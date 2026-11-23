import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { AttachmentView, MessageDetail, MessageRef } from '../../shared/types';
import { api, ApiError } from './api';
import { refKey } from './util';

/**
 * Inline images of large messages.
 *
 * The server opens a large message without downloading its attachments (MessageDetail.partial),
 * so its inline images arrive as <img data-ratatoskr-part="…"> placeholders. The message is shown
 * at once; each image is then fetched on its own and shows a spinner until it is there, or a
 * "couldn't load" sign if it fails or takes too long (it stays downloadable as an attachment).
 *
 * The message frame makes no network requests (see shared/srcdoc.ts), so images are fetched
 * here and put into the HTML as data: URIs.
 */

export const PENDING_ATTR = 'data-ratatoskr-part';
/** Images larger than this aren't shown in the message, only offered as attachments. */
export const MAX_INLINE_IMAGE_BYTES = 25 * 1024 * 1024;
/** How long one image may take to arrive before it is given up on. */
export const INLINE_IMAGE_TIMEOUT_MS = 120_000;

const RASTER = /^image\/(png|jpe?g|gif|webp|avif|bmp)$/i;
const SAFE_SRC = /^data:image\/(png|jpe?g|gif|webp|avif|bmp|svg\+xml);base64,[A-Za-z0-9+/=]+$/;

export type InlineImageState =
  | { status: 'loading' }
  | { status: 'loaded'; src: string }
  | { status: 'failed'; reason: string };

function svg(body: string): string {
  const doc = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32" fill="none" stroke="#8a8f98" stroke-width="2.5" stroke-linecap="round">${body}</svg>`;
  return `data:image/svg+xml;base64,${btoa(doc)}`;
}

/** A spinning arc (SVG animations run even inside an image in the scriptless frame). */
export const LOADING_IMAGE = svg(
  '<path d="M16 4a12 12 0 0 1 12 12"><animateTransform attributeName="transform" type="rotate" from="0 16 16" to="360 16 16" dur="0.9s" repeatCount="indefinite"/></path><circle cx="16" cy="16" r="12" stroke-opacity="0.2"/>',
);
/** A crossed-out picture. */
export const FAILED_IMAGE = svg('<rect x="5" y="7" width="22" height="18" rx="2"/><path d="M5 21l6-6 5 5 3-3 8 8"/><path d="M4 4l24 24"/>');

/** The parts of the message that placeholders in its HTML are waiting for, in order. */
export function pendingParts(html: string): string[] {
  const parts = [...html.matchAll(/data-ratatoskr-part="([0-9.]+)"/g)].map((m) => m[1]!);
  return [...new Set(parts)];
}

/** Which attachments to fetch for the placeholders, and which can't be shown inline at all. */
export function inlineTargets(d: Pick<MessageDetail, 'html' | 'attachments' | 'partial'>): { load: AttachmentView[]; skip: Map<string, string> } {
  const load: AttachmentView[] = [];
  const skip = new Map<string, string>();
  if (!d.partial || !d.html) return { load, skip };
  for (const part of pendingParts(d.html)) {
    const a = d.attachments.find((x) => x.part === part);
    if (!a || !RASTER.test(a.mimeType)) skip.set(part, 'Not an image');
    else if (a.size > MAX_INLINE_IMAGE_BYTES) skip.set(part, 'Too large to show here; download it from the attachments');
    else load.push(a);
  }
  return { load, skip };
}

/**
 * The HTML with every placeholder showing its image, a spinner while it loads, or a broken
 * picture if it could not be loaded. Only data: URIs of image types are ever inserted.
 */
export function fillInlineImages(html: string, states: ReadonlyMap<string, InlineImageState>): string {
  return html.replace(/data-ratatoskr-part="([0-9.]+)"/g, (attr, part: string) => {
    const s = states.get(part) ?? { status: 'loading' };
    if (s.status === 'loaded' && SAFE_SRC.test(s.src)) return `src="${s.src}" ${attr}`;
    if (s.status === 'failed') return `src="${FAILED_IMAGE}" ${attr} data-ratatoskr-state="failed"`;
    return `src="${LOADING_IMAGE}" ${attr} data-ratatoskr-state="loading"`;
  });
}

function base64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}

/** Fetch one inline image and return it as a data: URI of its declared (raster) type. */
export async function loadInlineImage(
  url: string,
  mimeType: string,
  opts: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<string> {
  const type = mimeType.toLowerCase();
  if (!RASTER.test(type)) throw new Error('Not an image');
  const doFetch = opts.fetch ?? fetch;
  const signal = AbortSignal.timeout(opts.timeoutMs ?? INLINE_IMAGE_TIMEOUT_MS);
  try {
    const res = await doFetch(url, { credentials: 'same-origin', signal });
    if (!res.ok) {
      let msg = res.statusText || `HTTP ${res.status}`;
      try {
        msg = ((await res.json()) as { error?: string }).error ?? msg;
      } catch {
        /* not JSON */
      }
      throw new ApiError(msg, res.status);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    return `data:${type === 'image/jpg' ? 'image/jpeg' : type};base64,${base64(bytes)}`;
  } catch (err) {
    if (signal.aborted) throw new Error('The image took too long to load');
    throw err;
  }
}

/**
 * Load the inline images of a partially loaded message one after another (the server fetches
 * them over a single mail server connection anyway, so each gets its full time budget), and
 * report how each one is doing. Loaded images are kept in the query cache.
 */
export function useInlineImages(msgRef: MessageRef, d: MessageDetail | undefined): ReadonlyMap<string, InlineImageState> {
  const qc = useQueryClient();
  const [states, setStates] = useState<ReadonlyMap<string, InlineImageState>>(new Map());
  const key = refKey(msgRef);
  useEffect(() => {
    if (!d) return;
    const { load, skip } = inlineTargets(d);
    const initial = new Map<string, InlineImageState>();
    for (const [part, reason] of skip) initial.set(part, { status: 'failed', reason });
    for (const a of load) {
      const cached = qc.getQueryData<string>(['inline-image', key, a.part]);
      initial.set(a.part!, cached ? { status: 'loaded', src: cached } : { status: 'loading' });
    }
    setStates(initial);
    let cancelled = false;
    void (async () => {
      for (const a of load) {
        if (cancelled) return;
        if (initial.get(a.part!)?.status === 'loaded') continue;
        let next: InlineImageState;
        try {
          const src = await qc.fetchQuery({
            queryKey: ['inline-image', key, a.part],
            queryFn: () => loadInlineImage(api.attachmentUrl(msgRef, a), a.mimeType),
            staleTime: Infinity,
            gcTime: 10 * 60_000,
            retry: false,
          });
          next = { status: 'loaded', src };
        } catch (err) {
          next = { status: 'failed', reason: (err as Error).message };
        }
        if (cancelled) return;
        setStates((prev) => new Map(prev).set(a.part!, next));
      }
    })();
    return () => {
      cancelled = true;
    };
    // msgRef is identified by key
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d, key, qc]);
  return states;
}
