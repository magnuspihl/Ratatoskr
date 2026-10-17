import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

const root = path.resolve(import.meta.dirname, '..');

export default defineConfig(({ mode }) => {
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
  return {
    root: import.meta.dirname,
    plugins: [react()],
    build: { outDir: path.join(root, 'dist/web'), emptyOutDir: true, sourcemap: false },
    server: {
      allowedHosts,
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
