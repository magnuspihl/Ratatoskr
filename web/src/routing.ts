/**
 * Navigation state <-> URL. Pure functions, no DOM access, so they can be unit tested.
 *
 *   /                                     unified inbox (all accounts' INBOX)
 *   /mail/<accountId>/<folder>            a folder of one account (folder is URI-encoded)
 *   ...?q=<text>                          server-side search in that view
 *   ...&unread=1                          only unread messages (IMAP UNSEEN, on the server)
 *   ...?open=<accountId>.<uidValidity>.<uid>
 *                                         an open message. Its folder is always the list's
 *                                         folder (INBOX in the unified view), so it isn't repeated.
 *
 * Overlays (compose, settings, accounts, the phone folder drawer) are not part of the URL: they
 * live in history.state on an entry with the same URL, so Back closes them and a reload doesn't
 * reopen a half-written message.
 */

export interface OpenMessage {
  accountId: string;
  uidValidity: string;
  uid: number;
}

export interface Route {
  /** null = unified inbox */
  accountId: string | null;
  folder: string;
  q: string;
  unread: boolean;
  open: OpenMessage | null;
}

export type Overlay = 'compose' | 'settings' | 'accounts' | 'nav';

export interface HistoryState {
  /** Set on entries the app pushed itself; Back from them stays inside the app. */
  app: true;
  overlay?: Overlay;
}

export const HOME: Route = { accountId: null, folder: 'INBOX', q: '', unread: false, open: null };

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function parseOpen(raw: string | null): OpenMessage | null {
  if (!raw) return null;
  const m = /^([A-Za-z0-9_-]{1,64})\.(\d{1,20})\.(\d{1,10})$/.exec(raw);
  if (!m) return null;
  const uid = Number(m[3]);
  if (!Number.isSafeInteger(uid) || uid < 1) return null;
  return { accountId: m[1]!, uidValidity: m[2]!, uid };
}

export function parseLocation(pathname: string, search: string): Route {
  const params = new URLSearchParams(search);
  const q = (params.get('q') ?? '').slice(0, 500);
  const unread = params.get('unread') === '1';
  const open = parseOpen(params.get('open'));
  const parts = pathname.split('/').filter(Boolean);
  if (parts[0] === 'mail' && parts.length >= 3) {
    const accountId = parts[1]!;
    let folder: string;
    try {
      // Folder paths may contain '/', which is encoded; tolerate an unencoded one too.
      folder = parts.slice(2).map(decodeURIComponent).join('/');
    } catch {
      return { ...HOME };
    }
    if (!ID_RE.test(accountId) || !folder || folder.length > 1000) return { ...HOME };
    // An open message must belong to the account whose folder is shown.
    return { accountId, folder, q, unread, open: open && open.accountId === accountId ? open : null };
  }
  return { accountId: null, folder: 'INBOX', q, unread, open };
}

export function buildUrl(route: Route): string {
  const path = route.accountId ? `/mail/${encodeURIComponent(route.accountId)}/${encodeURIComponent(route.folder)}` : '/';
  const params = new URLSearchParams();
  if (route.q) params.set('q', route.q);
  if (route.unread) params.set('unread', '1');
  if (route.open) params.set('open', `${route.open.accountId}.${route.open.uidValidity}.${route.open.uid}`);
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

export function sameRoute(a: Route, b: Route): boolean {
  return buildUrl(a) === buildUrl(b);
}

/** The folder an open message lives in, given the route it was opened from. */
export function openMessageFolder(route: Route): string {
  return route.accountId ? route.folder : 'INBOX';
}

/** The list a message view belongs to (used for "back" and for stale-message fallback). */
export function listRoute(route: Route): Route {
  return { ...route, open: null };
}

export function readHistoryState(state: unknown): HistoryState | null {
  if (!state || typeof state !== 'object' || (state as HistoryState).app !== true) return null;
  const overlay = (state as HistoryState).overlay;
  const valid: Overlay[] = ['compose', 'settings', 'accounts', 'nav'];
  return { app: true, ...(overlay && valid.includes(overlay) ? { overlay } : {}) };
}

/** Identity of a list view (what the list shows, ignoring which message is open). */
export function viewKey(route: Route): string {
  return buildUrl(listRoute(route));
}
