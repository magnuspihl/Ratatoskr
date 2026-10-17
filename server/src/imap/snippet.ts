import type { MessageStructureObject } from 'imapflow';
import { convert } from 'html-to-text';

export interface TextPart {
  part: string;
  type: 'text/plain' | 'text/html';
  encoding: string;
  charset: string;
}

/** Bytes fetched per message to build a list snippet. */
export const SNIPPET_FETCH_BYTES = 3072;
const SNIPPET_LENGTH = 180;

function isAttachment(node: MessageStructureObject): boolean {
  return node.disposition?.toLowerCase() === 'attachment';
}

/** Find the best part to build a preview snippet from: text/plain first, then text/html. */
export function findTextPart(root: MessageStructureObject | undefined): TextPart | null {
  if (!root) return null;
  let plain: TextPart | null = null;
  let html: TextPart | null = null;
  const visit = (node: MessageStructureObject, depth: number) => {
    if (depth > 20 || (plain && html)) return;
    const type = node.type?.toLowerCase();
    if (node.childNodes?.length) {
      for (const child of node.childNodes) visit(child, depth + 1);
      return;
    }
    if (type === 'message/rfc822' || isAttachment(node)) return;
    const info = {
      part: node.part || '1',
      encoding: (node.encoding || '7bit').toLowerCase(),
      charset: node.parameters?.charset || 'utf-8',
    };
    if (type === 'text/plain' && !plain) plain = { ...info, type: 'text/plain' };
    if (type === 'text/html' && !html) html = { ...info, type: 'text/html' };
  };
  visit(root, 0);
  return plain ?? html;
}

/** Does the structure contain attachments (not counting inline images in HTML)? */
export function hasAttachments(root: MessageStructureObject | undefined): boolean {
  if (!root) return false;
  let found = false;
  const visit = (node: MessageStructureObject, depth: number) => {
    if (found || depth > 20) return;
    if (node.childNodes?.length) {
      for (const child of node.childNodes) visit(child, depth + 1);
      return;
    }
    const type = node.type?.toLowerCase() ?? '';
    if (isAttachment(node)) found = true;
    else if (node.dispositionParameters?.filename || node.parameters?.name) {
      if (!(node.disposition?.toLowerCase() === 'inline' && type.startsWith('image/'))) found = true;
    } else if (type === 'message/rfc822') found = true;
  };
  visit(root, 0);
  return found;
}

function decodeQuotedPrintable(input: Buffer): Buffer {
  const s = input.toString('latin1').replace(/=\r?\n/g, '');
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === '=' && /^[0-9a-f]{2}$/i.test(s.slice(i + 1, i + 3))) {
      out.push(Number.parseInt(s.slice(i + 1, i + 3), 16));
      i += 2;
    } else out.push(s.charCodeAt(i) & 0xff);
  }
  return Buffer.from(out);
}

function decodeCharset(bytes: Buffer, charset: string): string {
  try {
    return new TextDecoder(charset.toLowerCase(), { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/**
 * Decode a (possibly truncated) body part fetched with a byte range into a short snippet.
 * Truncation may cut a base64 quantum, a QP escape or a multi-byte character, all of which are
 * tolerated.
 */
export function snippetFromPart(raw: Buffer, part: TextPart, alreadyDecoded = false): string {
  let bytes = raw;
  if (!alreadyDecoded) {
    if (part.encoding === 'base64') {
      const clean = raw.toString('latin1').replace(/[^A-Za-z0-9+/]/g, '');
      bytes = Buffer.from(clean.slice(0, clean.length - (clean.length % 4)), 'base64');
    } else if (part.encoding === 'quoted-printable') {
      bytes = decodeQuotedPrintable(raw);
    }
  }
  let text = decodeCharset(bytes, part.charset);
  if (part.type === 'text/html') {
    // Strip any trailing partial tag before converting.
    text = text.replace(/<[^>]*$/, '');
    text = convert(text, {
      wordwrap: false,
      selectors: [
        { selector: 'a', options: { ignoreHref: true } },
        { selector: 'img', format: 'skip' },
        { selector: 'style', format: 'skip' },
        { selector: 'head', format: 'skip' },
      ],
    });
  }
  return text
    .split('\n')
    .filter((l) => !/^\s*>/.test(l)) // drop quoted lines
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, SNIPPET_LENGTH);
}
