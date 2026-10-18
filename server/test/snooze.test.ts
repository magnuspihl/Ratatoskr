import crypto from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AccountFolders, AccountInput, MessageRef, ServerEvent } from '../../shared/types.js';
import { DEFAULT_PREFERENCES, Store } from '../src/db.js';
import type { MailService } from '../src/imap/mail.js';
import { SnoozeError, SnoozeService, MAX_SNOOZE_MS, parseSnoozeTime } from '../src/mail/snooze.js';
import { buildNotification, buildSnoozeNotification, type NotificationPayload, type WokenMail } from '../src/push/notify.js';
import { PushService } from '../src/push/service.js';
import type { PushRequest } from '../src/push/webpush.js';

const accountInput: AccountInput = {
  name: 'Work',
  displayName: 'Test User',
  email: 'user@example.com',
  color: '#3366ff',
  imap: { host: 'mail.example.com', port: 993, tls: 'tls', user: 'user@example.com', password: 'pw' },
  smtp: { host: 'mail.example.com', port: 465, tls: 'tls', user: 'user@example.com', password: 'pw' },
  appendSent: true,
};

const NOW = Date.parse('2026-10-18T12:00:00Z');

function setup() {
  const store = new Store(':memory:', crypto.randomBytes(32));
  const user = store.upsertUser('iss', 'u', '', '');
  const acc = store.createAccount(user.id, accountInput);
  return { store, user, acc };
}

describe('wake-up times the user can pick', () => {
  it('accepts a future ISO time with a time zone', () => {
    expect(parseSnoozeTime('2026-10-19T08:00:00.000Z', NOW)).toBe(Date.parse('2026-10-19T08:00:00Z'));
    expect(parseSnoozeTime('2026-10-19T08:00+02:00', NOW)).toBe(Date.parse('2026-10-19T06:00:00Z'));
  });

  it('refuses times in the past, now, more than five years ahead, or without a time zone', () => {
    expect(() => parseSnoozeTime('2026-10-18T11:59:00Z', NOW)).toThrow(/future/);
    expect(() => parseSnoozeTime(new Date(NOW).toISOString(), NOW)).toThrow(/future/);
    expect(() => parseSnoozeTime(new Date(NOW + MAX_SNOOZE_MS + 60_000).toISOString(), NOW)).toThrow(/five years/);
    expect(() => parseSnoozeTime('2026-10-19T08:00', NOW)).toThrow(SnoozeError);
    expect(() => parseSnoozeTime('tomorrow', NOW)).toThrow(SnoozeError);
    expect(() => parseSnoozeTime('2026-13-45T99:00:00Z', NOW)).toThrow(SnoozeError);
  });
});

describe('snoozes in the database', () => {
  it('remembers when each snoozed message returns, and snoozing again only changes the time', () => {
    const { store, user, acc } = setup();
    store.setSnoozes(user.id, acc.id, 'Snoozed', '7', [10, 11], NOW + 1000);
    store.setSnoozes(user.id, acc.id, 'Snoozed', '7', [11], NOW + 5000);
    expect(store.snoozesIn(user.id, acc.id, 'Snoozed', '7')).toEqual(new Map([[10, NOW + 1000], [11, NOW + 5000]]));
    expect(store.snoozesIn(user.id, acc.id, 'Snoozed', '8').size).toBe(0);
    expect(store.nextSnoozeDue()).toBe(NOW + 1000);
  });

  it('lists only the snoozes that are due, oldest first', () => {
    const { store, user, acc } = setup();
    store.setSnoozes(user.id, acc.id, 'Snoozed', '7', [3], NOW - 10);
    store.setSnoozes(user.id, acc.id, 'Snoozed', '7', [1], NOW - 500);
    store.setSnoozes(user.id, acc.id, 'Snoozed', '7', [2], NOW + 500);
    expect(store.dueSnoozes(NOW).map((s) => s.uid)).toEqual([1, 3]);
    expect(store.dueSnoozes(NOW)[0]).toEqual({ userId: user.id, accountId: acc.id, folder: 'Snoozed', uidValidity: '7', uid: 1, until: NOW - 500 });
  });

  it("keeps every user's snoozes to themselves and forgets them with the account", () => {
    const { store, user, acc } = setup();
    const other = store.upsertUser('iss', 'other', '', '');
    store.setSnoozes(other.id, acc.id, 'Snoozed', '7', [1], NOW);
    expect(store.nextSnoozeDue()).toBeNull();
    store.setSnoozes(user.id, acc.id, 'Snoozed', '7', [1, 2], NOW);
    expect(store.snoozesIn(other.id, acc.id, 'Snoozed', '7').size).toBe(0);
    store.deleteSnoozes(other.id, acc.id, 'Snoozed', '7', [1]);
    store.deleteSnoozes(user.id, acc.id, 'Snoozed', '7', [2]);
    expect([...store.snoozesIn(user.id, acc.id, 'Snoozed', '7').keys()]).toEqual([1]);
    store.deleteAccount(user.id, acc.id);
    expect(store.nextSnoozeDue()).toBeNull();
  });
});

