import crypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../src/app.js';
import { FailureLimiter, hashPassword, usernameSchema, verifyPassword } from '../src/auth/password.js';
import { loadConfig } from '../src/config.js';
import { Keyring } from '../src/crypto.js';
import { Store } from '../src/db.js';

const SECRET = crypto.randomBytes(48).toString('base64');
const base = { NODE_ENV: 'test', RATATOSKR_SECRET_KEY: SECRET };

describe('password hashing', () => {
  it('accepts the right password and rejects a wrong one', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(await verifyPassword('correct horse battery', hash)).toBe(true);
    expect(await verifyPassword('correct horse batterz', hash)).toBe(false);
  });

  it('salts every hash, so the same password never produces the same hash', async () => {
    const [a, b] = await Promise.all([hashPassword('same password'), hashPassword('same password')]);
    expect(a).not.toBe(b);
    expect(a).not.toContain('same password');
  });

  it('rejects malformed stored hashes instead of throwing', async () => {
    expect(await verifyPassword('x', 'plaintext')).toBe(false);
    expect(await verifyPassword('x', 'scrypt$abc$8$1$c2FsdA$aGFzaA')).toBe(false);
  });
});

describe('usernames', () => {
  it('are case-insensitive and ignore surrounding spaces', () => {
    expect(usernameSchema.parse('  Alice@Example.COM ')).toBe('alice@example.com');
  });

  it('reject spaces, control characters and other symbols', () => {
    for (const bad of ['a', 'has space', 'semi;colon', 'tab\there', 'x'.repeat(101)]) {
      expect(usernameSchema.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe('failed attempt limiter', () => {
  it('blocks a key after too many failures and unblocks it when the window passes', () => {
    let now = 0;
    const limiter = new FailureLimiter(3, 1000, () => now);
    for (let i = 0; i < 3; i++) limiter.fail('ip');
    expect(limiter.blocked('ip')).toBe(true);
    expect(limiter.blocked('other')).toBe(false);
    now = 1000;
    expect(limiter.blocked('ip')).toBe(false);
  });

  it('forgets failures after a successful login', () => {
    const limiter = new FailureLimiter(2, 1000);
    limiter.fail('alice');
    limiter.fail('alice');
    limiter.reset('alice');
    expect(limiter.blocked('alice')).toBe(false);
  });
});

describe('login configuration', () => {
  it('enables password login by default when no OIDC provider is configured', () => {
    const c = loadConfig(base);
    expect(c.passwordLogin).toBe(true);
    expect(c.registration).toBe('first');
  });

  it('keeps password login off by default when OIDC is configured, unless switched on', () => {
    const oidc = { ...base, OIDC_ISSUER_URL: 'https://auth.example.com/', OIDC_CLIENT_ID: 'rk' };
    expect(loadConfig(oidc).passwordLogin).toBe(false);
    expect(loadConfig({ ...oidc, RATATOSKR_PASSWORD_LOGIN: 'true' }).passwordLogin).toBe(true);
    expect(loadConfig(oidc).oidc?.label).toBe('Single sign-on');
    expect(loadConfig({ ...oidc, OIDC_LABEL: 'Authentik' }).oidc?.label).toBe('Authentik');
  });

  it('refuses to start without any way to log in', () => {
    expect(() => loadConfig({ ...base, RATATOSKR_PASSWORD_LOGIN: 'false' })).toThrow(/login method/);
  });

  it('rejects an unknown registration mode', () => {
    expect(() => loadConfig({ ...base, RATATOSKR_REGISTRATION: 'invite' })).toThrow(/RATATOSKR_REGISTRATION/);
  });
});

describe('password login over HTTP', () => {
  let ctx: App | null = null;
  afterEach(async () => {
    await ctx?.app.close();
    ctx = null;
  });

  async function start(env: Record<string, string> = {}) {
    const config = loadConfig({ ...base, ...env });
    ctx = await buildApp(config, { store: new Store(':memory:', new Keyring(config.secretKey).credentialKey), logger: false });
    return ctx;
  }

  const post = (url: string, payload: unknown, cookie?: string, csrf = true) =>
    ctx!.app.inject({
      method: 'POST',
      url,
      payload: payload as object,
      headers: { ...(csrf ? { 'x-ratatoskr': '1' } : {}), ...(cookie ? { cookie } : {}) },
    });
  const cookieOf = (res: { cookies: { name: string; value: string }[] }) => {
    const c = res.cookies.find((c) => c.name === 'rk_session');
    return c ? `rk_session=${c.value}` : undefined;
  };
  const me = (cookie?: string) => ctx!.app.inject({ method: 'GET', url: '/api/me', headers: cookie ? { cookie } : {} });

  it('lets the first user register and signs them in straight away', async () => {
    await start();
    expect((await ctx!.app.inject({ url: '/auth/methods' })).json()).toEqual({ password: true, registration: true, oidc: null, dev: false });
    const res = await post('/auth/password/register', { username: 'Alice', password: 'a long password' });
    expect(res.statusCode).toBe(200);
    const profile = await me(cookieOf(res));
    expect(profile.statusCode).toBe(200);
    expect(profile.json()).toMatchObject({ name: 'alice', hasPassword: true });
  });

  it('closes registration after the first user by default', async () => {
    await start();
    await post('/auth/password/register', { username: 'alice', password: 'a long password' });
    expect((await ctx!.app.inject({ url: '/auth/methods' })).json().registration).toBe(false);
    const res = await post('/auth/password/register', { username: 'mallory', password: 'a long password' });
    expect(res.statusCode).toBe(403);
    expect(cookieOf(res)).toBeUndefined();
  });

  it('allows anyone to register when registration is open, but not twice with the same username', async () => {
    await start({ RATATOSKR_REGISTRATION: 'open' });
    expect((await post('/auth/password/register', { username: 'alice', password: 'a long password' })).statusCode).toBe(200);
    expect((await post('/auth/password/register', { username: 'bob', password: 'another password' })).statusCode).toBe(200);
    expect((await post('/auth/password/register', { username: 'ALICE', password: 'a third password' })).statusCode).toBe(409);
  });

  it('refuses all registration when it is closed', async () => {
    await start({ RATATOSKR_REGISTRATION: 'closed' });
    expect((await post('/auth/password/register', { username: 'alice', password: 'a long password' })).statusCode).toBe(403);
  });

  it('rejects passwords shorter than 10 characters at registration', async () => {
    await start();
    const res = await post('/auth/password/register', { username: 'alice', password: 'short' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/at least 10/);
  });

  it('signs in with the right password (any letter case in the username) and refuses a wrong one', async () => {
    await start();
    await post('/auth/password/register', { username: 'alice', password: 'a long password' });
    const ok = await post('/auth/password/login', { username: 'ALICE', password: 'a long password' });
    expect(ok.statusCode).toBe(200);
    expect((await me(cookieOf(ok))).statusCode).toBe(200);

    const wrong = await post('/auth/password/login', { username: 'alice', password: 'not the password' });
    expect(wrong.statusCode).toBe(401);
    expect(cookieOf(wrong)).toBeUndefined();
    // Unknown users get the very same answer, so usernames can't be probed.
    const unknown = await post('/auth/password/login', { username: 'nobody', password: 'not the password' });
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json()).toEqual(wrong.json());
  });

  it('requires the CSRF header, so other sites cannot log a browser in or create accounts', async () => {
    await start();
    expect((await post('/auth/password/register', { username: 'alice', password: 'a long password' }, undefined, false)).statusCode).toBe(403);
    expect((await post('/auth/password/login', { username: 'alice', password: 'a long password' }, undefined, false)).statusCode).toBe(403);
  });

  it('locks a username for a while after 10 wrong passwords, even for the right one', async () => {
    await start();
    await post('/auth/password/register', { username: 'alice', password: 'a long password' });
    for (let i = 0; i < 10; i++) await post('/auth/password/login', { username: 'alice', password: `guess number ${i}` });
    const res = await post('/auth/password/login', { username: 'alice', password: 'a long password' });
    expect(res.statusCode).toBe(429);
  });

  it('changes the password only when the current one is given correctly', async () => {
    await start();
    const cookie = cookieOf(await post('/auth/password/register', { username: 'alice', password: 'a long password' }))!;
    const put = (payload: unknown) =>
      ctx!.app.inject({ method: 'PUT', url: '/api/password', payload: payload as object, headers: { cookie, 'x-ratatoskr': '1' } });

    expect((await put({ current: 'wrong password', next: 'a brand new password' })).statusCode).toBe(403);
    expect((await put({ current: 'a long password', next: 'short' })).statusCode).toBe(400);
    expect((await put({ current: 'a long password', next: 'a brand new password' })).statusCode).toBe(200);

    expect((await post('/auth/password/login', { username: 'alice', password: 'a long password' })).statusCode).toBe(401);
    expect((await post('/auth/password/login', { username: 'alice', password: 'a brand new password' })).statusCode).toBe(200);
  });

  it('does not send password users to the OIDC provider on logout', async () => {
    // The issuer is never contacted: a password session logs out locally.
    await start({ OIDC_ISSUER_URL: 'https://auth.invalid/', OIDC_CLIENT_ID: 'rk', RATATOSKR_PASSWORD_LOGIN: 'true' });
    expect((await ctx!.app.inject({ url: '/auth/methods' })).json()).toMatchObject({ password: true, oidc: { label: 'Single sign-on' } });
    const cookie = cookieOf(await post('/auth/password/register', { username: 'alice', password: 'a long password' }))!;
    const res = await post('/auth/logout', {}, cookie);
    expect(res.json()).toEqual({ redirect: '/' });
  });

  it('has no password endpoints when password login is off', async () => {
    await start({ RATATOSKR_PASSWORD_LOGIN: 'false', RATATOSKR_DEV_LOGIN: 'true' });
    expect((await ctx!.app.inject({ url: '/auth/methods' })).json()).toMatchObject({ password: false, registration: false, dev: true });
    expect((await post('/auth/password/login', { username: 'alice', password: 'a long password' })).statusCode).toBe(404);
    expect((await post('/auth/password/register', { username: 'alice', password: 'a long password' })).statusCode).toBe(404);
  });
});
