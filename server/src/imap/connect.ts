import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import type { TlsMode } from '../../../shared/types.js';
import { assertPublicHost } from '../net/ssrf.js';

export interface ServerSettings {
  host: string;
  port: number;
  tls: TlsMode;
  user: string;
  password: string;
}

export interface ConnectOptions {
  blockPrivateHosts: boolean;
  /** Keep the connection IDLE-ing automatically (watchers) or not (command connections). */
  autoIdle?: boolean;
}

/** Thrown for problems that should be shown to the user verbatim (bad password, unreachable, ...). */
export class MailServerError extends Error {
  constructor(
    message: string,
    readonly kind: 'auth' | 'network' | 'tls' | 'protocol' | 'blocked',
  ) {
    super(message);
  }
}

export function describeError(err: unknown, server: string): MailServerError {
  if (err instanceof MailServerError) return err;
  const e = err as { code?: string; authenticationFailed?: boolean; responseText?: string; message?: string };
  if (e.code === 'EBLOCKED') return new MailServerError(`${server}: internal addresses are not allowed`, 'blocked');
  if (e.authenticationFailed || e.code === 'EAUTH' || /auth/i.test(e.responseText ?? '')) {
    return new MailServerError(`${server}: authentication failed, check username and password`, 'auth');
  }
  if (['ENOTFOUND', 'EAI_AGAIN'].includes(e.code ?? '')) return new MailServerError(`${server}: host not found`, 'network');
  if (['ECONNREFUSED', 'ETIMEDOUT', 'CONNECT_TIMEOUT', 'ECONNRESET', 'EHOSTUNREACH', 'ETIMEOUT'].includes(e.code ?? '')) {
    return new MailServerError(`${server}: could not connect (${e.code})`, 'network');
  }
  if (/certificate|self[- ]signed|TLS|SSL|wrong version/i.test(e.message ?? '') || e.code === 'ESOCKET') {
    return new MailServerError(`${server}: TLS error: ${e.message ?? 'handshake failed'}`, 'tls');
  }
  return new MailServerError(`${server}: ${e.responseText || e.message || 'unknown error'}`, 'protocol');
}

export function createImapClient(s: ServerSettings, opts: ConnectOptions): ImapFlow {
  const client = new ImapFlow({
    host: s.host,
    port: s.port,
    secure: s.tls === 'tls',
    doSTARTTLS: s.tls === 'starttls' ? true : s.tls === 'none' ? false : undefined,
    auth: { user: s.user, pass: s.password },
    logger: false,
    disableAutoIdle: !opts.autoIdle,
    maxIdleTime: 4 * 60 * 1000,
    connectionTimeout: 20_000,
    greetingTimeout: 15_000,
    socketTimeout: 6 * 60 * 1000,
    clientInfo: { name: 'Ratatoskr' },
  });
  // An unhandled 'error' event would crash the process; failures surface through promises.
  client.on('error', () => {});
  return client;
}

export async function connectImap(s: ServerSettings, opts: ConnectOptions): Promise<ImapFlow> {
  try {
    if (opts.blockPrivateHosts) await assertPublicHost(s.host);
    const client = createImapClient(s, opts);
    await client.connect();
    return client;
  } catch (err) {
    throw describeError(err, `IMAP ${s.host}`);
  }
}

export function createSmtpTransport(s: ServerSettings) {
  return nodemailer.createTransport({
    host: s.host,
    port: s.port,
    secure: s.tls === 'tls',
    requireTLS: s.tls === 'starttls',
    ignoreTLS: s.tls === 'none',
    auth: s.user ? { user: s.user, pass: s.password } : undefined,
    connectionTimeout: 20_000,
    greetingTimeout: 15_000,
    socketTimeout: 60_000,
    logger: false,
  });
}

/** Verify IMAP and SMTP settings by actually logging in to both. */
export async function testConnection(imap: ServerSettings, smtp: ServerSettings, blockPrivateHosts: boolean) {
  const client = await connectImap(imap, { blockPrivateHosts });
  await client.logout().catch(() => client.close());
  try {
    if (blockPrivateHosts) await assertPublicHost(smtp.host);
    const transport = createSmtpTransport(smtp);
    try {
      await transport.verify();
    } finally {
      transport.close();
    }
  } catch (err) {
    throw describeError(err, `SMTP ${smtp.host}`);
  }
}
