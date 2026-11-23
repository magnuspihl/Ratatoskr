import type { MessageStructureObject } from 'imapflow';
import { describe, expect, it } from 'vitest';
import { DeadlineError, withDeadline } from '../src/deadline.js';
import { buildMessageDetail, parseRaw } from '../src/mail/parse.js';
import { sanitizeEmailHtml } from '../src/mail/sanitize.js';
import { decodedSize, decodeText, decodeTransfer, findPart, planMessage } from '../src/mail/structure.js';

/** A typical large message: text + HTML, an inline photo, a big attachment and a forwarded mail. */
const STRUCTURE: MessageStructureObject = {
  type: 'multipart/mixed',
  childNodes: [
    {
      part: '1',
      type: 'multipart/related',
      childNodes: [
        {
          part: '1.1',
          type: 'multipart/alternative',
          childNodes: [
            { part: '1.1.1', type: 'text/plain', parameters: { charset: 'UTF-8' }, encoding: '7bit', size: 40 },
            { part: '1.1.2', type: 'text/html', parameters: { charset: 'ISO-8859-1' }, encoding: 'quoted-printable', size: 90 },
          ],
        },
        { part: '1.2', type: 'image/jpeg', id: '<Photo1@Example.com>', encoding: 'base64', size: 7_800_000, disposition: 'inline', dispositionParameters: { filename: 'photo.jpg' } },
      ],
    },
    { part: '2', type: 'application/zip', encoding: 'base64', size: 78_000_000, disposition: 'attachment', dispositionParameters: { filename: 'all.zip' } },
    {
      part: '3',
      type: 'message/rfc822',
      size: 2000,
      childNodes: [{ part: '3.1', type: 'text/plain', size: 100 }],
    },
  ],
};

const meta = { accountId: 'a1', folder: 'INBOX', uid: 9, uidValidity: '1', flags: new Set<string>(), internalDate: null };

describe('planning a large message from its structure', () => {
  it('picks the text and HTML body and leaves images, attachments and forwarded mail for later', () => {
    const plan = planMessage(STRUCTURE);
    expect(plan.text.map((p) => p.part)).toEqual(['1.1.1']);
    expect(plan.html.map((p) => p.part)).toEqual(['1.1.2']);
    expect(plan.html[0]).toMatchObject({ charset: 'iso-8859-1', encoding: 'quoted-printable' });
    expect(plan.attachments.map((p) => [p.part, p.mimeType, p.filename])).toEqual([
      ['1.2', 'image/jpeg', 'photo.jpg'],
      ['2', 'application/zip', 'all.zip'],
      ['3', 'message/rfc822', null],
    ]);
    expect(plan.attachments[0]!.contentId).toBe('photo1@example.com');
  });

  it('treats a message that is not multipart as body part 1', () => {
    const plan = planMessage({ type: 'text/html', parameters: { charset: 'utf-8' }, size: 10 });
    expect(plan.html.map((p) => p.part)).toEqual(['1']);
    expect(plan.attachments).toEqual([]);
  });

  it('keeps every HTML piece of a body that is split around inline images', () => {
    const plan = planMessage({
      type: 'multipart/mixed',
      childNodes: [
        { part: '1', type: 'text/html', size: 10 },
        { part: '2', type: 'image/png', size: 10, disposition: 'inline', dispositionParameters: { filename: 'a.png' } },
        { part: '3', type: 'text/html', size: 10 },
      ],
    });
    expect(plan.html.map((p) => p.part)).toEqual(['1', '3']);
  });

  it('treats a named text file as an attachment, not as the body', () => {
    const plan = planMessage({
      type: 'multipart/mixed',
      childNodes: [
        { part: '1', type: 'text/plain', size: 10 },
        { part: '2', type: 'text/plain', size: 10, parameters: { name: 'notes.txt' } },
      ],
    });
    expect(plan.text.map((p) => p.part)).toEqual(['1']);
    expect(plan.attachments.map((p) => p.filename)).toEqual(['notes.txt']);
  });

  it('estimates the decoded size of base64 parts from the size the server reports', () => {
    expect(decodedSize(78_000_000, 'base64')).toBeGreaterThan(56_900_000);
    expect(decodedSize(78_000_000, 'base64')).toBeLessThan(57_100_000);
    expect(decodedSize(1234, '7bit')).toBe(1234);
  });

  it('finds a part by number, but not multiparts or parts that do not exist', () => {
    expect(findPart(STRUCTURE, '1.2')).toMatchObject({ mimeType: 'image/jpeg', encoding: 'base64' });
    expect(findPart(STRUCTURE, '1')).toBeNull();
    expect(findPart(STRUCTURE, '9')).toBeNull();
  });
});

