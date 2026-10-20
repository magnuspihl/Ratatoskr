import type { FetchMessageObject, ImapFlow, ListResponse, SearchObject } from 'imapflow';
import type {
  AccountCursor,
  AccountFolders,
  Address,
  FolderView,
  ListResponse as MessageListResponse,
  MessageAction,
  MessageDetail,
  MessageRef,
  MessageSummary,
  SpecialUse,
  UndoInfo,
} from '../../../shared/types.js';
import type { ThreadHeaders } from '../../../shared/threads.js';
import { CacheCorruptError, imapFlags, type CachedFolder, type MailCache } from '../cache/store.js';
import type { CacheSync } from '../cache/sync.js';
import { decideRemoteImages, displayDomain } from '../mail/imageAllowlist.js';
import { attachmentBytes, buildMessageDetail, parseRaw, type ParsedEmail } from '../mail/parse.js';
import { collectRemoteImageUrls } from '../mail/sanitize.js';
import { inlineRemoteImages, type InlineOptions, type RemoteImageCache } from '../net/remoteImages.js';
import { MailServerError, describeError } from './connect.js';
import type { ImapPool } from './pool.js';
import { lookupTerms, matchesTerm, RelatedIndex, searchFor, termKey, type LookupTerm } from './related.js';
import { addresses, fetchSnippets, LIST_FETCH, sortTime, summaryOf, threadHeaders, toDate } from './summary.js';

export { threadHeaders };

const SPECIAL_USE: Record<string, SpecialUse> = {
  '\\Inbox': 'inbox',
  '\\Sent': 'sent',
  '\\Drafts': 'drafts',
  '\\Trash': 'trash',
  '\\Archive': 'archive',
  '\\Junk': 'junk',
  '\\All': 'all',
  '\\Flagged': 'flagged',
  // RFC 9979. Only marks the folder; IMAP has no wake-up time, so Ratatoskr keeps that itself.
  '\\Snoozed': 'snoozed',
};

/** Extra name fallbacks on top of ImapFlow's built-in localized name detection. */
const NAME_FALLBACKS: Partial<Record<SpecialUse, RegExp>> = {
  sent: /^(sent|sent items|sent mail|sent messages|gesendet|envoyés|skickat|sendt)$/i,
  drafts: /^(drafts?|entwürfe|brouillons|utkast|kladder)$/i,
  trash: /^(trash|deleted|deleted items|deleted messages|bin|papierkorb|corbeille|papperskorg|papirkurv)$/i,
  archive: /^(archives?|archiv|arkiv)$/i,
  junk: /^(junk|spam|junk e-?mail|bulk mail|skräppost|uønsket)$/i,
  snoozed: /^(snoozed|zurückgestellt|en attente|snoozade|udsat)$/i,
};

export class MessageGoneError extends Error {}
export class StaleError extends Error {}

export interface ListSource {
  accountId: string;
  folder: string;
}

/** Server-side filtering of a listing: a text query and/or unread only. */
export interface ListFilter {
  /** '' = no text query */
  text: string;
  unread: boolean;
}

export const NO_FILTER: ListFilter = { text: '', unread: false };
export const isFiltered = (f: ListFilter) => f.text !== '' || f.unread;

/** A message of a listing, fetched from the IMAP server (`msg`, no snippet yet) or from the cache (`summary`). */
interface FetchedItem {
  source: ListSource;
  uidValidity: string;
  uid: number;
  sortTime: number;
  headers: ThreadHeaders;
  msg?: FetchMessageObject;
  summary?: MessageSummary;
}

interface SourcePage {
  source: ListSource;
  uidValidity: string;
  items: FetchedItem[];
  /** True if there are no messages older than the oldest item returned. */
  exhausted: boolean;
  reset: boolean;
}

type CursorMap = Record<string, AccountCursor>;

const sourceKey = (s: ListSource) => `${s.accountId}\u0000${s.folder}`;

function fetchedItem(source: ListSource, uidValidity: string, msg: FetchMessageObject): FetchedItem {
  return { source, uidValidity, uid: msg.uid, sortTime: sortTime(msg), headers: threadHeaders(msg), msg };
}

function cachedItem(source: ListSource, uidValidity: string, m: { summary: MessageSummary; sortTime: number }): FetchedItem {
  return { source, uidValidity, uid: m.summary.uid, sortTime: m.sortTime, headers: m.summary, summary: m.summary };
}

export function encodeCursor(c: CursorMap): string {
  return Buffer.from(JSON.stringify(c)).toString('base64url');
}