describe('back-from-snooze notification text', () => {
  const account = { id: 'acc1', name: 'Work' };
  const woken = (uid: number | null, from: string, subject: string): WokenMail => ({
    uid,
    uidValidity: uid === null ? null : '42',
    from: { name: from, address: `${from.toLowerCase()}@example.com` },
    subject,
  });

  it('names sender and subject and opens the message, replacing any new-mail notification for it', () => {
    const n = buildSnoozeNotification(account, [woken(9, 'Alice', 'Call the plumber')], 'full')!;
    expect(n).toEqual({ title: 'Back from snooze', body: 'Alice: Call the plumber', tag: 'acc1:9', url: '/?open=acc1.42.9' });
    const asNewMail = buildNotification(account, [{ uid: 9, uidValidity: '42', from: null, subject: '' }], 'full')!;
    expect(n.tag).toBe(asNewMail.tag);
  });

  it('opens the inbox when the server did not report where the message went', () => {
    expect(buildSnoozeNotification(account, [woken(null, 'Alice', 'Hi')], 'full')).toMatchObject({ url: '/', tag: 'acc1:snooze' });
  });

  it('summarises several messages and never reveals sender or subject with minimal content', () => {
    const many = [woken(1, 'Alice', 'Secret one'), woken(2, 'Bob', 'Secret two')];
    expect(buildSnoozeNotification(account, many, 'full')).toMatchObject({
      title: '2 snoozed messages are back',
      body: 'Alice: Secret one\nBob: Secret two',
      url: '/',
    });
    for (const n of [buildSnoozeNotification(account, many, 'minimal')!, buildSnoozeNotification(account, many.slice(0, 1), 'minimal')!]) {
      expect(JSON.stringify(n)).not.toMatch(/Alice|Bob|Secret/);
      expect(n.body).toBe('Work');
    }
    expect(buildSnoozeNotification(account, [], 'full')).toBeNull();
  });

  it('is sent to the devices of a user who is away, but not while the app is in front of them', async () => {
    for (const active of [false, true]) {
      const { store, user, acc } = setup();
      store.setPreferences(user.id, DEFAULT_PREFERENCES);
      const ecdh = crypto.createECDH('prime256v1');
      ecdh.generateKeys();
      store.addPushSubscription(user.id, {
        endpoint: 'https://fcm.googleapis.com/fcm/send/phone',
        keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') },
      });
      const sent: PushRequest[] = [];
      const push = new PushService({ store, transport: async (r) => (sent.push(r), 'sent'), isUserActive: () => active, onNoSubscriptions: () => {} });
      await push.notifySnoozeEnded(user.id, acc.id, [woken(9, 'Alice', 'Call the plumber')]);
      expect(sent.map((r) => (r.payload as NotificationPayload).title)).toEqual(active ? [] : ['Back from snooze']);
    }
  });
});

