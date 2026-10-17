import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { sanitizeEmailHtml, type SanitizeOptions } from '../src/mail/sanitize.js';
import { sanitizeInlineStyle, sanitizeStylesheet } from '../src/mail/css.js';
import { buildSrcdoc } from '../../shared/srcdoc.js';

const FIXTURES = path.join(import.meta.dirname, 'fixtures', 'hostile');
const fixture = (name: string) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

const blocked: SanitizeOptions = {
  allowRemote: false,
  proxyUrl: (u) => `/api/proxy/image?u=${encodeURIComponent(u)}&s=sig`,
  resolveCid: (cid) => (cid === 'logo@example.com' ? `data:image/png;base64,${PNG_1PX}` : null),
};
const allowed: SanitizeOptions = { ...blocked, allowRemote: true };

/** Everything that must never appear in sanitized output, whatever the input. */
function assertInert(html: string, css: string) {
  const all = `${html}\n${css}`;
  expect(all).not.toMatch(/<script/i);
  expect(all).not.toMatch(/\son[a-z]+\s*=/i);
  expect(all).not.toMatch(/javascript:/i);
  expect(all).not.toMatch(/vbscript:/i);
  expect(all).not.toMatch(/expression\s*\(/i);
  expect(all).not.toMatch(/<(iframe|frame|frameset|object|embed|applet|form|input|button|select|textarea|meta|link|base|svg|math|video|audio|isindex)\b/i);
  expect(all).not.toMatch(/@import/i);
  expect(all).not.toMatch(/-moz-binding|behavior\s*:/i);
  expect(css).not.toMatch(/<\/style/i);
  // No direct remote references: every http(s) URL must go through the proxy.
  const withoutProxy = all.replace(/\/api\/proxy\/image\?u=[^"'\s)]+/g, '');
  expect(withoutProxy).not.toMatch(/(src|href|background)\s*=\s*["']?(https?:)?\/\/(?!ok\.example\.com)[^"'\s>]*/i);
  expect(withoutProxy).not.toMatch(/url\(\s*["']?(https?:)?\/\//i);
}

describe('sanitizeEmailHtml: hostile fixtures', () => {
  const files = fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.html'));
  it('has fixtures', () => expect(files.length).toBeGreaterThanOrEqual(8));

  for (const file of files) {
    for (const [mode, opts] of [
      ['remote blocked', blocked],
      ['remote allowed', allowed],
    ] as const) {
      it(`${file} (${mode}) is inert`, () => {
        const out = sanitizeEmailHtml(fixture(file), opts);
        assertInert(out.html, out.css);
      });
    }
  }
});

describe('sanitizeEmailHtml: specific behaviour', () => {
  it('removes scripts and their content', () => {
    const out = sanitizeEmailHtml(fixture('script-tags.html'), blocked);
    expect(out.html).toContain('<p>Hello</p>');
    expect(out.html).not.toContain('document.cookie');
    // Broken-up tags survive only as escaped, inert text.
    expect(out.html).not.toMatch(/<[a-z]*script/i);
  });

  it('strips event handlers but keeps content and safe styles', () => {
    const out = sanitizeEmailHtml(fixture('event-handlers.html'), blocked);
    expect(out.html).toContain('Click');
    expect(out.html).toMatch(/<p style="color: ?red">styled<\/p>/);
  });

  it('only keeps http(s)/mailto links, opened in a new tab without opener', () => {
    const out = sanitizeEmailHtml(fixture('javascript-urls.html'), blocked);
    expect(out.html).toContain('href="https://ok.example.com/page" target="_blank" rel="noopener noreferrer nofollow"');
    expect(out.html).toContain('href="mailto:user@example.com"');
    expect(out.html).not.toContain('/relative/path');
    expect(out.html).not.toContain('evil.example.com');
    expect(out.html).not.toMatch(/data:text/);
  });

  it('removes CSS expressions, @import, behaviours, escaped urls and remote url() in style sheets', () => {
    const out = sanitizeEmailHtml(fixture('css-expressions.html'), blocked);
    expect(out.css).toContain('color: red');
    // The second sheet is cut short by "</style>" inside a CSS string (HTML parsing rules), which
    // leaves invalid CSS; it is dropped entirely and the rest becomes inert text.
    expect(out.css).not.toContain('color: blue');
    expect(out.css).not.toContain('evil.example.com');
    expect(out.html).toContain('color: green');
    expect(out.html).not.toContain('evil.example.com');
    expect(out.remoteBlocked).toBeGreaterThan(0);
  });

  it('cannot break out of the <style> element', () => {
    const out = sanitizeEmailHtml(fixture('css-expressions.html'), blocked);
    const doc = buildSrcdoc({
      html: out.html,
      css: out.css,
      mode: 'light',
      origin: 'https://mail.example.com',
      palette: { background: '#000', text: '#fff', muted: '#888', link: '#09f', border: '#333' },
    });
    expect(doc.match(/<script/gi)).toBeNull();
    expect(doc.match(/<\/style>/gi)?.length).toBe(doc.match(/<style>/gi)?.length);
  });

  it('blocks remote images by default and counts them', () => {
    const out = sanitizeEmailHtml(fixture('remote-pixels.html'), blocked);
    expect(out.html).not.toContain('tracker.example.com');
    expect(out.remoteBlocked).toBeGreaterThanOrEqual(5);
    // cid: images are resolved to inline data URLs, srcset is dropped
    expect(out.html).toContain(`src="data:image/png;base64,${PNG_1PX}"`);
    expect(out.html).not.toContain('srcset');
  });

  it('routes remote images through the proxy when allowed (never direct)', () => {
    const out = sanitizeEmailHtml(fixture('remote-pixels.html'), allowed);
    expect(out.html).toContain(`src="/api/proxy/image?u=${encodeURIComponent('https://tracker.example.com/open.gif?id=123').replace(/&/g, '&amp;')}`);
    expect(out.html).toContain(encodeURIComponent('https://tracker.example.com/protocol-relative.gif'));
    expect(out.html).toContain('background="/api/proxy/image');
    // Non-standard ports are not proxied.
    expect(out.html).not.toContain(encodeURIComponent('tracker.example.com:8443'));
  });

  it('removes forms and inputs', () => {
    const out = sanitizeEmailHtml(fixture('forms.html'), blocked);
    expect(out.html).not.toContain('phish.example.com');
    expect(out.html).not.toContain('textarea content');
  });

  it('removes meta refresh, base, title, frames and plugins', () => {
    const out = sanitizeEmailHtml(fixture('meta-refresh.html'), blocked);
    expect(out.html).toContain('<p>Body</p>');
    expect(out.html).not.toContain('Title text');
    expect(out.html).not.toMatch(/refresh|evil\.example\.com|phish/);
  });

  it('removes SVG and MathML payloads and SVG data images', () => {
    const out = sanitizeEmailHtml(fixture('svg-payloads.html'), blocked);
    expect(out.html).toContain('<p>after</p>');
    expect(out.html).not.toMatch(/svg/i);
    expect(out.html).not.toContain('alert');
  });

  it('keeps raster data: images', () => {
    const out = sanitizeEmailHtml(`<img src="data:image/png;base64,${PNG_1PX}" alt="x">`, blocked);
    expect(out.html).toContain(`data:image/png;base64,${PNG_1PX}`);
  });

  it('classifies simple and designed messages', () => {
    expect(sanitizeEmailHtml('<div>Hi,<br>see you <b>tomorrow</b>.</div><blockquote>quoted</blockquote>', blocked).style).toBe('simple');
    const newsletter = `<style>.a{color:red}.b{color:blue}.c{padding:0}.d{margin:0}.e{font-size:12px}</style>
      <table width="600" bgcolor="#f0f0f0"><tr><td style="background-color:#fff"><img src="https://x.example.com/a.png"></td></tr></table>`;
    expect(sanitizeEmailHtml(newsletter, blocked).style).toBe('designed');
  });
});

describe('css sanitizer', () => {
  const noUrls = () => null;
  it('drops escapes and comments that could hide dangerous tokens', () => {
    expect(sanitizeInlineStyle('background: u\\72l(https://x.example.com)', noUrls)).toBe('');
    expect(sanitizeInlineStyle('width: expr/**/ession(alert(1))', noUrls)).toBe('');
    expect(sanitizeInlineStyle('color: red; } body { color: blue', noUrls)).toBe('');
  });
  it('rewrites url() through the rewriter', () => {
    expect(sanitizeInlineStyle('background-image: url(cid:a)', () => 'data:image/png;base64,AAAA')).toBe(
      'background-image: url("data:image/png;base64,AAAA")',
    );
  });
  it('removes disallowed at-rules but keeps media queries', () => {
    const out = sanitizeStylesheet('@import "x.css"; @media (max-width: 600px) { .a { color: red } } @font-face { src: url(x) }', noUrls);
    expect(out).toContain('@media');
    expect(out).not.toContain('@import');
    expect(out).not.toContain('@font-face');
  });
});

describe('iframe document', () => {
  const palette = { background: '#111', text: '#eee', muted: '#888', link: '#09f', border: '#333' };
  it('carries a strict CSP that only allows the image proxy', () => {
    const doc = buildSrcdoc({ html: '<p>x</p>', css: '', mode: 'dark', origin: 'https://mail.example.com', palette });
    expect(doc).toContain(`http-equiv="Content-Security-Policy" content="default-src 'none'`);
    expect(doc).toContain('img-src data: https://mail.example.com/api/proxy/image');
    expect(doc).toContain("script-src 'none'");
    expect(doc).toContain("form-action 'none'");
    expect(doc).toContain('<meta name="referrer" content="no-referrer">');
  });
  it('does not let palette values inject CSS', () => {
    const doc = buildSrcdoc({
      html: '',
      css: '',
      mode: 'dark',
      origin: 'https://mail.example.com',
      palette: { ...palette, background: 'red;} body{background:url(https://evil.example.com/x)' },
    });
    expect(doc).not.toContain('evil.example.com');
  });
});
