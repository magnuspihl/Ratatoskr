// Types shared between the server API and the web client.

export type TlsMode = 'tls' | 'starttls' | 'none';

export interface AccountInput {
  name: string;
  displayName: string;
  email: string;
  color: string;
  imap: { host: string; port: number; tls: TlsMode; user: string; password?: string };
  smtp: { host: string; port: number; tls: TlsMode; user: string; password?: string };
  appendSent: boolean;
}

/** Account as returned to the browser. Never contains passwords. */
export interface AccountView {
  id: string;
  name: string;
  displayName: string;
  email: string;
  color: string;
  imap: { host: string; port: number; tls: TlsMode; user: string };
  smtp: { host: string; port: number; tls: TlsMode; user: string };
  appendSent: boolean;
}

export type SpecialUse = 'inbox' | 'sent' | 'drafts' | 'trash' | 'archive' | 'junk' | 'all' | 'flagged' | 'snoozed';

export interface FolderView {
  path: string;
  name: string;
  delimiter: string;
  parentPath: string;
  specialUse: SpecialUse | null;
  selectable: boolean;
  unread: number | null;
  total: number | null;
}

export interface AccountFolders {
  accountId: string;
  folders: FolderView[];
  error?: string;
}

export interface Address {
  name: string;
  address: string;
}

export interface MessageSummary {
  accountId: string;
  folder: string;
  uid: number;
  uidValidity: string;
  messageId: string | null;
  subject: string;
  from: Address[];
  to: Address[];
  date: string;
  snippet: string;
  seen: boolean;
  flagged: boolean;
  answered: boolean;
  draft: boolean;
  hasAttachments: boolean;
  size: number;
  /** ISO time the message returns to the inbox, while it waits in the Snoozed folder. */
  snoozedUntil?: string;
}

/** Per-account position in a mailbox stream. */
export interface AccountCursor {
  uidValidity: string;
  /** Messages with UID strictly below this value have not been returned yet. */
  beforeUid: number;
  done: boolean;
}

export interface ListResponse {
  messages: MessageSummary[];
  /** Opaque cursor for the next page, or null when every source is exhausted. */
  cursor: string | null;
  /** Accounts that could not be queried, with a human-readable reason. */
  errors: { accountId: string; error: string }[];
  /** True if the server noticed a UIDVALIDITY change and the client should reload. */
  reset: boolean;
}

export interface AttachmentView {
  index: number;
  filename: string;
  mimeType: string;
  size: number;
  inline: boolean;
  contentId: string | null;
}

export type HtmlStyle = 'simple' | 'designed';

export interface MessageDetail {
  accountId: string;
  folder: string;
  uid: number;
  uidValidity: string;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  subject: string;
  from: Address[];
  to: Address[];
  cc: Address[];
  /** Only present on drafts and sent copies that kept the header. */
  bcc: Address[];
  replyTo: Address[];
  date: string;
  seen: boolean;
  flagged: boolean;
  text: string | null;
  /** Sanitized HTML document body, safe to put in a sandboxed iframe srcdoc. */
  html: string | null;
  /** Sanitized stylesheet from the message's own <style> elements. */
  css: string;
  htmlStyle: HtmlStyle | null;
  remoteContentBlocked: number;
  remoteContentLoaded: boolean;
  /** Domain of the From address, if it has a valid one. */
  senderDomain: DomainName | null;
  /** Allowlisted domain that made remote images load automatically. */
  imagesAllowedBy: DomainName | null;
  /** The sender is allowlisted, but the message failed DMARC so images were not loaded automatically. */
  allowlistSkipped: 'dmarc-fail' | null;
  attachments: AttachmentView[];
  /** ISO time the message returns to the inbox, while it waits in the Snoozed folder. */
  snoozedUntil?: string;
}

/** A domain in its stored ASCII (punycode) form and its human-readable form. */
export interface DomainName {
  domain: string;
  display: string;
}

export type MessageAction =
  | { type: 'seen'; value: boolean }
  | { type: 'flagged'; value: boolean }
  | { type: 'move'; destination: string }
  | { type: 'archive' }
  | { type: 'delete' }
  /** Move to the Snoozed folder until `until` (ISO time), then back to the inbox. Again on a snoozed message: change the time. */
  | { type: 'snooze'; until: string }
  /** Back to the inbox right away. */
  | { type: 'unsnooze' };

/** Where moved messages ended up, so the move can be undone by moving them back. */
export interface UndoInfo {
  accountId: string;
  folder: string;
  uidValidity: string;
  uids: number[];
  restoreTo: string;
}

export interface ActionResult {
  undo: UndoInfo[];
  /** True if messages were permanently deleted (expunged from Trash). */
  permanent: boolean;
  /** Folders that had to be created (e.g. a missing Archive). */
  createdFolders: string[];
}

export type SwipeAction = 'none' | 'delete' | 'archive' | 'toggleRead' | 'toggleFlag';

export interface MessageRef {
  accountId: string;
  folder: string;
  uid: number;
  uidValidity: string;
}

export interface ComposePayload {
  accountId: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  html: string;
  inReplyTo: string | null;
  references: string[];
  /** Attachments carried over from an existing message (forward / draft edit). */
  forwardFrom: (MessageRef & { indices: number[] }) | null;
  /** Existing draft to replace when saving or sending. */
  replaceDraft: MessageRef | null;
  /** Message being replied to; flagged as answered after sending. */
  answering: MessageRef | null;
}

export interface SendResult {
  messageId: string;
  savedToSent: boolean;
  warning: string | null;
}

export interface DraftResult {
  draft: MessageRef | null;
}

/** full: sender and subject in phone notifications; minimal: only "New message" and the account. */
export type NotificationContent = 'full' | 'minimal';

export interface Preferences {
  theme: 'system' | 'light' | 'dark';
  pageSize: number;
  markReadOnOpen: boolean;
  swipeLeft: SwipeAction;
  swipeRight: SwipeAction;
  notificationContent: NotificationContent;
}

/** A browser's Web Push subscription, as produced by PushSubscription.toJSON(). */
export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface Me {
  id: string;
  name: string;
  email: string;
  preferences: Preferences;
  /** Signs in with a username and password, so can change it in Settings. */
  hasPassword: boolean;
}

/** Login options shown on the sign-in page (GET /auth/methods). */
export interface AuthMethods {
  password: boolean;
  /** A new password account can be created right now. */
  registration: boolean;
  oidc: { label: string } | null;
  dev: boolean;
}

export type ServerEvent =
  | { type: 'mailbox'; accountId: string; folder: string }
  | { type: 'reset'; accountId: string; folder: string }
  /** A snoozed message is back in the inbox (uid is null if the server couldn't tell). */
  | { type: 'snoozeEnded'; accountId: string; uidValidity: string; uid: number | null; from: string; subject: string }
  | { type: 'hello' };

/**
 * Sent by the browser over the WebSocket: whether the app is in front of the user right now
 * (visible and focused). Phone notifications are skipped while any session is active.
 */
export type ClientEvent = { type: 'presence'; active: boolean };
