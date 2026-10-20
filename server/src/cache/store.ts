import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { MessageSummary } from '../../../shared/types.js';
import { decryptBytes, encryptBytes } from '../crypto.js';
import { matchesTerm, type LookupField, type LookupTerm } from '../imap/related.js';

/**
 * Local copies of the newest messages of a few folders (INBOX and Sent), so listings and opening
 * a message don't have to wait for the IMAP server. The IMAP server stays the source of truth:
 * CacheSync (sync.ts) keeps this in step with it, and everything here can be thrown away at any
 * time. That is also how problems are handled: a format change, another secret key, a value that
 * doesn't decrypt or a damaged file all just empty the cache (or the folder), and it is filled
 * again from IMAP.
 *
 * Mail content is encrypted (AES-256-GCM, bound to user, account, folder, UIDVALIDITY and UID):
 * subjects, addresses, snippets, Message-IDs and message bodies. Readable are only what queries
 * need: folder paths, UIDs, arrival times, flags (read, flagged, answered, draft) and sizes.
 * Conversations are matched through keyed hashes of the Message-IDs.
 */

const SCHEMA_VERSION = '1';

const SCHEMA = `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE folders (
    id INTEGER PRIMARY KEY,
    user_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    path TEXT NOT NULL,
    -- Why the folder is cached: 'inbox' or 'sent'.
    role TEXT NOT NULL,
    uid_validity TEXT NOT NULL,
    -- Every message with low_uid <= UID < uid_next is in the cache.
    uid_next INTEGER NOT NULL,
    low_uid INTEGER NOT NULL,
    -- The server has no messages below low_uid.
    complete INTEGER NOT NULL,
    -- HIGHESTMODSEQ at the last sync (CONDSTORE), null if the server has none.
    modseq TEXT,
    exists_count INTEGER NOT NULL,
    synced_at INTEGER NOT NULL,
    UNIQUE (user_id, account_id, path)
  );
  CREATE TABLE messages (
    folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
    uid INTEGER NOT NULL,
    sort_time INTEGER NOT NULL,
    flags INTEGER NOT NULL,
    size INTEGER NOT NULL,
    data BLOB NOT NULL,
    PRIMARY KEY (folder_id, uid)
  ) WITHOUT ROWID;
  CREATE TABLE thread_keys (
    folder_id INTEGER NOT NULL,
    uid INTEGER NOT NULL,
    hash BLOB NOT NULL,
    PRIMARY KEY (folder_id, hash, uid),
    FOREIGN KEY (folder_id, uid) REFERENCES messages(folder_id, uid) ON DELETE CASCADE
  ) WITHOUT ROWID;
  CREATE INDEX thread_keys_message ON thread_keys(folder_id, uid);
  CREATE TABLE bodies (
    folder_id INTEGER NOT NULL,
    uid INTEGER NOT NULL,
    size INTEGER NOT NULL,
    accessed_at INTEGER NOT NULL,
    data BLOB NOT NULL,
    PRIMARY KEY (folder_id, uid),
    FOREIGN KEY (folder_id, uid) REFERENCES messages(folder_id, uid) ON DELETE CASCADE
  ) WITHOUT ROWID;
`;

const SEEN = 1;
const FLAGGED = 2;
const ANSWERED = 4;
const DRAFT = 8;

export interface MessageFlags {
  seen: boolean;
  flagged: boolean;
  answered: boolean;
  draft: boolean;
}

const toBits = (f: MessageFlags) => (f.seen ? SEEN : 0) | (f.flagged ? FLAGGED : 0) | (f.answered ? ANSWERED : 0) | (f.draft ? DRAFT : 0);
const fromBits = (b: number): MessageFlags => ({ seen: !!(b & SEEN), flagged: !!(b & FLAGGED), answered: !!(b & ANSWERED), draft: !!(b & DRAFT) });

