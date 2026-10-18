import crypto from 'node:crypto';
import https from 'node:https';
import net from 'node:net';
import { publicOnlyLookup } from '../net/ssrf.js';

/**
 * Minimal Web Push sender: message encryption (RFC 8291, aes128gcm from RFC 8188) and VAPID
 * authentication (RFC 8292), on top of node:crypto and node:https. No third-party push library.
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

export class PushEndpointError extends Error {}

/**
 * Checks the shape of a push endpoint URL from the browser. Any HTTPS push service is allowed
 * (Chrome/FCM, Apple, Mozilla, Windows, and whatever Vivaldi, Brave & co. use), but the URL comes
 * from the browser, so where it may point is restricted: no credentials, the standard port, and
 * no IP literals or reserved names. That the host resolves only to public addresses is enforced
 * when connecting (see sendPush).
 */
export function checkPushEndpoint(endpoint: string): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new PushEndpointError('Invalid push endpoint');
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) {
    throw new PushEndpointError(`Unsupported push service (${host || 'no host'})`);
  }
  // Chromium builds without Google API keys hand out endpoints on this placeholder host.
  if (host.endsWith('.invalid')) {
    throw new PushEndpointError(`This browser has no working push service (${host}). Try another browser.`);
  }
  if (net.isIP(host.replace(/^\[|\]$/g, '')) || !host.includes('.') || /\.(localhost|local|internal|home\.arpa|test|example)$/.test(host)) {
    throw new PushEndpointError(`Unsupported push service (${host})`);
  }
  return url;
}

export function isAllowedPushEndpoint(endpoint: string): boolean {
  try {
    checkPushEndpoint(endpoint);
    return true;
  } catch {
    return false;
  }
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

/** POST to a push service, connecting only to public addresses (checked and pinned at DNS lookup). */
function post(url: URL, headers: Record<string, string>, body: Buffer): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      { method: 'POST', headers: { ...headers, 'content-length': String(body.length) }, lookup: publicOnlyLookup as never, timeout: 15_000 },
      (res) => {
        res.resume(); // the body is irrelevant; redirects are not followed
        res.on('end', () => resolve(res.statusCode ?? 0));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error('push service timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

/** Sends real Web Push requests. 404/410 means the subscription no longer exists. */
export function createPushTransport(keys: VapidKeys, subject: string): PushTransport {
  return async ({ subscription, payload, ttl, urgency = 'normal' }) => {
    let url: URL;
    try {
      url = checkPushEndpoint(subscription.endpoint);
    } catch {
      return 'gone';
    }
    const body = encryptPayload(subscription, Buffer.from(JSON.stringify(payload)));
    try {
      const status = await post(
        url,
        {
          authorization: vapidAuthorization(subscription.endpoint, keys, subject),
          'content-encoding': 'aes128gcm',
          'content-type': 'application/octet-stream',
          ttl: String(ttl),
          urgency,
        },
        body,
      );
      if (status === 404 || status === 410) return 'gone';
      return status >= 200 && status < 300 ? 'sent' : 'failed';
    } catch {
      return 'failed';
    }
  };
}
