import type { SearchObject } from 'imapflow';
import type { ThreadHeaders } from '../../../shared/threads.js';

/**
 * Finding the rest of a conversation on the server: your replies in Sent (also those sent from
 * another mail client) and older messages in the listed folder. IMAP has no portable way to ask
 * for a thread across folders, so this searches headers for the conversation's Message-IDs.
 */

export type LookupField = 'references' | 'in-reply-to' | 'message-id';

export interface LookupTerm {
  field: LookupField;
  id: string;
}

export const termKey = (t: LookupTerm) => `${t.field} ${t.id}`;

/** IDs longer than this are not searched for (they make long commands and are likely bogus). */
const MAX_ID_LENGTH = 250;

/**
 * Header searches that find the rest of a message's conversation in another folder: replies to
 * its conversation keep the first message's ID (the root) in References; the root and the parent
 * are found by Message-ID; and replies from clients that only set In-Reply-To are found by that.
 */
export function lookupTerms(m: ThreadHeaders): LookupTerm[] {
  const root = m.references[0] ?? m.inReplyTo ?? m.messageId;
  const terms: LookupTerm[] = [];
  if (root) terms.push({ field: 'references', id: root }, { field: 'message-id', id: root });
  if (m.messageId) terms.push({ field: 'in-reply-to', id: m.messageId });
  if (m.inReplyTo && m.inReplyTo !== root) terms.push({ field: 'message-id', id: m.inReplyTo });
  return terms.filter((t) => t.id.length <= MAX_ID_LENGTH && /^<[\x21-\x7e]+>$/.test(t.id));
}

/** Whether a message really matches a term (IMAP header search is only a substring match). */
export function matchesTerm(t: LookupTerm, m: ThreadHeaders): boolean {
  if (t.field === 'message-id') return m.messageId === t.id;
  if (t.field === 'in-reply-to') return m.inReplyTo === t.id;
  return m.references.includes(t.id);
}

/** Searches per IMAP command: keeps commands short enough for every server. */
export const TERMS_PER_SEARCH = 20;

/** SEARCH criteria for a batch of terms among UIDs from `fromUid` up. */
export function searchFor(terms: LookupTerm[], fromUid: number): SearchObject {
  const header = (t: LookupTerm): SearchObject => ({ header: { [t.field]: t.id } });
  const scope: SearchObject = fromUid > 1 ? { uid: `${fromUid}:*` } : {};
  if (terms.length === 1) return { ...scope, ...header(terms[0]!) };
  return { ...scope, or: terms.map(header) };
}

interface TermEntry {
  /** UIDs below this were searched. */
  upTo: number;
  uids: number[];
}

interface FolderIndex {
  uidValidity: string;
  terms: Map<string, TermEntry>;
}

const MAX_TERMS_PER_FOLDER = 3000;
const MAX_FOLDERS = 300;

/**
 * Remembers which UIDs matched each term, per folder. New mail only ever gets higher UIDs, so a
 * term once searched only needs the UIDs that arrived since: a list refresh doesn't search the
 * whole Sent folder again. Expunged UIDs drop out when they are no longer found.
 */
export class RelatedIndex {
  private folders = new Map<string, FolderIndex>();

  private folder(key: string, uidValidity: string): FolderIndex {
    let f = this.folders.get(key);
    if (!f || f.uidValidity !== uidValidity) {
      f = { uidValidity, terms: new Map() };
    }
    // Most recently used last.
    this.folders.delete(key);
    this.folders.set(key, f);
    while (this.folders.size > MAX_FOLDERS) this.folders.delete(this.folders.keys().next().value!);
    return f;
  }

  /**
   * What has to be searched for `terms` in a folder whose next UID is `uidNext`: batches of terms
   * with the UID to start from (1 = never searched), plus the UIDs already known to match.
   */
  plan(key: string, uidValidity: string, uidNext: number, terms: LookupTerm[]) {
    const f = this.folder(key, uidValidity);
    const known = new Set<number>();
    const byStart = new Map<number, LookupTerm[]>();
    for (const t of terms) {
      const e = f.terms.get(termKey(t));
      for (const u of e?.uids ?? []) known.add(u);
      const start = e ? e.upTo : 1;
      if (e && start >= uidNext) continue;
      byStart.set(start, [...(byStart.get(start) ?? []), t]);
    }
    const searches: { fromUid: number; terms: LookupTerm[] }[] = [];
    for (const [fromUid, list] of byStart) {
      for (let i = 0; i < list.length; i += TERMS_PER_SEARCH) searches.push({ fromUid, terms: list.slice(i, i + TERMS_PER_SEARCH) });
    }
    return { searches, known };
  }

  /**
   * Record the outcome: `found` are the messages that exist now among the candidates (with their
   * headers), `searched` the terms whose search succeeded up to `uidNext`.
   */
  record(key: string, uidValidity: string, uidNext: number, terms: LookupTerm[], searched: Set<string>, found: { uid: number; headers: ThreadHeaders }[]) {
    const f = this.folder(key, uidValidity);
    for (const t of terms) {
      const k = termKey(t);
      const prev = f.terms.get(k);
      if (!searched.has(k) && !prev) continue;
      const uids = found.filter((m) => matchesTerm(t, m.headers)).map((m) => m.uid);
      f.terms.delete(k);
      f.terms.set(k, { upTo: searched.has(k) ? uidNext : prev!.upTo, uids });
    }
    while (f.terms.size > MAX_TERMS_PER_FOLDER) f.terms.delete(f.terms.keys().next().value!);
  }
}
