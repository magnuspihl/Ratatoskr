import crypto from 'node:crypto';
import { ImapFlow } from 'imapflow';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { groupConversations } from '../../../shared/threads.js';
import type { AccountView, ListResponse } from '../../../shared/types.js';
import { buildApp, type App } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { Keyring } from '../../src/crypto.js';
import { Store } from '../../src/db.js';

/**
 * Conversations end to end against GreenMail: a reply sent from another mail client only exists
 * in the Sent folder, and the listing has to bring it along with the inbox message it answers.
 * Uses its own mailbox so it doesn't disturb the other integration tests.
 */

const gm = inject('greenmail');
const FRAN = 'fran@example.com';
const GUS = 'gus@example.com';

let ctx: App;
let store: Store;
let cookie = '';
let account: AccountView;

function raw(opts: { from: string; to: string; subject: string; id: string; date: Date; inReplyTo?: string; references?: string[]; text?: string }) {
  const thread =
    (opts.inReplyTo ? `In-Reply-To: <${opts.inReplyTo}@example.com>\r\n` : '') +
    (opts.references ? `References: ${opts.references.map((r) => `<${r}@example.com>`).join('\r\n ')}\r\n` : '');
  return Buffer.from(
    `From: ${opts.from}\r\nTo: ${opts.to}\r\nSubject: ${opts.subject}\r\nDate: ${opts.date.toUTCString()}\r\n` +
      `Message-ID: <${opts.id}@example.com>\r\n${thread}MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${opts.text ?? 'hello'}\r\n`,
  );
}

async function withImap(fn: (c: ImapFlow) => Promise<void>) {
  const c = new ImapFlow({ host: gm.host, port: gm.imapPort, secure: false, doSTARTTLS: false, auth: { user: FRAN, pass: 'x' }, logger: false });
  c.on('error', () => {});
  await c.connect();
  try {
    await fn(c);
  } finally {
    await c.logout();
  }
}

async function list(folder: string, query = '') {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/messages?accountId=${account.id}&folder=${encodeURIComponent(folder)}${query}`,
    headers: { cookie, 'x-ratatoskr': '1' },
  });
  return JSON.parse(res.body) as ListResponse;
}

const base = Date.UTC(2026, 5, 1, 12);
const at = (hours: number) => new Date(base + hours * 3600e3);
const id = (s: string) => `${s}-${crypto.randomUUID().slice(0, 8)}`;
const ids = { question: id('question'), reply: id('reply'), followUp: id('followup'), other: id('other'), stray: id('stray') };

beforeAll(async () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    RATATOSKR_SECRET_KEY: crypto.randomBytes(48).toString('base64'),
    RATATOSKR_DEV_LOGIN: 'true',
    RATATOSKR_DATA_DIR: '/nonexistent-not-used',
    RATATOSKR_BASE_URL: 'http://localhost:8080',
  });
  store = new Store(':memory:', new Keyring(config.secretKey).credentialKey);
  ctx = await buildApp(config, { store, logger: false });
  const login = await ctx.app.inject({ method: 'GET', url: '/auth/dev-login' });
  cookie = `rk_session=${login.cookies.find((c) => c.name === 'rk_session')!.value}`;

  await withImap(async (c) => {
    for (const f of ['Sent', 'Drafts', 'Trash']) await c.mailboxCreate(f).catch(() => undefined);
    await c.append('INBOX', raw({ from: GUS, to: FRAN, subject: 'Boat trip', id: ids.question, date: at(0), text: 'Are you in?' }), ['\\Seen'], at(0));
    await c.append('INBOX', raw({ from: GUS, to: FRAN, subject: 'Unrelated', id: ids.other, date: at(1) }), ['\\Seen'], at(1));
    // Fran answered from her phone: the reply is only in Sent.
    await c.append(
      'Sent',
      raw({ from: FRAN, to: GUS, subject: 'Re: Boat trip', id: ids.reply, date: at(2), inReplyTo: ids.question, references: [ids.question], text: 'Count me in' }),
      ['\\Seen'],
      at(2),
    );
    await c.append('Sent', raw({ from: FRAN, to: GUS, subject: 'Something else', id: ids.stray, date: at(3) }), ['\\Seen'], at(3));
  });

  const server = (port: number) => ({ host: gm.host, port, tls: 'none' as const, user: FRAN, password: 'pw' });
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/accounts',
    headers: { cookie, 'x-ratatoskr': '1', 'content-type': 'application/json' },
    payload: JSON.stringify({ name: 'Fran', displayName: 'Fran', email: FRAN, color: '#123456', imap: server(gm.imapPort), smtp: server(gm.smtpPort), appendSent: false }),
  });
  account = JSON.parse(res.body) as AccountView;
});

afterAll(async () => {
  await ctx?.app.close();
  store?.close();
});

describe('conversations', () => {
  it('brings my reply from the Sent folder along with the inbox message it answers', async () => {
    const res = await list('INBOX');
    expect(res.related.map((m) => m.messageId)).toEqual([`<${ids.reply}@example.com>`]);
    expect(res.related[0]).toMatchObject({ folder: 'Sent', inReplyTo: `<${ids.question}@example.com>`, snippet: 'Count me in' });
    const rows = groupConversations(res.messages, res.related);
    const trip = rows.find((r) => r.subject === 'Boat trip')!;
    expect(trip.thread.map((m) => m.subject)).toEqual(['Boat trip', 'Re: Boat trip']);
    expect(rows.find((r) => r.subject === 'Unrelated')!.thread).toHaveLength(1);
  });

  it('picks up a new reply in Sent on the next refresh', async () => {
    await list('INBOX');
    const followUp = id('followup2');
    await withImap((c) =>
      c
        .append(
          'Sent',
          raw({ from: FRAN, to: GUS, subject: 'Re: Boat trip', id: followUp, date: at(4), inReplyTo: ids.reply, references: [ids.question, ids.reply] }),
          ['\\Seen'],
          at(4),
        )
        .then(() => undefined),
    );
    const res = await list('INBOX');
    expect(res.related.map((m) => m.messageId).sort()).toEqual([`<${followUp}@example.com>`, `<${ids.reply}@example.com>`].sort());
  });

  it('finds older messages of the conversation in the listed folder that are not on this page', async () => {
    await withImap((c) =>
      c
        .append(
          'INBOX',
          raw({ from: GUS, to: FRAN, subject: 'Re: Boat trip', id: ids.followUp, date: at(5), inReplyTo: ids.reply, references: [ids.question, ids.reply] }),
          [],
          at(5),
        )
        .then(() => undefined),
    );
    const res = await list('INBOX', '&limit=1');
    expect(res.messages.map((m) => m.messageId)).toEqual([`<${ids.followUp}@example.com>`]);
    const question = res.related.find((m) => m.messageId === `<${ids.question}@example.com>`);
    expect(question?.folder).toBe('INBOX');
    const [row] = groupConversations(res.messages, res.related);
    // Archiving this row takes the older inbox message along, but not the replies in Sent.
    expect(row!.members.map((m) => m.folder)).toEqual(['INBOX', 'INBOX']);
    expect(row!.thread.length).toBeGreaterThanOrEqual(3);
  });

  it('does not look for conversations in the Drafts folder', async () => {
    await withImap((c) =>
      c.append('Drafts', raw({ from: FRAN, to: GUS, subject: 'Re: Boat trip', id: id('draft'), date: at(6), inReplyTo: ids.question, references: [ids.question] }), ['\\Draft'], at(6)).then(() => undefined),
    );
    const res = await list('Drafts');
    expect(res.messages).toHaveLength(1);
    expect(res.related).toEqual([]);
  });
});
