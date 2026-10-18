import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AccountInput, AccountView, Preferences, PushSubscriptionInput, TlsMode } from '../../shared/types.js';
import { decrypt, encrypt } from './crypto.js';

// Snoozed messages: where each one waits (IMAP folder, UIDVALIDITY, UID) and when it returns to
// INBOX. IMAP has a "Snoozed" folder attribute but no wake-up time, so the time lives here.
const SNOOZES_SQL = `CREATE TABLE IF NOT EXISTS snoozes (
     account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
     folder TEXT NOT NULL,
     uid_validity TEXT NOT NULL,
     uid INTEGER NOT NULL,
     until INTEGER NOT NULL,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (account_id, folder, uid_validity, uid)
   );
   CREATE INDEX IF NOT EXISTS snoozes_until ON snoozes(until);`;

const MIGRATIONS: (string | ((db: DatabaseSync) => void))[] = [
  `CREATE TABLE users (
     id TEXT PRIMARY KEY,
     issuer TEXT NOT NULL,
     subject TEXT NOT NULL,
     email TEXT NOT NULL DEFAULT '',
     name TEXT NOT NULL DEFAULT '',
     preferences TEXT NOT NULL DEFAULT '{}',
     created_at INTEGER NOT NULL,
     UNIQUE (issuer, subject)
   );
   CREATE TABLE accounts (
     id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     name TEXT NOT NULL,
     display_name TEXT NOT NULL,
     email TEXT NOT NULL,
     color TEXT NOT NULL,
     imap_host TEXT NOT NULL, imap_port INTEGER NOT NULL, imap_tls TEXT NOT NULL,
     imap_user TEXT NOT NULL, imap_password TEXT NOT NULL,
     smtp_host TEXT NOT NULL, smtp_port INTEGER NOT NULL, smtp_tls TEXT NOT NULL,
     smtp_user TEXT NOT NULL, smtp_password TEXT NOT NULL,
     append_sent INTEGER NOT NULL DEFAULT 1,
     position INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL
   );
   CREATE INDEX accounts_user ON accounts(user_id);
   CREATE TABLE recent_recipients (
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     address TEXT NOT NULL,
     name TEXT NOT NULL DEFAULT '',
     last_used INTEGER NOT NULL,
     uses INTEGER NOT NULL DEFAULT 1,
     PRIMARY KEY (user_id, address)
   );`,
  `CREATE TABLE image_domains (
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     domain TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (user_id, domain)
   );`,
  // Web Push: one row per browser/device. The endpoint is unique, so a device that is used by a
  // different user after a re-login moves to that user instead of receiving both users' mail.
  `CREATE TABLE push_subscriptions (
     endpoint TEXT PRIMARY KEY,
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     p256dh TEXT NOT NULL,
     auth TEXT NOT NULL,
     created_at INTEGER NOT NULL
   );
   CREATE INDEX push_subscriptions_user ON push_subscriptions(user_id);
   CREATE TABLE inbox_state (
     account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
     uid_validity TEXT NOT NULL,
     last_uid INTEGER NOT NULL
   );`,
  SNOOZES_SQL,
  // Username/password login: such users have issuer 'local' and the normalised username as subject.
  // Dev databases shared between branches may already be at this version with the password column
  // and without snoozes (both branches used the same migration number), so repair either way.
  (db) => {
    db.exec(SNOOZES_SQL);
    const cols = db.prepare("SELECT name FROM pragma_table_info('users')").all() as { name: string }[];
    if (!cols.some((c) => c.name === 'password_hash')) db.exec('ALTER TABLE users ADD COLUMN password_hash TEXT;');
  },
  // The user's short name for {username} in default account settings: the login name of password
  // users, the provider's preferred_username for OIDC users (filled in at their next login).
  (db) => {
    const cols = db.prepare("SELECT name FROM pragma_table_info('users')").all() as { name: string }[];
    if (!cols.some((c) => c.name === 'username')) db.exec("ALTER TABLE users ADD COLUMN username TEXT NOT NULL DEFAULT '';");
    db.exec("UPDATE users SET username = subject WHERE password_hash IS NOT NULL AND username = '';");
  },
];

/** Most devices one user can have notifications on; the oldest subscription is dropped beyond that. */
export const MAX_PUSH_SUBSCRIPTIONS = 20;

