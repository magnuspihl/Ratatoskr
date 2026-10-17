import crypto from 'node:crypto';
import { ImapFlow } from 'imapflow';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type {
  AccountFolders,
  AccountView,
  ComposePayload,
  DraftResult,
  ListResponse,
  MessageDetail,
  MessageSummary,
  SendResult,
  ServerEvent,
} from '../../../shared/types.js';
import { buildApp, type App } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { Keyring, sealJson } from '../../src/crypto.js';
import { Store } from '../../src/db.js';

/**
 * End-to-end tests of the HTTP API against a real IMAP/SMTP server (GreenMail, see
 * greenmail.setup.ts). GreenMail runs with authentication disabled, so any password works and
 * mailboxes are created on first login. All addresses are fake.
 */

const gm = inject('greenmail');
const ALICE = 'alice@example.com';
const BOB = 'bob@example.com';

let ctx: App;
let secretKey = '';
let cookie = '';
const accounts: Record<string, AccountView> = {};

function imapClient(user: string) {
  const c = new ImapFlow({ host: gm.host, port: gm.imapPort, secure: false, doSTARTTLS: false, auth: { user, pass: 'x' }, logger: false });
  c.on('error', () => {});
  return c;
}

function rawMessage(opts: { from: string; to: string; subject: string; date: Date; html?: string; text?: string; id: string }) {
  const body = opts.html
    ? `Content-Type: text/html; charset=utf-8\r\n\r\n${opts.html}`
    : `Content-Type: text/plain; charset=utf-8\r\n\r\n${opts.text ?? 'hello'}`;
  return Buffer.from(
    `From: ${opts.from}\r\nTo: ${opts.to}\r\nSubject: ${opts.subject}\r\nDate: ${opts.date.toUTCString()}\r\n` +
      `Message-ID: <${opts.id}@example.com>\r\nMIME-Version: 1.0\r\n${body}\r\n`,
  );
}

