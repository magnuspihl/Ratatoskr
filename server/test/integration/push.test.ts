import crypto from 'node:crypto';
import { ImapFlow } from 'imapflow';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { AccountView, Me } from '../../../shared/types.js';
import { buildApp, type App } from '../../src/app.js';
import { loadConfig, type Config } from '../../src/config.js';
import { Keyring } from '../../src/crypto.js';
import { Store } from '../../src/db.js';
import type { NotificationPayload } from '../../src/push/notify.js';
import type { PushRequest } from '../../src/push/webpush.js';

/**
 * Phone notifications end to end: real IMAP IDLE against GreenMail, with Web Push delivery
 * replaced by a recorder. Uses its own mailbox so it doesn't disturb mail.test.ts.
 */

const gm = inject('greenmail');
const CAROL = 'carol@example.com';
const BOB = 'bob@example.com';

let config: Config;
let store: Store;
let ctx: App;
let cookie = '';
let userId = '';
let account: AccountView;
const sent: PushRequest[] = [];

const titles = () => sent.map((r) => (r.payload as NotificationPayload).body);

function imapClient(user: string) {
  const c = new ImapFlow({ host: gm.host, port: gm.imapPort, secure: false, doSTARTTLS: false, auth: { user, pass: 'x' }, logger: false });
  c.on('error', () => {});
  return c;
}

async function deliver(subject: string, flags: string[] = []) {
  const c = imapClient(CAROL);
  await c.connect();
  const raw = `From: Bob <${BOB}>\r\nTo: ${CAROL}\r\nSubject: ${subject}\r\nDate: ${new Date().toUTCString()}\r\nMessage-ID: <${crypto.randomUUID()}@example.com>\r\n\r\nhello\r\n`;
  await c.append('INBOX', Buffer.from(raw), flags);
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

const until = async (fn: () => boolean, ms = 15_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
};
const settle = () => new Promise((r) => setTimeout(r, 1500));

function browserSubscription(id: string) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    endpoint: `https://fcm.googleapis.com/fcm/send/${id}`,
    keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') },
  };
}
const phone = browserSubscription('carols-phone');

async function start() {
  ctx = await buildApp(config, { store, logger: false, pushTransport: async (r) => (sent.push(r), 'sent'), pushHostCheck: async () => {} });
  await ctx.app.ready();
}

/** The watcher has connected and recorded where "new" starts. */
const tracking = () => until(() => store.getInboxState(userId, account.id) !== null);

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

  await deliver('Already there before notifications');
  const server = (port: number) => ({ host: gm.host, port, tls: 'none' as const, user: CAROL, password: 'pw' });
  account = (
    await api<AccountView>('POST', '/api/accounts', {
      name: 'Carol', displayName: 'Carol', email: CAROL, color: '#123456',
      imap: server(gm.imapPort), smtp: server(gm.smtpPort), appendSent: false,
    })
  ).json;
});

afterAll(async () => {
  await ctx?.app.close();
  store?.close();
});

describe('phone notifications for new mail', () => {
  it('refuses push endpoints on internal addresses and names the host in the error', async () => {
    const res = await api<{ error: string }>('POST', '/api/push/subscriptions', { ...phone, endpoint: 'https://10.0.0.5/hook' });
    expect(res.status).toBe(400);
    expect(res.json.error).toContain('10.0.0.5');
  });

  it('notifies about mail that arrives after notifications are switched on, not about older mail', async () => {
    expect((await api('POST', '/api/push/subscriptions', phone)).status).toBe(200);
    expect(await tracking()).toBe(true);
    await deliver('Lunch tomorrow?');
    expect(await until(() => sent.length > 0)).toBe(true);
    expect(sent[0]!.subscription.endpoint).toBe(phone.endpoint);
    expect(sent[0]!.payload).toMatchObject({ title: 'Bob', body: 'Lunch tomorrow?', url: expect.stringMatching(/^\/\?open=/) });
    expect(titles()).not.toContain('Already there before notifications');
  });

  it('skips mail that is already read when it arrives', async () => {
    sent.length = 0;
    await deliver('Read elsewhere', ['\\Seen']);
    await deliver('Still unread');
    expect(await until(() => titles().includes('Still unread'))).toBe(true);
    expect(titles()).not.toContain('Read elsewhere');
  });

  it('closes the notification on the phone once the message is read in another mail client', async () => {
    const shown = sent.find((r) => (r.payload as NotificationPayload).body === 'Still unread')!.payload as NotificationPayload;
    const uid = Number(shown.tag.split(':').pop());
    sent.length = 0;
    const c = imapClient(CAROL);
    await c.connect();
    await c.mailboxOpen('INBOX');
    await c.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
    await c.logout();
    expect(await until(() => sent.length > 0)).toBe(true);
    expect(sent[0]!.payload).toMatchObject({ type: 'clear', tags: [shown.tag] });
    expect(sent[0]!.subscription.endpoint).toBe(phone.endpoint);
  });

  it('sends a test notification to the device', async () => {
    sent.length = 0;
    expect((await api<{ delivered: number }>('POST', '/api/push/test')).json).toEqual({ delivered: 1 });
    expect(sent[0]!.payload).toMatchObject({ tag: 'test' });
  });

  it('catches up on mail that arrived while the server was down, after a restart', async () => {
    await ctx.app.close();
    sent.length = 0;
    await deliver('While the server was down');
    await start();
    expect(await until(() => titles().includes('While the server was down'))).toBe(true);
  });

  it('stops after the last device switches notifications off, and does not replay that mail when switched on again', async () => {
    expect((await api('DELETE', '/api/push/subscriptions', { endpoint: phone.endpoint })).status).toBe(200);
    expect(ctx.pool.isBackground(userId)).toBe(false);
    sent.length = 0;
    await deliver('While notifications were off');
    await settle();
    expect(sent).toEqual([]);

    expect((await api('POST', '/api/push/subscriptions', phone)).status).toBe(200);
    expect(await tracking()).toBe(true);
    await deliver('After switching back on');
    expect(await until(() => titles().includes('After switching back on'))).toBe(true);
    expect(titles()).not.toContain('While notifications were off');
  });
});
