import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';

const pub = path.resolve(import.meta.dirname, '../public');
const read = (p: string) => fs.readFileSync(path.join(pub, p));

/** Decodes an 8-bit RGBA, non-interlaced PNG (what scripts/icons.mjs writes) into width, height and pixels. */
function decodePng(buf: Buffer) {
  expect(buf.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  let pos = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      expect([data[8], data[9], data[12]]).toEqual([8, 6, 0]);
    }
    if (type === 'IDAT') idat.push(data);
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const px = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x]!;
      const a = x >= 4 ? px[y * stride + x - 4]! : 0;
      const b = y > 0 ? px[(y - 1) * stride + x]! : 0;
      const c = x >= 4 && y > 0 ? px[(y - 1) * stride + x - 4]! : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      const paeth = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      const pred = [0, a, b, (a + b) >> 1, paeth][filter]!;
      px[y * stride + x] = (v + pred) & 0xff;
    }
  }
  const alpha = (x: number, y: number) => px[y * stride + x * 4 + 3]!;
  return { width, height, px, alpha };
}

describe('app icons', () => {
  const manifest = JSON.parse(read('manifest.webmanifest').toString('utf8')) as {
    icons: { src: string; sizes: string; purpose: string }[];
  };

  it.each(manifest.icons)('$src exists at the size the manifest declares', (icon) => {
    const { width, height } = decodePng(read(icon.src));
    expect(`${width}x${height}`).toBe(icon.sizes);
  });

  it('the maskable icon is opaque edge to edge, so launcher masks never show a hole', () => {
    const icon = manifest.icons.find((i) => i.purpose === 'maskable')!;
    const { width, height, alpha } = decodePng(read(icon.src));
    for (const [x, y] of [[0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1]]) expect(alpha(x!, y!)).toBe(255);
  });

  it('the iOS home screen icon is 180px and fully opaque (iOS fills transparency with black)', () => {
    const { width, height, px } = decodePng(read('icons/apple-touch-icon.png'));
    expect([width, height]).toEqual([180, 180]);
    for (let i = 3; i < px.length; i += 4) expect(px[i]).toBe(255);
  });

  it('the notification badge is a white silhouette on a transparent background', () => {
    const { width, height, px, alpha } = decodePng(read('icons/badge-96.png'));
    expect([width, height]).toEqual([96, 96]);
    expect(alpha(0, 0)).toBe(0);
    let opaque = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] === 255) {
        opaque++;
        expect([px[i], px[i + 1], px[i + 2]]).toEqual([255, 255, 255]);
      }
    }
    expect(opaque).toBeGreaterThan(500);
  });

  it('the icons draw the squirrel in the app accent orange on its pale accent tint, against a dark trunk', () => {
    const css = fs.readFileSync(path.resolve(import.meta.dirname, '../src/styles.css'), 'utf8');
    const token = (name: string) => css.match(new RegExp(`--${name}: (#[0-9a-f]{6});`))![1]!;
    for (const file of ['favicon.svg', '../icons-src/icon.svg', '../icons-src/full-bleed.svg']) {
      const svg = read(file).toString('utf8');
      expect(svg).toMatch(new RegExp(`<path d="[^"]+" fill="${token('accent-fill')}"/>`));
      expect(svg).toContain(`fill="${token('accent-soft')}"`);
      expect(svg).toContain('fill="#3a1d10"');
    }
    expect(manifest).toMatchObject({ background_color: token('accent-soft') });
  });

  it('the maskable icon shows the orange squirrel, the dark trunk and the pale background', () => {
    const { width, px } = decodePng(read('icons/icon-maskable-512.png'));
    const rgb = (x: number, y: number) => [...px.subarray((y * width + x) * 4, (y * width + x) * 4 + 3)];
    expect(rgb(60, 256)).toEqual([0x3a, 0x1d, 0x10]);
    expect(rgb(480, 256)).toEqual([0xfd, 0xee, 0xe6]);
    expect(rgb(260, 300)).toEqual([0xc2, 0x41, 0x0c]);
  });

  it('no light seam shows where the trunk meets the icon border', () => {
    const { width, px } = decodePng(read('icons/icon-512.png'));
    const at = (x: number, y: number) => [...px.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)];
    // Down the trunk column from the top edge, and across the trunk at the bottom: every opaque pixel is bark.
    const probes = [...Array.from({ length: 120 }, (_, y) => [120, y]), ...Array.from({ length: 120 }, (_, i) => [120, 511 - i])];
    for (const [x, y] of probes) {
      const [r, g, b, a] = at(x!, y!);
      if (a === 255) expect([r, g, b]).toEqual([0x3a, 0x1d, 0x10]);
    }
  });

  it('the animated squirrel and the Compose button use the icon orange in both light and dark themes', () => {
    const css = fs.readFileSync(path.resolve(import.meta.dirname, '../src/styles.css'), 'utf8');
    const dark = css.slice(css.indexOf("[data-theme='dark']"), css.indexOf('}', css.indexOf("[data-theme='dark']")));
    expect(css.match(/--accent-fill:[^;]*;/g)).toEqual(['--accent-fill: #c2410c;']);
    expect(css.match(/--squirrel:[^;]*;/g)).toEqual(['--squirrel: var(--accent-fill);']);
    expect(css).toMatch(/\.btn\.primary \{ background: var\(--accent-fill\);/);
    // White label on the dark orange, in both themes.
    expect(css.match(/--accent-text:[^;]*;/g)).toEqual(['--accent-text: #ffffff;']);
    expect(dark).not.toContain('--accent-fill');
  });

  it('the favicon is the squirrel icon, not the old envelope', () => {
    const svg = read('favicon.svg').toString('utf8');
    expect(svg).toContain('<title>Ratatoskr</title>');
    expect(svg).not.toContain('M14 22l18 13 18-13');
  });
});
