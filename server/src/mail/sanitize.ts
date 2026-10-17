import { Parser } from 'htmlparser2';
import sanitizeHtml from 'sanitize-html';
import type { HtmlStyle } from '../../../shared/types.js';
import { proxyableUrl } from '../net/imageProxy.js';
import { countRules, sanitizeInlineStyle, sanitizeStylesheet } from './css.js';

/**
 * Email HTML sanitizer. Every message is treated as hostile.
 *
 * Defence in depth, outermost first:
 *  1. The browser renders the result in an <iframe sandbox> with neither allow-scripts nor
 *     allow-same-origin, plus a CSP that forbids scripts, forms, frames and any network access
 *     other than the app's own image proxy.
 *  2. This module removes everything that isn't plain formatting: scripts, event handlers, forms,
 *     frames, objects, SVG/MathML, meta/link/base, comments, javascript:/data: links, CSS
 *     expressions, @import, and any remote URL (img src, background, CSS url()).
 *  3. Remote images are only re-inserted on request, rewritten to the signed server-side proxy so
 *     the sender never sees the reader's IP address or cookies.
 */

const ALLOWED_TAGS = [
  'a', 'abbr', 'address', 'article', 'aside', 'b', 'bdi', 'bdo', 'big', 'blockquote', 'br', 'caption',
  'center', 'cite', 'code', 'col', 'colgroup', 'dd', 'del', 'details', 'dfn', 'div', 'dl', 'dt', 'em',
  'figcaption', 'figure', 'font', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'i',
  'img', 'ins', 'kbd', 'li', 'main', 'mark', 'nav', 'ol', 'p', 'pre', 'q', 's', 'samp', 'section',
  'small', 'span', 'strike', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th',
  'thead', 'time', 'tr', 'tt', 'u', 'ul', 'var', 'wbr',
];

const GLOBAL_ATTRS = ['style', 'class', 'dir', 'lang', 'title', 'align', 'valign', 'width', 'height', 'bgcolor'];

const ALLOWED_ATTRS: Record<string, string[]> = {
  '*': GLOBAL_ATTRS,
  a: ['href', 'name', 'target', 'rel'],
  img: ['src', 'alt', 'border', 'hspace', 'vspace'],
  font: ['color', 'face', 'size'],
  table: ['border', 'cellpadding', 'cellspacing', 'background', 'frame', 'rules', 'summary'],
  td: ['colspan', 'rowspan', 'background', 'nowrap', 'abbr', 'headers', 'scope'],
  th: ['colspan', 'rowspan', 'background', 'nowrap', 'abbr', 'headers', 'scope'],
  tr: ['background'],
  col: ['span'],
  colgroup: ['span'],
  ol: ['start', 'type', 'reversed'],
  ul: ['type'],
  li: ['value', 'type'],
  blockquote: ['cite'],
  q: ['cite'],
  del: ['cite', 'datetime'],
  ins: ['cite', 'datetime'],
  time: ['datetime'],
  hr: ['size', 'noshade', 'color'],
  div: ['background'],
  details: ['open'],
};

/** Elements whose text content must be dropped together with the element. */
const NON_TEXT_TAGS = [
  'script', 'style', 'textarea', 'option', 'noscript', 'title', 'template', 'xmp', 'noembed',
  'noframes', 'iframe', 'object', 'svg', 'math', 'head', 'select', 'button',
];

const SAFE_LINK = /^(https?:|mailto:|tel:)/i;
const SAFE_DATA_IMAGE = /^data:image\/(png|jpe?g|gif|webp|avif|bmp);base64,[a-z0-9+/=\s]+$/i;

export interface SanitizeOptions {
  /** Load remote images through the proxy (true) or strip them (false, default). */
  allowRemote: boolean;
  /** Build a proxy URL for a remote resource. */
  proxyUrl: (url: string) => string;
  /** Resolve a cid: reference (without the "cid:" prefix) to a data: URL, or null. */
  resolveCid: (cid: string) => string | null;
}

