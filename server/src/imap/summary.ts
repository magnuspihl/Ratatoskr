import type { FetchMessageObject, FetchQueryObject, ImapFlow, MessageAddressObject } from 'imapflow';
import type { Address, MessageSummary } from '../../../shared/types.js';
import { firstMessageId, type ThreadHeaders } from '../../../shared/threads.js';
import { parseReferences } from '../mail/parse.js';
import { findTextPart, hasAttachments, SNIPPET_FETCH_BYTES, snippetFromPart, type TextPart } from './snippet.js';

// Turning fetched IMAP messages into list entries, shared by live listings and the mail cache.

/** What a message list needs of each message. */
export const LIST_FETCH: FetchQueryObject = { uid: true, flags: true, envelope: true, bodyStructure: true, internalDate: true, size: true, headers: ['references', 'in-reply-to'] };

/** References kept per message: the root and the most recent ancestors are what threading needs. */
const MAX_REFERENCES = 30;

/** Message-ID, In-Reply-To and References of a message fetched with LIST_FETCH. */
export function threadHeaders(msg: Pick<FetchMessageObject, 'envelope' | 'headers'>): ThreadHeaders {
  // Read from the headers: not every server puts In-Reply-To in the ENVELOPE.
  const raw = msg.headers?.toString('latin1').replace(/\r?\n[ \t]+/g, ' ') ?? '';
  let references = parseReferences(raw.match(/^references:(.*)$/im)?.[1]);
  if (references.length > MAX_REFERENCES) references = [references[0]!, ...references.slice(-(MAX_REFERENCES - 1))];
  return {
    messageId: firstMessageId(msg.envelope?.messageId) ?? msg.envelope?.messageId ?? null,
    inReplyTo: firstMessageId(raw.match(/^in-reply-to:(.*)$/im)?.[1]) ?? firstMessageId(msg.envelope?.inReplyTo),
    references,
  };
}

export function toDate(d: Date | string | undefined): Date | null {
  if (!d) return null;
  const date = d instanceof Date ? d : new Date(d);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function addresses(list: MessageAddressObject[] | undefined): Address[] {
  return (list ?? []).filter((a) => a.address).map((a) => ({ name: a.name ?? '', address: a.address! }));
}

/** Where a message sorts in a merged listing: its arrival time. */
export function sortTime(msg: Pick<FetchMessageObject, 'internalDate' | 'envelope'>): number {
  return (toDate(msg.internalDate) ?? toDate(msg.envelope?.date) ?? new Date(0)).getTime();
}

export function summaryOf(source: { accountId: string; folder: string }, uidValidity: string, msg: FetchMessageObject, snippet: string): MessageSummary {
  const env = msg.envelope ?? {};
  const flags = msg.flags ?? new Set<string>();
  const date = toDate(env.date) ?? toDate(msg.internalDate) ?? new Date(0);
  return {
    accountId: source.accountId,
    folder: source.folder,
    uid: msg.uid,
    uidValidity,
    ...threadHeaders(msg),
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
 * Preview snippets for messages of the currently selected mailbox, fetched with LIST_FETCH: the
 * first bytes of each one's text part, one FETCH per kind of part. Keyed by UID.
 */
export async function fetchSnippets(client: ImapFlow, msgs: FetchMessageObject[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const byPart = new Map<string, { part: TextPart; uids: number[] }>();
  for (const m of msgs) {
    const part = findTextPart(m.bodyStructure);
    if (!part) continue;
    const k = `${part.part}|${part.type}|${part.encoding}|${part.charset}`;
    const e = byPart.get(k) ?? { part, uids: [] };
    e.uids.push(m.uid);
    byPart.set(k, e);
  }
  for (const { part, uids } of byPart.values()) {
    const fetched = await client.fetchAll(
      uids.join(','),
      { uid: true, bodyParts: [{ key: part.part, start: 0, maxLength: SNIPPET_FETCH_BYTES }] },
      { uid: true },
    );
    for (const f of fetched) {
      const buf = f.bodyParts ? [...f.bodyParts.values()][0] : undefined;
      if (buf) out.set(f.uid, snippetFromPart(buf, part, (f.binaryParts?.size ?? 0) > 0));
    }
  }
  return out;
}
