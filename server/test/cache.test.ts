import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { MessageSummary } from '../../shared/types.js';
import { CacheCorruptError, MailCache, type CachedFolder } from '../src/cache/store.js';
import { loadConfig } from '../src/config.js';
import { Keyring } from '../src/crypto.js';

// Generated per test run; never a real key.
const secret = () => crypto.randomBytes(48).toString('base64');
const keysOf = (s: string) => {
  const k = new Keyring(s);
  return { cacheKey: k.cacheKey, indexKey: k.cacheIndexKey };
};

const dirs: string[] = [];
const tempFile = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ratatoskr-cache-'));
  dirs.push(dir);
  return path.join(dir, 'cache.db');
};
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function summary(f: CachedFolder, uid: number, over: Partial<MessageSummary> = {}): MessageSummary {
  return {
    accountId: f.accountId,
    folder: f.path,
    uid,
    uidValidity: f.uidValidity,
    messageId: `<m${uid}@example.com>`,
    inReplyTo: null,
    references: [],
    subject: `Subject ${uid}`,
    from: [{ name: 'Ada', address: 'ada@example.com' }],
    to: [{ name: '', address: 'me@example.com' }],
    date: new Date(Date.UTC(2026, 0, 1) + uid * 60_000).toISOString(),
    snippet: `Snippet ${uid}`,
    seen: false,
    flagged: false,
    answered: false,
    draft: false,
    hasAttachments: false,
    size: 1000 + uid,
    ...over,
  };
}

function put(cache: MailCache, f: CachedFolder, ...list: MessageSummary[]) {
  cache.putMessages(f, list.map((s) => ({ summary: s, sortTime: new Date(s.date).getTime(), internalDate: s.date })));
}

/** A folder that has been synced once, holding UIDs from 1 up. */
function inbox(cache: MailCache, userId = 'u1', accountId = 'a1', path = 'INBOX', role: 'inbox' | 'sent' = 'inbox') {
  const f = cache.resetFolder(userId, accountId, path, role, '7');
  cache.updateFolder(f, { lowUid: 1, uidNext: 1, complete: true, syncedAt: Date.now() });
  return f;
}

