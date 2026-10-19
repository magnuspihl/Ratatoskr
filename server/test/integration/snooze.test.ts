import crypto from 'node:crypto';
import { ImapFlow } from 'imapflow';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { AccountFolders, AccountView, ActionResult, ListResponse, Me, MessageDetail, MessageSummary } from '../../../shared/types.js';
import { buildApp, type App } from '../../src/app.js';
import { loadConfig, type Config } from '../../src/config.js';
import { Keyring } from '../../src/crypto.js';
import { Store } from '../../src/db.js';
import type { NotificationPayload } from '../../src/push/notify.js';
import type { PushRequest } from '../../src/push/webpush.js';

/**
 * Snoozing end to end against GreenMail: the Snoozed folder, the wake-up timer putting mail back
 * into INBOX, and the notification. Web Push delivery is replaced by a recorder. Uses its own
 * mailbox so it doesn't disturb the other integration tests.
 */

const gm = inject('greenmail');
const DAVE = 'dave@example.com';

let config: Config;
let store: Store;
let ctx: App;
let cookie = '';
let userId = '';
let account: AccountView;
const sent: PushRequest[] = [];
// Shown notifications only, not the "clear" pushes that close them once their message is read or moved.
const notifications = () => sent.map((r) => r.payload as NotificationPayload).filter((p) => 'title' in p);

async function deliver(subject: string, opts: { date?: Date; flags?: string[] } = {}) {
  const c = new ImapFlow({ host: gm.host, port: gm.imapPort, secure: false, doSTARTTLS: false, auth: { user: DAVE, pass: 'x' }, logger: false });
  c.on('error', () => {});
  await c.connect();
  const date = opts.date ?? new Date();
  const raw = `From: Erin <erin@example.com>\r\nTo: ${DAVE}\r\nSubject: ${subject}\r\nDate: ${date.toUTCString()}\r\nMessage-ID: <${crypto.randomUUID()}@example.com>\r\n\r\nhello\r\n`;
  await c.append('INBOX', Buffer.from(raw), opts.flags ?? [], date);
  await c.logout();
}

