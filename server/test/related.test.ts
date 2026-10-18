import { describe, expect, it } from 'vitest';
import { threadHeaders } from '../src/imap/mail.js';
import { lookupTerms, matchesTerm, RelatedIndex, searchFor, TERMS_PER_SEARCH, type LookupTerm } from '../src/imap/related.js';

const headers = (messageId: string | null, inReplyTo: string | null = null, references: string[] = []) => ({ messageId, inReplyTo, references });

describe('finding the rest of a conversation', () => {
  it('searches for replies to a first message and for the message itself', () => {
    expect(lookupTerms(headers('<a@x>'))).toEqual([
      { field: 'references', id: '<a@x>' },
      { field: 'message-id', id: '<a@x>' },
      { field: 'in-reply-to', id: '<a@x>' },
    ]);
  });

  it('searches for the root of the conversation and the parent of a reply', () => {
    expect(lookupTerms(headers('<c@x>', '<b@x>', ['<a@x>', '<b@x>']))).toEqual([
      { field: 'references', id: '<a@x>' },
      { field: 'message-id', id: '<a@x>' },
      { field: 'in-reply-to', id: '<c@x>' },
      { field: 'message-id', id: '<b@x>' },
    ]);
  });

  it('skips IDs that are malformed or absurdly long', () => {
    expect(lookupTerms(headers('<a b@x>'))).toEqual([]);
    expect(lookupTerms(headers(`<${'x'.repeat(300)}@x>`))).toEqual([]);
    expect(lookupTerms(headers(null))).toEqual([]);
  });

  it('only counts exact matches, not the substring matches IMAP returns', () => {
    const t: LookupTerm = { field: 'references', id: '<a@x>' };
    expect(matchesTerm(t, headers('<z@x>', null, ['<a@x>']))).toBe(true);
    expect(matchesTerm(t, headers('<z@x>', null, ['<ba@x>']))).toBe(false);
    expect(matchesTerm({ field: 'message-id', id: '<a@x>' }, headers('<a@x>'))).toBe(true);
    expect(matchesTerm({ field: 'in-reply-to', id: '<a@x>' }, headers('<z@x>', '<a@x>'))).toBe(true);
  });

  it('combines several terms into one OR search, limited to new UIDs when asked', () => {
    const terms: LookupTerm[] = [
      { field: 'references', id: '<a@x>' },
      { field: 'message-id', id: '<a@x>' },
    ];
    expect(searchFor(terms, 1)).toEqual({ or: [{ header: { references: '<a@x>' } }, { header: { 'message-id': '<a@x>' } }] });
    expect(searchFor(terms.slice(0, 1), 40)).toEqual({ uid: '40:*', header: { references: '<a@x>' } });
  });
});

describe('remembering conversation searches per folder', () => {
  const t1: LookupTerm = { field: 'references', id: '<a@x>' };
  const t2: LookupTerm = { field: 'message-id', id: '<b@x>' };

  it('searches the whole folder for a new term, then only mail that arrived since', () => {
    const idx = new RelatedIndex();
    const first = idx.plan('f', '1', 100, [t1]);
    expect(first.searches).toEqual([{ fromUid: 1, terms: [t1] }]);
    idx.record('f', '1', 100, [t1], new Set(['references <a@x>']), [{ uid: 42, headers: headers('<r@x>', null, ['<a@x>']) }]);

    const unchanged = idx.plan('f', '1', 100, [t1]);
    expect(unchanged.searches).toEqual([]);
    expect([...unchanged.known]).toEqual([42]);

    const newMail = idx.plan('f', '1', 105, [t1, t2]);
    expect(newMail.searches).toEqual([
      { fromUid: 100, terms: [t1] },
      { fromUid: 1, terms: [t2] },
    ]);
  });

  it('forgets a match once the message is gone from the folder', () => {
    const idx = new RelatedIndex();
    idx.record('f', '1', 100, [t1], new Set(['references <a@x>']), [{ uid: 42, headers: headers('<r@x>', null, ['<a@x>']) }]);
    idx.record('f', '1', 100, [t1], new Set(), []);
    expect([...idx.plan('f', '1', 100, [t1]).known]).toEqual([]);
  });

  it('starts over when the folder was recreated (UIDVALIDITY changed)', () => {
    const idx = new RelatedIndex();
    idx.record('f', '1', 100, [t1], new Set(['references <a@x>']), [{ uid: 42, headers: headers('<r@x>', null, ['<a@x>']) }]);
    const plan = idx.plan('f', '2', 100, [t1]);
    expect(plan.known.size).toBe(0);
    expect(plan.searches).toEqual([{ fromUid: 1, terms: [t1] }]);
  });

  it('searches again later for a term whose search failed', () => {
    const idx = new RelatedIndex();
    idx.record('f', '1', 100, [t1], new Set(), []);
    expect(idx.plan('f', '1', 100, [t1]).searches).toHaveLength(1);
  });

  it('splits many terms into several short searches', () => {
    const terms = Array.from({ length: TERMS_PER_SEARCH * 2 + 1 }, (_, i) => ({ field: 'references' as const, id: `<m${i}@x>` }));
    expect(new RelatedIndex().plan('f', '1', 10, terms).searches.map((s) => s.terms.length)).toEqual([TERMS_PER_SEARCH, TERMS_PER_SEARCH, 1]);
  });
});

describe('reading thread headers from a listing', () => {
  it('reads folded References and the In-Reply-To ID', () => {
    const h = threadHeaders({
      envelope: { messageId: '<c@x>', inReplyTo: '<b@x> (comment)' },
      headers: Buffer.from('References: <a@x>\r\n <b@x>\r\n\r\n'),
    });
    expect(h).toEqual({ messageId: '<c@x>', inReplyTo: '<b@x>', references: ['<a@x>', '<b@x>'] });
  });

  it('reads In-Reply-To from the headers when the server leaves it out of the envelope', () => {
    const h = threadHeaders({ envelope: { messageId: '<c@x>' }, headers: Buffer.from('In-Reply-To:\r\n <b@x>\r\n\r\n') });
    expect(h.inReplyTo).toBe('<b@x>');
  });

  it('keeps the first and the latest references of very long chains', () => {
    const refs = Array.from({ length: 50 }, (_, i) => `<r${i}@x>`);
    const h = threadHeaders({ envelope: {}, headers: Buffer.from(`References: ${refs.join(' ')}\r\n`) });
    expect(h.references).toHaveLength(30);
    expect(h.references[0]).toBe('<r0@x>');
    expect(h.references.at(-1)).toBe('<r49@x>');
    expect(h.messageId).toBeNull();
  });
});
