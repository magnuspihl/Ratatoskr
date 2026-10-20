import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { MessageAction, MessageDetail, MessageRef, MessageSummary } from '../../shared/types';
import { groupConversations, rowOf } from '../../shared/threads';
import { inboxUnread } from '../../shared/unread';
import { api, ApiError, type MailboxSel } from './api';
import { AccountsDialog } from './components/AccountsDialog';
import { Composer, type ComposerInit } from './components/Composer';
import { Login } from './components/Login';
import { MessageList } from './components/MessageList';
import { quotableDetail, Reader, replyTarget, type ReplyKind } from './components/Reader';
import { SettingsDialog } from './components/SettingsDialog';
import { Sidebar } from './components/Sidebar';
import { SquirrelRun, type Run } from './components/SquirrelRun';
import { useAccounts, useFolders, useLiveUpdates, useMe, useMessageAction, useMessages, useTheme, useToasts, type SnoozeEndedEvent } from './hooks';
import { PENDING_MAILTO_KEY, parseMailto } from './mailto';
import { blankComposer, composerFor, composerForMailto } from './replies';
import { useRouter, type Location } from './router';
import { disablePush, notificationTarget, registerServiceWorker, setAppBadge, syncPush } from './push';
import { HOME, listRoute, openMessageFolder, parseLocation, viewKey, type Route } from './routing';
import { updateSticky, withSticky } from './sticky';
import { removesFromList, swipeToAction, type Direction, type UndoStep } from './swipe';
import { formatSnoozeTime } from './snooze';
import { planRun, runFor, runSpeed, type PaneView } from './squirrel';
import { refKey, toRef } from './util';

