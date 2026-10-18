import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { z } from 'zod';

const scrypt = promisify(crypto.scrypt) as (pw: crypto.BinaryLike, salt: crypto.BinaryLike, len: number, opts: crypto.ScryptOptions) => Promise<Buffer>;

/** Issuer recorded for users who sign in with a username and password (OIDC users store their provider's issuer). */
export const LOCAL_ISSUER = 'local';

export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 256;

// scrypt N=2^15, r=8, p=1: OWASP's recommended minimum, ~50-100 ms and 32 MiB per hash.
const PARAMS = { N: 2 ** 15, r: 8, p: 1 };
const KEY_LEN = 32;

/** Usernames are case-insensitive; an email address works as a username. */
export const usernameSchema = z
  .string()
  .transform((s) => s.normalize('NFKC').trim().toLowerCase())
  .pipe(
    z
      .string()
      .min(2, 'Username must be at least 2 characters')
      .max(100, 'Username must be at most 100 characters')
      .regex(/^[a-z0-9._@+-]+$/, 'Username may only contain letters, digits and . _ @ + -'),
  );

export const passwordSchema = z
  .string()
  .min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`)
  .max(MAX_PASSWORD_LENGTH, `Password must be at most ${MAX_PASSWORD_LENGTH} characters`);

/** Self-contained hash string: `scrypt$N$r$p$salt$hash` (base64url), so parameters can be raised later. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const hash = await derive(password, salt, PARAMS);
  return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64url'), hash.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [N, r, p] = parts.slice(1, 4).map(Number) as [number, number, number];
  if (![N, r, p].every((n) => Number.isSafeInteger(n) && n > 0)) return false;
  const expected = Buffer.from(parts[5]!, 'base64url');
  const actual = await derive(password, Buffer.from(parts[4]!, 'base64url'), { N, r, p }, expected.length);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

let dummyHash: Promise<string> | null = null;

/** Spends the same time as a real check, so response times don't reveal which usernames exist. */
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hashPassword(crypto.randomBytes(16).toString('hex'));
  await verifyPassword(password, await dummyHash);
}

function derive(password: string, salt: Buffer, p: { N: number; r: number; p: number }, len = KEY_LEN) {
  return scrypt(password.normalize('NFKC'), salt, len, { ...p, maxmem: 128 * p.N * p.r * 2 });
}

/**
 * Counts failed attempts per key (client IP, username) in a fixed window. In memory only: a
 * restart resets it, which is fine for slowing down online guessing against one instance.
 */
export class FailureLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  blocked(key: string): boolean {
    const h = this.hits.get(key);
    if (!h) return false;
    if (h.resetAt <= this.now()) {
      this.hits.delete(key);
      return false;
    }
    return h.count >= this.max;
  }

  fail(key: string) {
    const now = this.now();
    const h = this.hits.get(key);
    if (!h || h.resetAt <= now) this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
    else h.count++;
    if (this.hits.size > 10_000) this.prune();
  }

  reset(key: string) {
    this.hits.delete(key);
  }

  private prune() {
    const now = this.now();
    for (const [k, h] of this.hits) if (h.resetAt <= now) this.hits.delete(k);
  }
}
