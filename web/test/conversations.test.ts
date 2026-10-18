import { describe, expect, it } from 'vitest';
import { baseSubject, groupConversations, participants, rowOf } from '../../shared/threads';
import type { MessageSummary } from '../../shared/types';

let nextUid = 1;
function msg(over: Partial<MessageSummary> & { id: string }): MessageSummary {
  const { id, ...rest } = over;
  return {
    accountId: 'a1',
    folder: 'INBOX',
    uid: nextUid++,
    uidValidity: '1',
    messageId: `<${id}@example.com>`,
    inReplyTo: null,
    references: [],
    subject: 'Lunch',
    from: [{ name: 'Ada Lovelace', address: 'ada@example.com' }],
    to: [{ name: 'Me', address: 'me@example.com' }],
    date: '2026-10-18T10:00:00Z',
    snippet: '',
    seen: true,
    flagged: false,
    answered: false,
    draft: false,
    hasAttachments: false,
    size: 100,
    ...rest,
  };
}

const ME = { name: 'Me', address: 'me@example.com' };
const replyTo = (parent: MessageSummary, over: Partial<MessageSummary> & { id: string }) =>
  msg({
    subject: `Re: ${parent.subject}`,
    inReplyTo: parent.messageId,
    references: [...parent.references, parent.messageId!],
    ...over,
  });

describe('grouping messages into conversations', () => {
  it('shows an inbox message and my reply from Sent (sent with another client) as one row', () => {
    const original = msg({ id: 'orig', date: '2026-10-18T09:00:00Z' });
    const myReply = replyTo(original, { id: 'reply', folder: 'Sent', from: [ME], date: '2026-10-18T09:30:00Z' });
    const rows = groupConversations([original], [myReply]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.uid).toBe(original.uid);
    expect(rows[0]!.thread.map((m) => m.messageId)).toEqual(['<orig@example.com>', '<reply@example.com>']);
    // Archiving or deleting the row leaves the copy in Sent alone.
    expect(rows[0]!.members.map((m) => m.uid)).toEqual([original.uid]);
  });

  it('merges replies in the same folder into the row of the newest one, keeping list order', () => {
    const a = msg({ id: 'a', subject: 'Plans', date: '2026-10-17T08:00:00Z' });
    const other = msg({ id: 'other', subject: 'Invoice', date: '2026-10-18T07:00:00Z' });
    const b = replyTo(a, { id: 'b', date: '2026-10-18T08:00:00Z', seen: false });
    const rows = groupConversations([b, other, a]);
    expect(rows.map((r) => r.subject)).toEqual(['Re: Plans', 'Invoice']);
    expect(rows[0]!.members).toHaveLength(2);
    expect(rows[0]!.thread.map((m) => m.messageId)).toEqual(['<a@example.com>', '<b@example.com>']);
  });

  it('shows a conversation as unread while any of its listed messages is unread', () => {
    const a = msg({ id: 'a', seen: true });
    const b = replyTo(a, { id: 'b', seen: false });
    expect(groupConversations([b, a])[0]!.seen).toBe(false);
    expect(groupConversations([{ ...b, seen: true }, a])[0]!.seen).toBe(true);
  });

  it('ignores whether my reply in Sent is read when deciding if the row is unread', () => {
    const a = msg({ id: 'a', seen: true });
    const mine = replyTo(a, { id: 'b', folder: 'Sent', from: [ME], seen: false });
    expect(groupConversations([a], [mine])[0]!.seen).toBe(true);
  });

  it('links replies from clients that only set In-Reply-To', () => {
    const a = msg({ id: 'a' });
    const b = msg({ id: 'b', subject: 'RE: Lunch', inReplyTo: a.messageId });
    expect(groupConversations([b, a])).toHaveLength(1);
  });

  it('keeps messages apart when the subject changed, like Gmail', () => {
    const a = msg({ id: 'a', subject: 'Lunch' });
    const b = msg({ id: 'b', subject: 'Re: Something else entirely', inReplyTo: a.messageId, references: [a.messageId!] });
    expect(groupConversations([b, a])).toHaveLength(2);
  });

  it('never merges messages from different accounts', () => {
    const a = msg({ id: 'a', accountId: 'a1' });
    const copy = { ...a, accountId: 'a2', uid: 99 };
    expect(groupConversations([a, copy])).toHaveLength(2);
  });

  it('leaves out related messages whose conversation has nothing in the listing', () => {
    const a = msg({ id: 'a' });
    const stray = msg({ id: 'stray', subject: 'Other', folder: 'Sent' });
    const rows = groupConversations([a], [stray]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.thread).toHaveLength(1);
  });

  it('counts an older message from the listed folder as part of the conversation, for actions too', () => {
    const old = msg({ id: 'old' });
    const recent = replyTo(old, { id: 'recent' });
    const rows = groupConversations([recent], [old]);
    expect(rows[0]!.members.map((m) => m.messageId)).toEqual(['<recent@example.com>', '<old@example.com>']);
  });

  it('shows a message that is both in Sent and in the inbox (mail to yourself) only once', () => {
    const inbox = msg({ id: 'self', from: [ME] });
    const sent = { ...inbox, folder: 'Sent', uid: 500 };
    const rows = groupConversations([inbox], [sent]);
    expect(rows[0]!.thread).toHaveLength(1);
    expect(rows[0]!.thread[0]!.folder).toBe('INBOX');
  });

  it('does not group drafts', () => {
    const a = msg({ id: 'a', folder: 'Drafts' });
    const b = replyTo(a, { id: 'b', folder: 'Drafts' });
    expect(groupConversations([b, a], [], { group: false })).toHaveLength(2);
  });

  it('lists a message only once when it shows up on two pages', () => {
    const a = msg({ id: 'a' });
    expect(groupConversations([a, { ...a }])).toHaveLength(1);
  });

  it('finds the row of any message in a conversation', () => {
    const a = msg({ id: 'a' });
    const mine = replyTo(a, { id: 'b', folder: 'Sent', from: [ME] });
    const rows = groupConversations([a], [mine]);
    expect(rowOf(rows, mine)).toBe(rows[0]);
    expect(rowOf(rows, { ...a, uid: 12345 })).toBeUndefined();
  });
});

