import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AccountInput, AccountView, Preferences, TlsMode } from '../../shared/types.js';
import { decrypt, encrypt } from './crypto.js';

const MIGRATIONS: string[] = [
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
];

export const DEFAULT_PREFERENCES: Preferences = {
  theme: 'system',
  pageSize: 50,
  markReadOnOpen: true,
  swipeLeft: 'delete',
  swipeRight: 'archive',
};

export interface User {
  id: string;
  issuer: string;
  subject: string;
  email: string;
  name: string;
  preferences: Preferences;
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
 * preferences and recently used recipients. No mail content is ever stored.
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
        this.db.exec(MIGRATIONS[v]!);
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

  upsertUser(issuer: string, subject: string, email: string, name: string): User {
    const existing = this.db
      .prepare('SELECT id FROM users WHERE issuer = ? AND subject = ?')
      .get(issuer, subject) as { id: string } | undefined;
    if (existing) {
      this.db.prepare('UPDATE users SET email = ?, name = ? WHERE id = ?').run(email, name, existing.id);
      return this.getUser(existing.id)!;
    }
    const id = crypto.randomUUID();
    this.db
      .prepare('INSERT INTO users (id, issuer, subject, email, name, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, issuer, subject, email, name, Date.now());
    return this.getUser(id)!;
  }

  getUser(id: string): User | null {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as
      | { id: string; issuer: string; subject: string; email: string; name: string; preferences: string }
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
      preferences: { ...DEFAULT_PREFERENCES, ...prefs },
    };
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
}
