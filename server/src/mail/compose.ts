import { convert } from 'html-to-text';
import MailComposer from 'nodemailer/lib/mail-composer';
import addressparser from 'nodemailer/lib/addressparser';
import sanitizeHtml from 'sanitize-html';
import type { Address } from '../../../shared/types.js';

export interface OutgoingAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
}

export interface OutgoingMessage {
  from: Address;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  html: string;
  inReplyTo: string | null;
  references: string[];
  attachments: OutgoingAttachment[];
}

const MESSAGE_ID = /^<[^<>\s@]+@[^<>\s@]+>$/;

/** Parse a comma separated recipient field ("A <a@example.com>, b@example.com"). */
export function parseAddressList(input: string): Address[] {
  if (!input.trim()) return [];
  const out: Address[] = [];
  const visit = (entries: ReturnType<typeof addressparser>) => {
    for (const e of entries) {
      if ('group' in e && e.group) visit(e.group);
      else if ('address' in e && e.address) out.push({ name: e.name ?? '', address: e.address });
    }
  };
  visit(addressparser(input));
  return out;
}

export function isValidAddress(a: string): boolean {
  return /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/.test(a);
}

/**
 * The editor produces HTML in the user's browser; it is still sanitized before it is sent so that
 * nothing unexpected (scripts, remote references to this server, ...) ends up in outgoing mail.
 */
export function sanitizeOutgoingHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: [
      'a', 'b', 'blockquote', 'br', 'code', 'div', 'em', 'h1', 'h2', 'h3', 'h4', 'hr', 'i', 'img', 'li',
      'ol', 'p', 'pre', 's', 'span', 'strike', 'strong', 'sub', 'sup', 'table', 'tbody', 'td', 'th',
      'thead', 'tr', 'u', 'ul', 'font', 'center',
    ],
    allowedAttributes: {
      '*': ['style', 'dir', 'align'],
      a: ['href', 'title'],
      img: ['src', 'alt', 'width', 'height'],
      font: ['color', 'face', 'size'],
      td: ['colspan', 'rowspan'],
      th: ['colspan', 'rowspan'],
      blockquote: ['type', 'cite'],
    },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowedSchemesByTag: { img: ['data', 'https', 'http'] },
    allowProtocolRelative: false,
    // Relative URLs (for example the app's own image proxy) must never leave the server.
    exclusiveFilter: (frame) => frame.tag === 'img' && !/^(data:image\/|https?:)/i.test(frame.attribs.src ?? ''),
  });
}

export function htmlToPlainText(html: string): string {
  return convert(html, {
    wordwrap: 76,
    selectors: [
      { selector: 'img', format: 'skip' },
      { selector: 'a', options: { hideLinkHrefIfSameAsText: true } },
      { selector: 'blockquote', format: 'blockquote' },
    ],
  });
}

/**
 * Build the raw RFC 5322 message. The same bytes are sent over SMTP and appended to Sent, so the
 * stored copy is exactly what recipients received. Drafts keep the Bcc header.
 */
export async function buildRawMessage(
  msg: OutgoingMessage,
  opts: { keepBcc: boolean },
): Promise<{ raw: Buffer; messageId: string; envelope: { from: string; to: string[] } }> {
  const html = sanitizeOutgoingHtml(msg.html);
  const references = msg.references.filter((r) => MESSAGE_ID.test(r)).slice(-30);
  const inReplyTo = msg.inReplyTo && MESSAGE_ID.test(msg.inReplyTo) ? msg.inReplyTo : undefined;
  if (inReplyTo && !references.includes(inReplyTo)) references.push(inReplyTo);

  const composer = new MailComposer({
    from: msg.from,
    to: msg.to,
    cc: msg.cc,
    bcc: msg.bcc,
    subject: msg.subject,
    inReplyTo,
    references: references.length ? references : undefined,
    html,
    text: htmlToPlainText(html),
    attachments: msg.attachments.map((a) => ({
      filename: a.filename,
      contentType: a.contentType,
      content: a.content,
    })),
    // Pasted inline images become proper cid: attachments.
    attachDataUrls: true,
    // Never let message content reference local files or fetch URLs on the server.
    disableFileAccess: true,
    disableUrlAccess: true,
    xMailer: 'Ratatoskr',
  });
  const node = composer.compile();
  if (opts.keepBcc) (node as unknown as { keepBcc: boolean }).keepBcc = true;
  const envelope = node.getEnvelope();
  const raw = await node.build();
  return {
    raw,
    messageId: node.messageId(),
    envelope: { from: envelope.from || msg.from.address, to: envelope.to },
  };
}
