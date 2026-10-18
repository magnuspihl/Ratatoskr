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
import { SnoozeService } from './mail/snooze.js';
import { PushService } from './push/service.js';
import { createPushTransport, vapidKeysFromSeed, type PushTransport } from './push/webpush.js';
import type { RemoteImage } from './net/remoteImages.js';
import { registerApiRoutes } from './routes/api.js';
import { inboxUnread } from '../../shared/unread.js';
import { registerWebSocket, type LiveSessions } from './routes/ws.js';

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
  push: PushService;
  snooze: SnoozeService;
}

export async function buildApp(
  config: Config,
  opts: {
    store?: Store;
    logger?: boolean;
    fetchImage?: (url: string) => Promise<RemoteImage>;
    /** Replaces real Web Push delivery (tests only). */
    pushTransport?: PushTransport;
    /** Replaces the DNS check of push service hosts (tests only). */
    pushHostCheck?: (host: string) => Promise<void>;
  } = {},
): Promise<App> {
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
  const vapid = vapidKeysFromSeed(keyring.vapidSeed);
  let live: LiveSessions = { isUserActive: () => false };
  const push = new PushService({
    store,
    transport: opts.pushTransport ?? createPushTransport(vapid, config.vapidSubject),
    isUserActive: (userId) => live.isUserActive(userId),
    onNoSubscriptions: (userId) => pool.setBackground(userId, false),
    unreadCount: async (userId) => {
      const folders = await Promise.all(store.listAccounts(userId).map((a) => mail.listFolders(userId, a.id)));
      return folders.some((f) => f.error) ? null : inboxUnread(folders);
    },
    log: (msg, extra) => app.log.warn(extra ?? {}, msg),
  });
  const snooze = new SnoozeService({
    store,
    mail,
    maxMessageBytes: config.maxMessageBytes,
    notify: (userId, accountId, messages) => push.notifySnoozeEnded(userId, accountId, messages),
    emit: (userId, event) => pool.onEvent(userId, event),
    log: (msg, extra) => app.log.warn(extra ?? {}, msg),
  });
  pool.onNewMail = (userId, accountId, messages) => {
    // Snoozed mail coming back gets its own notification from the snooze service.
    const fresh = messages.filter((m) => !snooze.wasResurfaced(userId, accountId, m.messageId));
    if (fresh.length > 0) void push.notifyNewMail(userId, accountId, fresh);
  };
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
  await registerApiRoutes(app, {
    config,
    store,
    sessions,
    pool,
    mail,
    compose,
    push,
    snooze,
    vapidPublicKey: vapid.publicKey,
    pushHostCheck: opts.pushHostCheck,
    fetchImage: opts.fetchImage,
  });
  live = await registerWebSocket(app, config, store, sessions, pool);

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

  // Users with notifications on some device are watched even while no browser is open.
  app.addHook('onReady', async () => {
    for (const userId of store.pushUserIds()) pool.setBackground(userId, true);
    // Also wakes messages whose snooze ended while the server was down.
    snooze.start();
  });

  app.addHook('onClose', async () => {
    await snooze.stop();
    await pool.close();
    if (!opts.store) store.close();
  });

  return { app, store, pool, push, snooze };
}
