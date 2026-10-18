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
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AccountFolders, AccountView, DomainName, MessageAction, MessageDetail, MessageRef } from '../../../shared/types';
import { api, ApiError } from '../api';
import type { ResolvedTheme } from '../hooks';
import { avatarColor, displayName, formatFullDate, formatSize, initials, refKey } from '../util';
import { MessageFrame } from './MessageFrame';
import { MoveMenu } from './MoveMenu';
import { SnoozeMenu } from './SnoozeMenu';
import { formatSnoozeTime } from '../snooze';

const URL_RE = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/g;

/** Plain-text body: React escapes everything; only http(s) URLs become links. */
function TextBody({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  return (
    <div className="msg-text">
      {lines.map((line, i) => {
        const parts: ReactNode[] = [];
        let last = 0;
        for (const m of line.matchAll(URL_RE)) {
          parts.push(line.slice(last, m.index));
          parts.push(
            <a key={m.index} href={m[0]} target="_blank" rel="noopener noreferrer nofollow">
              {m[0]}
            </a>,
          );
          last = m.index + m[0].length;
        }
        parts.push(line.slice(last));
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

interface Props {
  openRef: MessageRef | null;
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
  onBack: () => void;
  /** The message is gone (404) or its folder's UIDVALIDITY changed (stale). */
  onGone: (stale: boolean) => void;
}

export function Reader({ openRef, account, multipleAccounts, folders, isDrafts, theme, markReadOnOpen, onAction, snoozeSignal, onReply, onBack, onGone }: Props) {
  const key = openRef ? refKey(openRef) : '';
  const [remote, setRemote] = useState(false);
  const [modeOverride, setModeOverride] = useState<'dark' | 'paper' | null>(null);
  const [showText, setShowText] = useState(false);
  const [headOpen, setHeadOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  useEffect(() => {
    setRemote(false);
    setModeOverride(null);
    setShowText(false);
    setHeadOpen(false);
    setLocalError(null);
  }, [key]);

  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['message', key, remote ? 'load' : 'auto'],
    queryFn: () => api.message(openRef!, remote ? 'load' : 'auto'),
    enabled: !!openRef,
    staleTime: 5 * 60_000,
    retry: (n, err) => !(err instanceof ApiError && err.status < 500) && n < 1,
  });
  const d = q.data;

  useEffect(() => {
    if (q.error instanceof ApiError && (q.error.stale || q.error.status === 404)) onGone(q.error.stale);
  }, [q.error, onGone]);

  // Mark as read when opened (once per message).
  useEffect(() => {
    if (d && !d.seen && markReadOnOpen && openRef && refKey(openRef) === refKey(d)) onAction([openRef], { type: 'seen', value: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d?.uid, d?.accountId, d?.folder]);

  const mode = useMemo(() => {
    if (theme === 'light') return 'light' as const;
    if (modeOverride) return modeOverride;
    return d?.htmlStyle === 'designed' ? ('paper' as const) : ('dark' as const);
  }, [theme, modeOverride, d?.htmlStyle]);

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
  const seen = d?.seen ?? true;
  const flagged = d?.flagged ?? false;

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
        {q.isLoading && (
          <div className="center">
            <div className="spinner" />
          </div>
        )}
        {q.error && <div className="banner error">{(q.error as Error).message}</div>}
        {localError && <div className="banner error">{localError}</div>}
        {d && (
          <>
            <h2 className="msg-subject">{d.subject || '(no subject)'}</h2>
            <div className={`msg-head ${headOpen ? 'open' : ''}`}>
              <div className="avatar" style={{ background: avatarColor(d.from[0]?.address ?? '') }}>
                {initials(d.from[0])}
              </div>
              <div className="msg-meta">
                {/* On phones the addresses and recipients fold away; tapping the sender shows them. */}
                <div className="msg-from">
                  <button className="msg-from-toggle" aria-expanded={headOpen} title="Show details" onClick={() => setHeadOpen((o) => !o)}>
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
                <button className="btn" onClick={() => onAction([ref], { type: 'unsnooze' })}>
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
                    onClick={() => void changeAllowlist(() => api.addImageDomain(d.senderDomain!.domain))}
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
                  <a key={a.index} className="attachment" href={api.attachmentUrl(ref, a.index)} download={a.filename} title={`${a.filename} (${a.mimeType})`}>
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
              <TextBody text={d.text ?? ''} />
            )}
          </>
        )}
      </div>
    </section>
  );
}
