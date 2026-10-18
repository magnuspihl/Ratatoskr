import { AlarmClock } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { defaultCustomTime, formatSnoozeTime, fromLocalInput, snoozePresets, toLocalInput } from '../snooze';

interface Props {
  disabled?: boolean;
  iconSize: number;
  /** Opens the menu whenever this number changes (keyboard shortcut). */
  openSignal?: number;
  onSnooze: (until: Date) => void;
}

/** Snooze button: quick choices plus a date and time picker. */
export function SnoozeMenu({ disabled, iconSize, openSignal, onSnooze }: Props) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState('');
  const [now, setNow] = useState(() => new Date());
  const ref = useRef<HTMLDivElement>(null);
  const first = useRef(openSignal);

  const show = () => {
    const n = new Date();
    setNow(n);
    setCustom(toLocalInput(defaultCustomTime(n)));
    setOpen(true);
  };
  useEffect(() => {
    if (openSignal !== first.current && !disabled) show();
  }, [openSignal, disabled]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  const pick = (d: Date) => {
    setOpen(false);
    onSnooze(d);
  };
  const customDate = fromLocalInput(custom);
  const customOk = !!customDate && customDate.getTime() > Date.now();

  return (
    <div className="menu-wrap" ref={ref}>
      <button className="icon-btn" title="Snooze (b)" disabled={disabled} onClick={() => (open ? setOpen(false) : show())}>
        <AlarmClock size={iconSize} />
      </button>
      {open && (
        <div className="menu snooze-menu">
          <div className="menu-label">Snooze until</div>
          {snoozePresets(now).map((p) => (
            <button key={p.id} onClick={() => pick(p.until)}>
              <span className="grow">{p.label}</span>
              <span className="muted">{formatSnoozeTime(p.until, now)}</span>
            </button>
          ))}
          <form
            className="snooze-custom"
            onSubmit={(e) => {
              e.preventDefault();
              if (customOk) pick(customDate);
            }}
          >
            <div className="menu-label">Pick date &amp; time</div>
            <input
              className="input"
              type="datetime-local"
              value={custom}
              min={toLocalInput(now)}
              onChange={(e) => setCustom(e.target.value)}
              aria-label="Snooze until date and time"
            />
            <button type="submit" className="btn primary" disabled={!customOk}>
              Snooze
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