async function api<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await ctx.app.inject({
    method,
    url,
    headers: { cookie, 'x-ratatoskr': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    payload: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.statusCode, json: res.body ? (JSON.parse(res.body) as T) : (undefined as T) };
}

async function multipart<T>(url: string, payload: ComposePayload, files: { name: string; type: string; data: string }[] = []) {
  const form = new FormData();
  form.append('payload', JSON.stringify(payload));
  for (const f of files) form.append('files', new Blob([f.data], { type: f.type }), f.name);
  const req = new Request('http://localhost/', { method: 'POST', body: form });
  const res = await ctx.app.inject({
    method: 'POST',
    url,
    headers: { cookie, 'x-ratatoskr': '1', 'content-type': req.headers.get('content-type')! },
    payload: Buffer.from(await req.arrayBuffer()),
  });
  return { status: res.statusCode, json: JSON.parse(res.body) as T };
}

function accountInput(email: string, name: string, color: string) {
  const server = (port: number) => ({ host: gm.host, port, tls: 'none' as const, user: email, password: 'test-password' });
  return { name, displayName: name, email, color, imap: server(gm.imapPort), smtp: server(gm.smtpPort), appendSent: true };
}

function compose(accountId: string, over: Partial<ComposePayload>): ComposePayload {
  return {
    accountId, to: '', cc: '', bcc: '', subject: '', html: '', inReplyTo: null, references: [],
    forwardFrom: null, replaceDraft: null, answering: null, ...over,
  };
}

async function listAll(query: string): Promise<MessageSummary[]> {
  const out: MessageSummary[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 20; i++) {
    const res: { json: ListResponse } = await api<ListResponse>('GET', `/api/messages?${query}${cursor ? `&cursor=${cursor}` : ''}`);
    out.push(...res.json.messages);
    cursor = res.json.cursor;
    if (!cursor) break;
  }
  return out;
}

const until = async (fn: () => Promise<boolean>, ms = 15_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
};

beforeAll(async () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    RATATOSKR_SECRET_KEY: (secretKey = crypto.randomBytes(48).toString('base64')),
    RATATOSKR_DEV_LOGIN: 'true',
    RATATOSKR_DATA_DIR: '/nonexistent-not-used',
    RATATOSKR_BASE_URL: 'http://localhost:8080',
  });
  const store = new Store(':memory:', new Keyring(config.secretKey).credentialKey);
  ctx = await buildApp(config, { store, logger: false });

  const login = await ctx.app.inject({ method: 'GET', url: '/auth/dev-login' });
  cookie = String(login.cookies.find((c) => c.name === 'rk_session')!.value);
  cookie = `rk_session=${cookie}`;

  // Seed: special folders for alice, and messages with distinct dates for both users.
  const a = imapClient(ALICE);
  await a.connect();
  for (const f of ['Sent', 'Drafts', 'Trash', 'Archive']) await a.mailboxCreate(f).catch(() => undefined);
  const base = Date.UTC(2026, 0, 10, 12);
  await a.append('INBOX', rawMessage({ from: BOB, to: ALICE, subject: 'A1 oldest', date: new Date(base), id: 'a1', text: 'first message' }), [], new Date(base));
  await a.append('INBOX', rawMessage({ from: BOB, to: ALICE, subject: 'A2 middle', date: new Date(base + 2 * 3600e3), id: 'a2', text: 'needle in haystack' }), ['\\Seen'], new Date(base + 2 * 3600e3));
  await a.append(
    'INBOX',
    rawMessage({
      from: BOB, to: ALICE, subject: 'A3 newest html', date: new Date(base + 4 * 3600e3), id: 'a3',
      html: '<p onclick="steal()">Hello <b>Alice</b></p><img src="https://tracker.example.com/pixel.gif"><script>evil()</script>',
    }),
    [],
    new Date(base + 4 * 3600e3),
  );
  await a.logout();
  const b = imapClient(BOB);
  await b.connect();
  for (const f of ['Sent', 'Drafts', 'Trash']) await b.mailboxCreate(f).catch(() => undefined);
  await b.append('INBOX', rawMessage({ from: ALICE, to: BOB, subject: 'B1', date: new Date(base + 1 * 3600e3), id: 'b1' }), [], new Date(base + 1 * 3600e3));
  await b.append('INBOX', rawMessage({ from: ALICE, to: BOB, subject: 'B2', date: new Date(base + 3 * 3600e3), id: 'b2' }), [], new Date(base + 3 * 3600e3));
  await b.logout();
});

afterAll(async () => {
  await ctx?.app.close();
});

describe('accounts', () => {
  it('rejects unauthenticated and CSRF-less requests', async () => {
    expect((await ctx.app.inject({ method: 'GET', url: '/api/accounts' })).statusCode).toBe(401);
    const res = await ctx.app.inject({ method: 'POST', url: '/api/accounts', headers: { cookie, 'content-type': 'application/json' }, payload: '{}' });
    expect(res.statusCode).toBe(403);
  });

  it('tests the connection on save and refuses unreachable servers', async () => {
    const bad = accountInput(ALICE, 'Broken', '#ff0000');
    bad.imap.port = 1; // nothing listens there
    const res = await api<{ error: string }>('POST', '/api/accounts', bad);
    expect(res.status).toBe(502);
    expect(res.json.error).toMatch(/could not connect/);
  });

  it('adds two accounts and never returns passwords', async () => {
    const r1 = await api<AccountView>('POST', '/api/accounts', accountInput(ALICE, 'Alice', '#3366ff'));
    expect(r1.status).toBe(200);
    const r2 = await api<AccountView>('POST', '/api/accounts', accountInput(BOB, 'Bob', '#22aa66'));
    expect(r2.status).toBe(200);
    accounts.alice = r1.json;
    accounts.bob = r2.json;
    const list = await api<AccountView[]>('GET', '/api/accounts');
    expect(list.json).toHaveLength(2);
    expect(JSON.stringify(list.json)).not.toContain('test-password');
  });
});

