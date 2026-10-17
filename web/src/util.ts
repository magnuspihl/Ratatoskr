import type { Address, MessageRef, MessageSummary } from '../../shared/types';

export const toRef = (m: Pick<MessageSummary, 'accountId' | 'folder' | 'uid' | 'uidValidity'>): MessageRef => ({
  accountId: m.accountId,
  folder: m.folder,
  uid: m.uid,
  uidValidity: m.uidValidity,
});

export const refKey = (r: MessageRef) => `${r.accountId}|${r.folder}|${r.uidValidity}|${r.uid}`;

export function formatAddress(a: Address): string {
  if (!a.name) return a.address;
  const needsQuotes = /[",;<>@()[\]:\\]/.test(a.name);
  return `${needsQuotes ? `"${a.name.replace(/["\\]/g, '\\$&')}"` : a.name} <${a.address}>`;
}

export const displayName = (a: Address | undefined) => (a ? a.name || a.address : '');

export function formatListDate(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  if (now.getTime() - d.getTime() < 6 * 86400e3 && d < now) return d.toLocaleDateString(undefined, { weekday: 'short' });
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export const formatFullDate = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function initials(a: Address | undefined): string {
  const s = (a?.name || a?.address || '?').replace(/["']/g, '').trim();
  const parts = s.split(/[\s.@_-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '?') + (parts.length > 1 ? (parts[1]?.[0] ?? '') : '')).toUpperCase();
}

/** Deterministic pleasant colour for an avatar. */
export function avatarColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return `hsl(${h} 55% 48%)`;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function textToHtml(text: string): string {
  return escapeHtml(text).replace(/\r?\n/g, '<br>');
}

export function prefixSubject(prefix: 'Re' | 'Fwd', subject: string): string {
  const re = prefix === 'Re' ? /^\s*(re|aw|sv|antw)\s*:/i : /^\s*(fwd?|wg|vs)\s*:/i;
  return re.test(subject) ? subject : `${prefix}: ${subject}`;
}

export const ACCOUNT_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316'];
