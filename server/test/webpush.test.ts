import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Keyring } from '../src/crypto.js';
import { encryptPayload, isAllowedPushEndpoint, vapidAuthorization, vapidKeysFromSeed } from '../src/push/webpush.js';

const b = (s: string) => Buffer.from(s, 'base64url');

// RFC 8291, Appendix A.
const RFC = {
  plaintext: 'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  body:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

/** What a browser does with an incoming push (RFC 8291 receiver side). */
function browserDecrypt(body: Buffer, uaPrivate: Buffer, auth: Buffer): string {
  const salt = body.subarray(0, 16);
  const idLen = body[20]!;
  const asPublic = body.subarray(21, 21 + idLen);
  const ciphertext = body.subarray(21 + idLen);
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(uaPrivate);
  const uaPublic = ecdh.getPublicKey();
  const secret = ecdh.computeSecret(asPublic);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', secret, auth, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(-16));
  const padded = Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]);
  expect(padded.at(-1)).toBe(2);
  return padded.subarray(0, -1).toString('utf8');
}

describe('Web Push message encryption', () => {
  it('reproduces the RFC 8291 test vector byte for byte', () => {
    const body = encryptPayload({ p256dh: RFC.uaPublic, auth: RFC.auth }, b(RFC.plaintext), {
      ephemeralPrivateKey: b(RFC.asPrivate),
      salt: b(RFC.salt),
    });
    expect(body.toString('base64url')).toBe(RFC.body);
  });

  it('produces a message the browser can decrypt, with a fresh key and salt every time', () => {
    const text = JSON.stringify({ title: 'Alice Example', body: 'Lunch? 🥪' });
    const one = encryptPayload({ p256dh: RFC.uaPublic, auth: RFC.auth }, Buffer.from(text));
    const two = encryptPayload({ p256dh: RFC.uaPublic, auth: RFC.auth }, Buffer.from(text));
    expect(one.equals(two)).toBe(false);
    expect(browserDecrypt(one, b(RFC.uaPrivate), b(RFC.auth))).toBe(text);
  });

  it('rejects browser keys that are not an uncompressed P-256 point', () => {
    expect(() => encryptPayload({ p256dh: 'AAAA', auth: RFC.auth }, Buffer.from('x'))).toThrow();
  });
});

describe('VAPID', () => {
  const keys = vapidKeysFromSeed(new Keyring(crypto.randomBytes(48).toString('base64')).vapidSeed);

  it('derives the same key pair from the same secret, and a different one from another secret', () => {
    const secret = crypto.randomBytes(48).toString('base64');
    const a = vapidKeysFromSeed(new Keyring(secret).vapidSeed);
    const again = vapidKeysFromSeed(new Keyring(secret).vapidSeed);
    expect(a.publicKey).toBe(again.publicKey);
    expect(a.publicKey).not.toBe(keys.publicKey);
    expect(b(a.publicKey)).toHaveLength(65);
  });

  it('signs a token for the push service origin that verifies with the advertised public key', () => {
    const now = Date.UTC(2026, 9, 18);
    const header = vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', keys, 'https://mail.example.com', now);
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header);
    expect(m).not.toBeNull();
    const [, h, c, sig, k] = m!;
    expect(k).toBe(keys.publicKey);
    expect(JSON.parse(b(h!).toString())).toEqual({ typ: 'JWT', alg: 'ES256' });
    expect(JSON.parse(b(c!).toString())).toEqual({
      aud: 'https://fcm.googleapis.com',
      exp: now / 1000 + 12 * 3600,
      sub: 'https://mail.example.com',
    });
    const pub = b(k!);
    const publicKey = crypto.createPublicKey({
      key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') },
      format: 'jwk',
    });
    expect(crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, b(sig!))).toBe(true);
  });
});

describe('push endpoint allowlist', () => {
  it.each([
    'https://fcm.googleapis.com/fcm/send/abc',
    'https://web.push.apple.com/QGx1',
    'https://updates.push.services.mozilla.com/wpush/v2/gAAA',
    'https://wns2-par02p.notify.windows.com/w/?token=x',
  ])('accepts the browser push service %s', (url) => {
    expect(isAllowedPushEndpoint(url)).toBe(true);
  });

  it.each([
    'http://fcm.googleapis.com/fcm/send/abc',
    'https://127.0.0.1/push',
    'https://localhost/push',
    'https://fcm.googleapis.com.evil.test/x',
    'https://evilfcm.googleapis.com.example/x',
    'https://notpush.apple.com.attacker.example/x',
    'https://user:pw@fcm.googleapis.com/x',
    'https://fcm.googleapis.com:8443/x',
    'not a url',
  ])('refuses %s', (url) => {
    expect(isAllowedPushEndpoint(url)).toBe(false);
  });
});