describe('folders', () => {
  it('lists folders with unread counts and detects special-use folders by name', async () => {
    const res = await api<AccountFolders[]>('GET', '/api/folders');
    const alice = res.json.find((f) => f.accountId === accounts.alice!.id)!;
    expect(alice.error).toBeUndefined();
    const inbox = alice.folders.find((f) => f.specialUse === 'inbox')!;
    expect(inbox.unread).toBe(2);
    expect(inbox.total).toBe(3);
    const uses = Object.fromEntries(alice.folders.map((f) => [f.specialUse, f.path]));
    expect(uses).toMatchObject({ sent: 'Sent', drafts: 'Drafts', trash: 'Trash', archive: 'Archive' });
  });
});

describe('unified inbox', () => {
  it('merges all accounts by date across pages without gaps or duplicates', async () => {
    const all = await listAll('limit=2');
    expect(all.map((m) => m.subject)).toEqual(['A3 newest html', 'B2', 'A2 middle', 'B1', 'A1 oldest']);
    expect(new Set(all.map((m) => `${m.accountId}:${m.uid}`)).size).toBe(5);
  });

  it('includes flags, snippets and account ids', async () => {
    const all = await listAll('limit=50');
    const a2 = all.find((m) => m.subject === 'A2 middle')!;
    expect(a2.seen).toBe(true);
    expect(a2.accountId).toBe(accounts.alice!.id);
    expect(a2.snippet).toBe('needle in haystack');
    const a3 = all.find((m) => m.subject === 'A3 newest html')!;
    expect(a3.snippet).toBe('Hello Alice');
    expect(a3.seen).toBe(false);
  });

  it('paginates a single folder', async () => {
    const all = await listAll(`accountId=${accounts.alice!.id}&folder=INBOX&limit=1`);
    expect(all.map((m) => m.subject)).toEqual(['A3 newest html', 'A2 middle', 'A1 oldest']);
  });

  it('searches server-side in a folder and across accounts', async () => {
    const inFolder = await listAll(`accountId=${accounts.alice!.id}&folder=INBOX&q=needle`);
    expect(inFolder.map((m) => m.subject)).toEqual(['A2 middle']);
    const unified = await listAll('q=B2');
    expect(unified.map((m) => m.subject)).toEqual(['B2']);
  });
});

