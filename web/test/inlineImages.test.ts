import { describe, expect, it } from 'vitest';
import type { AttachmentView } from '../../shared/types';
import { api } from '../src/api';
import {
  FAILED_IMAGE,
  fillInlineImages,
  inlineTargets,
  LOADING_IMAGE,
  loadInlineImage,
  MAX_INLINE_IMAGE_BYTES,
  pendingParts,
  type InlineImageState,
} from '../src/inlineImages';

const ref = { accountId: 'a1', folder: 'INBOX', uid: 7, uidValidity: '1' };
const att = (part: string, over: Partial<AttachmentView> = {}): AttachmentView => ({
  index: 0,
  part,
  filename: `${part}.jpg`,
  mimeType: 'image/jpeg',
  size: 1000,
  inline: true,
  contentId: `${part}@x`,
  ...over,
});
const HTML = '<p>Hi</p><img width="400" data-ratatoskr-part="1.2" /><img data-ratatoskr-part="1.3" /><img data-ratatoskr-part="1.2" />';

describe('inline images of large messages', () => {
  it('finds each image placeholder once, in order', () => {
    expect(pendingParts(HTML)).toEqual(['1.2', '1.3']);
    expect(pendingParts('<p>No images</p>')).toEqual([]);
  });

  it('shows a spinner for every image that is still loading', () => {
    const out = fillInlineImages(HTML, new Map());
    expect(out.match(/data-ratatoskr-state="loading"/g)).toHaveLength(3);
    expect(out).toContain(`src="${LOADING_IMAGE}"`);
  });

  it('puts each loaded image in place and keeps spinners for the rest', () => {
    const states = new Map<string, InlineImageState>([['1.2', { status: 'loaded', src: 'data:image/jpeg;base64,AAAA' }]]);
    const out = fillInlineImages(HTML, states);
    expect(out).toContain('<img width="400" src="data:image/jpeg;base64,AAAA" data-ratatoskr-part="1.2" />');
    expect(out).toContain(`<img src="${LOADING_IMAGE}" data-ratatoskr-part="1.3" data-ratatoskr-state="loading" />`);
  });

  it('shows a broken-image sign instead of spinning forever when an image failed', () => {
    const out = fillInlineImages(HTML, new Map([['1.3', { status: 'failed', reason: 'timeout' }]]));
    expect(out).toContain(`<img src="${FAILED_IMAGE}" data-ratatoskr-part="1.3" data-ratatoskr-state="failed" />`);
  });

  it('never inserts anything but an image data: URI', () => {
    const states = new Map<string, InlineImageState>([['1.2', { status: 'loaded', src: 'https://evil.example/" onerror="x' }]]);
    const out = fillInlineImages(HTML, states);
    expect(out).not.toContain('evil.example');
    expect(out).not.toContain('onerror');
  });

  it('loads only raster images small enough to show; the rest stay downloadable attachments', () => {
    const d = {
      partial: true,
      html: HTML + '<img data-ratatoskr-part="1.4" /><img data-ratatoskr-part="1.5" />',
      attachments: [att('1.2'), att('1.3', { size: MAX_INLINE_IMAGE_BYTES + 1 }), att('1.4', { mimeType: 'image/svg+xml' }), att('2', { inline: false })],
    };
    const { load, skip } = inlineTargets(d);
    expect(load.map((a) => a.part)).toEqual(['1.2']);
    expect([...skip.keys()]).toEqual(['1.3', '1.4', '1.5']);
    expect(skip.get('1.3')).toMatch(/too large/i);
  });

  it('has nothing to load for messages that were downloaded whole', () => {
    expect(inlineTargets({ partial: undefined, html: HTML, attachments: [att('1.2')] }).load).toEqual([]);
  });

  it('fetches an image by part and turns it into a data: URI of its type', async () => {
    let asked = '';
    const fetch = (async (url: string) => {
      asked = url;
      return new Response(new Uint8Array([1, 2, 3]));
    }) as unknown as typeof globalThis.fetch;
    const src = await loadInlineImage(api.attachmentUrl(ref, att('1.2')), 'image/jpeg', { fetch });
    expect(asked).toBe('/api/attachment?accountId=a1&folder=INBOX&uid=7&uidValidity=1&part=1.2');
    expect(src).toBe('data:image/jpeg;base64,AQID');
  });

  it("reports the server's error message when an image can't be fetched", async () => {
    const fetch = (async () => new Response(JSON.stringify({ error: 'Attachment not found' }), { status: 404 })) as unknown as typeof globalThis.fetch;
    await expect(loadInlineImage('/x', 'image/png', { fetch })).rejects.toThrow('Attachment not found');
  });

  it('gives up on an image that takes too long', async () => {
    const fetch = ((_url: string, init: RequestInit) =>
      new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason)))) as unknown as typeof globalThis.fetch;
    await expect(loadInlineImage('/x', 'image/png', { fetch, timeoutMs: 20 })).rejects.toThrow('The image took too long to load');
  });

  it('refuses to load non-raster types such as SVG', async () => {
    await expect(loadInlineImage('/x', 'image/svg+xml', { fetch: (() => {}) as unknown as typeof fetch })).rejects.toThrow('Not an image');
  });
});

describe('attachment links', () => {
  it('fetch attachments of large messages by part and others by index', () => {
    expect(api.attachmentUrl(ref, { index: 3 })).toBe('/api/attachment?accountId=a1&folder=INBOX&uid=7&uidValidity=1&index=3');
    expect(api.attachmentUrl(ref, { index: 3, part: '2.1' })).toBe('/api/attachment?accountId=a1&folder=INBOX&uid=7&uidValidity=1&part=2.1');
  });
});
