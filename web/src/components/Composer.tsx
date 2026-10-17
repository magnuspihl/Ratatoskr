import {
  Bold,
  Italic,
  Link,
  List,
  ListOrdered,
  Maximize2,
  Minimize2,
  Paperclip,
  Quote,
  RemoveFormatting,
  Send,
  Strikethrough,
  Trash2,
  Underline,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { AccountView, AttachmentView, ComposePayload, MessageRef } from '../../../shared/types';
import { api } from '../api';
import { formatAddress, formatSize } from '../util';

export interface ComposerInit {
  accountId: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  html: string;
  inReplyTo: string | null;
  references: string[];
  forwardFrom: MessageRef | null;
  forwardAttachments: AttachmentView[];
  replaceDraft: MessageRef | null;
  answering: MessageRef | null;
}

function AddressInput({ label, value, onChange, extra }: { label: string; value: string; onChange: (v: string) => void; extra?: ReactNode }) {
  const [suggestions, setSuggestions] = useState<{ name: string; address: string }[]>([]);
  const [active, setActive] = useState(0);
  const [focused, setFocused] = useState(false);
  const token = value.split(',').pop()!.trim();

  useEffect(() => {
    if (!focused || token.length < 2) {
      setSuggestions([]);
      return;
    }
    const t = window.setTimeout(() => {
      api
        .recipients(token)
        .then((r) => {
          setSuggestions(r);
          setActive(0);
        })
        .catch(() => setSuggestions([]));
    }, 150);
    return () => window.clearTimeout(t);
  }, [token, focused]);

  const pick = (s: { name: string; address: string }) => {
    const parts = value.split(',');
    parts[parts.length - 1] = ` ${formatAddress(s)}`;
    onChange(`${parts.join(',').replace(/^\s+/, '')}, `);
    setSuggestions([]);
  };

  return (
    <div className="field">
      <label>{label}</label>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => window.setTimeout(() => setFocused(false), 150)}
        onKeyDown={(e) => {
          if (!suggestions.length) return;
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, suggestions.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === 'Enter' || e.key === 'Tab') {
            e.preventDefault();
            pick(suggestions[active]!);
          } else if (e.key === 'Escape') setSuggestions([]);
        }}
        autoComplete="off"
        spellCheck={false}
      />
      {extra}
      {focused && suggestions.length > 0 && (
        <div className="suggestions">
          {suggestions.map((s, i) => (
            <button key={s.address} className={i === active ? 'on' : ''} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(s)}>
              {s.name ? `${s.name} <${s.address}>` : s.address}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Tool({ title, cmd, arg, children, onRun }: { title: string; cmd?: string; arg?: string; children: ReactNode; onRun?: () => void }) {
  return (
    <button
      type="button"
      className="icon-btn"
      title={title}
      onMouseDown={(e) => {
        e.preventDefault(); // keep the editor selection
        if (onRun) onRun();
        // execCommand is deprecated but remains the only dependency-free rich text primitive.
        else if (cmd) document.execCommand(cmd, false, arg);
      }}
    >
      {children}
    </button>
  );
}

interface Props {
  init: ComposerInit;
  accounts: AccountView[];
  onClose: () => void;
  onToast: (msg: string, error?: boolean) => void;
  onSent: () => void;
}

export function Composer({ init, accounts, onClose, onToast, onSent }: Props) {
  const [accountId, setAccountId] = useState(init.accountId);
  const [to, setTo] = useState(init.to);
  const [cc, setCc] = useState(init.cc);
  const [bcc, setBcc] = useState(init.bcc);
  const [showCc, setShowCc] = useState(!!(init.cc || init.bcc));
  const [subject, setSubject] = useState(init.subject);
  const [files, setFiles] = useState<File[]>([]);
  const [fwd, setFwd] = useState<AttachmentView[]>(init.forwardAttachments);
  const [fwdSource, setFwdSource] = useState<MessageRef | null>(init.forwardFrom);
  const [draft, setDraft] = useState<MessageRef | null>(init.replaceDraft);
  const [busy, setBusy] = useState<'send' | 'draft' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [maximized, setMaximized] = useState(false);
  const [dirty, setDirty] = useState(false);
  const editor = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editor.current) editor.current.innerHTML = init.html;
    if (init.to) {
      editor.current?.focus();
      // Place the caret at the start (above any quoted text).
      const sel = window.getSelection();
      if (sel && editor.current) {
        sel.collapse(editor.current, 0);
      }
    }
  }, [init.html, init.to]);

  useEffect(() => setDirty(true), [to, cc, bcc, subject, files, accountId]);

  const payload = (): ComposePayload => ({
    accountId,
    to,
    cc,
    bcc,
    subject,
    html: editor.current?.innerHTML ?? '',
    inReplyTo: init.inReplyTo,
    references: init.references,
    forwardFrom: fwdSource && fwd.length ? { ...fwdSource, indices: fwd.map((a) => a.index) } : null,
    replaceDraft: draft,
    answering: init.answering,
  });

  const send = async () => {
    setBusy('send');
    setError(null);
    try {
      const res = await api.send(payload(), files);
      onToast(res.warning ? `Sent. ${res.warning}` : 'Message sent', !!res.warning);
      onSent();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const saveDraft = async () => {
    setBusy('draft');
    setError(null);
    try {
      const res = await api.saveDraft(payload(), files);
      if (res.draft) {
        setDraft(res.draft);
        // Attachments now live in the saved draft (the previous one was replaced), so future
        // saves and the final send carry them over from there.
        if (files.length || fwd.length) {
          const saved = await api.message(res.draft, false);
          setFwdSource(res.draft);
          setFwd(saved.attachments.filter((a) => !a.inline));
          setFiles([]);
        }
      }
      setDirty(false);
      onToast('Draft saved');
      onSent();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const close = () => {
    if (dirty && !window.confirm('Discard this message?')) return;
    onClose();
  };

  const addLink = () => {
    const url = window.prompt('Link address (https://…)');
    if (!url) return;
    if (!/^(https?:\/\/|mailto:)/i.test(url.trim())) {
      setError('Links must start with https://, http:// or mailto:');
      return;
    }
    document.execCommand('createLink', false, url.trim());
  };

  return (
    <div
      className={`composer ${maximized ? 'maximized' : ''}`}
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
          e.preventDefault();
          void send();
        }
        if (e.key === 'Escape') close();
      }}
    >
      <div className="composer-head">
        <span className="title">{subject || 'New message'}</span>
        <button className="icon-btn" title={maximized ? 'Restore' : 'Maximize'} onClick={() => setMaximized((m) => !m)}>
          {maximized ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </button>
        <button className="icon-btn" title="Close" onClick={close}>
          <X size={17} />
        </button>
      </div>
      <div className="field">
        <label>From</label>
        <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.displayName ? `${a.displayName} <${a.email}>` : a.email} · {a.name}
            </option>
          ))}
        </select>
      </div>
      <AddressInput
        label="To"
        value={to}
        onChange={setTo}
        extra={
          !showCc && (
            <button className="toggle" onClick={() => setShowCc(true)}>
              Cc/Bcc
            </button>
          )
        }
      />
      {showCc && <AddressInput label="Cc" value={cc} onChange={setCc} />}
      {showCc && <AddressInput label="Bcc" value={bcc} onChange={setBcc} />}
      <div className="field">
        <label>Subject</label>
        <input value={subject} onChange={(e) => setSubject(e.target.value)} />
      </div>
      <div className="toolbar">
        <Tool title="Bold" cmd="bold">
          <Bold size={15} />
        </Tool>
        <Tool title="Italic" cmd="italic">
          <Italic size={15} />
        </Tool>
        <Tool title="Underline" cmd="underline">
          <Underline size={15} />
        </Tool>
        <Tool title="Strikethrough" cmd="strikeThrough">
          <Strikethrough size={15} />
        </Tool>
        <span className="sep" />
        <Tool title="Bulleted list" cmd="insertUnorderedList">
          <List size={15} />
        </Tool>
        <Tool title="Numbered list" cmd="insertOrderedList">
          <ListOrdered size={15} />
        </Tool>
        <Tool title="Quote" cmd="formatBlock" arg="blockquote">
          <Quote size={15} />
        </Tool>
        <Tool title="Link" onRun={addLink}>
          <Link size={15} />
        </Tool>
        <span className="sep" />
        <Tool title="Clear formatting" cmd="removeFormat">
          <RemoveFormatting size={15} />
        </Tool>
      </div>
      <div className="editor">
        {/* Quoted mail is server-sanitized; the container's CSS containment keeps any
            positioned content from escaping the editor area. */}
        <div ref={editor} className="editor-content" contentEditable suppressContentEditableWarning onInput={() => setDirty(true)} />
      </div>
      {(files.length > 0 || fwd.length > 0) && (
        <div className="composer-attachments">
          {fwd.map((a) => (
            <span className="attachment" key={`f${a.index}`}>
              <Paperclip size={13} />
              <span className="fname">{a.filename}</span>
              <span className="fsize">{formatSize(a.size)}</span>
              <button className="remove" title="Remove" onClick={() => setFwd((list) => list.filter((x) => x !== a))}>
                <X size={13} />
              </button>
            </span>
          ))}
          {files.map((f, i) => (
            <span className="attachment" key={`u${i}`}>
              <Paperclip size={13} />
              <span className="fname">{f.name}</span>
              <span className="fsize">{formatSize(f.size)}</span>
              <button className="remove" title="Remove" onClick={() => setFiles((list) => list.filter((x) => x !== f))}>
                <X size={13} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="composer-foot">
        <button className="btn primary" onClick={() => void send()} disabled={busy !== null}>
          <Send size={15} /> {busy === 'send' ? 'Sending…' : 'Send'}
        </button>
        <button className="btn" onClick={() => void saveDraft()} disabled={busy !== null}>
          {busy === 'draft' ? 'Saving…' : 'Save draft'}
        </button>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            const picked = Array.from(e.target.files ?? []);
            setFiles((f) => [...f, ...picked]);
            e.target.value = '';
          }}
        />
        <button className="icon-btn" title="Attach files" onClick={() => fileInput.current?.click()}>
          <Paperclip size={17} />
        </button>
        <span className="grow error-text">{error}</span>
        <button className="icon-btn" title="Discard" onClick={close}>
          <Trash2 size={16} />
        </button>
      </div>
    </div>
  );
}
