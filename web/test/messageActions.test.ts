import { InfiniteQueryObserver, QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it } from 'vitest';
import type { ActionResult, ListResponse, MessageAction, MessageRef, MessageSummary } from '../../shared/types';
import { actionsPending, runMessageAction, type MessagesData } from '../src/messageActions';

const msg = (uid: number, over: Partial<MessageSummary> = {}): MessageSummary => ({
  accountId: 'a',
  folder: 'INBOX',
  uid,
  uidValidity: '1',
  messageId: `<m${uid}@x>`,
  inReplyTo: null,
  references: [],
  subject: `Message ${uid}`,
  from: [],
  to: [],
  date: new Date(Date.UTC(2026, 0, 1, 0, uid)).toISOString(),
  snippet: '',
  seen: false,
  flagged: false,
  answered: false,
  draft: false,
  hasAttachments: false,
  size: 100,
  ...over,
});
const ref = (m: MessageSummary): MessageRef => ({ accountId: m.accountId, folder: m.folder, uid: m.uid, uidValidity: m.uidValidity });
const page = (messages: MessageSummary[]): ListResponse => ({ messages, related: [], cursor: null, errors: [], reset: false });
const ok: ActionResult = { undo: [], permanent: false, createdFolders: [] };

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

/** A query client with one watched message list whose server answers are released by the test. */
function setup(initial: MessageSummary[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const answers: ReturnType<typeof deferred<ListResponse>>[] = [];
  const queryKey = ['messages', 'a', 'INBOX', '', false];
  qc.setQueryData<MessagesData>(queryKey, { pages: [page(initial)], pageParams: [null] });
  const observer = new InfiniteQueryObserver(qc, {
    queryKey,
    queryFn: () => {
      const d = deferred<ListResponse>();
      answers.push(d);
      return d.promise;
    },
    initialPageParam: null as string | null,
    getNextPageParam: () => null,
    staleTime: Infinity,
  });
  const stop = observer.subscribe(() => {});
  const shown = () => (qc.getQueryData<MessagesData>(queryKey)?.pages ?? []).flatMap((p) => p.messages.map((m) => m.subject));
  return { qc, answers, shown, stop };
}

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

describe('message actions', () => {
  it('keeps a quickly deleted second message hidden while a list fetched before its deletion arrives', async () => {
    const [a, b, c] = [msg(3), msg(2), msg(1)];
    const { qc, answers, shown, stop } = setup([a, b, c]);
    cleanup = stop;
    const errors: string[] = [];
    const del: MessageAction = { type: 'delete' };

    // Deleting A finishes and asks for the list again.
    await runMessageAction(qc, [ref(a)], del, { send: async () => ok, onError: (e) => errors.push(e) });
    await flush();
    expect(answers).toHaveLength(1);

    // B is deleted while that list is on its way; the server hasn't moved B yet.
    const sendB = deferred<ActionResult>();
    const deleting = runMessageAction(qc, [ref(b)], del, { send: () => sendB.promise, onError: (e) => errors.push(e) });
    await flush();
    expect(shown()).toEqual(['Message 1']);

    // The list answered before B's deletion went through still contains B: it must not come back.
    answers[0]!.resolve(page([b, c]));
    await flush();
    expect(shown()).toEqual(['Message 1']);

    sendB.resolve(ok);
    await deleting;
    await flush();
    expect(answers).toHaveLength(2);
    answers[1]!.resolve(page([c]));
    await flush();
    expect(shown()).toEqual(['Message 1']);
    expect(errors).toEqual([]);
  });

  it('fetches the list again only once the last of several running actions is done', async () => {
    const [a, b, c] = [msg(3), msg(2), msg(1)];
    const { qc, answers, stop } = setup([a, b, c]);
    cleanup = stop;
    const sends = [deferred<ActionResult>(), deferred<ActionResult>()];
    const first = runMessageAction(qc, [ref(a)], { type: 'archive' }, { send: () => sends[0]!.promise, onError: () => {} });
    const second = runMessageAction(qc, [ref(b)], { type: 'archive' }, { send: () => sends[1]!.promise, onError: () => {} });
    await flush();
    expect(actionsPending(qc)).toBe(true);

    sends[0]!.resolve(ok);
    await first;
    await flush();
    expect(answers).toHaveLength(0);
    expect(actionsPending(qc)).toBe(true);

    sends[1]!.resolve(ok);
    await second;
    await flush();
    expect(answers).toHaveLength(1);
    expect(actionsPending(qc)).toBe(false);
  });

  it('keeps a read mark made while an older list was on its way', async () => {
    const a = msg(1);
    const { qc, answers, shown, stop } = setup([a]);
    cleanup = stop;
    void qc.invalidateQueries({ queryKey: ['messages'] });
    await flush();
    const sending = runMessageAction(qc, [ref(a)], { type: 'seen', value: true }, { send: async () => ok, onError: () => {} });
    answers[0]!.resolve(page([a]));
    await sending;
    await flush();
    const data = qc.getQueryData<MessagesData>(['messages', 'a', 'INBOX', '', false])!;
    expect(data.pages[0]!.messages[0]!.seen).toBe(true);
    expect(shown()).toEqual(['Message 1']);
  });

  it('reports a failed action and fetches the list again to show what really happened', async () => {
    const a = msg(1);
    const { qc, answers, shown, stop } = setup([a]);
    cleanup = stop;
    const errors: string[] = [];
    const out = await runMessageAction(qc, [ref(a)], { type: 'delete' }, { send: async () => Promise.reject(new Error('Mail server unreachable')), onError: (e) => errors.push(e) });
    expect(out.ok).toBe(false);
    expect(errors).toEqual(['Mail server unreachable']);
    await flush();
    expect(answers).toHaveLength(1);
    answers[0]!.resolve(page([a]));
    await flush();
    expect(shown()).toEqual(['Message 1']);
    expect(actionsPending(qc)).toBe(false);
  });
});
