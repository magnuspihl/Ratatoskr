import type { AccountFolders } from './types.js';

/** Unread messages across every account's INBOX: the number shown on the app icon badge. */
export function inboxUnread(accounts: AccountFolders[]): number {
  let total = 0;
  for (const acc of accounts) {
    const inbox = acc.folders.find((f) => f.path.toUpperCase() === 'INBOX') ?? acc.folders.find((f) => f.specialUse === 'inbox');
    total += inbox?.unread ?? 0;
  }
  return total;
}
