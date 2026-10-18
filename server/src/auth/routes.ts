import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as oidc from 'openid-client';
import { z } from 'zod';
import type { AuthMethods } from '../../../shared/types.js';
import type { Config } from '../config.js';
import type { Store } from '../db.js';
import { burnPasswordCheck, FailureLimiter, hashPassword, LOCAL_ISSUER, passwordSchema, usernameSchema, verifyPassword } from './password.js';
import type { Sessions } from './session.js';

/** May a new password account be created right now? */
export function registrationOpen(config: Config, store: Store): boolean {
  if (!config.passwordLogin) return false;
  if (config.registration === 'open') return true;
  return config.registration === 'first' && store.countUsers() === 0;
}

/**
 * Two ways in, usable side by side:
 *
 * - Generic OpenID Connect login (authorization code flow with PKCE, state and nonce). Works with
 *   any standards-compliant provider (Authentik, Keycloak, ...). Users are keyed by (issuer, sub).
 * - Username and password (scrypt hashes in SQLite), with optional self-registration.
 */
export async function registerAuthRoutes(app: FastifyInstance, config: Config, store: Store, sessions: Sessions) {
  const callbackUrl = new URL('/auth/callback', config.baseUrl);
  let configPromise: Promise<oidc.Configuration> | null = null;

  const getConfig = () => {
    if (!config.oidc) throw new Error('OIDC is not configured');
    const o = config.oidc;
    configPromise ??= oidc
      .discovery(new URL(o.issuerUrl), o.clientId, o.clientSecret || undefined, undefined, {
        execute: !config.production && o.issuerUrl.startsWith('http:') ? [oidc.allowInsecureRequests] : [],
      })
      .catch((err: unknown) => {
        configPromise = null; // retry discovery on the next attempt
        throw err;
      });
    return configPromise;
  };

  app.get('/auth/methods', async (): Promise<AuthMethods> => ({
    password: config.passwordLogin,
    registration: registrationOpen(config, store),
    oidc: config.oidc ? { label: config.oidc.label } : null,
    dev: config.devLogin,
  }));

  app.get('/auth/login', async (req, reply) => {
    if (!config.oidc) return reply.redirect(config.devLogin ? '/auth/dev-login' : '/');
    const cfg = await getConfig();
    const verifier = oidc.randomPKCECodeVerifier();
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    sessions.writeLogin(reply, { state, nonce, verifier });
    const url = oidc.buildAuthorizationUrl(cfg, {
      redirect_uri: callbackUrl.toString(),
      scope: config.oidc.scopes,
      code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
      state,
      nonce,
    });
    return reply.redirect(url.toString());
  });

  app.get('/auth/callback', async (req, reply) => {
    const tx = sessions.takeLogin(req, reply);
    if (!tx) return reply.code(400).type('text/plain').send('Login expired or invalid. Please try again.');
    try {
      const cfg = await getConfig();
      // Rebuild the callback URL from the configured base URL, not from request headers.
      const current = new URL(req.url, config.baseUrl);
      const tokens = await oidc.authorizationCodeGrant(cfg, current, {
        pkceCodeVerifier: tx.verifier,
        expectedState: tx.state,
        expectedNonce: tx.nonce,
        idTokenExpected: true,
      });
      const claims = tokens.claims();
      if (!claims?.sub) throw new Error('ID token has no subject');
      let email = typeof claims.email === 'string' ? claims.email : '';
      let name = typeof claims.name === 'string' ? claims.name : '';
      if ((!email || !name) && tokens.access_token) {
        try {
          const info = await oidc.fetchUserInfo(cfg, tokens.access_token, claims.sub);
          email ||= typeof info.email === 'string' ? info.email : '';
          name ||= typeof info.name === 'string' ? info.name : typeof info.preferred_username === 'string' ? info.preferred_username : '';
        } catch {
          /* userinfo is optional */
        }
      }
      const user = store.upsertUser(claims.iss, claims.sub, email, name || email || claims.sub);
      sessions.write(reply, { uid: user.id, via: 'oidc', idt: tokens.id_token && tokens.id_token.length < 2500 ? tokens.id_token : undefined });
      return reply.redirect('/');
    } catch (err) {
      req.log.warn({ err: (err as Error).message }, 'OIDC callback failed');
      return reply.code(400).type('text/plain').send('Login failed. Please try again.');
    }
  });

  app.post('/auth/logout', async (req, reply) => {
    const session = sessions.read(req);
    sessions.clear(reply);
    let redirect = '/';
    if (config.oidc && session && (session.via ?? 'oidc') === 'oidc') {
      try {
        const cfg = await getConfig();
        if (cfg.serverMetadata().end_session_endpoint) {
          redirect = oidc
            .buildEndSessionUrl(cfg, {
              post_logout_redirect_uri: new URL('/', config.baseUrl).toString(),
              ...(session.idt ? { id_token_hint: session.idt } : {}),
            })
            .toString();
        }
      } catch {
        /* fall back to local logout */
      }
    }
    return { redirect };
  });

  if (config.devLogin) {
    app.log.warn('RATATOSKR_DEV_LOGIN is enabled: anyone can log in as the local dev user. Never use this in production.');
    app.get('/auth/dev-login', async (_req, reply) => {
      const user = store.upsertUser('dev-login', 'dev', 'user@example.com', 'Dev User');
      sessions.write(reply, { uid: user.id, via: 'dev' });
      return reply.redirect('/');
    });
  }

  if (config.passwordLogin) registerPasswordRoutes(app, config, store, sessions);
}

