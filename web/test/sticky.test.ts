import { describe, expect, it } from 'vitest';
import type { MessageSummary } from '../../shared/types';
import { updateSticky, withSticky } from '../src/sticky';

const msg = (uid: number, seen = false): MessageSummary => ({
  accountId: 'a', folder: 'INBOX', uid, uidValidity: '1', messageId: null, subject: `m${uid}`, from: [], to: [],
  date: new Date(2026, 0, uid).toISOString(), snippet: '', seen, flagged: false, answered: false, draft: false,
  hasAttachments: false, size: 0,
});
const key = (m: MessageSummary) => `${m.accountId}|${m.uid}`;
const uids = (list: MessageSummary[]) => list.map((m) => m.uid);

describe('unread-only: read messages stay until the view changes', () => {
  it('keeps a message read in this view in its old position, marked read', () => {
    const shown = [msg(5), msg(4), msg(3), msg(2)];
    const fresh = [msg(5), msg(3), msg(2)]; // server no longer returns 4 (now read)
    const out = withSticky(shown, fresh, new Set(['a|4']), key);
    expect(uids(out)).toEqual([5, 4, 3, 2]);
    expect(out[1]!.seen).toBe(true);
  });

  it('does not keep messages that were not read in this view', () => {
    const out = withSticky([msg(5), msg(4)], [msg(5)], new Set(), key);
    expect(uids(out)).toEqual([5]);
  });

  it('shows new unread mail (e.g. from IDLE) next to kept messages', () => {
    const shown = [msg(5), msg(4)];
    const fresh = [msg(9), msg(5)]; // 9 arrived, 4 was read
    expect(uids(withSticky(shown, fresh, new Set(['a|4']), key))).toEqual([9, 5, 4]);
  });

  it('keeps several, including at the top and in a row', () => {
    const shown = [msg(6), msg(5), msg(4), msg(3)];
    const fresh = [msg(4)];
    expect(uids(withSticky(shown, fresh, new Set(['a|6', 'a|5', 'a|3']), key))).toEqual([6, 5, 4, 3]);
  });

  it('is stable across repeated refreshes', () => {
    const sticky = new Set(['a|4']);
    const first = withSticky([msg(5), msg(4), msg(3)], [msg(5), msg(3)], sticky, key);
    const second = withSticky(first, [msg(5), msg(3)], sticky, key);
    expect(uids(second)).toEqual([5, 4, 3]);
  });

  it('a fresh view (empty sticky set) shows exactly the server result', () => {
    expect(uids(withSticky([msg(5), msg(4)], [msg(5)], new Set(), key))).toEqual([5]);
  });

  it('remembers reads, forgets messages marked unread again or moved away', () => {
    let s = updateSticky(new Set(), ['a|4', 'a|3'], { type: 'seen', value: true });
    expect([...s].sort()).toEqual(['a|3', 'a|4']);
    s = updateSticky(s, ['a|3'], { type: 'seen', value: false });
    expect([...s]).toEqual(['a|4']);
    s = updateSticky(s, ['a|4'], { type: 'archive' });
    expect(s.size).toBe(0);
    expect(updateSticky(new Set(['a|1']), ['a|1'], { type: 'flagged', value: true })).toEqual(new Set(['a|1']));
  });
});
