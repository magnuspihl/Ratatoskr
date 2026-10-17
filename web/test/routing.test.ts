import { describe, expect, it } from 'vitest';
import { buildUrl, HOME, listRoute, openMessageFolder, parseLocation, readHistoryState, sameRoute, viewKey, type Route } from '../src/routing';

const ACC = '3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b';
const parse = (url: string) => {
  const u = new URL(url, 'https://mail.example.com');
  return parseLocation(u.pathname, u.search);
};

describe('routing', () => {
  it('parses the unified inbox', () => {
    expect(parse('/')).toEqual(HOME);
    expect(parse('/?q=invoice')).toEqual({ ...HOME, q: 'invoice' });
    expect(parse('/?unread=1')).toEqual({ ...HOME, unread: true });
    expect(parse('/?unread=yes')).toEqual(HOME);
  });

  it.each<Route>([
    HOME,
    { accountId: ACC, folder: 'INBOX', q: '', unread: false, open: null },
    { accountId: ACC, folder: 'INBOX', q: 'invoice', unread: true, open: null },
    { accountId: null, folder: 'INBOX', q: '', unread: true, open: { accountId: ACC, uidValidity: '7', uid: 3 } },
    { accountId: ACC, folder: 'INBOX.Sent', q: '', unread: false, open: null },
    { accountId: ACC, folder: 'Archive/2026/Receipts', q: '', unread: false, open: null },
    { accountId: ACC, folder: 'Entwürfe & Notizen #1?', q: 'a b&c=d', unread: false, open: null },
    { accountId: ACC, folder: 'INBOX', q: '', unread: false, open: { accountId: ACC, uidValidity: '1792243501', uid: 42 } },
    { accountId: null, folder: 'INBOX', q: 'x', unread: false, open: { accountId: ACC, uidValidity: '7', uid: 1 } },
  ])('round-trips %j', (route) => {
    expect(parse(buildUrl(route))).toEqual(route);
  });

  it('encodes folder separators so a folder is one path segment', () => {
    const url = buildUrl({ accountId: ACC, folder: 'A/B', q: '', unread: false, open: null });
    expect(url).toBe(`/mail/${ACC}/A%2FB`);
    // A hand-typed unencoded separator still works.
    expect(parse(`/mail/${ACC}/A/B`).folder).toBe('A/B');
  });

  it('builds clean URLs', () => {
    expect(buildUrl(HOME)).toBe('/');
    expect(buildUrl({ ...HOME, open: { accountId: ACC, uidValidity: '5', uid: 9 } })).toBe(`/?open=${ACC}.5.9`);
  });

  it('rejects malformed input instead of guessing', () => {
    expect(parse('/mail/not a valid id!/INBOX')).toEqual(HOME);
    expect(parse(`/mail/${ACC}/%E0%A4%A`)).toEqual(HOME); // bad percent-encoding
    expect(parse('/?open=../../etc').open).toBeNull();
    expect(parse(`/?open=${ACC}.5.0`).open).toBeNull();
    expect(parse(`/?open=${ACC}.x.9`).open).toBeNull();
    expect(parse('/some/unknown/path')).toEqual(HOME);
  });

  it('ignores an open message from a different account than the folder shown', () => {
    expect(parse(`/mail/${ACC}/INBOX?open=other-account.5.9`).open).toBeNull();
  });

  it('keeps the unread filter in the list route and view key, but not the open message', () => {
    const r = parse(`/mail/${ACC}/INBOX?unread=1&open=${ACC}.5.9`);
    expect(listRoute(r).unread).toBe(true);
    expect(viewKey(r)).toBe(`/mail/${ACC}/INBOX?unread=1`);
    expect(viewKey(r)).not.toBe(viewKey({ ...r, unread: false }));
  });

  it('knows the folder of an open message and its list route', () => {
    const r = parse(`/mail/${ACC}/Archive?q=x&open=${ACC}.5.9`);
    expect(openMessageFolder(r)).toBe('Archive');
    expect(openMessageFolder(parse(`/?open=${ACC}.5.9`))).toBe('INBOX');
    expect(listRoute(r)).toEqual({ ...r, open: null });
    expect(sameRoute(listRoute(r), parse(`/mail/${ACC}/Archive?q=x`))).toBe(true);
  });

  it('reads only well-formed app history state', () => {
    expect(readHistoryState(null)).toBeNull();
    expect(readHistoryState({ foo: 1 })).toBeNull();
    expect(readHistoryState({ app: true })).toEqual({ app: true });
    expect(readHistoryState({ app: true, overlay: 'compose' })).toEqual({ app: true, overlay: 'compose' });
    expect(readHistoryState({ app: true, overlay: 'evil' })).toEqual({ app: true });
  });
});