describe('reading', () => {
  it('returns sanitized HTML with remote content blocked by default', async () => {
    const [msg] = await listAll(`accountId=${accounts.alice!.id}&folder=INBOX&q=newest`);
    const q = `accountId=${msg!.accountId}&folder=INBOX&uid=${msg!.uid}&uidValidity=${msg!.uidValidity}`;
    const d = (await api<MessageDetail>('GET', `/api/message?${q}`)).json;
    expect(d.html).toContain('Hello <b>Alice</b>');
    expect(d.html).not.toMatch(/onclick|script|tracker\.example\.com/);
    expect(d.remoteContentBlocked).toBe(1);
    // Reading does not implicitly mark as read (BODY.PEEK).
    const again = await listAll(`accountId=${accounts.alice!.id}&folder=INBOX&q=newest`);
    expect(again[0]!.seen).toBe(false);

    const withImages = (await api<MessageDetail>('GET', `/api/message?${q}&remote=1`)).json;
    expect(withImages.html).toContain('/api/proxy/image?u=https%3A%2F%2Ftracker.example.com%2Fpixel.gif');
  });

  it('reports a stale UIDVALIDITY as 409', async () => {
    const [msg] = await listAll(`accountId=${accounts.alice!.id}&folder=INBOX&q=newest`);
    const res = await api<{ stale: boolean }>('GET', `/api/message?accountId=${msg!.accountId}&folder=INBOX&uid=${msg!.uid}&uidValidity=1`);
    expect(res.status).toBe(409);
    expect(res.json.stale).toBe(true);
  });

  it('does not let one user see or touch another user\'s accounts', async () => {
    const mallory = ctx.store.upsertUser('https://auth.example.com', 'mallory', 'mallory@example.com', 'Mallory');
    const malloryCookie = `rk_session=${sealJson(new Keyring(secretKey).sessionKey, { uid: mallory.id }, 600, 'session')}`;
    const as = (method: 'GET' | 'POST' | 'DELETE', url: string, body?: unknown) =>
      ctx.app.inject({
        method,
        url,
        headers: { cookie: malloryCookie, 'x-ratatoskr': '1', ...(body ? { 'content-type': 'application/json' } : {}) },
        payload: body ? JSON.stringify(body) : undefined,
      });
    const [msg] = await listAll(`accountId=${accounts.alice!.id}&folder=INBOX&limit=1`);
    const aliceId = accounts.alice!.id;
    expect(JSON.parse((await as('GET', '/api/accounts')).body)).toEqual([]);
    expect(JSON.parse((await as('GET', '/api/messages?limit=5')).body).messages).toEqual([]);
    expect((await as('GET', `/api/messages?accountId=${aliceId}&folder=INBOX`)).statusCode).toBe(404);
    expect((await as('GET', `/api/message?accountId=${aliceId}&folder=INBOX&uid=${msg!.uid}&uidValidity=${msg!.uidValidity}`)).statusCode).toBe(404);
    expect(
      (await as('POST', '/api/messages/actions', { messages: [{ accountId: aliceId, folder: 'INBOX', uid: msg!.uid, uidValidity: msg!.uidValidity }], action: { type: 'delete' } })).statusCode,
    ).toBe(404);
    expect((await as('DELETE', `/api/accounts/${aliceId}`)).statusCode).toBe(404);
    expect(ctx.store.listAccounts(ctx.store.upsertUser('dev-login', 'dev', 'user@example.com', 'Dev User').id)).toHaveLength(2);
  });
});

describe('actions', () => {
  const ref = (m: MessageSummary) => ({ accountId: m.accountId, folder: m.folder, uid: m.uid, uidValidity: m.uidValidity });

  it('marks read/unread and flags multiple messages', async () => {
    const msgs = await listAll(`accountId=${accounts.alice!.id}&folder=INBOX`);
    expect((await api('POST', '/api/messages/actions', { messages: msgs.map(ref), action: { type: 'seen', value: true } })).status).toBe(200);
    await api('POST', '/api/messages/actions', { messages: [ref(msgs[0]!)], action: { type: 'flagged', value: true } });
    const after = await listAll(`accountId=${accounts.alice!.id}&folder=INBOX`);
    expect(after.every((m) => m.seen)).toBe(true);
    expect(after[0]!.flagged).toBe(true);
    await api('POST', '/api/messages/actions', { messages: [ref(msgs[2]!)], action: { type: 'seen', value: false } });
    const folders = (await api<AccountFolders[]>('GET', '/api/folders')).json.find((f) => f.accountId === accounts.alice!.id)!;
    expect(folders.folders.find((f) => f.path === 'INBOX')!.unread).toBe(1);
  });

  it('archives, deletes to Trash, and only expunges from Trash', async () => {
    const id = accounts.alice!.id;
    const inbox = await listAll(`accountId=${id}&folder=INBOX`);
    const oldest = inbox.find((m) => m.subject === 'A1 oldest')!;
    const middle = inbox.find((m) => m.subject === 'A2 middle')!;
    expect((await api('POST', '/api/messages/actions', { messages: [ref(oldest)], action: { type: 'archive' } })).status).toBe(200);
    expect((await listAll(`accountId=${id}&folder=Archive`)).map((m) => m.subject)).toEqual(['A1 oldest']);

    await api('POST', '/api/messages/actions', { messages: [ref(middle)], action: { type: 'delete' } });
    const trash = await listAll(`accountId=${id}&folder=Trash`);
    expect(trash.map((m) => m.subject)).toEqual(['A2 middle']);
    expect((await listAll(`accountId=${id}&folder=INBOX`)).map((m) => m.subject)).toEqual(['A3 newest html']);

    await api('POST', '/api/messages/actions', { messages: [ref(trash[0]!)], action: { type: 'delete' } });
    expect(await listAll(`accountId=${id}&folder=Trash`)).toEqual([]);
  });

  it('moves to an arbitrary folder', async () => {
    const id = accounts.bob!.id;
    const [b] = await listAll(`accountId=${id}&folder=INBOX&q=B1`);
    await api('POST', '/api/messages/actions', { messages: [ref(b!)], action: { type: 'move', destination: 'Trash' } });
    expect((await listAll(`accountId=${id}&folder=Trash`)).map((m) => m.subject)).toEqual(['B1']);
  });
});