export function App() {
  const qc = useQueryClient();
  const me = useMe();
  const loggedIn = !!me.data;
  const theme = useTheme(me.data?.preferences.theme);
  const accountsQ = useAccounts();
  const accounts = useMemo(() => (loggedIn ? (accountsQ.data ?? []) : []), [accountsQ.data, loggedIn]);
  const accountMap = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  const folders = useFolders(loggedIn && accounts.length > 0);
  const { toasts, push, dismiss } = useToasts();

  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [composer, setComposer] = useState<ComposerInit | null>(null);
  /** Bumped for every new composer, so it starts fresh even if the previous one looked alike. */
  const [composeId, setComposeId] = useState(0);
  const [lastOpenKey, setLastOpenKey] = useState<string | null>(null);
  const [snoozeSignal, setSnoozeSignal] = useState(0);
  const composerDirty = useRef(false);
  /** Entries pushed while the (non-modal) composer stayed open on top of them. */
  const composeNavs = useRef(0);

  // Browser Back/Forward: close the composer when leaving its entry; ignore stale overlay entries.
  const onPop = useCallback((prev: Location, next: Location) => {
    if (prev.state?.overlay === 'compose' && next.state?.overlay !== 'compose' && composerRef.current) {
      if (composerDirty.current && !window.confirm('Discard this message?')) {
        // Stay: put the compose entry back.
        router.current.reopen('compose');
        return;
      }
      setComposer(null);
    }
    composeNavs.current = Math.max(0, composeNavs.current - 1);
    if (next.state?.overlay === 'compose' && !composerRef.current) router.current.clear();
  }, []);
  const { loc, navigate, openOverlay, closeOverlay, clearOverlay, back } = useRouter(onPop);
  const composerRef = useRef(composer);
  composerRef.current = composer;
  const router = useRef({ reopen: openOverlay, clear: clearOverlay });
  router.current = { reopen: (o) => openOverlay(o), clear: clearOverlay };

  const route = loc.route;
  const overlay = loc.state?.overlay;
  const sel: MailboxSel = useMemo(() => ({ accountId: route.accountId, folder: route.folder }), [route.accountId, route.folder]);
  const query = route.q;
  const open: MessageRef | null = useMemo(
    () => (route.open ? { accountId: route.open.accountId, folder: openMessageFolder(route), uid: route.open.uid, uidValidity: route.open.uidValidity } : null),
    [route],
  );
  const dialog = overlay === 'settings' || overlay === 'accounts' ? overlay : null;
  const view: PaneView = overlay === 'nav' ? 'nav' : open ? 'reader' : 'list';

  useEffect(() => {
    if (open) setLastOpenKey(refKey(open));
  }, [open]);

  // Phone view changes: the squirrel runs across and drags the new view in. Set before paint so
  // the new pane never flashes in unclipped.
  const appRef = useRef<HTMLDivElement>(null);
  const shownView = useRef(view);
  const runId = useRef(0);
  const [run, setRun] = useState<(Run & { from: PaneView }) | null>(null);
  const transitionPref = me.data?.preferences.screenTransitions;
  useLayoutEffect(() => {
    const from = shownView.current;
    shownView.current = view;
    const kind = runFor(from, view);
    if (!kind) return;
    const speed = runSpeed(transitionPref, matchMedia('(max-width: 860px)').matches, matchMedia('(prefers-reduced-motion: reduce)').matches);
    setRun(speed ? { id: ++runId.current, plan: planRun(kind, window.innerWidth, window.innerHeight, speed), from, to: view } : null);
  }, [view, transitionPref]);
  // While running back to the folder, the message stays up underneath rather than the empty reader.
  const lastOpen = useRef(open);
  if (open) lastOpen.current = open;
  const readerRef = open ?? (run?.from === 'reader' ? lastOpen.current : null);

  /** Navigate, keeping a non-modal composer open on top of the new entry. */
  const go = useCallback(
    (r: Route, replace = false) => {
      if (composerRef.current) composeNavs.current++;
      navigate(r, { replace, keepOverlay: !!composerRef.current });
    },
    [navigate],
  );

  // With a single account the unified view is just that account's inbox.
  const effectiveSel = useMemo<MailboxSel>(
    () => (sel.accountId === null && accounts.length === 1 ? { accountId: accounts[0]!.id, folder: 'INBOX' } : sel),
    [sel, accounts],
  );
  const messagesQ = useMessages(effectiveSel, query, route.unread, loggedIn && accounts.length > 0);
  const serverMessages = useMemo(() => messagesQ.data?.pages.flatMap((p) => p.messages) ?? [], [messagesQ.data]);

  // "Unread only": messages read in this view stay listed (dimmed) until the view changes or is
  // refreshed. Both the sticky keys and the last shown list are tied to the current view.
  const currentView = viewKey(route);
  const [sticky, setSticky] = useState<{ view: string; keys: Set<string> }>({ view: '', keys: new Set() });
  const lastShown = useRef<{ view: string; list: MessageSummary[] }>({ view: '', list: [] });
  const messages = useMemo(() => {
    if (!route.unread) return serverMessages;
    const keys = sticky.view === currentView ? sticky.keys : new Set<string>();
    const prev = lastShown.current.view === currentView ? lastShown.current.list : [];
    return withSticky(prev, serverMessages, keys, refKey);
  }, [serverMessages, sticky, currentView, route.unread]);
  useEffect(() => {
    lastShown.current = { view: currentView, list: messages };
  }, [currentView, messages]);
  const listErrors = messagesQ.data?.pages.at(-1)?.errors ?? [];

  const currentFolders = effectiveSel.accountId ? folders.data?.find((f) => f.accountId === effectiveSel.accountId) : undefined;
  const folderInfo = currentFolders?.folders.find((f) => f.path === effectiveSel.folder);
  const isSentLike = folderInfo?.specialUse === 'sent' || folderInfo?.specialUse === 'drafts';
  const inSnoozed = folderInfo?.specialUse === 'snoozed';
  const inDrafts = folderInfo?.specialUse === 'drafts';

  // One row per conversation, Gmail-style, including your replies found in Sent.
  const related = useMemo(() => messagesQ.data?.pages.flatMap((p) => p.related ?? []) ?? [], [messagesQ.data]);
  const rows = useMemo(() => groupConversations(messages, related, { group: !inDrafts }), [messages, related, inDrafts]);
  /** Actions on a conversation apply to all of its messages in the listed folder. */
  const expand = useCallback(
    (refs: MessageRef[]) => {
      const out = new Map<string, MessageRef>();
      for (const r of refs) {
        const row = rowOf(rows, r);
        const list = row && row.members.some((m) => refKey(m) === refKey(r)) ? row.members.map(toRef) : [r];
        for (const m of list) out.set(refKey(m), m);
      }
      return [...out.values()];
    },
    [rows],
  );

  // A snoozed message is back: say so while the app is open (phones get a notification instead).
  const onSnoozeEnded = useCallback(
    (ev: SnoozeEndedEvent) => {
      const text = `Back from snooze: ${ev.subject || '(no subject)'}${ev.from ? ` (${ev.from})` : ''}`;
      const target = ev.uid && ev.uidValidity ? { accountId: ev.accountId, uidValidity: ev.uidValidity, uid: ev.uid } : null;
      push(text, false, target ? { label: 'Open', run: () => go({ ...HOME, open: target }) } : undefined);
    },
    [push, go],
  );
  useLiveUpdates(loggedIn && accounts.length > 0, onSnoozeEnded);

  // Notifications: register the service worker, keep this device's subscription current, and
  // follow taps on a notification while the app is already open.
  useEffect(() => {
    if (!loggedIn) return;
    registerServiceWorker();
    void syncPush().catch(() => {});
    if (!('serviceWorker' in navigator)) return;
    const onMessage = (e: MessageEvent) => {
      const data = e.data as { type?: string; url?: unknown } | null;
      const target = data?.type === 'open' ? notificationTarget(data.url, window.location.origin) : null;
      if (!target) return;
      const u = new URL(target, window.location.origin);
      go(parseLocation(u.pathname, u.search));
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, [loggedIn, go]);

  // Unread count across all inboxes on the app icon (installed app).
  useEffect(() => {
    if (folders.data) setAppBadge(inboxUnread(folders.data));
  }, [folders.data]);

  // Deep link to an account that doesn't exist (any more): back to the unified inbox, quietly.
  useEffect(() => {
    if (accountsQ.isSuccess && route.accountId && !accountMap.has(route.accountId)) {
      navigate(HOME, { replace: true });
      push('That account no longer exists.');
    }
  }, [accountsQ.isSuccess, route.accountId, accountMap, navigate, push]);

  // UIDVALIDITY changed under an open cursor: start the list over.
  useEffect(() => {
    if (messagesQ.data?.pages.some((p) => p.reset)) void qc.resetQueries({ queryKey: ['messages'] });
  }, [messagesQ.data, qc]);

  // First run: open the account dialog.
  useEffect(() => {
    if (loggedIn && accountsQ.isSuccess && accounts.length === 0) openOverlay('accounts');
  }, [loggedIn, accountsQ.isSuccess, accounts.length, openOverlay]);

  const runAction = useMessageAction(useCallback((m: string) => push(m, true), [push]));

  const title = effectiveSel.accountId
    ? `${folderInfo?.specialUse === 'inbox' ? 'Inbox' : (folderInfo?.name ?? effectiveSel.folder)}${accounts.length > 1 ? ` · ${accountMap.get(effectiveSel.accountId)?.name ?? ''}` : ''}`
    : 'All inboxes';

  /** Opening a message pushes an entry; switching to another one while open replaces it. */
  const openMessage = (m: MessageSummary) => {
    go({ ...route, open: { accountId: m.accountId, uidValidity: m.uidValidity, uid: m.uid } }, !!route.open);
  };
  const setOpenRef = (r: MessageRef | null) => go({ ...route, open: r ? { accountId: r.accountId, uidValidity: r.uidValidity, uid: r.uid } : null }, true);

  /** Move the selection to the neighbour of `ref`'s row (after archive/delete or j/k). */
  const rowIndex = useCallback(
    (ref: MessageRef) => {
      const row = rowOf(rows, ref);
      return row ? rows.indexOf(row) : -1;
    },
    [rows],
  );
  const neighbour = useCallback(
    (ref: MessageRef, dir: 1 | -1) => {
      const i = rowIndex(ref);
      return i === -1 ? null : (rows[i + dir] ?? rows[i - dir] ?? null);
    },
    [rows, rowIndex],
  );

  const runUndo = useCallback(
    async (steps: UndoStep[]) => {
      for (const step of steps) await runAction(step.refs, step.action);
      push('Undone');
    },
    [runAction, push],
  );

  const act = useCallback(
    async (picked: MessageRef[], action: MessageAction) => {
      const refs = expand(picked);
      // Snoozing again from the Snoozed folder only changes the time; the message stays.
      const removes = removesFromList(action) && !(action.type === 'snooze' && inSnoozed);
      if (removes && open && refs.some((r) => refKey(r) === refKey(open))) {
        const next = neighbour(open, 1);
        if (next && !refs.some((r) => refKey(r) === refKey(next))) setOpenRef(toRef(next));
        else back(listRoute(route));
      }
      if (removes) setChecked(new Set());
      if (route.unread) {
        const view = viewKey(route);
        setSticky((s) => ({ view, keys: updateSticky(s.view === view ? s.keys : new Set(), refs.map(refKey), action) }));
      }
      const res = await runAction(refs, action);
      if (!res.ok) return;
      const n = picked.length;
      const conversations = refs.length > picked.length;
      const what = n === 1 ? (conversations ? 'Conversation' : 'Message') : `${n} ${conversations ? 'conversations' : 'messages'}`;
      const label =
        action.type === 'archive' ? `${what} archived` : action.type === 'delete' ? (res.result?.permanent ? `${what} deleted permanently` : `${what} moved to Trash`)
          : action.type === 'move' ? `${what} moved to ${action.destination}`
          : action.type === 'snooze' ? `${what} snoozed until ${formatSnoozeTime(action.until)}`
          : action.type === 'unsnooze' ? `${what} back in the inbox` : null;
      for (const f of res.result?.createdFolders ?? []) push(`Created folder "${f}" for ${action.type === 'snooze' ? 'snoozed' : 'archived'} mail.`);
      const undo = res.undo;
      if (label) push(label, false, undo ? { label: 'Undo', run: () => void runUndo(undo) } : undefined);
      else if (undo && picked.length > 1) push(`${what} updated`, false, { label: 'Undo', run: () => void runUndo(undo) });
      return undo;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [open, neighbour, expand, runAction, runUndo, route, back, push, inSnoozed],
  );

  /** Swipe actions: same as toolbar actions, with an undo toast for read/flag toggles too. */
  const prefs = me.data?.preferences;
  const swipeFor = (dir: Direction) => (dir === 'left' ? prefs?.swipeLeft : prefs?.swipeRight) ?? 'none';
  const isTrash = (m: MessageSummary) =>
    folders.data?.find((f) => f.accountId === m.accountId)?.folders.find((f) => f.path === m.folder)?.specialUse === 'trash';
  const onSwipe = async (m: MessageSummary, dir: Direction) => {
    const action = swipeToAction(swipeFor(dir), m);
    if (!action) return;
    const undo = await act([toRef(m)], action);
    if (!removesFromList(action) && undo) {
      const text =
        action.type === 'seen' ? (action.value ? 'Marked as read' : 'Marked as unread') : action.type === 'flagged' ? (action.value ? 'Flagged' : 'Unflagged') : 'Done';
      push(text, false, { label: 'Undo', run: () => void runUndo(undo) });
    }
  };


  const startCompose = useCallback(
    (init: ComposerInit) => {
      setComposer(init);
      setComposeId((n) => n + 1);
      composerDirty.current = false;
      composeNavs.current = 0;
      openOverlay('compose');
    },
    [openOverlay],
  );
  const compose = () => {
    const account = (effectiveSel.accountId && accountMap.get(effectiveSel.accountId)) || accounts[0];
    if (account) startCompose(blankComposer(account));
  };
  /** Compose from a mailto: link, from the current account (or the first one). */
  const composeMailto = useCallback(
    (mailto: string) => {
      const fields = parseMailto(mailto);
      const account = (effectiveSel.accountId && accountMap.get(effectiveSel.accountId)) || accounts[0];
      if (!fields || !account) return;
      if (composerRef.current && composerDirty.current && !window.confirm('Discard the message you are writing?')) return;
      startCompose(composerForMailto(fields, account));
    },
    [effectiveSel.accountId, accountMap, accounts, startCompose],
  );
  // Opened for a mailto: link (see main.tsx): compose once signed in and there is an account.
  useEffect(() => {
    if (!loggedIn || !accountsQ.isSuccess || accounts.length === 0) return;
    const pending = sessionStorage.getItem(PENDING_MAILTO_KEY);
    if (!pending) return;
    sessionStorage.removeItem(PENDING_MAILTO_KEY);
    composeMailto(pending);
  }, [loggedIn, accountsQ.isSuccess, accounts.length, composeMailto]);
  const reply = useCallback(
    (kind: ReplyKind, d: MessageDetail) => {
      const account = accountMap.get(d.accountId);
      if (account) startCompose(composerFor(kind, d, account));
    },
    [accountMap, startCompose],
  );

  /** Close the composer from its own UI without leaving a dead history entry. */
  const closeComposer = () => {
    setComposer(null);
    if (overlay === 'compose') {
      if (composeNavs.current === 0) closeOverlay('compose');
      else clearOverlay();
    }
  };

  // The open message is gone (deleted elsewhere) or its folder's UIDVALIDITY changed: fall back to
  // the list with a quiet notice.
  const onGone = useCallback(
    (stale: boolean) => {
      navigate(listRoute(route), { replace: true, keepOverlay: true });
      push(stale ? 'This folder changed on the server; the list was reloaded.' : 'That message is no longer available.');
      if (stale) void qc.resetQueries({ queryKey: ['messages'] });
    },
    [navigate, route, push, qc],
  );

  // Keyboard shortcuts (ignored while typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (composer || dialog || e.metaKey || e.ctrlKey || e.altKey) return;
      if (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) return;
      const cur = open ? rowOf(rows, open) : undefined;
      switch (e.key) {
        case 'j':
        case 'k': {
          const next = open ? neighbour(open, e.key === 'j' ? 1 : -1) : rows[0];
          if (next && (!open || next !== cur)) {
            const idx = rows.indexOf(next);
            const curIdx = open ? rowIndex(open) : -1;
            if (!open || (e.key === 'j' ? idx > curIdx : idx < curIdx)) {
              if (open) setOpenRef(toRef(next));
              else openMessage(next);
            }
          }
          break;
        }
        case 'c':
          compose();
          break;
        case 'e':
          if (open) void act([open], { type: 'archive' });
          break;
        case 'b':
          if (open) setSnoozeSignal((n) => n + 1);
          break;
        case '#':
        case 'Delete':
          if (open) void act([open], { type: 'delete' });
          break;
        case 's':
          if (open && cur) void act([open], { type: 'flagged', value: !cur.flagged });
          break;
        case 'u':
          if (open) void act([open], { type: 'seen', value: false });
          break;
        case 'r':
        case 'a':
        case 'f': {
          if (!open) break;
          const d = qc.getQueryData<MessageDetail>(['message', refKey(replyTarget(cur, open)), 'auto']);
          const kind = e.key === 'r' ? 'reply' : e.key === 'a' ? 'replyAll' : 'forward';
          if (d) void quotableDetail(qc, d).then((quoted) => reply(kind, quoted), (err: Error) => push(err.message, true));
          break;
        }
        case 'Escape':
          setChecked(new Set());
          break;
        default:
          return;
      }
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (me.isLoading) {
    return (
      <div className="center">
        <div className="spinner" />
      </div>
    );
  }
  if (me.error) {
    if (me.error instanceof ApiError && me.error.status === 401) return <Login />;
    return <div className="center error-text">Could not reach the server: {(me.error as Error).message}</div>;
  }

  const logout = async () => {
    // Stop this device's notifications along with the session.
    await disablePush().catch(() => {});
    setAppBadge(0);
    const { redirect } = await api.logout();
    qc.clear();
    window.location.href = redirect;
  };

  return (
    <div className="app" data-view={view} ref={appRef} data-run={run?.plan.kind} data-leaving={run?.from}>
      <Sidebar
        accounts={accounts}
        folders={folders.data}
        sel={effectiveSel}
        onSelect={(s) => {
          setChecked(new Set());
          // From the phone drawer, the folder replaces the drawer entry: Back then returns to the
          // previous folder rather than reopening the drawer.
          const r: Route = { accountId: s.accountId, folder: s.folder, q: '', unread: false, open: null };
          if (overlay === 'nav') navigate(r, { replace: true });
          else go(r);
        }}
        onCompose={compose}
        onAccounts={() => openOverlay('accounts')}
        onSettings={() => openOverlay('settings')}
        onLogout={() => void logout()}
        userLabel={me.data!.name || me.data!.email}
        onCloseNav={() => closeOverlay('nav')}
      />
      <MessageList
        title={title}
        unified={effectiveSel.accountId === null}
        isSentLike={isSentLike}
        accounts={accountMap}
        folders={folders.data}
        messages={rows}
        loading={messagesQ.isLoading && accounts.length > 0}
        fetchingMore={messagesQ.isFetchingNextPage}
        hasMore={!!messagesQ.hasNextPage}
        errors={listErrors}
        listError={messagesQ.error ? (messagesQ.error as Error).message : null}
        openKey={open ? refKey(open) : null}
        checked={checked}
        query={query}
        onQuery={(q) => {
          if (q === route.q) return;
          setChecked(new Set());
          go({ ...route, q, open: null });
        }}
        onOpen={openMessage}
        onCheck={(m, on) =>
          setChecked((c) => {
            const n = new Set(c);
            if (on) n.add(refKey(m));
            else n.delete(refKey(m));
            return n;
          })
        }
        onCheckAll={(on) => setChecked(on ? new Set(rows.map(refKey)) : new Set())}
        onLoadMore={() => void messagesQ.fetchNextPage()}
        unreadOnly={route.unread}
        onUnreadOnly={(on) => {
          setChecked(new Set());
          go({ ...route, unread: on, open: null });
        }}
        onRefresh={() => {
          // An explicit refresh also lets read messages leave the unread-only list.
          setSticky({ view: '', keys: new Set() });
          api.requestFresh();
          void qc.invalidateQueries({ queryKey: ['messages'] });
          void qc.invalidateQueries({ queryKey: ['folders'] });
        }}
        onBulk={(action) => void act(rows.filter((m) => checked.has(refKey(m))).map(toRef), action)}
        onNav={() => openOverlay('nav')}
        lastOpenKey={lastOpenKey}
        swipeLeft={prefs?.swipeLeft ?? 'none'}
        swipeRight={prefs?.swipeRight ?? 'none'}
        swipeRemoves={(m, d) => {
          const a = swipeToAction(swipeFor(d), m);
          return !!a && removesFromList(a);
        }}
        confirmSwipe={(m, d) => swipeFor(d) !== 'delete' || !isTrash(m) || window.confirm('Delete this message permanently?')}
        onSwipe={(m, d) => void onSwipe(m, d)}
      />
      <Reader
        openRef={readerRef}
        conversation={readerRef ? rowOf(rows, readerRef) : undefined}
        account={readerRef ? accountMap.get(readerRef.accountId) : undefined}
        multipleAccounts={accounts.length > 1}
        folders={readerRef ? folders.data?.find((f) => f.accountId === readerRef.accountId) : undefined}
        isDrafts={
          !!readerRef &&
          folders.data?.find((f) => f.accountId === readerRef.accountId)?.folders.find((f) => f.path === readerRef.folder)?.specialUse === 'drafts'
        }
        theme={theme}
        markReadOnOpen={me.data!.preferences.markReadOnOpen}
        contactPhotos={me.data!.preferences.contactPhotos}
        onAction={(refs, a) => void act(refs, a)}
        snoozeSignal={snoozeSignal}
        onReply={reply}
        onMailto={composeMailto}
        onBack={() => back(listRoute(route))}
        onGone={open ? onGone : () => {}}
      />
      {composer && (
        <Composer
          key={composeId}
          init={composer}
          accounts={accounts}
          onClose={closeComposer}
          dirtyRef={composerDirty}
          onToast={push}
          onSent={() => {
            void qc.invalidateQueries({ queryKey: ['messages'] });
            void qc.invalidateQueries({ queryKey: ['folders'] });
          }}
        />
      )}
      {dialog === 'accounts' && <AccountsDialog accounts={accounts} defaults={me.data!.accountDefaults} startWithNew={accounts.length === 0} onClose={() => closeOverlay('accounts')} />}
      {dialog === 'settings' && <SettingsDialog prefs={me.data!.preferences} hasPassword={me.data!.hasPassword} onClose={() => closeOverlay('settings')} />}
      {run && <SquirrelRun key={run.id} run={run} appRef={appRef} onDone={() => setRun(null)} />}
      <div className="toast-stack" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.error ? 'error' : ''}`}>
            <span>{t.text}</span>
            {t.action && (
              <button
                onClick={() => {
                  dismiss(t.id);
                  t.action!.run();
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
