import { useQuery } from '@tanstack/react-query';
import {
  Archive,
  ArrowLeft,
  Download,
  FileText,
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
import type { AccountFolders, AccountView, MessageAction, MessageDetail, MessageRef } from '../../../shared/types';
import { api, ApiError } from '../api';
import type { ResolvedTheme } from '../hooks';
import { avatarColor, displayName, formatFullDate, formatSize, initials, refKey } from '../util';
import { MessageFrame } from './MessageFrame';
import { MoveMenu } from './MoveMenu';

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

interface Props {
  openRef: MessageRef | null;
  account: AccountView | undefined;
  folders: AccountFolders | undefined;
  isDrafts: boolean;
  theme: ResolvedTheme;
  markReadOnOpen: boolean;
  onAction: (refs: MessageRef[], action: MessageAction) => void;
  onReply: (kind: ReplyKind, detail: MessageDetail) => void;
  onBack: () => void;
  onStale: () => void;
}

export function Reader({ openRef, account, folders, isDrafts, theme, markReadOnOpen, onAction, onReply, onBack, onStale }: Props) {
  const key = openRef ? refKey(openRef) : '';
  const [remote, setRemote] = useState(false);
  const [modeOverride, setModeOverride] = useState<'dark' | 'paper' | null>(null);
  const [showText, setShowText] = useState(false);
  useEffect(() => {
    setRemote(false);
    setModeOverride(null);
    setShowText(false);
  }, [key]);

  const q = useQuery({
    queryKey: ['message', key, remote],
    queryFn: () => api.message(openRef!, remote),
    enabled: !!openRef,
    staleTime: 5 * 60_000,
    retry: (n, err) => !(err instanceof ApiError && err.status < 500) && n < 1,
  });
  const d = q.data;

  useEffect(() => {
    if (q.error instanceof ApiError && q.error.stale) onStale();
  }, [q.error, onStale]);

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
              j / k to move · r reply · e archive · # delete
            </div>
          </div>
        </div>
      </section>
    );
  }

  const ref = openRef;
  const seen = d?.seen ?? true;
  const flagged = d?.flagged ?? false;

  return (
    <section className="pane reader">
      <div className="reader-toolbar">
        <button className="icon-btn mobile-only" onClick={onBack} title="Back">
          <ArrowLeft size={18} />
        </button>
        {isDrafts ? (
          <button className="btn" disabled={!d} onClick={() => d && onReply('editDraft', d)}>
            <PenSquare size={15} /> Edit draft
          </button>
        ) : (
          <>
            <button className="icon-btn" title="Reply (r)" disabled={!d} onClick={() => d && onReply('reply', d)}>
              <Reply size={17} />
            </button>
            <button className="icon-btn" title="Reply all (a)" disabled={!d} onClick={() => d && onReply('replyAll', d)}>
              <ReplyAll size={17} />
            </button>
            <button className="icon-btn" title="Forward (f)" disabled={!d} onClick={() => d && onReply('forward', d)}>
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
        {d && (
          <>
            <h2 className="msg-subject">{d.subject || '(no subject)'}</h2>
            <div className="msg-head">
              <div className="avatar" style={{ background: avatarColor(d.from[0]?.address ?? '') }}>
                {initials(d.from[0])}
              </div>
              <div className="msg-meta">
                <div className="msg-from">
                  {displayName(d.from[0]) || '(unknown sender)'} {d.from[0]?.name && <span className="addr">&lt;{d.from[0].address}&gt;</span>}
                </div>
                <div className="msg-to" title={[...d.to, ...d.cc].map((a) => a.address).join(', ')}>
                  to {d.to.map(displayName).join(', ') || '(undisclosed)'}
                  {d.cc.length > 0 && <> · cc {d.cc.map(displayName).join(', ')}</>}
                  {account && <span className="muted"> · {account.name}</span>}
                </div>
              </div>
              <div className="msg-date">{formatFullDate(d.date)}</div>
            </div>

            {d.html && (d.remoteContentBlocked > 0 || theme === 'dark' || d.text) && (
              <div className="notice">
                {d.remoteContentBlocked > 0 && !remote ? (
                  <>
                    <ImageOff size={16} />
                    <span className="grow">
                      Remote content blocked ({d.remoteContentBlocked}) to protect your privacy.
                    </span>
                    <button className="btn" onClick={() => setRemote(true)}>
                      Load images
                    </button>
                  </>
                ) : (
                  <span className="grow">{remote ? 'Remote images are loaded through a privacy proxy.' : ''}</span>
                )}
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
                  <button className="btn ghost" title="Toggle plain text" onClick={() => setShowText((s) => !s)}>
                    <FileText size={15} /> {showText ? 'HTML' : 'Text'}
                  </button>
                )}
              </div>
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
