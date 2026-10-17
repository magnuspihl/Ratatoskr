import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hostnameOf, isDevHostAllowed, matchesHostSuffix, parseHostSuffix } from '../../shared/devHosts.js';
import { buildApp, type App } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { Keyring } from '../src/crypto.js';
import { Store } from '../src/db.js';
import { isWsOriginAllowed } from '../src/routes/ws.js';

const SUFFIX = '--myworkspace--me.dev.example.com';
const BASE = 'https://5173--myworkspace--me.dev.example.com';
const PREVIEW = '40140--myworkspace--me.dev.example.com';

const baseEnv = (extra: Record<string, string> = {}) => ({
  RATATOSKR_SECRET_KEY: 'x'.repeat(48),
  RATATOSKR_BASE_URL: BASE,
  RATATOSKR_DEV_LOGIN: 'true',
  ...extra,
});

describe('dev host suffix matching', () => {
  it('accepts suffixes starting with "--" or "." and normalises case and whitespace', () => {
    expect(parseHostSuffix(` ${SUFFIX.toUpperCase()} `)).toBe(SUFFIX);
    expect(parseHostSuffix('.dev.example.com')).toBe('.dev.example.com');
  });
  it('treats an unset or empty suffix as "no extra hosts"', () => {
    expect(parseHostSuffix(undefined)).toBeNull();
    expect(parseHostSuffix('  ')).toBeNull();
  });
  it('rejects suffixes that could match in the middle of a name or that are not a domain', () => {
    for (const bad of ['example.com', 'me.dev.example.com', '-me.dev.example.com', '--', '.', '.com', '--me', '--me.example.com/', '--me.example.com:443', '*.example.com']) {
      expect(() => parseHostSuffix(bad), bad).toThrow(/RATATOSKR_DEV_ALLOWED_HOST_SUFFIX/);
    }
  });
  it('matches any host ending in the suffix, with or without a port', () => {
    expect(matchesHostSuffix(PREVIEW, SUFFIX)).toBe(true);
    expect(matchesHostSuffix('5173--MyWorkspace--me.dev.example.com', SUFFIX)).toBe(true);
    expect(isDevHostAllowed(`${PREVIEW}:443`, { hosts: [], suffix: SUFFIX })).toBe(true);
  });
  it('does not match lookalike hosts', () => {
    for (const host of [
      SUFFIX.slice(2), // the bare parent, no "<port>--" in front
      SUFFIX,
      `40140${SUFFIX}.attacker.example.net`,
      '40140--myworkspace--me.dev.example.com.evil.test',
      '40140--otherworkspace--me.dev.example.com',
      '40140--myworkspace--me-dev.example.com',
      '40140--myworkspace--me.dev.example.co',
      'evilmyworkspace--me.dev.example.com',
    ]) {
      expect(isDevHostAllowed(host, { hosts: [], suffix: SUFFIX }), host).toBe(false);
    }
  });
  it('rejects malformed Host headers', () => {
    for (const host of [undefined, '', `user@${PREVIEW}`, `${PREVIEW}/path`, `${PREVIEW}?x`, 'a b']) {
      expect(isDevHostAllowed(host, { hosts: [], suffix: SUFFIX }), String(host)).toBe(false);
    }
    expect(hostnameOf(`${PREVIEW}:40140`)).toBe(PREVIEW);
  });
  it('without a suffix allows only localhost, IP literals and the listed hosts (the old behaviour)', () => {
    const opts = { hosts: ['5173--myworkspace--me.dev.example.com'], suffix: null };
    expect(isDevHostAllowed('localhost:5173', opts)).toBe(true);
    expect(isDevHostAllowed('127.0.0.1:5173', opts)).toBe(true);
    expect(isDevHostAllowed('[::1]:5173', opts)).toBe(true);
    expect(isDevHostAllowed('5173--myworkspace--me.dev.example.com', opts)).toBe(true);
    expect(isDevHostAllowed(PREVIEW, opts)).toBe(false);
  });
});

describe('RATATOSKR_DEV_ALLOWED_HOST_SUFFIX in the server config', () => {
  it('is read in development', () => {
    expect(loadConfig(baseEnv({ NODE_ENV: 'development', RATATOSKR_DEV_ALLOWED_HOST_SUFFIX: SUFFIX })).devAllowedHostSuffix).toBe(SUFFIX);
  });
  it('is null when unset', () => {
    expect(loadConfig(baseEnv({ NODE_ENV: 'development' })).devAllowedHostSuffix).toBeNull();
  });
  it('fails startup in development when the value is unusable', () => {
    expect(() => loadConfig(baseEnv({ NODE_ENV: 'development', RATATOSKR_DEV_ALLOWED_HOST_SUFFIX: 'example.com' }))).toThrow(/RATATOSKR_DEV_ALLOWED_HOST_SUFFIX/);
  });
  it('is ignored entirely in production, even when set (or invalid)', () => {
    const env = { NODE_ENV: 'production', OIDC_ISSUER_URL: 'https://auth.example.com/', OIDC_CLIENT_ID: 'ratatoskr' };
    expect(loadConfig(baseEnv({ ...env, RATATOSKR_DEV_ALLOWED_HOST_SUFFIX: SUFFIX })).devAllowedHostSuffix).toBeNull();
    expect(loadConfig(baseEnv({ ...env, RATATOSKR_DEV_ALLOWED_HOST_SUFFIX: 'example.com' })).devAllowedHostSuffix).toBeNull();
  });
});