describe('conversation subjects', () => {
  it('ignores reply and forward prefixes in several languages, repeated, and list tags', () => {
    expect(baseSubject('Re: RE: Fwd: Lunch')).toBe('lunch');
    expect(baseSubject('AW: SV: Antw: Lunch')).toBe('lunch');
    expect(baseSubject('[team] Re: Lunch ')).toBe('lunch');
    expect(baseSubject('Re[2]: Lunch')).toBe('lunch');
    expect(baseSubject('Rebooking')).toBe('rebooking');
  });
});

describe('conversation participants', () => {
  const isMe = (a: string) => a === 'me@example.com';

  it('shows the full name when only one person wrote', () => {
    expect(participants([msg({ id: 'a' }), msg({ id: 'b' })], isMe)).toBe('Ada Lovelace');
  });

  it('shows first names and "me" in the order people first wrote', () => {
    const thread = [msg({ id: 'a' }), msg({ id: 'b', from: [ME] }), msg({ id: 'c' })];
    expect(participants(thread, isMe)).toBe('Ada, me');
  });

  it('uses the part before the @ for senders without a name', () => {
    const thread = [msg({ id: 'a', from: [{ name: '', address: 'bob@example.com' }] }), msg({ id: 'b', from: [ME] })];
    expect(participants(thread, isMe)).toBe('bob, me');
  });

  it('shortens long lists to the first and the last people', () => {
    const people = ['Ada A', 'Bob B', 'Cy C', 'Di D'].map((name, i) => msg({ id: `p${i}`, from: [{ name, address: `${i}@example.com` }] }));
    expect(participants(people, isMe)).toBe('Ada, Bob … Di');
  });
});
