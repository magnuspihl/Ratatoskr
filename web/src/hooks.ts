import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClientEvent, MessageAction, MessageRef, MessageSummary, Preferences, ServerEvent } from '../../shared/types';
import { api, type MailboxSel } from './api';
import { actionsPending, runMessageAction, updateMessageLists, type ActionOutcome } from './messageActions';
import { applyThemeColor } from './themeColor';

export const useMe = () => useQuery({ queryKey: ['me'], queryFn: api.me, retry: false, staleTime: Infinity });
export const useAccounts = () => useQuery({ queryKey: ['accounts'], queryFn: api.accounts, staleTime: 60_000 });
export const useFolders = (enabled: boolean) =>
  useQuery({ queryKey: ['folders'], queryFn: api.folders, enabled, staleTime: 30_000, refetchInterval: 120_000 });

export function useMessages(sel: MailboxSel, q: string, unread: boolean, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: ['messages', sel.accountId, sel.accountId ? sel.folder : '', q, unread],
    queryFn: ({ pageParam }) => api.messages(sel, pageParam, q, unread),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.cursor,
    enabled,
    staleTime: 20_000,
    // INBOX changes arrive via IDLE; this also catches changes in other folders.
    refetchInterval: 120_000,
  });
}

/** Apply a transformation to every cached message list (optimistic updates). */
export function useMessageCache() {
  const qc = useQueryClient();
  return useCallback((fn: (m: MessageSummary) => MessageSummary | null) => updateMessageLists(qc, fn), [qc]);
}

/**
 * Run a message action with an optimistic cache update and a refetch afterwards. Resolves with a
 * plan to undo it (null if it failed or can't be undone). See messageActions.ts.
 */
export function useMessageAction(onError: (msg: string) => void) {
  const qc = useQueryClient();
  return useCallback(
    (refs: MessageRef[], action: MessageAction): Promise<ActionOutcome> => runMessageAction(qc, refs, action, { send: api.action, onError }),
    [qc, onError],
  );
}

/** In front of the user right now: phone notifications are held back while this is true. */
const isActive = () => document.visibilityState === 'visible' && document.hasFocus();

export type SnoozeEndedEvent = Extract<ServerEvent, { type: 'snoozeEnded' }>;

/** One WebSocket per browser session; reconnects with backoff. Reports presence to the server. */
export function useLiveUpdates(enabled: boolean, onSnoozeEnded?: (ev: SnoozeEndedEvent) => void) {
  const qc = useQueryClient();
  const timer = useRef<number | null>(null);
  const snoozeEnded = useRef(onSnoozeEnded);
  snoozeEnded.current = onSnoozeEnded;
  useEffect(() => {
    if (!enabled) return;
    let ws: WebSocket | null = null;
    let stopped = false;
    let backoff = 1000;
    let retry: number | null = null;
    const refresh = () => {
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        // While actions are under way the last one to finish refetches; a list fetched now could
        // still show what they are removing.
        if (!actionsPending(qc)) void qc.invalidateQueries({ queryKey: ['messages'] });
        void qc.invalidateQueries({ queryKey: ['folders'] });
      }, 400);
    };
    const sendPresence = () => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'presence', active: isActive() } satisfies ClientEvent));
    };
    const presenceEvents = ['visibilitychange', 'focus', 'blur'] as const;
    for (const ev of presenceEvents) window.addEventListener(ev, sendPresence);
    const connect = () => {
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws`);
      ws.onopen = () => {
        backoff = 1000;
        sendPresence();
      };
      ws.onmessage = (e) => {
        const ev = JSON.parse(String(e.data)) as ServerEvent;
        if (ev.type === 'reset') void qc.resetQueries({ queryKey: ['messages'] });
        else if (ev.type === 'mailbox') refresh();
        else if (ev.type === 'snoozeEnded') snoozeEnded.current?.(ev);
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
      for (const ev of presenceEvents) window.removeEventListener(ev, sendPresence);
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
  useEffect(() => applyThemeColor(document, theme), [theme]);
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
