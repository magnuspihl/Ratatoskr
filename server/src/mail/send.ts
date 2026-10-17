import type { ComposePayload, DraftResult, SendResult } from '../../../shared/types.js';
import type { Store } from '../db.js';
import { createSmtpTransport, describeError, MailServerError } from '../imap/connect.js';
import type { MailService } from '../imap/mail.js';
import { assertPublicHost } from '../net/ssrf.js';
import { attachmentBytes } from './parse.js';
import { buildRawMessage, isValidAddress, parseAddressList, type OutgoingAttachment } from './compose.js';

export class ComposeError extends Error {}

export class ComposeService {
  constructor(
    private readonly store: Store,
    private readonly mail: MailService,
    private readonly opts: { maxMessageBytes: number; blockPrivateHosts: boolean },
  ) {}

  private async prepare(userId: string, p: ComposePayload, uploads: OutgoingAttachment[], requireRecipients: boolean) {
    const account = this.store.getAccountSecret(userId, p.accountId);
    if (!account) throw new ComposeError('Unknown sender account');
    const to = parseAddressList(p.to);
    const cc = parseAddressList(p.cc);
    const bcc = parseAddressList(p.bcc);
    const all = [...to, ...cc, ...bcc];
    const invalid = all.filter((a) => !isValidAddress(a.address));
    if (invalid.length) throw new ComposeError(`Invalid address: ${invalid.map((a) => a.address).join(', ')}`);
    if (requireRecipients && all.length === 0) throw new ComposeError('Add at least one recipient');

    const attachments = [...uploads];
    if (p.forwardFrom && p.forwardFrom.indices.length) {
      const original = await this.mail.getParsed(userId, p.forwardFrom, this.opts.maxMessageBytes);
      for (const i of p.forwardFrom.indices) {
        const a = original.attachments[i];
        if (!a) continue;
        attachments.push({
          filename: a.filename || `attachment-${i + 1}`,
          contentType: a.mimeType || 'application/octet-stream',
          content: attachmentBytes(a),
        });
      }
    }
    return {
      account,
      recipients: all,
      message: {
        from: { name: account.displayName, address: account.email },
        to,
        cc,
        bcc,
        subject: p.subject,
        html: p.html,
        inReplyTo: p.inReplyTo,
        references: p.references,
        attachments,
      },
    };
  }

  async send(userId: string, p: ComposePayload, uploads: OutgoingAttachment[]): Promise<SendResult> {
    const { account, recipients, message } = await this.prepare(userId, p, uploads, true);
    const { raw, messageId, envelope } = await buildRawMessage(message, { keepBcc: false });

    try {
      if (this.opts.blockPrivateHosts) await assertPublicHost(account.smtp.host);
      const transport = createSmtpTransport(account.smtp);
      try {
        await transport.sendMail({ envelope, raw });
      } finally {
        transport.close();
      }
    } catch (err) {
      throw describeError(err, `SMTP ${account.smtp.host}`);
    }

    // From here on the message is sent; failures are reported as warnings, not errors.
    const warnings: string[] = [];
    let savedToSent = false;
    if (account.appendSent) {
      try {
        const sent = await this.mail.specialFolder(userId, account.id, 'sent');
        if (sent) {
          await this.mail.append(userId, account.id, sent, raw, ['\\Seen']);
          savedToSent = true;
        } else warnings.push('No Sent folder found; the message was not saved.');
      } catch (err) {
        warnings.push(`Could not save to Sent: ${(err as Error).message}`);
      }
    }
    if (p.replaceDraft) await this.mail.deleteDraft(userId, p.replaceDraft).catch(() => undefined);
    if (p.answering) await this.mail.markAnswered(userId, p.answering);
    this.store.rememberRecipients(userId, recipients);
    return { messageId, savedToSent, warning: warnings.join(' ') || null };
  }

  async saveDraft(userId: string, p: ComposePayload, uploads: OutgoingAttachment[]): Promise<DraftResult> {
    const { account, message } = await this.prepare(userId, p, uploads, false);
    const { raw } = await buildRawMessage(message, { keepBcc: true });
    const drafts = await this.mail.specialFolder(userId, account.id, 'drafts');
    if (!drafts) throw new MailServerError('This account has no Drafts folder', 'protocol');
    const res = await this.mail.append(userId, account.id, drafts, raw, ['\\Draft', '\\Seen']);
    if (p.replaceDraft) await this.mail.deleteDraft(userId, p.replaceDraft).catch(() => undefined);
    const draft =
      res && res.uid && res.uidValidity
        ? { accountId: account.id, folder: drafts, uid: res.uid, uidValidity: res.uidValidity.toString() }
        : null;
    return { draft };
  }
}
