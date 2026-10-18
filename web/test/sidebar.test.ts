import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';
import type { AccountView } from '../../shared/types';
import { Sidebar } from '../src/components/Sidebar';

beforeAll(() => {
  (globalThis as { localStorage?: unknown }).localStorage ??= { getItem: () => null, setItem: () => {} };
});

const account = { id: 'a1', name: 'Work', color: '#3b82f6' } as AccountView;
const noop = () => {};

function render(folders: Parameters<typeof Sidebar>[0]['folders']) {
  return renderToStaticMarkup(
    createElement(Sidebar, {
      accounts: [account],
      folders,
      sel: { accountId: 'a1', folder: 'INBOX' },
      onSelect: noop,
      onCompose: noop,
      onAccounts: noop,
      onSettings: noop,
      onLogout: noop,
      userLabel: 'me',
      onCloseNav: noop,
    }),
  );
}

describe('Sidebar', () => {
  it('shows a spinner instead of "Loading…" text while an account\'s folders load', () => {
    const html = render(undefined);
    expect(html).toContain('class="nav-loading"');
    expect(html).toContain('class="spinner"');
    expect(html).not.toContain('Loading…');
  });

  it('hides the spinner once the folders have arrived', () => {
    const html = render([{ accountId: 'a1', folders: [] }] as never);
    expect(html).not.toContain('nav-loading');
  });
});
