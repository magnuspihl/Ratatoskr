import { useInfiniteQuery, useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ListResponse, MessageAction, MessageRef, MessageSummary, Preferences, ServerEvent } from '../../shared/types';
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

/** Run a message action with an optimistic cache update and a refetch afterwards. */
export function useMessageAction(onError: (msg: string) => void) {
  const qc = useQueryClient();
  const update = useMessageCache();
  return useCallback(
    async (refs: MessageRef[], action: MessageAction) => {
      if (refs.length === 0) return;
      const keys = new Set(refs.map(refKey));
      const hit = (m: MessageSummary) => keys.has(refKey(m));
      if (action.type === 'seen') update((m) => (hit(m) ? { ...m, seen: action.value } : m));
      else if (action.type === 'flagged') update((m) => (hit(m) ? { ...m, flagged: action.value } : m));
      else update((m) => (hit(m) ? null : m));
      try {
        await api.action(refs, action);
      } catch (err) {
        onError((err as Error).message);
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
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  return theme;
}

export function useToasts() {
  const [toasts, setToasts] = useState<{ id: number; text: string; error: boolean }[]>([]);
  const push = useCallback((text: string, error = false) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, error }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), error ? 6000 : 3500);
  }, []);
  return { toasts, push };
}
