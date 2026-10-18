// Conversations (Gmail-style threads): messages that belong together are shown as one row and read
// together. Shared by the server (to find the rest of a conversation) and the web client (to group).

import type { Address, MessageSummary } from './types.js';

/** The headers that tie a message to its conversation. */
export interface ThreadHeaders {
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
}

/** One `<id>` from a Message-ID / In-Reply-To header, or null. */
export function firstMessageId(value: string | null | undefined): string | null {
  return value?.match(/<[^<>\s]+>/)?.[0] ?? null;
}

const SUBJECT_PREFIX = /^\s*(?:(?:re|aw|sv|antw|vs|fwd?|wg|tr|rif|ref)(?:\[\d+\])?\s*:|\[[^\]]{1,40}\])\s*/i;

/** Subject without reply/forward prefixes ("Re:", "Fwd:", "AW:", ...) and mailing-list tags. */
export function baseSubject(subject: string): string {
  let s = subject;
  for (let prev = ''; prev !== s; ) {
    prev = s;
    s = s.replace(SUBJECT_PREFIX, '');
  }
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Every Message-ID that links this message to others: its own, its parent's and its ancestors'. */
export function threadIds(m: ThreadHeaders): string[] {
  const ids = new Set<string>();
  if (m.messageId) ids.add(m.messageId);
  if (m.inReplyTo) ids.add(m.inReplyTo);
  for (const r of m.references) ids.add(r);
  return [...ids];
}

/** A row of the message list: the newest listed message of a conversation, standing for all of it. */
export interface ConversationRow extends MessageSummary {
  /** Every message of the conversation that is known, oldest first (including this one). */
  thread: MessageSummary[];
  /**
   * The messages of the conversation in the listed folder: actions on the row apply to all of
   * them. Messages elsewhere (your replies in Sent) are shown but left alone.
   */
  members: MessageSummary[];
}

const key = (m: MessageSummary) => `${m.accountId}|${m.folder}|${m.uidValidity}|${m.uid}`;
const time = (m: MessageSummary) => new Date(m.date).getTime() || 0;

/**
 * Group a listing into conversations. `listed` is the listing in display order (newest first);
 * `related` are other messages of the same conversations found elsewhere (older ones in this
 * folder, your replies in Sent). Messages are in one conversation when they share a Message-ID
 * (own, In-Reply-To or References) and their subjects match once "Re:" and the like are removed,
 * like Gmail. Conversations never span accounts. Each conversation becomes one row in the
 * position of its newest listed message; related messages without a listed one are dropped.
 *
 * With `group: false` (drafts), every listed message is its own row.
 */
export function groupConversations(listed: MessageSummary[], related: MessageSummary[] = [], opts: { group?: boolean } = {}): ConversationRow[] {
  const all: MessageSummary[] = [];
  const seen = new Set<string>();
  const listedKeys = new Set<string>();
  for (const m of listed) {
    if (seen.has(key(m))) continue;
    seen.add(key(m));
    listedKeys.add(key(m));
    all.push(m);
  }
  if (opts.group === false) return all.map((m) => ({ ...m, thread: [m], members: [m] }));
  for (const m of related) {
    if (seen.has(key(m))) continue;
    seen.add(key(m));
    all.push(m);
  }

  // Union-find over messages, joined through shared Message-IDs with matching subjects.
  const parent = all.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]!]!;
    return i;
  };
  const byId = new Map<string, number>();
  all.forEach((m, i) => {
    const subject = baseSubject(m.subject);
    for (const id of threadIds(m)) {
      const k = `${m.accountId}\u0000${subject}\u0000${id}`;
      const other = byId.get(k);
      if (other === undefined) byId.set(k, i);
      else parent[find(i)] = find(other);
    }
  });

  const groups = new Map<number, MessageSummary[]>();
  all.forEach((m, i) => {
    const root = find(i);
    groups.set(root, [...(groups.get(root) ?? []), m]);
  });

  const rows: ConversationRow[] = [];
  const done = new Set<number>();
  all.forEach((m, i) => {
    // Rows follow the order of the listing: the first listed message of a group is its newest.
    if (!listedKeys.has(key(m))) return;
    const root = find(i);
    if (done.has(root)) return;
    done.add(root);
    const group = groups.get(root)!;
    const head = m;
    const members = group.filter((x) => x.folder === head.folder);
    // The same message can be in two folders (mail to yourself: Sent and Inbox). Show it once.
    const byMessageId = new Map<string, MessageSummary>();
    const thread: MessageSummary[] = [];
    for (const x of [...members, ...group.filter((g) => g.folder !== head.folder)]) {
      if (x.messageId && byMessageId.has(x.messageId)) continue;
      if (x.messageId) byMessageId.set(x.messageId, x);
      thread.push(x);
    }
    thread.sort((a, b) => time(a) - time(b) || a.uid - b.uid);
    rows.push({
      ...head,
      seen: members.every((x) => x.seen),
      flagged: members.some((x) => x.flagged),
      answered: members.some((x) => x.answered),
      hasAttachments: thread.some((x) => x.hasAttachments),
      thread,
      members,
    });
  });
  return rows;
}

/** The row a message belongs to (as its head or any message of its conversation). */
export function rowOf<T extends ConversationRow>(rows: T[], ref: { accountId: string; folder: string; uidValidity: string; uid: number }): T | undefined {
  const k = `${ref.accountId}|${ref.folder}|${ref.uidValidity}|${ref.uid}`;
  return rows.find((r) => key(r) === k) ?? rows.find((r) => r.thread.some((m) => key(m) === k));
}

const firstName = (a: Address) => {
  const name = a.name.trim();
  if (name) return name.split(/\s+/)[0]!.replace(/,$/, '');
  return a.address.split('@')[0]!;
};

/**
 * Who took part, Gmail-style: "Ada Lovelace" for one sender, "Ada, me" for several (first names,
 * in the order they first wrote, at most `max`). `isMe` tells your own addresses apart.
 */
export function participants(thread: MessageSummary[], isMe: (address: string) => boolean, max = 3): string {
  const people: { from: Address; me: boolean }[] = [];
  const seen = new Set<string>();
  for (const m of thread) {
    const from = m.from[0];
    if (!from) continue;
    const me = isMe(from.address);
    const k = me ? '\u0000me' : from.address.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    people.push({ from, me });
  }
  if (people.length === 0) return '';
  if (people.length === 1) return people[0]!.me ? 'me' : people[0]!.from.name || people[0]!.from.address;
  const names = people.map((p) => (p.me ? 'me' : firstName(p.from)));
  return names.length > max ? `${names.slice(0, max - 1).join(', ')} … ${names.at(-1)}` : names.join(', ');
}
