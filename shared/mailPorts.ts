import type { TlsMode } from './types.js';

/** Standard ports for each protocol and security mode. */
export const DEFAULT_PORTS: Record<'imap' | 'smtp', Record<TlsMode, number>> = {
  imap: { tls: 993, starttls: 143, none: 143 },
  smtp: { tls: 465, starttls: 587, none: 25 },
};
