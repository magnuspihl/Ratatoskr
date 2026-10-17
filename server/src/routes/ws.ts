import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { ServerEvent } from '../../../shared/types.js';
import type { Config } from '../config.js';
import type { Store } from '../db.js';
import type { ImapPool } from '../imap/pool.js';
import type { Sessions } from '../auth/session.js';

/**
 * One WebSocket per browser session. While at least one is open for a user, the pool keeps an IDLE
 * connection per account on INBOX and forwards change notifications; the browser then re-fetches.
 */
export async function registerWebSocket(app: FastifyInstance, config: Config, store: Store, sessions: Sessions, pool: ImapPool) {
  const sockets = new Map<string, Set<WebSocket>>();

  pool.onEvent = (userId: string, event: ServerEvent) => {
    const payload = JSON.stringify(event);
    for (const ws of sockets.get(userId) ?? []) if (ws.readyState === ws.OPEN) ws.send(payload);
  };

  app.get('/api/ws', { websocket: true }, (socket, req) => {
    const origin = req.headers.origin;
    const session = sessions.read(req);
    const user = session ? store.getUser(session.uid) : null;
    // Cross-site WebSocket hijacking guard: the browser always sends Origin on WS upgrades.
    const allowedOrigin = config.baseUrl.origin;
    const originOk = !!origin && (origin === allowedOrigin || (!config.production && /^https?:\/\/localhost(:\d+)?$/.test(origin)) || origin === `${req.protocol}://${req.headers.host}`);
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
    // The client never needs to send anything; ignore input.
    socket.on('message', () => {});
  });
}
