import crypto from 'node:crypto';
import type { NotificationContent, PushSubscriptionInput } from '../../../shared/types.js';
import type { Store } from '../db.js';
import { buildNotification, buildSnoozeNotification, type NewMail, type NotificationPayload, type WokenMail } from './notify.js';
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
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

/** Turns new INBOX mail (and snoozed mail coming back) into Web Push notifications on every device the user enabled. */
export class PushService {
  constructor(private readonly opts: PushServiceOptions) {}

  async notifyNewMail(userId: string, accountId: string, messages: NewMail[]) {
    await this.notify(userId, accountId, (account, content) => buildNotification(account, messages, content));
  }

  /** Snoozed messages are back in the inbox. */
  async notifySnoozeEnded(userId: string, accountId: string, messages: WokenMail[]) {
    await this.notify(userId, accountId, (account, content) => buildSnoozeNotification(account, messages, content));
  }

  private async notify(
    userId: string,
    accountId: string,
    build: (account: { id: string; name: string }, content: NotificationContent) => NotificationPayload | null,
  ) {
    const { store } = this.opts;
    if (this.opts.isUserActive(userId)) return;
    const user = store.getUser(userId);
    const account = store.listAccounts(userId).find((a) => a.id === accountId);
    if (!user || !account) return;
    const payload = build(account, user.preferences.notificationContent);
    if (!payload) return;
    const badge = await this.opts.unreadCount?.(userId).catch(() => null);
    await this.send(userId, typeof badge === 'number' ? { ...payload, badge } : payload, 24 * 3600);
  }

  /** "Send test notification" in Settings. Returns how many devices accepted it. */
  async sendTest(userId: string): Promise<number> {
    return this.send(
      userId,
      { title: 'Ratatoskr', body: 'Notifications work on this device.', tag: 'test', url: '/' },
      300,
    );
  }

  private async send(userId: string, payload: NotificationPayload, ttl: number): Promise<number> {
    const { store, transport } = this.opts;
    if (Buffer.byteLength(JSON.stringify(payload)) > MAX_PAYLOAD_BYTES) {
      payload = { ...payload, body: payload.body.slice(0, 500) };
    }
    const subs = store.listPushSubscriptions(userId);
    const outcomes = await Promise.all(
      subs.map(async (s) => {
        const outcome = await transport({
          subscription: { endpoint: s.endpoint, p256dh: s.keys.p256dh, auth: s.keys.auth },
          payload,
          ttl,
          urgency: 'high',
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