const credentialsSchema = z.object({ username: z.string().max(500), password: z.string().max(1000) });

function registerPasswordRoutes(app: FastifyInstance, config: Config, store: Store, sessions: Sessions) {
  const window = 15 * 60 * 1000;
  const failuresByIp = new FailureLimiter(30, window);
  const failuresByUser = new FailureLimiter(10, window);
  const registrationsByIp = new FailureLimiter(5, 60 * 60 * 1000);

  /** Same CSRF rule as /api: a custom header only our own origin can send. Also stops login CSRF. */
  const parse = (req: FastifyRequest, reply: FastifyReply) => {
    if (req.headers['x-ratatoskr'] !== '1') {
      void reply.code(403).send({ error: 'Missing CSRF header' });
      return null;
    }
    const body = credentialsSchema.safeParse(req.body);
    if (!body.success) {
      void reply.code(400).send({ error: 'Username and password are required' });
      return null;
    }
    return body.data;
  };

  app.post('/auth/password/login', async (req, reply) => {
    const body = parse(req, reply);
    if (!body) return reply;
    const username = usernameSchema.safeParse(body.username);
    const userKey = username.success ? username.data : body.username.toLowerCase();
    if (failuresByIp.blocked(req.ip) || failuresByUser.blocked(userKey)) {
      return reply.code(429).send({ error: 'Too many failed attempts. Try again in a few minutes.' });
    }
    const found = username.success ? store.findPasswordUser(LOCAL_ISSUER, username.data) : null;
    const ok = found ? await verifyPassword(body.password, found.passwordHash) : (await burnPasswordCheck(body.password), false);
    if (!found || !ok) {
      failuresByIp.fail(req.ip);
      failuresByUser.fail(userKey);
      return reply.code(401).send({ error: 'Wrong username or password' });
    }
    failuresByUser.reset(userKey);
    sessions.write(reply, { uid: found.user.id, via: 'password' });
    return { ok: true };
  });

  app.post('/auth/password/register', async (req, reply) => {
    const body = parse(req, reply);
    if (!body) return reply;
    if (!registrationOpen(config, store)) return reply.code(403).send({ error: 'Registration is closed' });
    if (registrationsByIp.blocked(req.ip)) {
      return reply.code(429).send({ error: 'Too many new accounts from this address. Try again later.' });
    }
    const username = usernameSchema.safeParse(body.username);
    if (!username.success) return reply.code(400).send({ error: username.error.issues[0]!.message });
    const password = passwordSchema.safeParse(body.password);
    if (!password.success) return reply.code(400).send({ error: password.error.issues[0]!.message });
    const hash = await hashPassword(password.data);
    // Checked again after the (slow) hash: in `first` mode two concurrent sign-ups must not both win.
    if (!registrationOpen(config, store)) return reply.code(403).send({ error: 'Registration is closed' });
    const user = store.createPasswordUser(LOCAL_ISSUER, username.data, hash);
    if (!user) return reply.code(409).send({ error: 'That username is taken' });
    registrationsByIp.fail(req.ip);
    sessions.write(reply, { uid: user.id, via: 'password' });
    return { ok: true };
  });
}