export interface SanitizedHtml {
  /** Sanitized body markup. */
  html: string;
  /** Sanitized stylesheet collected from the message's <style> elements. */
  css: string;
  /** Number of remote resources removed (0 when allowRemote is true). */
  remoteBlocked: number;
  style: HtmlStyle;
}

/** Collect the raw contents of every <style> element, exactly as an HTML parser sees them. */
function extractStylesheets(html: string): string[] {
  const sheets: string[] = [];
  let depth = 0;
  let buf = '';
  const parser = new Parser(
    {
      onopentag(name) {
        if (name === 'style') {
          depth++;
          buf = '';
        }
      },
      ontext(text) {
        if (depth > 0) buf += text;
      },
      onclosetag(name) {
        if (name === 'style' && depth > 0) {
          depth--;
          sheets.push(buf);
        }
      },
    },
    { decodeEntities: false, lowerCaseTags: true },
  );
  parser.write(html);
  parser.end();
  return sheets;
}

export function sanitizeEmailHtml(input: string, opts: SanitizeOptions): SanitizedHtml {
  let remoteBlocked = 0;
  let designSignals = 0;
  let images = 0;
  let tables = 0;

  const rewriteResourceUrl = (raw: string): string | null => {
    let src = raw.trim();
    if (src.startsWith('//')) src = `https:${src}`;
    if (/^cid:/i.test(src)) return opts.resolveCid(src.slice(4));
    if (SAFE_DATA_IMAGE.test(src)) return src.replace(/\s+/g, '');
    if (/^https?:\/\//i.test(src)) {
      if (opts.allowRemote && proxyableUrl(src)) return opts.proxyUrl(src);
      remoteBlocked++;
      return null;
    }
    return null;
  };

  const css = extractStylesheets(input)
    .map((sheet) => sanitizeStylesheet(sheet, rewriteResourceUrl))
    .filter(Boolean)
    .join('\n');
  if (countRules(css) >= 5) designSignals += 2;

  const html = sanitizeHtml(input, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: ALLOWED_ATTRS,
    // URL attributes are validated in transformTags below; this is a second line of defence.
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowedSchemesByTag: { img: ['http', 'https', 'data'] },
    allowedSchemesAppliedToAttributes: ['href', 'src', 'cite', 'background'],
    allowProtocolRelative: false,
    allowedStyles: undefined,
    parseStyleAttributes: false,
    nonTextTags: NON_TEXT_TAGS,
    disallowedTagsMode: 'discard',
    enforceHtmlBoundary: false,
    transformTags: {
      '*': (tagName, attribs) => {
        const out: Record<string, string> = { ...attribs };
        if (out.style !== undefined) {
          const style = sanitizeInlineStyle(out.style, rewriteResourceUrl);
          if (style) out.style = style;
          else delete out.style;
          if (/background/i.test(out.style ?? '')) designSignals++;
        }
        if (out.bgcolor !== undefined) designSignals++;
        if (out.background !== undefined) {
          const bg = rewriteResourceUrl(out.background);
          if (bg) out.background = bg;
          else delete out.background;
          designSignals++;
        }
        if (tagName === 'a') {
          const href = (out.href ?? '').trim();
          if (SAFE_LINK.test(href)) {
            out.href = href;
            out.target = '_blank';
            out.rel = 'noopener noreferrer nofollow';
          } else {
            delete out.href;
            delete out.target;
            delete out.rel;
          }
        }
        if (tagName === 'img') {
          images++;
          const src = out.src !== undefined ? rewriteResourceUrl(out.src) : null;
          if (src) out.src = src;
          else delete out.src;
        }
        if (tagName === 'table') {
          tables++;
          const w = Number.parseInt(out.width ?? '', 10);
          if (w >= 400 || (out.width ?? '').endsWith('%')) designSignals++;
        }
        return { tagName, attribs: out };
      },
    },
  });

  if (images >= 3) designSignals++;
  if (tables >= 2) designSignals++;
  const style: HtmlStyle = designSignals >= 3 ? 'designed' : 'simple';

  return { html, css, remoteBlocked, style };
}