describe('decoding downloaded parts', () => {
  it('decodes base64 with line breaks and quoted-printable with soft line breaks', () => {
    expect(decodeTransfer(Buffer.from('aGVsbG8g\r\nd29ybGQ=\r\n'), 'base64').toString()).toBe('hello world');
    expect(decodeTransfer(Buffer.from('caf=C3=A9 is a lo=\r\nng word =3D yes'), 'quoted-printable').toString()).toBe('café is a long word = yes');
    expect(decodeTransfer(Buffer.from('plain'), '7bit').toString()).toBe('plain');
  });

  it('reads text in its declared charset, and unknown charsets as UTF-8', () => {
    expect(decodeText(Buffer.from([0xc5, 0x6c]), 'iso-8859-1')).toBe('Ål');
    expect(decodeText(Buffer.from('Ål'), 'x-made-up')).toBe('Ål');
    expect(decodeText(Buffer.from('plain'), null)).toBe('plain');
  });
});

describe('showing a partially loaded message', () => {
  it('turns inline images into placeholders and lists every part with its number', async () => {
    const email = await parseRaw(Buffer.from('From: a@example.com\r\nSubject: Photos\r\n\r\n'));
    const html = '<p>Hi</p><img src="cid:photo1@example.com" width="400"><img src="cid:missing@example.com">';
    const plan = planMessage(STRUCTURE);
    const d = buildMessageDetail({ ...email, html, text: 'Hi', attachments: [] }, meta, { allowRemote: false, resolveRemote: () => null, parts: plan.attachments });
    expect(d.partial).toBe(true);
    expect(d.subject).toBe('Photos');
    expect(d.html).toContain('<img width="400" data-ratatoskr-part="1.2" />');
    expect(d.html).not.toContain('cid:');
    expect(d.attachments.map((a) => [a.part, a.filename, a.inline])).toEqual([
      ['1.2', 'photo.jpg', true],
      ['2', 'all.zip', false],
      ['3', 'attachment-3.eml', false],
    ]);
  });

  it('does not mark small, fully downloaded messages as partial', async () => {
    const email = await parseRaw(Buffer.from('From: a@example.com\r\nSubject: Small\r\nContent-Type: text/plain\r\n\r\nHi\r\n'));
    const d = buildMessageDetail(email, meta, { allowRemote: false, resolveRemote: () => null });
    expect(d.partial).toBeUndefined();
    expect(d.attachments).toEqual([]);
  });
});

describe('placeholders in sanitized HTML', () => {
  const sanitize = (html: string) =>
    sanitizeEmailHtml(html, {
      allowRemote: false,
      resolveRemote: () => null,
      resolveCid: (cid) => (cid === 'a@x' ? { part: '1.2' } : cid === 'bad@x' ? { part: '1"><script>' } : null),
    }).html;

  it('marks a cid image that loads later with its part number and no source', () => {
    expect(sanitize('<img src="cid:a@x" alt="Photo">')).toBe('<img alt="Photo" data-ratatoskr-part="1.2" />');
  });

  it("removes a sender's own placeholder marker so a message can't point at other parts", () => {
    expect(sanitize('<img data-ratatoskr-part="2" src="https://evil.example/x.png">')).toBe('<img />');
    expect(sanitize('<p data-ratatoskr-part="2">x</p>')).toBe('<p>x</p>');
  });

  it('ignores part numbers that are not plain dotted numbers', () => {
    expect(sanitize('<img src="cid:bad@x">')).toBe('<img />');
  });

  it('drops cid backgrounds that would only load later (only <img> gets a placeholder)', () => {
    expect(sanitize('<td background="cid:a@x">x</td>')).not.toContain('background');
  });
});

describe('the deadline for opening a message', () => {
  it('passes the result through when the work finishes in time', async () => {
    await expect(withDeadline(Promise.resolve(42), 1000, 'slow')).resolves.toBe(42);
  });

  it('gives up with a clear error when the work takes too long', async () => {
    const never = new Promise<number>(() => {});
    const err = await withDeadline(never, 20, 'The mail server is taking too long').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeadlineError);
    expect((err as Error).message).toBe('The mail server is taking too long');
  });

  it('does not turn a failure after the deadline into an unhandled rejection', async () => {
    let fail: (e: Error) => void = () => {};
    const late = new Promise<number>((_, reject) => (fail = reject));
    await expect(withDeadline(late, 10, 'slow')).rejects.toBeInstanceOf(DeadlineError);
    fail(new Error('IMAP connection dropped'));
    await new Promise((r) => setTimeout(r, 10));
  });
});
