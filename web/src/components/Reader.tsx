import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  AlarmClock,
  Archive,
  ArrowLeft,
  Download,
  Flag,
  FolderInput,
  Forward,
  ImageOff,
  Mail,
  MailOpen,
  Paperclip,
  PenSquare,
  Reply,
  ReplyAll,
  Trash2,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ConversationRow } from '../../../shared/threads';
import type { AccountFolders, AccountView, DomainName, MessageAction, MessageDetail, MessageRef, MessageSummary } from '../../../shared/types';
import { api, ApiError } from '../api';
import type { ResolvedTheme } from '../hooks';
import { avatarColor, displayName, formatFullDate, formatListDate, formatSize, initials, refKey, toRef } from '../util';
import { MessageFrame } from './MessageFrame';
import { MoveMenu } from './MoveMenu';
import { SnoozeMenu } from './SnoozeMenu';
import { formatSnoozeTime } from '../snooze';
import { linkify } from '../mailto';

/**
 * Plain-text body: React escapes everything; only http(s) URLs, mailto: links and email addresses
 * become links. Email links open the composer here instead of another mail program.
 */
function TextBody({ text, onMailto }: { text: string; onMailto: (mailto: string) => void }) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  return (
    <div className="msg-text">
      {lines.map((line, i) => {
        const parts: ReactNode[] = linkify(line).map((p, j) =>
          typeof p === 'string' ? (
            p
          ) : p.mailto ? (
            <a
              key={j}
              href={p.href}
              onClick={(e) => {
                e.preventDefault();
                onMailto(p.href);
              }}
            >
              {p.text}
            </a>
          ) : (
            <a key={j} href={p.href} target="_blank" rel="noopener noreferrer nofollow">
              {p.text}
            </a>
          ),
        );
        return (
          <span key={i} className={/^\s*>/.test(line) ? 'quote' : undefined}>
            {parts}
            {'\n'}
          </span>
        );
      })}
    </div>
  );
}

export type ReplyKind = 'reply' | 'replyAll' | 'forward' | 'editDraft';

/**
 * The version of a message to quote in a reply/forward: without remote images, so downloaded
 * remote content (e.g. tracking pixels) isn't embedded in outgoing mail.
 */
export async function quotableDetail(qc: QueryClient, d: MessageDetail): Promise<MessageDetail> {
  if (!d.remoteContentLoaded) return d;
  return qc.fetchQuery({ queryKey: ['message', refKey(d), 'block'], queryFn: () => api.message(d, 'block'), staleTime: 5 * 60_000 });
}

/** The message a reply goes to, like Gmail: the newest one of the conversation. */
export function replyTarget(conversation: ConversationRow | undefined, openRef: MessageRef): MessageRef {
  const last = conversation?.thread.at(-1);
  return last ? toRef(last) : openRef;
}

interface Props {
  openRef: MessageRef | null;
  /** The list row of the open message: its whole conversation. Absent e.g. for a deep link. */
  conversation?: ConversationRow;
  account: AccountView | undefined;
  /** The user has more than one account, so which one received the message is worth showing. */
  multipleAccounts: boolean;
  folders: AccountFolders | undefined;
  isDrafts: boolean;
  theme: ResolvedTheme;
  markReadOnOpen: boolean;
  onAction: (refs: MessageRef[], action: MessageAction) => void;
  /** Opens the snooze menu whenever it changes (keyboard shortcut). */
  snoozeSignal: number;
  onReply: (kind: ReplyKind, detail: MessageDetail) => void;
  /** A mailto: link in a plain-text body was clicked. */
  onMailto: (mailto: string) => void;
  onBack: () => void;
  /** The message is gone (404) or its folder's UIDVALIDITY changed (stale). */
  onGone: (stale: boolean) => void;
}

const retry = (n: number, err: Error) => !(err instanceof ApiError && err.status < 500) && n < 1;

