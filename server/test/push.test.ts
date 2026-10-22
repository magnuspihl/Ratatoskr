import crypto from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { AccountInput, PushSubscriptionInput } from '../../shared/types.js';
import { inboxUnread } from '../../shared/unread.js';
import { DEFAULT_PREFERENCES, MAX_PUSH_SUBSCRIPTIONS, Store } from '../src/db.js';
import { buildNotification, type NewMail } from '../src/push/notify.js';
import { PushService, PushSubscriptionError, validateSubscription } from '../src/push/service.js';
import type { PushRequest } from '../src/push/webpush.js';
import { parseClientEvent } from '../src/routes/ws.js';

const account = { id: 'acc1', name: 'Work' };
const mail = (uid: number, from: string, subject: string): NewMail => ({
  uid,
  uidValidity: '42',
  from: { name: from, address: `${from.toLowerCase()}@example.com` },
  subject,
});

// A real P-256 public key and auth secret, as a browser would produce them (generated per run).
function browserKeys() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return { p256dh: ecdh.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') };
}
const sub = (id: string): PushSubscriptionInput => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${id}`, keys: browserKeys() });

const accountInput: AccountInput = {
  name: 'Work',
  displayName: 'Test User',
  email: 'user@example.com',
  color: '#3366ff',
  imap: { host: 'mail.example.com', port: 993, tls: 'tls', user: 'user@example.com', password: 'pw' },
  smtp: { host: 'mail.example.com', port: 465, tls: 'tls', user: 'user@example.com', password: 'pw' },
  appendSent: true,
};

function store() {
  return new Store(':memory:', crypto.randomBytes(32));
}

describe('notification text', () => {
  it('shows sender and subject for a single message and opens that message when tapped', () => {
    expect(buildNotification(account, [mail(7, 'Alice', 'Lunch tomorrow?')], 'full')).toEqual({
      title: 'Alice',
      body: 'Lunch tomorrow?',
      tag: 'acc1:7',
      url: '/?open=acc1.42.7',
    });
  });

  it('summarises several messages in one notification, newest first, and opens the inbox', () => {
    const n = buildNotification(account, [mail(1, 'Alice', 'One'), mail(3, 'Carol', 'Three'), mail(2, 'Bob', 'Two')], 'full')!;
    expect(n.title).toBe('3 new messages in Work');
    expect(n.body).toBe('Carol: Three\nBob: Two\nAlice: One');
    expect(n.url).toBe('/');
  });

  it('lists at most five messages and counts the rest', () => {
    const many = Array.from({ length: 8 }, (_, i) => mail(i + 1, `Sender${i + 1}`, `Subject ${i + 1}`));
    const lines = buildNotification(account, many, 'full')!.body.split('\n');
    expect(lines).toHaveLength(6);
    expect(lines[0]).toBe('Sender8: Subject 8');
    expect(lines[5]).toBe('and 3 more');
  });

  it('never reveals sender or subject when the user chose minimal notifications', () => {
    const one = buildNotification(account, [mail(7, 'Alice', 'Secret plans')], 'minimal')!;
    const many = buildNotification(account, [mail(7, 'Alice', 'Secret plans'), mail(8, 'Bob', 'More secrets')], 'minimal')!;
    for (const n of [one, many]) {
      expect(JSON.stringify(n)).not.toMatch(/Alice|Bob|Secret|secrets/);
      expect(n.body).toBe('Work');
    }
    expect(one.title).toBe('New message');
    expect(many.title).toBe('2 new messages');
  });

  it('falls back to the address, "Unknown sender" and "(no subject)" and shortens very long subjects', () => {
    expect(buildNotification(account, [{ uid: 1, uidValidity: '1', from: { name: '', address: 'a@example.com' }, subject: '' }], 'full')).toMatchObject({
      title: 'a@example.com',
      body: '(no subject)',
    });
    expect(buildNotification(account, [{ uid: 1, uidValidity: '1', from: null, subject: 'x'.repeat(500) }], 'full')).toMatchObject({
      title: 'Unknown sender',
      body: `${'x'.repeat(199)}…`,
    });
  });

  it('sends nothing for an empty batch', () => {
    expect(buildNotification(account, [], 'full')).toBeNull();
  });
});

describe('push subscription validation', () => {
  const publicHost = async () => {};
  const internalHost = async () => {
    throw new Error('blocked');
  };

  it('accepts a real browser subscription', async () => {
    await expect(validateSubscription(sub('ok'), publicHost)).resolves.toBeUndefined();
  });

  it('accepts push services other than the big four, such as other Chromium browsers use', async () => {
    await expect(validateSubscription({ ...sub('x'), endpoint: 'https://push.vivaldi-like.example.net/abc' }, publicHost)).resolves.toBeUndefined();
  });

  it('refuses push hosts that resolve to internal addresses, naming the host', async () => {
    await expect(validateSubscription({ ...sub('x'), endpoint: 'https://push.corp.example.net/x' }, internalHost)).rejects.toThrow(
      /push\.corp\.example\.net.*public address/,
    );
  });

  it('refuses endpoints that are not plain HTTPS URLs on a host name', async () => {
    await expect(validateSubscription({ ...sub('x'), endpoint: 'https://169.254.169.254/latest/meta-data' }, publicHost)).rejects.toThrow(PushSubscriptionError);
    await expect(validateSubscription({ ...sub('x'), endpoint: 'http://fcm.googleapis.com/x' }, publicHost)).rejects.toThrow(PushSubscriptionError);
  });

  it('refuses keys that are not a P-256 point or a 16-byte auth secret', async () => {
    const good = sub('k');
    const offCurve = Buffer.alloc(65, 1);
    offCurve[0] = 4;
    await expect(validateSubscription({ ...good, keys: { ...good.keys, p256dh: offCurve.toString('base64url') } }, publicHost)).rejects.toThrow(PushSubscriptionError);
    await expect(validateSubscription({ ...good, keys: { ...good.keys, auth: 'c2hvcnQ' } }, publicHost)).rejects.toThrow(PushSubscriptionError);
  });
});

describe('push subscriptions and inbox marks in the database', () => {
  it('moves a device to the user who subscribed it most recently', () => {
    const s = store();
    const a = s.upsertUser('iss', 'a', '', '');
    const b = s.upsertUser('iss', 'b', '', '');
    const device = sub('shared-phone');
    s.addPushSubscription(a.id, device);
    s.addPushSubscription(b.id, device);
    expect(s.listPushSubscriptions(a.id)).toEqual([]);
    expect(s.listPushSubscriptions(b.id)).toEqual([device]);
    expect(s.pushUserIds()).toEqual([b.id]);
  });

  it(`keeps at most ${MAX_PUSH_SUBSCRIPTIONS} devices per user, dropping the oldest`, () => {
    const s = store();
    const u = s.upsertUser('iss', 'u', '', '');
    const now = vi.spyOn(Date, 'now');
    for (let i = 0; i < MAX_PUSH_SUBSCRIPTIONS + 2; i++) {
      now.mockReturnValue(1_000 + i);
      s.addPushSubscription(u.id, sub(`d${i}`));
    }
    now.mockRestore();
    const endpoints = s.listPushSubscriptions(u.id).map((x) => x.endpoint);
    expect(endpoints).toHaveLength(MAX_PUSH_SUBSCRIPTIONS);
    expect(endpoints[0]).toMatch(/\/d2$/);
  });

  it('only lets a user remove their own subscriptions', () => {
    const s = store();
    const a = s.upsertUser('iss', 'a', '', '');
    const b = s.upsertUser('iss', 'b', '', '');
    const device = sub('a-phone');
    s.addPushSubscription(a.id, device);
    expect(s.removePushSubscription(b.id, device.endpoint)).toBe(false);
    expect(s.removePushSubscription(a.id, device.endpoint)).toBe(true);
  });

  it("keeps each account's highest notified UID per user, and forgets it with the account", () => {
    const s = store();
    const a = s.upsertUser('iss', 'a', '', '');
    const b = s.upsertUser('iss', 'b', '', '');
    const acc = s.createAccount(a.id, accountInput);
    s.setInboxState(a.id, acc.id, '42', 100);
    expect(s.getInboxState(a.id, acc.id)).toEqual({ uidValidity: '42', lastUid: 100 });
    // Another user can neither read nor write it.
    expect(s.getInboxState(b.id, acc.id)).toBeNull();
    s.setInboxState(b.id, acc.id, '42', 999);
    expect(s.getInboxState(a.id, acc.id)?.lastUid).toBe(100);
    s.clearInboxState(a.id);
    expect(s.getInboxState(a.id, acc.id)).toBeNull();
    s.setInboxState(a.id, acc.id, '42', 5);
    s.deleteAccount(a.id, acc.id);
    expect((s.db.prepare('SELECT COUNT(*) AS n FROM inbox_state').get() as { n: number }).n).toBe(0);
  });

  it('defaults to sender and subject in notifications', () => {
    expect(DEFAULT_PREFERENCES.notificationContent).toBe('full');
  });
});

describe('sending new-mail notifications', () => {
  function setup(opts: { active?: boolean; outcome?: (r: PushRequest) => 'sent' | 'gone' | 'failed'; badge?: number | null } = {}) {
    const s = store();
    const user = s.upsertUser('iss', 'u', '', '');
    const acc = s.createAccount(user.id, accountInput);
    const sent: PushRequest[] = [];
    const noSubs = vi.fn();
    const push = new PushService({
      store: s,
      transport: async (r) => {
        sent.push(r);
        return opts.outcome?.(r) ?? 'sent';
      },
      isUserActive: () => opts.active ?? false,
      onNoSubscriptions: noSubs,
      unreadCount: async () => opts.badge ?? null,
    });
    return { s, user, acc, sent, noSubs, push };
  }

  it('sends one notification to every device of the user, with the unread badge', async () => {
    const { s, user, acc, sent, push } = setup({ badge: 12 });
    s.addPushSubscription(user.id, sub('phone'));
    s.addPushSubscription(user.id, sub('laptop'));
    await push.notifyNewMail(user.id, acc.id, [mail(5, 'Alice', 'Hi')]);
    expect(sent.map((r) => r.subscription.endpoint).sort()).toEqual([
      'https://fcm.googleapis.com/fcm/send/laptop',
      'https://fcm.googleapis.com/fcm/send/phone',
    ]);
    expect(sent[0]!.payload).toMatchObject({ title: 'Alice', body: 'Hi', badge: 12 });
  });

  it('uses minimal content when the user chose it', async () => {
    const { s, user, acc, sent, push } = setup();
    s.setPreferences(user.id, { ...DEFAULT_PREFERENCES, notificationContent: 'minimal' });
    s.addPushSubscription(user.id, sub('phone'));
    await push.notifyNewMail(user.id, acc.id, [mail(5, 'Alice', 'Hi')]);
    expect(sent[0]!.payload).toMatchObject({ title: 'New message', body: 'Work' });
  });

  it('stays quiet while the user has the app open in front of them', async () => {
    const { s, user, acc, sent, push } = setup({ active: true });
    s.addPushSubscription(user.id, sub('phone'));
    await push.notifyNewMail(user.id, acc.id, [mail(5, 'Alice', 'Hi')]);
    expect(sent).toEqual([]);
  });

  it('forgets devices the push service says are gone, and reports when none are left', async () => {
    const { s, user, acc, push, noSubs } = setup({ outcome: () => 'gone' });
    s.addPushSubscription(user.id, sub('old-phone'));
    await push.notifyNewMail(user.id, acc.id, [mail(5, 'Alice', 'Hi')]);
    expect(s.listPushSubscriptions(user.id)).toEqual([]);
    expect(noSubs).toHaveBeenCalledWith(user.id);
  });

  it('keeps devices after a temporary delivery failure', async () => {
    const { s, user, acc, push, noSubs } = setup({ outcome: () => 'failed' });
    s.addPushSubscription(user.id, sub('phone'));
    await push.notifyNewMail(user.id, acc.id, [mail(5, 'Alice', 'Hi')]);
    expect(s.listPushSubscriptions(user.id)).toHaveLength(1);
    expect(noSubs).not.toHaveBeenCalled();
  });

  it('counts the devices that accepted a test notification, even while the app is open', async () => {
    const { s, user, push } = setup({ active: true, outcome: (r) => (r.subscription.endpoint.endsWith('ok') ? 'sent' : 'failed') });
    s.addPushSubscription(user.id, sub('ok'));
    s.addPushSubscription(user.id, sub('broken'));
    expect(await push.sendTest(user.id)).toBe(1);
  });
});

describe('clearing notifications when the mail is read elsewhere', () => {
  /** `unread` is what the IMAP server says is still unread in INBOX (UIDVALIDITY 42). */
  function setup(opts: { unread?: Set<number>; badge?: number; recheckMs?: number } = {}) {
    const s = store();
    const user = s.upsertUser('iss', 'u', '', '');
    const acc = s.createAccount(user.id, accountInput);
    const sent: PushRequest[] = [];
    const state = { unread: opts.unread ?? new Set<number>(), checks: 0 };
    const push = new PushService({
      store: s,
      transport: async (r) => (sent.push(r), 'sent'),
      isUserActive: () => false,
      onNoSubscriptions: () => {},
      unreadCount: async () => opts.badge ?? null,
      unreadInInbox: async (_u, _a, uidValidity, uids) => {
        state.checks++;
        return uidValidity === '42' ? new Set(uids.filter((u) => state.unread.has(u))) : new Set();
      },
      clearDelayMs: 10,
      recheckMs: opts.recheckMs ?? 60_000,
    });
    s.addPushSubscription(user.id, sub('phone'));
    const clears = () => sent.filter((r) => (r.payload as { type?: string }).type === 'clear').map((r) => r.payload);
    return { s, user, acc, sent, state, push, clears };
  }

  it('closes the notification on every device once its message is read, with the new badge count', async () => {
    const { user, acc, push, state, clears, sent } = setup({ unread: new Set([5]), badge: 0 });
    await push.notifyNewMail(user.id, acc.id, [mail(5, 'Alice', 'Hi')]);
    state.unread.delete(5);
    await push.clearRead(user.id, acc.id);
    expect(clears()).toEqual([{ type: 'clear', tags: [`${acc.id}:5`], badge: 0 }]);
    // Pushes that show nothing go out at normal priority.
    expect(sent.at(-1)!.urgency).toBe('normal');
  });

  it('sends nothing while the message is still unread', async () => {
    const { user, acc, push, clears } = setup({ unread: new Set([5]) });
    await push.notifyNewMail(user.id, acc.id, [mail(5, 'Alice', 'Hi')]);
    await push.clearRead(user.id, acc.id);
    expect(clears()).toEqual([]);
  });

  it('closes a summary notification only after every message in it is read', async () => {
    const { user, acc, push, state, clears } = setup({ unread: new Set([1, 2]) });
    await push.notifyNewMail(user.id, acc.id, [mail(1, 'Alice', 'One'), mail(2, 'Bob', 'Two')]);
    state.unread.delete(1);
    await push.clearRead(user.id, acc.id);
    expect(clears()).toEqual([]);
    state.unread.delete(2);
    await push.clearRead(user.id, acc.id);
    expect(clears()).toEqual([{ type: 'clear', tags: [`${acc.id}:batch`] }]);
  });

  it('clears each notification only once', async () => {
    const { user, acc, push, clears } = setup();
    await push.notifyNewMail(user.id, acc.id, [mail(5, 'Alice', 'Hi')]);
    await push.clearRead(user.id, acc.id);
    await push.clearRead(user.id, acc.id);
    expect(clears()).toHaveLength(1);
  });

  it('does not ask the mail server anything when no notification is showing', async () => {
    const { user, acc, push, state } = setup();
    push.inboxChanged(user.id, acc.id);
    await new Promise((r) => setTimeout(r, 30));
    expect(state.checks).toBe(0);
  });

  it('checks once after a burst of inbox changes', async () => {
    const { user, acc, push, state, clears } = setup();
    await push.notifyNewMail(user.id, acc.id, [mail(5, 'Alice', 'Hi')]);
    for (let i = 0; i < 5; i++) push.inboxChanged(user.id, acc.id);
    await new Promise((r) => setTimeout(r, 50));
    expect(state.checks).toBe(1);
    expect(clears()).toHaveLength(1);
  });

  it('notices a message read elsewhere even when the mail server never reports the change', async () => {
    const { user, acc, push, state, clears } = setup({ unread: new Set([5]), recheckMs: 20 });
    await push.notifyNewMail(user.id, acc.id, [mail(5, 'Alice', 'Hi')]);
    await new Promise((r) => setTimeout(r, 50));
    expect(clears()).toEqual([]);
    state.unread.delete(5);
    await new Promise((r) => setTimeout(r, 80));
    expect(clears()).toEqual([{ type: 'clear', tags: [`${acc.id}:5`] }]);
  });

  it('stops checking on its own once no notification is showing', async () => {
    const { user, acc, push, state } = setup({ recheckMs: 20 });
    await push.notifyNewMail(user.id, acc.id, [mail(5, 'Alice', 'Hi')]);
    await new Promise((r) => setTimeout(r, 60));
    const checks = state.checks;
    expect(checks).toBe(1);
    await new Promise((r) => setTimeout(r, 80));
    expect(state.checks).toBe(checks);
  });

  it('never sends a clear message to Apple devices, which would revoke the subscription', async () => {
    const { s, user, acc, push, sent } = setup();
    s.addPushSubscription(user.id, { ...sub('iphone'), endpoint: 'https://web.push.apple.com/iphone' });
    await push.notifyNewMail(user.id, acc.id, [mail(5, 'Alice', 'Hi')]);
    sent.length = 0;
    await push.clearRead(user.id, acc.id);
    expect(sent.map((r) => r.subscription.endpoint)).toEqual(['https://fcm.googleapis.com/fcm/send/phone']);
  });

  it('closes a back-from-snooze notification once that message is read', async () => {
    const { user, acc, push, clears } = setup();
    await push.notifySnoozeEnded(user.id, acc.id, [{ uid: 9, uidValidity: '42', from: null, subject: 'Later' }]);
    await push.clearRead(user.id, acc.id);
    expect(clears()).toEqual([{ type: 'clear', tags: [`${acc.id}:9`] }]);
  });

  it("leaves snooze notifications alone when the messages' new UIDs are unknown", async () => {
    const { user, acc, push, clears, state } = setup();
    await push.notifySnoozeEnded(user.id, acc.id, [{ uid: null, uidValidity: null, from: null, subject: 'Later' }]);
    await push.clearRead(user.id, acc.id);
    expect(clears()).toEqual([]);
    expect(state.checks).toBe(0);
  });
});

describe('presence messages from the browser', () => {
  it('reads presence updates and ignores anything else', () => {
    expect(parseClientEvent('{"type":"presence","active":true}')).toEqual({ type: 'presence', active: true });
    expect(parseClientEvent(Buffer.from('{"type":"presence","active":false}'))).toEqual({ type: 'presence', active: false });
    expect(parseClientEvent('{"type":"presence","active":"yes"}')).toBeNull();
    expect(parseClientEvent('{"type":"other"}')).toBeNull();
    expect(parseClientEvent('not json')).toBeNull();
    expect(parseClientEvent('null')).toBeNull();
  });
});

describe('app icon badge count', () => {
  const folder = (path: string, unread: number | null, specialUse: 'inbox' | null = null) => ({
    path,
    name: path,
    delimiter: '/',
    parentPath: '',
    specialUse,
    selectable: true,
    unread,
    total: 0,
  });

  it("adds up the unread count of every account's inbox, ignoring other folders", () => {
    expect(
      inboxUnread([
        { accountId: 'a', folders: [folder('INBOX', 3, 'inbox'), folder('Archive', 50)] },
        { accountId: 'b', folders: [folder('Inbox', 4)] },
        { accountId: 'c', folders: [], error: 'offline' },
        { accountId: 'd', folders: [folder('INBOX', null)] },
      ]),
    ).toBe(7);
  });
});
