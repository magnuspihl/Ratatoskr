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

  it('the favicon is the squirrel icon, not the old envelope', () => {
    const svg = read('favicon.svg').toString('utf8');
    expect(svg).toContain('<title>Ratatoskr</title>');
    expect(svg).not.toContain('M14 22l18 13 18-13');
  });
});
