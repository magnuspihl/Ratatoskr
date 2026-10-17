import dns from 'node:dns';
import net from 'node:net';
import ipaddr from 'ipaddr.js';

/**
 * Returns true only for globally routable unicast addresses. Everything else (loopback, RFC1918,
 * link-local, CGNAT, ULA, multicast, documentation, reserved, IPv4-mapped/translated forms of
 * those, ...) is treated as internal.
 */
export function isPublicAddress(ip: string): boolean {
  if (!ipaddr.isValid(ip)) return false;
  let addr = ipaddr.parse(ip);
  if (addr.kind() === 'ipv6') {
    const v6 = addr as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) addr = v6.toIPv4Address();
    else {
      const range = v6.range();
      // NAT64 / 6to4 / Teredo can smuggle an IPv4 destination; refuse them outright.
      if (range !== 'unicast') return false;
      return true;
    }
  }
  return (addr as ipaddr.IPv4).range() === 'unicast';
}

export class BlockedAddressError extends Error {
  readonly code = 'EBLOCKED';
  constructor(host: string) {
    super(`Refusing to connect to internal address for ${host}`);
  }
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;

/**
 * A drop-in `lookup` for net/http/tls that resolves the name and refuses non-public results.
 * Because the socket connects to the address this function returns, there is no window for DNS
 * rebinding between "check" and "connect".
 */
export function publicOnlyLookup(hostname: string, options: dns.LookupOptions, callback: LookupCallback): void {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, '');
    const list = (addresses as dns.LookupAddress[]).filter((a) => isPublicAddress(a.address));
    if (list.length === 0) return callback(new BlockedAddressError(hostname), '');
    if (options.all) return callback(null, list);
    callback(null, list[0]!.address, list[0]!.family);
  });
}

/** Resolve a host and check that every address it resolves to is public. */
export async function assertPublicHost(host: string): Promise<void> {
  const ips = net.isIP(host) ? [host] : (await dns.promises.lookup(host, { all: true })).map((a) => a.address);
  if (ips.length === 0 || !ips.every(isPublicAddress)) throw new BlockedAddressError(host);
}
