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

export type SpecialUse = 'inbox' | 'sent' | 'drafts' | 'trash' | 'archive' | 'junk' | 'all' | 'flagged';

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
  attachments: AttachmentView[];
}

export type MessageAction =
  | { type: 'seen'; value: boolean }
  | { type: 'flagged'; value: boolean }
  | { type: 'move'; destination: string }
  | { type: 'archive' }
  | { type: 'delete' };

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

export interface Preferences {
  theme: 'system' | 'light' | 'dark';
  pageSize: number;
  markReadOnOpen: boolean;
  swipeLeft: SwipeAction;
  swipeRight: SwipeAction;
}

export interface Me {
  id: string;
  name: string;
  email: string;
  preferences: Preferences;
}

export type ServerEvent =
  | { type: 'mailbox'; accountId: string; folder: string }
  | { type: 'reset'; accountId: string; folder: string }
  | { type: 'hello' };