export const DEFAULT_PREFERENCES: Preferences = {
  theme: 'system',
  pageSize: 50,
  markReadOnOpen: true,
  swipeLeft: 'delete',
  swipeRight: 'archive',
  notificationContent: 'full',
  screenTransitions: 'fast',
  contactPhotos: true,
};

export interface User {
  id: string;
  issuer: string;
  subject: string;
  email: string;
  name: string;
  /** Short user name, e.g. "alice" (may be empty for OIDC users whose provider sends none). */
  username: string;
  preferences: Preferences;
  /** Signs in with a username and password (as opposed to OIDC). */
  hasPassword: boolean;
}

/** A snoozed message: where it waits and when it returns to INBOX (ms since the epoch). */
export interface Snooze {
  userId: string;
  accountId: string;
  folder: string;
  uidValidity: string;
  uid: number;
  until: number;
}

/** Full account including decrypted credentials. Server-side only, never serialise to clients. */
export interface AccountSecret extends AccountView {
  userId: string;
  imap: AccountView['imap'] & { password: string };
  smtp: AccountView['smtp'] & { password: string };
}

interface AccountRow {
  id: string;
  user_id: string;
  name: string;
  display_name: string;
  email: string;
  color: string;
  imap_host: string;
  imap_port: number;
  imap_tls: string;
  imap_user: string;
  imap_password: string;
  smtp_host: string;
  smtp_port: number;
  smtp_tls: string;
  smtp_user: string;
  smtp_password: string;
  append_sent: number;
}

function credAad(userId: string, accountId: string, kind: 'imap' | 'smtp'): string {
  return `account-credential:${userId}:${accountId}:${kind}`;
}

function toView(r: AccountRow): AccountView {
  return {
    id: r.id,
    name: r.name,
    displayName: r.display_name,
    email: r.email,
    color: r.color,
    imap: { host: r.imap_host, port: r.imap_port, tls: r.imap_tls as TlsMode, user: r.imap_user },
    smtp: { host: r.smtp_host, port: r.smtp_port, tls: r.smtp_tls as TlsMode, user: r.smtp_user },
    appendSent: r.append_sent === 1,
  };
}

/**
 * Persistence for the only state Ratatoskr keeps: users, their (encrypted) account settings,
 * preferences, recently used recipients, sender domains allowed to show images, Web Push
 * subscriptions, the highest INBOX UID already notified about and when snoozed messages (by folder
 * and UID) return. No mail content is ever stored.
 *
 * Every account query is scoped by user id; there is deliberately no "get account by id" without
 * an owner, which keeps per-user isolation enforced at the data layer.
 */
export class Store {
  readonly db: DatabaseSync;