/** IMAP flags as stored (only the ones the app uses). */
export function flagsOf(set: Set<string> | undefined): MessageFlags {
  return { seen: !!set?.has('\\Seen'), flagged: !!set?.has('\\Flagged'), answered: !!set?.has('\\Answered'), draft: !!set?.has('\\Draft') };
}

export function imapFlags(f: MessageFlags): Set<string> {
  const out = new Set<string>();
  if (f.seen) out.add('\\Seen');
  if (f.flagged) out.add('\\Flagged');
  if (f.answered) out.add('\\Answered');
  if (f.draft) out.add('\\Draft');
  return out;
}

export type CachedRole = 'inbox' | 'sent';

/** A cached folder. */
export interface CachedFolder {
  id: number;
  userId: string;
  accountId: string;
  path: string;
  role: CachedRole;
  uidValidity: string;
  uidNext: number;
  lowUid: number;
  complete: boolean;
  modseq: string | null;
  exists: number;
  syncedAt: number;
}

export interface CachedMessage {
  summary: MessageSummary;
  sortTime: number;
  internalDate: string | null;
}

/** What is stored per message, ready to be encrypted. */
export interface MessageEntry {
  summary: MessageSummary;
  sortTime: number;
  internalDate: string | null;
}

/** The encrypted part of a message row: the summary without what the row or folder already says. */
type SealedSummary = Omit<MessageSummary, 'accountId' | 'folder' | 'uid' | 'uidValidity' | 'seen' | 'flagged' | 'answered' | 'draft' | 'size' | 'snoozedUntil'> & {
  internalDate: string | null;
};

/** A cached value didn't decrypt or parse: the folder's copy can't be trusted any more. */
export class CacheCorruptError extends Error {}

interface FolderRow {
  id: number;
  user_id: string;
  account_id: string;
  path: string;
  role: string;
  uid_validity: string;
  uid_next: number;
  low_uid: number;
  complete: number;
  modseq: string | null;
  exists_count: number;
  synced_at: number;
}

interface MessageRow {
  uid: number;
  sort_time: number;
  flags: number;
  size: number;
  data: Uint8Array;
}

const toFolder = (r: FolderRow): CachedFolder => ({
  id: r.id,
  userId: r.user_id,
  accountId: r.account_id,
  path: r.path,
  role: r.role as CachedRole,
  uidValidity: r.uid_validity,
  uidNext: r.uid_next,
  lowUid: r.low_uid,
  complete: r.complete === 1,
  modseq: r.modseq,
  exists: r.exists_count,
  syncedAt: r.synced_at,
});

/** Variables per SQL statement, well below SQLite's limit. */
const CHUNK = 500;

