import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { MessageAction, MessageDetail, MessageRef, MessageSummary } from '../../shared/types';
import { api, ApiError, type MailboxSel } from './api';
import { AccountsDialog } from './components/AccountsDialog';
import { Composer, type ComposerInit } from './components/Composer';
import { Login } from './components/Login';
import { MessageList } from './components/MessageList';
import { Reader, type ReplyKind } from './components/Reader';
import { SettingsDialog } from './components/SettingsDialog';
import { Sidebar } from './components/Sidebar';
import { useAccounts, useFolders, useLiveUpdates, useMe, useMessageAction, useMessages, useTheme, useToasts } from './hooks';
import { blankComposer, composerFor } from './replies';
import { refKey, toRef } from './util';

type MobileView = 'nav' | 'list' | 'reader';

export function App() {
  const qc = useQueryClient();
  const me = useMe();
  const loggedIn = !!me.data;
  const theme = useTheme(me.data?.preferences.theme);
  const accountsQ = useAccounts();
  const accounts = useMemo(() => (loggedIn ? (accountsQ.data ?? []) : []), [accountsQ.data, loggedIn]);
  const accountMap = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  const folders = useFolders(loggedIn && accounts.length > 0);
  const { toasts, push } = useToasts();

  const [sel, setSel] = useState<MailboxSel>({ accountId: null, folder: 'INBOX' });
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<MessageRef | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [composer, setComposer] = useState<ComposerInit | null>(null);
  const [dialog, setDialog] = useState<'accounts' | 'settings' | null>(null);
  const [view, setView] = useState<MobileView>('list');

  // With a single account the unified view is just that account's inbox.
  const effectiveSel = useMemo<MailboxSel>(
    () => (sel.accountId === null && accounts.length === 1 ? { accountId: accounts[0]!.id, folder: 'INBOX' } : sel),
    [sel, accounts],
  );
  const messagesQ = useMessages(effectiveSel, query, loggedIn && accounts.length > 0);
  const messages = useMemo(() => messagesQ.data?.pages.flatMap((p) => p.messages) ?? [], [messagesQ.data]);
  const listErrors = messagesQ.data?.pages.at(-1)?.errors ?? [];

  useLiveUpdates(loggedIn && accounts.length > 0);

  // UIDVALIDITY changed under an open cursor: start the list over.
  useEffect(() => {
    if (messagesQ.data?.pages.some((p) => p.reset)) void qc.resetQueries({ queryKey: ['messages'] });
  }, [messagesQ.data, qc]);

  // First run: open the account dialog.
  useEffect(() => {
    if (loggedIn && accountsQ.isSuccess && accounts.length === 0) setDialog('accounts');
  }, [loggedIn, accountsQ.isSuccess, accounts.length]);

  const runAction = useMessageAction(useCallback((m: string) => push(m, true), [push]));
  const currentFolders = effectiveSel.accountId ? folders.data?.find((f) => f.accountId === effectiveSel.accountId) : undefined;
  const folderInfo = currentFolders?.folders.find((f) => f.path === effectiveSel.folder);
  const isSentLike = folderInfo?.specialUse === 'sent' || folderInfo?.specialUse === 'drafts';

  const title = effectiveSel.accountId
    ? `${folderInfo?.specialUse === 'inbox' ? 'Inbox' : (folderInfo?.name ?? effectiveSel.folder)}${accounts.length > 1 ? ` · ${accountMap.get(effectiveSel.accountId)?.name ?? ''}` : ''}`
    : 'All inboxes';

  const openMessage = (m: MessageSummary) => {
    setOpen(toRef(m));
    setView('reader');
  };

  /** Move the selection to the neighbour of `ref` (after archive/delete or j/k). */
  const neighbour = useCallback(
    (ref: MessageRef, dir: 1 | -1) => {
      const i = messages.findIndex((m) => refKey(m) === refKey(ref));
      return i === -1 ? null : (messages[i + dir] ?? messages[i - dir] ?? null);
    },
    [messages],
  );

  const act = useCallback(
    (refs: MessageRef[], action: MessageAction) => {
      const removes = action.type === 'move' || action.type === 'archive' || action.type === 'delete';
      if (removes && open && refs.some((r) => refKey(r) === refKey(open))) {
        const next = neighbour(open, 1);
        setOpen(next && !refs.some((r) => refKey(r) === refKey(next)) ? toRef(next) : null);
        if (!next) setView('list');
      }
      if (removes) setChecked(new Set());
      void runAction(refs, action);
    },
    [open, neighbour, runAction],
  );

  const reply = useCallback(
    (kind: ReplyKind, d: MessageDetail) => {
      const account = accountMap.get(d.accountId);
      if (account) setComposer(composerFor(kind, d, account));
    },
    [accountMap],
  );

  const compose = () => {
    const account = (effectiveSel.accountId && accountMap.get(effectiveSel.accountId)) || accounts[0];
    if (account) setComposer(blankComposer(account));
  };

  const onStale = useCallback(() => {
    setOpen(null);
    void qc.resetQueries({ queryKey: ['messages'] });
  }, [qc]);

  // Keyboard shortcuts (ignored while typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (composer || dialog || e.metaKey || e.ctrlKey || e.altKey) return;
      if (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) return;
      const cur = open ? messages.find((m) => refKey(m) === refKey(open)) : undefined;
      switch (e.key) {
        case 'j':
        case 'k': {
          const next = open ? neighbour(open, e.key === 'j' ? 1 : -1) : messages[0];
          if (next && (!open || refKey(next) !== refKey(open))) {
            const idx = messages.indexOf(next);
            const curIdx = open ? messages.findIndex((m) => refKey(m) === refKey(open)) : -1;
            if (!open || (e.key === 'j' ? idx > curIdx : idx < curIdx)) setOpen(toRef(next));
          }
          break;
        }
        case 'c':
          compose();
          break;
        case 'e':
          if (open) act([open], { type: 'archive' });
          break;
        case '#':
        case 'Delete':
          if (open) act([open], { type: 'delete' });
          break;
        case 's':
          if (open && cur) act([open], { type: 'flagged', value: !cur.flagged });
          break;
        case 'u':
          if (open) act([open], { type: 'seen', value: false });
          break;
        case 'r':
        case 'a':
        case 'f': {
          if (!open) break;
          const d = qc.getQueryData<MessageDetail>(['message', refKey(open), false]);
          if (d) reply(e.key === 'r' ? 'reply' : e.key === 'a' ? 'replyAll' : 'forward', d);
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
    const { redirect } = await api.logout();
    qc.clear();
    window.location.href = redirect;
  };

  return (
    <div className="app" data-view={view}>
      <Sidebar
        accounts={accounts}
        folders={folders.data}
        sel={effectiveSel}
        onSelect={(s) => {
          setSel(s);
          setQuery('');
          setOpen(null);
          setChecked(new Set());
          setView('list');
        }}
        onCompose={compose}
        onAccounts={() => setDialog('accounts')}
        onSettings={() => setDialog('settings')}
        onLogout={() => void logout()}
        userLabel={me.data!.name || me.data!.email}
      />
      <MessageList
        title={title}
        unified={effectiveSel.accountId === null}
        isSentLike={isSentLike}
        accounts={accountMap}
        folders={folders.data}
        messages={messages}
        loading={messagesQ.isLoading && accounts.length > 0}
        fetchingMore={messagesQ.isFetchingNextPage}
        hasMore={!!messagesQ.hasNextPage}
        errors={listErrors}
        listError={messagesQ.error ? (messagesQ.error as Error).message : null}
        openKey={open ? refKey(open) : null}
        checked={checked}
        query={query}
        onQuery={(q) => {
          setQuery(q);
          setChecked(new Set());
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
        onCheckAll={(on) => setChecked(on ? new Set(messages.map(refKey)) : new Set())}
        onLoadMore={() => void messagesQ.fetchNextPage()}
        onRefresh={() => {
          void qc.invalidateQueries({ queryKey: ['messages'] });
          void qc.invalidateQueries({ queryKey: ['folders'] });
        }}
        onBulk={(action) => act(messages.filter((m) => checked.has(refKey(m))).map(toRef), action)}
        onNav={() => setView('nav')}
      />
      <Reader
        openRef={open}
        account={open ? accountMap.get(open.accountId) : undefined}
        folders={open ? folders.data?.find((f) => f.accountId === open.accountId) : undefined}
        isDrafts={
          !!open &&
          folders.data?.find((f) => f.accountId === open.accountId)?.folders.find((f) => f.path === open.folder)?.specialUse === 'drafts'
        }
        theme={theme}
        markReadOnOpen={me.data!.preferences.markReadOnOpen}
        onAction={act}
        onReply={reply}
        onBack={() => setView('list')}
        onStale={onStale}
      />
      {composer && (
        <Composer
          key={JSON.stringify(composer.answering ?? composer.replaceDraft ?? composer.subject)}
          init={composer}
          accounts={accounts}
          onClose={() => setComposer(null)}
          onToast={push}
          onSent={() => {
            void qc.invalidateQueries({ queryKey: ['messages'] });
            void qc.invalidateQueries({ queryKey: ['folders'] });
          }}
        />
      )}
      {dialog === 'accounts' && <AccountsDialog accounts={accounts} startWithNew={accounts.length === 0} onClose={() => setDialog(null)} />}
      {dialog === 'settings' && <SettingsDialog prefs={me.data!.preferences} onClose={() => setDialog(null)} />}
      <div className="toast-stack">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.error ? 'error' : ''}`}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}
