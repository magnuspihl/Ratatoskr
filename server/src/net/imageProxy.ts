import http from 'node:http';
import https from 'node:https';
import { hmac, safeEqual } from '../crypto.js';
import net from 'node:net';
import { BlockedAddressError, isPublicAddress, publicOnlyLookup } from './ssrf.js';

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
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 4;
const TIMEOUT_MS = 10_000;

/** Validate that a URL is something the proxy is willing to fetch at all. */
export function proxyableUrl(raw: string): URL | null {
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

/**
 * Proxy URLs are signed so the endpoint is not an open proxy, and so that it works from inside
 * the sandboxed (opaque-origin, cookieless) message iframe. The signature binds the target URL
 * to the requesting user.
 */
export function signProxyUrl(key: Buffer, userId: string, target: string): string {
  const sig = hmac(key, `img-proxy:${userId}:${target}`);
  return `/api/proxy/image?u=${encodeURIComponent(target)}&uid=${encodeURIComponent(userId)}&s=${sig}`;
}

export function verifyProxySignature(key: Buffer, userId: string, target: string, sig: string): boolean {
  return safeEqual(hmac(key, `img-proxy:${userId}:${target}`), sig);
}

export interface ProxiedImage {
  contentType: string;
  body: Buffer;
}

export class ProxyError extends Error {
  constructor(
    message: string,
    readonly status = 502,
  ) {
    super(message);
  }
}

function getOnce(url: URL): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer | null }> {
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
          'user-agent': 'Mozilla/5.0 (compatible; Ratatoskr image proxy)',
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
        if (declared > MAX_BYTES) {
          res.destroy();
          return reject(new ProxyError('Image too large', 413));
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > MAX_BYTES) {
            res.destroy();
            reject(new ProxyError('Image too large', 413));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => resolve({ status, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new ProxyError('Upstream timeout', 504)));
    req.on('error', (err) =>
      reject(err instanceof ProxyError || err instanceof BlockedAddressError ? err : new ProxyError(err.message)),
    );
    req.end();
  });
}

/** Fetch a remote image without ever touching private/internal addresses. */
export async function fetchRemoteImage(raw: string): Promise<ProxiedImage> {
  const first = proxyableUrl(raw);
  if (!first) throw new ProxyError('URL not allowed', 400);
  let url: URL = first;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const res = await getOnce(url);
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.location;
      const next: URL | null = loc ? proxyableUrl(new URL(loc, url).toString()) : null;
      if (!next) throw new ProxyError('Redirect not allowed', 502);
      url = next;
      continue;
    }
    if (res.status !== 200 || !res.body) throw new ProxyError(`Upstream status ${res.status}`, 502);
    const type = String(res.headers['content-type'] ?? '')
      .split(';')[0]!
      .trim()
      .toLowerCase();
    // SVG is excluded on purpose: it is a scriptable document format.
    if (!ALLOWED_TYPES.has(type)) throw new ProxyError('Not an allowed image type', 415);
    return { contentType: type, body: res.body };
  }
  throw new ProxyError('Too many redirects', 502);
}
