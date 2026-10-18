import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { devEnvFiles, loadDevEnv, mainCheckoutDir } from '../../scripts/devEnv.mjs';

describe('dev server environment in git worktrees', () => {
  let tmp: string;
  let main: string;
  let worktree: string;

  beforeAll(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rk-devenv-')));
    main = path.join(tmp, 'main');
    worktree = path.join(tmp, 'task');
    fs.mkdirSync(main);
    const git = (...args: string[]) => execFileSync('git', ['-C', main, ...args], { stdio: 'ignore' });
    git('init', '-q');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'init');
    git('worktree', 'add', '-q', worktree);
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const write = (dir: string, content: string) => fs.writeFileSync(path.join(dir, '.env'), content);
  const remove = (dir: string) => fs.rmSync(path.join(dir, '.env'), { force: true });

  it('finds the main checkout from a worktree, but not from the main checkout itself', () => {
    expect(mainCheckoutDir(worktree)).toBe(main);
    expect(mainCheckoutDir(main)).toBeNull();
    expect(mainCheckoutDir(tmp)).toBeNull(); // not a git checkout at all
  });

  it("uses the main checkout's .env when the worktree has none", () => {
    write(main, 'RATATOSKR_SECRET_KEY=from-main\nRATATOSKR_DEV_LOGIN=true\n');
    remove(worktree);
    const { env, files } = loadDevEnv(worktree, {});
    expect(files).toEqual([path.join(main, '.env')]);
    expect(env).toMatchObject({ RATATOSKR_SECRET_KEY: 'from-main', RATATOSKR_DEV_LOGIN: 'true' });
  });

  it("lets the worktree's own .env override single values, and real environment variables override both", () => {
    write(main, 'RATATOSKR_SECRET_KEY=from-main\nRATATOSKR_DEV_LOGIN=true\nLOG_LEVEL=info\n');
    write(worktree, 'RATATOSKR_DEV_LOGIN=false\nLOG_LEVEL=debug\n');
    const { env } = loadDevEnv(worktree, { LOG_LEVEL: 'trace' });
    expect(env).toMatchObject({ RATATOSKR_SECRET_KEY: 'from-main', RATATOSKR_DEV_LOGIN: 'false', LOG_LEVEL: 'trace' });
  });

  it('loads only its own .env in the main checkout, and nothing when there is none', () => {
    write(main, 'A=1\n');
    expect(devEnvFiles(main)).toEqual([path.join(main, '.env')]);
    remove(main);
    remove(worktree);
    expect(loadDevEnv(worktree, { B: '2' })).toEqual({ env: { B: '2' }, files: [] });
  });

  it("never points a worktree at the main checkout's database", () => {
    remove(main);
    remove(worktree);
    expect(loadDevEnv(worktree, {}).env.RATATOSKR_DATA_DIR).toBeUndefined();
  });

  it("keeps a relative data directory from the main .env relative to the worktree", () => {
    write(main, 'RATATOSKR_DATA_DIR=./var/db\n');
    remove(worktree);
    expect(loadDevEnv(worktree, {}).env.RATATOSKR_DATA_DIR).toBe('./var/db');
  });
});
