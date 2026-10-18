import { useQuery, useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { DomainName, NotificationContent, Preferences, SwipeAction, TransitionSpeed } from '../../../shared/types';
import { api } from '../api';
import { handlerTemplate } from '../mailto';
import { currentEnvironment, currentSubscription, disablePush, enablePush, pushAvailability, type PushAvailability } from '../push';

const TRANSITION_OPTIONS: [TransitionSpeed, string][] = [
  ['off', 'Off'],
  ['fast', 'Fast'],
  ['medium', 'Medium'],
  ['slow', 'Slow'],
];

const SWIPE_OPTIONS: [SwipeAction, string][] = [
  ['none', 'Nothing'],
  ['archive', 'Archive'],
  ['delete', 'Delete'],
  ['toggleRead', 'Mark read / unread'],
  ['toggleFlag', 'Flag / unflag'],
];

export function SettingsDialog({ prefs, hasPassword, onClose }: { prefs: Preferences; hasPassword: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [v, setV] = useState(prefs);
  const [error, setError] = useState<string | null>(null);

  const save = async (next: Preferences) => {
    setV(next);
    try {
      await api.savePreferences(next);
      await qc.invalidateQueries({ queryKey: ['me'] });
      await qc.invalidateQueries({ queryKey: ['messages'] });
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" style={{ width: 'min(460px, 100%)' }}>
        <div className="dialog-head">
          <h2>Settings</h2>
          <button className="icon-btn" onClick={onClose} title="Close">
            <X size={17} />
          </button>
        </div>
        <div className="dialog-body">
          <div>
            <label className="label">Appearance</label>
            <div className="segmented">
              {(['system', 'light', 'dark'] as const).map((t) => (
                <button key={t} className={v.theme === t ? 'on' : ''} onClick={() => void save({ ...v, theme: t })} style={{ padding: '6px 14px' }}>
                  {t === 'system' ? 'System' : t === 'light' ? 'Light' : 'Dark'}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="label">Messages per page</label>
            <select className="select" value={v.pageSize} onChange={(e) => void save({ ...v, pageSize: Number(e.target.value) })}>
              {[25, 50, 100].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
          <div className="grid2">
            {(['swipeRight', 'swipeLeft'] as const).map((key) => (
              <div key={key}>
                <label className="label">{key === 'swipeRight' ? 'Swipe right' : 'Swipe left'}</label>
                <select className="select" value={v[key]} onChange={(e) => void save({ ...v, [key]: e.target.value as SwipeAction })}>
                  {SWIPE_OPTIONS.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
          <label className="check">
            <input type="checkbox" checked={v.markReadOnOpen} onChange={(e) => void save({ ...v, markReadOnOpen: e.target.checked })} />
            Mark messages as read when opened
          </label>
          <div>
            <label className="label" htmlFor="screen-transitions">
              Screen Transitions
            </label>
            <select
              id="screen-transitions"
              className="select"
              value={v.screenTransitions}
              onChange={(e) => void save({ ...v, screenTransitions: e.target.value as TransitionSpeed })}
            >
              {TRANSITION_OPTIONS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <div className="hint">On phones, the squirrel runs across the screen when you open the menu or a message.</div>
          </div>
          <Notifications prefs={v} save={save} />
          <EmailLinks />
          <ImageDomains />
          {hasPassword && <ChangePassword />}
          {error && <div className="error-text">{error}</div>}
        </div>
      </div>
    </div>
  );
}

function ChangePassword() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const submit = async () => {
    setDone(false);
    if (next !== confirm) return setError('New passwords do not match');
    setBusy(true);
    setError(null);
    try {
      await api.changePassword(current, next);
      setCurrent('');
      setNext('');
      setConfirm('');
      setDone(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="password-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label className="label">Change password</label>
      <input type="text" name="username" autoComplete="username" hidden readOnly />
      <input className="input" type="password" autoComplete="current-password" placeholder="Current password" aria-label="Current password" required maxLength={1000} value={current} onChange={(e) => setCurrent(e.target.value)} />
      <input className="input" type="password" autoComplete="new-password" placeholder="New password (at least 10 characters)" aria-label="New password" required minLength={10} maxLength={256} value={next} onChange={(e) => setNext(e.target.value)} />
      <input className="input" type="password" autoComplete="new-password" placeholder="Repeat new password" aria-label="Repeat new password" required maxLength={256} value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      <div>
        <button className="btn" type="submit" disabled={busy}>
          Change password
        </button>
      </div>
      {done && <div className="hint">Password changed.</div>}
      {error && <div className="error-text">{error}</div>}
    </form>
  );
}

/** Sender domains whose mail loads remote images automatically (subdomains included). */
function ImageDomains() {
  const qc = useQueryClient();
  const domains = useQuery({ queryKey: ['imageDomains'], queryFn: api.imageDomains });
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const change = async (run: () => Promise<DomainName[]>) => {
    setBusy(true);
    setError(null);
    try {
      qc.setQueryData(['imageDomains'], await run());
      await qc.invalidateQueries({ queryKey: ['message'] });
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    if (input.trim() && (await change(() => api.addImageDomain(input.trim())))) setInput('');
  };

  return (
    <div>
      <label className="label">Always load images from</label>
      {domains.data && domains.data.length > 0 ? (
        <ul className="domain-list">
          {domains.data.map((d) => (
            <li key={d.domain}>
              <span title={d.display !== d.domain ? d.domain : undefined}>{d.display}</span>
              <button className="icon-btn" disabled={busy} title={`Remove ${d.display}`} onClick={() => void change(() => api.removeImageDomain(d.domain))}>
                <X size={15} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="hint">{domains.isLoading ? 'Loading…' : 'No domains yet. Images from other senders stay blocked until you load them.'}</div>
      )}
      <form
        className="domain-add"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <input className="input" value={input} onChange={(e) => setInput(e.target.value)} placeholder="example.com" aria-label="Domain to allow" maxLength={300} />
        <button className="btn" type="submit" disabled={busy || !input.trim()}>
          Add
        </button>
      </form>
      <div className="hint">Also covers subdomains. Not applied to messages that fail the sender check (DMARC).</div>
      {(error || domains.error) && <div className="error-text">{error ?? (domains.error as Error).message}</div>}
    </div>
  );
}

/** Ask the browser to open mailto: links (on any website) in Ratatoskr. */
function EmailLinks() {
  const [asked, setAsked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const supported = window.isSecureContext && typeof navigator.registerProtocolHandler === 'function';

  const register = () => {
    setError(null);
    try {
      navigator.registerProtocolHandler('mailto', handlerTemplate(window.location.origin));
      setAsked(true);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div>
      <label className="label">Email links</label>
      {supported ? (
        <>
          <button className="btn" onClick={register}>
            Open email links with Ratatoskr
          </button>
          <div className="hint">
            {asked
              ? 'Confirm in your browser’s prompt (some browsers show it as an icon in the address bar). You can undo this in the browser’s settings.'
              : 'Makes mailto: links on any website open a new message here. Links in your mail always do.'}
          </div>
        </>
      ) : (
        <div className="hint">
          {window.isSecureContext
            ? 'This browser can’t send mailto: links on other websites to Ratatoskr. Links in your mail still open a new message here.'
            : 'Opening mailto: links from other websites needs the app to be served over HTTPS.'}
        </div>
      )}
      {error && <div className="error-text">{error}</div>}
    </div>
  );
}

/** Web Push on this device, plus how much the notifications may reveal (a per-user preference). */
function Notifications({ prefs, save }: { prefs: Preferences; save: (p: Preferences) => Promise<void> }) {
  const [availability, setAvailability] = useState<PushAvailability>(() => pushAvailability(currentEnvironment()));
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  useEffect(() => {
    if (availability !== 'available') return setEnabled(false);
    void currentSubscription()
      .then((sub) => setEnabled(!!sub && Notification.permission === 'granted'))
      .catch(() => setEnabled(false));
  }, [availability]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      setAvailability(pushAvailability(currentEnvironment()));
    }
  };

  const toggle = (on: boolean) =>
    run(async () => {
      if (on) await enablePush();
      else await disablePush();
      setEnabled(on);
    });

  const test = () =>
    run(async () => {
      const { delivered } = await api.testPush();
      setInfo(delivered > 0 ? `Sent to ${delivered} device${delivered === 1 ? '' : 's'}.` : 'No device accepted the notification.');
    });

  return (
    <div>
      <label className="label">Notifications</label>
      {availability === 'needs-install' && (
        <div className="hint">
          On iPhone and iPad, notifications only work once Ratatoskr is on your Home Screen. Tap the Share button, choose
          “Add to Home Screen”, then open Ratatoskr from there and come back here.
        </div>
      )}
      {availability === 'denied' && (
        <div className="hint">Notifications are blocked for this site. Allow them in your browser’s site settings, then reopen this dialog.</div>
      )}
      {availability === 'unsupported' && (
        <div className="hint">
          {window.isSecureContext ? 'This browser does not support notifications.' : 'Notifications need the app to be served over HTTPS.'}
        </div>
      )}
      {availability === 'available' && (
        <div className="notify-row">
          <label className="check">
            <input type="checkbox" checked={!!enabled} disabled={busy || enabled === null} onChange={(e) => void toggle(e.target.checked)} />
            Notify me about new mail on this device
          </label>
          {enabled && (
            <button className="btn" disabled={busy} onClick={() => void test()}>
              Send test
            </button>
          )}
        </div>
      )}
      <div style={{ marginTop: 10 }}>
        <label className="label" htmlFor="notify-content">
          Show in notifications
        </label>
        <select
          id="notify-content"
          className="select"
          value={prefs.notificationContent}
          onChange={(e) => void save({ ...prefs, notificationContent: e.target.value as NotificationContent })}
        >
          <option value="full">Sender and subject</option>
          <option value="minimal">Only “New message” and the account</option>
        </select>
      </div>
      <div className="hint">
        You get a notification for new unread mail in your inboxes while Ratatoskr isn’t open in front of you. Notifications pass through
        Apple’s or Google’s push service, encrypted so that only your device can read them.
      </div>
      {info && <div className="hint">{info}</div>}
      {error && <div className="error-text">{error}</div>}
    </div>
  );
}
