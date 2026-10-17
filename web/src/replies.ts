import type { AccountView, Address, MessageDetail } from '../../shared/types';
import type { ComposerInit } from './components/Composer';
import type { ReplyKind } from './components/Reader';
import { escapeHtml, formatAddress, formatFullDate, prefixSubject, textToHtml, toRef } from './util';

const list = (addrs: Address[]) => addrs.map(formatAddress).join(', ');

function dedupe(addrs: Address[], exclude: Set<string>): Address[] {
  const seen = new Set(exclude);
  return addrs.filter((a) => {
    const k = a.address.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** The original message body as quotable HTML (server-sanitized HTML, or escaped text). */
function originalBody(d: MessageDetail): string {
  return d.html ?? textToHtml(d.text ?? '');
}

export function blankComposer(account: AccountView): ComposerInit {
  return {
    accountId: account.id,
    to: '',
    cc: '',
    bcc: '',
    subject: '',
    html: '<p><br></p>',
    inReplyTo: null,
    references: [],
    forwardFrom: null,
    forwardAttachments: [],
    replaceDraft: null,
    answering: null,
  };
}

export function composerFor(kind: ReplyKind, d: MessageDetail, account: AccountView): ComposerInit {
  const base = blankComposer(account);
  const ref = toRef(d);
  if (kind === 'editDraft') {
    return {
      ...base,
      to: list(d.to),
      cc: list(d.cc),
      bcc: list(d.bcc),
      subject: d.subject,
      html: originalBody(d),
      inReplyTo: d.inReplyTo,
      references: d.references,
      forwardFrom: ref,
      forwardAttachments: d.attachments.filter((a) => !a.inline),
      replaceDraft: ref,
    };
  }

  const who = d.from[0] ? escapeHtml(formatAddress(d.from[0])) : 'someone';
  if (kind === 'forward') {
    const header = [
      '---------- Forwarded message ----------',
      `From: ${list(d.from)}`,
      `Date: ${formatFullDate(d.date)}`,
      `Subject: ${d.subject}`,
      `To: ${list(d.to)}`,
      ...(d.cc.length ? [`Cc: ${list(d.cc)}`] : []),
    ]
      .map(escapeHtml)
      .join('<br>');
    return {
      ...base,
      subject: prefixSubject('Fwd', d.subject),
      html: `<p><br></p><p>${header}</p><div>${originalBody(d)}</div>`,
      references: d.messageId ? [...d.references, d.messageId] : d.references,
      forwardFrom: ref,
      forwardAttachments: d.attachments.filter((a) => !a.inline),
    };
  }

  const self = new Set([account.email.toLowerCase()]);
  const primary = d.replyTo.length ? d.replyTo : d.from;
  let to = primary;
  let cc: Address[] = [];
  if (kind === 'replyAll') {
    // Replying to your own sent message: reply to its original recipients.
    const fromSelf = d.from.some((a) => self.has(a.address.toLowerCase()));
    to = dedupe(fromSelf ? d.to : [...primary, ...d.to], self);
    cc = dedupe(d.cc, new Set([...self, ...to.map((a) => a.address.toLowerCase())]));
  } else if (d.from.some((a) => self.has(a.address.toLowerCase()))) {
    to = d.to;
  }
  return {
    ...base,
    to: list(to),
    cc: list(cc),
    subject: prefixSubject('Re', d.subject),
    html: `<p><br></p><p>On ${escapeHtml(formatFullDate(d.date))}, ${who} wrote:</p><blockquote type="cite">${originalBody(d)}</blockquote>`,
    inReplyTo: d.messageId,
    references: d.messageId ? [...d.references, d.messageId] : d.references,
    answering: ref,
  };
}
