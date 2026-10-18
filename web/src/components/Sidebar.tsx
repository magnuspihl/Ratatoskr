import {
  AlarmClock,
  Archive,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  File,
  Folder,
  Inbox,
  LogOut,
  PenSquare,
  Send,
  Settings,
  ShieldAlert,
  Star,
  Trash2,
  UserCog,
  Layers,
  X,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import type { AccountFolders, AccountView, FolderView, SpecialUse } from '../../../shared/types';
import type { MailboxSel } from '../api';

const SPECIAL_ICON: Record<SpecialUse, ReactNode> = {
  inbox: <Inbox size={16} />,
  sent: <Send size={16} />,
  drafts: <File size={16} />,
  trash: <Trash2 size={16} />,
  archive: <Archive size={16} />,
  junk: <ShieldAlert size={16} />,
  all: <Layers size={16} />,
  flagged: <Star size={16} />,
  snoozed: <AlarmClock size={16} />,
};
const SPECIAL_ORDER: SpecialUse[] = ['inbox', 'snoozed', 'drafts', 'sent', 'archive', 'junk', 'trash'];

function sortFolders(folders: FolderView[]): FolderView[] {
  const rank = (f: FolderView) => {
    const i = f.specialUse ? SPECIAL_ORDER.indexOf(f.specialUse) : -1;
    return i === -1 ? 100 : i;
  };
  return [...folders].sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path));
}

function depth(f: FolderView): number {
  if (!f.parentPath || !f.delimiter) return 0;
  return f.parentPath.split(f.delimiter).length;
}

interface Props {
  accounts: AccountView[];
  folders: AccountFolders[] | undefined;
  sel: MailboxSel;
  onSelect: (sel: MailboxSel) => void;
  onCompose: () => void;
  onAccounts: () => void;
  onSettings: () => void;
  onLogout: () => void;
  userLabel: string;
  onCloseNav: () => void;
}

export function Sidebar({ accounts, folders, sel, onSelect, onCompose, onAccounts, onSettings, onLogout, userLabel, onCloseNav }: Props) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [rail, setRail] = useState(() => localStorage.getItem('navRail') === '1');
  useEffect(() => localStorage.setItem('navRail', rail ? '1' : '0'), [rail]);
  const totalUnread = (folders ?? []).reduce((sum, a) => sum + (a.folders.find((f) => f.specialUse === 'inbox')?.unread ?? 0), 0);

  return (
    <aside className={`pane sidebar ${rail ? 'rail' : ''}`}>
      <div className="brand">
        <img className="brand-mark" src="/favicon.svg" alt="" />
        <span className="name" style={{ flex: 1 }}>Ratatoskr</span>
        <button className="icon-btn mobile-only" title="Close" onClick={onCloseNav}>
          <X size={18} />
        </button>
      </div>
      <button className="btn primary compose-btn" onClick={onCompose} disabled={accounts.length === 0} title="Compose">
        <PenSquare size={16} /> <span className="name">Compose</span>
      </button>
      <nav className="nav">
        {accounts.length > 1 && (
          <button
            className={`nav-item ${sel.accountId === null ? 'active' : ''} ${totalUnread ? 'unread' : ''}`}
            onClick={() => onSelect({ accountId: null, folder: 'INBOX' })}
            title="All inboxes"
          >
            <Layers size={16} />
            <span className="name">All inboxes</span>
            {totalUnread > 0 && <span className="count">{totalUnread}</span>}
          </button>
        )}
        {accounts.map((acc) => {
          const af = folders?.find((f) => f.accountId === acc.id);
          const isCollapsed = !rail && collapsed[acc.id];
          return (
            <div className="nav-section" key={acc.id}>
              <button
                className="nav-heading"
                onClick={() => setCollapsed((c) => ({ ...c, [acc.id]: !c[acc.id] }))}
                title={acc.name}
              >
                {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                <span className="dot" style={{ background: acc.color }} />
                <span className="name" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{acc.name}</span>
              </button>
              {!isCollapsed && (
                <>
                  {!af && <div className="nav-error muted">Loading…</div>}
                  {af?.error && <div className="nav-error">{af.error}</div>}
                  {af &&
                    sortFolders(af.folders).map((f) => {
                      const active = sel.accountId === acc.id && sel.folder === f.path;
                      const showCount = f.unread && f.specialUse !== 'sent' && f.specialUse !== 'drafts' && f.specialUse !== 'trash' && f.specialUse !== 'snoozed';
                      return (
                        <button
                          key={f.path}
                          className={`nav-item ${active ? 'active' : ''} ${showCount ? 'unread' : ''}`}
                          disabled={!f.selectable}
                          style={{ paddingLeft: rail ? undefined : 8 + depth(f) * 14, opacity: f.selectable ? 1 : 0.6 }}
                          onClick={() => onSelect({ accountId: acc.id, folder: f.path })}
                          title={f.path}
                        >
                          {f.specialUse ? SPECIAL_ICON[f.specialUse] : <Folder size={16} />}
                          <span className="name">{f.specialUse === 'inbox' ? 'Inbox' : f.name}</span>
                          {showCount ? <span className="count">{f.unread}</span> : null}
                        </button>
                      );
                    })}
                </>
              )}
            </div>
          );
        })}
      </nav>
      <div className="sidebar-footer">
        <span className="who name" title={userLabel}>
          {userLabel}
        </span>
        <button className="icon-btn" title="Accounts" onClick={onAccounts}>
          <UserCog size={17} />
        </button>
        <button className="icon-btn" title="Settings" onClick={onSettings}>
          <Settings size={17} />
        </button>
        <button className="icon-btn" title="Sign out" onClick={onLogout}>
          <LogOut size={17} />
        </button>
        <button
          className="icon-btn rail-toggle desktop-only"
          title={rail ? 'Expand sidebar' : 'Collapse sidebar'}
          onClick={() => setRail((r) => !r)}
        >
          {rail ? <ChevronRight size={17} /> : <ChevronLeft size={17} />}
        </button>
      </div>
    </aside>
  );
}