  constructor(
    file: string,
    private readonly credentialKey: Buffer,
  ) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  private migrate() {
    const current = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    for (let v = current; v < MIGRATIONS.length; v++) {
      this.db.exec('BEGIN');
      try {
        const m = MIGRATIONS[v]!;
        if (typeof m === 'string') this.db.exec(m);
        else m(this.db);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    }
  }

  close() {
    this.db.close();
  }

  // ---- users ---------------------------------------------------------------

  upsertUser(issuer: string, subject: string, email: string, name: string, username = ''): User {
    const existing = this.db
      .prepare('SELECT id FROM users WHERE issuer = ? AND subject = ?')
      .get(issuer, subject) as { id: string } | undefined;
    if (existing) {
      this.db.prepare('UPDATE users SET email = ?, name = ?, username = ? WHERE id = ?').run(email, name, username, existing.id);
      return this.getUser(existing.id)!;
    }
    const id = crypto.randomUUID();
    this.db
      .prepare('INSERT INTO users (id, issuer, subject, email, name, username, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, issuer, subject, email, name, username, Date.now());
    return this.getUser(id)!;
  }

  getUser(id: string): User | null {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as
      | { id: string; issuer: string; subject: string; email: string; name: string; username: string; preferences: string; password_hash: string | null }
      | undefined;
    if (!row) return null;
    let prefs: Partial<Preferences> = {};
    try {
      prefs = JSON.parse(row.preferences) as Partial<Preferences>;
    } catch {
      /* fall back to defaults */
    }
    return {
      id: row.id,
      issuer: row.issuer,
      subject: row.subject,
      email: row.email,
      name: row.name,
      username: row.username,
      preferences: { ...DEFAULT_PREFERENCES, ...prefs },
      hasPassword: row.password_hash !== null,
    };
  }

  countUsers(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  }

  /** A password user and their stored hash, by normalised username. */
  findPasswordUser(issuer: string, username: string): { user: User; passwordHash: string } | null {
    const row = this.db
      .prepare('SELECT id, password_hash FROM users WHERE issuer = ? AND subject = ? AND password_hash IS NOT NULL')
      .get(issuer, username) as { id: string; password_hash: string } | undefined;
    return row ? { user: this.getUser(row.id)!, passwordHash: row.password_hash } : null;
  }

  /** Creates a password user; null if the username is taken. */
  createPasswordUser(issuer: string, username: string, passwordHash: string): User | null {
    const id = crypto.randomUUID();
    const email = username.includes('@') ? username : '';
    const res = this.db
      .prepare(
        `INSERT INTO users (id, issuer, subject, email, name, username, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (issuer, subject) DO NOTHING`,
      )
      .run(id, issuer, username, email, username, username, passwordHash, Date.now());
    return res.changes > 0 ? this.getUser(id) : null;
  }

  setPasswordHash(userId: string, passwordHash: string) {
    this.db.prepare('UPDATE users SET password_hash = ? WHERE id = ? AND password_hash IS NOT NULL').run(passwordHash, userId);
  }

  getPasswordHash(userId: string): string | null {
    const row = this.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId) as { password_hash: string | null } | undefined;
    return row?.password_hash ?? null;
  }

  setPreferences(userId: string, prefs: Preferences) {
    this.db.prepare('UPDATE users SET preferences = ? WHERE id = ?').run(JSON.stringify(prefs), userId);
  }

  // ---- accounts ------------------------------------------------------------

  listAccounts(userId: string): AccountView[] {
    const rows = this.db
      .prepare('SELECT * FROM accounts WHERE user_id = ? ORDER BY position, created_at')
      .all(userId) as unknown as AccountRow[];
    return rows.map(toView);
  }

  getAccountSecret(userId: string, accountId: string): AccountSecret | null {
    const r = this.db
      .prepare('SELECT * FROM accounts WHERE user_id = ? AND id = ?')
      .get(userId, accountId) as AccountRow | undefined;
    if (!r) return null;
    const view = toView(r);
    return {
      ...view,
      userId: r.user_id,
      imap: { ...view.imap, password: decrypt(this.credentialKey, r.imap_password, credAad(userId, r.id, 'imap')) },
      smtp: { ...view.smtp, password: decrypt(this.credentialKey, r.smtp_password, credAad(userId, r.id, 'smtp')) },
    };
  }

  /** Creates an account. Passwords are required on create. */
  createAccount(userId: string, input: AccountInput, id: string = crypto.randomUUID()): AccountView {
    const imapPw = input.imap.password ?? '';
    const smtpPw = input.smtp.password ?? imapPw;
    const position =
      (this.db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM accounts WHERE user_id = ?').get(userId) as {
        p: number;
      }).p;
    this.db
      .prepare(
        `INSERT INTO accounts (id, user_id, name, display_name, email, color,
           imap_host, imap_port, imap_tls, imap_user, imap_password,
           smtp_host, smtp_port, smtp_tls, smtp_user, smtp_password,
           append_sent, position, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        userId,
        input.name,
        input.displayName,
        input.email,
        input.color,
        input.imap.host,
        input.imap.port,
        input.imap.tls,
        input.imap.user,
        encrypt(this.credentialKey, imapPw, credAad(userId, id, 'imap')),
        input.smtp.host,
        input.smtp.port,
        input.smtp.tls,
        input.smtp.user,
        encrypt(this.credentialKey, smtpPw, credAad(userId, id, 'smtp')),
        input.appendSent ? 1 : 0,
        position,
        Date.now(),
      );
    return this.listAccounts(userId).find((a) => a.id === id)!;
  }

  /** Updates an account. Omitted passwords keep their stored value. */
  updateAccount(userId: string, accountId: string, input: AccountInput): AccountView | null {
    const current = this.getAccountSecret(userId, accountId);
    if (!current) return null;
    const imapPw = input.imap.password || current.imap.password;
    const smtpPw = input.smtp.password || current.smtp.password;
    this.db
      .prepare(
        `UPDATE accounts SET name = ?, display_name = ?, email = ?, color = ?,
           imap_host = ?, imap_port = ?, imap_tls = ?, imap_user = ?, imap_password = ?,
           smtp_host = ?, smtp_port = ?, smtp_tls = ?, smtp_user = ?, smtp_password = ?,
           append_sent = ?
         WHERE user_id = ? AND id = ?`,
      )
      .run(
        input.name,
        input.displayName,
        input.email,
        input.color,
        input.imap.host,
        input.imap.port,
        input.imap.tls,
        input.imap.user,
        encrypt(this.credentialKey, imapPw, credAad(userId, accountId, 'imap')),
        input.smtp.host,
        input.smtp.port,
        input.smtp.tls,
        input.smtp.user,
        encrypt(this.credentialKey, smtpPw, credAad(userId, accountId, 'smtp')),
        input.appendSent ? 1 : 0,
        userId,
        accountId,
      );
    return this.listAccounts(userId).find((a) => a.id === accountId) ?? null;
  }

  deleteAccount(userId: string, accountId: string): boolean {
    return this.db.prepare('DELETE FROM accounts WHERE user_id = ? AND id = ?').run(userId, accountId).changes > 0;
  }

  // ---- recent recipients (address autocomplete) ----------------------------

  rememberRecipients(userId: string, recipients: { name: string; address: string }[]) {
    const stmt = this.db.prepare(
      `INSERT INTO recent_recipients (user_id, address, name, last_used) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id, address) DO UPDATE SET
         name = CASE WHEN excluded.name != '' THEN excluded.name ELSE name END,
         last_used = excluded.last_used, uses = uses + 1`,
    );
    const now = Date.now();
    for (const r of recipients) stmt.run(userId, r.address.toLowerCase(), r.name, now);
    // Keep the table small: only the 500 most recent per user.
    this.db
      .prepare(
        `DELETE FROM recent_recipients WHERE user_id = ? AND address NOT IN (
           SELECT address FROM recent_recipients WHERE user_id = ? ORDER BY last_used DESC LIMIT 500)`,
      )
      .run(userId, userId);
  }

  searchRecipients(userId: string, query: string, limit = 8): { name: string; address: string }[] {
    const like = `%${query.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    return this.db
      .prepare(
        `SELECT name, address FROM recent_recipients
         WHERE user_id = ? AND (address LIKE ? ESCAPE '\\' OR lower(name) LIKE ? ESCAPE '\\')
         ORDER BY uses DESC, last_used DESC LIMIT ?`,
      )
      .all(userId, like, like, limit) as { name: string; address: string }[];
  }

  // ---- sender domains whose remote images load automatically -----------------
  // Domains are stored normalised (lowercase ASCII/punycode); callers validate them first.

  listImageDomains(userId: string): string[] {
    return (
      this.db.prepare('SELECT domain FROM image_domains WHERE user_id = ? ORDER BY domain').all(userId) as { domain: string }[]
    ).map((r) => r.domain);
  }

  /** Returns false if the user already has `max` domains (re-adding an existing one is fine). */
  addImageDomain(userId: string, domain: string, max: number): boolean {
    const count = (this.db.prepare('SELECT COUNT(*) AS n FROM image_domains WHERE user_id = ?').get(userId) as { n: number }).n;
    const exists = !!this.db.prepare('SELECT 1 FROM image_domains WHERE user_id = ? AND domain = ?').get(userId, domain);
    if (exists) return true;
    if (count >= max) return false;
    this.db.prepare('INSERT INTO image_domains (user_id, domain, created_at) VALUES (?, ?, ?)').run(userId, domain, Date.now());
    return true;
  }

  removeImageDomain(userId: string, domain: string): boolean {
    return this.db.prepare('DELETE FROM image_domains WHERE user_id = ? AND domain = ?').run(userId, domain).changes > 0;
  }

  // ---- Web Push subscriptions ------------------------------------------------

  addPushSubscription(userId: string, sub: PushSubscriptionInput) {
    this.db
      .prepare(
        `INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh,
           auth = excluded.auth, created_at = excluded.created_at`,
      )
      .run(sub.endpoint, userId, sub.keys.p256dh, sub.keys.auth, Date.now());
    this.db
      .prepare(
        `DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint NOT IN (
           SELECT endpoint FROM push_subscriptions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?)`,
      )
      .run(userId, userId, MAX_PUSH_SUBSCRIPTIONS);
  }

  listPushSubscriptions(userId: string): PushSubscriptionInput[] {
    const rows = this.db
      .prepare('SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ? ORDER BY created_at')
      .all(userId) as { endpoint: string; p256dh: string; auth: string }[];
    return rows.map((r) => ({ endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } }));
  }

