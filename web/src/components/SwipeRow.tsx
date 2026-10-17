import { Archive, Flag, Mail, MailOpen, Trash2 } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
import type { SwipeAction } from '../../../shared/types';
import { dragOffset, isArmed, lockAxis, releaseOutcome, type Axis, type Direction } from '../swipe';

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

interface Look {
  label: string;
  color: string;
  icon: ReactNode;
}

function look(action: SwipeAction, seen: boolean, flagged: boolean): Look | null {
  switch (action) {
    case 'delete':
      return { label: 'Delete', color: 'var(--swipe-delete)', icon: <Trash2 size={20} /> };
    case 'archive':
      return { label: 'Archive', color: 'var(--swipe-archive)', icon: <Archive size={20} /> };
    case 'toggleRead':
      return seen
        ? { label: 'Unread', color: 'var(--swipe-read)', icon: <Mail size={20} /> }
        : { label: 'Read', color: 'var(--swipe-read)', icon: <MailOpen size={20} /> };
    case 'toggleFlag':
      return { label: flagged ? 'Unflag' : 'Flag', color: 'var(--swipe-flag)', icon: <Flag size={20} /> };
    default:
      return null;
  }
}

interface Props {
  left: SwipeAction;
  right: SwipeAction;
  seen: boolean;
  flagged: boolean;
  /** Whether the triggered action removes the row (animate out) or just changes it (snap back). */
  removes: (dir: Direction) => boolean;
  /** Last chance to cancel (e.g. confirm a permanent delete). */
  confirm: (dir: Direction) => boolean;
  onSwipe: (dir: Direction) => void;
  className: string;
  onClick: (e: React.MouseEvent) => void;
  children: ReactNode;
}

interface Gesture {
  id: number;
  x: number;
  y: number;
  axis: Axis;
  width: number;
  samples: { x: number; t: number }[];
  dx: number;
}

/**
 * A list row that can be swiped left/right. The browser keeps vertical scrolling (touch-action:
 * pan-y); a gesture only becomes a swipe once horizontal movement clearly dominates.
 */
export function SwipeRow({ left, right, seen, flagged, removes, confirm, onSwipe, className, onClick, children }: Props) {
  const outer = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const g = useRef<Gesture | null>(null);
  const suppressClick = useRef(false);
  const [dir, setDir] = useState<Direction | null>(null);
  const [armed, setArmed] = useState(false);
  const leftLook = look(left, seen, flagged);
  const rightLook = look(right, seen, flagged);
  const enabled = { left: !!leftLook, right: !!rightLook };

  const setX = (x: number, animate: boolean) => {
    const el = content.current;
    if (!el) return;
    el.style.transition = animate && !reducedMotion() ? 'transform 180ms ease-out' : 'none';
    el.style.transform = x ? `translate3d(${x}px,0,0)` : '';
  };

  const reset = () => {
    g.current = null;
    setX(0, true);
    window.setTimeout(() => {
      setDir(null);
      setArmed(false);
    }, reducedMotion() ? 0 : 180);
  };

  const commit = (d: Direction, width: number) => {
    if (!confirm(d)) return reset();
    g.current = null;
    if (!removes(d)) {
      onSwipe(d);
      return reset();
    }
    if (reducedMotion()) return onSwipe(d);
    setX(d === 'left' ? -width : width, true);
    window.setTimeout(() => {
      const el = outer.current;
      if (el) {
        el.style.height = `${el.offsetHeight}px`;
        void el.offsetHeight; // force layout so the height transition runs
        el.style.transition = 'height 160ms ease-out, opacity 160ms';
        el.style.height = '0px';
        el.style.opacity = '0';
      }
      window.setTimeout(() => onSwipe(d), 160);
    }, 180);
  };

  return (
    <div
      ref={outer}
      className="swipe"
      onPointerDown={(e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        if (!enabled.left && !enabled.right) return;
        g.current = { id: e.pointerId, x: e.clientX, y: e.clientY, axis: 'pending', width: outer.current?.offsetWidth ?? 0, samples: [], dx: 0 };
        suppressClick.current = false;
      }}
      onPointerMove={(e) => {
        const s = g.current;
        if (!s || s.id !== e.pointerId) return;
        const dx = e.clientX - s.x;
        const dy = e.clientY - s.y;
        const axis = lockAxis(s.axis, dx, dy);
        if (axis === 'vertical') {
          g.current = null; // a scroll: leave it to the browser
          return;
        }
        if (axis === 'pending') return;
        if (s.axis !== 'horizontal') {
          s.axis = 'horizontal';
          suppressClick.current = true;
          outer.current?.setPointerCapture(e.pointerId);
        }
        s.dx = dx;
        s.samples.push({ x: e.clientX, t: e.timeStamp });
        if (s.samples.length > 6) s.samples.shift();
        const shown = dragOffset(dx, enabled.left, enabled.right);
        setX(shown, false);
        const d: Direction = dx < 0 ? 'left' : 'right';
        if (d !== dir) setDir(d);
        const a = isArmed(shown, s.width);
        if (a !== armed) setArmed(a);
      }}
      onPointerUp={(e) => {
        const s = g.current;
        if (!s || s.id !== e.pointerId || s.axis !== 'horizontal') {
          g.current = null;
          return;
        }
        const first = s.samples[0];
        const last = s.samples[s.samples.length - 1];
        const velocity = first && last && last.t > first.t ? (last.x - first.x) / (last.t - first.t) : 0;
        const outcome = releaseOutcome(s.dx, velocity, s.width, enabled);
        if (outcome) commit(outcome, s.width);
        else reset();
      }}
      onPointerCancel={() => g.current && reset()}
      onClickCapture={(e) => {
        if (suppressClick.current) {
          e.stopPropagation();
          e.preventDefault();
          suppressClick.current = false;
        }
      }}
    >
      {dir && (dir === 'right' ? rightLook : leftLook) && (
        <div
          className={`swipe-bg ${dir} ${armed ? 'armed' : ''}`}
          style={{ background: (dir === 'right' ? rightLook : leftLook)!.color }}
          aria-hidden="true"
        >
          {(dir === 'right' ? rightLook : leftLook)!.icon}
          <span>{(dir === 'right' ? rightLook : leftLook)!.label}</span>
        </div>
      )}
      <div ref={content} className={className} onClick={onClick}>
        {children}
      </div>
    </div>
  );
}
