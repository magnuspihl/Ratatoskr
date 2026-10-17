import type { FetchMessageObject, ImapFlow, ListResponse, MessageAddressObject, SearchObject } from 'imapflow';
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
import { decideRemoteImages, displayDomain } from '../mail/imageAllowlist.js';
import { attachmentBytes, buildMessageDetail, parseRaw, type ParsedEmail } from '../mail/parse.js';
import { collectRemoteImageUrls } from '../mail/sanitize.js';
import { inlineRemoteImages, type InlineOptions, type RemoteImageCache } from '../net/remoteImages.js';
import { MailServerError, describeError } from './connect.js';
import type { ImapPool } from './pool.js';
import { findTextPart, hasAttachments, SNIPPET_FETCH_BYTES, snippetFromPart, type TextPart } from './snippet.js';

const SPECIAL_USE: Record<string, SpecialUse> = {
  '\\Inbox': 'inbox',
  '\\Sent': 'sent',
  '\\Drafts': 'drafts',
  '\\Trash': 'trash',
  '\\Archive': 'archive',
  '\\Junk': 'junk',
  '\\All': 'all',
  '\\Flagged': 'flagged',
};

/** Extra name fallbacks on top of ImapFlow's built-in localized name detection. */
const NAME_FALLBACKS: Partial<Record<SpecialUse, RegExp>> = {
  sent: /^(sent|sent items|sent mail|sent messages|gesendet|envoyés|skickat|sendt)$/i,
  drafts: /^(drafts?|entwürfe|brouillons|utkast|kladder)$/i,
  trash: /^(trash|deleted|deleted items|deleted messages|bin|papierkorb|corbeille|papperskorg|papirkurv)$/i,
  archive: /^(archives?|archiv|arkiv)$/i,
  junk: /^(junk|spam|junk e-?mail|bulk mail|skräppost|uønsket)$/i,
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

interface FetchedItem {
  source: ListSource;
  uidValidity: string;
  msg: FetchMessageObject;
  sortTime: number;
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

function addresses(list: MessageAddressObject[] | undefined): Address[] {
  return (list ?? []).filter((a) => a.address).map((a) => ({ name: a.name ?? '', address: a.address! }));
}

function toDate(d: Date | string | undefined): Date | null {
  if (!d) return null;
  const date = d instanceof Date ? d : new Date(d);
  return Number.isNaN(date.getTime()) ? null : date;
}

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
    const lastConsumed = q.idx > 0 ? q.page.items[q.idx - 1]!.msg.uid : null;
    const firstUid = q.page.items[0]?.msg.uid;
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

export class MailService {
  constructor(private readonly pool: ImapPool) {}

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

      const msgs = await client.fetchAll(
        range,
        { uid: true, flags: true, envelope: true, bodyStructure: true, internalDate: true, size: true },
        { uid: useUid },
      );
      const items = msgs
        .filter((m) => !cursor || m.uid < cursor.beforeUid)
        .sort((a, b) => b.uid - a.uid)
        .map((msg) => ({
          source,
          uidValidity,
          msg,
          sortTime: (toDate(msg.internalDate) ?? toDate(msg.envelope?.date) ?? new Date(0)).getTime(),
        }));
      return { source, uidValidity, items, exhausted, reset };
    });
  }

  private async snippets(userId: string, items: FetchedItem[]): Promise<Map<FetchedItem, string>> {
    const out = new Map<FetchedItem, string>();
    const bySource = new Map<string, FetchedItem[]>();
    for (const it of items) {
      const k = sourceKey(it.source);
      bySource.set(k, [...(bySource.get(k) ?? []), it]);
    }
    await Promise.all(
      [...bySource.values()].map(async (group) => {
        const { accountId, folder } = group[0]!.source;
        try {
          await this.pool.withMailbox(userId, accountId, folder, async (client) => {
            const byPart = new Map<string, { part: TextPart; items: FetchedItem[] }>();
            for (const it of group) {
              const part = findTextPart(it.msg.bodyStructure);
              if (!part) continue;
              const k = `${part.part}|${part.type}|${part.encoding}|${part.charset}`;
              const e = byPart.get(k) ?? { part, items: [] };
              e.items.push(it);
              byPart.set(k, e);
            }
            for (const { part, items: partItems } of byPart.values()) {
              const byUid = new Map(partItems.map((i) => [i.msg.uid, i]));
              const fetched = await client.fetchAll(
                partItems.map((i) => i.msg.uid).join(','),
                { uid: true, bodyParts: [{ key: part.part, start: 0, maxLength: SNIPPET_FETCH_BYTES }] },
                { uid: true },
              );
              for (const f of fetched) {
                const it = byUid.get(f.uid);
                const buf = f.bodyParts ? [...f.bodyParts.values()][0] : undefined;
                if (!it || !buf) continue;
                out.set(it, snippetFromPart(buf, part, (f.binaryParts?.size ?? 0) > 0));
              }
            }
          });
        } catch {
          /* snippets are best-effort */
        }
      }),
    );
    return out;
  }

  private toSummary(it: FetchedItem, snippet: string): MessageSummary {
    const { msg } = it;
    const env = msg.envelope ?? {};
    const flags = msg.flags ?? new Set<string>();
    const date = toDate(env.date) ?? toDate(msg.internalDate) ?? new Date(0);
    return {
      accountId: it.source.accountId,
      folder: it.source.folder,
      uid: msg.uid,
      uidValidity: it.uidValidity,
      messageId: env.messageId ?? null,
      subject: env.subject ?? '',
      from: addresses(env.from),
      to: addresses(env.to),
      date: date.toISOString(),
      snippet,
      seen: flags.has('\\Seen'),
      flagged: flags.has('\\Flagged'),
      answered: flags.has('\\Answered'),
      draft: flags.has('\\Draft'),
      hasAttachments: hasAttachments(msg.bodyStructure),
      size: msg.size ?? 0,
    };
  }

  /**
   * List the newest messages across one or more mailboxes (a single folder, or every account's
   * INBOX for the unified view), merged by date with per-source cursors.
   */
  async listMessages(
    userId: string,
    sources: ListSource[],
    rawCursor: string | null,
    limit: number,
    filter: ListFilter = NO_FILTER,
  ): Promise<MessageListResponse> {
    const previous = decodeCursor(rawCursor);
    const errors: MessageListResponse['errors'] = [];
    const pages = (
      await Promise.all(
        sources.map(async (s) => {
          try {
            return await this.fetchSourcePage(userId, s, previous[sourceKey(s)], limit, filter);
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
    const snippets = await this.snippets(userId, picked);
    return {
      messages: picked.map((it) => this.toSummary(it, snippets.get(it) ?? '')),
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

  async fetchRaw(
    userId: string,
    ref: MessageRef,
    maxBytes: number,
  ): Promise<{ raw: Buffer; flags: Set<string>; internalDate: Date | null }> {
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
   * Find the Archive folder, creating one (inside the personal namespace) if the account has none.
   * Creating it is the least surprising fallback: "archive" keeps working like in other clients.
   */
  async ensureArchive(userId: string, accountId: string): Promise<{ path: string; created: boolean }> {
    const existing = await this.specialFolder(userId, accountId, 'archive');
    if (existing) return { path: existing, created: false };
    try {
      const res = await this.pool.withClient(userId, accountId, async (client) => {
        const created = await client.mailboxCreate(['Archive']);
        await client.mailboxSubscribe(created.path).catch(() => undefined);
        return created;
      });
      await this.pool.folders(userId, accountId, true);
      return { path: res.path, created: true };
    } catch (err) {
      const e = err as { responseText?: string; message?: string };
      throw new MailServerError(`This account has no Archive folder and one could not be created: ${e.responseText || e.message}`, 'protocol');
    }
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
    if (uids.length === 0) return none;
    const range = uids.join(',');
    const ref = { accountId, folder, uid: 0, uidValidity };

    let destination: string | null = null;
    let expunge = false;
    let createdFolder: string | null = null;
    if (action.type === 'move') destination = action.destination;
    if (action.type === 'archive') {
      const archive = await this.ensureArchive(userId, accountId);
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
    } catch {
      /* not critical */
    }
  }

  async append(userId: string, accountId: string, folder: string, raw: Buffer, flags: string[]) {
    return this.pool.withClient(userId, accountId, (client) => client.append(folder, raw, flags));
  }

  async deleteDraft(userId: string, ref: MessageRef) {
    await this.pool.withMailbox(userId, ref.accountId, ref.folder, async (client, mailbox) => {
      if (mailbox.uidValidity.toString() !== ref.uidValidity) return;
      await client.messageDelete(String(ref.uid), { uid: true });
    });
  }
}
