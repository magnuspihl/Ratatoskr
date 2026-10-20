import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ImapFlow } from 'imapflow';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { AccountView, ListResponse, Me, MessageDetail, MessageSummary, ServerEvent } from '../../../shared/types.js';
import { buildApp, type App } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { Keyring } from '../../src/crypto.js';
import { Store } from '../../src/db.js';

/**
 * The mail cache end to end against GreenMail: INBOX and Sent are answered from local copies,
 * which follow what happens on the server (also changes made by other mail clients), and the
 * IMAP server stays the source of truth. Uses its own mailboxes.
 */

const gm = inject('greenmail');
const HEDY = `hedy-${crypto.randomUUID().slice(0, 6)}@example.com`;
const IVAN = `ivan-${crypto.randomUUID().slice(0, 6)}@example.com`;
const JUNE = `june-${crypto.randomUUID().slice(0, 6)}@example.com`;

let ctx: App;
let store: Store;
let cookie = '';
let userId = '';
let hedy: AccountView;
let ivan: AccountView;
let dir = '';
let cacheFile = '';
const events: ServerEvent[] = [];

function imap(user: string) {
  const c = new ImapFlow({ host: gm.host, port: gm.imapPort, secure: false, doSTARTTLS: false, auth: { user, pass: 'x' }, logger: false });
  c.on('error', () => {});
  return c;
}

async function withImap<T>(user: string, fn: (c: ImapFlow) => Promise<T>): Promise<T> {
  const c = imap(user);
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.logout();
  }
}

function raw(to: string, subject: string, opts: { id?: string; inReplyTo?: string; text?: string; date?: Date } = {}) {
  const thread = opts.inReplyTo ? `In-Reply-To: ${opts.inReplyTo}\r\nReferences: ${opts.inReplyTo}\r\n` : '';
  return Buffer.from(
    `From: Kim <kim@example.com>\r\nTo: ${to}\r\nSubject: ${subject}\r\nDate: ${(opts.date ?? new Date()).toUTCString()}\r\n` +
      `Message-ID: ${opts.id ?? `<${crypto.randomUUID()}@example.com>`}\r\n${thread}MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${opts.text ?? 'hello'}\r\n`,
  );
}

const deliver = (to: string, subject: string, opts: Parameters<typeof raw>[2] & { folder?: string; flags?: string[] } = {}) =>
  withImap(to, (c) => c.append(opts.folder ?? 'INBOX', raw(to, subject, opts), opts.flags ?? []));

