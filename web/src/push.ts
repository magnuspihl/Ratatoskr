import { api } from './api';

/**
 * Web Push on this device: registering the service worker (web/public/sw.js), subscribing and
 * unsubscribing, and keeping the server's copy of the subscription current.
 */

export type PushAvailability =
  /** Can be turned on. */
  | 'available'
  /** iPhone/iPad in a Safari tab: push only works once the app is added to the Home Screen. */
  | 'needs-install'
  /** The user blocked notifications for this site; only the browser settings can undo that. */
  | 'denied'
  | 'unsupported';

export interface PushEnvironment {
  secure: boolean;
  serviceWorker: boolean;
  pushManager: boolean;
  notification: boolean;
  permission: NotificationPermission | null;
  ios: boolean;
  standalone: boolean;
}

/** iPadOS reports itself as a Mac; touch support tells them apart. */
export function isIosDevice(userAgent: string, maxTouchPoints: number): boolean {
  return /iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1);
}

export function pushAvailability(env: PushEnvironment): PushAvailability {
  if (env.ios && !env.standalone) return 'needs-install';
  if (!env.secure || !env.serviceWorker || !env.pushManager || !env.notification) return 'unsupported';
  if (env.permission === 'denied') return 'denied';
  return 'available';
}

export function currentEnvironment(): PushEnvironment {
  const nav = navigator as Navigator & { standalone?: boolean };
  return {
    secure: window.isSecureContext,
    serviceWorker: 'serviceWorker' in navigator,
    pushManager: 'PushManager' in window,
    notification: 'Notification' in window,
    permission: 'Notification' in window ? Notification.permission : null,
    ios: isIosDevice(navigator.userAgent, navigator.maxTouchPoints ?? 0),
    standalone: window.matchMedia('(display-mode: standalone)').matches || nav.standalone === true,
  };
}

function b64uToBytes(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Whether a subscription was made with this server key (it changes with RATATOSKR_SECRET_KEY). */
export function sameServerKey(subscriptionKey: ArrayBuffer | null | undefined, serverKey: string): boolean {
  if (!subscriptionKey) return false;
  const a = new Uint8Array(subscriptionKey);
  const b = b64uToBytes(serverKey);
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Where a tapped notification should take the app: a path on this origin, nothing else.
 * Returns null for anything that isn't one.
 */
export function notificationTarget(url: unknown, origin: string): string | null {
  if (typeof url !== 'string') return null;
  try {
    const u = new URL(url, origin);
    return u.origin === origin ? u.pathname + u.search : null;
  } catch {
    return null;
  }
}

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  void navigator.serviceWorker.register('/sw.js').catch(() => {});
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  return (await navigator.serviceWorker.getRegistration()) ?? null;
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await registration();
  return (await reg?.pushManager.getSubscription()) ?? null;
}

async function save(sub: PushSubscription) {
  const json = sub.toJSON();
  await api.addPushSubscription({ endpoint: json.endpoint!, keys: { p256dh: json.keys!.p256dh!, auth: json.keys!.auth! } });
}

/** Ask for permission and subscribe. Must be called from a tap/click (iOS requires it). */
export async function enablePush(): Promise<void> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error(permission === 'denied' ? 'Notifications are blocked for this site in your browser settings.' : 'Permission was not granted.');
  registerServiceWorker();
  const reg = await navigator.serviceWorker.ready;
  const { publicKey } = await api.pushKey();
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameServerKey(sub.options.applicationServerKey, publicKey)) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(publicKey) });
  await save(sub);
}

export async function disablePush(): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  await api.removePushSubscription(sub.endpoint).catch(() => {});
  await sub.unsubscribe();
}

/**
 * On app start: re-send this device's subscription so the server has it under the logged-in user,
 * and replace it if the server key changed since it was made.
 */
export async function syncPush(): Promise<void> {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const sub = await currentSubscription();
  if (!sub) return;
  const { publicKey } = await api.pushKey();
  if (sameServerKey(sub.options.applicationServerKey, publicKey)) await save(sub);
  else await enablePush();
}

/** Show the unread count on the app icon (installed apps; ignored where unsupported). */
export function setAppBadge(count: number) {
  const nav = navigator as Navigator & { setAppBadge?: (n: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
  if (!nav.setAppBadge || !nav.clearAppBadge) return;
  void (count > 0 ? nav.setAppBadge(count) : nav.clearAppBadge()).catch(() => {});
}
