import type { FetchMessageObject } from 'imapflow';
import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor, mergePages } from '../src/imap/mail.js';

function page(accountId: string, entries: [uid: number, time: number][], exhausted: boolean) {
  const source = { accountId, folder: 'INBOX' };
  return {
    source,
    uidValidity: '1',
    exhausted,
    reset: false,
    items: entries.map(([uid, sortTime]) => ({ source, uidValidity: '1', sortTime, msg: { uid, seq: uid } as FetchMessageObject })),
  };
}

describe('unified inbox merge', () => {
  it('merges by date and records per-account cursors', () => {
    const a = page('a', [[10, 100], [9, 80], [8, 60]], true);
    const b = page('b', [[50, 90], [49, 70], [48, 10]], false);
    const { picked, cursor, more } = mergePages([a, b], 4, {});
    expect(picked.map((p) => `${p.source.accountId}${p.msg.uid}`)).toEqual(['a10', 'b50', 'a9', 'b49']);
    expect(cursor['a\u0000INBOX']).toEqual({ uidValidity: '1', beforeUid: 9, done: false });
    expect(cursor['b\u0000INBOX']).toEqual({ uidValidity: '1', beforeUid: 49, done: false });
    expect(more).toBe(true);
  });

  it('keeps each account a strict UID-descending prefix even if dates disagree', () => {
    // UID 9 has a newer date than UID 10 (e.g. a message copied in later with an old date).
    const a = page('a', [[10, 50], [9, 100]], true);
    const b = page('b', [[5, 60]], true);
    const { picked, cursor } = mergePages([a, b], 2, {});
    expect(picked.map((p) => `${p.source.accountId}${p.msg.uid}`)).toEqual(['b5', 'a10']);
    expect(cursor['a\u0000INBOX']!.beforeUid).toBe(10);
  });

  it('marks exhausted sources as done and stops when everything is consumed', () => {
    const a = page('a', [[2, 10], [1, 5]], true);
    const { cursor, more } = mergePages([a], 10, {});
    expect(cursor['a\u0000INBOX']!.done).toBe(true);
    expect(more).toBe(false);
  });

  it('does not skip an untouched source', () => {
    const a = page('a', [[10, 100]], false);
    const b = page('b', [[7, 1]], false);
    const { cursor } = mergePages([a, b], 1, {});
    // Nothing from b was consumed, so its next page must still include UID 7.
    expect(cursor['b\u0000INBOX']!.beforeUid).toBe(8);
  });

  it('round-trips cursors and ignores garbage', () => {
    const c = { 'a\u0000INBOX': { uidValidity: '3', beforeUid: 77, done: false } };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
    expect(decodeCursor('not-base64-json')).toEqual({});
    expect(decodeCursor(Buffer.from('{"x":{"uidValidity":1}}').toString('base64url'))).toEqual({});
  });
});
