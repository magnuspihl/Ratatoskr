import { describe, expect, it } from 'vitest';
import { isIosDevice, notificationTarget, pushAvailability, sameServerKey, type PushEnvironment } from '../src/push';

const desktop: PushEnvironment = {
  secure: true,
  serviceWorker: true,
  pushManager: true,
  notification: true,
  permission: 'default',
  ios: false,
  standalone: false,
};

describe('whether notifications can be turned on', () => {
  it('can on a desktop or Android browser over HTTPS', () => {
    expect(pushAvailability(desktop)).toBe('available');
  });

  it('asks iPhone and iPad users in a Safari tab to add the app to the Home Screen first', () => {
    expect(pushAvailability({ ...desktop, ios: true, standalone: false, pushManager: false })).toBe('needs-install');
  });

  it('can in the iPhone Home Screen app', () => {
    expect(pushAvailability({ ...desktop, ios: true, standalone: true })).toBe('available');
  });

  it('explains when the user blocked notifications for the site', () => {
    expect(pushAvailability({ ...desktop, permission: 'denied' })).toBe('denied');
  });

  it('cannot without HTTPS or without push support in the browser', () => {
    expect(pushAvailability({ ...desktop, secure: false })).toBe('unsupported');
    expect(pushAvailability({ ...desktop, pushManager: false })).toBe('unsupported');
    expect(pushAvailability({ ...desktop, serviceWorker: false })).toBe('unsupported');
  });
});

describe('recognising iPhones and iPads', () => {
  it('recognises iPhones, and iPads that pretend to be a Mac', () => {
    expect(isIosDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15', 5)).toBe(true);
    expect(isIosDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15', 5)).toBe(true);
  });

  it('does not mistake a real Mac or an Android phone for one', () => {
    expect(isIosDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15', 0)).toBe(false);
    expect(isIosDevice('Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36', 5)).toBe(false);
  });
});

describe('noticing a changed server key', () => {
  const key = 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4';
  const bytes = (s: string) => Uint8Array.from(Buffer.from(s, 'base64url')).buffer;

  it('treats a subscription made with the current key as current', () => {
    expect(sameServerKey(bytes(key), key)).toBe(true);
  });

  it('treats a subscription made with another key (or none) as stale', () => {
    const other = Buffer.from(key, 'base64url');
    other[10] ^= 1;
    expect(sameServerKey(Uint8Array.from(other).buffer, key)).toBe(false);
    expect(sameServerKey(null, key)).toBe(false);
  });
});

describe('where a tapped notification leads', () => {
  const origin = 'https://mail.example.com';

  it('opens paths of the app itself', () => {
    expect(notificationTarget('/?open=acc1.42.7', origin)).toBe('/?open=acc1.42.7');
    expect(notificationTarget('https://mail.example.com/mail/acc1/INBOX', origin)).toBe('/mail/acc1/INBOX');
  });

  it('never leaves the app', () => {
    expect(notificationTarget('https://evil.example/phish', origin)).toBeNull();
    expect(notificationTarget('//evil.example/phish', origin)).toBeNull();
    expect(notificationTarget('javascript:alert(1)', origin)).toBeNull();
    expect(notificationTarget(42, origin)).toBeNull();
  });
});
