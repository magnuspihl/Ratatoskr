import type { ImapFlow, ListResponse, MailboxObject } from 'imapflow';
import type { ServerEvent } from '../../../shared/types.js';
import type { AccountSecret, Store } from '../db.js';
import { connectImap, MailServerError } from './connect.js';

export interface PoolOptions {
  idleTimeoutMs: number;
  blockPrivateHosts: boolean;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

interface CommandConnection {
  client: ImapFlow | null;
  connecting: Promise<ImapFlow> | null;
  lastUsed: number;
  inFlight: number;
  folders: { at: number; list: ListResponse[] } | null;
}

interface Watcher {
  client: ImapFlow | null;
  uidValidity: string | null;
  stopped: boolean;
  retry: NodeJS.Timeout | null;
  backoffMs: number;
}

export class NotFoundError extends Error {}

const FOLDER_CACHE_MS = 60_000;

/**
 * Lazily opened IMAP connections, one command connection per (user, account), closed after an
 * idle timeout. Separately, while a user has a live browser session, one IDLE connection per
 * account watches INBOX and reports changes.
 *
 * There is no message cache: every request goes to the IMAP server.
 */
export class ImapPool {
  private readonly conns = new Map<string, CommandConnection>();
  private readonly watchers = new Map<string, Map<string, Watcher>>();
  private readonly watchRefs = new Map<string, number>();
  private readonly sweeper: NodeJS.Timeout;
  onEvent: (userId: string, event: ServerEvent) => void = () => {};

  constructor(
    private readonly store: Store,
    private readonly opts: PoolOptions,
  ) {
    this.sweeper = setInterval(() => this.sweep(), Math.min(30_000, opts.idleTimeoutMs));
    this.sweeper.unref();
  }

  private key(userId: string, accountId: string) {
    return `${userId}:${accountId}`;
  }

  private account(userId: string, accountId: string): AccountSecret {
    const acc = this.store.getAccountSecret(userId, accountId);
    if (!acc) throw new NotFoundError('Account not found');
    return acc;
  }

  private async client(userId: string, accountId: string): Promise<{ conn: CommandConnection; client: ImapFlow }> {
    const key = this.key(userId, accountId);
    let conn = this.conns.get(key);
    if (!conn) {
      conn = { client: null, connecting: null, lastUsed: Date.now(), inFlight: 0, folders: null };
      this.conns.set(key, conn);
    }
    conn.lastUsed = Date.now();
    if (conn.client?.usable) return { conn, client: conn.client };
    if (!conn.connecting) {
      const acc = this.account(userId, accountId);
      const c = conn;
      c.connecting = connectImap(acc.imap, { blockPrivateHosts: this.opts.blockPrivateHosts, autoIdle: false })
        .then((client) => {
          client.on('close', () => {
            if (c.client === client) c.client = null;
          });
          c.client = client;
          return client;
        })
        .finally(() => {
          c.connecting = null;
        });
    }
    return { conn, client: await conn.connecting! };
  }

  /** Run `fn` with a connection, without selecting a mailbox. */
  async withClient<T>(userId: string, accountId: string, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    const { conn, client } = await this.client(userId, accountId);
    conn.inFlight++;
    try {
      return await fn(client);
    } finally {
      conn.inFlight--;
      conn.lastUsed = Date.now();
    }
  }

  /** Run `fn` with `path` selected and locked on the account's command connection. */
  async withMailbox<T>(
    userId: string,
    accountId: string,
    path: string,
    fn: (client: ImapFlow, mailbox: MailboxObject) => Promise<T>,
  ): Promise<T> {
    return this.withClient(userId, accountId, async (client) => {
      let lock;
      try {
        lock = await client.getMailboxLock(path, { acquireTimeout: 60_000 });
      } catch (err) {
        const e = err as { responseText?: string; message?: string };
        throw new MailServerError(`Cannot open folder "${path}": ${e.responseText || e.message}`, 'protocol');
      }
      try {
        return await fn(client, client.mailbox as MailboxObject);
      } finally {
        lock.release();
      }
    });
  }

  /** Folder list with a short cache (special-use lookups happen on most actions). */
  async folders(userId: string, accountId: string, fresh = false): Promise<ListResponse[]> {
    const { conn } = await this.client(userId, accountId);
    if (!fresh && conn.folders && Date.now() - conn.folders.at < FOLDER_CACHE_MS) return conn.folders.list;
    const list = await this.withClient(userId, accountId, (c) =>
      c.list({ statusQuery: { unseen: true, messages: true } }),
    );
    conn.folders = { at: Date.now(), list };
    return list;
  }

