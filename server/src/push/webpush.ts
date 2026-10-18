import crypto from 'node:crypto';

/**
 * Minimal Web Push sender: message encryption (RFC 8291, aes128gcm from RFC 8188) and VAPID
 * authentication (RFC 8292), on top of node:crypto and fetch. No third-party push library.
 */

export interface PushSubscriptionKeys {
  endpoint: string;
  /** Browser's P-256 public key, uncompressed point, base64url. */
  p256dh: string;
  /** 16-byte authentication secret, base64url. */
  auth: string;
}

export interface VapidKeys {
  /** Uncompressed P-256 public key (65 bytes), base64url. This is the browser's applicationServerKey. */
  publicKey: string;
  privateKey: crypto.KeyObject;
}

const b64u = (b: Buffer) => b.toString('base64url');
const fromB64u = (s: string) => Buffer.from(s, 'base64url');

/** Turn a raw 32-byte P-256 private scalar into a VAPID key pair. */
export function vapidKeysFromSeed(seed: Buffer): VapidKeys {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(seed);
  const pub = ecdh.getPublicKey();
  const privateKey = crypto.createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', d: b64u(seed), x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) },
    format: 'jwk',
  });
  return { publicKey: b64u(pub), privateKey };
}

/**
 * Hosts of the push services browsers actually use. The endpoint URL comes from the browser, so
 * without this list a user could make the server POST to arbitrary (internal) URLs.
 */
const PUSH_HOST_SUFFIXES = [
  'fcm.googleapis.com', // Chrome, Edge on Android, Samsung Internet, Opera, Brave
  'android.googleapis.com',
  'push.services.mozilla.com', // Firefox
  'push.apple.com', // Safari, iOS/iPadOS home screen apps
  'notify.windows.com', // Edge on Windows
];

export function isAllowedPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return false;
  const host = url.hostname.toLowerCase();
  return PUSH_HOST_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`));
}

/** ES256 JWT for the push service at `endpoint`'s origin (RFC 8292). */
export function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string, now = Date.now()): string {
  const header = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(
    Buffer.from(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })),
  );
  const signature = crypto.sign('sha256', Buffer.from(`${header}.${claims}`), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${b64u(signature)}, k=${keys.publicKey}`;
}

/**
 * Encrypt a payload for one subscription (RFC 8291). `ephemeral` and `salt` exist only so the RFC
 * test vector can be reproduced; leave them out in real use.
 */
export function encryptPayload(
  sub: Pick<PushSubscriptionKeys, 'p256dh' | 'auth'>,
  plaintext: Buffer,
  testOnly?: { ephemeralPrivateKey: Buffer; salt: Buffer },
): Buffer {
  const uaPublic = fromB64u(sub.p256dh);
  const authSecret = fromB64u(sub.auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) throw new Error('Invalid p256dh key');
  if (authSecret.length < 16) throw new Error('Invalid auth secret');

  const ecdh = crypto.createECDH('prime256v1');
  if (testOnly) ecdh.setPrivateKey(testOnly.ephemeralPrivateKey);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(uaPublic);
  const salt = testOnly?.salt ?? crypto.randomBytes(16);

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', ecdhSecret, authSecret, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));

  // One record: plaintext followed by the 0x02 "last record" delimiter, no padding.
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);

  const recordSize = Buffer.alloc(4);
  recordSize.writeUInt32BE(4096);
  return Buffer.concat([salt, recordSize, Buffer.from([asPublic.length]), asPublic, ciphertext]);
}

/** Push services accept at least 4096 bytes of encrypted body; stay well below. */
export const MAX_PAYLOAD_BYTES = 3000;

export type PushOutcome = 'sent' | 'gone' | 'failed';

export interface PushRequest {
  subscription: PushSubscriptionKeys;
  payload: unknown;
  /** Seconds the push service may keep an undelivered message. */
  ttl: number;
  urgency?: 'very-low' | 'low' | 'normal' | 'high';
}

export type PushTransport = (req: PushRequest) => Promise<PushOutcome>;

/** Sends real Web Push requests with fetch. 404/410 means the subscription no longer exists. */
export function createPushTransport(keys: VapidKeys, subject: string): PushTransport {
  return async ({ subscription, payload, ttl, urgency = 'normal' }) => {
    if (!isAllowedPushEndpoint(subscription.endpoint)) return 'gone';
    const body = encryptPayload(subscription, Buffer.from(JSON.stringify(payload)));
    try {
      const res = await fetch(subscription.endpoint, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
        headers: {
          authorization: vapidAuthorization(subscription.endpoint, keys, subject),
          'content-encoding': 'aes128gcm',
          'content-type': 'application/octet-stream',
          ttl: String(ttl),
          urgency,
        },
        body,
      });
      await res.arrayBuffer().catch(() => undefined);
      if (res.status === 404 || res.status === 410) return 'gone';
      return res.ok ? 'sent' : 'failed';
    } catch {
      return 'failed';
    }
  };
}
