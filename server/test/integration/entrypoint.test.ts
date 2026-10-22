import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The container entrypoint (docker/entrypoint.sh), run for real in the Dockerfile's `base` stage:
 * the runtime image minus the app, so it builds in seconds.
 */
const IMAGE = 'ratatoskr-entrypoint-test';
const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/** Prepares /data as root, then runs the entrypoint with `env`, which reports on itself. */
function runEntrypoint(env: Record<string, string>, setup = 'true', report = 'id -u; id -g') {
  const envArgs = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  const script = `${setup} && exec ratatoskr-entrypoint sh -c '${report}'`;
  const r = spawnSync('docker', ['run', '--rm', ...envArgs, '--entrypoint', 'sh', IMAGE, '-c', script], {
    encoding: 'utf8',
  });
  return { status: r.status, out: r.stdout.trim().split('\n'), err: r.stderr };
}

beforeAll(() => {
  execFileSync('docker', ['build', '-q', '--target', 'base', '-t', IMAGE, ROOT], { stdio: 'pipe' });
}, 300_000);

afterAll(() => {
  spawnSync('docker', ['rmi', '-f', IMAGE]);
});

describe('container entrypoint', () => {
  it('runs as 1000:1000 (the node user, as older images did) when PUID and PGID are not set', () => {
    expect(runEntrypoint({}).out).toEqual(['1000', '1000']);
  });

  it('treats an empty PUID or PGID (a blank template field) as the default', () => {
    expect(runEntrypoint({ PUID: '', PGID: '' }).out).toEqual(['1000', '1000']);
  });

  it('runs as the PUID and PGID it is given, e.g. unRAID nobody:users', () => {
    expect(runEntrypoint({ PUID: '99', PGID: '100' }).out).toEqual(['99', '100']);
  });

  it('hands the whole data directory over to PUID:PGID when it belongs to someone else', () => {
    const r = runEntrypoint(
      { PUID: '99', PGID: '100' },
      'mkdir -p /data/sub && touch /data/ratatoskr.db /data/sub/f && chown -R 1000:1000 /data',
      'stat -c %u:%g /data /data/ratatoskr.db /data/sub/f',
    );
    expect(r.out).toEqual(['99:100', '99:100', '99:100']);
  });

  it('fixes ownership of files deeper in the data directory even when the directory itself is right', () => {
    const r = runEntrypoint(
      { PUID: '99', PGID: '100' },
      'mkdir -p /data && touch /data/ratatoskr.db && chown 1000:1000 /data/ratatoskr.db && chown 99:100 /data',
      'stat -c %u:%g /data/ratatoskr.db',
    );
    expect(r.out).toEqual(['99:100']);
  });

  it('creates and uses RATATOSKR_DATA_DIR when the data directory is moved', () => {
    const r = runEntrypoint({ PUID: '99', PGID: '100', RATATOSKR_DATA_DIR: '/srv/mail' }, 'true', 'stat -c %u:%g /srv/mail');
    expect(r.out).toEqual(['99:100']);
  });

  it('applies UMASK to files the server creates', () => {
    expect(runEntrypoint({ UMASK: '002' }, 'true', 'umask').out).toEqual(['0002']);
  });

  it('refuses to start with a non-numeric PUID, PGID or UMASK', () => {
    const invalid: Record<string, string>[] = [{ PUID: 'nobody' }, { PGID: 'users' }, { PUID: '-1' }, { UMASK: 'u=rwx' }];
    for (const env of invalid) {
      const r = runEntrypoint(env);
      expect(r.status).not.toBe(0);
      expect(r.err).toMatch(/must be/);
    }
  });

  it('leaves the user alone when the container is started with --user', () => {
    const r = spawnSync('docker', ['run', '--rm', '--user', '1234:5678', '-e', 'PUID=99', IMAGE, 'sh', '-c', 'id -u; id -g'], {
      encoding: 'utf8',
    });
    expect(r.stdout.trim().split('\n')).toEqual(['1234', '5678']);
  });
});
