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
 *
 * Not every refetch can be held back (the window regaining focus, the periodic refresh, loading the
 * next page), so every change is also remembered until the server has carried it out: a list
 * requested before then gets it applied on arrival (see `fetchMessageList`). Only lists requested
 * after the action finished are taken as they are.
 */

export type MessagesData = InfiniteData<ListResponse, string | null>;

/** Actions sent to the server and not answered yet, per query client. */
const pending = new WeakMap<QueryClient, number>();

/** True while message actions are under way: message lists must not be refetched meanwhile. */
export const actionsPending = (qc: QueryClient) => (pending.get(qc) ?? 0) > 0;

/** How long a finished change is remembered: long enough for any list requested before it to arrive. */
const KEEP_MS = 60_000;

interface Change {
  /** The action that made it (a later action on the same message replaces it). */
  action: number;
  apply: (m: MessageSummary) => MessageSummary | null;
  /** `requests` when the action finished; null while it runs. */
  doneAt: number | null;
  finishedAt: number;
}

/** Optimistic changes not yet known to be in every list the server sends, per query client. */
interface Changes {
  /** Counts list requests and actions, to tell which happened first. */
  requests: number;
  actions: number;
  byKey: Map<string, Change>;
}
const changes = new WeakMap<QueryClient, Changes>();

function changesOf(qc: QueryClient): Changes {
  let c = changes.get(qc);
  if (!c) changes.set(qc, (c = { requests: 0, actions: 0, byKey: new Map() }));
  return c;
}

const applyAll = (list: MessageSummary[], fn: (m: MessageSummary) => MessageSummary | null) =>
  list.map(fn).filter((m): m is MessageSummary => m !== null);

/**
 * Fetch a page of a message list. If message actions were under way when it was requested, the
 * server may have answered before carrying them out, so their changes are applied to it.
 */
export async function fetchMessageList(qc: QueryClient, load: () => Promise<ListResponse>): Promise<ListResponse> {
  const c = changesOf(qc);
  const requested = ++c.requests;
  const page = await load();
  const now = Date.now();
  for (const [k, ch] of c.byKey) if (ch.doneAt !== null && now - ch.finishedAt > KEEP_MS) c.byKey.delete(k);
  const stale = (m: MessageSummary) => {
    const ch = c.byKey.get(refKey(m));
    return ch && (ch.doneAt === null || requested <= ch.doneAt) ? ch : null;
  };
  const fix = (m: MessageSummary) => {
    const ch = stale(m);
    return ch ? ch.apply(m) : m;
  };
  if (![...page.messages, ...(page.related ?? [])].some(stale)) return page;
  return { ...page, messages: applyAll(page.messages, fix), related: applyAll(page.related ?? [], fix) };
}

/** Apply a transformation to every cached message list (null removes the message). */
export function updateMessageLists(qc: QueryClient, fn: (m: MessageSummary) => MessageSummary | null) {
  qc.setQueriesData<MessagesData>({ queryKey: ['messages'] }, (data) =>
    data
      ? {
          ...data,
          pages: data.pages.map((p) => ({
            ...p,
            messages: applyAll(p.messages, fn),
            related: applyAll(p.related ?? [], fn),
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

  // The change to every affected message, as shown until the server's lists include it.
  const change: (m: MessageSummary) => MessageSummary | null =
    action.type === 'seen' || action.type === 'flagged'
      ? (m) => ({ ...m, [action.type]: action.value })
      : action.type === 'snooze'
        ? // Already snoozed (in the Snoozed folder): only the time changes. Anything else leaves the list.
          (m) => (m.snoozedUntil ? { ...m, snoozedUntil: action.until } : null)
        : () => null;
  const remembered = changesOf(qc);
  const id = ++remembered.actions;
  for (const k of keys) remembered.byKey.set(k, { action: id, apply: change, doneAt: null, finishedAt: 0 });
  let failed = false;

  pending.set(qc, (pending.get(qc) ?? 0) + 1);
  try {
    // A list on its way may predate this action; drop it rather than let it undo the change below.
    await qc.cancelQueries({ queryKey: ['messages'] });

    // Previous flag values, so read/flag changes can be undone exactly.
    const before = new Map<string, MessageSummary>();
    for (const [, data] of qc.getQueriesData<MessagesData>({ queryKey: ['messages'] })) {
      for (const p of data?.pages ?? []) for (const m of [...p.messages, ...(p.related ?? [])]) if (hit(m)) before.set(refKey(m), m);
    }

    updateMessageLists(qc, (m) => (hit(m) ? change(m) : m));
    // Keep open message details in sync as well.
    if (action.type === 'seen' || action.type === 'flagged') {
      const field = action.type;
      qc.setQueriesData<MessageDetail>({ queryKey: ['message'] }, (d) => (d && keys.has(refKey(d)) ? { ...d, [field]: action.value } : d));
    } else if (action.type === 'snooze') {
      qc.setQueriesData<MessageDetail>({ queryKey: ['message'] }, (d) =>
        d && keys.has(refKey(d)) && d.snoozedUntil ? { ...d, snoozedUntil: action.until } : d,
      );
    }

    const result = await deps.send(refs, action);
    const undo = undoPlan(action, refs, result, (r) => {
      const m = before.get(refKey(r));
      if (!m) return undefined;
      return action.type === 'seen' ? m.seen : action.type === 'flagged' ? m.flagged : undefined;
    });
    return { ok: true, result, undo };
  } catch (err) {
    failed = true;
    deps.onError((err as Error).message);
    return { ok: false, result: null, undo: null };
  } finally {
    // Done: lists requested from now on show what really happened (also when it failed).
    for (const k of keys) {
      const ch = remembered.byKey.get(k);
      if (ch?.action !== id) continue;
      if (failed) remembered.byKey.delete(k);
      else Object.assign(ch, { doneAt: remembered.requests, finishedAt: Date.now() });
    }
    const left = (pending.get(qc) ?? 1) - 1;
    pending.set(qc, left);
    // Only the last action refetches: earlier ones would fetch lists the later ones then undo.
    if (left === 0) void qc.invalidateQueries({ queryKey: ['messages'] });
    void qc.invalidateQueries({ queryKey: ['folders'] });
  }
}
