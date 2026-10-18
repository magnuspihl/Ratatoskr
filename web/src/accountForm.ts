import type { AccountDefaults, AccountInput } from '../../shared/types';
import { ACCOUNT_COLORS } from './util';

/** A new account's form, starting from the admin's defaults (already filled in for this user). */
export function newAccountInput(n: number, defaults: AccountDefaults): AccountInput {
  return {
    name: defaults.name,
    displayName: defaults.displayName,
    email: defaults.email,
    color: ACCOUNT_COLORS[n % ACCOUNT_COLORS.length]!,
    imap: { ...defaults.imap, password: '' },
    smtp: { ...defaults.smtp, password: '' },
    appendSent: true,
  };
}

/**
 * Will a blank password on a new account be replaced by the admin's default password? Mirrors the
 * server: only while the server is still the default one.
 */
export function usesDefaultPassword(defaults: AccountDefaults, kind: 'imap' | 'smtp', host: string): boolean {
  const def = defaults[kind].host;
  return defaults.password && def !== '' && def.trim().toLowerCase() === host.trim().toLowerCase();
}
