/**
 * Development-only host matching, shared by the Vite dev server (Host header check) and the
 * backend (WebSocket Origin check in development).
 *
 * RATATOSKR_DEV_ALLOWED_HOST_SUFFIX lets one dev setup be reached through several reverse-proxied
 * hostnames that differ only in a leading part, e.g. `<port>--myworkspace--me.dev.example.com`.
 * The suffix must start with `.` or `--` so it can only match at a label/segment boundary.
 */

const SUFFIX_RE = /^(?:\.|--)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
const HOSTNAME_RE = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

/**
 * Normalises a suffix setting. Returns null when unset; throws when set but unusable, so a typo
 * doesn't silently fall back to "no extra hosts" (or, worse, match too much).
 */
export function parseHostSuffix(raw: string | undefined): string | null {
  const value = (raw ?? '').trim().toLowerCase();
  if (!value) return null;
  if (!SUFFIX_RE.test(value) || !value.slice(1).includes('.')) {
    throw new Error(
      `RATATOSKR_DEV_ALLOWED_HOST_SUFFIX must start with "." or "--" and end in a domain (e.g. --myworkspace--me.dev.example.com), got ${JSON.stringify(raw)}`,
    );
  }
  return value;
}

/** Hostname (lowercase, no port) from a Host header or URL authority; null when malformed. */
export function hostnameOf(hostHeader: string | undefined): string | null {
  if (!hostHeader) return null;
  try {
    const url = new URL(`http://${hostHeader}`);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
    return url.hostname;
  } catch {
    return null;
  }
}

/** True when `hostname` is `<something><suffix>`: an exact suffix match with a non-empty prefix. */
export function matchesHostSuffix(hostname: string, suffix: string | null): boolean {
  if (!suffix) return false;
  const host = hostname.toLowerCase();
  return HOSTNAME_RE.test(host) && host.length > suffix.length && host.endsWith(suffix);
}

/** Whether the dev server should answer a request carrying this Host header. */
export function isDevHostAllowed(hostHeader: string | undefined, opts: { hosts: readonly string[]; suffix: string | null }): boolean {
  const hostname = hostnameOf(hostHeader);
  if (!hostname) return false;
  // Same built-ins as Vite: localhost and IP literals can't be used for DNS rebinding.
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || isIpLiteral(hostname)) return true;
  if (opts.hosts.includes(hostname)) return true;
  return matchesHostSuffix(hostname, opts.suffix);
}

function isIpLiteral(hostname: string): boolean {
  return hostname.startsWith('[') || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname);
}
