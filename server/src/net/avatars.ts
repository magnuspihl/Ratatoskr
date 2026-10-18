import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import { normaliseDomain } from '../mail/imageAllowlist.js';
import { fetchRemoteImage, RemoteImageCache, type RemoteImage } from './remoteImages.js';

/**
 * Contact pictures for senders. Like remote images in mail, the server fetches them itself, so the
 * reader's browser never talks to Gravatar & co.: they don't see the reader's IP address, and an
 * avatar request never reveals when a message is opened.
 *
 * Sources, in order: Gravatar, Libravatar (the sender domain's own server if it federates, else
 * the central one), then the icon of the sender's organisation domain. Free-mail domains get no
 * domain icon: a Gmail logo says nothing about the person.
 */

export const AVATAR_SIZE = 160;
export const MAX_AVATAR_BYTES = 512 * 1024;
/** No new source is tried after this long, so one slow host can't hold a lookup forever. */
const LOOKUP_DEADLINE_MS = 10_000;

const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+$/;

/** Lowercased, trimmed address with a plausible domain, or null. */
export function normaliseEmail(input: string): string | null {
  const email = input.trim().toLowerCase();
  if (email.length > 254 || !EMAIL.test(email)) return null;
  const domain = normaliseDomain(email.slice(email.lastIndexOf('@') + 1));
  return domain ? `${email.slice(0, email.lastIndexOf('@'))}@${domain}` : null;
}

/** The hash Gravatar and Libravatar both accept: SHA-256 of the normalised address. */
export const emailHash = (email: string) => crypto.createHash('sha256').update(email).digest('hex');

// Public mailbox providers, matched on the organisation domain's first label (gmail.com,
// yahoo.co.uk, gmx.de, ...).
const FREEMAIL = new Set([
  'gmail', 'googlemail', 'outlook', 'hotmail', 'live', 'msn', 'yahoo', 'ymail', 'icloud', 'me', 'mac',
  'aol', 'gmx', 'web', 'proton', 'protonmail', 'pm', 'mail', 'yandex', 'zoho', 'fastmail', 'hey',
  'tutanota', 'tuta', 'mailbox', 'posteo', 'qq', '163', '126', 'naver', 'seznam', 'libero', 'orange',
  'free', 'wanadoo', 't-online', 'comcast', 'att', 'sbcglobal', 'verizon', 'btinternet', 'rocketmail',
]);

// Second-level labels under which country-code TLDs register names (example.co.uk, example.com.au).
const CC_SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'ac', 'gov', 'edu', 'ne', 'or', 'go', 'gv']);

/**
 * The organisation domain of a mail domain: mail.github.com -> github.com, news.bbc.co.uk ->
 * bbc.co.uk. An approximation of the public suffix list that is right for the common cases.
 */
export function organisationDomain(domain: string): string {
  const labels = domain.split('.');
  const n = labels.length;
  const keep = n >= 3 && labels[n - 1]!.length === 2 && CC_SECOND_LEVEL.has(labels[n - 2]!) ? 3 : 2;
  return labels.slice(-keep).join('.');
}

export const isFreemail = (domain: string) => FREEMAIL.has(organisationDomain(domain).split('.')[0]!);

export type SrvResolver = (name: string) => Promise<{ name: string; port: number; priority: number; weight: number }[]>;

/** Libravatar federation: the sender's domain can run its own avatar server (_avatars-sec._tcp SRV). */
async function libravatarBase(domain: string, resolveSrv: SrvResolver): Promise<string> {
  try {
    const records = await resolveSrv(`_avatars-sec._tcp.${domain}`);
    const best = records.filter((r) => r.port === 443 && normaliseDomain(r.name)).sort((a, b) => a.priority - b.priority || b.weight - a.weight)[0];
    if (best) return `https://${normaliseDomain(best.name)}/avatar/`;
  } catch {
    // No federation record: use the central server.
  }
  return 'https://seccdn.libravatar.org/avatar/';
}

/** Image URLs to try for an address, most specific first. */
export async function avatarCandidates(email: string, resolveSrv: SrvResolver = dns.resolveSrv): Promise<string[]> {
  const hash = emailHash(email);
  const domain = email.slice(email.lastIndexOf('@') + 1);
  const query = `?s=${AVATAR_SIZE}&d=404`;
  const urls = [`https://gravatar.com/avatar/${hash}${query}`, `${await libravatarBase(domain, resolveSrv)}${hash}${query}`];
  if (!isFreemail(domain)) {
    const org = organisationDomain(domain);
    urls.push(`https://${org}/apple-touch-icon.png`, `https://www.${org}/apple-touch-icon.png`);
  }
  return urls;
}

export interface AvatarServiceOptions {
  /** Injectable for tests. */
  fetchImage?: (url: string) => Promise<RemoteImage>;
  resolveSrv?: SrvResolver;
  cache?: RemoteImageCache;
  deadlineMs?: number;
}

export class AvatarService {
  private readonly fetchImage: (url: string) => Promise<RemoteImage>;
  private readonly resolveSrv: SrvResolver;
  // Hits are kept a day, misses six hours: people rarely change their picture.
  private readonly cache: RemoteImageCache;
  private readonly inflight = new Map<string, Promise<RemoteImage | null>>();
  private readonly deadlineMs: number;

  constructor(opts: AvatarServiceOptions = {}) {
    this.fetchImage = opts.fetchImage ?? ((url) => fetchRemoteImage(url, { maxBytes: MAX_AVATAR_BYTES }));
    this.resolveSrv = opts.resolveSrv ?? dns.resolveSrv;
    this.cache = opts.cache ?? new RemoteImageCache(32 * 1024 * 1024, 24 * 3600_000, 6 * 3600_000);
    this.deadlineMs = opts.deadlineMs ?? LOOKUP_DEADLINE_MS;
  }

  /** The picture for an already normalised address, or null if no source has one. Never throws. */
  lookup(userId: string, email: string): Promise<RemoteImage | null> {
    const cached = this.cache.get(userId, email);
    if (cached !== undefined) return Promise.resolve(cached);
    // A conversation shows the same sender several times; look them up once.
    const key = `${userId}\u0000${email}`;
    let pending = this.inflight.get(key);
    if (!pending) {
      pending = this.find(email).then((img) => {
        this.cache.set(userId, email, img);
        this.inflight.delete(key);
        return img;
      });
      this.inflight.set(key, pending);
    }
    return pending;
  }

  private async find(email: string): Promise<RemoteImage | null> {
    const deadline = Date.now() + this.deadlineMs;
    let urls: string[];
    try {
      urls = await avatarCandidates(email, this.resolveSrv);
    } catch {
      return null;
    }
    for (const url of urls) {
      if (Date.now() > deadline) break;
      try {
        const img = await this.fetchImage(url);
        if (img.body.length > 0 && img.body.length <= MAX_AVATAR_BYTES) return img;
      } catch {
        // Not there (404), not an image, blocked or unreachable: try the next source.
      }
    }
    return null;
  }
}
