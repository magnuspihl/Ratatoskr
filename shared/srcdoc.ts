/**
 * Builds the document loaded into the sandboxed message iframe (via srcdoc).
 *
 * The iframe is created with `sandbox="allow-popups allow-popups-to-escape-sandbox"`: no scripts,
 * no same-origin access, no forms, no top navigation. The CSP below is a second, independent
 * layer: even if markup slipped through sanitization, nothing may load except inline styles,
 * data: images and the app's own signed image proxy.
 */

export type RenderMode = 'light' | 'dark' | 'paper';

export interface RenderPalette {
  background: string;
  text: string;
  muted: string;
  link: string;
  border: string;
}

export interface SrcdocInput {
  html: string;
  css: string;
  mode: RenderMode;
  /** Origin of the app, e.g. "https://mail.example.com" (for the image proxy CSP source). */
  origin: string;
  palette: RenderPalette;
}

export function contentSecurityPolicy(origin: string): string {
  return [
    "default-src 'none'",
    `img-src data: ${origin}/api/proxy/image`,
    "style-src 'unsafe-inline'",
    'font-src data:',
    "form-action 'none'",
    "base-uri 'none'",
    "frame-src 'none'",
    "script-src 'none'",
  ].join('; ');
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/** Only allow simple colour tokens into the generated CSS. */
function color(c: string): string {
  return /^[#a-z0-9(),.\s%-]+$/i.test(c) ? c : 'inherit';
}

function baseCss(p: RenderPalette): string {
  return `
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; padding: 20px 24px; font: 15px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  word-wrap: break-word; overflow-wrap: anywhere; }
img { max-width: 100%; height: auto; }
img:not([src]) { display: inline-block; min-width: 1px; min-height: 1px; }
pre { white-space: pre-wrap; }
blockquote { margin: 0.5em 0 0.5em 0.25em; padding-left: 0.9em; border-left: 3px solid ${color(p.border)}; }
table { max-width: 100%; }`;
}

function modeCss(mode: RenderMode, p: RenderPalette): string {
  if (mode === 'dark') {
    // Simple messages: force a readable dark rendering by neutralising the message's colours.
    return `
html, body { background: ${color(p.background)}; color: ${color(p.text)}; color-scheme: dark; }
body * { color: inherit !important; background-color: transparent !important; border-color: ${color(p.border)} !important; }
a, a * { color: ${color(p.link)} !important; }`;
  }
  // light and paper: the message's own design applies on a white sheet.
  return `
html, body { background: #ffffff; color: #1d1f23; color-scheme: light; }
a { color: #1a5fd0; }`;
}

export function buildSrcdoc(input: SrcdocInput): string {
  const { html, css, mode, origin, palette } = input;
  // Message styles first, viewer styles last so the dark override wins where intended.
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${escapeAttr(contentSecurityPolicy(origin))}">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="${mode === 'dark' ? 'dark' : 'light'}">
<style>${baseCss(palette)}</style>
<style>${css}</style>
<style>${modeCss(mode, palette)}</style>
</head><body>${html}</body></html>`;
}

/** Plain-text bodies are rendered as escaped text; links are made clickable safely. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
