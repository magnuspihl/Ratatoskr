import {
  Archive,
  ChevronDown,
  ChevronRight,
  File,
  Folder,
  Inbox,
  LogOut,
  Mail,
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
import { useState, type ReactNode } from 'react';
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
};
const SPECIAL_ORDER: SpecialUse[] = ['inbox', 'drafts', 'sent', 'archive', 'junk', 'trash'];

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
  const totalUnread = (folders ?? []).reduce((sum, a) => sum + (a.folders.find((f) => f.specialUse === 'inbox')?.unread ?? 0), 0);

  return (
    <aside className="pane sidebar">
      <div className="brand">
        <div className="brand-mark">
          <Mail size={15} />
        </div>
        <span style={{ flex: 1 }}>Ratatoskr</span>
        <button className="icon-btn mobile-only" title="Close" onClick={onCloseNav}>
          <X size={18} />
        </button>
      </div>
      <button className="btn primary compose-btn" onClick={onCompose} disabled={accounts.length === 0}>
        <PenSquare size={16} /> Compose
      </button>
      <nav className="nav">
        {accounts.length > 1 && (
          <button
            className={`nav-item ${sel.accountId === null ? 'active' : ''} ${totalUnread ? 'unread' : ''}`}
            onClick={() => onSelect({ accountId: null, folder: 'INBOX' })}
          >
            <Layers size={16} />
            <span className="name">All inboxes</span>
            {totalUnread > 0 && <span className="count">{totalUnread}</span>}
          </button>
        )}
        {accounts.map((acc) => {
          const af = folders?.find((f) => f.accountId === acc.id);
          const isCollapsed = collapsed[acc.id];
          return (
            <div className="nav-section" key={acc.id}>
              <button className="nav-heading" onClick={() => setCollapsed((c) => ({ ...c, [acc.id]: !c[acc.id] }))}>
                {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                <span className="dot" style={{ background: acc.color }} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{acc.name}</span>
              </button>
              {!isCollapsed && (
                <>
                  {!af && <div className="nav-error muted">Loading…</div>}
                  {af?.error && <div className="nav-error">{af.error}</div>}
                  {af &&
                    sortFolders(af.folders).map((f) => {
                      const active = sel.accountId === acc.id && sel.folder === f.path;
                      const showCount = f.unread && f.specialUse !== 'sent' && f.specialUse !== 'drafts' && f.specialUse !== 'trash';
                      return (
                        <button
                          key={f.path}
                          className={`nav-item ${active ? 'active' : ''} ${showCount ? 'unread' : ''}`}
                          disabled={!f.selectable}
                          style={{ paddingLeft: 8 + depth(f) * 14, opacity: f.selectable ? 1 : 0.6 }}
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
        <span className="who" title={userLabel}>
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
      </div>
    </aside>
  );
}
