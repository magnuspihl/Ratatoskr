import type { AccountDefaults, AccountInput, TlsMode } from '../../shared/types.js';
import { DEFAULT_PORTS } from '../../shared/mailPorts.js';

/** Tokens an admin can use in default account values, e.g. `{username}@example.com`. */
export const TEMPLATE_TOKENS = ['username', 'email', 'name'] as const;
export type TemplateToken = (typeof TEMPLATE_TOKENS)[number];
export type TemplateValues = Record<TemplateToken, string>;

/**
 * Instance-wide starting values for new mail accounts (RATATOSKR_DEFAULT_*). Strings are templates;
 * empty means "no default".
 */
export interface AccountDefaultsConfig {
  name: string;
  displayName: string;
  email: string;
  imap: { host: string; port: number | null; tls: TlsMode | null };
  smtp: { host: string; port: number | null; tls: TlsMode | null };
  /** Username for both IMAP and SMTP. */
  user: string;
  /** Password for both IMAP and SMTP, taken literally (not a template). Never sent to the browser. */
  password: string;
}

const TOKEN_RE = /\{([^{}]*)\}/g;

/** Tokens in a template that aren't known, e.g. a typo like `{usename}`. */
export function unknownTokens(template: string): string[] {
  return [...template.matchAll(TOKEN_RE)].map((m) => m[1]!).filter((t) => !(TEMPLATE_TOKENS as readonly string[]).includes(t));
}

/**
 * Fills in the tokens. If a token the template uses has no value for this user (say, an OIDC user
 * without an email address), the result is empty rather than half a value like "@example.com".
 */
export function expandTemplate(template: string, values: TemplateValues): string {
  let missing = false;
  const out = template.replace(TOKEN_RE, (_, token: string) => {
    const v = values[token as TemplateToken] ?? '';
    if (!v) missing = true;
    return v;
  });
  return missing ? '' : out.trim();
}

/** The "Add account" form's starting values for one user. */
export function accountDefaultsFor(config: AccountDefaultsConfig, values: TemplateValues): AccountDefaults {
  const server = (kind: 'imap' | 'smtp') => {
    const c = config[kind];
    const tls = c.tls ?? 'tls';
    return { host: expandTemplate(c.host, values), port: c.port ?? DEFAULT_PORTS[kind][tls], tls, user: expandTemplate(config.user, values) };
  };
  return {
    name: expandTemplate(config.name, values),
    displayName: expandTemplate(config.displayName, values),
    email: expandTemplate(config.email, values),
    imap: server('imap'),
    smtp: server('smtp'),
    password: config.password !== '',
  };
}

const sameHost = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Fills blank passwords of a new account with the admin's default password. Only for a server that
 * is still the default one: if the user points the account somewhere else, the shared password must
 * not be sent there.
 */
export function withDefaultPassword(config: AccountDefaultsConfig, values: TemplateValues, input: AccountInput): AccountInput {
  if (!config.password) return input;
  const fallback = (kind: 'imap' | 'smtp') => {
    const host = expandTemplate(config[kind].host, values);
    return host && sameHost(host, input[kind].host) ? config.password : '';
  };
  return {
    ...input,
    imap: { ...input.imap, password: input.imap.password || fallback('imap') },
    smtp: { ...input.smtp, password: input.smtp.password || input.imap.password || fallback('smtp') },
  };
}
