import type { ActionResult, MessageAction, MessageRef, MessageSummary, SwipeAction } from '../../shared/types.js';

/** Pure swipe-gesture logic, kept free of DOM access so it can be unit tested. */

export type Axis = 'pending' | 'horizontal' | 'vertical';
export type Direction = 'left' | 'right';

/** Movement (px) before deciding whether a gesture is a swipe or a scroll. */
export const LOCK_SLOP = 10;
/** Fraction of the row width the row must travel to trigger. */
export const TRIGGER_FRACTION = 0.35;
/** A flick faster than this (px/ms) triggers even below the distance threshold... */
export const FLICK_VELOCITY = 0.6;
/** ...as long as it travelled at least this far. */
export const FLICK_MIN_DISTANCE = 40;

/**
 * Decide the gesture axis once the pointer has moved past the slop. Horizontal needs to clearly
 * dominate, so diagonal scrolling stays a scroll. Once decided the axis never changes.
 */
export function lockAxis(current: Axis, dx: number, dy: number, slop = LOCK_SLOP): Axis {
  if (current !== 'pending') return current;
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax < slop && ay < slop) return 'pending';
  return ax > ay * 1.5 ? 'horizontal' : 'vertical';
}

/** Offset to render for a finger offset: directions without an action only rubber-band a little. */
export function dragOffset(dx: number, leftEnabled: boolean, rightEnabled: boolean): number {
  const enabled = dx < 0 ? leftEnabled : rightEnabled;
  if (enabled) return dx;
  return Math.sign(dx) * Math.min(Math.abs(dx) * 0.15, 24);
}

export function directionOf(dx: number): Direction | null {
  return dx < 0 ? 'left' : dx > 0 ? 'right' : null;
}

/** Has the drag passed the distance threshold (used to "arm" the visual feedback)? */
export function isArmed(dx: number, width: number, fraction = TRIGGER_FRACTION): boolean {
  return width > 0 && Math.abs(dx) >= width * fraction;
}

/**
 * Outcome when the finger is lifted: the direction to trigger, or null to snap back.
 * `velocity` is px/ms along x (positive = right), measured over the last few moves.
 */
export function releaseOutcome(dx: number, velocity: number, width: number, enabled: { left: boolean; right: boolean }): Direction | null {
  const dir = directionOf(dx);
  if (!dir || !enabled[dir]) return null;
  if (isArmed(dx, width)) return dir;
  const flick = Math.abs(velocity) >= FLICK_VELOCITY && Math.sign(velocity) === Math.sign(dx) && Math.abs(dx) >= FLICK_MIN_DISTANCE;
  return flick ? dir : null;
}

/** Translate a configured swipe action into a message action for this message. */
export function swipeToAction(action: SwipeAction, m: Pick<MessageSummary, 'seen' | 'flagged'>): MessageAction | null {
  switch (action) {
    case 'delete':
      return { type: 'delete' };
    case 'archive':
      return { type: 'archive' };
    case 'toggleRead':
      return { type: 'seen', value: !m.seen };
    case 'toggleFlag':
      return { type: 'flagged', value: !m.flagged };
    default:
      return null;
  }
}

/** Does this action remove the row from the list (so it should animate out)? */
export function removesFromList(action: MessageAction): boolean {
  return action.type === 'delete' || action.type === 'archive' || action.type === 'move' || action.type === 'snooze' || action.type === 'unsnooze';
}

export interface UndoStep {
  refs: MessageRef[];
  action: MessageAction;
}

/**
 * Plan how to undo an action that just succeeded.
 * - read/flag: restore each message's previous value (grouped, so a mixed bulk selection comes
 *   back exactly as it was);
 * - move/archive/delete-to-Trash: move the messages, at their new UIDs reported by the server,
 *   back to the folder they came from;
 * - permanent deletion (expunge from Trash) can't be undone: returns null.
 */
export function undoPlan(
  action: MessageAction,
  refs: MessageRef[],
  result: ActionResult | null,
  previous: (ref: MessageRef) => boolean | undefined,
): UndoStep[] | null {
  if (action.type === 'seen' || action.type === 'flagged') {
    const restore = refs.filter((r) => {
      const before = previous(r);
      return before !== undefined && before !== action.value;
    });
    return restore.length ? [{ refs: restore, action: { type: action.type, value: !action.value } }] : null;
  }
  if (!result || result.permanent || result.undo.length === 0) return null;
  return result.undo.map((u) => ({
    refs: u.uids.map((uid) => ({ accountId: u.accountId, folder: u.folder, uid, uidValidity: u.uidValidity })),
    action: { type: 'move', destination: u.restoreTo },
  }));
}
