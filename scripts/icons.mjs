// Regenerates the app icons from web/icons-src/original.svg (squirrel + trunk, 1254x1254).
// Writes the SVG variants to web/icons-src/ and web/public/favicon.svg, and the PNGs to web/public/icons/.
// The rasterizer is not a project dependency:  npm i --no-save @resvg/resvg-js && node scripts/icons.mjs
import fs from 'node:fs';
import { Resvg } from '@resvg/resvg-js';

const SRC = 'web/icons-src';
const OUT = 'web/public/icons';
const BG = '#fff7e6';
const FG = '#502513';
const TRUNK = process.env.TRUNK || '#c89b6d';
const BORDER = 56;
const RADIUS = 270;

const original = fs.readFileSync(`${SRC}/original.svg`, 'utf8');
const d = original.match(/<path d="([^"]+)"/)[1].replace(/\s+/g, ' ').trim();
const svg = 'xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1254 1254"';

// The trunk is widened to fill everything left of the squirrel and runs past the frame, in a lighter bark tone so
// it doesn't outweigh the squirrel. The art is shrunk to clear the border and to stay inside the 80% safe circle
// that maskable icons are cropped to.
const art = `<g transform="translate(627 627) scale(0.84) translate(-627 -627)"><rect x="-400" y="-400" width="863" height="2054" fill="${TRUNK}"/><path d="${d}" fill="${FG}"/></g>`;
const inner = 1254 - 2 * BORDER;

const variants = {
  // Rounded tile with a border: favicon and the "any" purpose icons.
  'icon.svg': `<svg ${svg}><title>Ratatoskr</title><defs><clipPath id="c"><rect x="${BORDER}" y="${BORDER}" width="${inner}" height="${inner}" rx="${RADIUS - BORDER}"/></clipPath></defs><rect x="${BORDER / 2}" y="${BORDER / 2}" width="${1254 - BORDER}" height="${1254 - BORDER}" rx="${RADIUS - BORDER / 2}" fill="${BG}" stroke="${FG}" stroke-width="${BORDER}"/><g clip-path="url(#c)">${art}</g></svg>\n`,
  // Full bleed, opaque: for launchers that apply their own mask (Android maskable, iOS home screen).
  'full-bleed.svg': `<svg ${svg}><title>Ratatoskr</title><rect width="1254" height="1254" fill="${BG}"/>${art}</svg>\n`,
  // Notification badge: Android only uses the alpha channel, so a white silhouette on transparent.
  'badge.svg': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="116 100 1040 1040"><g fill="#fff"><rect x="390" y="118" width="73" height="1018"/><path d="${d}"/></g></svg>\n`,
};
for (const [name, content] of Object.entries(variants)) fs.writeFileSync(`${SRC}/${name}`, content);
fs.writeFileSync('web/public/favicon.svg', variants['icon.svg']);

const pngs = [
  ['icon.svg', 'icon-192.png', 192],
  ['icon.svg', 'icon-512.png', 512],
  ['full-bleed.svg', 'icon-maskable-512.png', 512],
  ['full-bleed.svg', 'apple-touch-icon.png', 180],
  ['badge.svg', 'badge-96.png', 96],
];
for (const [src, out, size] of pngs) {
  const png = new Resvg(variants[src], { fitTo: { mode: 'width', value: size } }).render().asPng();
  fs.writeFileSync(`${OUT}/${out}`, png);
  console.log(`${OUT}/${out}`);
}
