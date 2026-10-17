import PostalMime from 'postal-mime';
import type { Address as PmAddress, Attachment, Email } from 'postal-mime';
import type { Address, AttachmentView, DomainName, MessageDetail } from '../../../shared/types.js';
import { sanitizeEmailHtml, type SanitizeOptions } from './sanitize.js';

export type ParsedEmail = Email;

const INLINE_IMAGE = /^image\/(png|jpe?g|gif|webp|avif|bmp)$/i;
const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;

export function parseRaw(raw: Buffer | Uint8Array): Promise<ParsedEmail> {
  return PostalMime.parse(raw, { attachmentEncoding: 'arraybuffer', maxNestingDepth: 50 });
}

export function flattenAddresses(input: PmAddress | PmAddress[] | undefined): Address[] {
  if (!input) return [];
  const list = Array.isArray(input) ? input : [input];
  const out: Address[] = [];
  for (const a of list) {
    if (a.group) out.push(...a.group.map((m) => ({ name: m.name ?? '', address: m.address ?? '' })));
    else if (a.address) out.push({ name: a.name ?? '', address: a.address });
  }
  return out;
}

export function attachmentBytes(a: Attachment): Buffer {
  if (typeof a.content === 'string') return Buffer.from(a.content, a.encoding === 'base64' ? 'base64' : 'utf8');
  if (a.content instanceof ArrayBuffer) return Buffer.from(a.content);
  return Buffer.from(a.content.buffer, a.content.byteOffset, a.content.byteLength);
}

function normaliseCid(cid: string): string {
  return cid.trim().replace(/^<|>$/g, '').toLowerCase();
}

export function parseReferences(value: string | undefined): string[] {
  if (!value) return [];
  return value.match(/<[^<>\s]+>/g) ?? [];
}

export interface DetailMeta {
  accountId: string;
  folder: string;
  uid: number;
  uidValidity: string;
  flags: Set<string>;
  internalDate: Date | null;
}

export interface DetailOptions {
  allowRemote: boolean;
  resolveRemote: SanitizeOptions['resolveRemote'];
  /** Outcome of the sender-domain image allowlist (see imageAllowlist.ts). */
  allowlist?: {
    senderDomain: DomainName | null;
    allowedBy: DomainName | null;
    skipped: MessageDetail['allowlistSkipped'];
  };
}

/** Turn a parsed message into the view model sent to the browser, sanitizing any HTML. */
export function buildMessageDetail(email: ParsedEmail, meta: DetailMeta, opts: DetailOptions): MessageDetail {
  const usedCids = new Set<string>();
  const byCid = new Map<string, Attachment>();
  for (const a of email.attachments) if (a.contentId) byCid.set(normaliseCid(a.contentId), a);

  const resolveCid = (cid: string): string | null => {
    const key = normaliseCid(cid);
    const att = byCid.get(key);
    if (!att || !INLINE_IMAGE.test(att.mimeType)) return null;
    const bytes = attachmentBytes(att);
    if (bytes.length > MAX_INLINE_IMAGE_BYTES) return null;
    usedCids.add(key);
    return `data:${att.mimeType.toLowerCase()};base64,${bytes.toString('base64')}`;
  };

  let html: string | null = null;
  let css = '';
  let htmlStyle: MessageDetail['htmlStyle'] = null;
  let remoteContentBlocked = 0;
  if (email.html) {
    const s = sanitizeEmailHtml(email.html, { allowRemote: opts.allowRemote, resolveRemote: opts.resolveRemote, resolveCid });
    html = s.html;
    css = s.css;
    htmlStyle = s.style;
    remoteContentBlocked = s.remoteBlocked;
  }

  const attachments: AttachmentView[] = email.attachments
    .map((a, index) => ({
      index,
      filename: a.filename || `attachment-${index + 1}${a.mimeType === 'message/rfc822' ? '.eml' : ''}`,
      mimeType: a.mimeType || 'application/octet-stream',
      size: attachmentBytes(a).length,
      inline: a.disposition === 'inline' || (!!a.contentId && usedCids.has(normaliseCid(a.contentId))),
      contentId: a.contentId ? normaliseCid(a.contentId) : null,
    }))
    // Inline images that were actually displayed in the body aren't listed as attachments.
    .filter((a) => !(a.contentId && usedCids.has(a.contentId)));

  const date = email.date ? new Date(email.date) : meta.internalDate;
  return {
    accountId: meta.accountId,
    folder: meta.folder,
    uid: meta.uid,
    uidValidity: meta.uidValidity,
    messageId: email.messageId ?? null,
    inReplyTo: email.inReplyTo ?? null,
    references: parseReferences(email.references),
    subject: email.subject ?? '',
    from: flattenAddresses(email.from),
    to: flattenAddresses(email.to),
    cc: flattenAddresses(email.cc),
    bcc: flattenAddresses(email.bcc),
    replyTo: flattenAddresses(email.replyTo),
    date: (date && !Number.isNaN(date.getTime()) ? date : new Date(0)).toISOString(),
    seen: meta.flags.has('\\Seen'),
    flagged: meta.flags.has('\\Flagged'),
    text: email.text ?? null,
    html,
    css,
    htmlStyle,
    remoteContentBlocked,
    remoteContentLoaded: opts.allowRemote,
    senderDomain: opts.allowlist?.senderDomain ?? null,
    imagesAllowedBy: opts.allowlist?.allowedBy ?? null,
    allowlistSkipped: opts.allowlist?.skipped ?? null,
    attachments,
  };
}