async function api<T>(method: 'GET' | 'POST' | 'DELETE', url: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await ctx.app.inject({
    method,
    url,
    headers: { cookie, 'x-ratatoskr': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    payload: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.statusCode, json: JSON.parse(res.body) as T };
}

const list = async (account: AccountView, folder = 'INBOX', query = '') =>
  (await api<ListResponse>('GET', `/api/messages?accountId=${account.id}&folder=${encodeURIComponent(folder)}&limit=200${query}`)).json;
const subjects = (msgs: MessageSummary[]) => msgs.map((m) => m.subject);

const until = async (fn: () => Promise<boolean> | boolean, ms = 15_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
};

/** Wait until the account's INBOX copy is filled, synced after the last change and watched. */
const settled = (account: AccountView) =>
  until(async () => {
    await ctx.cacheSync!.idle();
    return ctx.cacheSync!.isCurrent(userId, account.id, 'INBOX');
  });

/** Count the requests that go to the IMAP server while `fn` runs. */
async function imapCalls<T>(fn: () => Promise<T>): Promise<{ result: T; calls: number }> {
  const pool = ctx.pool;
  const orig = { withMailbox: pool.withMailbox, withClient: pool.withClient };
  let calls = 0;
  pool.withMailbox = ((...args: Parameters<typeof pool.withMailbox>) => {
    calls++;
    return orig.withMailbox.apply(pool, args);
  }) as typeof pool.withMailbox;
  pool.withClient = ((...args: Parameters<typeof pool.withClient>) => {
    calls++;
    return orig.withClient.apply(pool, args);
  }) as typeof pool.withClient;
  try {
    return { result: await fn(), calls };
  } finally {
    Object.assign(pool, orig);
  }
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ratatoskr-cache-it-'));
  cacheFile = path.join(dir, 'cache.db');
  const config = loadConfig({
    NODE_ENV: 'test',
    RATATOSKR_SECRET_KEY: crypto.randomBytes(48).toString('base64'),
    RATATOSKR_DEV_LOGIN: 'true',
    RATATOSKR_DATA_DIR: '/nonexistent-not-used',
    RATATOSKR_BASE_URL: 'http://localhost:8080',
    RATATOSKR_CACHE_MESSAGES: '50',
  });
  store = new Store(':memory:', new Keyring(config.secretKey).credentialKey);
  ctx = await buildApp(config, { store, logger: false, cacheFile, pushTransport: async () => 'sent', pushHostCheck: async () => {} });
  await ctx.app.ready();
  const onEvent = ctx.pool.onEvent;
  ctx.pool.onEvent = (u, e) => {
    events.push(e);
    onEvent(u, e);
  };
  const login = await ctx.app.inject({ method: 'GET', url: '/auth/dev-login' });
  cookie = `rk_session=${login.cookies.find((c) => c.name === 'rk_session')!.value}`;
  userId = (await api<Me>('GET', '/api/me')).json.id;

  for (const user of [HEDY, IVAN]) await withImap(user, async (c) => void (await c.mailboxCreate('Sent').catch(() => undefined)));
  await deliver(HEDY, 'Welcome aboard', { text: 'Glad to have you' });
  await deliver(HEDY, 'Lunch on Friday?', { id: '<lunch@example.com>', flags: ['\\Seen'] });
  // Older than the cache keeps (50 per folder), so paging has to continue on the server.
  await withImap(IVAN, async (c) => {
    for (let i = 1; i <= 70; i++) await c.append('INBOX', raw(IVAN, `Bulk ${String(i).padStart(2, '0')}`, { date: new Date(Date.UTC(2026, 0, 1, 0, i)) }), ['\\Seen']);
  });

  const add = async (email: string) => {
    const server = (port: number) => ({ host: gm.host, port, tls: 'none' as const, user: email, password: 'pw' });
    return (await api<AccountView>('POST', '/api/accounts', { name: email, displayName: email, email, color: '#224466', imap: server(gm.imapPort), smtp: server(gm.smtpPort), appendSent: false })).json;
  };
  hedy = await add(HEDY);
  ivan = await add(IVAN);
  // Notifications on: the server watches the inboxes (IDLE) even without a browser.
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  await api('POST', '/api/push/subscriptions', {
    endpoint: 'https://fcm.googleapis.com/fcm/send/hedys-phone',
    keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') },
  });
  await settled(hedy);
  await settled(ivan);
});

afterAll(async () => {
  await ctx?.app.close();
  store?.close();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe('mail cache', () => {
  it('answers a watched inbox from the cache, without asking the mail server', async () => {
    const { result, calls } = await imapCalls(() => list(hedy));
    expect(subjects(result.messages)).toEqual(['Lunch on Friday?', 'Welcome aboard']);
    expect(result.messages[0]).toMatchObject({ seen: true, folder: 'INBOX', accountId: hedy.id });
    expect(result.messages[1]).toMatchObject({ seen: false, snippet: 'Glad to have you' });
    expect(calls).toBe(0);
  });

  it('shows mail that arrives meanwhile and tells the browser', async () => {
    events.length = 0;
    await deliver(HEDY, 'Fresh off the press');
    expect(await until(async () => subjects((await list(hedy)).messages).includes('Fresh off the press'))).toBe(true);
    expect(events).toContainEqual({ type: 'mailbox', accountId: hedy.id, folder: 'INBOX' });
  });

  it('follows messages read and deleted in another mail client', async () => {
    await deliver(HEDY, 'Read me elsewhere');
    await deliver(HEDY, 'Delete me elsewhere');
    await settled(hedy);
    await withImap(HEDY, async (c) => {
      await c.mailboxOpen('INBOX');
      const uids = async (subject: string) => (await c.search({ subject }, { uid: true })) || [];
      await c.messageFlagsAdd((await uids('Read me elsewhere')).join(','), ['\\Seen'], { uid: true });
      await c.messageDelete((await uids('Delete me elsewhere')).join(','), { uid: true });
    });
    expect(
      await until(async () => {
        const msgs = (await list(hedy)).messages;
        return msgs.find((m) => m.subject === 'Read me elsewhere')?.seen === true && !msgs.some((m) => m.subject === 'Delete me elsewhere');
      }),
    ).toBe(true);
  });

  it('applies our own actions to the cache right away', async () => {
    await settled(hedy);
    const welcome = (await list(hedy)).messages.find((m) => m.subject === 'Welcome aboard')!;
    await api('POST', '/api/messages/actions', { messages: [welcome], action: { type: 'flagged', value: true } });
    const { result, calls } = await imapCalls(() => list(hedy));
    expect(result.messages.find((m) => m.subject === 'Welcome aboard')!.flagged).toBe(true);
    expect(calls).toBe(0);
  });

  it('opens unread messages from the cache once loaded ahead, without marking them read', async () => {
    await settled(hedy);
    const welcome = (await list(hedy)).messages.find((m) => m.subject === 'Welcome aboard')!;
    const ref = `accountId=${hedy.id}&folder=INBOX&uid=${welcome.uid}&uidValidity=${welcome.uidValidity}`;
    const { result, calls } = await imapCalls(() => api<MessageDetail>('GET', `/api/message?${ref}`));
    expect(result.json.text).toContain('Glad to have you');
    expect(calls).toBe(0);
    const flags = await withImap(HEDY, async (c) => {
      await c.mailboxOpen('INBOX', { readOnly: true });
      const m = await c.fetchOne(String(welcome.uid), { flags: true }, { uid: true });
      return m ? m.flags : undefined;
    });
    expect(flags?.has('\\Seen')).toBe(false);
  });

  it('keeps a message read from the server for the next time it is opened', async () => {
    await settled(hedy);
    const lunch = (await list(hedy)).messages.find((m) => m.subject === 'Lunch on Friday?')!;
    const ref = `accountId=${hedy.id}&folder=INBOX&uid=${lunch.uid}&uidValidity=${lunch.uidValidity}`;
    // Read messages aren't loaded ahead: the first time goes to the server...
    expect((await imapCalls(() => api('GET', `/api/message?${ref}`))).calls).toBeGreaterThan(0);
    // ...the second time doesn't.
    expect((await imapCalls(() => api('GET', `/api/message?${ref}`))).calls).toBe(0);
  });

  it('brings my reply along from the cached Sent folder', async () => {
    await deliver(HEDY, 'Re: Lunch on Friday?', { folder: 'Sent', inReplyTo: '<lunch@example.com>', flags: ['\\Seen'], text: 'Sure, 12:30' });
    expect(await until(async () => (await list(hedy, 'INBOX', '&fresh=1')).related.some((m) => m.folder === 'Sent'))).toBe(true);
    await settled(hedy);
    const { result, calls } = await imapCalls(() => list(hedy));
    expect(result.related.map((m) => [m.folder, m.subject, m.snippet])).toEqual([['Sent', 'Re: Lunch on Friday?', 'Sure, 12:30']]);
    expect(calls).toBe(0);
  });

  it('pages on past the cached messages with the mail server, without gaps or repeats', async () => {
    const all: string[] = [];
    let cursor: string | null = null;
    do {
      const page: ListResponse = (await api<ListResponse>('GET', `/api/messages?accountId=${ivan.id}&folder=INBOX&limit=30${cursor ? `&cursor=${cursor}` : ''}`)).json;
      all.push(...subjects(page.messages));
      cursor = page.cursor;
    } while (cursor);
    expect(all).toEqual(Array.from({ length: 70 }, (_, i) => `Bulk ${String(70 - i).padStart(2, '0')}`));
    expect(ctx.cache!.count(ctx.cache!.folder(userId, ivan.id, 'INBOX')!)).toBe(50);
  });

  it('serves unread-only from the cache, and asks the server when the cache may not have them all', async () => {
    await settled(ivan);
    // Every bulk message is read, but only the newest 50 are cached: the server has to confirm.
    const { result, calls } = await imapCalls(() => list(ivan, 'INBOX', '&unread=1'));
    expect(result.messages).toEqual([]);
    expect(calls).toBeGreaterThan(0);
  });

  it('goes to the mail server when a cached entry is damaged, and fills the cache again', async () => {
    await settled(hedy);
    const db = new DatabaseSync(cacheFile);
    db.exec('PRAGMA busy_timeout = 5000');
    db.prepare(`UPDATE messages SET data = randomblob(64) WHERE folder_id = (SELECT id FROM folders WHERE account_id = ? AND path = 'INBOX')`).run(hedy.id);
    db.close();
    expect(subjects((await list(hedy)).messages)).toContain('Lunch on Friday?');
    expect(
      await until(async () => {
        await ctx.cacheSync!.idle();
        const f = ctx.cacheSync!.ready(userId, hedy.id, 'INBOX');
        return !!f && ctx.cache!.page(f, null, 200).some((m) => m.summary.subject === 'Lunch on Friday?');
      }),
    ).toBe(true);
  });

  it('starts a folder over when the server replaces it (new UIDVALIDITY)', async () => {
    await withImap(HEDY, async (c) => {
      await c.mailboxDelete('Sent');
      await c.mailboxCreate('Sent');
      await c.append('Sent', raw('kim@example.com', 'After the reset'), ['\\Seen']);
    });
    expect(await until(async () => subjects((await list(hedy, 'Sent', '&fresh=1')).messages).join() === 'After the reset')).toBe(true);
  });

  it('forgets the cached mail of a deleted account', async () => {
    const june = (
      await api<AccountView>('POST', '/api/accounts', {
        name: 'June', displayName: 'June', email: JUNE, color: '#112233',
        imap: { host: gm.host, port: gm.imapPort, tls: 'none', user: JUNE, password: 'pw' },
        smtp: { host: gm.host, port: gm.smtpPort, tls: 'none', user: JUNE, password: 'pw' },
        appendSent: false,
      })
    ).json;
    await deliver(JUNE, 'Short stay');
    expect(await until(async () => subjects((await list(june, 'INBOX', '&fresh=1')).messages).includes('Short stay') && !!ctx.cacheSync!.ready(userId, june.id, 'INBOX'))).toBe(true);
    await api('DELETE', `/api/accounts/${june.id}`);
    await ctx.cacheSync!.idle();
    expect(ctx.cache!.folder(userId, june.id, 'INBOX')).toBeNull();
  });
});
