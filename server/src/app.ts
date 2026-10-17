import fs from 'node:fs';
import path from 'node:path';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerAuthRoutes } from './auth/routes.js';
import { Sessions } from './auth/session.js';
import type { Config } from './config.js';
import { Keyring } from './crypto.js';
import { Store } from './db.js';
import { MailService } from './imap/mail.js';
import { ImapPool } from './imap/pool.js';
import { ComposeService } from './mail/send.js';
import { registerApiRoutes } from './routes/api.js';
import { registerWebSocket } from './routes/ws.js';

/** CSP for the application itself. Message iframes (srcdoc) inherit it, plus their own. */
export const APP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "base-uri 'none'",
  "object-src 'none'",
].join('; ');

/**
 * Client-side routes (e.g. /mail/<account>/<folder>) are served the SPA shell. Only browser
 * navigations qualify (GET/HEAD asking for HTML), and never anything under /api or /auth, so API
 * typos still get a JSON 404 and missing assets aren't answered with HTML.
 */
export function isSpaRequest(method: string, url: string, accept: string | undefined): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false;
  const path = url.split('?')[0]!;
  if (/^\/(api|auth)(\/|$)/.test(path) || path === '/healthz') return false;
  return (accept ?? '').includes('text/html');
}

export interface App {
  app: FastifyInstance;
  store: Store;
  pool: ImapPool;
}

export async function buildApp(config: Config, opts: { store?: Store; logger?: boolean } = {}): Promise<App> {
  const app = Fastify({
    logger: opts.logger === false ? false : { level: config.logLevel },
    trustProxy: config.trustProxy,
    bodyLimit: 2 * 1024 * 1024,
  });
  const keyring = new Keyring(config.secretKey);
  const store = opts.store ?? new Store(path.join(config.dataDir, 'ratatoskr.db'), keyring.credentialKey);
  const sessions = new Sessions(keyring.sessionKey, config.baseUrl.protocol === 'https:');
  const pool = new ImapPool(store, {
    idleTimeoutMs: config.imapIdleTimeoutMs,
    blockPrivateHosts: config.blockPrivateMailHosts,
    log: (msg, extra) => app.log.info(extra ?? {}, msg),
  });
  const mail = new MailService(pool);
  const compose = new ComposeService(store, mail, {
    maxMessageBytes: config.maxMessageBytes,
    blockPrivateHosts: config.blockPrivateMailHosts,
  });

  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: config.maxUploadBytes, files: 50, fieldSize: 6 * 1024 * 1024 } });
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });

  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-frame-options', 'DENY');
    reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=(), interest-cohort=()');
    reply.header('cross-origin-opener-policy', 'same-origin');
    if (!reply.hasHeader('content-security-policy')) reply.header('content-security-policy', APP_CSP);
    return payload;
  });

  app.get('/healthz', async () => ({ ok: true }));

  await registerAuthRoutes(app, config, store, sessions);
  await registerApiRoutes(app, { config, store, keyring, sessions, pool, mail, compose });
  await registerWebSocket(app, config, store, sessions, pool);

  // Static frontend (production build). In development Vite serves the UI and proxies /api.
  if (fs.existsSync(path.join(config.webDir, 'index.html'))) {
    await app.register(fastifyStatic, { root: config.webDir, wildcard: false, index: ['index.html'] });
    app.setNotFoundHandler((req, reply) => {
      if (isSpaRequest(req.method, req.url, req.headers.accept)) {
        return reply.header('cache-control', 'no-cache').sendFile('index.html');
      }
      return reply.code(404).send({ error: 'Not found' });
    });
  }

  app.addHook('onClose', async () => {
    await pool.close();
    if (!opts.store) store.close();
  });

  return { app, store, pool };
}
