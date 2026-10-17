import { describe, expect, it } from 'vitest';
import { buildUrl, HOME, listRoute, openMessageFolder, parseLocation, readHistoryState, sameRoute, type Route } from '../src/routing';

const ACC = '3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b';
const parse = (url: string) => {
  const u = new URL(url, 'https://mail.example.com');
  return parseLocation(u.pathname, u.search);
};

describe('routing', () => {
  it('parses the unified inbox', () => {
    expect(parse('/')).toEqual(HOME);
    expect(parse('/?q=invoice')).toEqual({ ...HOME, q: 'invoice' });
  });

  it.each<Route>([
    HOME,
    { accountId: ACC, folder: 'INBOX', q: '', open: null },
    { accountId: ACC, folder: 'INBOX.Sent', q: '', open: null },
    { accountId: ACC, folder: 'Archive/2026/Receipts', q: '', open: null },
    { accountId: ACC, folder: 'Entwürfe & Notizen #1?', q: 'a b&c=d', open: null },
    { accountId: ACC, folder: 'INBOX', q: '', open: { accountId: ACC, uidValidity: '1792243501', uid: 42 } },
    { accountId: null, folder: 'INBOX', q: 'x', open: { accountId: ACC, uidValidity: '7', uid: 1 } },
  ])('round-trips %j', (route) => {
    expect(parse(buildUrl(route))).toEqual(route);
  });

  it('encodes folder separators so a folder is one path segment', () => {
    const url = buildUrl({ accountId: ACC, folder: 'A/B', q: '', open: null });
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
