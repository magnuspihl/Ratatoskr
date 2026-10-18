import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';
import { groupConversations } from '../../shared/threads';
import type { AccountView, MessageDetail, MessageSummary } from '../../shared/types';
import { Reader, replyTarget } from '../src/components/Reader';
import type { ResolvedTheme } from '../src/hooks';
import { refKey } from '../src/util';

// MessageFrame reads theme colours from the page; give it an empty stylesheet.
beforeAll(() => {
  const g = globalThis as Record<string, unknown>;
  g.document ??= { documentElement: {} };
  g.getComputedStyle ??= () => ({ getPropertyValue: () => '' });
});

const account = { id: 'a1', name: 'Work', color: '#3b82f6' } as AccountView;
const ref = { accountId: 'a1', folder: 'INBOX', uid: 7, uidValidity: '1' };
const noop = () => {};

function detail(overrides: Partial<MessageDetail> = {}): MessageDetail {
  return {
    ...ref,
    subject: 'Hello',
    from: [{ name: 'Ada Lovelace', address: 'ada@example.com' }],
    to: [{ name: 'Magnus', address: 'me@example.com' }],
    cc: [],
    bcc: [],
    replyTo: [],
    date: '2026-10-18T10:00:00Z',
    seen: true,
    flagged: false,
    text: 'Hi',
    html: '<p>Hi</p>',
    css: '',
    htmlStyle: 'simple',
    remoteContentBlocked: 0,
    remoteContentLoaded: false,
    senderDomain: { domain: 'example.com', display: 'example.com' },
    imagesAllowedBy: null,
    allowlistSkipped: null,
    attachments: [],
    ...overrides,
  } as MessageDetail;
}

function render(d: MessageDetail, opts: { multipleAccounts?: boolean; theme?: ResolvedTheme } = {}) {
  const qc = new QueryClient();
  qc.setQueryData(['message', refKey(ref), 'auto'], d);
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: qc },
      createElement(Reader, {
        openRef: ref,
        account,
        multipleAccounts: opts.multipleAccounts ?? false,
        folders: undefined,
        isDrafts: false,
        theme: opts.theme ?? 'dark',
        markReadOnOpen: false,
        onAction: noop,
        snoozeSignal: 0,
        onReply: noop,
        onMailto: noop,
        onBack: noop,
        onGone: noop,
      }),
    ),
  );
}

describe('message header', () => {
  it('makes the sender name a collapsed toggle that reveals the email address', () => {
    const html = render(detail());
    expect(html).toMatch(/<button class="msg-from-toggle" aria-expanded="false"[^>]*>Ada Lovelace<\/button>/);
    expect(html).toContain('ada@example.com');
  });

  it('shows no account dot or account name when the user has a single account', () => {
    const html = render(detail());
    expect(html).not.toContain('acct-dot');
    expect(html).not.toContain('Work');
    expect(html).toMatch(/class="msg-to "/);
  });

  it('shows a dot in the account colour next to the recipient when the user has several accounts', () => {
    const html = render(detail(), { multipleAccounts: true });
    expect(html).toMatch(/class="msg-to has-account"/);
    expect(html).toMatch(/<span class="acct-dot" style="background:#3b82f6" title="Work">/);
  });
});

describe('message notices', () => {
  it('keeps the blocked-images notice while remote images are not loaded', () => {
    const html = render(detail({ remoteContentBlocked: 3 }));
    expect(html).toContain('Remote content blocked (3)');
    expect(html).toContain('Load images');
  });

  it('shows no image message once images were loaded automatically from an allowed sender', () => {
    const html = render(
      detail({ remoteContentLoaded: true, imagesAllowedBy: { domain: 'example.com', display: 'example.com' } }),
    );
    expect(html).not.toContain('class="notice"');
    expect(html).not.toMatch(/Images loaded|remote image|downloaded by the server/i);
  });

  it('puts the Dark/Paper and HTML/Text toggles together in one row', () => {
    const html = render(detail());
    const row = html.match(/<div class="view-toggles">(.*?)<\/div><\/div>/)?.[1] ?? '';
    expect(row).toContain('Dark');
    expect(row).toContain('Paper');
    expect(html).toMatch(/<div class="view-toggles">.*Paper.*HTML.*Text/);
  });

  it('shows only the HTML/Text toggle in the light theme', () => {
    const html = render(detail(), { theme: 'light' });
    expect(html).toContain('view-toggles');
    expect(html).not.toContain('Paper');
    expect(html).toContain('>Text<');
  });
});