describe('WebSocket origin check', () => {
  const dev = { production: false, baseUrl: new URL(BASE), devAllowedHostSuffix: SUFFIX };
  const prod = { ...dev, production: true, devAllowedHostSuffix: null };
  // Behind a TLS-terminating proxy and Vite's proxy, the backend sees http and the public Host.
  const viaProxy = (host: string) => ({ protocol: 'http', host });

  it('in development accepts a preview origin that matches the request Host and the suffix', () => {
    expect(isWsOriginAllowed(dev, `https://${PREVIEW}`, viaProxy(PREVIEW))).toBe(true);
  });
  it('in development still accepts the base URL and localhost', () => {
    expect(isWsOriginAllowed(dev, BASE, viaProxy(PREVIEW))).toBe(true);
    expect(isWsOriginAllowed(dev, 'http://localhost:5173', viaProxy('localhost:5173'))).toBe(true);
  });
  it('in development rejects an origin that differs from the request Host', () => {
    expect(isWsOriginAllowed(dev, 'https://evil.example.net', viaProxy(PREVIEW))).toBe(false);
    expect(isWsOriginAllowed(dev, `https://40141${SUFFIX}`, viaProxy(PREVIEW))).toBe(false);
  });
  it('in development rejects a Host outside the suffix even when the origin matches it', () => {
    expect(isWsOriginAllowed(dev, 'https://evil.example.net', viaProxy('evil.example.net'))).toBe(false);
    expect(isWsOriginAllowed({ ...dev, devAllowedHostSuffix: null }, `https://${PREVIEW}`, viaProxy(PREVIEW))).toBe(false);
  });
  it('rejects a missing or non-web origin', () => {
    expect(isWsOriginAllowed(dev, undefined, viaProxy(PREVIEW))).toBe(false);
    expect(isWsOriginAllowed(dev, 'null', viaProxy(PREVIEW))).toBe(false);
    expect(isWsOriginAllowed(dev, `ftp://${PREVIEW}`, viaProxy(PREVIEW))).toBe(false);
  });
  it('in production behaves exactly as before: base URL or same scheme+host only', () => {
    expect(isWsOriginAllowed(prod, BASE, viaProxy(PREVIEW))).toBe(true);
    expect(isWsOriginAllowed(prod, `http://${PREVIEW}`, viaProxy(PREVIEW))).toBe(true);
    expect(isWsOriginAllowed(prod, `https://${PREVIEW}`, viaProxy(PREVIEW))).toBe(false);
    expect(isWsOriginAllowed(prod, 'http://localhost:5173', viaProxy('localhost:5173'))).toBe(true);
    expect(isWsOriginAllowed(prod, 'http://localhost:5173', viaProxy('mail.example.com'))).toBe(false);
    // Even a config object that somehow carried a suffix is ignored in production.
    expect(isWsOriginAllowed({ ...prod, devAllowedHostSuffix: SUFFIX }, `https://${PREVIEW}`, viaProxy(PREVIEW))).toBe(false);
  });
});

describe('dev login when served from a host other than RATATOSKR_BASE_URL', () => {
  let ctx: App;
  let cookie: string;

  beforeAll(async () => {
    const config = loadConfig({
      ...baseEnv({ NODE_ENV: 'development', RATATOSKR_DEV_ALLOWED_HOST_SUFFIX: SUFFIX }),
      RATATOSKR_SECRET_KEY: crypto.randomBytes(48).toString('base64'),
    });
    ctx = await buildApp(config, { store: new Store(':memory:', new Keyring(config.secretKey).credentialKey), logger: false });
  });
  afterAll(async () => {
    await ctx.app.close();
  });

  it('sets a host-only session cookie and redirects to a relative path', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/auth/dev-login', headers: { host: PREVIEW } });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/');
    const session = res.cookies.find((c) => c.name === 'rk_session')!;
    expect(session.domain).toBeUndefined();
    expect(session.path).toBe('/');
    cookie = `rk_session=${session.value}`;
    const me = await ctx.app.inject({ method: 'GET', url: '/api/me', headers: { host: PREVIEW, cookie } });
    expect(me.statusCode).toBe(200);
  });

  it('opens the live-update WebSocket from the preview origin', async () => {
    let resolveFirst: (msg: string) => void;
    const firstMessage = new Promise<string>((resolve) => (resolveFirst = resolve));
    const ws = await ctx.app.injectWS(
      '/api/ws',
      { headers: { host: PREVIEW, cookie, origin: `https://${PREVIEW}` } },
      { onInit: (socket) => socket.once('message', (d) => resolveFirst(String(d))) },
    );
    const first = await firstMessage;
    ws.terminate();
    expect(JSON.parse(first)).toEqual({ type: 'hello' });
  });

  it('refuses the WebSocket from an origin that does not match the Host', async () => {
    const ws = await ctx.app.injectWS('/api/ws', { headers: { host: PREVIEW, cookie, origin: 'https://evil.example.net' } });
    const code = await new Promise<number>((resolve) => ws.on('close', (c) => resolve(c)));
    expect(code).toBe(4401);
  });
});