async function api<T>(method: 'GET' | 'POST' | 'DELETE', url: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await ctx.app.inject({
    method,
    url,
    headers: { cookie, 'x-ratatoskr': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    payload: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.statusCode, json: JSON.parse(res.body) as T };
}

const list = async (folder: string) =>
  (await api<ListResponse>('GET', `/api/messages?accountId=${account.id}&folder=${encodeURIComponent(folder)}&limit=200`)).json.messages;
const find = async (folder: string, subject: string) => (await list(folder)).find((m) => m.subject === subject);
const snooze = (msgs: MessageSummary[], until: Date | string) =>
  api<ActionResult>('POST', '/api/messages/actions', { messages: msgs, action: { type: 'snooze', until: typeof until === 'string' ? until : until.toISOString() } });

const until = async (fn: () => Promise<boolean> | boolean, ms = 15_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
};

async function start() {
  ctx = await buildApp(config, { store, logger: false, pushTransport: async (r) => (sent.push(r), 'sent'), pushHostCheck: async () => {} });
  await ctx.app.ready();
}

beforeAll(async () => {
  config = loadConfig({
    NODE_ENV: 'test',
    RATATOSKR_SECRET_KEY: crypto.randomBytes(48).toString('base64'),
    RATATOSKR_DEV_LOGIN: 'true',
    RATATOSKR_DATA_DIR: '/nonexistent-not-used',
    RATATOSKR_BASE_URL: 'http://localhost:8080',
  });
  store = new Store(':memory:', new Keyring(config.secretKey).credentialKey);
  await start();
  const login = await ctx.app.inject({ method: 'GET', url: '/auth/dev-login' });
  cookie = `rk_session=${login.cookies.find((c) => c.name === 'rk_session')!.value}`;
  userId = (await api<Me>('GET', '/api/me')).json.id;
  const server = (port: number) => ({ host: gm.host, port, tls: 'none' as const, user: DAVE, password: 'pw' });
  account = (
    await api<AccountView>('POST', '/api/accounts', {
      name: 'Dave', displayName: 'Dave', email: DAVE, color: '#654321',
      imap: server(gm.imapPort), smtp: server(gm.smtpPort), appendSent: false,
    })
  ).json;
  // Notifications on, so the new-mail watcher runs too (and must not report snoozed mail as new).
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  await api('POST', '/api/push/subscriptions', {
    endpoint: 'https://fcm.googleapis.com/fcm/send/daves-phone',
    keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') },
  });
  await until(() => store.getInboxState(userId, account.id) !== null);
});

afterAll(async () => {
  await ctx?.app.close();
  store?.close();
});

describe('snoozing', () => {
  it('moves the message to a Snoozed folder (creating it) and shows when it comes back', async () => {
    await deliver('Renew passport');
    const msg = (await find('INBOX', 'Renew passport'))!;
    const wake = new Date(Date.now() + 3 * 86_400_000);
    const res = await snooze([msg], wake);
    expect(res.status).toBe(200);
    expect(res.json.createdFolders).toEqual(['Snoozed']);

    const folders = (await api<AccountFolders[]>('GET', '/api/folders')).json.find((f) => f.accountId === account.id)!;
    expect(folders.folders.find((f) => f.path === 'Snoozed')?.specialUse).toBe('snoozed');
    expect(await find('INBOX', 'Renew passport')).toBeUndefined();
    const snoozed = (await find('Snoozed', 'Renew passport'))!;
    expect(snoozed.snoozedUntil).toBe(wake.toISOString());
    const detail = await api<MessageDetail>('GET', `/api/message?accountId=${account.id}&folder=Snoozed&uid=${snoozed.uid}&uidValidity=${snoozed.uidValidity}`);
    expect(detail.json.snoozedUntil).toBe(wake.toISOString());
  });

  it('refuses a time in the past, and leaves the message where it is', async () => {
    await deliver('Not into the past');
    const msg = (await find('INBOX', 'Not into the past'))!;
    const res = await snooze([msg], new Date(Date.now() - 60_000));
    expect(res.status).toBe(400);
    expect((res.json as unknown as { error: string }).error).toMatch(/future/);
    expect(await find('INBOX', 'Not into the past')).toBeDefined();
  });

  it('brings the message back to the top of the inbox as unread when the time comes, with one notification', async () => {
    // An old, already read message: it must still stand out when it comes back.
    await deliver('Pay the invoice', { date: new Date('2024-01-02T10:00:00Z'), flags: ['\\Seen'] });
    await deliver('Newer mail meanwhile');
    const msg = (await find('INBOX', 'Pay the invoice'))!;
    sent.length = 0;
    expect((await snooze([msg], new Date(Date.now() + 1500))).status).toBe(200);
    expect(await find('INBOX', 'Pay the invoice')).toBeUndefined();

    expect(await until(async () => !!(await find('INBOX', 'Pay the invoice')))).toBe(true);
    const inbox = await list('INBOX');
    expect(inbox[0]!.subject).toBe('Pay the invoice');
    expect(inbox[0]!.seen).toBe(false);
    expect(inbox[0]!.snoozedUntil).toBeUndefined();
    expect(await find('Snoozed', 'Pay the invoice')).toBeUndefined();

    const aboutIt = () => notifications().filter((n) => n.body.includes('Pay the invoice'));
    expect(await until(() => aboutIt().length > 0)).toBe(true);
    await new Promise((r) => setTimeout(r, 1500)); // a duplicate "new message" notification would arrive by now
    expect(aboutIt()).toEqual([
      expect.objectContaining({ title: 'Back from snooze', body: 'Erin: Pay the invoice', url: `/?open=${account.id}.${inbox[0]!.uidValidity}.${inbox[0]!.uid}` }),
    ]);
  });

  it('changes only the time when a snoozed message is snoozed again', async () => {
    const msg = (await find('Snoozed', 'Renew passport'))!;
    const later = new Date(Date.now() + 10 * 86_400_000);
    const res = await snooze([msg], later);
    expect(res.json.undo).toEqual([]);
    const again = (await find('Snoozed', 'Renew passport'))!;
    expect(again.uid).toBe(msg.uid);
    expect(again.snoozedUntil).toBe(later.toISOString());
  });

  it('unsnoozes right away, keeping the read state and without a notification', async () => {
    await deliver('Unsnooze me', { flags: ['\\Seen'] });
    await snooze([(await find('INBOX', 'Unsnooze me'))!], new Date(Date.now() + 86_400_000));
    sent.length = 0;
    const res = await api<ActionResult>('POST', '/api/messages/actions', { messages: [(await find('Snoozed', 'Unsnooze me'))!], action: { type: 'unsnooze' } });
    expect(res.status).toBe(200);
    const back = (await find('INBOX', 'Unsnooze me'))!;
    expect(back.seen).toBe(true);
    expect(await find('Snoozed', 'Unsnooze me')).toBeUndefined();
    await new Promise((r) => setTimeout(r, 1500));
    expect(notifications()).toEqual([]);
  });

  it('can be undone, and a message moved out of the Snoozed folder by hand no longer comes back', async () => {
    await deliver('Undo snooze');
    await deliver('Moved out by hand');
    const before = new Map(store.dueSnoozes(Number.MAX_SAFE_INTEGER).map((s) => [`${s.folder}|${s.uid}`, s]));
    const a = (await snooze([(await find('INBOX', 'Undo snooze'))!], new Date(Date.now() + 86_400_000))).json;
    const u = a.undo[0]!;
    await api('POST', '/api/messages/actions', {
      messages: u.uids.map((uid) => ({ accountId: u.accountId, folder: u.folder, uid, uidValidity: u.uidValidity })),
      action: { type: 'move', destination: u.restoreTo },
    });
    expect(await find('INBOX', 'Undo snooze')).toBeDefined();

    await snooze([(await find('INBOX', 'Moved out by hand'))!], new Date(Date.now() + 86_400_000));
    await api('POST', '/api/messages/actions', { messages: [(await find('Snoozed', 'Moved out by hand'))!], action: { type: 'archive' } });

    const after = store.dueSnoozes(Number.MAX_SAFE_INTEGER).filter((s) => !before.has(`${s.folder}|${s.uid}`));
    expect(after).toEqual([]);
  });

  it('brings back messages whose time came while the server was down', async () => {
    await deliver('Wake after restart');
    await snooze([(await find('INBOX', 'Wake after restart'))!], new Date(Date.now() + 1000));
    await ctx.app.close();
    await new Promise((r) => setTimeout(r, 1500));
    await start();
    expect(await until(async () => !!(await find('INBOX', 'Wake after restart')))).toBe(true);
    expect(await find('Snoozed', 'Wake after restart')).toBeUndefined();
  });
});