describe('mail cache storage', () => {
  it('keeps subjects, addresses, snippets, Message-IDs and message content encrypted on disk', () => {
    const file = tempFile();
    const cache = new MailCache(file, keysOf(secret()));
    const f = inbox(cache);
    put(cache, f, summary(f, 1, { subject: 'Quarterly numbers', snippet: 'Revenue went up', messageId: '<secret-thread@corp.example>', from: [{ name: 'Grace Hopper', address: 'grace@navy.example' }] }));
    cache.putBody(f, 1, Buffer.from('Subject: Quarterly numbers\r\n\r\nThe launch code is 4711\r\n'));
    cache.close();

    const bytes = Buffer.concat([file, `${file}-wal`].filter((p) => fs.existsSync(p)).map((p) => fs.readFileSync(p)));
    for (const plain of ['Quarterly numbers', 'Revenue went up', 'secret-thread', 'Grace Hopper', 'grace@navy.example', 'launch code']) {
      expect(bytes.includes(Buffer.from(plain)), plain).toBe(false);
    }
  });

  it('lists cached messages newest first, below a cursor and unread only', () => {
    const cache = new MailCache(':memory:', keysOf(secret()));
    const f = inbox(cache);
    put(cache, f, summary(f, 1), summary(f, 2, { seen: true }), summary(f, 3), summary(f, 4, { flagged: true }));
    expect(cache.page(f, null, 10).map((m) => m.summary.uid)).toEqual([4, 3, 2, 1]);
    expect(cache.page(f, 4, 2).map((m) => m.summary.uid)).toEqual([3, 2]);
    expect(cache.page(f, null, 10, true).map((m) => m.summary.uid)).toEqual([4, 3, 1]);
    const m = cache.message(f, 4)!.summary;
    expect(m).toMatchObject({ subject: 'Subject 4', flagged: true, seen: false, folder: 'INBOX', accountId: 'a1', uidValidity: '7' });
  });

  it('applies flag changes and removals', () => {
    const cache = new MailCache(':memory:', keysOf(secret()));
    const f = inbox(cache);
    put(cache, f, summary(f, 1), summary(f, 2));
    cache.changeFlag(f, [1], 'seen', true);
    expect(cache.setFlags(f, [{ uid: 2, flags: { seen: false, flagged: true, answered: true, draft: false } }])).toBe(1);
    expect(cache.message(f, 1)!.summary.seen).toBe(true);
    expect(cache.message(f, 2)!.summary).toMatchObject({ flagged: true, answered: true });
    cache.removeMessages(f, [1]);
    expect(cache.uids(f)).toEqual([2]);
  });

  it('finds the rest of a conversation by Message-ID, References and In-Reply-To', () => {
    const cache = new MailCache(':memory:', keysOf(secret()));
    const sent = inbox(cache, 'u1', 'a1', 'Sent', 'sent');
    put(
      cache,
      sent,
      summary(sent, 1, { messageId: '<reply@x>', inReplyTo: '<root@x>', references: ['<root@x>'] }),
      summary(sent, 2, { messageId: '<other@x>' }),
    );
    expect(cache.related(sent, [{ field: 'references', id: '<root@x>' }], 10).map((m) => m.summary.uid)).toEqual([1]);
    expect(cache.related(sent, [{ field: 'in-reply-to', id: '<root@x>' }], 10).map((m) => m.summary.uid)).toEqual([1]);
    expect(cache.related(sent, [{ field: 'message-id', id: '<other@x>' }], 10).map((m) => m.summary.uid)).toEqual([2]);
    expect(cache.related(sent, [{ field: 'message-id', id: '<root@x>' }], 10)).toEqual([]);
  });

  it('never matches conversations across users or accounts', () => {
    const cache = new MailCache(':memory:', keysOf(secret()));
    const mine = inbox(cache, 'u1', 'a1');
    const theirs = inbox(cache, 'u2', 'a2');
    put(cache, theirs, summary(theirs, 1, { messageId: '<shared@x>' }));
    expect(cache.related(mine, [{ field: 'message-id', id: '<shared@x>' }], 10)).toEqual([]);
    expect(cache.folder('u1', 'a2', 'INBOX')).toBeNull();
  });

  it('keeps only the newest messages of a folder and remembers where its copy starts', () => {
    const cache = new MailCache(':memory:', keysOf(secret()));
    const f = inbox(cache);
    put(cache, f, ...[1, 2, 3, 4, 5].map((u) => summary(f, u)));
    cache.trim(f, 3);
    expect(cache.uids(f)).toEqual([3, 4, 5]);
    expect(cache.folder('u1', 'a1', 'INBOX')).toMatchObject({ lowUid: 3, complete: false });
    // A page reaching below the copy stops there (the caller asks the IMAP server for the rest).
    expect(cache.page(f, null, 10).map((m) => m.summary.uid)).toEqual([5, 4, 3]);
  });

  it('drops the least recently read message content first when an account is over its budget', () => {
    const cache = new MailCache(':memory:', keysOf(secret()));
    const f = inbox(cache);
    put(cache, f, summary(f, 1), summary(f, 2), summary(f, 3));
    cache.putBody(f, 1, Buffer.alloc(400, 'a'), 1000);
    cache.putBody(f, 2, Buffer.alloc(400, 'b'), 3000);
    cache.putBody(f, 3, Buffer.alloc(400, 'c'), 2000);
    cache.enforceBodyBudget('u1', 'a1', 900);
    expect([1, 2, 3].map((u) => cache.hasBody(f, u))).toEqual([false, true, true]);
    expect(cache.body(f, 2)!.toString()).toBe('b'.repeat(400));
  });

  it('suggests the newest unread, not too large, not yet stored messages to load ahead', () => {
    const cache = new MailCache(':memory:', keysOf(secret()));
    const f = inbox(cache);
    put(cache, f, summary(f, 1), summary(f, 2, { seen: true }), summary(f, 3, { size: 5_000_000 }), summary(f, 4), summary(f, 5));
    cache.putBody(f, 5, Buffer.from('x'));
    expect(cache.prefetchCandidates(f, 100, 1_000_000, 10)).toEqual([4, 1]);
  });

  it('forgets message content together with the message', () => {
    const cache = new MailCache(':memory:', keysOf(secret()));
    const f = inbox(cache);
    put(cache, f, summary(f, 1));
    cache.putBody(f, 1, Buffer.from('content'));
    cache.removeMessages(f, [1]);
    expect(cache.hasBody(f, 1)).toBe(false);
    expect(cache.bodyBytes('u1', 'a1')).toBe(0);
  });

  it('starts empty when the secret key changes', () => {
    const file = tempFile();
    const first = new MailCache(file, keysOf(secret()));
    const f = inbox(first);
    put(first, f, summary(f, 1));
    first.close();
    const second = new MailCache(file, keysOf(secret()));
    expect(second.folder('u1', 'a1', 'INBOX')).toBeNull();
    second.close();
  });

  it('keeps its contents across restarts with the same key', () => {
    const file = tempFile();
    const s = secret();
    const first = new MailCache(file, keysOf(s));
    const f = inbox(first);
    put(first, f, summary(f, 1));
    first.close();
    const second = new MailCache(file, keysOf(s));
    expect(second.page(second.folder('u1', 'a1', 'INBOX')!, null, 10).map((m) => m.summary.subject)).toEqual(['Subject 1']);
    second.close();
  });

  it('starts over when the file is damaged', () => {
    const file = tempFile();
    fs.writeFileSync(file, 'this is not a database, just junk bytes '.repeat(200));
    const cache = new MailCache(file, keysOf(secret()));
    const f = inbox(cache);
    put(cache, f, summary(f, 1));
    expect(cache.uids(f)).toEqual([1]);
    cache.close();
  });

  it('reports a tampered entry as unreadable instead of returning it', () => {
    const file = tempFile();
    const cache = new MailCache(file, keysOf(secret()));
    const f = inbox(cache);
    put(cache, f, summary(f, 1));
    const raw = new DatabaseSync(file);
    raw.prepare('UPDATE messages SET data = randomblob(64)').run();
    raw.close();
    expect(() => cache.page(f, null, 10)).toThrow(CacheCorruptError);
    cache.close();
  });

  it('refuses an entry copied to another folder', () => {
    const file = tempFile();
    const cache = new MailCache(file, keysOf(secret()));
    const a = inbox(cache, 'u1', 'a1');
    const b = inbox(cache, 'u2', 'a2');
    put(cache, a, summary(a, 1));
    const raw = new DatabaseSync(file);
    raw.prepare('INSERT INTO messages (folder_id, uid, sort_time, flags, size, data) SELECT ?, uid, sort_time, flags, size, data FROM messages WHERE folder_id = ?').run(b.id, a.id);
    raw.close();
    expect(() => cache.page(b, null, 10)).toThrow(CacheCorruptError);
    cache.close();
  });

  it('forgets accounts that no longer exist', () => {
    const cache = new MailCache(':memory:', keysOf(secret()));
    inbox(cache, 'u1', 'a1');
    inbox(cache, 'u1', 'gone');
    cache.prune(new Set(['u1\u0000a1']));
    expect(cache.folder('u1', 'a1', 'INBOX')).not.toBeNull();
    expect(cache.folder('u1', 'gone', 'INBOX')).toBeNull();
  });

  it('keeps one Sent folder per account: a renamed Sent folder replaces the old one', () => {
    const cache = new MailCache(':memory:', keysOf(secret()));
    inbox(cache, 'u1', 'a1', 'Sent', 'sent');
    cache.resetFolder('u1', 'a1', 'Sent Items', 'sent', '9');
    expect(cache.folder('u1', 'a1', 'Sent')).toBeNull();
    expect(cache.folderByRole('u1', 'a1', 'sent')?.path).toBe('Sent Items');
  });
});

