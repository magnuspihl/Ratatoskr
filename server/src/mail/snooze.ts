import type { MessageRef, ServerEvent, UndoInfo } from '../../../shared/types.js';
import type { Snooze, Store } from '../db.js';
import { MailServerError } from '../imap/connect.js';
import type { MailService } from '../imap/mail.js';
import type { WokenMail } from '../push/notify.js';

export class SnoozeError extends Error {}

/** Furthest a message can be snoozed into the future. */
export const MAX_SNOOZE_MS = 5 * 366 * 86_400_000;
/** The scheduler looks at the table at least this often (a safety net; it normally wakes exactly on time). */
const MAX_TIMER_MS = 60_000;
/** How long a message put back into INBOX is remembered, so the new-mail watcher doesn't report it as new. */
const RESURFACED_TTL_MS = 10 * 60_000;
const FIRST_RETRY_MS = 30_000;
const MAX_RETRY_MS = 60 * 60_000;

/** Parse and check a requested wake-up time: a future ISO date-time, at most MAX_SNOOZE_MS ahead. */
export function parseSnoozeTime(until: string, now: number): number {
  const t = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(until) ? Date.parse(until) : NaN;
  if (!Number.isFinite(t)) throw new SnoozeError('Not a valid date and time');
  if (t <= now) throw new SnoozeError('Pick a time in the future');
  if (t - now > MAX_SNOOZE_MS) throw new SnoozeError('You can snooze for at most five years');
  return t;
}

export interface SnoozeOptions {
  store: Store;
  mail: MailService;
  /** Messages up to this size come back with a new arrival date; larger ones are moved as they are. */
  maxMessageBytes: number;
  /** Snoozed messages of one account are back in INBOX (phone notification). */
  notify: (userId: string, accountId: string, messages: WokenMail[]) => Promise<void> | void;
  /** Live update for the user's open browser sessions. */
  emit: (userId: string, event: ServerEvent) => void;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
  now?: () => number;
}

type ActionOutcome = { undo: UndoInfo | null; permanent: boolean; createdFolder: string | null };

/**
 * Snoozing: the message moves to the account's Snoozed folder (found by the RFC 9979 attribute or
 * by name, created if missing) and the wake-up time is stored. IMAP has no way to store that time
 * on the message, so a timer here puts each message back into INBOX when it is due, as unread with
 * the current time as its arrival date, and notifies the user. Snoozes that came due while the
 * server was down are handled as soon as it starts.
 */
export class SnoozeService {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private stopped = true;
  /** Accounts whose IMAP server failed recently: key -> when to try again and the current delay. */
  private readonly retry = new Map<string, { at: number; delay: number }>();
  private readonly resurfaced = new Map<string, number>();
  private readonly now: () => number;

  constructor(private readonly opts: SnoozeOptions) {
    this.now = opts.now ?? Date.now;
  }

  start() {
    this.stopped = false;
    void this.runDue();
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.running;
  }

  /** Snooze messages of one folder. Messages already in the Snoozed folder only get a new time. */
  async snooze(userId: string, ref: Omit<MessageRef, 'uid'>, uids: number[], untilIso: string): Promise<ActionOutcome> {
    const { store, mail } = this.opts;
    const until = parseSnoozeTime(untilIso, this.now());
    const target = await mail.ensureFolder(userId, ref.accountId, 'snoozed');
    const createdFolder = target.created ? target.path : null;
    if (ref.folder === target.path) {
      await mail.assertUidValidity(userId, ref);
      store.setSnoozes(userId, ref.accountId, ref.folder, ref.uidValidity, uids, until);
      this.reschedule();
      return { undo: null, permanent: false, createdFolder };
    }
    const moved = await mail.applyAction(userId, ref.accountId, ref.folder, ref.uidValidity, uids, { type: 'move', destination: target.path });
    if (!moved.undo) {
      throw new MailServerError(
        `The mail server didn't say where the messages ended up in "${target.path}", so they can't come back on their own. Move them back by hand.`,
        'protocol',
      );
    }
    const u = moved.undo;
    store.setSnoozes(userId, ref.accountId, u.folder, u.uidValidity, u.uids, until);
    this.reschedule();
    return { undo: u, permanent: false, createdFolder };
  }

  /** "Unsnooze": back to INBOX right away, without a notification. */
  async unsnooze(userId: string, ref: Omit<MessageRef, 'uid'>, uids: number[]): Promise<ActionOutcome> {
    const { store, mail } = this.opts;
    await mail.assertUidValidity(userId, ref);
    for (const uid of uids) {
      await mail.resurface(userId, { ...ref, uid }, {
        markUnread: false,
        maxBytes: this.opts.maxMessageBytes,
        beforeAppend: (id) => this.expect(userId, ref.accountId, id),
      });
      store.deleteSnoozes(userId, ref.accountId, ref.folder, ref.uidValidity, [uid]);
    }
    return { undo: null, permanent: false, createdFolder: null };
  }

