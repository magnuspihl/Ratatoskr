import path from 'node:path';
import { parseHostSuffix } from '../../shared/devHosts.js';

export interface Config {
  production: boolean;
  host: string;
  port: number;
  baseUrl: URL;
  secretKey: string;
  dataDir: string;
  trustProxy: boolean;
  logLevel: string;
  oidc: {
    issuerUrl: string;
    clientId: string;
    clientSecret: string;
    scopes: string;
  } | null;
  /** Development-only login bypass. Never honoured when NODE_ENV=production. */
  devLogin: boolean;
  /**
   * Development-only: extra hostnames (ending in this suffix) the app may be served from, e.g. via
   * several reverse-proxied dev ports. Always null when NODE_ENV=production.
   */
  devAllowedHostSuffix: string | null;
  /** Refuse IMAP/SMTP hosts that resolve to private/internal addresses. */
  blockPrivateMailHosts: boolean;
  /** Close pooled IMAP connections after this many ms without use. */
  imapIdleTimeoutMs: number;
  /** Largest message (bytes) the server will download for display. */
  maxMessageBytes: number;
  /** Largest total upload size (bytes) for compose attachments. */
  maxUploadBytes: number;
  webDir: string;
  /** Contact for push services (VAPID `sub`): a mailto: or https: URL. */
  vapidSubject: string;
}

function bool(v: string | undefined, def: boolean): boolean {
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

function int(v: string | undefined, def: number): number {
  const n = v ? Number.parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? n : def;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const production = env.NODE_ENV === 'production';
  const port = int(env.PORT, 8080);
  const errors: string[] = [];

  const secretKey = env.RATATOSKR_SECRET_KEY ?? '';
  if (secretKey.length < 32) errors.push('RATATOSKR_SECRET_KEY must be set to at least 32 characters');

  let baseUrl: URL;
  try {
    baseUrl = new URL(env.RATATOSKR_BASE_URL || `http://localhost:${port}`);
  } catch {
    errors.push('RATATOSKR_BASE_URL is not a valid URL');
    baseUrl = new URL(`http://localhost:${port}`);
  }

  const oidc = env.OIDC_ISSUER_URL
    ? {
        issuerUrl: env.OIDC_ISSUER_URL,
        clientId: env.OIDC_CLIENT_ID ?? '',
        clientSecret: env.OIDC_CLIENT_SECRET ?? '',
        scopes: env.OIDC_SCOPES || 'openid email profile',
      }
    : null;
  if (oidc && !oidc.clientId) errors.push('OIDC_CLIENT_ID is required when OIDC_ISSUER_URL is set');

  const devLogin = !production && bool(env.RATATOSKR_DEV_LOGIN, false);
  if (!oidc && !devLogin) {
    errors.push('OIDC_ISSUER_URL is required (or RATATOSKR_DEV_LOGIN=true outside production)');
  }

  let devAllowedHostSuffix: string | null = null;
  if (!production) {
    try {
      devAllowedHostSuffix = parseHostSuffix(env.RATATOSKR_DEV_ALLOWED_HOST_SUFFIX);
    } catch (err) {
      errors.push((err as Error).message);
    }
  }

  const vapidSubject =
    env.RATATOSKR_VAPID_SUBJECT ||
    (baseUrl.protocol === 'https:' ? baseUrl.origin : `mailto:postmaster@${baseUrl.hostname}`);
  if (!/^(mailto:\S+@\S+|https:\/\/\S+)$/.test(vapidSubject)) {
    errors.push('RATATOSKR_VAPID_SUBJECT must be a mailto: or https: URL');
  }

  if (errors.length) throw new Error(`Invalid configuration:\n  - ${errors.join('\n  - ')}`);

  return {
    production,
    host: env.HOST || '0.0.0.0',
    port,
    baseUrl,
    secretKey,
    dataDir: path.resolve(env.RATATOSKR_DATA_DIR || './data'),
    trustProxy: bool(env.RATATOSKR_TRUST_PROXY, false),
    logLevel: env.LOG_LEVEL || 'info',
    oidc,
    devLogin,
    devAllowedHostSuffix,
    blockPrivateMailHosts: bool(env.RATATOSKR_BLOCK_PRIVATE_MAIL_HOSTS, false),
    imapIdleTimeoutMs: int(env.RATATOSKR_IMAP_IDLE_TIMEOUT, 300) * 1000,
    maxMessageBytes: int(env.RATATOSKR_MAX_MESSAGE_MB, 50) * 1024 * 1024,
    maxUploadBytes: int(env.RATATOSKR_MAX_UPLOAD_MB, 25) * 1024 * 1024,
    webDir: path.resolve(env.RATATOSKR_WEB_DIR || './dist/web'),
    vapidSubject,
  };
}
