import { AlarmClock, Archive, Flag, FolderInput, Mail, MailCheck, MailOpen, Menu, Paperclip, RefreshCw, Search, Star, Trash2, X, Reply } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { AccountFolders, AccountView, MessageAction, MessageSummary, SwipeAction } from '../../../shared/types';
import type { Direction } from '../swipe';
import { SwipeRow } from './SwipeRow';
import { displayName, formatListDate, refKey } from '../util';
import { MoveMenu } from './MoveMenu';
import { SnoozeMenu } from './SnoozeMenu';
import { formatSnoozeTime } from '../snooze';

interface Props {
  title: string;
  unified: boolean;
  isSentLike: boolean;
  accounts: Map<string, AccountView>;
  folders: AccountFolders[] | undefined;
  messages: MessageSummary[];
  loading: boolean;
  fetchingMore: boolean;
  hasMore: boolean;
  errors: { accountId: string; error: string }[];
  listError: string | null;
  openKey: string | null;
  checked: Set<string>;
  query: string;
  onQuery: (q: string) => void;
  onOpen: (m: MessageSummary) => void;
  onCheck: (m: MessageSummary, on: boolean) => void;
  onCheckAll: (on: boolean) => void;
  onLoadMore: () => void;
  onRefresh: () => void;
  onBulk: (action: MessageAction) => void;
  onNav: () => void;
  lastOpenKey: string | null;
  /** Server-side "unread only" filter for this view. */
  unreadOnly: boolean;
  onUnreadOnly: (on: boolean) => void;
  swipeLeft: SwipeAction;
  swipeRight: SwipeAction;
  swipeRemoves: (m: MessageSummary, dir: Direction) => boolean;
  confirmSwipe: (m: MessageSummary, dir: Direction) => boolean;
  onSwipe: (m: MessageSummary, dir: Direction) => void;
}