  /** True if this INBOX arrival is a snoozed message coming back, not new mail. */
  wasResurfaced(userId: string, accountId: string, messageId: string | null | undefined): boolean {
    const now = this.now();
    for (const [k, exp] of this.resurfaced) if (exp < now) this.resurfaced.delete(k);
    return !!messageId && this.resurfaced.has(`${userId}\u0000${accountId}\u0000${messageId}`);
  }

  private expect(userId: string, accountId: string, messageId: string | null) {
    if (messageId) this.resurfaced.set(`${userId}\u0000${accountId}\u0000${messageId}`, this.now() + RESURFACED_TTL_MS);
  }

  /** Wake every message that is due (also called by the timer). Runs one pass at a time. */
  runDue(): Promise<void> {
    if (!this.running) {
      this.running = this.processDue()
        .catch((err: unknown) => this.opts.log?.('snooze pass failed', { error: (err as Error).message }))
        .finally(() => {
          this.running = null;
          this.reschedule();
        });
    }
    return this.running;
  }

  private async processDue() {
    const now = this.now();
    const byAccount = new Map<string, Snooze[]>();
    for (const s of this.opts.store.dueSnoozes(now)) {
      const key = `${s.userId}\u0000${s.accountId}`;
      if ((this.retry.get(key)?.at ?? 0) > now) continue;
      byAccount.set(key, [...(byAccount.get(key) ?? []), s]);
    }
    // Accounts in parallel; within one account in order, on its single command connection.
    await Promise.all([...byAccount].map(([key, due]) => this.wakeAccount(key, due)));
  }

  private async wakeAccount(key: string, due: Snooze[]) {
    const { store, mail } = this.opts;
    const { userId, accountId } = due[0]!;
    const woken: WokenMail[] = [];
    const folders = new Set<string>();
    try {
      for (const s of due) {
        const back = await mail.resurface(userId, s, {
          markUnread: true,
          maxBytes: this.opts.maxMessageBytes,
          beforeAppend: (id) => this.expect(userId, accountId, id),
        });
        // Gone (moved away or deleted meanwhile, or the folder was recreated): just forget it.
        store.deleteSnoozes(userId, accountId, s.folder, s.uidValidity, [s.uid]);
        folders.add(s.folder);
        if (back) woken.push({ uid: back.uid, uidValidity: back.uidValidity, from: back.from, subject: back.subject });
      }
      this.retry.delete(key);
    } catch (err) {
      await this.handleFailure(key, due, err);
    }
    if (woken.length === 0) return;
    const { emit } = this.opts;
    for (const folder of ['INBOX', ...folders]) emit(userId, { type: 'mailbox', accountId, folder });
    for (const m of woken) {
      emit(userId, {
        type: 'snoozeEnded',
        accountId,
        uid: m.uid,
        uidValidity: m.uidValidity ?? '',
        from: m.from?.name || m.from?.address || '',
        subject: m.subject,
      });
    }
    try {
      await this.opts.notify(userId, accountId, woken);
    } catch (err) {
      this.opts.log?.('snooze notification failed', { accountId, error: (err as Error).message });
    }
  }

  /**
   * The account's server failed: try again later, backing off. If the Snoozed folder itself is
   * gone (deleted by the user in another client), its snoozes are dropped instead of retried forever.
   */
  private async handleFailure(key: string, due: Snooze[], err: unknown) {
    const { userId, accountId } = due[0]!;
    const folders = await this.opts.mail.listFolders(userId, accountId).catch(() => null);
    if (folders && !folders.error) {
      const existing = new Set(folders.folders.map((f) => f.path));
      const missing = due.filter((s) => !existing.has(s.folder));
      for (const s of missing) this.opts.store.deleteSnoozes(userId, accountId, s.folder, s.uidValidity, [s.uid]);
      if (missing.length === due.length) return;
    }
    const delay = Math.min((this.retry.get(key)?.delay ?? FIRST_RETRY_MS / 2) * 2, MAX_RETRY_MS);
    this.retry.set(key, { at: this.now() + delay, delay });
    this.opts.log?.('could not wake snoozed messages, will retry', { accountId, retryInMs: delay, error: (err as Error).message });
  }

  /** Arm the timer for the next due snooze (or the next retry), at most MAX_TIMER_MS ahead. */
  private reschedule() {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    const now = this.now();
    const next = this.opts.store.nextSnoozeDue();
    let delay = next === null ? MAX_TIMER_MS : next - now;
    if (delay <= 0) {
      // Due, but its account is waiting to retry: wake up when the first retry is allowed.
      const retries = [...this.retry.values()].map((r) => r.at - now);
      delay = retries.length ? Math.min(...retries) : 0;
    }
    this.timer = setTimeout(() => void this.runDue(), Math.min(Math.max(delay, 50), MAX_TIMER_MS));
    this.timer.unref();
  }
}
