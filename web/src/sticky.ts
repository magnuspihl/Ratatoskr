import type { MessageSummary } from '../../shared/types.js';

/**
 * "Unread only" keeps messages you read in that view on screen until the view changes or is
 * refreshed, so the list doesn't jump under your finger. The server (correctly) stops returning
 * them; this merges them back in where they were.
 *
 * @param previous what was shown last time, in display order
 * @param fresh    the latest server result
 * @param sticky   keys (see `keyOf`) of messages read in this view
 */
export function withSticky(
  previous: readonly MessageSummary[],
  fresh: readonly MessageSummary[],
  sticky: ReadonlySet<string>,
  keyOf: (m: MessageSummary) => string,
): MessageSummary[] {
  if (sticky.size === 0) return [...fresh];
  const freshKeys = new Set(fresh.map(keyOf));
  const result = [...fresh];
  previous.forEach((m, i) => {
    const k = keyOf(m);
    if (!sticky.has(k) || freshKeys.has(k)) return;
    // Insert after the nearest earlier neighbour that is still shown, else at the top.
    let at = 0;
    for (let j = i - 1; j >= 0; j--) {
      const idx = result.findIndex((r) => keyOf(r) === keyOf(previous[j]!));
      if (idx !== -1) {
        at = idx + 1;
        break;
      }
    }
    result.splice(at, 0, { ...m, seen: true });
  });
  return result;
}

/** Keys to remember after an action in an unread-only view. */
export function updateSticky(
  current: ReadonlySet<string>,
  keys: readonly string[],
  action: { type: string; value?: boolean },
): Set<string> {
  const next = new Set(current);
  if (action.type === 'seen' && action.value === true) for (const k of keys) next.add(k);
  // Marked unread again: the server returns it anyway. Moved/deleted: it must really go away.
  else if (action.type === 'seen' || action.type === 'move' || action.type === 'archive' || action.type === 'delete') {
    for (const k of keys) next.delete(k);
  }
  return next;
}
