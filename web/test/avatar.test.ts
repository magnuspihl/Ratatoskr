import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Avatar } from '../src/components/Avatar';
import { avatarUrl } from '../src/util';

const render = (address: { name: string; address: string } | undefined, photos: boolean) =>
  renderToStaticMarkup(createElement(Avatar, { address, photos }));

describe('contact pictures', () => {
  it('are requested from our own server, never from Gravatar directly', () => {
    expect(avatarUrl(' Ada@Example.org ')).toBe('/api/avatar?email=ada%40example.org');
  });

  it('are not requested for things that are not addresses', () => {
    expect(avatarUrl('')).toBeNull();
    expect(avatarUrl('undisclosed-recipients')).toBeNull();
  });

  it('show over the initials, which stay visible until the picture loads', () => {
    const html = render({ name: 'Ada Lovelace', address: 'ada@example.org' }, true);
    expect(html).toContain('AL');
    expect(html).toContain('<img src="/api/avatar?email=ada%40example.org"');
  });

  it('are left out when turned off in Settings, leaving just the initials', () => {
    const html = render({ name: 'Ada Lovelace', address: 'ada@example.org' }, false);
    expect(html).toContain('AL');
    expect(html).not.toContain('<img');
  });

  it('are not requested for a message without a sender', () => {
    expect(render(undefined, true)).not.toContain('<img');
  });
});
