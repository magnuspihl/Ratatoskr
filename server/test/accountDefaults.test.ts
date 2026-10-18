import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { AccountInput } from '../../shared/types.js';
import { accountDefaultsFor, expandTemplate, withDefaultPassword } from '../src/accountDefaults.js';
import { buildApp, type App } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { Keyring } from '../src/crypto.js';
import { Store } from '../src/db.js';

const SECRET = crypto.randomBytes(48).toString('base64');
const base = { NODE_ENV: 'test', RATATOSKR_SECRET_KEY: SECRET };

// One shared mail provider for everyone, username derived from the login.
const mailhost = {
  ...base,
  RATATOSKR_DEFAULT_IMAP_HOST: 'imap.example.net',
  RATATOSKR_DEFAULT_SMTP_HOST: 'smtp.example.net',
  RATATOSKR_DEFAULT_MAIL_USERNAME: '{username}@example.org',
  RATATOSKR_DEFAULT_EMAIL: '{username}@example.org',
};

const alice = { username: 'alice', email: 'alice@example.com', name: 'Alice Liddell' };

const input = (imapHost: string, smtpHost: string, imapPw = '', smtpPw = ''): AccountInput => ({
  name: 'Mail',
  displayName: '',
  email: 'alice@example.org',
  color: '#3b82f6',
  imap: { host: imapHost, port: 993, tls: 'tls', user: 'alice@example.org', password: imapPw },
  smtp: { host: smtpHost, port: 465, tls: 'tls', user: 'alice@example.org', password: smtpPw },
  appendSent: true,
});

describe('templates in default account settings', () => {
  it('fills in {username}, {email} and {name}', () => {
    expect(expandTemplate('{username}@example.org', alice)).toBe('alice@example.org');
    expect(expandTemplate('{name} <{email}>', alice)).toBe('Alice Liddell <alice@example.com>');
    expect(expandTemplate('imap.example.net', alice)).toBe('imap.example.net');
  });

  it('leaves the field empty when the user has no value for a token, instead of "@example.org"', () => {
    expect(expandTemplate('{username}@example.org', { ...alice, username: '' })).toBe('');
  });
});

describe('default account settings configuration', () => {
  it('reads servers, username and email from the environment', () => {
    const d = loadConfig(mailhost).accountDefaults;
    expect(d.imap.host).toBe('imap.example.net');
    expect(d.smtp.host).toBe('smtp.example.net');
    expect(d.user).toBe('{username}@example.org');
    expect(d.password).toBe('');
  });

  it('refuses to start with a misspelled token, naming the variable', () => {
    expect(() => loadConfig({ ...base, RATATOSKR_DEFAULT_MAIL_USERNAME: '{usename}@example.org' })).toThrow(
      /RATATOSKR_DEFAULT_MAIL_USERNAME uses unknown token\(s\) \{usename\}/,
    );
  });

  it('rejects an invalid port or security mode', () => {
    expect(() => loadConfig({ ...base, RATATOSKR_DEFAULT_IMAP_PORT: '99999' })).toThrow(/RATATOSKR_DEFAULT_IMAP_PORT/);
    expect(() => loadConfig({ ...base, RATATOSKR_DEFAULT_SMTP_SECURITY: 'ssl' })).toThrow(/RATATOSKR_DEFAULT_SMTP_SECURITY/);
  });

  it('takes the default password literally, braces and spaces included', () => {
    expect(loadConfig({ ...base, RATATOSKR_DEFAULT_MAIL_PASSWORD: ' p{a}ss ' }).accountDefaults.password).toBe(' p{a}ss ');
  });

  it('picks the standard port for the chosen security mode unless a port is given', () => {
    const d = accountDefaultsFor(loadConfig({ ...base, RATATOSKR_DEFAULT_SMTP_SECURITY: 'starttls', RATATOSKR_DEFAULT_IMAP_PORT: '1993' }).accountDefaults, alice);
    expect(d.imap).toMatchObject({ port: 1993, tls: 'tls' });
    expect(d.smtp).toMatchObject({ port: 587, tls: 'starttls' });
  });

  it('starts with an empty form (SSL/TLS on 993 and 465) when nothing is configured', () => {
    expect(accountDefaultsFor(loadConfig(base).accountDefaults, alice)).toEqual({
      name: '',
      displayName: '',
      email: '',
      imap: { host: '', port: 993, tls: 'tls', user: '' },
      smtp: { host: '', port: 465, tls: 'tls', user: '' },
      password: false,
    });
  });
});