  removePushSubscription(userId: string, endpoint: string): boolean {
    return this.db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').run(userId, endpoint).changes > 0;
  }

  /** Users with notifications enabled on at least one device. */
  pushUserIds(): string[] {
    return (this.db.prepare('SELECT DISTINCT user_id FROM push_subscriptions').all() as { user_id: string }[]).map((r) => r.user_id);
  }

  // ---- highest INBOX UID already notified about (per account) ---------------------

  getInboxState(userId: string, accountId: string): { uidValidity: string; lastUid: number } | null {
    const row = this.db
      .prepare(
        `SELECT s.uid_validity, s.last_uid FROM inbox_state s JOIN accounts a ON a.id = s.account_id
         WHERE a.user_id = ? AND a.id = ?`,
      )
      .get(userId, accountId) as { uid_validity: string; last_uid: number } | undefined;
    return row ? { uidValidity: row.uid_validity, lastUid: row.last_uid } : null;
  }

  /** Forget every mark of a user, so new-mail tracking starts over from "now". */
  clearInboxState(userId: string) {
    this.db.prepare('DELETE FROM inbox_state WHERE account_id IN (SELECT id FROM accounts WHERE user_id = ?)').run(userId);
  }

  setInboxState(userId: string, accountId: string, uidValidity: string, lastUid: number) {
    this.db
      .prepare(
        `INSERT INTO inbox_state (account_id, uid_validity, last_uid)
         SELECT id, ?, ? FROM accounts WHERE user_id = ? AND id = ?
         ON CONFLICT (account_id) DO UPDATE SET uid_validity = excluded.uid_validity, last_uid = excluded.last_uid`,
      )
      .run(uidValidity, lastUid, userId, accountId);
  }

