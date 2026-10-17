import { describe, expect, it } from 'vitest';
import {
  decideRemoteImages,
  displayDomain,
  dmarcFailed,
  domainMatches,
  findAllowedDomain,
  normaliseDomain,
  senderDomain,
} from '../src/mail/imageAllowlist.js';
import { parseRaw } from '../src/mail/parse.js';

const mail = (headers: string) =>
  parseRaw(Buffer.from(`${headers}\r\nSubject: hi\r\nContent-Type: text/html\r\n\r\n<img src="https://img.example.com/a.png">\r\n`));

describe('normaliseDomain', () => {
  it('lowercases and accepts the usual pasted forms', () => {
    expect(normaliseDomain('Example.COM')).toBe('example.com');
    expect(normaliseDomain('  news.example.com. ')).toBe('news.example.com');
    expect(normaliseDomain('@example.com')).toBe('example.com');
    expect(normaliseDomain('*.example.com')).toBe('example.com');
    expect(normaliseDomain('News@Example.com')).toBe('example.com');
  });

  it('maps Unicode and punycode spellings to the same ASCII form', () => {
    expect(normaliseDomain('Bücher.example')).toBe('xn--bcher-kva.example');
    expect(normaliseDomain('XN--BCHER-KVA.example')).toBe('xn--bcher-kva.example');
    expect(displayDomain('xn--bcher-kva.example')).toEqual({ domain: 'xn--bcher-kva.example', display: 'bücher.example' });
  });

  it('rejects things that are not domain names', () => {
    for (const bad of ['', 'com', 'localhost', '1.2.3.4', '[::1]', 'a..example.com', '-a.example.com', 'ex_ample.com', 'http://example.com', 'exa mple.com', `${'a'.repeat(64)}.com`, `${'a.'.repeat(130)}com`]) {
      expect(normaliseDomain(bad), bad).toBeNull();
    }
  });
});

describe('domain matching', () => {
  it('covers the domain itself and its subdomains', () => {
    expect(domainMatches('example.com', 'example.com')).toBe(true);
    expect(domainMatches('news.example.com', 'example.com')).toBe(true);
    expect(domainMatches('a.b.example.com', 'example.com')).toBe(true);
  });

  it('does not match lookalike suffixes or parents', () => {
    expect(domainMatches('badexample.com', 'example.com')).toBe(false);
    expect(domainMatches('example.com.evil.test', 'example.com')).toBe(false);
    expect(domainMatches('example.com', 'news.example.com')).toBe(false);
  });

  it('matches case-insensitively and across IDN spellings once normalised', async () => {
    const allow = [normaliseDomain('BÜCHER.example')!];
    expect(senderDomain(await mail('From: Shop <Shop@News.xn--bcher-kva.EXAMPLE>'))).toBe('news.xn--bcher-kva.example');
    expect(findAllowedDomain(senderDomain(await mail('From: shop@news.xn--bcher-kva.example'))!, allow)).toBe('xn--bcher-kva.example');
    expect(findAllowedDomain(senderDomain(await mail('From: shop@NEWS.Bücher.example'))!, allow)).toBe('xn--bcher-kva.example');
  });

  it('reports the most specific allowlist entry', () => {
    expect(findAllowedDomain('a.news.example.com', ['example.com', 'news.example.com'])).toBe('news.example.com');
    expect(findAllowedDomain('other.test', ['example.com'])).toBeNull();
  });
});

describe('DMARC guard', () => {
  const allow = ['example.com'];
  const decide = async (headers: string) => decideRemoteImages(await mail(headers), undefined, allow);

  it('auto-loads for allowlisted senders without Authentication-Results', async () => {
    expect(await decide('From: news@news.example.com')).toEqual({
      load: true,
      senderDomain: 'news.example.com',
      allowedBy: 'example.com',
      skipped: null,
    });
  });

  it('auto-loads on dmarc=pass and dmarc=none', async () => {
    expect((await decide('Authentication-Results: mx.example.net; dmarc=pass header.from=news.example.com\r\nFrom: news@news.example.com')).load).toBe(true);
    expect((await decide('Authentication-Results: mx.example.net; spf=pass; dmarc=none\r\nFrom: news@news.example.com')).load).toBe(true);
    expect((await decide('Authentication-Results: mx.example.net; none\r\nFrom: news@news.example.com')).load).toBe(true);
  });

  it('does not auto-load on dmarc=fail for the From domain', async () => {
    const folded = 'Authentication-Results: mx.example.net;\r\n dkim=fail header.d=example.com;\r\n DMARC=Fail (p=REJECT sp=REJECT dis=NONE) header.from="News.Example.com"\r\nFrom: news@news.example.com';
    expect(await decide(folded)).toEqual({ load: false, senderDomain: 'news.example.com', allowedBy: null, skipped: 'dmarc-fail' });
    expect((await decide('Authentication-Results: mx.example.net; dmarc=fail\r\nFrom: news@news.example.com')).skipped).toBe('dmarc-fail');
  });

  it('ignores a failure recorded for some other domain', async () => {
    const m = await mail('Authentication-Results: mx.example.net; dmarc=fail header.from=other.test\r\nFrom: news@example.com');
    expect(dmarcFailed(m, 'example.com')).toBe(false);
  });

  it('only trusts the topmost Authentication-Results header', async () => {
    // A forged result further down (added before our server saw it) doesn't count either way.
    const forgedPass = 'Authentication-Results: mx.example.net; dmarc=fail header.from=example.com\r\nAuthentication-Results: mx.example.net; dmarc=pass header.from=example.com\r\nFrom: a@example.com';
    expect((await decide(forgedPass)).load).toBe(false);
    const forgedFail = 'Authentication-Results: mx.example.net; dmarc=pass header.from=example.com\r\nAuthentication-Results: mx.example.net; dmarc=fail header.from=example.com\r\nFrom: a@example.com';
    expect((await decide(forgedFail)).load).toBe(true);
  });

  it('does not treat the authserv-id or comments as a result', async () => {
    const m = await mail('Authentication-Results: dmarc=fail.example.net (dmarc=fail); spf=pass\r\nFrom: a@example.com');
    expect(dmarcFailed(m, 'example.com')).toBe(false);
  });
});

describe('decideRemoteImages', () => {
  it('never auto-loads for senders that are not allowlisted', async () => {
    const m = await mail('From: a@badexample.com');
    expect(decideRemoteImages(m, undefined, ['example.com'])).toMatchObject({ load: false, allowedBy: null, senderDomain: 'badexample.com' });
  });

  it('lets an explicit choice override the allowlist', async () => {
    const m = await mail('From: a@example.com');
    expect(decideRemoteImages(m, false, ['example.com'])).toMatchObject({ load: false, allowedBy: null });
    expect(decideRemoteImages(m, true, [])).toMatchObject({ load: true, allowedBy: null });
  });

  it('copes with a missing or invalid From address', async () => {
    expect(decideRemoteImages(await mail('X-Nothing: 1'), undefined, ['example.com'])).toMatchObject({ load: false, senderDomain: null });
    expect(decideRemoteImages(await mail('From: a@[192.0.2.1]'), undefined, ['example.com'])).toMatchObject({ load: false, senderDomain: null });
  });
});
