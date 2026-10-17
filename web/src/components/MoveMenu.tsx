import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { AccountFolders } from '../../../shared/types';

interface Props {
  account: AccountFolders | undefined;
  exclude?: string;
  disabled?: boolean;
  icon: ReactNode;
  onMove: (path: string) => void;
}

export function MoveMenu({ account, exclude, disabled, icon, onMove }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const targets = (account?.folders ?? []).filter((f) => f.selectable && f.path !== exclude);
  return (
    <div className="menu-wrap" ref={ref}>
      <button className="icon-btn" title={disabled ? 'Select messages from one account to move' : 'Move to…'} disabled={disabled} onClick={() => setOpen((o) => !o)}>
        {icon}
      </button>
      {open && (
        <div className="menu">
          <div className="menu-label">Move to</div>
          {targets.map((f) => (
            <button
              key={f.path}
              onClick={() => {
                setOpen(false);
                onMove(f.path);
              }}
            >
              {f.specialUse === 'inbox' ? 'Inbox' : f.path}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
