import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Plugin, UserConfig } from 'vite';
import viteConfig, { devHostGuard } from '../vite.config';

// loadEnv always reads a plain .env, whatever the mode, so a developer's own .env would leak into these
// tests. Only the process.env set up below should count.
vi.mock('vite', async (importOriginal) => ({ ...(await importOriginal<typeof import('vite')>()), loadEnv: () => ({}) }));

const SUFFIX = '--myworkspace--me.dev.example.com';
const KEYS = ['RATATOSKR_BASE_URL', 'RATATOSKR_DEV_ALLOWED_HOST_SUFFIX'] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function resolve(command: 'serve' | 'build', env: Partial<Record<(typeof KEYS)[number], string>>): UserConfig {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, env);
  const fn = viteConfig as unknown as (e: { command: string; mode: string }) => UserConfig;
  return fn({ command, mode: 'test-no-env-file' });
}
const pluginNames = (c: UserConfig) => (c.plugins as Plugin[]).flat().map((p) => p.name);

describe('Vite dev server allowed hosts', () => {
  it('without the suffix allows exactly localhost and the RATATOSKR_BASE_URL host (unchanged)', () => {
    const c = resolve('serve', { RATATOSKR_BASE_URL: 'https://5173--myworkspace--me.dev.example.com' });
    expect(c.server?.allowedHosts).toEqual(['localhost', '5173--myworkspace--me.dev.example.com']);
    expect(pluginNames(c)).not.toContain('ratatoskr-dev-host-guard');
  });
  it('with the suffix hands host checking to the guard plugin', () => {
    const c = resolve('serve', { RATATOSKR_DEV_ALLOWED_HOST_SUFFIX: SUFFIX });
    expect(c.server?.allowedHosts).toBe(true);
    expect(pluginNames(c)).toContain('ratatoskr-dev-host-guard');
  });
  it('refuses to start the dev server with an unusable suffix', () => {
    expect(() => resolve('serve', { RATATOSKR_DEV_ALLOWED_HOST_SUFFIX: 'example.com' })).toThrow(/RATATOSKR_DEV_ALLOWED_HOST_SUFFIX/);
  });
  it('has no effect on the production build', () => {
    const c = resolve('build', { RATATOSKR_DEV_ALLOWED_HOST_SUFFIX: SUFFIX });
    expect(pluginNames(c)).not.toContain('ratatoskr-dev-host-guard');
    expect(c.server?.allowedHosts).toEqual(['localhost']);
  });
});

describe('dev host guard plugin', () => {
  function setup() {
    const middlewares: ((req: unknown, res: unknown, next: () => void) => void)[] = [];
    const httpServer = new EventEmitter();
    const plugin = devHostGuard(['localhost'], SUFFIX);
    (plugin.configureServer as (s: unknown) => void)({ middlewares: { use: (m: never) => middlewares.push(m) }, httpServer });
    const request = (host: string) => {
      let status = 0;
      let passed = false;
      middlewares[0]!({ headers: { host } }, { writeHead: (s: number) => (status = s), end: () => {} }, () => (passed = true));
      return passed ? 200 : status;
    };
    const upgrade = (host: string) => {
      let reached = false;
      let written = '';
      httpServer.on('upgrade', () => (reached = true));
      httpServer.emit('upgrade', { headers: { host } }, { end: (d: string) => (written = d) }, Buffer.alloc(0));
      httpServer.removeAllListeners('upgrade');
      return reached ? 'passed' : written.split('\r\n')[0];
    };
    return { request, upgrade };
  }

  it('lets requests for matching hosts and localhost through', () => {
    const { request } = setup();
    expect(request('40140--myworkspace--me.dev.example.com')).toBe(200);
    expect(request('localhost:5173')).toBe(200);
  });
  it('answers 403 for other and lookalike hosts', () => {
    const { request } = setup();
    expect(request('evil.example.net')).toBe(403);
    expect(request('40140--myworkspace--me.dev.example.com.evil.test')).toBe(403);
  });
  it('blocks WebSocket upgrades (HMR, /api/ws) from other hosts before any listener sees them', () => {
    const { upgrade } = setup();
    expect(upgrade('40140--myworkspace--me.dev.example.com')).toBe('passed');
    expect(upgrade('evil.example.net')).toBe('HTTP/1.1 403 Forbidden');
  });
});
