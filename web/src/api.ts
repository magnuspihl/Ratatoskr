import type {
  AccountFolders,
  ActionResult,
  AccountInput,
  AccountView,
  ComposePayload,
  DraftResult,
  ListResponse,
  Me,
  MessageAction,
  MessageDetail,
  MessageRef,
  Preferences,
  SendResult,
} from '../../shared/types';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly stale = false,
  ) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'x-ratatoskr': '1' };
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(url, { method, headers, body: payload, credentials: 'same-origin' });
  if (!res.ok) {
    let msg = res.statusText;
    let stale = false;
    try {
      const j = (await res.json()) as { error?: string; stale?: boolean };
      msg = j.error ?? msg;
      stale = !!j.stale;
    } catch {
      /* not JSON */
    }
    throw new ApiError(msg, res.status, stale);
  }
  return (await res.json()) as T;
}

export const refQuery = (r: MessageRef) =>
  `accountId=${encodeURIComponent(r.accountId)}&folder=${encodeURIComponent(r.folder)}&uid=${r.uid}&uidValidity=${r.uidValidity}`;

export interface MailboxSel {
  /** null = unified inbox */
  accountId: string | null;
  folder: string;
}

export const api = {
  me: () => request<Me>('GET', '/api/me'),
  savePreferences: (p: Preferences) => request<Preferences>('PUT', '/api/preferences', p),
  logout: () => request<{ redirect: string }>('POST', '/auth/logout'),

  accounts: () => request<AccountView[]>('GET', '/api/accounts'),
  testAccount: (account: AccountInput, id?: string) => request<{ ok: true }>('POST', '/api/accounts/test', { account, id }),
  createAccount: (a: AccountInput) => request<AccountView>('POST', '/api/accounts', a),
  updateAccount: (id: string, a: AccountInput) => request<AccountView>('PUT', `/api/accounts/${encodeURIComponent(id)}`, a),
  deleteAccount: (id: string) => request<{ ok: true }>('DELETE', `/api/accounts/${encodeURIComponent(id)}`),

  folders: () => request<AccountFolders[]>('GET', '/api/folders'),

  messages: (sel: MailboxSel, cursor: string | null, q: string) => {
    const p = new URLSearchParams();
    if (sel.accountId) {
      p.set('accountId', sel.accountId);
      p.set('folder', sel.folder);
    }
    if (cursor) p.set('cursor', cursor);
    if (q) p.set('q', q);
    return request<ListResponse>('GET', `/api/messages?${p.toString()}`);
  },
  message: (r: MessageRef, remote: boolean) => request<MessageDetail>('GET', `/api/message?${refQuery(r)}${remote ? '&remote=1' : ''}`),
  attachmentUrl: (r: MessageRef, index: number) => `/api/attachment?${refQuery(r)}&index=${index}`,
  action: (messages: MessageRef[], action: MessageAction) => request<ActionResult>('POST', '/api/messages/actions', { messages, action }),

  send: (payload: ComposePayload, files: File[]) => request<SendResult>('POST', '/api/send', composeForm(payload, files)),
  saveDraft: (payload: ComposePayload, files: File[]) => request<DraftResult>('POST', '/api/drafts', composeForm(payload, files)),
  recipients: (q: string) => request<{ name: string; address: string }[]>('GET', `/api/recipients?q=${encodeURIComponent(q)}`),
};

function composeForm(payload: ComposePayload, files: File[]): FormData {
  const form = new FormData();
  form.append('payload', JSON.stringify(payload));
  for (const f of files) form.append('files', f, f.name);
  return form;
}