describe('compose', () => {
  it('sends with attachments, appends to Sent and delivers', async () => {
    const res = await multipart<SendResult>(
      '/api/send',
      compose(accounts.alice!.id, { to: `Bob <${BOB}>`, subject: 'Report attached', html: '<p>Here is the <b>report</b>.</p>' }),
      [{ name: 'report.txt', type: 'text/plain', data: 'quarterly numbers' }],
    );
    expect(res.status).toBe(200);
    expect(res.json.savedToSent).toBe(true);
    expect(res.json.warning).toBeNull();

    const sent = await listAll(`accountId=${accounts.alice!.id}&folder=Sent`);
    expect(sent.map((m) => m.subject)).toEqual(['Report attached']);
    expect(sent[0]!.hasAttachments).toBe(true);

    let delivered: MessageSummary | undefined;
    await until(async () => {
      delivered = (await listAll(`accountId=${accounts.bob!.id}&folder=INBOX&q=Report`))[0];
      return !!delivered;
    });
    expect(delivered).toBeDefined();
    const d = (
      await api<MessageDetail>(
        'GET',
        `/api/message?accountId=${delivered!.accountId}&folder=INBOX&uid=${delivered!.uid}&uidValidity=${delivered!.uidValidity}`,
      )
    ).json;
    expect(d.text).toContain('Here is the report.');
    expect(d.attachments.map((a) => a.filename)).toEqual(['report.txt']);

    const att = await ctx.app.inject({
      method: 'GET',
      url: `/api/attachment?accountId=${d.accountId}&folder=INBOX&uid=${d.uid}&uidValidity=${d.uidValidity}&index=${d.attachments[0]!.index}`,
      headers: { cookie },
    });
    expect(att.body).toBe('quarterly numbers');
    expect(att.headers['content-disposition']).toContain('attachment');
    expect(att.headers['content-type']).toBe('application/octet-stream');

    // Recipients are remembered for autocomplete.
    const rec = await api<{ address: string }[]>('GET', '/api/recipients?q=bob');
    expect(rec.json.map((r) => r.address)).toContain(BOB);
  });

  it('forwards original attachments and marks the replied message answered', async () => {
    const [orig] = await listAll(`accountId=${accounts.bob!.id}&folder=INBOX&q=Report`);
    const detail = (
      await api<MessageDetail>('GET', `/api/message?accountId=${orig!.accountId}&folder=INBOX&uid=${orig!.uid}&uidValidity=${orig!.uidValidity}`)
    ).json;
    const origRef = { accountId: orig!.accountId, folder: 'INBOX', uid: orig!.uid, uidValidity: orig!.uidValidity };
    const res = await multipart<SendResult>(
      '/api/send',
      compose(accounts.bob!.id, {
        to: ALICE,
        subject: 'Fwd: Report attached',
        html: '<p>FYI</p>',
        forwardFrom: { ...origRef, indices: detail.attachments.map((a) => a.index) },
        answering: origRef,
        inReplyTo: detail.messageId,
      }),
    );
    expect(res.status).toBe(200);
    const sent = await listAll(`accountId=${accounts.bob!.id}&folder=Sent`);
    expect(sent[0]!.subject).toBe('Fwd: Report attached');
    expect(sent[0]!.hasAttachments).toBe(true);
    const after = await listAll(`accountId=${accounts.bob!.id}&folder=INBOX&q=Report`);
    expect(after[0]!.answered).toBe(true);
  });

  it('saves and replaces drafts in the Drafts folder', async () => {
    const id = accounts.alice!.id;
    const first = await multipart<DraftResult>('/api/drafts', compose(id, { to: BOB, bcc: 'hidden@example.com', subject: 'Draft v1', html: '<p>wip</p>' }));
    expect(first.status).toBe(200);
    let drafts = await listAll(`accountId=${id}&folder=Drafts`);
    expect(drafts.map((m) => m.subject)).toEqual(['Draft v1']);
    expect(drafts[0]!.draft).toBe(true);
    const replaceDraft = first.json.draft ?? {
      accountId: id, folder: 'Drafts', uid: drafts[0]!.uid, uidValidity: drafts[0]!.uidValidity,
    };
    const second = await multipart<DraftResult>('/api/drafts', compose(id, { to: BOB, subject: 'Draft v2', html: '<p>more</p>', replaceDraft }));
    expect(second.status).toBe(200);
    drafts = await listAll(`accountId=${id}&folder=Drafts`);
    expect(drafts.map((m) => m.subject)).toEqual(['Draft v2']);
  });

  it('validates recipients', async () => {
    const res = await multipart<{ error: string }>('/api/send', compose(accounts.alice!.id, { to: 'not an address', subject: 'x', html: 'x' }));
    expect(res.status).toBe(400);
  });
});

