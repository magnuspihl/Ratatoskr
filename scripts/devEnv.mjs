// Environment for `npm run dev`. In a git worktree (one checkout per task/branch) there's usually no
// .env of its own, so the main checkout's .env is used as a base. Precedence, highest first: real
// environment variables, the worktree's .env, the main checkout's .env.
//
// Worktrees also share the main checkout's database (its ./data) unless RATATOSKR_DATA_DIR is set
// somewhere; a relative RATATOSKR_DATA_DIR in the main .env is taken relative to the main checkout.
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
  for (const f of files) {
    const vars = parseEnv(fs.readFileSync(f, 'utf8'));
    if (main && path.dirname(f) === main && vars.RATATOSKR_DATA_DIR) {
      vars.RATATOSKR_DATA_DIR = path.resolve(main, vars.RATATOSKR_DATA_DIR);
    }
    Object.assign(merged, vars);
  }
  if (main && !merged.RATATOSKR_DATA_DIR) merged.RATATOSKR_DATA_DIR = path.join(main, 'data');
  return { env: { ...merged, ...env }, files };
}