describe('the snooze scheduler', () => {
  afterEach(() => vi.useRealTimers());

  type Resurface = MailService['resurface'];
  function service(opts: { resurface?: Resurface; folders?: AccountFolders; now?: () => number } = {}) {
    const { store, user, acc } = setup();
    const events: ServerEvent[] = [];
    const notified: WokenMail[][] = [];
    const calls: { ref: MessageRef; markUnread: boolean }[] = [];
    let clock = NOW;
    const defaultResurface: Resurface = async (_u, ref, o) => {
      o.beforeAppend?.(`<m${ref.uid}@example.com>`);
      return { uid: 100 + ref.uid, uidValidity: '1', messageId: `<m${ref.uid}@example.com>`, from: { name: 'Alice', address: 'alice@example.com' }, subject: `Subject ${ref.uid}` };
    };
    const mail = {
      resurface: vi.fn<Resurface>(async (u, ref, o) => {
        calls.push({ ref: { accountId: ref.accountId, folder: ref.folder, uidValidity: ref.uidValidity, uid: ref.uid }, markUnread: o.markUnread });
        return (opts.resurface ?? defaultResurface)(u, ref, o);
      }),
      listFolders: vi.fn(async () => opts.folders ?? { accountId: acc.id, folders: [], error: 'offline' }),
      ensureFolder: vi.fn(async () => ({ path: 'Snoozed', created: false })),
      assertUidValidity: vi.fn(async () => {}),
      applyAction: vi.fn(async () => ({ undo: { accountId: acc.id, folder: 'Snoozed', uidValidity: '7', uids: [50, 51], restoreTo: 'INBOX' }, permanent: false, createdFolder: null })),
    };
    const svc = new SnoozeService({
      store,
      mail: mail as unknown as MailService,
      maxMessageBytes: 1e6,
      notify: (_u, _a, m) => void notified.push(m),
      emit: (_u, e) => void events.push(e),
      now: opts.now ?? (() => clock),
    });
    return { store, user, acc, svc, mail, events, notified, calls, tick: (ms: number) => (clock += ms) };
  }

  it('puts due messages back into the inbox as unread, forgets them, updates open browsers and notifies once', async () => {
    const { store, user, acc, svc, events, notified, calls } = service();
    store.setSnoozes(user.id, acc.id, 'Snoozed', '7', [1, 2], NOW - 1000);
    store.setSnoozes(user.id, acc.id, 'Snoozed', '7', [3], NOW + 60_000);
    await svc.runDue();
    expect(calls.map((c) => [c.ref.uid, c.markUnread])).toEqual([[1, true], [2, true]]);
    expect([...store.snoozesIn(user.id, acc.id, 'Snoozed', '7').keys()]).toEqual([3]);
    expect(events).toContainEqual({ type: 'mailbox', accountId: acc.id, folder: 'INBOX' });
    expect(events).toContainEqual({ type: 'mailbox', accountId: acc.id, folder: 'Snoozed' });
    expect(events.filter((e) => e.type === 'snoozeEnded')).toEqual([
      { type: 'snoozeEnded', accountId: acc.id, uid: 101, uidValidity: '1', from: 'Alice', subject: 'Subject 1' },
      { type: 'snoozeEnded', accountId: acc.id, uid: 102, uidValidity: '1', from: 'Alice', subject: 'Subject 2' },
    ]);
    expect(notified).toHaveLength(1);
    expect(notified[0]!.map((m) => m.uid)).toEqual([101, 102]);
  });

  it('quietly forgets a snooze whose message was moved away or deleted meanwhile', async () => {
    const { store, user, acc, svc, notified, events } = service({ resurface: async () => null });
    store.setSnoozes(user.id, acc.id, 'Snoozed', '7', [1], NOW - 1);
    await svc.runDue();
    expect(store.nextSnoozeDue()).toBeNull();
    expect(notified).toEqual([]);
    expect(events).toEqual([]);
  });

  it('keeps the snooze when the mail server is unreachable and retries later instead of hammering it', async () => {
    let fail = true;
    const s = service({
      resurface: async (_u, ref) => {
        if (fail) throw new Error('connection refused');
        return { uid: 5, uidValidity: '1', messageId: null, from: null, subject: `s${ref.uid}` };
      },
    });
    s.store.setSnoozes(s.user.id, s.acc.id, 'Snoozed', '7', [1], NOW - 1);
    await s.svc.runDue();
    await s.svc.runDue();
    expect(s.mail.resurface).toHaveBeenCalledTimes(1);
    expect(s.store.nextSnoozeDue()).toBe(NOW - 1);
    fail = false;
    s.tick(31_000);
    await s.svc.runDue();
    expect(s.mail.resurface).toHaveBeenCalledTimes(2);
    expect(s.store.nextSnoozeDue()).toBeNull();
    expect(s.notified).toHaveLength(1);
  });

  it('drops snoozes whose Snoozed folder was deleted in another mail app', async () => {
    const s = service({ resurface: async () => Promise.reject(new Error('Cannot open folder')) });
    s.mail.listFolders.mockResolvedValue({ accountId: s.acc.id, folders: [] });
    s.store.setSnoozes(s.user.id, s.acc.id, 'Snoozed', '7', [1], NOW - 1);
    await s.svc.runDue();
    expect(s.store.nextSnoozeDue()).toBeNull();
  });

  it('tells a snoozed message coming back apart from real new mail, for a while', async () => {
    const s = service();
    s.store.setSnoozes(s.user.id, s.acc.id, 'Snoozed', '7', [1], NOW - 1);
    await s.svc.runDue();
    expect(s.svc.wasResurfaced(s.user.id, s.acc.id, '<m1@example.com>')).toBe(true);
    expect(s.svc.wasResurfaced(s.user.id, s.acc.id, '<other@example.com>')).toBe(false);
    expect(s.svc.wasResurfaced('someone-else', s.acc.id, '<m1@example.com>')).toBe(false);
    expect(s.svc.wasResurfaced(s.user.id, s.acc.id, null)).toBe(false);
    s.tick(11 * 60_000);
    expect(s.svc.wasResurfaced(s.user.id, s.acc.id, '<m1@example.com>')).toBe(false);
  });

  it('moves snoozed messages to the Snoozed folder and remembers them at their new UIDs', async () => {
    const s = service();
    const until = new Date(NOW + 3600_000).toISOString();
    const res = await s.svc.snooze(s.user.id, { accountId: s.acc.id, folder: 'INBOX', uidValidity: '1' }, [5, 6], until);
    expect(s.mail.applyAction).toHaveBeenCalledWith(s.user.id, s.acc.id, 'INBOX', '1', [5, 6], { type: 'move', destination: 'Snoozed' });
    expect(res.undo).toMatchObject({ folder: 'Snoozed', uids: [50, 51], restoreTo: 'INBOX' });
    expect(s.store.snoozesIn(s.user.id, s.acc.id, 'Snoozed', '7')).toEqual(new Map([[50, NOW + 3600_000], [51, NOW + 3600_000]]));
  });

  it('only changes the time when a message in the Snoozed folder is snoozed again', async () => {
    const s = service();
    s.store.setSnoozes(s.user.id, s.acc.id, 'Snoozed', '7', [50], NOW + 1000);
    await s.svc.snooze(s.user.id, { accountId: s.acc.id, folder: 'Snoozed', uidValidity: '7' }, [50], new Date(NOW + 9000).toISOString());
    expect(s.mail.applyAction).not.toHaveBeenCalled();
    expect(s.store.snoozesIn(s.user.id, s.acc.id, 'Snoozed', '7').get(50)).toBe(NOW + 9000);
  });

  it('refuses to snooze into the past without touching the messages', async () => {
    const s = service();
    await expect(s.svc.snooze(s.user.id, { accountId: s.acc.id, folder: 'INBOX', uidValidity: '1' }, [5], new Date(NOW - 1).toISOString())).rejects.toThrow(SnoozeError);
    expect(s.mail.applyAction).not.toHaveBeenCalled();
  });

  it('unsnooze puts a message back right away, keeps it read, and sends no notification', async () => {
    const s = service();
    s.store.setSnoozes(s.user.id, s.acc.id, 'Snoozed', '7', [50], NOW + 1000);
    await s.svc.unsnooze(s.user.id, { accountId: s.acc.id, folder: 'Snoozed', uidValidity: '7' }, [50]);
    expect(s.calls).toEqual([{ ref: { accountId: s.acc.id, folder: 'Snoozed', uidValidity: '7', uid: 50 }, markUnread: false }]);
    expect(s.store.nextSnoozeDue()).toBeNull();
    expect(s.notified).toEqual([]);
  });

  it('wakes a message right on time, without waiting for a periodic check', async () => {
    vi.useFakeTimers({ now: NOW });
    const s = service({ now: () => Date.now() });
    s.mail.applyAction.mockResolvedValueOnce({ undo: { accountId: s.acc.id, folder: 'Snoozed', uidValidity: '7', uids: [50], restoreTo: 'INBOX' }, permanent: false, createdFolder: null });
    s.svc.start();
    await vi.advanceTimersByTimeAsync(10);
    await s.svc.snooze(s.user.id, { accountId: s.acc.id, folder: 'INBOX', uidValidity: '1' }, [5], new Date(NOW + 5_000).toISOString());
    await vi.advanceTimersByTimeAsync(4_000);
    expect(s.mail.resurface).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_200);
    expect(s.calls.map((c) => c.ref.uid)).toEqual([50]);
    await s.svc.stop();
  });
});