  // ---- snoozed messages ------------------------------------------------------------

  /** Snooze (or re-snooze) messages of one folder until `until`. */
  setSnoozes(userId: string, accountId: string, folder: string, uidValidity: string, uids: number[], until: number) {
    const stmt = this.db.prepare(
      `INSERT INTO snoozes (account_id, folder, uid_validity, uid, until, created_at)
       SELECT id, ?, ?, ?, ?, ? FROM accounts WHERE user_id = ? AND id = ?
       ON CONFLICT (account_id, folder, uid_validity, uid) DO UPDATE SET until = excluded.until`,
    );
    const now = Date.now();
    for (const uid of uids) stmt.run(folder, uidValidity, uid, until, now, userId, accountId);
  }

  /** Wake-up times of the snoozed messages in one folder, by UID. */
  snoozesIn(userId: string, accountId: string, folder: string, uidValidity: string): Map<number, number> {
    const rows = this.db
      .prepare(
        `SELECT s.uid, s.until FROM snoozes s JOIN accounts a ON a.id = s.account_id
         WHERE a.user_id = ? AND a.id = ? AND s.folder = ? AND s.uid_validity = ?`,
      )
      .all(userId, accountId, folder, uidValidity) as { uid: number; until: number }[];
    return new Map(rows.map((r) => [r.uid, r.until]));
  }

  /** Forget snoozes (the messages were woken, moved elsewhere or deleted). */
  deleteSnoozes(userId: string, accountId: string, folder: string, uidValidity: string, uids: number[]) {
    const stmt = this.db.prepare(
      `DELETE FROM snoozes WHERE account_id IN (SELECT id FROM accounts WHERE user_id = ? AND id = ?)
         AND folder = ? AND uid_validity = ? AND uid = ?`,
    );
    for (const uid of uids) stmt.run(userId, accountId, folder, uidValidity, uid);
  }

  /** Snoozes whose time has come, oldest first, across all users. */
  dueSnoozes(now: number, limit = 500): Snooze[] {
    const rows = this.db
      .prepare(
        `SELECT a.user_id, s.account_id, s.folder, s.uid_validity, s.uid, s.until
         FROM snoozes s JOIN accounts a ON a.id = s.account_id
         WHERE s.until <= ? ORDER BY s.until LIMIT ?`,
      )
      .all(now, limit) as { user_id: string; account_id: string; folder: string; uid_validity: string; uid: number; until: number }[];
    return rows.map((r) => ({ userId: r.user_id, accountId: r.account_id, folder: r.folder, uidValidity: r.uid_validity, uid: r.uid, until: r.until }));
  }

  /** When the next snoozed message is due, or null if nothing is snoozed. */
  nextSnoozeDue(): number | null {
    return (this.db.prepare('SELECT MIN(until) AS t FROM snoozes').get() as { t: number | null }).t;
  }
}
