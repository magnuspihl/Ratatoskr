import crypto from 'node:crypto';

/**
 * All server-side cryptography derives from one master secret (RATATOSKR_SECRET_KEY).
 * Independent subkeys are derived with HKDF so that, e.g., a session cookie can never be
 * decrypted as an account credential or vice versa.
 */
export class Keyring {
  readonly credentialKey: Buffer;
  readonly sessionKey: Buffer;
  readonly signingKey: Buffer;

  constructor(masterSecret: string) {
    if (masterSecret.length < 32) throw new Error('Master secret must be at least 32 characters');
    const ikm = Buffer.from(masterSecret, 'utf8');
    const derive = (info: string) =>
      Buffer.from(crypto.hkdfSync('sha256', ikm, Buffer.from('ratatoskr'), Buffer.from(info), 32));
    this.credentialKey = derive('account-credentials-v1');
    this.sessionKey = derive('session-cookie-v1');
    this.signingKey = derive('url-signing-v1');
  }
}

const VERSION = 'v1';

/**
 * AES-256-GCM with a random 96-bit IV. `aad` binds the ciphertext to its context (for account
 * credentials: the owning user and account id), so a ciphertext copied to another row or user
 * fails authentication instead of silently decrypting.
 */
export function encrypt(key: Buffer, plaintext: string, aad: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.');
}

export function decrypt(key: Buffer, sealed: string, aad: string): string {
  const parts = sealed.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) throw new Error('Unsupported ciphertext format');
  const [, ivB64, tagB64, ctB64] = parts as [string, string, string, string];
  const iv = Buffer.from(ivB64, 'base64url');
  const tag = Buffer.from(tagB64, 'base64url');
  if (iv.length !== 12 || tag.length !== 16) throw new Error('Malformed ciphertext');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64url')), decipher.final()]).toString('utf8');
}

/** Encrypt-and-authenticate a JSON value with an expiry (used for cookies). */
export function sealJson(key: Buffer, value: unknown, ttlSeconds: number, purpose: string): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  return encrypt(key, JSON.stringify({ exp, v: value }), purpose);
}

export function openJson<T>(key: Buffer, sealed: string | undefined, purpose: string): T | null {
  if (!sealed) return null;
  try {
    const { exp, v } = JSON.parse(decrypt(key, sealed, purpose)) as { exp: number; v: T };
    if (typeof exp !== 'number' || exp < Math.floor(Date.now() / 1000)) return null;
    return v;
  } catch {
    return null;
  }
}

export function hmac(key: Buffer, data: string): string {
  return crypto.createHmac('sha256', key).update(data).digest('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}
