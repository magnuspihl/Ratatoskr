import { describe, expect, it } from 'vitest';
import type { AccountDefaults } from '../../shared/types';
import { newAccountInput, usesDefaultPassword } from '../src/accountForm';

const defaults: AccountDefaults = {
  name: '',
  displayName: '',
  email: 'alice@example.org',
  imap: { host: 'imap.example.net', port: 993, tls: 'tls', user: 'alice@example.org' },
  smtp: { host: 'smtp.example.net', port: 465, tls: 'tls', user: 'alice@example.org' },
  password: true,
};

describe('new account form', () => {
  it("starts with the admin's servers and username, and blank passwords", () => {
    const v = newAccountInput(0, defaults);
    expect(v.email).toBe('alice@example.org');
    expect(v.imap).toEqual({ host: 'imap.example.net', port: 993, tls: 'tls', user: 'alice@example.org', password: '' });
    expect(v.smtp).toEqual({ host: 'smtp.example.net', port: 465, tls: 'tls', user: 'alice@example.org', password: '' });
  });

  it('tells the user a blank password means the default one, but only for the default server', () => {
    expect(usesDefaultPassword(defaults, 'imap', 'imap.example.net')).toBe(true);
    expect(usesDefaultPassword(defaults, 'imap', 'imap.gmail.com')).toBe(false);
    expect(usesDefaultPassword({ ...defaults, password: false }, 'imap', 'imap.example.net')).toBe(false);
    expect(usesDefaultPassword({ ...defaults, imap: { ...defaults.imap, host: '' } }, 'imap', '')).toBe(false);
  });
});
