// Environment for `npm run dev`. In a git worktree (one checkout per task/branch) there's usually no
// .env of its own, so the main checkout's .env is used as a base. Precedence, highest first: real
// environment variables, the worktree's .env, the main checkout's .env.
//
// The database is NOT shared: a relative RATATOSKR_DATA_DIR (default ./data) is taken relative to the
// worktree, so each one has its own. Branches with different migration lists would otherwise
// corrupt each other's schema.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';

/** The main checkout's directory if `cwd` is inside a linked git worktree, else null. */
export function mainCheckoutDir(cwd) {
  try {
    const git = (...args) => execFileSync('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const top = git('--show-toplevel');
    const main = path.dirname(git('--git-common-dir'));
    return path.resolve(main) === path.resolve(top) ? null : main;
  } catch {
    return null; // not a git checkout, or no git (e.g. inside a container)
  }
}

/** .env files to load, lowest precedence first. Only files that exist. */
export function devEnvFiles(cwd, main = mainCheckoutDir(cwd)) {
  const files = [main && path.join(main, '.env'), path.join(cwd, '.env')].filter(Boolean);
  return files.filter((f, i) => files.indexOf(f) === i && fs.existsSync(f));
}

export function loadDevEnv(cwd, env = process.env, main = mainCheckoutDir(cwd)) {
  const files = devEnvFiles(cwd, main);
  const merged = {};
  for (const f of files) Object.assign(merged, parseEnv(fs.readFileSync(f, 'utf8')));
  return { env: { ...merged, ...env }, files };
}
