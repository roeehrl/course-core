import { BlockList, isIP } from 'node:net';
import type { FastifyRequest } from 'fastify';

/** At most this many proxy addresses may be trusted. */
export const MAX_TRUSTED_PROXIES = 16;
/** Only this many X-Forwarded-For hops, counted from the right, are examined. */
const MAX_FORWARDED_HOPS = 32;

/** Strips the IPv4-mapped IPv6 prefix a dual-stack socket reports (::ffff:127.0.0.1). */
function plain(address: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  return (mapped ? mapped[1]! : address).toLowerCase();
}
function family(address: string): 'ipv4' | 'ipv6' | undefined {
  const version = isIP(address);
  return version === 4 ? 'ipv4' : version === 6 ? 'ipv6' : undefined;
}

/**
 * Parses TRUSTED_PROXIES: a comma-separated list of exact IP addresses of reverse proxies
 * that set X-Forwarded-For. Empty or absent means none (the default): no proxy header is
 * ever read. Ranges, host names, wildcards and "trust everything" values are refused.
 */
export function parseTrustedProxies(value: string | readonly string[] | undefined): string[] {
  const items = value === undefined ? [] : typeof value === 'string' ? value.split(',').map(item => item.trim()).filter(Boolean) : [...value];
  if (items.length > MAX_TRUSTED_PROXIES) throw new Error(`At most ${MAX_TRUSTED_PROXIES} trusted proxies are supported.`);
  const seen = new Set<string>();
  for (const item of items) {
    const shown = JSON.stringify(String(item).slice(0, 100));
    if (typeof item !== 'string' || item.includes('/') || item.includes('*') || family(plain(item)) === undefined) {
      throw new Error(`Invalid trusted proxy ${shown}: list each proxy's exact IP address (no ranges, wildcards or host names).`);
    }
    const address = plain(item);
    if (seen.has(address)) throw new Error(`Trusted proxy ${shown} is listed twice.`);
    seen.add(address);
  }
  return [...seen];
}

const loopback = new BlockList();
loopback.addSubnet('127.0.0.0', 8, 'ipv4');
loopback.addAddress('::1', 'ipv6');

/** Where a request came from, for throttling only (never for authorization). */
export interface ClientSource {
  /** The address used as the per-source throttle key. */
  address: string;
  /** True when `address` does not identify one client: a loopback peer (a local process, or a
   * forwarder such as `tailscale serve --tcp` that every remote client arrives through) or a
   * trusted proxy that did not name the client. Throttles must not let one client exhaust a
   * shared source's budget for everyone. */
  shared: boolean;
}

/**
 * Resolves the client address of a request. The TCP peer is used unless it is one of the
 * configured trusted proxies, in which case X-Forwarded-For is read from the right: trusted
 * proxy hops are skipped and the first other address is the client. A malformed hop, or a
 * header naming only trusted proxies, leaves the proxy itself as the (shared) source.
 */
export function clientSourceResolver(trustedProxies: readonly string[] = []) {
  const trusted = new BlockList();
  for (const address of parseTrustedProxies(trustedProxies)) trusted.addAddress(address, family(address)!);
  const isTrusted = (address: string) => { const kind = family(address); return kind !== undefined && trusted.check(address, kind); };
  return (request: FastifyRequest): ClientSource => {
    const peer = plain(request.socket?.remoteAddress ?? request.ip ?? '');
    const kind = family(peer);
    if (kind === undefined) return { address: 'unknown', shared: true };
    const shared = loopback.check(peer, kind) || isTrusted(peer);
    if (!isTrusted(peer)) return { address: peer, shared };
    const header = request.headers['x-forwarded-for'];
    const value = Array.isArray(header) ? header.join(',') : header;
    if (typeof value !== 'string' || value.length > 4096) return { address: peer, shared };
    const hops = value.split(',').map(hop => plain(hop.trim())).slice(-MAX_FORWARDED_HOPS);
    for (let index = hops.length - 1; index >= 0; index--) {
      const hop = hops[index]!;
      if (family(hop) === undefined) break;
      if (isTrusted(hop)) continue;
      // A loopback hop named by a trusted proxy is still a shared source.
      return { address: hop, shared: loopback.check(hop, family(hop)!) };
    }
    return { address: peer, shared };
  };
}
