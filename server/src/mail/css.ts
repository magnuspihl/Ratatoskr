import postcss, { type AtRule, type Declaration, type Root } from 'postcss';

/** Decides what a CSS `url(...)` turns into. Return null to drop the declaration. */
export type UrlRewriter = (url: string) => string | null;

const ALLOWED_AT_RULES = new Set(['media', 'supports', 'keyframes', '-webkit-keyframes', 'layer', 'container']);
const FORBIDDEN_VALUE = /expression\s*\(|javascript:|vbscript:|-moz-binding|behaviou?r\s*:|@import|<\/?\s*style/i;
const FORBIDDEN_PROPS = /^(behaviou?r|-moz-binding|-ms-behavior)$/i;
const URL_RE = /url\(\s*(['"]?)(.*?)\1\s*\)/gi;
const IMAGE_SET_RE = /image-set\(|image\(|cross-fade\(|element\(/i;

function sanitizeDeclaration(decl: Declaration, rewriteUrl: UrlRewriter): void {
  const prop = decl.prop.trim();
  let value = decl.value;
  // CSS escapes and comments inside values are a classic way to hide `url(` or `expression(`
  // from naive filters. Legitimate mail almost never needs them, so refuse them outright.
  if (FORBIDDEN_PROPS.test(prop) || /\\|\/\*/.test(value) || /\\/.test(prop)) {
    decl.remove();
    return;
  }
  if (FORBIDDEN_VALUE.test(value) || IMAGE_SET_RE.test(value)) {
    decl.remove();
    return;
  }
  if (/url\(/i.test(value)) {
    let dropped = false;
    value = value.replace(URL_RE, (_m, _q: string, inner: string) => {
      const replacement = rewriteUrl(inner.trim());
      if (replacement === null) {
        dropped = true;
        return '';
      }
      return `url("${replacement.replace(/["\\\n\r]/g, encodeURIComponent)}")`;
    });
    // Any url( left over after rewriting was malformed; refuse it.
    if (dropped || /url\(/i.test(value.replace(/url\("[^"]*"\)/gi, ''))) {
      decl.remove();
      return;
    }
    decl.value = value;
  }
}

function walk(root: Root, rewriteUrl: UrlRewriter): void {
  root.walkAtRules((rule: AtRule) => {
    if (!ALLOWED_AT_RULES.has(rule.name.toLowerCase())) rule.remove();
  });
  root.walkDecls((decl) => sanitizeDeclaration(decl, rewriteUrl));
  root.walkComments((c) => {
    c.remove();
  });
}

/** Make the text safe to embed inside a <style> element: it must never be able to close it. */
function neutraliseMarkup(css: string): string {
  return css.replace(/</g, '\\3c ').replace(/>/g, '\\3e ');
}

/** Sanitize the contents of a <style> element. Returns '' if it can't be parsed. */
export function sanitizeStylesheet(css: string, rewriteUrl: UrlRewriter): string {
  try {
    const root = postcss.parse(css);
    walk(root, rewriteUrl);
    // Selectors may legitimately contain '>' (child combinator); after the at-rule/decl pass we
    // only need to make sure nothing can terminate the surrounding <style> element.
    return root.toString().replace(/<\/?\s*style/gi, '').replace(/</g, '\\3c ');
  } catch {
    return '';
  }
}

/** Sanitize a `style="..."` attribute value. */
export function sanitizeInlineStyle(style: string, rewriteUrl: UrlRewriter): string {
  try {
    const root = postcss.parse(`x{${style}}`);
    // An inline style must be declarations only; anything that broke out of the block is dropped.
    const first = root.first;
    if (!first || first.type !== 'rule' || root.nodes.length !== 1) return '';
    walk(root, rewriteUrl);
    const out: string[] = [];
    first.walkDecls((d) => {
      out.push(`${d.prop}: ${d.value}${d.important ? ' !important' : ''}`);
    });
    return neutraliseMarkup(out.join('; '));
  } catch {
    return '';
  }
}

/** Count the number of style rules (used to classify "designed" HTML). */
export function countRules(css: string): number {
  try {
    let n = 0;
    postcss.parse(css).walkRules(() => {
      n++;
    });
    return n;
  } catch {
    return 0;
  }
}
