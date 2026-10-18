import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';
import type { AccountView, MessageDetail } from '../../shared/types';
import { Reader } from '../src/components/Reader';
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