describe('conversation view', () => {
  const summary = (over: Partial<MessageSummary>): MessageSummary => ({
    ...ref,
    messageId: '<orig@example.com>',
    inReplyTo: null,
    references: [],
    subject: 'Hello',
    from: [{ name: 'Ada Lovelace', address: 'ada@example.com' }],
    to: [{ name: 'Magnus', address: 'me@example.com' }],
    date: '2026-10-18T09:00:00Z',
    snippet: 'Are you free for lunch?',
    seen: true,
    flagged: false,
    answered: false,
    draft: false,
    hasAttachments: false,
    size: 100,
    ...over,
  });
  const original = summary({});
  const myReplyRef = { accountId: 'a1', folder: 'Sent', uid: 3, uidValidity: '9' };
  const myReply = summary({
    ...myReplyRef,
    messageId: '<reply@example.com>',
    inReplyTo: '<orig@example.com>',
    references: ['<orig@example.com>'],
    subject: 'Re: Hello',
    from: [{ name: 'Magnus', address: 'me@example.com' }],
    to: [{ name: 'Ada Lovelace', address: 'ada@example.com' }],
    date: '2026-10-18T09:30:00Z',
    snippet: 'Sure, noon works',
  });

  function renderConversation() {
    const conversation = groupConversations([original], [myReply])[0]!;
    const qc = new QueryClient();
    qc.setQueryData(['message', refKey(myReplyRef), 'auto'], detail({ ...myReplyRef, subject: 'Re: Hello', from: myReply.from, to: myReply.to, text: 'Sure, noon works', html: null }));
    return renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(Reader, {
          openRef: ref,
          conversation,
          account,
          multipleAccounts: false,
          folders: undefined,
          isDrafts: false,
          theme: 'dark',
          markReadOnOpen: false,
          onAction: noop,
          snoozeSignal: 0,
          onReply: noop,
          onMailto: noop,
          onBack: noop,
          onGone: noop,
        }),
      ),
    );
  }

  it('shows the original and my reply from Sent together, under the first subject with a count', () => {
    const html = renderConversation();
    expect(html).toMatch(/<h2 class="msg-subject">Hello<span class="msg-count">2<\/span><\/h2>/);
  });

  it('folds the older message to a summary line and opens the newest one', () => {
    const html = renderConversation();
    expect(html).toMatch(/<button class="msg-card msg-collapsed"[^>]*>.*Ada Lovelace.*Are you free for lunch\?/);
    expect(html).toContain('Sure, noon works');
    expect(html.indexOf('Are you free for lunch?')).toBeLessThan(html.indexOf('Sure, noon works'));
  });

  it('replies to the newest message of the conversation', () => {
    const conversation = groupConversations([original], [myReply])[0]!;
    expect(replyTarget(conversation, ref)).toEqual(myReplyRef);
    expect(replyTarget(undefined, ref)).toEqual(ref);
  });
});

describe('message bodies', () => {
  it('links email addresses in plain-text mail as mailto: links that stay in the app', () => {
    const html = render(detail({ html: null, text: 'Write to ada@example.com' }));
    expect(html).toContain('<a href="mailto:ada@example.com">ada@example.com</a>');
  });

  it('points mailto: links in HTML mail at the app’s composer', () => {
    const html = render(detail({ html: '<a href="mailto:ada@example.com" target="_blank" rel="noopener noreferrer nofollow">Ada</a>' }));
    expect(html).toContain('/?mailto=mailto%3Aada%40example.com');
    expect(html).not.toMatch(/href=&quot;mailto:/);
  });
});
