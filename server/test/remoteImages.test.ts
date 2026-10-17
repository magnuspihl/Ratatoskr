import { describe, expect, it, vi } from 'vitest';
import { buildMessageDetail } from '../src/mail/parse.js';
import { collectRemoteImageUrls } from '../src/mail/sanitize.js';
import { inlineRemoteImages, RemoteImageCache, RemoteImageError, type RemoteImage } from '../src/net/remoteImages.js';

const png = (bytes: number): RemoteImage => ({ contentType: 'image/png', body: Buffer.alloc(bytes, 7) });
const dataUri = (img: RemoteImage) => `data:${img.contentType};base64,${img.body.toString('base64')}`;

describe('inlineRemoteImages', () => {
  it('fetches each distinct URL once and returns data: URIs', async () => {
    const fetchImage = vi.fn(async () => png(10));
    const out = await inlineRemoteImages(['https://img.example.com/a.png', 'https://img.example.com/a.png', 'https://img.example.com/b.png'], {
      userId: 'u1',
      fetchImage,
    });
    expect(fetchImage).toHaveBeenCalledTimes(2);
    expect(out.get('https://img.example.com/a.png')).toBe(dataUri(png(10)));
    expect(out.get('https://img.example.com/b.png')).toBe(dataUri(png(10)));
  });

  it('respects the concurrency limit', async () => {
    let active = 0;
    let peak = 0;
    const fetchImage = async () => {
      peak = Math.max(peak, ++active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return png(1);
    };
    const urls = Array.from({ length: 12 }, (_, i) => `https://img.example.com/${i}.png`);
    await inlineRemoteImages(urls, { userId: 'u1', fetchImage, concurrency: 3 });
    expect(peak).toBe(3);
  });

  it('drops images beyond the per-message byte budget', async () => {
    const urls = ['https://img.example.com/1.png', 'https://img.example.com/2.png', 'https://img.example.com/3.png'];
    const out = await inlineRemoteImages(urls, { userId: 'u1', fetchImage: async () => png(400), totalBytes: 1000, concurrency: 1 });
    expect(urls.map((u) => out.get(u) !== null)).toEqual([true, true, false]);
  });

  it('turns per-image errors into null without failing the rest', async () => {
    const out = await inlineRemoteImages(['https://img.example.com/ok.png', 'https://img.example.com/broken.png'], {
      userId: 'u1',
      fetchImage: async (u) => {
        if (u.includes('broken')) throw new RemoteImageError('Upstream status 500');
        return png(5);
      },
    });
    expect(out.get('https://img.example.com/ok.png')).not.toBeNull();
    expect(out.get('https://img.example.com/broken.png')).toBeNull();
  });

  it('never fetches URLs the fetcher refuses (odd ports, credentials, non-http)', async () => {
    const fetchImage = vi.fn(async () => png(5));
    const urls = ['https://img.example.com:8443/a.png', 'https://user:pw@img.example.com/a.png', 'ftp://img.example.com/a.png'];
    const out = await inlineRemoteImages(urls, { userId: 'u1', fetchImage });
    expect(fetchImage).not.toHaveBeenCalled();
    expect([...out.values()]).toEqual([null, null, null]);
  });

  it('never inlines private/internal addresses (real fetcher, no request is made)', async () => {
    const urls = ['http://127.0.0.1/a.png', 'http://localhost/b.png', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/c.png', 'http://10.0.0.1/d.png'];
    const out = await inlineRemoteImages(urls, { userId: 'u1' });
    expect([...out.values()]).toEqual(urls.map(() => null));
  });

  it('caps the number of images per message', async () => {
    const urls = Array.from({ length: 5 }, (_, i) => `https://img.example.com/${i}.png`);
    const out = await inlineRemoteImages(urls, { userId: 'u1', fetchImage: async () => png(1), maxImages: 2 });
    expect([...out.values()].filter((v) => v !== null)).toHaveLength(2);
  });

  it('uses the cache per user, including remembered failures', async () => {
    const cache = new RemoteImageCache();
    const fetchImage = vi.fn(async (u: string) => {
      if (u.includes('bad')) throw new Error('nope');
      return png(3);
    });
    const urls = ['https://img.example.com/a.png', 'https://img.example.com/bad.png'];
    await inlineRemoteImages(urls, { userId: 'u1', fetchImage, cache });
    await inlineRemoteImages(urls, { userId: 'u1', fetchImage, cache });
    expect(fetchImage).toHaveBeenCalledTimes(2);
    await inlineRemoteImages(urls, { userId: 'u2', fetchImage, cache });
    expect(fetchImage).toHaveBeenCalledTimes(4);
  });
});

describe('RemoteImageCache', () => {
  it('evicts least recently used entries beyond its byte cap', () => {
    const cache = new RemoteImageCache(250);
    cache.set('u', 'a', png(100));
    cache.set('u', 'b', png(100));
    expect(cache.get('u', 'a')).not.toBeUndefined(); // touch a: b is now oldest
    cache.set('u', 'c', png(100));
    expect(cache.get('u', 'b')).toBeUndefined();
    expect(cache.get('u', 'a')).not.toBeUndefined();
    expect(cache.bytes).toBeLessThanOrEqual(250);
  });
  it('expires entries', () => {
    vi.useFakeTimers();
    try {
      const cache = new RemoteImageCache(1000, 1000, 100);
      cache.set('u', 'ok', png(1));
      cache.set('u', 'fail', null);
      vi.advanceTimersByTime(500);
      expect(cache.get('u', 'ok')).not.toBeUndefined();
      expect(cache.get('u', 'fail')).toBeUndefined();
      vi.advanceTimersByTime(600);
      expect(cache.get('u', 'ok')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('message rendering with remote content allowed', () => {
  const html = `<style>.hero { background: url(https://img.example.com/hero.png) } .x { background-image: url("http://127.0.0.1/admin.png") }</style>
    <table background="https://img.example.com/table.png"><tr><td background="http://10.0.0.1/td.png">cell</td></tr></table>
    <img src="https://img.example.com/logo.png" alt="Logo" width="80" height="30">
    <img src="https://img.example.com/huge.png" alt="Huge">
    <img src="http://localhost/secret.png" alt="Internal">
    <div style="background-image:url('https://img.example.com/broken.png')">text</div>`;

  it('contains no network references and never inlines internal addresses', async () => {
    const fetched: string[] = [];
    const fetchImage = async (u: string): Promise<RemoteImage> => {
      fetched.push(u);
      if (u.includes('broken')) throw new RemoteImageError('Upstream status 404');
      if (u.includes('huge')) return png(900);
      // Anything internal reaching the fetcher would be a bug: the real fetcher refuses it.
      if (/127\.0\.0\.1|10\.0\.0\.1|localhost/.test(u)) throw new Error('internal address reached the fetcher');
      return png(50);
    };
    const urls = collectRemoteImageUrls(html);
    const inlined = await inlineRemoteImages(urls, { userId: 'u1', totalBytes: 600, concurrency: 1, fetchImage });
    const detail = buildMessageDetail(
      { headers: [], headerLines: [], attachments: [], html },
      { accountId: 'a', folder: 'INBOX', uid: 1, uidValidity: '1', flags: new Set(), internalDate: null },
      { allowRemote: true, resolveRemote: (u) => inlined.get(u) ?? null },
    );
    const all = `${detail.html}\n${detail.css}`.replace(/&quot;/g, '"');
    expect(all).not.toMatch(/https?:\/\//);
    expect(all).not.toMatch(/url\(\s*(?!["']?data:)/);
    expect(all).toContain('data:image/png;base64,');
    // Over the 600-byte budget, errors and internal addresses become placeholders.
    expect(detail.html).toContain('<img alt="Huge" />');
    expect(detail.html).toContain('<img alt="Internal" />');
    expect(detail.html).toContain('<td>cell</td>');
    expect(detail.remoteContentBlocked).toBe(5);
    expect(detail.remoteContentLoaded).toBe(true);
    // The real fetcher would refuse the internal URLs; here they at least never got inlined.
    expect(fetched.filter((u) => /127\.0\.0\.1|10\.0\.0\.1|localhost/.test(u)).length).toBeGreaterThan(0);
  });
});
