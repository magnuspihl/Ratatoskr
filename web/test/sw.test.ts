import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(import.meta.dirname, '../public/sw.js'), 'utf8');

interface FakeNotification {
  title: string;
  tag?: string;
  closed: boolean;
  close(): void;
}

/** Runs sw.js against a minimal fake service worker global and lets the test deliver pushes. */
function serviceWorker() {
  const listeners = new Map<string, (event: unknown) => void>();
  const notifications: FakeNotification[] = [];
  const badges: (number | 'cleared')[] = [];
  const self = {
    location: { origin: 'https://mail.example.com' },
    addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn),
    registration: {
      showNotification: async (title: string, opts: { tag?: string }) => {
        const n: FakeNotification = { title, tag: opts.tag, closed: false, close: () => (n.closed = true) };
        notifications.push(n);
      },
      getNotifications: async () => notifications.filter((n) => !n.closed),
    },
    navigator: {
      setAppBadge: async (n: number) => void badges.push(n),
      clearAppBadge: async () => void badges.push('cleared'),
    },
    clients: { claim: async () => {} },
  };
  vm.runInNewContext(source, { self, URL });
  const push = async (payload: unknown) => {
    let done: Promise<unknown> = Promise.resolve();
    listeners.get('push')!({ data: { json: () => payload }, waitUntil: (p: Promise<unknown>) => (done = p) });
    await done;
  };
  const open = () => notifications.filter((n) => !n.closed).map((n) => n.tag);
  return { push, open, badges };
}

describe('service worker', () => {
  it('shows a notification for new mail and sets the app badge', async () => {
    const sw = serviceWorker();
    await sw.push({ title: 'Alice', body: 'Hi', tag: 'acc1:7', url: '/', badge: 3 });
    expect(sw.open()).toEqual(['acc1:7']);
    expect(sw.badges).toEqual([3]);
  });

  it('closes only the notifications named in a clear message, without showing anything', async () => {
    const sw = serviceWorker();
    await sw.push({ title: 'Alice', body: 'Hi', tag: 'acc1:7', url: '/' });
    await sw.push({ title: 'Bob', body: 'Yo', tag: 'acc1:8', url: '/' });
    await sw.push({ type: 'clear', tags: ['acc1:7', 'acc1:99'], badge: 1 });
    expect(sw.open()).toEqual(['acc1:8']);
    expect(sw.badges).toEqual([1]);
  });

  it('clears the app badge when a clear message says nothing is unread', async () => {
    const sw = serviceWorker();
    await sw.push({ type: 'clear', tags: ['acc1:7'], badge: 0 });
    expect(sw.badges).toEqual(['cleared']);
    expect(sw.open()).toEqual([]);
  });
});