export function decodeCursor(raw: string | undefined | null): CursorMap {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const out: CursorMap = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      const c = v as Partial<AccountCursor>;
      if (typeof c.uidValidity === 'string' && Number.isInteger(c.beforeUid) && typeof c.done === 'boolean') {
        out[k] = { uidValidity: c.uidValidity, beforeUid: c.beforeUid!, done: c.done };
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** Related messages fetched per folder and page. */
const MAX_RELATED = 200;
/** A listing of a current cached INBOX checks the cached Sent folder in the background when it is older than this. */
const SENT_REFRESH_MS = 5000;

/**
 * K-way merge of per-source pages. Each source's items are a queue ordered newest-UID-first; at
 * every step the queue head with the most recent date wins. Because each source is consumed as a
 * strict UID-descending prefix, "the lowest UID consumed" is an exact per-source cursor even when
 * dates and UIDs disagree.
 */
export function mergePages(pages: SourcePage[], limit: number, previous: CursorMap) {
  const queues = pages.map((p) => ({ page: p, idx: 0 }));
  const picked: FetchedItem[] = [];
  while (picked.length < limit) {
    let best: (typeof queues)[number] | null = null;
    for (const q of queues) {
      const head = q.page.items[q.idx];
      if (!head) continue;
      const bestHead = best ? best.page.items[best.idx]! : null;
      if (!bestHead || head.sortTime > bestHead.sortTime) best = q;
    }
    if (!best) break;
    picked.push(best.page.items[best.idx]!);
    best.idx++;
  }
  const cursor: CursorMap = {};
  let more = false;
  for (const q of queues) {
    const key = sourceKey(q.page.source);
    const prev = q.page.reset ? undefined : previous[key];
    const consumedAll = q.idx >= q.page.items.length;
    const lastConsumed = q.idx > 0 ? q.page.items[q.idx - 1]!.uid : null;
    const firstUid = q.page.items[0]?.uid;
    const beforeUid = lastConsumed ?? prev?.beforeUid ?? (firstUid !== undefined ? firstUid + 1 : Number.MAX_SAFE_INTEGER);
    const done = consumedAll && q.page.exhausted;
    cursor[key] = { uidValidity: q.page.uidValidity, beforeUid, done };
    if (!done) more = true;
  }
  return { picked, cursor, more };
}

/**
 * IMAP SEARCH criteria for a filtered listing, in order of preference. Each source (folder) of a
 * listing gets its own set, scoped below its cursor so paging stays exact; unread-only adds
 * UNSEEN to every attempt. The text query prefers subject/sender/recipients/body; some servers
 * reject parts of that (e.g. FROM/TO with spaces), which fails the whole command, so it falls
 * back to the standard TEXT search (headers + body), then to SUBJECT alone.
 */
export function searchAttempts(filter: ListFilter, cursor?: Pick<AccountCursor, 'beforeUid'>): SearchObject[] {
  const scope: SearchObject = {};
  if (cursor) scope.uid = `1:${cursor.beforeUid - 1}`;
  if (filter.unread) scope.seen = false;
  const q = filter.text;
  if (!q) return [Object.keys(scope).length ? scope : { all: true }];
  return [
    { ...scope, or: [{ subject: q }, { from: q }, { to: q }, { body: q }] },
    { ...scope, text: q },
    { ...scope, subject: q },
  ];
}

/** Run the first search attempt the server accepts. */
export async function searchWithFallback(client: ImapFlow, attempts: SearchObject[]): Promise<number[]> {
  for (const criteria of attempts) {
    const res = await client.search(criteria, { uid: true }).catch(() => false as const);
    if (Array.isArray(res)) return res;
  }
  return [];
}

/** The mail cache (see cache/store.ts), when it is switched on. */
export interface MailCacheDeps {
  cache: MailCache;
  sync: CacheSync;
  /** Largest message whose content is kept, and how much content one account may keep. */
  maxBodyBytes: number;
  bodyBytesPerAccount: number;
}

export class MailService {
  private readonly relatedIndex = new RelatedIndex();

  constructor(
    private readonly pool: ImapPool,
    private readonly cached: MailCacheDeps | null = null,
  ) {}

  // ---- cache -----------------------------------------------------------------

  /**
   * Run `fn` against the cache. Any problem with it is handled (see CacheSync.handleError) and
   * `fallback` returned instead, so a broken cache only ever means going to the IMAP server.
   */
  private fromCache<T>(userId: string, accountId: string, folder: string, fallback: T, fn: (c: MailCacheDeps) => T): T {
    if (!this.cached) return fallback;
    try {
      return fn(this.cached);
    } catch (err) {
      this.cached.sync.handleError(err, userId, accountId, folder);
      if (err instanceof CacheCorruptError) this.cached.sync.syncSoon(userId, accountId, folder);
      return fallback;
    }
  }

  /** The cached copy of a folder, if it is cached, filled and for this UIDVALIDITY (if given). */
  private cachedFolder(userId: string, accountId: string, folder: string, uidValidity?: string): CachedFolder | null {
    return this.fromCache(userId, accountId, folder, null, ({ sync }) => {
      const f = sync.ready(userId, accountId, folder);
      return f && (uidValidity === undefined || f.uidValidity === uidValidity) ? f : null;
    });
  }

  /** Keep the cache of INBOX and Sent of an account up to date (called when its INBOX is watched). */
  syncAccount(userId: string, accountId: string) {
    this.fromCache(userId, accountId, 'INBOX', undefined, ({ sync }) => sync.syncAccount(userId, accountId));
  }

  /** Something changed in a folder: if it is cached, sync it soon. */
  folderChanged(userId: string, accountId: string, folder: string) {
    this.fromCache(userId, accountId, folder, undefined, ({ sync }) => sync.syncSoon(userId, accountId, folder));
  }

  /** Apply a change we just made on the IMAP server to the cached copy of the folder, if there is one. */
  private updateCache(userId: string, accountId: string, folder: string, uidValidity: string, fn: (cache: MailCache, f: CachedFolder) => void) {
    const f = this.cachedFolder(userId, accountId, folder, uidValidity);
    if (f) this.fromCache(userId, accountId, folder, undefined, ({ cache }) => fn(cache, f));
  }

  /** Forget everything cached for an account (deleted, or now pointing at another mailbox). */
  forgetAccount(userId: string, accountId: string) {
    this.fromCache(userId, accountId, 'INBOX', undefined, ({ cache }) => cache.dropAccount(userId, accountId));
  }

  // ---- folders -------------------------------------------------------------

  private static specialUse(f: ListResponse): SpecialUse | null {
    if (f.path.toUpperCase() === 'INBOX') return 'inbox';
    const su = f.specialUse ? SPECIAL_USE[f.specialUse] : undefined;
    if (su) return su;
    for (const [use, re] of Object.entries(NAME_FALLBACKS)) if (re!.test(f.name)) return use as SpecialUse;
    return null;
  }

  async listFolders(userId: string, accountId: string): Promise<AccountFolders> {
    try {
      const list = await this.pool.folders(userId, accountId, true);
      const folders: FolderView[] = list.map((f) => ({
        path: f.path,
        name: f.name,
        delimiter: f.delimiter,
        parentPath: f.parentPath,
        specialUse: MailService.specialUse(f),
        selectable: !f.flags.has('\\Noselect') && !f.flags.has('\\NonExistent'),
        unread: f.status?.unseen ?? null,
        total: f.status?.messages ?? null,
      }));
      return { accountId, folders };
    } catch (err) {
      return { accountId, folders: [], error: describeError(err, 'IMAP').message };
    }
  }

  /** Find a special-use folder, preferring server-declared SPECIAL-USE over name matches. */
  async specialFolder(userId: string, accountId: string, use: SpecialUse): Promise<string | null> {
    const list = await this.pool.folders(userId, accountId);
    const declared = list.find((f) => f.specialUse && SPECIAL_USE[f.specialUse] === use);
    if (declared) return declared.path;
    const byName = list.find((f) => MailService.specialUse(f) === use && !f.flags.has('\\Noselect'));
    return byName?.path ?? null;
  }

  // ---- listing -------------------------------------------------------------

  private async fetchSourcePage(
    userId: string,
    source: ListSource,
    cursor: AccountCursor | undefined,
    limit: number,
    filter: ListFilter,
  ): Promise<SourcePage> {
    return this.pool.withMailbox(userId, source.accountId, source.folder, async (client, selected) => {
      // The pooled connection may have had this folder selected for a while. Not every server
      // pushes EXISTS for mail delivered meanwhile; a NOOP makes it report new messages, so the
      // listing (which counts from EXISTS) never misses the newest mail.
      await client.noop();
      const mailbox = (client.mailbox || selected) as typeof selected;
      const uidValidity = mailbox.uidValidity.toString();
      let reset = false;
      if (cursor && cursor.uidValidity !== uidValidity) {
        reset = true;
        cursor = undefined;
      }
      const empty: SourcePage = { source, uidValidity, items: [], exhausted: true, reset };
      if (cursor?.done || mailbox.exists === 0) return empty;
      if (cursor && cursor.beforeUid <= 1) return empty;

      let range: string;
      let useUid: boolean;
      let exhausted: boolean;
      if (isFiltered(filter)) {
        const uids = (await searchWithFallback(client, searchAttempts(filter, cursor))).sort((a, b) => a - b);
        const page = uids.slice(-limit);
        if (page.length === 0) return empty;
        range = page.join(',');
        useUid = true;
        exhausted = uids.length <= limit;
      } else {
        let top = mailbox.exists;
        if (cursor && cursor.beforeUid < mailbox.uidNext) {
          // Find the sequence number just below the cursor UID.
          const exact = (await client.search({ uid: String(cursor.beforeUid) }, { uid: false })) || [];
          if (exact.length) top = exact[0]! - 1;
          else {
            const below = (await client.search({ uid: `1:${cursor.beforeUid - 1}` }, { uid: false })) || [];
            top = below.length ? Math.max(...below) : 0;
          }
        }
        if (top < 1) return empty;
        const start = Math.max(1, top - limit + 1);
        range = `${start}:${top}`;
        useUid = false;
        exhausted = start === 1;
      }

      const msgs = await client.fetchAll(range, LIST_FETCH, { uid: useUid });
      const items = msgs
        .filter((m) => !cursor || m.uid < cursor.beforeUid)
        .sort((a, b) => b.uid - a.uid)
        .map((msg) => fetchedItem(source, uidValidity, msg));
      return { source, uidValidity, items, exhausted, reset };
    });
  }

  /**
   * A page of `source` from the cache, or null if the cache can't answer it: the folder isn't
   * cached (or not filled yet), there is a text search (always done by the IMAP server), or the
   * page reaches below the oldest cached message. Also makes a background sync check for news.
   */
  private cachedSourcePage(userId: string, source: ListSource, cursor: AccountCursor | undefined, limit: number, filter: ListFilter): SourcePage | null {
    if (!this.cached || filter.text) return null;
    const { accountId, folder } = source;
    return this.fromCache(userId, accountId, folder, null, ({ cache, sync }) => {
      const f = sync.ready(userId, accountId, folder);
      if (!f) {
        // Not cached yet: start filling it if it is INBOX or Sent (the IMAP server answers meanwhile).
        if (folder === 'INBOX' || cache.folder(userId, accountId, folder)) sync.syncAccount(userId, accountId);
        return null;
      }
      let reset = false;
      if (cursor && cursor.uidValidity !== f.uidValidity) {
        reset = true;
        cursor = undefined;
      }
      const empty: SourcePage = { source, uidValidity: f.uidValidity, items: [], exhausted: true, reset };
      if (cursor?.done) return empty;
      const rows = cache.page(f, cursor?.beforeUid ?? null, limit, filter.unread);
      if (rows.length < limit && !f.complete) return null;
      return { source, uidValidity: f.uidValidity, items: rows.map((m) => cachedItem(source, f.uidValidity, m)), exhausted: rows.length < limit, reset };
    });
  }

  /**
   * Messages in `source` that match any of `terms` (see related.ts). Header searches can be slow
   * on big folders, so the RelatedIndex remembers results and later only searches new mail.
   */
  private async findByTerms(userId: string, source: ListSource, terms: LookupTerm[]): Promise<FetchedItem[]> {
    return this.pool.withMailbox(userId, source.accountId, source.folder, async (client, selected) => {
      await client.noop();
      const mailbox = (client.mailbox || selected) as typeof selected;
      if (mailbox.exists === 0) return [];
      const uidValidity = mailbox.uidValidity.toString();
      const uidNext = Number(mailbox.uidNext);
      const key = `${userId}\u0000${sourceKey(source)}`;
      const { searches, known } = this.relatedIndex.plan(key, uidValidity, uidNext, terms);
      const candidates = new Set(known);
      const searched = new Set<string>();
      for (const s of searches) {
        const res = await client.search(searchFor(s.terms, s.fromUid), { uid: true }).catch(() => false as const);
        if (!Array.isArray(res)) continue;
        // "n:*" includes the highest UID even when it is below n.
        for (const uid of res) if (uid >= s.fromUid) candidates.add(uid);
        for (const t of s.terms) searched.add(termKey(t));
      }
      const uids = [...candidates].sort((a, b) => b - a).slice(0, MAX_RELATED);
      const msgs = uids.length ? await client.fetchAll(uids.join(','), LIST_FETCH, { uid: true }) : [];
      const found = msgs.map((msg) => fetchedItem(source, uidValidity, msg));
      this.relatedIndex.record(key, uidValidity, uidNext, terms, searched, found);
      return found.filter((f) => terms.some((t) => matchesTerm(t, f.headers)));
    });
  }

  /**
   * The rest of the listed messages' conversations: your replies in the account's Sent folder
   * (wherever they were sent from) and older messages in the listed folder. Best effort: the
   * listing never fails because of this. Drafts are not threaded.
   */
  private async relatedItems(userId: string, picked: FetchedItem[]): Promise<FetchedItem[]> {
    const bySource = new Map<string, FetchedItem[]>();
    for (const it of picked) {
      const k = sourceKey(it.source);
      bySource.set(k, [...(bySource.get(k) ?? []), it]);
    }
    const listed = new Set(picked.map((it) => `${sourceKey(it.source)}\u0000${it.uid}`));
    const out = new Map<string, FetchedItem>();
    await Promise.all(
      [...bySource.values()].map(async (group) => {
        const { accountId, folder } = group[0]!.source;
        try {
          const terms = new Map<string, LookupTerm>();
          for (const it of group) for (const t of lookupTerms(it.headers)) terms.set(termKey(t), t);
          if (terms.size === 0) return;
          // A cached folder is INBOX or Sent, never Drafts, and its account's Sent folder is
          // known without asking the IMAP server.
          const cachedSent = this.cachedFolderList(userId, accountId, folder);
          let lookIn: string[];
          if (cachedSent) lookIn = cachedSent;
          else {
            const [sent, drafts] = await Promise.all([
              this.specialFolder(userId, accountId, 'sent'),
              this.specialFolder(userId, accountId, 'drafts'),
            ]);
            if (folder === drafts) return;
            lookIn = [...new Set([folder, ...(sent ? [sent] : [])])];
          }
          for (const f of lookIn) {
            const source = { accountId, folder: f };
            const items = await this.findRelated(userId, source, [...terms.values()]).catch(() => [] as FetchedItem[]);
            for (const it of items) {
              const k = `${sourceKey(source)}\u0000${it.uid}`;
              if (!listed.has(k)) out.set(k, it);
            }
          }
        } catch {
          /* threading is best-effort */
        }
      }),
    );
    return [...out.values()];
  }

  /**
   * Where the rest of the conversations of a listed cached folder are: the folder and the
   * account's Sent folder, if both are cached. Null if the IMAP server has to be asked.
   */
  private cachedFolderList(userId: string, accountId: string, folder: string): string[] | null {
    return this.fromCache(userId, accountId, folder, null, ({ cache, sync }) => {
      const listed = sync.ready(userId, accountId, folder);
      const sent = cache.folderByRole(userId, accountId, 'sent');
      if (!listed || !sent || sent.syncedAt === 0) return null;
      return [...new Set([folder, sent.path])];
    });
  }

  /**
   * Before listing cached folders: make sure they (and the Sent folder their conversations come
   * from) are up to date, unless they are known to be. See CacheSync.beforeListing.
   */
  private async prepareCached(userId: string, sources: ListSource[], filter: ListFilter, fresh: boolean) {
    if (!this.cached || filter.text) return;
    const { cache, sync } = this.cached;
    await Promise.all(
      sources.map(async ({ accountId, folder }) => {
        try {
          if (!sync.ready(userId, accountId, folder)) return;
          const sent = cache.folderByRole(userId, accountId, 'sent');
          const others = sent && sent.path !== folder ? [sent.path] : [];
          if (!fresh && sync.isCurrent(userId, accountId, folder)) {
            // Nothing tells us about changes in Sent; have a look in the background now and then.
            for (const p of others) sync.refreshIfOlder(userId, accountId, p, SENT_REFRESH_MS);
            return;
          }
          await sync.beforeListing(userId, accountId, [folder, ...others], { force: fresh });
        } catch (err) {
          sync.handleError(err, userId, accountId, folder);
        }
      }),
    );
  }

  /** Messages of a folder matching conversation terms: from the cache if it has the folder, else by IMAP search. */
  private async findRelated(userId: string, source: ListSource, terms: LookupTerm[]): Promise<FetchedItem[]> {
    const fromCache = this.fromCache(userId, source.accountId, source.folder, null, ({ cache, sync }) => {
      const f = sync.ready(userId, source.accountId, source.folder);
      return f ? cache.related(f, terms, MAX_RELATED).map((m) => cachedItem(source, f.uidValidity, m)) : null;
    });
    return fromCache ?? this.findByTerms(userId, source, terms);
  }

  /** Snippets of messages fetched from the IMAP server (cached ones already have theirs). */
  private async snippets(userId: string, items: FetchedItem[]): Promise<Map<FetchedItem, string>> {
    const out = new Map<FetchedItem, string>();
    const bySource = new Map<string, FetchedItem[]>();
    for (const it of items) {
      if (!it.msg) continue;
      const k = sourceKey(it.source);
      bySource.set(k, [...(bySource.get(k) ?? []), it]);
    }
    await Promise.all(
      [...bySource.values()].map(async (group) => {
        const { accountId, folder } = group[0]!.source;
        try {
          const byUid = new Map(group.map((it) => [it.uid, it]));
          const snippets = await this.pool.withMailbox(userId, accountId, folder, (client) => fetchSnippets(client, group.map((it) => it.msg!)));
          for (const [uid, snippet] of snippets) out.set(byUid.get(uid)!, snippet);
        } catch {
          /* snippets are best-effort */
        }
      }),
    );
    return out;
  }

  private toSummary(it: FetchedItem, snippet: string): MessageSummary {
    return it.summary ? { ...it.summary } : summaryOf(it.source, it.uidValidity, it.msg!, snippet);
  }

  /**
   * List the newest messages across one or more mailboxes (a single folder, or every account's
   * INBOX for the unified view), merged by date with per-source cursors. The rest of their
   * conversations comes along in `related` (see relatedItems).
   */
  async listMessages(
    userId: string,
    sources: ListSource[],
    rawCursor: string | null,
    limit: number,
    filter: ListFilter = NO_FILTER,
    /** fresh: the user asked to refresh, so cached folders are checked with the server first (see prepareCached). */
    opts: { fresh?: boolean } = {},
  ): Promise<MessageListResponse> {
    const previous = decodeCursor(rawCursor);
    const errors: MessageListResponse['errors'] = [];
    await this.prepareCached(userId, sources, filter, !!opts.fresh);
    const pages = (
      await Promise.all(
        sources.map(async (s) => {
          try {
            return this.cachedSourcePage(userId, s, previous[sourceKey(s)], limit, filter) ?? (await this.fetchSourcePage(userId, s, previous[sourceKey(s)], limit, filter));
          } catch (err) {
            errors.push({ accountId: s.accountId, error: describeError(err, 'IMAP').message });
            return null;
          }
        }),
      )
    ).filter((p): p is SourcePage => p !== null);

    const reset = pages.some((p) => p.reset) && rawCursor !== null;
    const { picked, cursor, more } = mergePages(pages, limit, previous);
    // Sources that failed keep their previous cursor so a later page can retry them.
    for (const s of sources) {
      const k = sourceKey(s);
      if (!cursor[k] && previous[k]) cursor[k] = previous[k];
    }
    const related = await this.relatedItems(userId, picked);
    const snippets = await this.snippets(userId, [...picked, ...related]);
    return {
      messages: picked.map((it) => this.toSummary(it, snippets.get(it) ?? '')),
      related: related.map((it) => this.toSummary(it, snippets.get(it) ?? '')),
      cursor: more ? encodeCursor(cursor) : null,
      errors,
      reset,
    };
  }

  // ---- single message ------------------------------------------------------

  private checkValidity(mailbox: { uidValidity: bigint }, ref: MessageRef) {
    if (mailbox.uidValidity.toString() !== ref.uidValidity) {
      throw new StaleError('The folder changed on the server (UIDVALIDITY). Reload the message list.');
    }
  }

  /** Throws StaleError if the folder's UIDVALIDITY no longer matches. */
  async assertUidValidity(userId: string, ref: Omit<MessageRef, 'uid'>) {
    await this.pool.withMailbox(userId, ref.accountId, ref.folder, async (_client, mailbox) => this.checkValidity(mailbox, { ...ref, uid: 0 }));
  }

  async fetchRaw(
    userId: string,
    ref: MessageRef,
    maxBytes: number,
  ): Promise<{ raw: Buffer; flags: Set<string>; internalDate: Date | null }> {
    const f = this.cachedFolder(userId, ref.accountId, ref.folder, ref.uidValidity);
    if (f) {
      const hit = this.fromCache(userId, ref.accountId, ref.folder, null, ({ cache }) => {
        const m = cache.message(f, ref.uid);
        const raw = m && cache.body(f, ref.uid);
        return m && raw ? { raw, flags: imapFlags(m.summary), internalDate: toDate(m.internalDate ?? undefined) } : null;
      });
      if (hit) return hit;
    }
    const res = await this.fetchRawLive(userId, ref, maxBytes);
    if (f && this.cached && res.raw.length <= this.cached.maxBodyBytes && this.cached.bodyBytesPerAccount > 0) {
      const { bodyBytesPerAccount } = this.cached;
      this.fromCache(userId, ref.accountId, ref.folder, undefined, ({ cache }) => {
        cache.putBody(f, ref.uid, res.raw);
        cache.enforceBodyBudget(userId, ref.accountId, bodyBytesPerAccount);
      });
    }
    return res;
  }

  private async fetchRawLive(userId: string, ref: MessageRef, maxBytes: number): Promise<{ raw: Buffer; flags: Set<string>; internalDate: Date | null }> {
    return this.pool.withMailbox(userId, ref.accountId, ref.folder, async (client, mailbox) => {
      this.checkValidity(mailbox, ref);
      const meta = await client.fetchOne(String(ref.uid), { uid: true, flags: true, internalDate: true, size: true }, { uid: true });
      if (!meta) throw new MessageGoneError('Message not found');
      if ((meta.size ?? 0) > maxBytes) {
        throw new MailServerError(`Message is too large to display (${Math.round((meta.size ?? 0) / 1048576)} MB)`, 'protocol');
      }
      // `source` is fetched with BODY.PEEK, so reading never sets \Seen implicitly.
      const full = await client.fetchOne(String(ref.uid), { uid: true, source: true }, { uid: true });
      if (!full || !full.source) throw new MessageGoneError('Message not found');
      return { raw: full.source, flags: meta.flags ?? new Set(), internalDate: toDate(meta.internalDate) };
    });
  }

  async getMessage(
    userId: string,
    ref: MessageRef,
    opts: {
      /** true = load remote images, false = keep them blocked, undefined = per the sender-domain allowlist. */
      allowRemote: boolean | undefined;
      imageDomains?: readonly string[];
      maxBytes: number;
      imageCache?: RemoteImageCache;
      fetchImage?: InlineOptions['fetchImage'];
    },
  ): Promise<MessageDetail> {
    const { raw, flags, internalDate } = await this.fetchRaw(userId, ref, opts.maxBytes);
    const email = await parseRaw(raw);
    const decision = decideRemoteImages(email, opts.allowRemote, opts.imageDomains ?? []);
    // Remote images are fetched here and inlined as data: URIs; the browser never fetches them.
    let inlined = new Map<string, string | null>();
    if (decision.load && email.html) {
      inlined = await inlineRemoteImages(collectRemoteImageUrls(email.html), {
        userId,
        cache: opts.imageCache,
        fetchImage: opts.fetchImage,
      });
    }
    return buildMessageDetail(
      email,
      { ...ref, flags, internalDate },
      {
        allowRemote: decision.load,
        resolveRemote: (u) => inlined.get(u) ?? null,
        allowlist: {
          senderDomain: decision.senderDomain ? displayDomain(decision.senderDomain) : null,
          allowedBy: decision.allowedBy ? displayDomain(decision.allowedBy) : null,
          skipped: decision.skipped,
        },
      },
    );
  }

  async getParsed(userId: string, ref: MessageRef, maxBytes: number): Promise<ParsedEmail> {
    const { raw } = await this.fetchRaw(userId, ref, maxBytes);
    return parseRaw(raw);
  }

  async getAttachment(userId: string, ref: MessageRef, index: number, maxBytes: number) {
    const email = await this.getParsed(userId, ref, maxBytes);
    const att = email.attachments[index];
    if (!att) throw new MessageGoneError('Attachment not found');
    return {
      filename: att.filename || `attachment-${index + 1}`,
      mimeType: att.mimeType || 'application/octet-stream',
      content: attachmentBytes(att),
    };
  }

  // ---- actions ---------------------------------------------------------------

  /**
   * Find a special-use folder, creating one (inside the personal namespace) if the account has
   * none. Creating it is the least surprising fallback: "archive" and "snooze" keep working like
   * in other clients.
   */
  async ensureFolder(userId: string, accountId: string, use: 'archive' | 'snoozed'): Promise<{ path: string; created: boolean }> {
    const existing = await this.specialFolder(userId, accountId, use);
    if (existing) return { path: existing, created: false };
    const name = use === 'archive' ? 'Archive' : 'Snoozed';
    try {
      const res = await this.pool.withClient(userId, accountId, async (client) => {
        const created = await client.mailboxCreate([name]);
        await client.mailboxSubscribe(created.path).catch(() => undefined);
        return created;
      });
      await this.pool.folders(userId, accountId, true);
      return { path: res.path, created: true };
    } catch (err) {
      const e = err as { responseText?: string; message?: string };
      throw new MailServerError(`This account has no ${name} folder and one could not be created: ${e.responseText || e.message}`, 'protocol');
    }
  }

  /**
   * Put a message back into INBOX as if it had just arrived (the end of a snooze): it is appended
   * with the current time as its arrival date, so it sorts to the top, and removed from `ref`'s
   * folder. Flags are kept, except \Seen when `markUnread`. Messages too large to download are
   * moved instead (keeping their old date). `beforeAppend` runs first with the Message-ID, so the
   * new-mail watcher can tell this message from real new mail.
   *
   * Returns null if the message is no longer there.
   */
  async resurface(
    userId: string,
    ref: MessageRef,
    opts: { markUnread: boolean; maxBytes: number; beforeAppend?: (messageId: string | null) => void },
  ): Promise<{ uid: number | null; uidValidity: string | null; messageId: string | null; from: Address | null; subject: string } | null> {
    const moved = await this.pool.withMailbox(userId, ref.accountId, ref.folder, async (client, mailbox) => {
      if (mailbox.uidValidity.toString() !== ref.uidValidity) return null;
      const uid = String(ref.uid);
      const meta = await client.fetchOne(uid, { uid: true, flags: true, envelope: true, size: true }, { uid: true });
      if (!meta) return null;
      const messageId = meta.envelope?.messageId ?? null;
      const info = { messageId, from: addresses(meta.envelope?.from)[0] ?? null, subject: meta.envelope?.subject ?? '' };
      opts.beforeAppend?.(messageId);
      const drop = new Set(['\\Deleted', '\\Recent', ...(opts.markUnread ? ['\\Seen'] : [])]);
      const flags = [...(meta.flags ?? [])].filter((f) => !drop.has(f));
      if ((meta.size ?? 0) <= opts.maxBytes) {
        const full = await client.fetchOne(uid, { uid: true, source: true }, { uid: true });
        if (!full || !full.source) return null;
        const res = await client.append('INBOX', full.source, flags, new Date());
        if (!res) throw new MailServerError('Could not put the message back into the inbox', 'protocol');
        await client.messageDelete(uid, { uid: true });
        return { ...info, uid: res.uid ?? null, uidValidity: res.uidValidity?.toString() ?? null };
      }
      if (opts.markUnread) await client.messageFlagsRemove(uid, ['\\Seen'], { uid: true });
      const res = await client.messageMove(uid, 'INBOX', { uid: true });
      return { ...info, uid: (res ? res.uidMap?.get(ref.uid) : undefined) ?? null, uidValidity: (res ? res.uidValidity?.toString() : undefined) ?? null };
    });
    if (moved) {
      this.updateCache(userId, ref.accountId, ref.folder, ref.uidValidity, (cache, f) => cache.removeMessages(f, [ref.uid]));
      this.folderChanged(userId, ref.accountId, 'INBOX');
    }
    if (!moved || (moved.uid && moved.uidValidity) || !moved.messageId) return moved;
    // No UIDPLUS: find the message in INBOX by Message-ID.
    const id = moved.messageId;
    return this.pool.withMailbox(userId, ref.accountId, 'INBOX', async (client, mailbox) => {
      const hits = (await client.search({ header: { 'message-id': id } }, { uid: true })) || [];
      return { ...moved, uid: hits.length ? Math.max(...hits) : null, uidValidity: mailbox.uidValidity.toString() };
    });
  }

  /**
   * Apply an action to messages that all live in the same account and folder. For moves (move,
   * archive, delete-to-Trash) the result describes where the messages went, so the client can
   * undo the action by moving them back.
   */
  async applyAction(
    userId: string,
    accountId: string,
    folder: string,
    uidValidity: string,
    uids: number[],
    action: MessageAction,
  ): Promise<{ undo: UndoInfo | null; permanent: boolean; createdFolder: string | null }> {
    const none = { undo: null, permanent: false, createdFolder: null };
    if (action.type === 'snooze' || action.type === 'unsnooze') throw new Error('Snoozing is handled by SnoozeService');
    if (uids.length === 0) return none;
    const range = uids.join(',');
    const ref = { accountId, folder, uid: 0, uidValidity };

    let destination: string | null = null;
    let expunge = false;
    let createdFolder: string | null = null;
    if (action.type === 'move') destination = action.destination;
    if (action.type === 'archive') {
      const archive = await this.ensureFolder(userId, accountId, 'archive');
      destination = archive.path;
      if (archive.created) createdFolder = archive.path;
    }
    if (action.type === 'delete') {
      const trash = await this.specialFolder(userId, accountId, 'trash');
      // Only messages already in Trash are permanently removed; everything else moves to Trash.
      if (trash && trash !== folder) destination = trash;
      else if (trash === folder) expunge = true;
      else throw new MailServerError('This account has no Trash folder', 'protocol');
    }
    if (destination === folder) return none;

    const moved = await this.pool.withMailbox(userId, accountId, folder, async (client: ImapFlow, mailbox) => {
      this.checkValidity(mailbox, ref);
      switch (action.type) {
        case 'seen':
          await (action.value ? client.messageFlagsAdd(range, ['\\Seen'], { uid: true }) : client.messageFlagsRemove(range, ['\\Seen'], { uid: true }));
          return null;
        case 'flagged':
          await (action.value ? client.messageFlagsAdd(range, ['\\Flagged'], { uid: true }) : client.messageFlagsRemove(range, ['\\Flagged'], { uid: true }));
          return null;
        default: {
          if (expunge) {
            await client.messageDelete(range, { uid: true });
            return null;
          }
          if (!destination) return null;
          // Remember Message-IDs in case the server can't tell us the new UIDs (no UIDPLUS).
          const ids = (await client.fetchAll(range, { uid: true, envelope: true }, { uid: true }))
            .map((m) => m.envelope?.messageId)
            .filter((id): id is string => !!id);
          const res = await client.messageMove(range, destination, { uid: true });
          return { res, ids };
        }
      }
    });

    if (action.type === 'seen' || action.type === 'flagged') {
      this.updateCache(userId, accountId, folder, uidValidity, (cache, f) => cache.changeFlag(f, uids, action.type as 'seen' | 'flagged', action.value));
    } else {
      this.updateCache(userId, accountId, folder, uidValidity, (cache, f) => cache.removeMessages(f, uids));
      if (destination) this.folderChanged(userId, accountId, destination);
    }
    if (expunge) return { ...none, permanent: true };
    if (!moved || !destination) return { ...none, createdFolder };
    let newUids = moved.res && moved.res.uidMap ? [...moved.res.uidMap.values()] : [];
    let destValidity = moved.res && moved.res.uidValidity ? moved.res.uidValidity.toString() : null;
    if (!newUids.length || !destValidity) {
      // No UIDPLUS: locate the moved messages by Message-ID.
      const found = await this.pool.withMailbox(userId, accountId, destination, async (client, mailbox) => {
        const out: number[] = [];
        for (const id of moved.ids) {
          const hits = (await client.search({ header: { 'message-id': id } }, { uid: true })) || [];
          if (hits.length) out.push(Math.max(...hits));
        }
        return { uids: out, uidValidity: mailbox.uidValidity.toString() };
      });
      newUids = found.uids;
      destValidity = found.uidValidity;
    }
    const undo: UndoInfo | null = newUids.length
      ? { accountId, folder: destination, uidValidity: destValidity, uids: newUids, restoreTo: folder }
      : null;
    return { undo, permanent: false, createdFolder };
  }

  /** Mark the message a reply/forward refers to as \Answered (best effort). */
  async markAnswered(userId: string, ref: MessageRef) {
    try {
      await this.pool.withMailbox(userId, ref.accountId, ref.folder, async (client, mailbox) => {
        if (mailbox.uidValidity.toString() !== ref.uidValidity) return;
        await client.messageFlagsAdd(String(ref.uid), ['\\Answered'], { uid: true });
      });
      this.updateCache(userId, ref.accountId, ref.folder, ref.uidValidity, (cache, f) => cache.changeFlag(f, [ref.uid], 'answered', true));
    } catch {
      /* not critical */
    }
  }

  async append(userId: string, accountId: string, folder: string, raw: Buffer, flags: string[]) {
    const res = await this.pool.withClient(userId, accountId, (client) => client.append(folder, raw, flags));
    this.folderChanged(userId, accountId, folder);
    return res;
  }

  async deleteDraft(userId: string, ref: MessageRef) {
    await this.pool.withMailbox(userId, ref.accountId, ref.folder, async (client, mailbox) => {
      if (mailbox.uidValidity.toString() !== ref.uidValidity) return;
      await client.messageDelete(String(ref.uid), { uid: true });
    });
    this.updateCache(userId, ref.accountId, ref.folder, ref.uidValidity, (cache, f) => cache.removeMessages(f, [ref.uid]));
  }
}
