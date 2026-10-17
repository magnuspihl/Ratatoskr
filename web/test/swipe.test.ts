import { describe, expect, it } from 'vitest';
import type { ActionResult, MessageRef } from '../../shared/types';
import {
  dragOffset,
  FLICK_MIN_DISTANCE,
  isArmed,
  lockAxis,
  LOCK_SLOP,
  releaseOutcome,
  removesFromList,
  swipeToAction,
  undoPlan,
} from '../src/swipe';

const both = { left: true, right: true };

describe('direction lock', () => {
  it('stays pending inside the slop', () => {
    expect(lockAxis('pending', 3, 4)).toBe('pending');
    expect(lockAxis('pending', -(LOCK_SLOP - 1), 0)).toBe('pending');
  });
  it('locks horizontal only when x clearly dominates', () => {
    expect(lockAxis('pending', 20, 3)).toBe('horizontal');
    expect(lockAxis('pending', -20, 5)).toBe('horizontal');
    expect(lockAxis('pending', 12, 10)).toBe('vertical'); // diagonal: let it scroll
    expect(lockAxis('pending', 2, 30)).toBe('vertical');
  });
  it('never changes once decided', () => {
    expect(lockAxis('vertical', 200, 0)).toBe('vertical');
    expect(lockAxis('horizontal', 0, 200)).toBe('horizontal');
  });
});

describe('release threshold', () => {
  const width = 400;
  it('triggers past ~35% of the width', () => {
    expect(releaseOutcome(-141, 0, width, both)).toBe('left');
    expect(releaseOutcome(141, 0, width, both)).toBe('right');
    expect(releaseOutcome(-130, 0, width, both)).toBeNull();
    expect(isArmed(140, width)).toBe(true);
    expect(isArmed(139, width)).toBe(false);
  });
  it('triggers on a fast flick in the same direction', () => {
    expect(releaseOutcome(-60, -1.2, width, both)).toBe('left');
    expect(releaseOutcome(60, 1.2, width, both)).toBe('right');
  });
  it('does not trigger on a flick back, a tiny flick, or a slow drag', () => {
    expect(releaseOutcome(-80, 1.5, width, both)).toBeNull();
    expect(releaseOutcome(FLICK_MIN_DISTANCE - 1, 2, width, both)).toBeNull();
    expect(releaseOutcome(100, 0.1, width, both)).toBeNull();
  });
  it('never triggers a direction without an action', () => {
    expect(releaseOutcome(-300, -2, width, { left: false, right: true })).toBeNull();
    expect(dragOffset(-300, false, true)).toBe(-24); // only a small rubber band
    expect(dragOffset(-30, true, true)).toBe(-30);
  });
});

describe('swipe actions', () => {
  it('maps configured actions to message actions', () => {
    expect(swipeToAction('delete', { seen: true, flagged: false })).toEqual({ type: 'delete' });
    expect(swipeToAction('archive', { seen: true, flagged: false })).toEqual({ type: 'archive' });
    expect(swipeToAction('toggleRead', { seen: true, flagged: false })).toEqual({ type: 'seen', value: false });
    expect(swipeToAction('toggleRead', { seen: false, flagged: false })).toEqual({ type: 'seen', value: true });
    expect(swipeToAction('toggleFlag', { seen: true, flagged: true })).toEqual({ type: 'flagged', value: false });
    expect(swipeToAction('none', { seen: true, flagged: true })).toBeNull();
    expect(removesFromList({ type: 'archive' })).toBe(true);
    expect(removesFromList({ type: 'seen', value: true })).toBe(false);
  });
});

describe('undo plans', () => {
  const ref = (uid: number, folder = 'INBOX'): MessageRef => ({ accountId: 'a', folder, uid, uidValidity: '1' });
  const result = (over: Partial<ActionResult>): ActionResult => ({ undo: [], permanent: false, createdFolders: [], ...over });

  it('moves archived/deleted messages back from their new location', () => {
    const plan = undoPlan(
      { type: 'archive' },
      [ref(10), ref(11)],
      result({ undo: [{ accountId: 'a', folder: 'Archive', uidValidity: '99', uids: [500, 501], restoreTo: 'INBOX' }] }),
      () => undefined,
    );
    expect(plan).toEqual([
      {
        refs: [
          { accountId: 'a', folder: 'Archive', uid: 500, uidValidity: '99' },
          { accountId: 'a', folder: 'Archive', uid: 501, uidValidity: '99' },
        ],
        action: { type: 'move', destination: 'INBOX' },
      },
    ]);
  });

  it('handles moves that span several accounts', () => {
    const plan = undoPlan(
      { type: 'delete' },
      [ref(1), { ...ref(2), accountId: 'b' }],
      result({
        undo: [
          { accountId: 'a', folder: 'Trash', uidValidity: '1', uids: [7], restoreTo: 'INBOX' },
          { accountId: 'b', folder: 'Deleted Items', uidValidity: '2', uids: [8], restoreTo: 'INBOX' },
        ],
      }),
      () => undefined,
    );
    expect(plan?.map((s) => [s.refs[0]!.accountId, s.refs[0]!.folder, s.action])).toEqual([
      ['a', 'Trash', { type: 'move', destination: 'INBOX' }],
      ['b', 'Deleted Items', { type: 'move', destination: 'INBOX' }],
    ]);
  });

  it('cannot undo a permanent delete or a move without undo info', () => {
    expect(undoPlan({ type: 'delete' }, [ref(1, 'Trash')], result({ permanent: true }), () => undefined)).toBeNull();
    expect(undoPlan({ type: 'archive' }, [ref(1)], null, () => undefined)).toBeNull();
  });

  it('restores read/flag state exactly, only for messages that changed', () => {
    const before = new Map([
      [10, false],
      [11, true],
    ]);
    const plan = undoPlan({ type: 'seen', value: true }, [ref(10), ref(11)], result({}), (r) => before.get(r.uid));
    expect(plan).toEqual([{ refs: [ref(10)], action: { type: 'seen', value: false } }]);
    expect(undoPlan({ type: 'flagged', value: false }, [ref(11)], result({}), () => false)).toBeNull();
  });
});
