import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import { isDevHostAllowed, parseHostSuffix } from '../shared/devHosts.ts';

const root = path.resolve(import.meta.dirname, '..');

/**
 * Vite's allowedHosts can't express "any host ending in --foo.example.com", so when
 * RATATOSKR_DEV_ALLOWED_HOST_SUFFIX is set the built-in check is switched off and this plugin
 * enforces the same rule (plus the suffix) for plain requests and for WebSocket upgrades (HMR and
 * the proxied /api/ws). Dev server only: `vite build` never runs it.
 */
export function devHostGuard(hosts: string[], suffix: string): Plugin {
  const allowed = (host: string | undefined) => isDevHostAllowed(host, { hosts, suffix });
  return {
    name: 'ratatoskr-dev-host-guard',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (allowed(req.headers.host)) return next();
        res.writeHead(403, { 'content-type': 'text/plain' });
        res.end(`Blocked request. This host (${JSON.stringify(req.headers.host ?? '')}) is not allowed.`);
      });
      const http = server.httpServer;
      if (!http) return;
      // Gate 'upgrade' before any listener (Vite's HMR, the proxy) sees it, whatever their order.
      const emit = http.emit.bind(http) as (event: string, ...args: unknown[]) => boolean;
      http.emit = ((event: string, ...args: unknown[]) => {
        if (event === 'upgrade') {
          const [req, socket] = args as [{ headers: { host?: string } }, { end: (data: string) => void }];
          if (!allowed(req.headers.host)) {
            socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
            return true;
          }
        }
        return emit(event, ...args);
      }) as typeof http.emit;
    },
  };
}

export default defineConfig(({ command, mode }) => {
  const env = { ...loadEnv(mode, root, ''), ...process.env };
  const backend = `http://127.0.0.1:${env.BACKEND_PORT || '8081'}`;
  // Vite rejects unknown Host headers. Accept localhost plus the host from RATATOSKR_BASE_URL
  // (e.g. a reverse-proxied preview URL), so nothing deployment-specific lives in the repo.
  const allowedHosts: string[] = ['localhost'];
  try {
    if (env.RATATOSKR_BASE_URL) allowedHosts.push(new URL(env.RATATOSKR_BASE_URL).hostname);
  } catch {
    /* ignore */
  }
  // Optionally also any host ending in RATATOSKR_DEV_ALLOWED_HOST_SUFFIX (several proxied ports).
  const suffix = command === 'serve' ? parseHostSuffix(env.RATATOSKR_DEV_ALLOWED_HOST_SUFFIX) : null;
  return {
    root: import.meta.dirname,
    plugins: [react(), ...(suffix ? [devHostGuard(allowedHosts, suffix)] : [])],
    build: { outDir: path.join(root, 'dist/web'), emptyOutDir: true, sourcemap: false },
    server: {
      allowedHosts: suffix ? true : allowedHosts,
      // Anchored patterns: only /api/* and /auth/* reach the backend; every other path falls
      // through to Vite's SPA fallback (index.html), so client routes survive a reload.
      proxy: {
        '^/api/ws$': { target: backend, ws: true },
        '^/api/': { target: backend },
        '^/auth/': { target: backend },
      },
    },
  };
});
