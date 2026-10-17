import { describe, expect, it } from 'vitest';
import { isFiltered, NO_FILTER, searchAttempts } from '../src/imap/mail.js';

const textAttempts = (q: string, extra: object = {}) => [
  { ...extra, or: [{ subject: q }, { from: q }, { to: q }, { body: q }] },
  { ...extra, text: q },
  { ...extra, subject: q },
];

describe('searchAttempts (IMAP SEARCH criteria)', () => {
  it('unread only: a single UNSEEN search', () => {
    expect(searchAttempts({ text: '', unread: true })).toEqual([{ seen: false }]);
  });

  it('unread only, next page: UNSEEN below the cursor', () => {
    expect(searchAttempts({ text: '', unread: true }, { beforeUid: 120 })).toEqual([{ uid: '1:119', seen: false }]);
  });

  it('text only: preferred query with fallbacks', () => {
    expect(searchAttempts({ text: 'invoice', unread: false })).toEqual(textAttempts('invoice'));
  });

  it('unread + text: UNSEEN is part of every attempt, including fallbacks', () => {
    const attempts = searchAttempts({ text: 'invoice march', unread: true }, { beforeUid: 50 });
    expect(attempts).toEqual(textAttempts('invoice march', { uid: '1:49', seen: false }));
    expect(attempts.every((a) => a.seen === false && a.uid === '1:49')).toBe(true);
  });

  it('unified view: every account gets the same filter, scoped by its own cursor', () => {
    // Accounts page independently; only the UID scope differs per source.
    const filter = { text: '', unread: true };
    const cursors = { work: { beforeUid: 900 }, home: undefined, club: { beforeUid: 3 } };
    expect(Object.fromEntries(Object.entries(cursors).map(([acc, c]) => [acc, searchAttempts(filter, c)]))).toEqual({
      work: [{ uid: '1:899', seen: false }],
      home: [{ seen: false }],
      club: [{ uid: '1:2', seen: false }],
    });
  });

  it('only filtered listings use SEARCH', () => {
    expect(isFiltered(NO_FILTER)).toBe(false);
    expect(isFiltered({ text: '', unread: true })).toBe(true);
    expect(isFiltered({ text: 'x', unread: false })).toBe(true);
  });
});
