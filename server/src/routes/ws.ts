import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { isDevHostAllowed } from '../../../shared/devHosts.js';
import type { ClientEvent, ServerEvent } from '../../../shared/types.js';
import type { Config } from '../config.js';
import type { Store } from '../db.js';
import type { ImapPool } from '../imap/pool.js';
import type { Sessions } from '../auth/session.js';

/**
 * Cross-site WebSocket hijacking guard: the browser always sends Origin on WS upgrades.
 *
 * Production accepts exactly what it always has. In development the allowed origin may also follow
 * the request's Host, as long as that Host is one the dev setup serves (localhost, the base URL's
 * host or RATATOSKR_DEV_ALLOWED_HOST_SUFFIX), so one dev server works behind several proxied
 * hostnames/ports. The scheme is not compared there: behind a TLS-terminating proxy and Vite's
 * proxy the backend only ever sees plain http.
 */
export function isWsOriginAllowed(
  config: Pick<Config, 'production' | 'baseUrl' | 'devAllowedHostSuffix'>,
  origin: string | undefined,
  req: { protocol: string; host: string | undefined },
): boolean {
  if (!origin) return false;
  const allowedOrigin = config.baseUrl.origin;
  if (origin === allowedOrigin || (!config.production && /^https?:\/\/localhost(:\d+)?$/.test(origin)) || origin === `${req.protocol}://${req.host}`) {
    return true;
  }
  if (config.production) return false;
  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    return false;
  }
  if (originUrl.protocol !== 'http:' && originUrl.protocol !== 'https:') return false;
  return (
    !!req.host &&
    originUrl.host === req.host.toLowerCase() &&
    isDevHostAllowed(req.host, { hosts: [config.baseUrl.hostname], suffix: config.devAllowedHostSuffix })
  );
}

/** Parses a message from the browser; anything unexpected is ignored. */
export function parseClientEvent(data: unknown): ClientEvent | null {
  try {
    const ev = JSON.parse(String(data)) as Partial<ClientEvent>;
    if (ev?.type === 'presence' && typeof ev.active === 'boolean') return { type: 'presence', active: ev.active };
  } catch {
    /* not JSON */
  }
  return null;
}

export interface LiveSessions {
  /** True if any of the user's browser sessions is visible and focused right now. */
  isUserActive: (userId: string) => boolean;
}

/**
 * One WebSocket per browser session. While at least one is open for a user, the pool keeps an IDLE
 * connection per account on INBOX and forwards change notifications; the browser then re-fetches.
 * The browser reports whether it is in front of the user, so phone notifications can be skipped
 * while the app is being looked at.
 */
export async function registerWebSocket(
  app: FastifyInstance,
  config: Config,
  store: Store,
  sessions: Sessions,
  pool: ImapPool,
): Promise<LiveSessions> {
  const sockets = new Map<string, Set<WebSocket>>();
  const active = new WeakSet<WebSocket>();

  pool.onEvent = (userId: string, event: ServerEvent) => {
    const payload = JSON.stringify(event);
    for (const ws of sockets.get(userId) ?? []) if (ws.readyState === ws.OPEN) ws.send(payload);
  };

  app.get('/api/ws', { websocket: true }, (socket, req) => {
    const origin = req.headers.origin;
    const session = sessions.read(req);
    const user = session ? store.getUser(session.uid) : null;
    const originOk = isWsOriginAllowed(config, origin, { protocol: req.protocol, host: req.headers.host });
    if (!user || !originOk) {
      socket.close(4401, 'unauthorized');
      return;
    }
    let set = sockets.get(user.id);
    if (!set) {
      set = new Set();
      sockets.set(user.id, set);
    }
    set.add(socket);
    pool.watch(user.id);
    socket.send(JSON.stringify({ type: 'hello' } satisfies ServerEvent));

    const ping = setInterval(() => socket.ping(), 30_000);
    socket.on('close', () => {
      clearInterval(ping);
      set.delete(socket);
      if (set.size === 0) sockets.delete(user.id);
      pool.unwatch(user.id);
    });
    socket.on('message', (data) => {
      const ev = parseClientEvent(data);
      if (ev?.active) active.add(socket);
      else if (ev) active.delete(socket);
    });
  });

  return {
    isUserActive: (userId) => [...(sockets.get(userId) ?? [])].some((ws) => ws.readyState === ws.OPEN && active.has(ws)),
  };
}