  /** Close and forget every connection for an account (after edit or delete). */
  invalidate(userId: string, accountId: string) {
    const key = this.key(userId, accountId);
    const conn = this.conns.get(key);
    this.conns.delete(key);
    conn?.client?.logout().catch(() => conn.client?.close());
    const w = this.watchers.get(userId)?.get(accountId);
    if (w) {
      this.stopWatcher(w);
      this.watchers.get(userId)!.delete(accountId);
      if ((this.watchRefs.get(userId) ?? 0) > 0) this.startWatcher(userId, accountId);
    }
  }

  private sweep() {
    const now = Date.now();
    for (const [key, conn] of this.conns) {
      if (conn.inFlight === 0 && !conn.connecting && now - conn.lastUsed > this.opts.idleTimeoutMs) {
        this.conns.delete(key);
        const c = conn.client;
        if (c) c.logout().catch(() => c.close());
      }
    }
  }

  // ---- live updates --------------------------------------------------------

  /** Called when a browser session for this user opens. Reference counted per user. */
  watch(userId: string) {
    const refs = (this.watchRefs.get(userId) ?? 0) + 1;
    this.watchRefs.set(userId, refs);
    if (refs > 1) return;
    for (const acc of this.store.listAccounts(userId)) this.startWatcher(userId, acc.id);
  }

  unwatch(userId: string) {
    const refs = (this.watchRefs.get(userId) ?? 1) - 1;
    if (refs > 0) {
      this.watchRefs.set(userId, refs);
      return;
    }
    this.watchRefs.delete(userId);
    const ws = this.watchers.get(userId);
    this.watchers.delete(userId);
    for (const w of ws?.values() ?? []) this.stopWatcher(w);
  }

  /** Start watching a newly added account if the user is online. */
  accountAdded(userId: string, accountId: string) {
    if ((this.watchRefs.get(userId) ?? 0) > 0) this.startWatcher(userId, accountId);
  }

  private stopWatcher(w: Watcher) {
    w.stopped = true;
    if (w.retry) clearTimeout(w.retry);
    const c = w.client;
    w.client = null;
    if (c) c.logout().catch(() => c.close());
  }

  private startWatcher(userId: string, accountId: string) {
    let byAccount = this.watchers.get(userId);
    if (!byAccount) {
      byAccount = new Map();
      this.watchers.set(userId, byAccount);
    }
    if (byAccount.has(accountId)) return;
    const w: Watcher = { client: null, uidValidity: null, stopped: false, retry: null, backoffMs: 5_000 };
    byAccount.set(accountId, w);
    void this.runWatcher(userId, accountId, w);
  }

  private async runWatcher(userId: string, accountId: string, w: Watcher) {
    if (w.stopped) return;
    const folder = 'INBOX';
    const emit = (event: ServerEvent) => this.onEvent(userId, event);
    try {
      const acc = this.account(userId, accountId);
      const client = await connectImap(acc.imap, { blockPrivateHosts: this.opts.blockPrivateHosts, autoIdle: true });
      if (w.stopped) {
        await client.logout().catch(() => client.close());
        return;
      }
      w.client = client;
      const mailbox = await client.mailboxOpen(folder, { readOnly: true });
      const uv = mailbox.uidValidity.toString();
      if (w.uidValidity !== null && w.uidValidity !== uv) emit({ type: 'reset', accountId, folder });
      else if (w.uidValidity !== null) emit({ type: 'mailbox', accountId, folder }); // catch up after reconnect
      w.uidValidity = uv;
      w.backoffMs = 5_000;
      const changed = () => emit({ type: 'mailbox', accountId, folder });
      client.on('exists', changed);
      client.on('expunge', changed);
      client.on('flags', changed);
      client.on('close', () => {
        if (w.client === client) w.client = null;
        this.scheduleWatcher(userId, accountId, w);
      });
    } catch (err) {
      if (err instanceof NotFoundError) return;
      this.opts.log?.('IMAP watcher failed', { accountId, error: (err as Error).message });
      this.scheduleWatcher(userId, accountId, w);
    }
  }

  private scheduleWatcher(userId: string, accountId: string, w: Watcher) {
    if (w.stopped || w.retry) return;
    w.retry = setTimeout(() => {
      w.retry = null;
      void this.runWatcher(userId, accountId, w);
    }, w.backoffMs);
    w.retry.unref();
    w.backoffMs = Math.min(w.backoffMs * 2, 5 * 60_000);
  }

  async close() {
    clearInterval(this.sweeper);
    for (const userId of [...this.watchRefs.keys()]) {
      this.watchRefs.set(userId, 1);
      this.unwatch(userId);
    }
    await Promise.all(
      [...this.conns.values()].map((c) => c.client?.logout().catch(() => c.client?.close())),
    );
    this.conns.clear();
  }
}
