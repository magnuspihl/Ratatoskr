import crypto from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp, type App } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { Keyring } from '../src/crypto.js';
import { DEFAULT_PREFERENCES, Store } from '../src/db.js';
import { AvatarService, avatarCandidates, emailHash, isFreemail, normaliseEmail, organisationDomain } from '../src/net/avatars.js';
import { RemoteImageError, type RemoteImage } from '../src/net/remoteImages.js';

const png = (bytes = 10): RemoteImage => ({ contentType: 'image/png', body: Buffer.alloc(bytes, 7) });
const noSrv = async () => {
  throw new Error('ENOTFOUND');
};
const notFound = () => Promise.reject(new RemoteImageError('Upstream status 404'));
const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

describe('sender addresses', () => {
  it('are lowercased and trimmed before hashing, as Gravatar expects', () => {
    expect(normaliseEmail('  Ada.Lovelace@Example.COM ')).toBe('ada.lovelace@example.com');
    expect(emailHash('ada@example.com')).toBe(sha256('ada@example.com'));
  });

  it('rejects things that are not addresses', () => {
    for (const bad of ['', 'ada', 'ada@', '@example.com', 'ada@localhost', 'a b@example.com', 'ada@10.0.0.1', `${'x'.repeat(250)}@example.com`]) {
      expect(normaliseEmail(bad), bad).toBeNull();
    }
  });
});

describe('organisation domains', () => {
  it('drops mail subdomains, also under country-code second-level domains', () => {
    expect(organisationDomain('github.com')).toBe('github.com');
    expect(organisationDomain('mail.notifications.github.com')).toBe('github.com');
    expect(organisationDomain('news.bbc.co.uk')).toBe('bbc.co.uk');
    expect(organisationDomain('example.de')).toBe('example.de');
  });

  it('recognises free mail providers, whose logo says nothing about the sender', () => {
    for (const d of ['gmail.com', 'outlook.com', 'yahoo.co.uk', 'gmx.de', 'icloud.com', 'proton.me']) expect(isFreemail(d), d).toBe(true);
    for (const d of ['github.com', 'bbc.co.uk', 'mail.example.org']) expect(isFreemail(d), d).toBe(false);
  });
});

describe('picture sources', () => {
  it('tries Gravatar, then Libravatar, then the sender organisation’s icon', async () => {
    const hash = sha256('ada@mail.example.org');
    expect(await avatarCandidates('ada@mail.example.org', noSrv)).toEqual([
      `https://gravatar.com/avatar/${hash}?s=160&d=404`,
      `https://seccdn.libravatar.org/avatar/${hash}?s=160&d=404`,
      'https://example.org/apple-touch-icon.png',
      'https://www.example.org/apple-touch-icon.png',
    ]);
  });

  it('does not use a free mail provider’s icon as a person’s picture', async () => {
    const urls = await avatarCandidates('ada@gmail.com', noSrv);
    expect(urls).toHaveLength(2);
    expect(urls.some((u) => u.includes('gmail.com'))).toBe(false);
  });

  it('asks the sender domain’s own Libravatar server when it announces one', async () => {
    const resolveSrv = vi.fn(async () => [
      { name: 'backup.example.org', port: 443, priority: 20, weight: 0 },
      { name: 'avatars.example.org', port: 443, priority: 10, weight: 0 },
      { name: 'odd-port.example.org', port: 8443, priority: 0, weight: 0 },
    ]);
    const urls = await avatarCandidates('ada@example.org', resolveSrv);
    expect(resolveSrv).toHaveBeenCalledWith('_avatars-sec._tcp.example.org');
    expect(urls[1]).toBe(`https://avatars.example.org/avatar/${sha256('ada@example.org')}?s=160&d=404`);
  });
});

