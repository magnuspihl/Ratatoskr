import type { FastifyInstance } from 'fastify';
import * as oidc from 'openid-client';
import type { Config } from '../config.js';
import type { Store } from '../db.js';
import type { Sessions } from './session.js';

/**
 * Generic OpenID Connect login (authorization code flow with PKCE, state and nonce). Works with
 * any standards-compliant provider (Authentik, Keycloak, ...). Users are keyed by (issuer, sub).
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

  app.get('/auth/login', async (req, reply) => {
    if (!config.oidc) return reply.redirect('/auth/dev-login');
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
      sessions.write(reply, { uid: user.id, idt: tokens.id_token && tokens.id_token.length < 2500 ? tokens.id_token : undefined });
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
    if (config.oidc && session) {
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
      sessions.write(reply, { uid: user.id });
      return reply.redirect('/');
    });
  }
}
