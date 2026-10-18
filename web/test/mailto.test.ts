import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { AccountView } from '../../shared/types';
import { composeUrl, handlerTemplate, linkify, parseMailto, rewriteMailtoLinks, takeMailtoParam } from '../src/mailto';
import { composerForMailto } from '../src/replies';

describe('reading mailto: links', () => {
  it('takes the recipient from the address part', () => {
    expect(parseMailto('mailto:ada@example.com')).toEqual({ to: 'ada@example.com', cc: '', bcc: '', subject: '', body: '' });
  });

  it('reads subject, body, cc and bcc, decoding percent escapes', () => {
    const f = parseMailto('mailto:ada@example.com?subject=Hello%20there&body=Line%201%0D%0ALine%202&cc=bob@example.com&bcc=eve@example.com');
    expect(f).toEqual({ to: 'ada@example.com', cc: 'bob@example.com', bcc: 'eve@example.com', subject: 'Hello there', body: 'Line 1\nLine 2' });
  });

  it('accepts several recipients and extra to= fields', () => {
    expect(parseMailto('mailto:a@example.com,b@example.com?to=c@example.com')?.to).toBe('a@example.com, b@example.com, c@example.com');
  });

  it('allows a link with only headers and no address', () => {
    expect(parseMailto('mailto:?to=a@example.com&subject=Hi')).toMatchObject({ to: 'a@example.com', subject: 'Hi' });
  });

  it('treats header names case-insensitively', () => {
    expect(parseMailto('MAILTO:a@example.com?Subject=Hi&CC=b@example.com')).toMatchObject({ subject: 'Hi', cc: 'b@example.com' });
  });

  it('keeps a plus sign as a plus, as in user+tag@example.com', () => {
    expect(parseMailto('mailto:user+tag@example.com?subject=a+b')).toMatchObject({ to: 'user+tag@example.com', subject: 'a+b' });
  });

  it('does not let a subject or address smuggle in extra header lines', () => {
    const f = parseMailto('mailto:a@example.com%0D%0ABcc:evil@example.com?subject=Hi%0D%0ABcc:%20evil@example.com');
    expect(f?.to).not.toMatch(/[\r\n]/);
    expect(f?.subject).not.toMatch(/[\r\n]/);
    expect(f?.bcc).toBe('');
  });

  it('ignores other headers such as attachments or In-Reply-To', () => {
    expect(parseMailto('mailto:a@example.com?attach=/etc/passwd&in-reply-to=%3Cx@y%3E')).toEqual({ to: 'a@example.com', cc: '', bcc: '', subject: '', body: '' });
  });

  it('survives broken percent escapes', () => {
    expect(parseMailto('mailto:a@example.com?subject=100%')?.subject).toBe('100%');
  });

  it('rejects anything that is not a mailto: link', () => {
    expect(parseMailto('https://example.com')).toBeNull();
    expect(parseMailto('javascript:alert(1)')).toBeNull();
    expect(parseMailto('')).toBeNull();
  });
});

describe('opening the app for a mailto: link', () => {
  it('builds the app URL that the browser and message links use', () => {
    expect(handlerTemplate('https://mail.example.com')).toBe('https://mail.example.com/?mailto=%s');
    expect(composeUrl('mailto:a@example.com?subject=Hi', 'https://mail.example.com')).toBe('https://mail.example.com/?mailto=mailto%3Aa%40example.com%3Fsubject%3DHi');
  });

  it('reads the link the browser passes and removes it from the URL', () => {
    expect(takeMailtoParam('?mailto=mailto%3Aa%40example.com%3Fsubject%3DHi')).toEqual({ mailto: 'mailto:a@example.com?subject=Hi', search: '' });
  });

  it('keeps the rest of the query string', () => {
    expect(takeMailtoParam('?q=hello&mailto=mailto%3Aa%40example.com')).toEqual({ mailto: 'mailto:a@example.com', search: '?q=hello' });
  });

  it('drops a mailto parameter that is not a mailto: link', () => {
    expect(takeMailtoParam('?mailto=javascript%3Aalert(1)')).toEqual({ mailto: null, search: '' });
  });

  it('does nothing when the app was opened normally', () => {
    expect(takeMailtoParam('?q=hello')).toBeNull();
  });

  it('registers Ratatoskr for mailto: links in the installed app', () => {
    const manifest = JSON.parse(readFileSync(new URL('../public/manifest.webmanifest', import.meta.url), 'utf8'));
    expect(manifest.protocol_handlers).toEqual([{ protocol: 'mailto', url: '/?mailto=%s' }]);
  });
});

describe('composing from a mailto: link', () => {
  const account = { id: 'a1', email: 'me@example.com' } as AccountView;

  it('fills in recipients and subject, with the body as escaped plain text', () => {
    const init = composerForMailto({ to: 'a@example.com', cc: 'b@example.com', bcc: '', subject: 'Hi', body: '<b>bold</b>\nnext' }, account);
    expect(init).toMatchObject({ accountId: 'a1', to: 'a@example.com', cc: 'b@example.com', subject: 'Hi', inReplyTo: null, answering: null });
    expect(init.html).toBe('<p>&lt;b&gt;bold&lt;/b&gt;<br>next</p>');
  });

  it('starts with an empty body when the link has none', () => {
    expect(composerForMailto({ to: 'a@example.com', cc: '', bcc: '', subject: '', body: '' }, account).html).toBe('<p><br></p>');
  });
});

describe('mailto: links in HTML mail', () => {
  const origin = 'https://mail.example.com';

  it('point at the app’s composer instead of another mail program', () => {
    const html = '<a href="mailto:a@example.com?subject=Hi&amp;body=x" target="_blank" rel="noopener noreferrer nofollow">mail</a>';
    expect(rewriteMailtoLinks(html, origin)).toBe(
      '<a href="https://mail.example.com/?mailto=mailto%3Aa%40example.com%3Fsubject%3DHi%26body%3Dx" target="_blank" rel="noopener noreferrer nofollow">mail</a>',
    );
  });

  it('leave web links and text that merely mentions mailto: alone', () => {
    const html = '<p>Write to mailto:a@example.com</p><a href="https://example.com/mailto:x" target="_blank">web</a>';
    expect(rewriteMailtoLinks(html, origin)).toBe(html);
  });

  it('cannot be used to break out of the link attribute', () => {
    const out = rewriteMailtoLinks('<a href="mailto:a@example.com?subject=&quot;&gt;&lt;script&gt;">x</a>', origin);
    expect(out).not.toContain('<script');
    expect(out).toMatch(/^<a href="https:\/\/mail\.example\.com\/\?mailto=[^"<>]*">x<\/a>$/);
  });
});

describe('links in plain-text mail', () => {
  it('turns email addresses and mailto: links into email links', () => {
    expect(linkify('Mail ada@example.com or mailto:bob@example.com?subject=Hi.')).toEqual([
      'Mail ',
      { href: 'mailto:ada@example.com', text: 'ada@example.com', mailto: true },
      ' or ',
      { href: 'mailto:bob@example.com?subject=Hi', text: 'mailto:bob@example.com?subject=Hi', mailto: true },
      '.',
    ]);
  });

  it('keeps web links whole, even when they contain an @', () => {
    expect(linkify('See https://example.com/@ada/post, thanks')).toEqual([
      'See ',
      { href: 'https://example.com/@ada/post', text: 'https://example.com/@ada/post', mailto: false },
      ', thanks',
    ]);
  });

  it('leaves text without links as it is', () => {
    expect(linkify('Nothing to see @ here')).toEqual(['Nothing to see @ here']);
  });
});
