import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/** scripts/release-version.sh, which the Release workflow uses to pick the version to publish. */
const SCRIPT = fileURLToPath(new URL('../../scripts/release-version.sh', import.meta.url));

let repo: string | undefined;

/** A throwaway repository with one commit carrying the given tags. */
function repoWithTags(...tags: string[]) {
  repo = mkdtempSync(path.join(tmpdir(), 'ratatoskr-release-'));
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], { cwd: repo, stdio: 'pipe' });
  git('init', '-q');
  git('commit', '-q', '--allow-empty', '-m', 'init');
  for (const t of tags) git('tag', t);
}

function run(...args: string[]) {
  const r = spawnSync('bash', [SCRIPT, ...args], { cwd: repo, encoding: 'utf8' });
  return { status: r.status, out: r.stdout.trim(), err: r.stderr };
}

afterEach(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
  repo = undefined;
});

describe('release version', () => {
  it('starts from 0.0.0 when nothing has been released yet', () => {
    repoWithTags();
    expect(run('bump', 'patch').out).toBe('0.0.1');
    expect(run('bump', 'minor').out).toBe('0.1.0');
    expect(run('bump', 'major').out).toBe('1.0.0');
  });

  it('bumps patch, minor or major off the newest release tag, resetting the lower parts', () => {
    repoWithTags('v1.4.2');
    expect(run('bump', 'patch').out).toBe('1.4.3');
    expect(run('bump', 'minor').out).toBe('1.5.0');
    expect(run('bump', 'major').out).toBe('2.0.0');
  });

  it('finds the newest tag by version number, not alphabetically (v0.10.0 is newer than v0.9.0)', () => {
    repoWithTags('v0.9.0', 'v0.10.0', 'v0.2.5');
    expect(run('bump', 'patch').out).toBe('0.10.1');
  });

  it('ignores pre-release and other non-release tags when bumping', () => {
    repoWithTags('v1.0.0', 'v2.0.0-rc1', 'vnext', 'release-9');
    expect(run('bump', 'minor').out).toBe('1.1.0');
  });

  it('rejects a bump other than patch, minor or major', () => {
    repoWithTags('v1.0.0');
    const r = run('bump', 'huge');
    expect(r.status).not.toBe(0);
    expect(r.err).toMatch(/patch, minor or major/);
  });

  it('uses a pushed tag verbatim, with or without the leading v', () => {
    repoWithTags();
    expect(run('tag', 'v3.2.1').out).toBe('3.2.1');
    expect(run('tag', '3.2.1').out).toBe('3.2.1');
  });

  it('rejects a pushed tag that is not MAJOR.MINOR.PATCH', () => {
    repoWithTags();
    for (const tag of ['v1.2', 'v1.2.3-rc1', 'vnext', '']) {
      const r = run('tag', tag);
      expect(r.status).not.toBe(0);
      expect(r.out).toBe('');
    }
  });
});