export function MessageList(p: Props) {
  const [q, setQ] = useState(p.query);
  const sentinel = useRef<HTMLDivElement>(null);
  const { hasMore, fetchingMore, onLoadMore } = p;

  useEffect(() => setQ(p.query), [p.query]);

  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && hasMore && !fetchingMore) onLoadMore();
    });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, fetchingMore, onLoadMore]);

  const checkedMsgs = p.messages.filter((m) => p.checked.has(refKey(m)));
  const sameAccount = checkedMsgs.length > 0 && checkedMsgs.every((m) => m.accountId === checkedMsgs[0]!.accountId);
  const anyUnread = checkedMsgs.some((m) => !m.seen);
  const anyUnflagged = checkedMsgs.some((m) => !m.flagged);

  return (
    <section className="pane list">
      <div className="list-header">
        <div className="list-title">
          <button className="icon-btn mobile-only" onClick={p.onNav} title="Folders">
            <Menu size={18} />
          </button>
          <h1>{p.title}</h1>
          <button className="icon-btn" onClick={p.onRefresh} title="Refresh">
            <RefreshCw size={16} />
          </button>
        </div>
        <form
          className="search"
          onSubmit={(e) => {
            e.preventDefault();
            p.onQuery(q.trim());
          }}
        >
          <Search size={15} />
          <input
            className="input"
            placeholder={p.unified ? 'Search all inboxes' : 'Search this folder'}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              if (!e.target.value) p.onQuery('');
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setQ('');
                p.onQuery('');
              }
            }}
          />
        </form>
        <label className="check unread-toggle">
          <input type="checkbox" checked={p.unreadOnly} onChange={(e) => p.onUnreadOnly(e.target.checked)} />
          Unread only
        </label>
      </div>

      {checkedMsgs.length > 0 && (
        <div className="bulk-bar">
          <input
            type="checkbox"
            checked={checkedMsgs.length === p.messages.length}
            onChange={(e) => p.onCheckAll(e.target.checked)}
            title="Select all"
            style={{ accentColor: 'var(--accent)' }}
          />
          <span className="count">{checkedMsgs.length} selected</span>
          <button className="icon-btn" title={anyUnread ? 'Mark read' : 'Mark unread'} onClick={() => p.onBulk({ type: 'seen', value: anyUnread })}>
            {anyUnread ? <MailOpen size={16} /> : <Mail size={16} />}
          </button>
          <button className="icon-btn" title={anyUnflagged ? 'Flag' : 'Unflag'} onClick={() => p.onBulk({ type: 'flagged', value: anyUnflagged })}>
            <Flag size={16} />
          </button>
          <button className="icon-btn" title="Archive" onClick={() => p.onBulk({ type: 'archive' })}>
            <Archive size={16} />
          </button>
          <SnoozeMenu iconSize={16} onSnooze={(until) => p.onBulk({ type: 'snooze', until: until.toISOString() })} />
          <MoveMenu
            disabled={!sameAccount}
            account={sameAccount ? p.folders?.find((f) => f.accountId === checkedMsgs[0]!.accountId) : undefined}
            exclude={checkedMsgs[0]?.folder}
            onMove={(destination) => p.onBulk({ type: 'move', destination })}
            icon={<FolderInput size={16} />}
          />
          <button className="icon-btn" title="Delete" onClick={() => p.onBulk({ type: 'delete' })}>
            <Trash2 size={16} />
          </button>
          <button className="icon-btn" title="Clear selection" onClick={() => p.onCheckAll(false)}>
            <X size={16} />
          </button>
        </div>
      )}

      <div className="rows">
        {p.listError && <div className="banner error">{p.listError}</div>}
        {p.errors.map((e) => (
          <div className="banner error" key={e.accountId}>
            {p.accounts.get(e.accountId)?.name ?? 'Account'}: {e.error}
          </div>
        ))}
        {p.loading && (
          <div className="center" style={{ height: 120 }}>
            <div className="spinner" />
          </div>
        )}
        {!p.loading && p.messages.length === 0 && !p.listError && (
          <div className="center muted" style={{ height: 160 }}>
            {p.unreadOnly ? (
              <div>
                <MailCheck size={28} style={{ opacity: 0.5 }} />
                <div style={{ marginTop: 6 }}>
                  {p.query ? 'No unread messages match your search.' : "You're all caught up. No unread messages here."}
                </div>
              </div>
            ) : p.query ? (
              'No messages match your search.'
            ) : (
              'No messages here.'
            )}
          </div>
        )}
        {p.messages.map((m) => {
          const key = refKey(m);
          const acc = p.accounts.get(m.accountId);
          const who = p.isSentLike ? `To: ${m.to.map(displayName).join(', ') || '(no recipients)'}` : displayName(m.from[0]) || '(unknown sender)';
          return (
            <SwipeRow
              key={key}
              left={p.swipeLeft}
              right={p.swipeRight}
              seen={m.seen}
              flagged={m.flagged}
              removes={(d) => p.swipeRemoves(m, d)}
              confirm={(d) => p.confirmSwipe(m, d)}
              onSwipe={(d) => p.onSwipe(m, d)}
              className={`row ${m.seen ? '' : 'unread'} ${p.openKey === key ? 'selected' : ''} ${p.lastOpenKey === key && p.openKey !== key ? 'recent' : ''} ${p.checked.has(key) ? 'checked' : ''} ${p.unreadOnly && m.seen ? 'read-in-filter' : ''}`}
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey) p.onCheck(m, !p.checked.has(key));
                else p.onOpen(m);
              }}
            >
              {p.unified && acc && <span className="acct-bar" style={{ background: acc.color }} title={acc.name} />}
              <div className="row-check" onClick={(e) => e.stopPropagation()}>
                <input type="checkbox" checked={p.checked.has(key)} onChange={(e) => p.onCheck(m, e.target.checked)} aria-label="Select" />
              </div>
              <div className="row-main">
                <div className="row-top">
                  <span className="row-from">
                    {m.draft && <span style={{ color: 'var(--danger)', fontWeight: 600 }}>Draft </span>}
                    {who}
                  </span>
                  {m.answered && <Reply size={13} className="ind" />}
                  {m.hasAttachments && <Paperclip size={13} className="ind" />}
                  {m.flagged && <Star size={13} className="flag" fill="currentColor" />}
                  {m.snoozedUntil ? (
                    <span className="row-date snoozed" title={`Snoozed until ${new Date(m.snoozedUntil).toLocaleString()}`}>
                      <AlarmClock size={12} /> {formatSnoozeTime(m.snoozedUntil)}
                    </span>
                  ) : (
                    <span className="row-date">{formatListDate(m.date)}</span>
                  )}
                </div>
                <div className="row-subject">
                  <span>{m.subject || '(no subject)'}</span>
                </div>
                {m.snippet && <div className="row-snippet">{m.snippet}</div>}
              </div>
            </SwipeRow>
          );
        })}
        <div ref={sentinel} className="list-footer">
          {p.fetchingMore && <div className="spinner" />}
          {!p.fetchingMore && p.hasMore && (
            <button className="btn ghost" onClick={p.onLoadMore}>
              Load more
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
