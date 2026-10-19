import crypto from 'node:crypto';
import type { NotificationContent, PushSubscriptionInput } from '../../../shared/types.js';
import type { Store } from '../db.js';
import {
  buildNotification,
  buildSnoozeNotification,
  type ClearPayload,
  type NewMail,
  type NotificationPayload,
  type WokenMail,
} from './notify.js';
import { assertPublicHost } from '../net/ssrf.js';
import { checkPushEndpoint, MAX_PAYLOAD_BYTES, PushEndpointError, type PushTransport } from './webpush.js';

export class PushSubscriptionError extends Error {}

/**
 * Checks a subscription from the browser before it is stored (and later POSTed to). `resolve`
 * also refuses hosts that resolve to internal addresses, for a clear error up front; sending
 * enforces that again on every connection.
 */
export async function validateSubscription(sub: PushSubscriptionInput, resolve: (host: string) => Promise<void> = assertPublicHost) {
  let url: URL;
  try {
    url = checkPushEndpoint(sub.endpoint);
  } catch (err) {
    throw new PushSubscriptionError((err as PushEndpointError).message);
  }
  try {
    await resolve(url.hostname);
  } catch {
    throw new PushSubscriptionError(`Unsupported push service (${url.hostname}): it does not resolve to a public address`);
  }
  const pub = Buffer.from(sub.keys.p256dh, 'base64url');
  const auth = Buffer.from(sub.keys.auth, 'base64url');
  if (auth.length !== 16) throw new PushSubscriptionError('Invalid push subscription keys');
  try {
    // Throws unless p256dh is a valid uncompressed point on P-256.
    if (pub.length !== 65) throw new Error();
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.generateKeys();
    ecdh.computeSecret(pub);
  } catch {
    throw new PushSubscriptionError('Invalid push subscription keys');
  }
}

export interface PushServiceOptions {
  store: Store;
  transport: PushTransport;
  /** True while the user has the app open in front of them; notifications are skipped then. */
  isUserActive: (userId: string) => boolean;
  /** Called when a user's last subscription disappears (expired at the push service). */
  onNoSubscriptions: (userId: string) => void;
  /** Total unread across the user's inboxes, for the app icon badge (null if unknown). */
  unreadCount?: (userId: string) => Promise<number | null>;
  /**
   * Which of `uids` are still unread in the account's INBOX. An empty set if INBOX's UIDVALIDITY
   * is no longer `uidValidity` (the UIDs mean nothing any more).
   */
  unreadInInbox?: (userId: string, accountId: string, uidValidity: string, uids: number[]) => Promise<Set<number>>;
  /** How long to wait for more INBOX changes before checking (several flags often change at once). */
  clearDelayMs?: number;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

/** A notification that may still be showing on the user's devices, and the messages it is about. */
interface Shown {
  accountId: string;
  uidValidity: string;
  uids: Set<number>;
  expires: number;
}

/** Same as the TTL of new-mail pushes: after that, nothing is cleared any more. */
const NOTIFICATION_TTL_S = 24 * 3600;

/**
 * Apple revokes a subscription after a few pushes that show no notification, so devices on
 * Apple's push service never get "clear" pushes.
 */
const canClearSilently = (endpoint: string) => !new URL(endpoint).hostname.endsWith('.push.apple.com');

/** Turns new INBOX mail (and snoozed mail coming back) into Web Push notifications on every device the user enabled. */
export class PushService {
  /** Per user: notification tag → what it is about. In memory only, so a restart forgets them. */
  private readonly shown = new Map<string, Map<string, Shown>>();
  private readonly clearTimers = new Map<string, NodeJS.Timeout>();
  private readonly clearing = new Map<string, Promise<void>>();

  constructor(private readonly opts: PushServiceOptions) {}

  async notifyNewMail(userId: string, accountId: string, messages: NewMail[]) {
    const uidValidity = messages[0]?.uidValidity;
    await this.notify(userId, accountId, (account, content) => buildNotification(account, messages, content), {
      uidValidity: uidValidity ?? '',
      uids: messages.filter((m) => m.uidValidity === uidValidity).map((m) => m.uid),
    });
  }

  /** Snoozed messages are back in the inbox. */
  async notifySnoozeEnded(userId: string, accountId: string, messages: WokenMail[]) {
    const known = messages.filter((m) => m.uid !== null && m.uidValidity !== null);
    const uidValidity = known[0]?.uidValidity ?? '';
    await this.notify(userId, accountId, (account, content) => buildSnoozeNotification(account, messages, content), {
      // A notification that is partly about messages with unknown UIDs is never cleared.
      uidValidity,
      uids: known.length === messages.length ? known.filter((m) => m.uidValidity === uidValidity).map((m) => m.uid!) : [],
    });
  }

  private async notify(
    userId: string,
    accountId: string,
    build: (account: { id: string; name: string }, content: NotificationContent) => NotificationPayload | null,
    about: { uidValidity: string; uids: number[] },
  ) {
    const { store } = this.opts;
    if (this.opts.isUserActive(userId)) return;
    const user = store.getUser(userId);
    const account = store.listAccounts(userId).find((a) => a.id === accountId);
    if (!user || !account) return;
    const payload = build(account, user.preferences.notificationContent);
    if (!payload) return;
    const badge = await this.opts.unreadCount?.(userId).catch(() => null);
    const delivered = await this.send(userId, typeof badge === 'number' ? { ...payload, badge } : payload, NOTIFICATION_TTL_S);
    if (delivered === 0) return;
    // A notification with the same tag replaces the one before, so this replaces its record too.
    const byTag = this.shown.get(userId) ?? new Map<string, Shown>();
    if (about.uids.length > 0) {
      byTag.set(payload.tag, {
        accountId,
        uidValidity: about.uidValidity,
        uids: new Set(about.uids),
        expires: Date.now() + NOTIFICATION_TTL_S * 1000,
      });
    } else {
      byTag.delete(payload.tag);
    }
    if (byTag.size > 0) this.shown.set(userId, byTag);
    else this.shown.delete(userId);
  }

