import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AttachmentView } from '../../shared/types';
import { AttachmentChip } from '../src/components/Reader';
import { downloadFile, downloadLabel, type DownloadState } from '../src/download';

/** A response whose body arrives in the given chunks. */
function streamed(chunks: string[], headers: Record<string, string> = {}): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
  return new Response(body, { status: 200, headers });
}

async function run(res: Response | Error) {
  const states: DownloadState[] = [];
  const saved: { blob: Blob; filename: string }[] = [];
  await downloadFile('/api/attachment?x', 'report.pdf', (s) => states.push(s), {
    fetch: async () => {
      if (res instanceof Error) throw res;
      return res;
    },
    save: (blob, filename) => saved.push({ blob, filename }),
  });
  return { states, saved };
}

describe('downloading an attachment', () => {
  it('shows that it is working straight away, before the server answers', async () => {
    const { states } = await run(streamed(['abc']));
    expect(states[0]).toEqual({ status: 'preparing' });
    expect(downloadLabel(states[0]!)).toBe('Preparing…');
  });

  it('reports progress as the file arrives and saves it under its own name', async () => {
    const { states, saved } = await run(streamed(['hello ', 'world'], { 'content-length': '11' }));
    const progress = states.filter((s) => s.status === 'receiving').map(downloadLabel);
    expect(progress).toEqual(['0%', '55%', '100%']);
    expect(states.at(-1)).toEqual({ status: 'done' });
    expect(saved).toHaveLength(1);
    expect(saved[0]!.filename).toBe('report.pdf');
    expect(await saved[0]!.blob.text()).toBe('hello world');
  });

  it('says "Downloading…" when the size is unknown', async () => {
    const { states } = await run(streamed(['abc']));
    expect(downloadLabel(states.find((s) => s.status === 'receiving')!)).toBe('Downloading…');
  });

  it('shows the server’s error instead of saving an error page as the file', async () => {
    const res = new Response(JSON.stringify({ error: 'Attachment not found' }), { status: 404, headers: { 'content-type': 'application/json' } });
    const { states, saved } = await run(res);
    expect(saved).toHaveLength(0);
    expect(states.at(-1)).toEqual({ status: 'error', message: 'Attachment not found' });
    expect(downloadLabel(states.at(-1)!)).toBe('Failed');
  });

  it('reports a lost connection as a failure', async () => {
    const { states, saved } = await run(new TypeError('Failed to fetch'));
    expect(saved).toHaveLength(0);
    expect(states.at(-1)).toEqual({ status: 'error', message: 'Failed to fetch' });
  });

  it('goes quietly back to normal when cancelled', async () => {
    const { states } = await run(new DOMException('aborted', 'AbortError'));
    expect(states.at(-1)).toEqual({ status: 'idle' });
  });
});

describe('the attachment chip', () => {
  const att: AttachmentView = { index: 0, filename: 'report.pdf', mimeType: 'application/pdf', size: 2048, inline: false, contentId: null };
  const chip = (state?: DownloadState) => renderToStaticMarkup(createElement(AttachmentChip, { url: '/api/attachment?i=0', attachment: att, initialState: state }));

  it('shows the file size when nothing is happening', () => {
    const html = chip();
    expect(html).toContain('report.pdf');
    expect(html).toContain('2 KB');
    expect(html).not.toContain('downloading');
  });

  it('shows a spinner and "Preparing…" while the server fetches the message', () => {
    const html = chip({ status: 'preparing' });
    expect(html).toContain('class="attachment downloading');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('Preparing…');
    expect(html).toContain('spin');
  });

  it('fills a progress bar as the file arrives', () => {
    const html = chip({ status: 'receiving', received: 512, total: 2048 });
    expect(html).toContain('25%');
    expect(html).toContain('width:25%');
  });

  it('confirms when the file was saved', () => {
    const html = chip({ status: 'done' });
    expect(html).toContain('saved');
    expect(html).toContain('Saved');
  });

  it('marks a failed download and explains why on hover', () => {
    const html = chip({ status: 'error', message: 'Mail server unavailable' });
    expect(html).toContain('failed');
    expect(html).toContain('Couldn&#x27;t download report.pdf: Mail server unavailable');
  });
});
