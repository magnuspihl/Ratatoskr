/**
 * mailto: links (RFC 6068). Pure functions, no DOM access, so they can be unit tested.
 *
 * Ratatoskr handles mailto: links itself in three places:
 *   - links in plain-text bodies open the composer directly;
 *   - links in HTML mail (inside the scriptless, sandboxed frame, where clicks can't be caught)
 *     point at `/?mailto=…`, which opens Ratatoskr in a new tab with the composer ready;
 *   - the browser can be told to send every mailto: link to `/?mailto=%s` (Settings, or the
 *     installed app's manifest).
 *
 * Only the recipients, subject and a plain-text body are taken from a link. Anything else (other
 * headers, attachments) is ignored, and nothing is ever sent without the user pressing Send.
 */

export interface MailtoFields {
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  body: string;
}

/** The query parameter the app is opened with to compose from a mailto: link. */
export const MAILTO_PARAM = 'mailto';

/** sessionStorage key for a mailto: link waiting for the user to be signed in with an account. */
export const PENDING_MAILTO_KEY = 'ratatoskr.pendingMailto';

const MAX_URL = 8000;
const MAX_FIELD = 4000;

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    // A stray '%' that isn't an escape: keep the text as it is.
    return s;
  }
}

/** Joins address lists with ", ", skipping empty parts. */
function joinAddresses(...lists: string[]): string {
  return lists
    .flatMap((l) => l.split(','))
    .map((a) => a.trim())
    .filter(Boolean)
    .join(', ');
}

/** Removes control characters (incl. CR/LF), so a link can't smuggle extra header lines. */
const oneLine = (s: string) => s.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();

/** Parses a mailto: URL. Returns null for anything that isn't one. */
export function parseMailto(url: string): MailtoFields | null {
  const raw = url.trim();
  if (raw.length > MAX_URL || !/^mailto:/i.test(raw)) return null;
  const rest = raw.slice('mailto:'.length);
  const q = rest.indexOf('?');
  const fields: MailtoFields = { to: '', cc: '', bcc: '', subject: '', body: '' };
  const to: string[] = [decode(q === -1 ? rest : rest.slice(0, q))];
  const cc: string[] = [];
  const bcc: string[] = [];
  if (q !== -1) {
    // Not URLSearchParams: in mailto: URLs '+' is a literal plus (user+tag@example.com).
    for (const pair of rest.slice(q + 1).split('&')) {
      const eq = pair.indexOf('=');
      const name = decode(eq === -1 ? pair : pair.slice(0, eq)).toLowerCase();
      const value = eq === -1 ? '' : decode(pair.slice(eq + 1));
      if (name === 'to') to.push(value);
      else if (name === 'cc') cc.push(value);
      else if (name === 'bcc') bcc.push(value);
      else if (name === 'subject' && !fields.subject) fields.subject = oneLine(value);
      else if (name === 'body' && !fields.body) fields.body = value.replace(/\r\n?/g, '\n');
    }
  }
  fields.to = oneLine(joinAddresses(...to));
  fields.cc = oneLine(joinAddresses(...cc));
  fields.bcc = oneLine(joinAddresses(...bcc));
  for (const k of Object.keys(fields) as (keyof MailtoFields)[]) fields[k] = fields[k].slice(0, MAX_FIELD);
  return fields;
}

/** The app URL that opens the composer for a mailto: link. */
export function composeUrl(mailto: string, origin: string): string {
  return `${origin}/?${MAILTO_PARAM}=${encodeURIComponent(mailto)}`;
}

/** The URL template registered with the browser for mailto: links (%s is the link). */
export function handlerTemplate(origin: string): string {
  return `${origin}/?${MAILTO_PARAM}=%s`;
}

/**
 * The mailto: link the app was opened with (null if it isn't a valid one), and the query string
 * without it. Returns null when the URL has no mailto parameter at all.
 */
export function takeMailtoParam(search: string): { mailto: string | null; search: string } | null {
  const params = new URLSearchParams(search);
  const value = params.get(MAILTO_PARAM);
  if (value === null) return null;
  params.delete(MAILTO_PARAM);
  const rest = params.toString();
  return { mailto: parseMailto(value) ? value : null, search: rest ? `?${rest}` : '' };
}

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e: string) => {
    const k = e.toLowerCase();
    if (k === 'amp') return '&';
    if (k === 'lt') return '<';
    if (k === 'gt') return '>';
    if (k === 'quot') return '"';
    if (k === 'apos') return "'";
    const code = k.startsWith('#x') ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
  });
}

const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Points mailto: links in server-sanitized message HTML at the app's composer. The sanitizer
 * always writes attributes double-quoted with '"' and '>' escaped, which this relies on.
 */
export function rewriteMailtoLinks(html: string, origin: string): string {
  return html.replace(/(<a\b[^>]*?\shref=")(mailto:[^"]*)"/gi, (_m, start: string, href: string) => {
    const mailto = decodeEntities(href);
    return `${start}${escapeAttr(composeUrl(mailto, origin))}"`;
  });
}

const LINK_RE = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]|\bmailto:[^\s<>"']+[^\s<>"'.,;:!?)\]]|[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

export type TextPart = string | { href: string; text: string; mailto: boolean };

/** Splits a line of plain text into text and links (http(s) URLs, mailto: links, email addresses). */
export function linkify(line: string): TextPart[] {
  const parts: TextPart[] = [];
  let last = 0;
  for (const m of line.matchAll(LINK_RE)) {
    const text = m[0];
    if (m.index > last) parts.push(line.slice(last, m.index));
    if (/^https?:/i.test(text)) parts.push({ href: text, text, mailto: false });
    else parts.push({ href: /^mailto:/i.test(text) ? text : `mailto:${text}`, text, mailto: true });
    last = m.index + text.length;
  }
  if (last < line.length) parts.push(line.slice(last));
  return parts;
}
