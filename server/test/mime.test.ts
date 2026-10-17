import fs from 'node:fs';
import path from 'node:path';
import type { MessageStructureObject } from 'imapflow';
import { describe, expect, it } from 'vitest';
import { buildMessageDetail, flattenAddresses, parseRaw, parseReferences } from '../src/mail/parse.js';
import { buildRawMessage, parseAddressList, sanitizeOutgoingHtml } from '../src/mail/compose.js';
import { findTextPart, hasAttachments, snippetFromPart } from '../src/imap/snippet.js';

const fixture = (name: string) => fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'mime', name));
const meta = { accountId: 'a1', folder: 'INBOX', uid: 42, uidValidity: '7', flags: new Set(['\\Seen']), internalDate: null };
const opts = { allowRemote: false, proxyUrl: (u: string) => `/api/proxy/image?u=${encodeURIComponent(u)}` };

describe('MIME parsing', () => {
  it('parses headers, encoded words and addresses', async () => {
    const d = buildMessageDetail(await parseRaw(fixture('rich.eml')), meta, opts);
    expect(d.subject).toBe('Re: Räksmörgås 💡');
    expect(d.from).toEqual([{ name: 'Jörg Example', address: 'sender@example.com' }]);
    expect(d.to).toEqual([
      { name: 'Test User', address: 'user@example.com' },
      { name: 'Other, Person', address: 'other@example.org' },
    ]);
    expect(d.cc).toEqual([]);
    expect(d.messageId).toBe('<msg-2@example.com>');
    expect(d.inReplyTo).toBe('<msg-1@example.com>');
    expect(d.references).toEqual(['<msg-0@example.com>', '<msg-1@example.com>']);
    expect(d.date).toBe('2026-09-01T08:15:00.000Z');
    expect(d.seen).toBe(true);
  });

  it('decodes quoted-printable text and sanitizes the HTML part', async () => {
    const d = buildMessageDetail(await parseRaw(fixture('rich.eml')), meta, opts);
    expect(d.text).toContain('Räksmörgås is ready. This line is long enough that it gets soft-wrapped');
    expect(d.html).toContain('<b>Räksmörgås</b>');
    expect(d.html).not.toContain('onclick');
    expect(d.html).not.toContain('tracker.example.com');
    expect(d.remoteContentBlocked).toBe(1);
  });

  it('inlines cid: images and lists only real attachments', async () => {
    const d = buildMessageDetail(await parseRaw(fixture('rich.eml')), meta, opts);
    expect(d.html).toMatch(/src="data:image\/png;base64,iVBOR/);
    expect(d.attachments).toHaveLength(1);
    expect(d.attachments[0]).toMatchObject({ filename: 'report.pdf', mimeType: 'application/pdf', index: 1, inline: false });
    expect(d.attachments[0]!.size).toBeGreaterThan(10);
  });

  it('decodes legacy charsets', async () => {
    const d = buildMessageDetail(await parseRaw(fixture('latin1.eml')), meta, opts);
    expect(d.text?.trim()).toBe('Grüße aus Köln');
    expect(d.html).toBeNull();
  });

  it('flattens address groups and parses references', () => {
    expect(
      flattenAddresses([{ name: 'Team', group: [{ name: 'A', address: 'a@example.com' }, { name: '', address: 'b@example.com' }] }]),
    ).toEqual([
      { name: 'A', address: 'a@example.com' },
      { name: '', address: 'b@example.com' },
    ]);
    expect(parseReferences('<a@example.com>\r\n <b@example.com> junk')).toEqual(['<a@example.com>', '<b@example.com>']);
  });
});

describe('snippets from BODYSTRUCTURE', () => {
  const structure: MessageStructureObject = {
    type: 'multipart/mixed',
    childNodes: [
      {
        type: 'multipart/alternative',
        part: '1',
        childNodes: [
          { type: 'text/html', part: '1.2', encoding: 'base64', parameters: { charset: 'utf-8' } },
          { type: 'text/plain', part: '1.1', encoding: 'quoted-printable', parameters: { charset: 'iso-8859-1' } },
        ],
      },
      { type: 'application/pdf', part: '2', disposition: 'attachment', dispositionParameters: { filename: 'x.pdf' } },
    ],
  };

  it('prefers text/plain and detects attachments', () => {
    expect(findTextPart(structure)).toEqual({ part: '1.1', type: 'text/plain', encoding: 'quoted-printable', charset: 'iso-8859-1' });
    expect(hasAttachments(structure)).toBe(true);
    expect(hasAttachments({ type: 'text/plain' })).toBe(false);
    expect(findTextPart({ type: 'text/plain' })?.part).toBe('1');
  });

  it('decodes truncated base64 html and quoted-printable latin-1, dropping quotes', () => {
    const html = Buffer.from('<html><head><style>p{color:red}</style></head><body><p>Hello <b>there</b> friend</p><p>more</p></body></html>').toString('base64');
    expect(snippetFromPart(Buffer.from(html.slice(0, 101)), { part: '1', type: 'text/html', encoding: 'base64', charset: 'utf-8' })).toMatch(/^Hello there/);
    const qp = Buffer.from('K=F6ln is nice=\r\n today\r\n> quoted reply\r\nbye =');
    expect(snippetFromPart(qp, { part: '1', type: 'text/plain', encoding: 'quoted-printable', charset: 'iso-8859-1' })).toBe('Köln is nice today bye =');
  });
});

describe('composing', () => {
  it('parses recipient lists', () => {
    expect(parseAddressList('"Doe, Jane" <jane@example.com>, bob@example.com')).toEqual([
      { name: 'Doe, Jane', address: 'jane@example.com' },
      { name: '', address: 'bob@example.com' },
    ]);
    expect(parseAddressList('  ')).toEqual([]);
  });

  it('strips scripts and relative (server-internal) image URLs from outgoing HTML', () => {
    const out = sanitizeOutgoingHtml('<p>hi<script>x()</script></p><img src="/api/proxy/image?u=x"><img src="https://img.example.com/a.png">');
    expect(out).toBe('<p>hi</p><img src="https://img.example.com/a.png" />');
  });

  it('builds a multipart message with a plain-text alternative that parses back', async () => {
    const { raw, messageId, envelope } = await buildRawMessage(
      {
        from: { name: 'Test User', address: 'user@example.com' },
        to: [{ name: 'Jane', address: 'jane@example.com' }],
        cc: [],
        bcc: [{ name: '', address: 'secret@example.com' }],
        subject: 'Grüße',
        html: '<p>Hello <b>Jane</b></p><blockquote>older</blockquote>',
        inReplyTo: '<orig@example.com>',
        references: ['<root@example.com>'],
        attachments: [{ filename: 'notes.txt', contentType: 'text/plain', content: Buffer.from('attached') }],
      },
      { keepBcc: false },
    );
    expect(envelope.to).toEqual(['jane@example.com', 'secret@example.com']);
    const parsed = await parseRaw(raw);
    expect(parsed.subject).toBe('Grüße');
    expect(parsed.text).toContain('Hello Jane');
    expect(parsed.html).toContain('<b>Jane</b>');
    expect(parsed.inReplyTo).toBe('<orig@example.com>');
    expect(parsed.references).toContain('<root@example.com>');
    expect(parsed.references).toContain('<orig@example.com>');
    expect(parsed.messageId).toBe(messageId);
    expect(parsed.bcc ?? []).toEqual([]);
    expect(parsed.attachments.map((a) => a.filename)).toEqual(['notes.txt']);
  });

  it('keeps Bcc in drafts', async () => {
    const { raw } = await buildRawMessage(
      {
        from: { name: '', address: 'user@example.com' },
        to: [],
        cc: [],
        bcc: [{ name: '', address: 'secret@example.com' }],
        subject: 'draft',
        html: '<p>wip</p>',
        inReplyTo: null,
        references: [],
        attachments: [],
      },
      { keepBcc: true },
    );
    expect((await parseRaw(raw)).bcc).toEqual([{ name: '', address: 'secret@example.com' }]);
  });
});
