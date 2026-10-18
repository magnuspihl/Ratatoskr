import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { BlockedAddressError, isPublicAddress, publicOnlyLookup } from './ssrf.js';

/**
 * Remote images in mail ("Load images"). The server fetches them itself and inlines them as
 * data: URIs, so the sandboxed message iframe never makes a network request: the sender never
 * sees the reader's IP or cookies, and it works behind cookie-based auth proxies (the opaque-origin
 * iframe couldn't send their SameSite cookies anyway).
 */

const ALLOWED_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
  'image/x-icon',
  'image/vnd.microsoft.icon',
]);
const ALLOWED_PORTS = new Set(['', '80', '443']);
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_BYTES = MAX_IMAGE_BYTES;
const MAX_REDIRECTS = 4;
const TIMEOUT_MS = 10_000;

/** Validate that a URL is something the server is willing to fetch at all. */
export function fetchableImageUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  if (!ALLOWED_PORTS.has(url.port)) return null;
  return url;
}

export interface RemoteImage {
  contentType: string;
  body: Buffer;
}

export class RemoteImageError extends Error {
  constructor(
    message: string,
    readonly status = 502,
  ) {
    super(message);
  }
}

function getOnce(url: URL, maxBytes: number): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer | null }> {
  // Node never calls `lookup` for IP-literal hosts, so those must be checked explicitly.
  const literal = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(literal) && !isPublicAddress(literal)) return Promise.reject(new BlockedAddressError(url.hostname));
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(
      url,
      {
        method: 'GET',
        lookup: publicOnlyLookup as never,
        timeout: TIMEOUT_MS,
        headers: {
          // Deliberately generic: no cookies, no referer, nothing identifying the reader.
          'user-agent': 'Mozilla/5.0 (compatible; Ratatoskr image fetcher)',
          accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif,image/*;q=0.8',
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.resume();
          return resolve({ status, headers: res.headers, body: null });
        }
        const declared = Number(res.headers['content-length'] ?? 0);
        if (declared > maxBytes) {
          res.destroy();
          return reject(new RemoteImageError('Image too large', 413));
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > maxBytes) {
            res.destroy();
            reject(new RemoteImageError('Image too large', 413));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => resolve({ status, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new RemoteImageError('Upstream timeout', 504)));
    req.on('error', (err) =>
      reject(err instanceof RemoteImageError || err instanceof BlockedAddressError ? err : new RemoteImageError(err.message)),
    );
    req.end();
  });
}

/** Fetch a remote image without ever touching private/internal addresses. */
export async function fetchRemoteImage(raw: string, opts: { maxBytes?: number } = {}): Promise<RemoteImage> {
  const maxBytes = Math.min(opts.maxBytes ?? MAX_BYTES, MAX_BYTES);
  const first = fetchableImageUrl(raw);
  if (!first) throw new RemoteImageError('URL not allowed', 400);
  let url: URL = first;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const res = await getOnce(url, maxBytes);
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.location;
      const next: URL | null = loc ? fetchableImageUrl(new URL(loc, url).toString()) : null;
      if (!next) throw new RemoteImageError('Redirect not allowed', 502);
      url = next;
      continue;
    }
    if (res.status !== 200 || !res.body) throw new RemoteImageError(`Upstream status ${res.status}`, 502);
    const type = String(res.headers['content-type'] ?? '')
      .split(';')[0]!
      .trim()
      .toLowerCase();
    // SVG is excluded on purpose: it is a scriptable document format.
    if (!ALLOWED_TYPES.has(type)) throw new RemoteImageError('Not an allowed image type', 415);
    return { contentType: type, body: res.body };
  }
  throw new RemoteImageError('Too many redirects', 502);
}

// ---- inlining -----------------------------------------------------------------------------

export interface InlineOptions {
  /** Cache scope: cached images are only reused for the same user. */
  userId: string;
  cache?: RemoteImageCache;
  /** Parallel fetches. */
  concurrency?: number;
  /** Total bytes of images inlined into one message. */
  totalBytes?: number;
  /** Most distinct images fetched for one message. */
  maxImages?: number;
  /** No new fetches are started after this many ms. */
  deadlineMs?: number;
  /** Injectable for tests. */
  fetchImage?: (url: string) => Promise<RemoteImage>;
}

export const INLINE_DEFAULTS = { concurrency: 6, totalBytes: 15 * 1024 * 1024, maxImages: 100, deadlineMs: 20_000 };

const toDataUri = (img: RemoteImage) => `data:${img.contentType};base64,${img.body.toString('base64')}`;

/**
 * Fetch the given remote image URLs and return url -> data: URI (or null when the image is
 * blocked, failed, too large, over the per-message budget, or past the deadline). Never throws.
 */
export async function inlineRemoteImages(urls: string[], opts: InlineOptions): Promise<Map<string, string | null>> {
  const o = { ...INLINE_DEFAULTS, ...opts };
  const fetchImage = opts.fetchImage ?? fetchRemoteImage;
  const out = new Map<string, string | null>();
  const unique = [...new Set(urls)];
  const queue = unique.slice(0, o.maxImages);
  for (const u of unique.slice(o.maxImages)) out.set(u, null);
  const deadline = Date.now() + o.deadlineMs;
  let budget = o.totalBytes;

  const accept = (url: string, img: RemoteImage | null) => {
    if (!img || img.body.length > budget) {
      out.set(url, null);
      return;
    }
    budget -= img.body.length;
    out.set(url, toDataUri(img));
  };

  const worker = async () => {
    for (let url = queue.shift(); url !== undefined; url = queue.shift()) {
      if (budget <= 0 || Date.now() > deadline || !fetchableImageUrl(url)) {
        out.set(url, null);
        continue;
      }
      const cached = o.cache?.get(o.userId, url);
      if (cached !== undefined) {
        accept(url, cached);
        continue;
      }
      let img: RemoteImage | null = null;
      try {
        img = await fetchImage(url);
      } catch {
        img = null;
      }
      o.cache?.set(o.userId, url, img);
      accept(url, img);
    }
  };
  await Promise.all(Array.from({ length: Math.min(o.concurrency, queue.length) }, worker));
  return out;
}

/**
 * Small in-memory LRU for fetched images, so toggling "Load images" or re-opening a message
 * doesn't refetch everything. Keyed per user, short TTL, capped in total bytes; failures are
 * remembered briefly too. Not persisted: it only saves round trips, it isn't a mail store.
 */
export class RemoteImageCache {
  private readonly entries = new Map<string, { img: RemoteImage | null; expires: number; size: number }>();
  private size = 0;

  constructor(
    private readonly maxBytes = 64 * 1024 * 1024,
    private readonly ttlMs = 10 * 60_000,
    private readonly failureTtlMs = 60_000,
  ) {}

  private key(userId: string, url: string) {
    return `${userId}\u0000${url}`;
  }

  /** undefined = not cached; null = cached failure. */
  get(userId: string, url: string): RemoteImage | null | undefined {
    const k = this.key(userId, url);
    const e = this.entries.get(k);
    if (!e) return undefined;
    if (e.expires < Date.now()) {
      this.delete(k);
      return undefined;
    }
    // Refresh recency.
    this.entries.delete(k);
    this.entries.set(k, e);
    return e.img;
  }

  set(userId: string, url: string, img: RemoteImage | null) {
    const k = this.key(userId, url);
    const size = (img?.body.length ?? 0) + url.length;
    if (size > this.maxBytes) return;
    this.delete(k);
    this.entries.set(k, { img, size, expires: Date.now() + (img ? this.ttlMs : this.failureTtlMs) });
    this.size += size;
    for (const [oldest] of this.entries) {
      if (this.size <= this.maxBytes) break;
      this.delete(oldest);
    }
  }

  private delete(k: string) {
    const e = this.entries.get(k);
    if (!e) return;
    this.size -= e.size;
    this.entries.delete(k);
  }

  get bytes() {
    return this.size;
  }
}
