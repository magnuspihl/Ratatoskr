import { useInfiniteQuery, useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ActionResult, ListResponse, MessageAction, MessageDetail, MessageRef, MessageSummary, Preferences, ServerEvent } from '../../shared/types';
import { undoPlan, type UndoStep } from './swipe';
import { api, type MailboxSel } from './api';
import { refKey } from './util';

export const useMe = () => useQuery({ queryKey: ['me'], queryFn: api.me, retry: false, staleTime: Infinity });
export const useAccounts = () => useQuery({ queryKey: ['accounts'], queryFn: api.accounts, staleTime: 60_000 });
export const useFolders = (enabled: boolean) =>
  useQuery({ queryKey: ['folders'], queryFn: api.folders, enabled, staleTime: 30_000, refetchInterval: 120_000 });

export function useMessages(sel: MailboxSel, q: string, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: ['messages', sel.accountId, sel.accountId ? sel.folder : '', q],
    queryFn: ({ pageParam }) => api.messages(sel, pageParam, q),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.cursor,
    enabled,
    staleTime: 20_000,
    // INBOX changes arrive via IDLE; this also catches changes in other folders.
    refetchInterval: 120_000,
  });
}

type MessagesData = InfiniteData<ListResponse, string | null>;

/** Apply a transformation to every cached message list (optimistic updates). */
export function useMessageCache() {
  const qc = useQueryClient();
  return useCallback(
    (fn: (m: MessageSummary) => MessageSummary | null) => {
      qc.setQueriesData<MessagesData>({ queryKey: ['messages'] }, (data) =>
        data
          ? {
              ...data,
              pages: data.pages.map((p) => ({
                ...p,
                messages: p.messages.map(fn).filter((m): m is MessageSummary => m !== null),
              })),
            }
          : data,
      );
    },
    [qc],
  );
}

/**
 * Run a message action with an optimistic cache update and a refetch afterwards. Resolves with a
 * plan to undo it (null if it failed or can't be undone).
 */
export function useMessageAction(onError: (msg: string) => void) {
  const qc = useQueryClient();
  const update = useMessageCache();
  return useCallback(
    async (refs: MessageRef[], action: MessageAction): Promise<{ ok: boolean; result: ActionResult | null; undo: UndoStep[] | null }> => {
      if (refs.length === 0) return { ok: true, result: null, undo: null };
      const keys = new Set(refs.map(refKey));
      const hit = (m: MessageSummary) => keys.has(refKey(m));

      // Previous flag values, so read/flag changes can be undone exactly.
      const before = new Map<string, MessageSummary>();
      for (const [, data] of qc.getQueriesData<MessagesData>({ queryKey: ['messages'] })) {
        for (const p of data?.pages ?? []) for (const m of p.messages) if (hit(m)) before.set(refKey(m), m);
      }

      if (action.type === 'seen' || action.type === 'flagged') {
        const field = action.type;
        update((m) => (hit(m) ? { ...m, [field]: action.value } : m));
        // Keep open message details in sync as well.
        qc.setQueriesData<MessageDetail>({ queryKey: ['message'] }, (d) =>
          d && keys.has(refKey(d)) ? { ...d, [field]: action.value } : d,
        );
      } else update((m) => (hit(m) ? null : m));
      try {
        const result = await api.action(refs, action);
        const undo = undoPlan(action, refs, result, (r) => {
          const m = before.get(refKey(r));
          if (!m) return undefined;
          return action.type === 'seen' ? m.seen : action.type === 'flagged' ? m.flagged : undefined;
        });
        return { ok: true, result, undo };
      } catch (err) {
        onError((err as Error).message);
        return { ok: false, result: null, undo: null };
      } finally {
        void qc.invalidateQueries({ queryKey: ['messages'] });
        void qc.invalidateQueries({ queryKey: ['folders'] });
      }
    },
    [qc, update, onError],
  );
}

/** One WebSocket per browser session; reconnects with backoff. */
export function useLiveUpdates(enabled: boolean) {
  const qc = useQueryClient();
  const timer = useRef<number | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let ws: WebSocket | null = null;
    let stopped = false;
    let backoff = 1000;
    let retry: number | null = null;
    const refresh = () => {
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        void qc.invalidateQueries({ queryKey: ['messages'] });
        void qc.invalidateQueries({ queryKey: ['folders'] });
      }, 400);
    };
    const connect = () => {
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws`);
      ws.onopen = () => {
        backoff = 1000;
      };
      ws.onmessage = (e) => {
        const ev = JSON.parse(String(e.data)) as ServerEvent;
        if (ev.type === 'reset') void qc.resetQueries({ queryKey: ['messages'] });
        else if (ev.type === 'mailbox') refresh();
      };
      ws.onclose = (e) => {
        if (stopped || e.code === 4401) return;
        retry = window.setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 60_000);
      };
    };
    connect();
    return () => {
      stopped = true;
      if (retry) window.clearTimeout(retry);
      ws?.close();
    };
  }, [enabled, qc]);
}

export type ResolvedTheme = 'light' | 'dark';

export function useTheme(pref: Preferences['theme'] | undefined): ResolvedTheme {
  const [system, setSystem] = useState<ResolvedTheme>(() =>
    window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
  );
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const on = () => setSystem(mq.matches ? 'dark' : 'light');
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  const theme = !pref || pref === 'system' ? system : pref;
  // Applied during render (idempotent) so children that read CSS variables, such as the message
  // iframe palette, already see the new theme in the same render.
  if (document.documentElement.dataset.theme !== theme) document.documentElement.dataset.theme = theme;
  return theme;
}

export interface Toast {
  id: number;
  text: string;
  error: boolean;
  action?: { label: string; run: () => void };
}

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const push = useCallback(
    (text: string, error = false, action?: Toast['action']) => {
      const id = Date.now() + Math.random();
      setToasts((t) => [...t.slice(-3), { id, text, error, action }]);
      window.setTimeout(() => dismiss(id), action ? 7000 : error ? 6000 : 3500);
    },
    [dismiss],
  );
  return { toasts, push, dismiss };
}
