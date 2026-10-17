// Development runner: backend (tsx watch) on BACKEND_PORT and the Vite dev server on PORT.
// Vite proxies /api and /auth to the backend. Stop with Ctrl+C.
import { spawn } from 'node:child_process';

const port = Number(process.env.PORT || 5173);
const backendPort = Number(process.env.BACKEND_PORT || port + 1);
const env = { ...process.env, BACKEND_PORT: String(backendPort) };

const procs = [
  spawn('npx', ['tsx', 'watch', '--env-file-if-exists=.env', 'server/src/index.ts'], {
    stdio: 'inherit',
    env: { ...env, PORT: String(backendPort), HOST: '127.0.0.1', NODE_OPTIONS: '--disable-warning=ExperimentalWarning' },
  }),
  spawn('npx', ['vite', '--config', 'web/vite.config.ts', '--port', String(port), '--strictPort', '--host', '0.0.0.0'], {
    stdio: 'inherit',
    env,
  }),
];

const stop = () => {
  for (const p of procs) p.kill('SIGTERM');
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const p of procs) p.on('exit', (code) => code && stop());