describe('mail cache settings', () => {
  const base = { RATATOSKR_SECRET_KEY: secret(), RATATOSKR_DEV_LOGIN: 'true' };

  it('is on by default with 2000 messages per folder, 1 MB per message and 200 MB per account', () => {
    expect(loadConfig(base).cache).toEqual({ messagesPerFolder: 2000, maxBodyBytes: 1024 * 1024, bodyBytesPerAccount: 200 * 1024 * 1024 });
  });

  it('can be switched off or sized by the administrator', () => {
    expect(loadConfig({ ...base, RATATOSKR_CACHE: 'false' }).cache).toBeNull();
    expect(loadConfig({ ...base, RATATOSKR_CACHE_MESSAGES: '500', RATATOSKR_CACHE_MAX_BODY_MB: '0.5', RATATOSKR_CACHE_ACCOUNT_MB: '50' }).cache).toEqual({
      messagesPerFolder: 500,
      maxBodyBytes: 512 * 1024,
      bodyBytesPerAccount: 50 * 1024 * 1024,
    });
  });

  it('rejects an unreasonable number of messages per folder', () => {
    expect(() => loadConfig({ ...base, RATATOSKR_CACHE_MESSAGES: '10' })).toThrow(/RATATOSKR_CACHE_MESSAGES/);
    expect(() => loadConfig({ ...base, RATATOSKR_CACHE_MESSAGES: '10000000' })).toThrow(/RATATOSKR_CACHE_MESSAGES/);
  });
});