describe('UIDVALIDITY changes', () => {
  it('tells the client to reset when a folder is recreated', async () => {
    const id = accounts.alice!.id;
    const c = imapClient(ALICE);
    await c.connect();
    await c.mailboxCreate('Recreated');
    for (let i = 0; i < 3; i++) {
      await c.append('Recreated', rawMessage({ from: BOB, to: ALICE, subject: `R${i}`, date: new Date(), id: `r${i}` }));
    }
    const page1 = (await api<ListResponse>('GET', `/api/messages?accountId=${id}&folder=Recreated&limit=1`)).json;
    expect(page1.cursor).not.toBeNull();
    await c.mailboxDelete('Recreated');
    // GreenMail derives UIDVALIDITY from the clock in seconds.
    await new Promise((r) => setTimeout(r, 1100));
    await c.mailboxCreate('Recreated');
    await c.append('Recreated', rawMessage({ from: BOB, to: ALICE, subject: 'new', date: new Date(), id: 'rn' }));
    await c.logout();
    const page2 = (await api<ListResponse>('GET', `/api/messages?accountId=${id}&folder=Recreated&limit=1&cursor=${page1.cursor}`)).json;
    expect(page2.reset).toBe(true);
  });
});

describe('live updates', () => {
  it('pushes a mailbox event over the WebSocket when new mail arrives', async () => {
    const events: ServerEvent[] = [];
    const ws = await ctx.app.injectWS('/api/ws', { headers: { cookie, origin: 'http://localhost:8080' } });
    ws.on('message', (data) => events.push(JSON.parse(String(data)) as ServerEvent));
    // Give the watcher time to connect and enter IDLE.
    await new Promise((r) => setTimeout(r, 2000));
    const c = imapClient(ALICE);
    await c.connect();
    await c.append('INBOX', rawMessage({ from: BOB, to: ALICE, subject: 'Live', date: new Date(), id: 'live' }));
    await c.logout();
    const got = await until(async () => events.some((e) => e.type === 'mailbox' && e.accountId === accounts.alice!.id), 20_000);
    ws.terminate();
    expect(got).toBe(true);
  });

  it('rejects WebSockets from other origins', async () => {
    const ws = await ctx.app.injectWS('/api/ws', { headers: { cookie, origin: 'https://evil.example.com' } });
    const code = await new Promise<number>((resolve) => ws.on('close', (c) => resolve(c)));
    expect(code).toBe(4401);
  });
});