export function Reader({ openRef, conversation, account, multipleAccounts, folders, isDrafts, theme, markReadOnOpen, onAction, snoozeSignal, onReply, onMailto, onBack, onGone }: Props) {
  const key = openRef ? refKey(openRef) : '';
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  /** Messages the user expanded or collapsed by hand. */
  const [toggled, setToggled] = useState<Map<string, boolean>>(new Map());
  useEffect(() => {
    setLocalError(null);
    setToggled(new Map());
  }, [key]);

  // The conversation, oldest first. The open message is in it; without a list row it's alone.
  const items: { ref: MessageRef; summary?: MessageSummary }[] = useMemo(() => {
    if (!openRef) return [];
    if (conversation?.thread.some((m) => refKey(m) === key)) return conversation.thread.map((m) => ({ ref: toRef(m), summary: m }));
    return [{ ref: openRef }];
  }, [openRef, conversation, key]);
  const primary = openRef ? replyTarget(items.length > 1 ? conversation : undefined, openRef) : null;
  const primaryKey = primary ? refKey(primary) : '';

  // Expanded by default: the newest message and the ones that were unread when the conversation
  // was opened (they stay expanded once read).
  const unreadAtOpen = useRef({ key: '', keys: new Set<string>() });
  if (unreadAtOpen.current.key !== key) unreadAtOpen.current = { key, keys: new Set() };
  for (const it of items) if (it.summary && !it.summary.seen) unreadAtOpen.current.keys.add(refKey(it.ref));
  const isExpanded = (k: string) => toggled.get(k) ?? (items.length === 1 || k === primaryKey || unreadAtOpen.current.keys.has(k));
  const toggle = (k: string) => setToggled((t) => new Map(t).set(k, !isExpanded(k)));

  const qc = useQueryClient();
  // The newest message: what the toolbar replies to (shared with its card's query).
  const q = useQuery({
    queryKey: ['message', primaryKey, 'auto'],
    queryFn: () => api.message(primary!, 'auto'),
    enabled: !!primary,
    staleTime: 5 * 60_000,
    retry,
  });
  const d = q.data;

  // Mark the conversation read when opened (once per opening).
  const marked = useRef('');
  useEffect(() => {
    if (!openRef) marked.current = '';
    if (!markReadOnOpen || !openRef || marked.current === key) return;
    const unread = conversation && items.length > 1 ? !conversation.seen : d && refKey(d) === key ? !d.seen : undefined;
    if (unread === undefined) return;
    marked.current = key;
    if (unread) onAction([openRef], { type: 'seen', value: true });
  });

  if (!openRef) {
    return (
      <section className="pane reader">
        <div className="empty-reader">
          <div>
            <Mail size={44} />
            <div style={{ marginTop: 8 }}>Select a message to read</div>
            <div className="kbd" style={{ marginTop: 4 }}>
              j / k to move · r reply · e archive · b snooze · # delete
            </div>
          </div>
        </div>
      </section>
    );
  }

  const ref = openRef;
  const replyWith = (kind: ReplyKind, detail: MessageDetail) =>
    void quotableDetail(qc, detail).then(
      (quoted) => onReply(kind, quoted),
      (err: Error) => setLocalError(err.message),
    );
  // Add or remove a sender domain on the image allowlist, then refetch so the server re-decides.
  const changeAllowlist = async (change: () => Promise<DomainName[]>) => {
    setBusy(true);
    setLocalError(null);
    try {
      qc.setQueryData(['imageDomains'], await change());
      await qc.invalidateQueries({ queryKey: ['message'] });
    } catch (err) {
      setLocalError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const threaded = items.length > 1;
  const seen = threaded ? conversation!.seen : (d?.seen ?? true);
  const flagged = threaded ? conversation!.flagged : (d?.flagged ?? false);
  const subject = threaded ? items[0]!.summary!.subject : d?.subject;

  return (
    <section className="pane reader">
      <div className="reader-toolbar">
        <button className="icon-btn mobile-only" onClick={onBack} title="Back">
          <ArrowLeft size={18} />
        </button>
        {isDrafts ? (
          <button className="btn" disabled={!d} onClick={() => d && replyWith('editDraft', d)}>
            <PenSquare size={15} /> Edit draft
          </button>
        ) : (
          <>
            <button className="icon-btn" title="Reply (r)" disabled={!d} onClick={() => d && replyWith('reply', d)}>
              <Reply size={17} />
            </button>
            <button className="icon-btn" title="Reply all (a)" disabled={!d} onClick={() => d && replyWith('replyAll', d)}>
              <ReplyAll size={17} />
            </button>
            <button className="icon-btn" title="Forward (f)" disabled={!d} onClick={() => d && replyWith('forward', d)}>
              <Forward size={17} />
            </button>
          </>
        )}
        <span className="spacer" />
        <button className="icon-btn" title={seen ? 'Mark unread (u)' : 'Mark read'} onClick={() => onAction([ref], { type: 'seen', value: !seen })}>
          {seen ? <Mail size={17} /> : <MailOpen size={17} />}
        </button>
        <button className={`icon-btn ${flagged ? 'active' : ''}`} title="Flag (s)" onClick={() => onAction([ref], { type: 'flagged', value: !flagged })}>
          <Flag size={17} fill={flagged ? 'currentColor' : 'none'} />
        </button>
        <button className="icon-btn" title="Archive (e)" onClick={() => onAction([ref], { type: 'archive' })}>
          <Archive size={17} />
        </button>
        <SnoozeMenu iconSize={17} openSignal={snoozeSignal} onSnooze={(until) => onAction([ref], { type: 'snooze', until: until.toISOString() })} />
        <MoveMenu account={folders} exclude={ref.folder} icon={<FolderInput size={17} />} onMove={(destination) => onAction([ref], { type: 'move', destination })} />
        <button className="icon-btn" title="Delete (#)" onClick={() => onAction([ref], { type: 'delete' })}>
          <Trash2 size={17} />
        </button>
      </div>

      <div className="reader-body">
        {localError && <div className="banner error">{localError}</div>}
        {subject !== undefined && (
          <h2 className="msg-subject">
            {subject || '(no subject)'}
            {threaded && <span className="msg-count">{items.length}</span>}
          </h2>
        )}
        {items.map((it) => {
          const k = refKey(it.ref);
          return (
            <MessageCard
              key={k}
              msgRef={it.ref}
              summary={it.summary}
              expanded={isExpanded(k)}
              onToggle={threaded ? () => toggle(k) : undefined}
              account={account}
              multipleAccounts={multipleAccounts}
              theme={theme}
              busy={busy}
              onAllowDomain={(domain) => void changeAllowlist(() => api.addImageDomain(domain))}
              onAction={onAction}
              onMailto={onMailto}
              onGone={k === key ? onGone : undefined}
            />
          );
        })}
      </div>
    </section>
  );
}

/** One message of the open conversation: just a summary line when collapsed. */
function MessageCard({
  msgRef,
  summary,
  expanded,
  onToggle,
  account,
  multipleAccounts,
  theme,
  busy,
  onAllowDomain,
  onAction,
  onMailto,
  onGone,
}: {
  msgRef: MessageRef;
  summary?: MessageSummary;
  expanded: boolean;
  /** Present in a conversation of several messages: collapse/expand this one. */
  onToggle?: () => void;
  account: AccountView | undefined;
  multipleAccounts: boolean;
  theme: ResolvedTheme;
  busy: boolean;
  onAllowDomain: (domain: string) => void;
  onAction: (refs: MessageRef[], action: MessageAction) => void;
  onMailto: (mailto: string) => void;
  /** Only for the open message: it is gone or its folder changed. */
  onGone?: (stale: boolean) => void;
}) {
  const [remote, setRemote] = useState(false);
  const [modeOverride, setModeOverride] = useState<'dark' | 'paper' | null>(null);
  const [showText, setShowText] = useState(false);
  const [headOpen, setHeadOpen] = useState(false);
  const q = useQuery({
    queryKey: ['message', refKey(msgRef), remote ? 'load' : 'auto'],
    queryFn: () => api.message(msgRef, remote ? 'load' : 'auto'),
    enabled: expanded,
    staleTime: 5 * 60_000,
    retry,
  });
  const d = q.data;

  useEffect(() => {
    if (onGone && q.error instanceof ApiError && (q.error.stale || q.error.status === 404)) onGone(q.error.stale);
  }, [q.error, onGone]);

  const mode = useMemo(() => {
    if (theme === 'light') return 'light' as const;
    if (modeOverride) return modeOverride;
    return d?.htmlStyle === 'designed' ? ('paper' as const) : ('dark' as const);
  }, [theme, modeOverride, d?.htmlStyle]);

  if (!expanded && summary) {
    const from = summary.from[0];
    return (
      <button className="msg-card msg-collapsed" onClick={onToggle} title="Show this message">
        <span className="avatar small" style={{ background: avatarColor(from?.address ?? '') }}>
          {initials(from)}
        </span>
        <span className="msg-collapsed-from">{displayName(from) || '(unknown sender)'}</span>
        <span className="msg-collapsed-snippet">{summary.snippet}</span>
        <span className="msg-date">{formatListDate(summary.date)}</span>
      </button>
    );
  }

  // How to show an HTML message: dark/paper (dark theme only) and HTML/plain text, kept on one line.
  const viewToggles = d?.html && ((theme === 'dark' && !showText) || d.text) && (
    <div className="view-toggles">
      {theme === 'dark' && !showText && (
        <div className="segmented" title="How to display this message in dark mode">
          <button className={mode === 'dark' ? 'on' : ''} onClick={() => setModeOverride('dark')}>
            Dark
          </button>
          <button className={mode === 'paper' ? 'on' : ''} onClick={() => setModeOverride('paper')}>
            Paper
          </button>
        </div>
      )}
      {d.text && (
        <div className="segmented" title="Show the HTML or plain-text version">
          <button className={showText ? '' : 'on'} onClick={() => setShowText(false)}>
            HTML
          </button>
          <button className={showText ? 'on' : ''} onClick={() => setShowText(true)}>
            Text
          </button>
        </div>
      )}
    </div>
  );

  return (
    <article className="msg-card">
      {q.isLoading && (
        <div className="center">
          <div className="spinner" />
        </div>
      )}
      {q.error && <div className="banner error">{(q.error as Error).message}</div>}
      {d && (
        <>
          {/* In a conversation, clicking the header folds the message away again. */}
          <div className={`msg-head ${headOpen ? 'open' : ''} ${onToggle ? 'foldable' : ''}`} onClick={onToggle}>
            <div className="avatar" style={{ background: avatarColor(d.from[0]?.address ?? '') }}>
              {initials(d.from[0])}
            </div>
            <div className="msg-meta">
              {/* On phones the addresses and recipients fold away; tapping the sender shows them. */}
              <div className="msg-from">
                <button
                  className="msg-from-toggle"
                  aria-expanded={headOpen}
                  title="Show details"
                  onClick={(e) => {
                    e.stopPropagation();
                    setHeadOpen((o) => !o);
                  }}
                >
                  {displayName(d.from[0]) || '(unknown sender)'}
                </button>{' '}
                {d.from[0]?.name && <span className="addr">&lt;{d.from[0].address}&gt;</span>}
              </div>
              <div className={`msg-to ${multipleAccounts && account ? 'has-account' : ''}`} title={[...d.to, ...d.cc].map((a) => a.address).join(', ')}>
                to {d.to.map(displayName).join(', ') || '(undisclosed)'}
                {multipleAccounts && account && <span className="acct-dot" style={{ background: account.color }} title={account.name} />}
                {d.cc.length > 0 && <span className="cc"> · cc {d.cc.map(displayName).join(', ')}</span>}
                {multipleAccounts && account && <span className="muted acct-name"> · {account.name}</span>}
              </div>
            </div>
            <div className="msg-date">{formatFullDate(d.date)}</div>
          </div>

          {d.snoozedUntil && (
            <div className="notice">
              <AlarmClock size={16} />
              <span className="grow">
                Snoozed until {formatSnoozeTime(d.snoozedUntil)}. It will come back to the inbox then.
              </span>
              <button className="btn" onClick={() => onAction([msgRef], { type: 'unsnooze' })}>
                Unsnooze
              </button>
            </div>
          )}

          {d.html && d.remoteContentBlocked > 0 && !d.remoteContentLoaded ? (
            <div className="notice">
              <ImageOff size={16} />
              <span className="grow">
                {d.allowlistSkipped === 'dmarc-fail' && d.senderDomain
                  ? `Images not loaded automatically: this message failed the sender check (DMARC) for ${d.senderDomain.display}.`
                  : `Remote content blocked (${d.remoteContentBlocked}) to protect your privacy.`}
              </span>
              <button className="btn" onClick={() => setRemote(true)}>
                Load images
              </button>
              {d.senderDomain && !d.allowlistSkipped && (
                <button
                  className="btn ghost"
                  disabled={busy}
                  title="Always load remote images in mail from this domain and its subdomains"
                  onClick={() => onAllowDomain(d.senderDomain!.domain)}
                >
                  Always load from {d.senderDomain.display}
                </button>
              )}
              {viewToggles}
            </div>
          ) : (
            viewToggles
          )}

          {d.attachments.length > 0 && (
            <div className="attachments">
              {d.attachments.map((a) => (
                <a key={a.index} className="attachment" href={api.attachmentUrl(msgRef, a.index)} download={a.filename} title={`${a.filename} (${a.mimeType})`}>
                  <Paperclip size={14} />
                  <span className="fname">{a.filename}</span>
                  <span className="fsize">{formatSize(a.size)}</span>
                  <Download size={14} className="muted" />
                </a>
              ))}
            </div>
          )}

          {d.html && !showText ? (
            <div className={`msg-frame-wrap ${mode === 'paper' ? 'paper' : ''}`}>
              <MessageFrame html={d.html} css={d.css} mode={mode} themeKey={theme} />
            </div>
          ) : (
            <TextBody text={d.text ?? ''} onMailto={onMailto} />
          )}
        </>
      )}
    </article>
  );
}
