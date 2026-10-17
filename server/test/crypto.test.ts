import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decrypt, encrypt, Keyring, openJson, sealJson } from '../src/crypto.js';
import { Store } from '../src/db.js';
import type { AccountInput } from '../../shared/types.js';

// Generated per test run; never a real key.
const secret = () => crypto.randomBytes(48).toString('base64');

const account = (password: string): AccountInput => ({
  name: 'Work',
  displayName: 'Test User',
  email: 'user@example.com',
  color: '#3366ff',
  imap: { host: 'mail.example.com', port: 993, tls: 'tls', user: 'user@example.com', password },
  smtp: { host: 'mail.example.com', port: 465, tls: 'tls', user: 'user@example.com', password },
  appendSent: true,
});

describe('AES-256-GCM helpers', () => {
  const key = new Keyring(secret()).credentialKey;

  it('round-trips', () => {
    const ct = encrypt(key, 'hunter2 – ünïcode', 'ctx');
    expect(ct).not.toContain('hunter2');
    expect(decrypt(key, ct, 'ctx')).toBe('hunter2 – ünïcode');
  });

  it('uses a fresh IV every time', () => {
    expect(encrypt(key, 'same', 'ctx')).not.toBe(encrypt(key, 'same', 'ctx'));
  });

  it('rejects tampered ciphertext', () => {
    const ct = encrypt(key, 'secret', 'ctx');
    const parts = ct.split('.');
    const body = Buffer.from(parts[3]!, 'base64url');
    body[0] = body[0]! ^ 1;
    parts[3] = body.toString('base64url');
    expect(() => decrypt(key, parts.join('.'), 'ctx')).toThrow();
  });

  it('rejects a different context (AAD) or key', () => {
    const ct = encrypt(key, 'secret', 'user-a');
    expect(() => decrypt(key, ct, 'user-b')).toThrow();
    expect(() => decrypt(new Keyring(secret()).credentialKey, ct, 'user-a')).toThrow();
  });

  it('derives independent subkeys', () => {
    const k = new Keyring(secret());
    expect(k.credentialKey.equals(k.sessionKey)).toBe(false);
    expect(k.sessionKey.equals(k.signingKey)).toBe(false);
  });

  it('refuses short master secrets', () => {
    expect(() => new Keyring('too-short')).toThrow();
  });

  it('sealed JSON expires and is purpose-bound', () => {
    const k = new Keyring(secret()).sessionKey;
    const sealed = sealJson(k, { uid: 'u1' }, 60, 'session');
    expect(openJson(k, sealed, 'session')).toEqual({ uid: 'u1' });
    expect(openJson(k, sealed, 'login')).toBeNull();
    expect(openJson(k, sealJson(k, { uid: 'u1' }, -1, 'session'), 'session')).toBeNull();
    expect(openJson(k, 'garbage', 'session')).toBeNull();
  });
});

describe('Store credential handling', () => {
  const keyring = new Keyring(secret());
  const newStore = () => new Store(':memory:', keyring.credentialKey);

  it('stores passwords encrypted, never in plaintext', () => {
    const store = newStore();
    const user = store.upsertUser('https://auth.example.com', 'sub-1', 'user@example.com', 'User');
    store.createAccount(user.id, account('correct-horse-battery-staple'));
    const rows = store.db.prepare('SELECT imap_password, smtp_password FROM accounts').all() as Record<string, string>[];
    for (const r of rows) {
      expect(r.imap_password).toMatch(/^v1\./);
      expect(JSON.stringify(r)).not.toContain('correct-horse');
    }
  });

  it('never exposes passwords through the client-facing view', () => {
    const store = newStore();
    const user = store.upsertUser('https://auth.example.com', 'sub-1', 'user@example.com', 'User');
    const view = store.createAccount(user.id, account('pw-123456'));
    expect(JSON.stringify(view)).not.toContain('pw-123456');
    expect(JSON.stringify(store.listAccounts(user.id))).not.toContain('pw-123456');
    expect(store.getAccountSecret(user.id, view.id)!.imap.password).toBe('pw-123456');
  });

  it('keeps the stored password when an update omits it', () => {
    const store = newStore();
    const user = store.upsertUser('https://auth.example.com', 'sub-1', 'user@example.com', 'User');
    const view = store.createAccount(user.id, account('original-pw'));
    const input = account('');
    delete input.imap.password;
    store.updateAccount(user.id, view.id, { ...input, name: 'Renamed' });
    const secretView = store.getAccountSecret(user.id, view.id)!;
    expect(secretView.name).toBe('Renamed');
    expect(secretView.imap.password).toBe('original-pw');
  });

  it('isolates users from each other', () => {
    const store = newStore();
    const alice = store.upsertUser('https://auth.example.com', 'alice', 'alice@example.com', 'Alice');
    const bob = store.upsertUser('https://auth.example.com', 'bob', 'bob@example.com', 'Bob');
    const acc = store.createAccount(alice.id, account('alice-pw'));
    expect(store.listAccounts(bob.id)).toEqual([]);
    expect(store.getAccountSecret(bob.id, acc.id)).toBeNull();
    expect(store.updateAccount(bob.id, acc.id, account('x'))).toBeNull();
    expect(store.deleteAccount(bob.id, acc.id)).toBe(false);
    expect(store.listAccounts(alice.id)).toHaveLength(1);
  });

  it('binds ciphertext to its owner: copying it to another user fails', () => {
    const store = newStore();
    const alice = store.upsertUser('https://auth.example.com', 'alice', 'alice@example.com', 'Alice');
    const bob = store.upsertUser('https://auth.example.com', 'bob', 'bob@example.com', 'Bob');
    const a = store.createAccount(alice.id, account('alice-pw'));
    const b = store.createAccount(bob.id, account('bob-pw'));
    const stolen = store.db.prepare('SELECT imap_password FROM accounts WHERE id = ?').get(a.id) as { imap_password: string };
    store.db.prepare('UPDATE accounts SET imap_password = ? WHERE id = ?').run(stolen.imap_password, b.id);
    expect(() => store.getAccountSecret(bob.id, b.id)).toThrow();
  });

  it('upserts users by issuer and subject', () => {
    const store = newStore();
    const a = store.upsertUser('https://auth.example.com', 'sub', 'a@example.com', 'A');
    const b = store.upsertUser('https://auth.example.com', 'sub', 'b@example.com', 'B');
    const c = store.upsertUser('https://other.example.com', 'sub', 'c@example.com', 'C');
    expect(b.id).toBe(a.id);
    expect(b.email).toBe('b@example.com');
    expect(c.id).not.toBe(a.id);
  });
});
