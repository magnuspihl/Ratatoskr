import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, isSpaRequest, type App } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { Keyring } from '../src/crypto.js';
import { Store } from '../src/db.js';

describe('isSpaRequest', () => {
  const html = 'text/html,application/xhtml+xml,*/*;q=0.8';
  it('serves the shell for client routes requested by a browser', () => {
    expect(isSpaRequest('GET', '/mail/abc/INBOX.Sent?open=abc.1.2', html)).toBe(true);
    expect(isSpaRequest('GET', '/mail/abc/Archive%2F2026', html)).toBe(true);
    expect(isSpaRequest('HEAD', '/', html)).toBe(true);
  });
  it('never swallows API, auth, health checks, non-GET or non-HTML requests', () => {
    expect(isSpaRequest('GET', '/api/nope', html)).toBe(false);
    expect(isSpaRequest('GET', '/api', html)).toBe(false);
    expect(isSpaRequest('GET', '/auth/whatever', html)).toBe(false);
    expect(isSpaRequest('GET', '/healthz', html)).toBe(false);
    expect(isSpaRequest('POST', '/mail/abc/INBOX', html)).toBe(false);
    expect(isSpaRequest('GET', '/assets/missing.js', '*/*')).toBe(false);
  });
});

describe('SPA fallback in the production server', () => {
  let ctx: App;
  const webDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rk-web-'));

  beforeAll(async () => {
    fs.writeFileSync(path.join(webDir, 'index.html'), '<!doctype html><title>shell</title>');
    const config = loadConfig({
      NODE_ENV: 'test',
      RATATOSKR_SECRET_KEY: crypto.randomBytes(48).toString('base64'),
      RATATOSKR_DEV_LOGIN: 'true',
      RATATOSKR_WEB_DIR: webDir,
    });
    ctx = await buildApp(config, { store: new Store(':memory:', new Keyring(config.secretKey).credentialKey), logger: false });
  });
  afterAll(async () => {
    await ctx.app.close();
    fs.rmSync(webDir, { recursive: true, force: true });
  });

  const get = (url: string, accept = 'text/html') => ctx.app.inject({ method: 'GET', url, headers: { accept } });

  it('answers deep links with index.html', async () => {
    const res = await get('/mail/3f2a9c1e/INBOX.Sent?open=3f2a9c1e.5.9');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<title>shell</title>');
  });
  it('keeps JSON errors for unknown API and auth paths', async () => {
    expect((await get('/api/does-not-exist')).headers['content-type']).toContain('application/json');
    const auth = await get('/auth/does-not-exist');
    expect(auth.statusCode).toBe(404);
    expect(auth.body).not.toContain('shell');
  });
  it('does not answer missing assets with HTML', async () => {
    const res = await get('/assets/missing.js', '*/*');
    expect(res.statusCode).toBe(404);
  });
});
