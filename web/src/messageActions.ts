import type { InfiniteData, QueryClient } from '@tanstack/react-query';
import type { ActionResult, ListResponse, MessageAction, MessageDetail, MessageRef, MessageSummary } from '../../shared/types';
import { undoPlan, type UndoStep } from './swipe';
import { refKey } from './util';

/**
 * Message actions with optimistic updates, kept free of React so they can be unit tested.
 *
 * Several actions can be under way at once (deleting two messages in quick succession). A message
 * list fetched while one of them is still running can predate it: the server may answer the list
 * before it has carried the action out. Such a reply would overwrite the optimistic change and show
 * the message again until the next refresh. So, as TanStack Query recommends for optimistic updates,
 * an action first cancels list requests in flight, and lists are only fetched again once the last
 * running action has finished; until then, refreshes are held back (see `actionsPending`).
 */

export type MessagesData = InfiniteData<ListResponse, string | null>;

/** Actions sent to the server and not answered yet, per query client. */
const pending = new WeakMap<QueryClient, number>();

/** True while message actions are under way: message lists must not be refetched meanwhile. */
export const actionsPending = (qc: QueryClient) => (pending.get(qc) ?? 0) > 0;

/** Apply a transformation to every cached message list (null removes the message). */
export function updateMessageLists(qc: QueryClient, fn: (m: MessageSummary) => MessageSummary | null) {
  qc.setQueriesData<MessagesData>({ queryKey: ['messages'] }, (data) =>
    data
      ? {
          ...data,
          pages: data.pages.map((p) => ({
            ...p,
            messages: p.messages.map(fn).filter((m): m is MessageSummary => m !== null),
            related: (p.related ?? []).map(fn).filter((m): m is MessageSummary => m !== null),
          })),
        }
      : data,
  );
}

export interface ActionOutcome {
  ok: boolean;
  result: ActionResult | null;
  undo: UndoStep[] | null;
}

/**
 * Run a message action with an optimistic update and a refetch afterwards. Resolves with a plan to
 * undo it (null if it failed or can't be undone).
 */
export async function runMessageAction(
  qc: QueryClient,
  refs: MessageRef[],
  action: MessageAction,
  deps: { send: (refs: MessageRef[], action: MessageAction) => Promise<ActionResult>; onError: (msg: string) => void },
): Promise<ActionOutcome> {
  if (refs.length === 0) return { ok: true, result: null, undo: null };
  const keys = new Set(refs.map(refKey));
  const hit = (m: MessageSummary) => keys.has(refKey(m));

  pending.set(qc, (pending.get(qc) ?? 0) + 1);
  try {
    // A list on its way may predate this action; drop it rather than let it undo the change below.
    await qc.cancelQueries({ queryKey: ['messages'] });

    // Previous flag values, so read/flag changes can be undone exactly.
    const before = new Map<string, MessageSummary>();
    for (const [, data] of qc.getQueriesData<MessagesData>({ queryKey: ['messages'] })) {
      for (const p of data?.pages ?? []) for (const m of [...p.messages, ...(p.related ?? [])]) if (hit(m)) before.set(refKey(m), m);
    }

    if (action.type === 'seen' || action.type === 'flagged') {
      const field = action.type;
      updateMessageLists(qc, (m) => (hit(m) ? { ...m, [field]: action.value } : m));
      // Keep open message details in sync as well.
      qc.setQueriesData<MessageDetail>({ queryKey: ['message'] }, (d) => (d && keys.has(refKey(d)) ? { ...d, [field]: action.value } : d));
    } else if (action.type === 'snooze') {
      // Already snoozed (in the Snoozed folder): only the time changes. Anything else leaves the list.
      updateMessageLists(qc, (m) => (hit(m) ? (m.snoozedUntil ? { ...m, snoozedUntil: action.until } : null) : m));
      qc.setQueriesData<MessageDetail>({ queryKey: ['message'] }, (d) =>
        d && keys.has(refKey(d)) && d.snoozedUntil ? { ...d, snoozedUntil: action.until } : d,
      );
    } else updateMessageLists(qc, (m) => (hit(m) ? null : m));

    const result = await deps.send(refs, action);
    const undo = undoPlan(action, refs, result, (r) => {
      const m = before.get(refKey(r));
      if (!m) return undefined;
      return action.type === 'seen' ? m.seen : action.type === 'flagged' ? m.flagged : undefined;
    });
    return { ok: true, result, undo };
  } catch (err) {
    deps.onError((err as Error).message);
    return { ok: false, result: null, undo: null };
  } finally {
    const left = (pending.get(qc) ?? 1) - 1;
    pending.set(qc, left);
    // Only the last action refetches: earlier ones would fetch lists the later ones then undo.
    if (left === 0) void qc.invalidateQueries({ queryKey: ['messages'] });
    void qc.invalidateQueries({ queryKey: ['folders'] });
  }
}
