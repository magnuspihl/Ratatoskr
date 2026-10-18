import { useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { DEFAULT_PORTS } from '../../../shared/mailPorts';
import type { AccountDefaults, AccountInput, AccountView, TlsMode } from '../../../shared/types';
import { newAccountInput, usesDefaultPassword } from '../accountForm';
import { api } from '../api';
import { ACCOUNT_COLORS } from '../util';

function fromView(a: AccountView): AccountInput {
  return {
    name: a.name,
    displayName: a.displayName,
    email: a.email,
    color: a.color,
    imap: { ...a.imap, password: '' },
    smtp: { ...a.smtp, password: '' },
    appendSent: a.appendSent,
  };
}

function ServerFields({
  kind,
  value,
  onChange,
  editing,
  passwordHint,
}: {
  kind: 'imap' | 'smtp';
  value: AccountInput['imap'];
  onChange: (v: AccountInput['imap']) => void;
  editing: boolean;
  /** Placeholder for a blank password on a new account. */
  passwordHint: string;
}) {
  return (
    <fieldset>
      <legend>{kind === 'imap' ? 'Incoming (IMAP)' : 'Outgoing (SMTP)'}</legend>
      <div className="grid3">
        <div>
          <label className="label">Server</label>
          <input className="input" value={value.host} placeholder={`${kind}.example.com`} onChange={(e) => onChange({ ...value, host: e.target.value })} />
        </div>
        <div>
          <label className="label">Security</label>
          <select
            className="select"
            value={value.tls}
            onChange={(e) => {
              const tls = e.target.value as TlsMode;
              onChange({ ...value, tls, port: DEFAULT_PORTS[kind][tls] });
            }}
          >
            <option value="tls">SSL/TLS</option>
            <option value="starttls">STARTTLS</option>
            <option value="none">None (insecure)</option>
          </select>
        </div>
        <div>
          <label className="label">Port</label>
          <input className="input" type="number" value={value.port} onChange={(e) => onChange({ ...value, port: Number(e.target.value) })} />
        </div>
      </div>
      <div className="grid2">
        <div>
          <label className="label">Username</label>
          <input className="input" value={value.user} autoComplete="off" onChange={(e) => onChange({ ...value, user: e.target.value })} />
        </div>
        <div>
          <label className="label">Password</label>
          <input
            className="input"
            type="password"
            value={value.password ?? ''}
            autoComplete="new-password"
            placeholder={editing ? 'Unchanged' : passwordHint}
            onChange={(e) => onChange({ ...value, password: e.target.value })}
          />
        </div>
      </div>
      {value.tls === 'none' && <div className="error-text" style={{ fontSize: 12 }}>Without TLS, your password and mail travel unencrypted.</div>}
    </fieldset>
  );
}

function AccountForm({
  initial,
  id,
  defaults,
  onDone,
  onCancel,
}: {
  initial: AccountInput;
  id?: string;
  defaults: AccountDefaults;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [v, setV] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);

  const normalized = (): AccountInput => ({
    ...v,
    smtp: { ...v.smtp, password: v.smtp.password || (id ? '' : v.imap.password) },
  });

  const run = async (what: 'test' | 'save') => {
    setBusy(what);
    setStatus(null);
    try {
      if (what === 'test') {
        await api.testAccount(normalized(), id);
        setStatus({ ok: true, text: 'Connection successful (IMAP and SMTP).' });
      } else {
        if (id) await api.updateAccount(id, normalized());
        else await api.createAccount(normalized());
        onDone();
      }
    } catch (err) {
      setStatus({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const defaultPw = (kind: 'imap' | 'smtp') => usesDefaultPassword(defaults, kind, v[kind].host);
  const imapHint = defaultPw('imap') ? 'Default password' : '';
  // The default password is never sent to a non-default SMTP server, not even via "Same as IMAP".
  const smtpHint = v.imap.password ? 'Same as IMAP' : defaultPw('smtp') ? 'Default password' : defaultPw('imap') ? '' : 'Same as IMAP';

  const setEmail = (email: string) => {
    // Fill obvious defaults while the user types the address.
    setV((cur) => ({
      ...cur,
      email,
      name: cur.name && cur.name !== cur.email ? cur.name : email,
      imap: { ...cur.imap, user: cur.imap.user && cur.imap.user !== cur.email ? cur.imap.user : email },
      smtp: { ...cur.smtp, user: cur.smtp.user && cur.smtp.user !== cur.email ? cur.smtp.user : email },
    }));
  };

  return (
    <>
      <div className="dialog-body">
        <div className="grid2">
          <div>
            <label className="label">Email address</label>
            <input className="input" value={v.email} placeholder="user@example.com" onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div>
            <label className="label">Your name (shown to recipients)</label>
            <input className="input" value={v.displayName} onChange={(e) => setV({ ...v, displayName: e.target.value })} />
          </div>
        </div>
        <div className="grid2">
          <div>
            <label className="label">Account label</label>
            <input className="input" value={v.name} placeholder="Work" onChange={(e) => setV({ ...v, name: e.target.value })} />
          </div>
          <div>
            <label className="label">Colour</label>
            <div className="swatches">
              {ACCOUNT_COLORS.map((c) => (
                <button key={c} className={`swatch ${v.color === c ? 'on' : ''}`} style={{ background: c }} onClick={() => setV({ ...v, color: c })} title={c} />
              ))}
            </div>
          </div>
        </div>
        <ServerFields kind="imap" value={v.imap} editing={!!id} passwordHint={imapHint} onChange={(imap) => setV({ ...v, imap })} />
        <ServerFields kind="smtp" value={v.smtp} editing={!!id} passwordHint={smtpHint} onChange={(smtp) => setV({ ...v, smtp })} />
        <label className="check">
          <input type="checkbox" checked={v.appendSent} onChange={(e) => setV({ ...v, appendSent: e.target.checked })} />
          Save a copy of sent mail to the Sent folder
          <span className="muted">(turn off if your provider already does this)</span>
        </label>
      </div>
      <div className="dialog-foot">
        <span className={`grow ${status?.ok ? '' : 'error-text'}`} style={status?.ok ? { color: 'var(--success)' } : undefined}>
          {status?.text}
        </span>
        <button className="btn ghost" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn" onClick={() => void run('test')} disabled={busy !== null}>
          {busy === 'test' ? 'Testing…' : 'Test connection'}
        </button>
        <button className="btn primary" onClick={() => void run('save')} disabled={busy !== null}>
          {busy === 'save' ? 'Connecting…' : 'Save'}
        </button>
      </div>
    </>
  );
}

export function AccountsDialog({
  accounts,
  defaults,
  onClose,
  startWithNew,
}: {
  accounts: AccountView[];
  defaults: AccountDefaults;
  onClose: () => void;
  startWithNew?: boolean;
}) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<{ id?: string; input: AccountInput } | null>(
    startWithNew ? { input: newAccountInput(accounts.length, defaults) } : null,
  );
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['accounts'] });
    void qc.invalidateQueries({ queryKey: ['folders'] });
    void qc.invalidateQueries({ queryKey: ['messages'] });
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true">
        <div className="dialog-head">
          <h2>{editing ? (editing.id ? 'Edit account' : 'Add account') : 'Mail accounts'}</h2>
          <button className="icon-btn" onClick={onClose} title="Close">
            <X size={17} />
          </button>
        </div>
        {editing ? (
          <AccountForm
            initial={editing.input}
            id={editing.id}
            defaults={defaults}
            onCancel={() => (accounts.length ? setEditing(null) : onClose())}
            onDone={() => {
              refresh();
              setEditing(null);
            }}
          />
        ) : (
          <>
            <div className="dialog-body">
              {accounts.length === 0 && <div className="muted">No accounts yet.</div>}
              {accounts.map((a) => (
                <div className="account-card" key={a.id}>
                  <span className="swatch" style={{ background: a.color, cursor: 'default' }} />
                  <div className="grow">
                    <div style={{ fontWeight: 600 }}>{a.name}</div>
                    <div className="sub">
                      {a.email} · {a.imap.host}
                    </div>
                  </div>
                  <button className="icon-btn" title="Edit" onClick={() => setEditing({ id: a.id, input: fromView(a) })}>
                    <Pencil size={16} />
                  </button>
                  <button
                    className="icon-btn"
                    title="Remove"
                    onClick={async () => {
                      if (!window.confirm(`Remove ${a.name}? Mail on the server is not affected.`)) return;
                      await api.deleteAccount(a.id);
                      refresh();
                    }}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}
            </div>
            <div className="dialog-foot">
              <span className="grow muted">Passwords are stored encrypted and never sent back to the browser.</span>
              <button className="btn primary" onClick={() => setEditing({ input: newAccountInput(accounts.length, defaults) })}>
                <Plus size={15} /> Add account
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