describe('default password', () => {
  const config = loadConfig({ ...mailhost, RATATOSKR_DEFAULT_MAIL_PASSWORD: 'shared secret' }).accountDefaults;

  it('fills blank passwords while the servers are the default ones (any letter case)', () => {
    const filled = withDefaultPassword(config, alice, input('IMAP.example.net', 'smtp.example.net'));
    expect(filled.imap.password).toBe('shared secret');
    expect(filled.smtp.password).toBe('shared secret');
  });

  it('keeps a password the user typed, also for SMTP via "Same as IMAP"', () => {
    const filled = withDefaultPassword(config, alice, input('imap.example.net', 'smtp.example.net', 'mine'));
    expect(filled.imap.password).toBe('mine');
    expect(filled.smtp.password).toBe('mine');
  });

  it('is never sent to a server the user chose instead of the default', () => {
    const otherSmtp = withDefaultPassword(config, alice, input('imap.example.net', 'smtp.gmail.com'));
    expect(otherSmtp.imap.password).toBe('shared secret');
    expect(otherSmtp.smtp.password).toBe('');
    const otherImap = withDefaultPassword(config, alice, input('imap.gmail.com', 'smtp.example.net'));
    expect(otherImap.imap.password).toBe('');
  });
});

describe('default account settings over HTTP', () => {
  let ctx: App | null = null;
  afterEach(async () => {
    await ctx?.app.close();
    ctx = null;
  });

  async function signUp(env: Record<string, string>, username: string) {
    const config = loadConfig(env);
    ctx = await buildApp(config, { store: new Store(':memory:', new Keyring(config.secretKey).credentialKey), logger: false });
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/auth/password/register',
      payload: { username, password: 'a long password' },
      headers: { 'x-ratatoskr': '1' },
    });
    const c = res.cookies.find((c) => c.name === 'rk_session')!;
    return `rk_session=${c.value}`;
  }

  it("gives each user the defaults with their own username filled in, but never the password", async () => {
    const cookie = await signUp({ ...mailhost, RATATOSKR_DEFAULT_MAIL_PASSWORD: 'shared secret' }, 'Carol');
    const res = await ctx!.app.inject({ url: '/api/me', headers: { cookie } });
    expect(res.json().accountDefaults).toEqual({
      name: '',
      displayName: '',
      email: 'carol@example.org',
      imap: { host: 'imap.example.net', port: 993, tls: 'tls', user: 'carol@example.org' },
      smtp: { host: 'smtp.example.net', port: 465, tls: 'tls', user: 'carol@example.org' },
      password: true,
    });
    expect(res.body).not.toContain('shared secret');
  });

  it('still asks for a password when the user switches to another mail server', async () => {
    const cookie = await signUp({ ...mailhost, RATATOSKR_DEFAULT_MAIL_PASSWORD: 'shared secret' }, 'alice');
    const res = await ctx!.app.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: input('imap.gmail.com', 'smtp.gmail.com'),
      headers: { cookie, 'x-ratatoskr': '1' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('IMAP password is required');
  });
});

describe('usernames of existing users', () => {
  it('are filled in from the login name of password users when the database is upgraded', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rk-username-'));
    const file = path.join(dir, 'ratatoskr.db');
    try {
      const key = crypto.randomBytes(32);
      const before = new Store(file, key);
      const id = before.createPasswordUser('local', 'alice', 'hash')!.id;
      before.close();
      // Back to the schema before usernames were stored.
      const db = new DatabaseSync(file);
      db.exec('ALTER TABLE users DROP COLUMN username; PRAGMA user_version = 5;');
      db.close();

      const store = new Store(file, key);
      expect(store.getUser(id)?.username).toBe('alice');
      store.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
