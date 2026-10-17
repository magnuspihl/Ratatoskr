import { describe, expect, it } from 'vitest';
import { assertPublicHost, isPublicAddress } from '../src/net/ssrf.js';
import { fetchRemoteImage, proxyableUrl, signProxyUrl, verifyProxySignature } from '../src/net/imageProxy.js';
import { Keyring } from '../src/crypto.js';

describe('isPublicAddress', () => {
  it.each([
    '127.0.0.1', '127.1.2.3', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254',
    '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '192.0.2.1', '198.51.100.1', '203.0.113.1',
    '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1',
    '::ffff:169.254.169.254', '64:ff9b::7f00:1', '2002:7f00:1::', '2001:db8::1', 'not-an-ip',
  ])('rejects %s', (ip) => expect(isPublicAddress(ip)).toBe(false));

  it.each(['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111', '::ffff:8.8.8.8'])('accepts %s', (ip) =>
    expect(isPublicAddress(ip)).toBe(true),
  );
});

describe('assertPublicHost', () => {
  it('rejects loopback names and literals', async () => {
    await expect(assertPublicHost('localhost')).rejects.toThrow(/internal/);
    await expect(assertPublicHost('127.0.0.1')).rejects.toThrow(/internal/);
    await expect(assertPublicHost('::1')).rejects.toThrow(/internal/);
  });
});

describe('image proxy', () => {
  it('only accepts http(s) URLs on default ports without credentials', () => {
    expect(proxyableUrl('https://img.example.com/a.png')).not.toBeNull();
    expect(proxyableUrl('http://img.example.com:80/a.png')).not.toBeNull();
    expect(proxyableUrl('https://img.example.com:8443/a.png')).toBeNull();
    expect(proxyableUrl('http://img.example.com:6379/')).toBeNull();
    expect(proxyableUrl('https://user:pw@img.example.com/a.png')).toBeNull();
    expect(proxyableUrl('file:///etc/passwd')).toBeNull();
    expect(proxyableUrl('gopher://img.example.com/')).toBeNull();
    expect(proxyableUrl('data:image/png;base64,AAAA')).toBeNull();
  });

  it('refuses to fetch internal addresses (no request is made)', async () => {
    await expect(fetchRemoteImage('http://127.0.0.1/x.png')).rejects.toThrow(/internal/);
    await expect(fetchRemoteImage('http://localhost/x.png')).rejects.toThrow(/internal/);
    await expect(fetchRemoteImage('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(/internal/);
    await expect(fetchRemoteImage('http://[::1]/x.png')).rejects.toThrow(/internal/);
    await expect(fetchRemoteImage('http://[::ffff:7f00:1]/x.png')).rejects.toThrow(/internal/);
  });

  it('signs URLs per user', () => {
    const key = new Keyring('a-fake-test-secret-that-is-long-enough-1234').signingKey;
    const url = signProxyUrl(key, 'user-1', 'https://img.example.com/a.png');
    const params = new URL(url, 'https://mail.example.com').searchParams;
    expect(verifyProxySignature(key, 'user-1', params.get('u')!, params.get('s')!)).toBe(true);
    expect(verifyProxySignature(key, 'user-2', params.get('u')!, params.get('s')!)).toBe(false);
    expect(verifyProxySignature(key, 'user-1', 'https://img.example.com/b.png', params.get('s')!)).toBe(false);
  });
});
