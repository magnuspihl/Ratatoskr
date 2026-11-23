import type { MessageStructureObject } from 'imapflow';

/**
 * Reading large messages without downloading them.
 *
 * A message with big attachments can take a long time to fetch from the mail server, and the
 * reader would wait for all of it before showing anything. For such messages the server reads
 * the IMAP BODYSTRUCTURE instead, downloads only the headers and the text/HTML body parts, and
 * leaves every other part (attachments, inline images) to be fetched on its own afterwards.
 */

/** Messages larger than this (and not in the local cache) are opened part by part. */
export const LIGHT_LOAD_MIN_BYTES = 2 * 1024 * 1024;

/** Largest text or HTML body part downloaded for display. */
export const MAX_BODY_PART_BYTES = 8 * 1024 * 1024;

export interface StructurePart {
  /** IMAP body part number, e.g. "2" or "1.2". */
  part: string;
  mimeType: string;
  filename: string | null;
  /** Decoded size in bytes, estimated from the encoded size the server reports. */
  size: number;
  /** Content-ID without the angle brackets, lowercased. */
  contentId: string | null;
  disposition: 'inline' | 'attachment' | null;
  /** Content-Transfer-Encoding, lowercased. */
  encoding: string;
  /** Charset of a text part, lowercased. */
  charset: string | null;
}

export interface MessagePlan {
  /** HTML body parts, in message order (some mailers split the body around inline images). */
  html: StructurePart[];
  text: StructurePart[];
  /** Everything else: attachments and inline images, fetched separately when needed. */
  attachments: StructurePart[];
}

export function normaliseCid(cid: string): string {
  return cid.trim().replace(/^<|>$/g, '').toLowerCase();
}

/** The decoded size of `encodedSize` bytes in the given Content-Transfer-Encoding. */
export function decodedSize(encodedSize: number, encoding: string | undefined): number {
  if ((encoding ?? '').toLowerCase() === 'base64') {
    // 76 characters + CRLF per line, 4 characters per 3 bytes.
    return Math.floor(((encodedSize * 76) / 78) * 0.75);
  }
  return encodedSize;
}

function toPart(node: MessageStructureObject): StructurePart {
  const disposition = (node.disposition ?? '').toLowerCase();
  const filename = node.dispositionParameters?.filename ?? node.parameters?.name ?? null;
  return {
    // A message that isn't multipart has its body as part 1.
    part: node.part || '1',
    mimeType: (node.type || 'application/octet-stream').toLowerCase(),
    filename: filename || null,
    size: decodedSize(node.size ?? 0, node.encoding),
    contentId: node.id ? normaliseCid(node.id) : null,
    disposition: disposition === 'inline' || disposition === 'attachment' ? disposition : null,
    encoding: (node.encoding ?? '7bit').toLowerCase(),
    charset: node.parameters?.charset?.toLowerCase() ?? null,
  };
}

/** The leaf part with this number, or null (multiparts have no content of their own). */
export function findPart(root: MessageStructureObject, part: string): StructurePart | null {
  const walk = (node: MessageStructureObject): StructurePart | null => {
    if ((node.type || '').toLowerCase().startsWith('multipart/') && node.childNodes) {
      for (const child of node.childNodes) {
        const found = walk(child);
        if (found) return found;
      }
      return null;
    }
    const p = toPart(node);
    return p.part === part ? p : null;
  };
  return walk(root);
}

function decodeQuotedPrintable(input: Buffer): Buffer {
  const s = input.toString('latin1').replace(/=\r?\n/g, '');
  const out = Buffer.alloc(s.length);
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const hex = s[i] === '=' ? s.slice(i + 1, i + 3) : '';
    if (/^[0-9a-f]{2}$/i.test(hex)) {
      out[n++] = Number.parseInt(hex, 16);
      i += 2;
    } else out[n++] = s.charCodeAt(i) & 0xff;
  }
  return out.subarray(0, n);
}

/** Undo a part's Content-Transfer-Encoding. */
export function decodeTransfer(raw: Buffer, encoding: string): Buffer {
  switch (encoding.toLowerCase()) {
    case 'base64':
      return Buffer.from(raw.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
    case 'quoted-printable':
      return decodeQuotedPrintable(raw);
    default:
      return raw;
  }
}

/** Text in a declared charset as a string; unknown charsets are read as UTF-8. */
export function decodeText(bytes: Buffer, charset: string | null): string {
  const label = !charset || charset === 'us-ascii' || charset === 'ascii' ? 'utf-8' : charset;
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/** Split a BODYSTRUCTURE into the body to display and the parts to load on demand. */
export function planMessage(root: MessageStructureObject): MessagePlan {
  const plan: MessagePlan = { html: [], text: [], attachments: [] };
  const walk = (node: MessageStructureObject) => {
    const type = (node.type || '').toLowerCase();
    // A forwarded message is one attachment; its own parts aren't this message's body.
    if (type.startsWith('multipart/') && node.childNodes) {
      for (const child of node.childNodes) walk(child);
      return;
    }
    const p = toPart(node);
    const isBody = p.disposition !== 'attachment' && !p.filename;
    if (isBody && type === 'text/html') plan.html.push(p);
    else if (isBody && type === 'text/plain') plan.text.push(p);
    else plan.attachments.push(p);
  };
  walk(root);
  return plan;
}

/** Part numbers are dot-separated integers; anything else is not a part of a message. */
export const PART_PATTERN = /^[1-9]\d{0,4}(\.[1-9]\d{0,4}){0,9}$/;