describe('picture lookup', () => {
  it('returns the first source that has a picture', async () => {
    const fetchImage = vi.fn((url: string) => (url.includes('libravatar') ? Promise.resolve(png(3)) : notFound()));
    const service = new AvatarService({ fetchImage, resolveSrv: noSrv });
    expect(await service.lookup('u1', 'ada@example.org')).toEqual(png(3));
    expect(fetchImage).toHaveBeenCalledTimes(2);
  });

  it('returns nothing when no source has a picture, and remembers that', async () => {
    const fetchImage = vi.fn(notFound);
    const service = new AvatarService({ fetchImage, resolveSrv: noSrv });
    expect(await service.lookup('u1', 'ada@example.org')).toBeNull();
    const calls = fetchImage.mock.calls.length;
    expect(await service.lookup('u1', 'ada@example.org')).toBeNull();
    expect(fetchImage).toHaveBeenCalledTimes(calls);
  });

  it('looks a sender up once when a conversation shows them several times', async () => {
    const fetchImage = vi.fn(async () => png());
    const service = new AvatarService({ fetchImage, resolveSrv: noSrv });
    await Promise.all([1, 2, 3].map(() => service.lookup('u1', 'ada@example.org')));
    await service.lookup('u1', 'ada@example.org');
    expect(fetchImage).toHaveBeenCalledTimes(1);
  });

  it('stops trying further sources once the time is up', async () => {
    const fetchImage = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 30));
      throw new RemoteImageError('Upstream timeout', 504);
    });
    const service = new AvatarService({ fetchImage, resolveSrv: noSrv, deadlineMs: 10 });
    expect(await service.lookup('u1', 'ada@example.org')).toBeNull();
    expect(fetchImage).toHaveBeenCalledTimes(1);
  });
});

describe('contact pictures preference', () => {
  it('is on by default for new users', () => {
    expect(DEFAULT_PREFERENCES.contactPhotos).toBe(true);
  });
});

describe('GET /api/avatar', () => {
  let ctx: App | undefined;
  afterEach(async () => {
    await ctx?.app.close();
    ctx = undefined;
  });

  async function setup(fetchImage: (url: string) => Promise<RemoteImage>) {
    const config = loadConfig({ NODE_ENV: 'test', RATATOSKR_SECRET_KEY: crypto.randomBytes(48).toString('base64') });
    const store = new Store(':memory:', new Keyring(config.secretKey).credentialKey);
    ctx = await buildApp(config, { store, logger: false, avatars: new AvatarService({ fetchImage, resolveSrv: noSrv }) });
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/auth/password/register',
      payload: { username: 'alice', password: 'a long password' },
      headers: { 'x-ratatoskr': '1' },
    });
    const c = res.cookies.find((c) => c.name === 'rk_session')!;
    const cookie = `${c.name}=${c.value}`;
    const get = (email: string) => ctx!.app.inject({ url: `/api/avatar?email=${encodeURIComponent(email)}`, headers: { cookie } });
    return { cookie, get };
  }

  it('serves the sender’s picture as an image the browser may keep for a day', async () => {
    const { get } = await setup(async () => png(4));
    const res = await get('Ada@Example.org');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['cache-control']).toBe('private, max-age=86400');
    expect(res.rawPayload).toEqual(png(4).body);
  });

  it('answers 404 when there is no picture, so the initials stay', async () => {
    const { get } = await setup(notFound);
    expect((await get('ada@example.org')).statusCode).toBe(404);
  });

  it('rejects something that is not an address without looking anything up', async () => {
    const fetchImage = vi.fn(async () => png());
    const { get } = await setup(fetchImage);
    expect((await get('not an address')).statusCode).toBe(400);
    expect(fetchImage).not.toHaveBeenCalled();
  });

  it('looks nothing up when the user turned contact pictures off', async () => {
    const fetchImage = vi.fn(async () => png());
    const { cookie, get } = await setup(fetchImage);
    const saved = await ctx!.app.inject({
      method: 'PUT',
      url: '/api/preferences',
      payload: { ...DEFAULT_PREFERENCES, contactPhotos: false },
      headers: { cookie, 'x-ratatoskr': '1' },
    });
    expect(saved.statusCode).toBe(200);
    const res = await get('ada@example.org');
    expect(res.statusCode).toBe(404);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(fetchImage).not.toHaveBeenCalled();
  });

  it('is only available to signed-in users', async () => {
    await setup(async () => png());
    expect((await ctx!.app.inject({ url: '/api/avatar?email=ada%40example.org' })).statusCode).toBe(401);
  });
});