function chunks<T>(list: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

export class MailCache {
  private db!: DatabaseSync;

  constructor(
    private readonly file: string,
    private readonly keys: { cacheKey: Buffer; indexKey: Buffer },
    private readonly log: (msg: string, extra?: Record<string, unknown>) => void = () => {},
  ) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      this.open();
    } catch (err) {
      this.log('mail cache unreadable, starting over', { error: (err as Error).message });
      this.deleteFiles();
      this.open();
    }
  }

  private keyCheck() {
    return crypto.createHmac('sha256', this.keys.cacheKey).update('ratatoskr mail cache').digest('hex');
  }

  private open() {
    this.db = new DatabaseSync(this.file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
    const hasMeta = !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
    const meta = hasMeta
      ? new Map((this.db.prepare('SELECT key, value FROM meta').all() as { key: string; value: string }[]).map((r) => [r.key, r.value]))
      : new Map<string, string>();
    if (meta.get('schema') === SCHEMA_VERSION && meta.get('key') === this.keyCheck()) return;
    // Another format or another secret key (nothing in here could be decrypted): start empty.
    if (hasMeta) this.log('mail cache format or key changed, starting over');
    this.recreate();
  }

  private recreate() {
    this.db.exec('PRAGMA foreign_keys = OFF');
    const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
    this.db.exec('BEGIN');
    try {
      for (const t of tables) this.db.exec(`DROP TABLE IF EXISTS "${t.name.replace(/"/g, '""')}"`);
      this.db.exec(SCHEMA);
      this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?), (?, ?)').run('schema', SCHEMA_VERSION, 'key', this.keyCheck());
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    this.db.exec('PRAGMA foreign_keys = ON');
  }

  private deleteFiles() {
    try {
      this.db?.close();
    } catch {
      /* already closed or never opened */
    }
    if (this.file === ':memory:') return;
    for (const f of [this.file, `${this.file}-wal`, `${this.file}-shm`]) fs.rmSync(f, { force: true });
  }

  /** Throw everything away (e.g. after a database error) and continue with an empty cache. */
  reset() {
    this.log('mail cache reset');
    this.deleteFiles();
    this.open();
  }

  close() {
    this.db.close();
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // ---- folders -------------------------------------------------------------

  folder(userId: string, accountId: string, path: string): CachedFolder | null {
    const r = this.db.prepare('SELECT * FROM folders WHERE user_id = ? AND account_id = ? AND path = ?').get(userId, accountId, path) as FolderRow | undefined;
    return r ? toFolder(r) : null;
  }

  /** The account's cached folder with this role. */
  folderByRole(userId: string, accountId: string, role: CachedRole): CachedFolder | null {
    const r = this.db.prepare('SELECT * FROM folders WHERE user_id = ? AND account_id = ? AND role = ?').get(userId, accountId, role) as FolderRow | undefined;
    return r ? toFolder(r) : null;
  }

  /** Start a folder over, empty, for this UIDVALIDITY. Replaces any other folder with the same role. */
  resetFolder(userId: string, accountId: string, path: string, role: CachedRole, uidValidity: string): CachedFolder {
    return this.tx(() => {
      this.db.prepare('DELETE FROM folders WHERE user_id = ? AND account_id = ? AND (path = ? OR role = ?)').run(userId, accountId, path, role);
      this.db
        .prepare(
          `INSERT INTO folders (user_id, account_id, path, role, uid_validity, uid_next, low_uid, complete, modseq, exists_count, synced_at)
           VALUES (?, ?, ?, ?, ?, 1, 1, 0, NULL, 0, 0)`,
        )
        .run(userId, accountId, path, role, uidValidity);
      return this.folder(userId, accountId, path)!;
    });
  }

  updateFolder(f: CachedFolder, patch: Partial<Pick<CachedFolder, 'uidNext' | 'lowUid' | 'complete' | 'modseq' | 'exists' | 'syncedAt'>>) {
    const next = { ...f, ...patch };
    this.db
      .prepare('UPDATE folders SET uid_next = ?, low_uid = ?, complete = ?, modseq = ?, exists_count = ?, synced_at = ? WHERE id = ?')
      .run(next.uidNext, next.lowUid, next.complete ? 1 : 0, next.modseq, next.exists, next.syncedAt, f.id);
    Object.assign(f, patch);
  }

  dropFolder(userId: string, accountId: string, path: string) {
    this.db.prepare('DELETE FROM folders WHERE user_id = ? AND account_id = ? AND path = ?').run(userId, accountId, path);
  }

  dropAccount(userId: string, accountId: string) {
    this.db.prepare('DELETE FROM folders WHERE user_id = ? AND account_id = ?').run(userId, accountId);
  }

  /** Forget accounts that no longer exist. `keep` holds `${userId}\0${accountId}`. */
  prune(keep: Set<string>) {
    const rows = this.db.prepare('SELECT DISTINCT user_id, account_id FROM folders').all() as { user_id: string; account_id: string }[];
    for (const r of rows) if (!keep.has(`${r.user_id}\u0000${r.account_id}`)) this.dropAccount(r.user_id, r.account_id);
  }

  // ---- messages ------------------------------------------------------------

  private aad(f: CachedFolder, uid: number, kind: 'summary' | 'body') {
    return `mail-cache:${kind}:${f.userId}:${f.accountId}:${f.path}:${f.uidValidity}:${uid}`;
  }

  /** Keyed hash of a conversation header value: equal IDs match, but the ID itself isn't stored. */
  private threadHash(f: CachedFolder, field: LookupField, id: string): Buffer {
    return crypto.createHmac('sha256', this.keys.indexKey).update(`${f.userId}\u0000${f.accountId}\u0000${field}\u0000${id}`).digest().subarray(0, 16);
  }

  /** Add or replace messages. */
  putMessages(f: CachedFolder, entries: MessageEntry[]) {
    if (entries.length === 0) return;
    const del = this.db.prepare('DELETE FROM messages WHERE folder_id = ? AND uid = ?');
    const ins = this.db.prepare('INSERT INTO messages (folder_id, uid, sort_time, flags, size, data) VALUES (?, ?, ?, ?, ?, ?)');
    const key = this.db.prepare('INSERT OR IGNORE INTO thread_keys (folder_id, uid, hash) VALUES (?, ?, ?)');
    this.tx(() => {
      for (const { summary: s, sortTime, internalDate } of entries) {
        const sealed: SealedSummary = {
          messageId: s.messageId,
          inReplyTo: s.inReplyTo,
          references: s.references,
          subject: s.subject,
          from: s.from,
          to: s.to,
          date: s.date,
          snippet: s.snippet,
          hasAttachments: s.hasAttachments,
          internalDate,
        };
        const data = encryptBytes(this.keys.cacheKey, Buffer.from(JSON.stringify(sealed)), this.aad(f, s.uid, 'summary'));
        del.run(f.id, s.uid);
        ins.run(f.id, s.uid, sortTime, toBits(s), s.size, data);
        if (s.messageId) key.run(f.id, s.uid, this.threadHash(f, 'message-id', s.messageId));
        if (s.inReplyTo) key.run(f.id, s.uid, this.threadHash(f, 'in-reply-to', s.inReplyTo));
        for (const r of s.references) key.run(f.id, s.uid, this.threadHash(f, 'references', r));
      }
    });
  }

  /** Update flags of cached messages; UIDs that aren't cached are ignored. */
  setFlags(f: CachedFolder, changes: { uid: number; flags: MessageFlags }[]): number {
    const stmt = this.db.prepare('UPDATE messages SET flags = ? WHERE folder_id = ? AND uid = ? AND flags != ?');
    let changed = 0;
    this.tx(() => {
      for (const c of changes) changed += Number(stmt.run(toBits(c.flags), f.id, c.uid, toBits(c.flags)).changes);
    });
    return changed;
  }

  /** Set or clear one flag on some messages (after an action of ours). */
  changeFlag(f: CachedFolder, uids: number[], flag: keyof MessageFlags, on: boolean) {
    const bit = { seen: SEEN, flagged: FLAGGED, answered: ANSWERED, draft: DRAFT }[flag];
    const stmt = this.db.prepare(on ? 'UPDATE messages SET flags = flags | ? WHERE folder_id = ? AND uid = ?' : 'UPDATE messages SET flags = flags & ~? WHERE folder_id = ? AND uid = ?');
    this.tx(() => {
      for (const uid of uids) stmt.run(bit, f.id, uid);
    });
  }

  removeMessages(f: CachedFolder, uids: number[]): number {
    let removed = 0;
    this.tx(() => {
      for (const part of chunks(uids)) {
        removed += Number(this.db.prepare(`DELETE FROM messages WHERE folder_id = ? AND uid IN (${part.map(() => '?').join(',')})`).run(f.id, ...part).changes);
      }
    });
    return removed;
  }

  /** Every cached UID of the folder, ascending. */
  uids(f: CachedFolder): number[] {
    return (this.db.prepare('SELECT uid FROM messages WHERE folder_id = ? ORDER BY uid').all(f.id) as { uid: number }[]).map((r) => r.uid);
  }

  count(f: CachedFolder): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE folder_id = ?').get(f.id) as { n: number }).n;
  }

  /** Keep only the newest `keep` messages (by UID); moves low_uid up accordingly. */
  trim(f: CachedFolder, keep: number) {
    const cut = this.db.prepare('SELECT uid FROM messages WHERE folder_id = ? ORDER BY uid DESC LIMIT 1 OFFSET ?').get(f.id, keep - 1) as { uid: number } | undefined;
    if (!cut || cut.uid <= f.lowUid) return;
    const removed = Number(this.db.prepare('DELETE FROM messages WHERE folder_id = ? AND uid < ?').run(f.id, cut.uid).changes);
    if (removed > 0) this.updateFolder(f, { lowUid: cut.uid, complete: false });
  }

  private decode(f: CachedFolder, r: MessageRow): CachedMessage {
    let s: SealedSummary;
    try {
      s = JSON.parse(decryptBytes(this.keys.cacheKey, r.data, this.aad(f, r.uid, 'summary')).toString('utf8')) as SealedSummary;
    } catch {
      throw new CacheCorruptError(`Cached message ${r.uid} in ${f.path} is unreadable`);
    }
    const flags = fromBits(r.flags);
    return {
      summary: {
        accountId: f.accountId,
        folder: f.path,
        uid: r.uid,
        uidValidity: f.uidValidity,
        messageId: s.messageId,
        inReplyTo: s.inReplyTo,
        references: s.references,
        subject: s.subject,
        from: s.from,
        to: s.to,
        date: s.date,
        snippet: s.snippet,
        ...flags,
        hasAttachments: s.hasAttachments,
        size: r.size,
      },
      sortTime: r.sort_time,
      internalDate: s.internalDate,
    };
  }

  /** Cached messages below `beforeUid` (all if null), newest UID first. Only covers UIDs from low_uid up. */
  page(f: CachedFolder, beforeUid: number | null, limit: number, unreadOnly = false): CachedMessage[] {
    const rows = this.db
      .prepare(
        `SELECT uid, sort_time, flags, size, data FROM messages
         WHERE folder_id = ? AND uid < ? AND uid >= ? ${unreadOnly ? `AND (flags & ${SEEN}) = 0` : ''}
         ORDER BY uid DESC LIMIT ?`,
      )
      .all(f.id, beforeUid ?? Number.MAX_SAFE_INTEGER, f.lowUid, limit) as unknown as MessageRow[];
    return rows.map((r) => this.decode(f, r));
  }

  message(f: CachedFolder, uid: number): CachedMessage | null {
    const r = this.db.prepare('SELECT uid, sort_time, flags, size, data FROM messages WHERE folder_id = ? AND uid = ?').get(f.id, uid) as MessageRow | undefined;
    return r ? this.decode(f, r) : null;
  }

  /** Cached messages matching any of the conversation terms (see related.ts), newest first. */
  related(f: CachedFolder, terms: LookupTerm[], limit: number): CachedMessage[] {
    if (terms.length === 0) return [];
    const uids = new Set<number>();
    for (const part of chunks(terms)) {
      const rows = this.db
        .prepare(`SELECT DISTINCT uid FROM thread_keys WHERE folder_id = ? AND hash IN (${part.map(() => '?').join(',')})`)
        .all(f.id, ...part.map((t) => this.threadHash(f, t.field, t.id))) as { uid: number }[];
      for (const r of rows) uids.add(r.uid);
    }
    const out: CachedMessage[] = [];
    for (const uid of [...uids].sort((a, b) => b - a)) {
      const m = this.message(f, uid);
      // A hash can (in theory) collide; the decrypted headers decide.
      if (m && terms.some((t) => matchesTerm(t, m.summary))) out.push(m);
      if (out.length >= limit) break;
    }
    return out;
  }

  // ---- message content -----------------------------------------------------

  body(f: CachedFolder, uid: number): Buffer | null {
    const r = this.db.prepare('SELECT data FROM bodies WHERE folder_id = ? AND uid = ?').get(f.id, uid) as { data: Uint8Array } | undefined;
    if (!r) return null;
    let raw: Buffer;
    try {
      raw = decryptBytes(this.keys.cacheKey, r.data, this.aad(f, uid, 'body'));
    } catch {
      throw new CacheCorruptError(`Cached content of message ${uid} in ${f.path} is unreadable`);
    }
    this.db.prepare('UPDATE bodies SET accessed_at = ? WHERE folder_id = ? AND uid = ?').run(Date.now(), f.id, uid);
    return raw;
  }

  hasBody(f: CachedFolder, uid: number): boolean {
    return !!this.db.prepare('SELECT 1 FROM bodies WHERE folder_id = ? AND uid = ?').get(f.id, uid);
  }

  /** Store a message's content (only for messages whose summary is cached). */
  putBody(f: CachedFolder, uid: number, raw: Buffer, accessedAt = Date.now()) {
    if (!this.db.prepare('SELECT 1 FROM messages WHERE folder_id = ? AND uid = ?').get(f.id, uid)) return;
    const data = encryptBytes(this.keys.cacheKey, raw, this.aad(f, uid, 'body'));
    this.db
      .prepare(
        `INSERT INTO bodies (folder_id, uid, size, accessed_at, data) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (folder_id, uid) DO UPDATE SET size = excluded.size, accessed_at = excluded.accessed_at, data = excluded.data`,
      )
      .run(f.id, uid, raw.length, accessedAt, data);
  }

  /**
   * Messages worth loading ahead: the newest `among` messages of the folder that are unread, no
   * larger than `maxBytes` and not stored yet. Newest first, at most `limit`.
   */
  prefetchCandidates(f: CachedFolder, among: number, maxBytes: number, limit: number): number[] {
    return (
      this.db
        .prepare(
          `SELECT m.uid FROM (SELECT uid, flags, size FROM messages WHERE folder_id = ? ORDER BY uid DESC LIMIT ?) m
           WHERE (m.flags & ${SEEN}) = 0 AND m.size <= ? AND NOT EXISTS (SELECT 1 FROM bodies b WHERE b.folder_id = ? AND b.uid = m.uid)
           ORDER BY m.uid DESC LIMIT ?`,
        )
        .all(f.id, among, maxBytes, f.id, limit) as { uid: number }[]
    ).map((r) => r.uid);
  }

  bodyBytes(userId: string, accountId: string): number {
    return (
      this.db
        .prepare('SELECT COALESCE(SUM(b.size), 0) AS n FROM bodies b JOIN folders f ON f.id = b.folder_id WHERE f.user_id = ? AND f.account_id = ?')
        .get(userId, accountId) as { n: number }
    ).n;
  }

  /** Drop the least recently read message content until the account is within `maxBytes`. */
  enforceBodyBudget(userId: string, accountId: string, maxBytes: number) {
    let total = this.bodyBytes(userId, accountId);
    if (total <= maxBytes) return;
    const rows = this.db
      .prepare(
        `SELECT b.folder_id, b.uid, b.size FROM bodies b JOIN folders f ON f.id = b.folder_id
         WHERE f.user_id = ? AND f.account_id = ? ORDER BY b.accessed_at, b.uid`,
      )
      .all(userId, accountId) as { folder_id: number; uid: number; size: number }[];
    const del = this.db.prepare('DELETE FROM bodies WHERE folder_id = ? AND uid = ?');
    this.tx(() => {
      for (const r of rows) {
        if (total <= maxBytes) break;
        del.run(r.folder_id, r.uid);
        total -= r.size;
      }
    });
  }
}
