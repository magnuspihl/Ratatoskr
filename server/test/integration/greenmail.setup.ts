import { execFileSync } from 'node:child_process';
import net from 'node:net';
import type { TestProject } from 'vitest/node';

/**
 * Starts a throwaway GreenMail (IMAP+SMTP test server) container for the integration tests and
 * removes it afterwards. Requires Docker. Ports are bound to 127.0.0.1 on random host ports.
 */
const IMAGE = 'greenmail/standalone:2.1.3';

declare module 'vitest' {
  export interface ProvidedContext {
    greenmail: { host: string; imapPort: number; smtpPort: number };
  }
}

function docker(...args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8' }).trim();
}

async function waitForGreeting(port: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const s = net.connect(port, '127.0.0.1');
      s.setTimeout(2000);
      s.once('data', (d) => {
        s.destroy();
        resolve(d.toString().startsWith('* OK'));
      });
      s.once('error', () => resolve(false));
      s.once('close', () => resolve(false));
      s.once('timeout', () => {
        s.destroy();
        resolve(false);
      });
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('GreenMail did not become ready in time');
}

export default async function setup(project: TestProject) {
  const id = docker(
    'run', '-d', '--rm',
    '-p', '127.0.0.1::3025',
    '-p', '127.0.0.1::3143',
    '-e', 'GREENMAIL_OPTS=-Dgreenmail.setup.test.smtp -Dgreenmail.setup.test.imap -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.auth.disabled',
    IMAGE,
  );
  const port = (p: number) => Number(docker('port', id, `${p}/tcp`).split('\n')[0]!.split(':').pop());
  try {
    const imapPort = port(3143);
    const smtpPort = port(3025);
    await waitForGreeting(imapPort, 60_000);
    project.provide('greenmail', { host: '127.0.0.1', imapPort, smtpPort });
  } catch (err) {
    docker('rm', '-f', id);
    throw err;
  }
  return () => {
    docker('rm', '-f', id);
  };
}