  /**
   * Something changed in an account's INBOX (flags, or messages removed). After a short pause,
   * closes notifications on the user's devices whose messages are now all read or gone.
   */
  inboxChanged(userId: string, accountId: string) {
    if (!this.opts.unreadInInbox || !this.showingFor(userId, accountId)) return;
    const key = `${userId}:${accountId}`;
    if (this.clearTimers.has(key)) return;
    const timer = setTimeout(() => {
      this.clearTimers.delete(key);
      void this.clearRead(userId, accountId);
    }, this.opts.clearDelayMs ?? 2_000);
    timer.unref();
    this.clearTimers.set(key, timer);
  }

  /** Closes the account's notifications whose messages are no longer unread in INBOX. One check at a time per account. */
  clearRead(userId: string, accountId: string): Promise<void> {
    const key = `${userId}:${accountId}`;
    const next = (this.clearing.get(key) ?? Promise.resolve())
      .then(() => this.checkShown(userId, accountId))
      .catch((err: unknown) => this.opts.log?.('clearing notifications failed', { accountId, error: (err as Error).message }));
    this.clearing.set(key, next);
    void next.then(() => {
      if (this.clearing.get(key) === next) this.clearing.delete(key);
    });
    return next;
  }

  private showingFor(userId: string, accountId: string): [string, Shown][] {
    const byTag = this.shown.get(userId);
    if (!byTag) return [];
    const now = Date.now();
    for (const [tag, s] of byTag) if (s.expires <= now) byTag.delete(tag);
    if (byTag.size === 0) this.shown.delete(userId);
    return [...byTag].filter(([, s]) => s.accountId === accountId);
  }

  private async checkShown(userId: string, accountId: string) {
    const unreadInInbox = this.opts.unreadInInbox;
    const showing = this.showingFor(userId, accountId);
    if (!unreadInInbox || showing.length === 0) return;
    const byValidity = new Map<string, Set<number>>();
    for (const [, s] of showing) {
      const uids = byValidity.get(s.uidValidity) ?? new Set<number>();
      for (const uid of s.uids) uids.add(uid);
      byValidity.set(s.uidValidity, uids);
    }
    const unread = new Map<string, Set<number>>();
    for (const [uidValidity, uids] of byValidity) {
      unread.set(uidValidity, await unreadInInbox(userId, accountId, uidValidity, [...uids].sort((a, b) => a - b)));
    }
    const done: string[] = [];
    const byTag = this.shown.get(userId);
    for (const [tag, s] of showing) {
      // Replaced by a newer notification while we were checking: leave that one alone.
      if (byTag?.get(tag) !== s) continue;
      const stillUnread = unread.get(s.uidValidity)!;
      for (const uid of s.uids) if (!stillUnread.has(uid)) s.uids.delete(uid);
      if (s.uids.size === 0) {
        byTag.delete(tag);
        done.push(tag);
      }
    }
    if (byTag?.size === 0) this.shown.delete(userId);
    if (done.length === 0) return;
    const badge = await this.opts.unreadCount?.(userId).catch(() => null);
    const payload: ClearPayload = { type: 'clear', tags: done, ...(typeof badge === 'number' ? { badge } : {}) };
    await this.send(userId, payload, NOTIFICATION_TTL_S, { urgency: 'normal', only: canClearSilently });
  }

  /** "Send test notification" in Settings. Returns how many devices accepted it. */
  async sendTest(userId: string): Promise<number> {
    return this.send(
      userId,
      { title: 'Ratatoskr', body: 'Notifications work on this device.', tag: 'test', url: '/' },
      300,
    );
  }

  private async send(
    userId: string,
    payload: NotificationPayload | ClearPayload,
    ttl: number,
    opts: { urgency?: 'normal' | 'high'; only?: (endpoint: string) => boolean } = {},
  ): Promise<number> {
    const { store, transport } = this.opts;
    if ('body' in payload && Buffer.byteLength(JSON.stringify(payload)) > MAX_PAYLOAD_BYTES) {
      payload = { ...payload, body: payload.body.slice(0, 500) };
    }
    if ('tags' in payload && Buffer.byteLength(JSON.stringify(payload)) > MAX_PAYLOAD_BYTES) {
      payload = { ...payload, tags: payload.tags.slice(0, 50) };
    }
    const subs = store.listPushSubscriptions(userId).filter((s) => !opts.only || opts.only(s.endpoint));
    const outcomes = await Promise.all(
      subs.map(async (s) => {
        const outcome = await transport({
          subscription: { endpoint: s.endpoint, p256dh: s.keys.p256dh, auth: s.keys.auth },
          payload,
          ttl,
          // High priority wakes a sleeping phone; push services may throttle sites that use it
          // for pushes that show nothing, so clearing uses normal.
          urgency: opts.urgency ?? 'high',
        }).catch(() => 'failed' as const);
        if (outcome === 'gone') store.removePushSubscription(userId, s.endpoint);
        else if (outcome === 'failed') this.opts.log?.('push delivery failed', { host: new URL(s.endpoint).host });
        return outcome;
      }),
    );
    if (subs.length > 0 && store.listPushSubscriptions(userId).length === 0) this.opts.onNoSubscriptions(userId);
    return outcomes.filter((o) => o === 'sent').length;
  }
}
