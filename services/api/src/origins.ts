import { BlockList } from 'node:net';
import type { FastifyRequest } from 'fastify';

/** At most this many additional origins may be trusted next to the primary one. */
export const MAX_ADDITIONAL_ORIGINS = 8;

/** Addresses Tailscale assigns to tailnet nodes: 100.64.0.0/10 and fd7a:115c:a1e0::/48. */
const tailscaleAddresses = new BlockList();
tailscaleAddresses.addSubnet('100.64.0.0', 10, 'ipv4');
tailscaleAddresses.addSubnet('fd7a:115c:a1e0::', 48, 'ipv6');
/** True for a URL host that is a literal Tailscale address (IPv6 in brackets). */
export function isTailscaleAddress(hostname: string): boolean {
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) return tailscaleAddresses.check(hostname, 'ipv4');
  const v6 = /^\[([0-9a-f:]+)\]$/.exec(hostname)?.[1];
  try { return v6 !== undefined && v6.startsWith('fd7a:115c:a1e0:') && tailscaleAddresses.check(v6, 'ipv6'); } catch { return false; }
}

/** Operator choices that relax origin validation. Default: none relaxed. */
export interface OriginPolicy {
  /** ALLOW_INSECURE_ORIGINS: when true, any exact `http://host:port` origin may be added,
   * not only a literal Tailscale address. Exact matching, CSRF tokens, SameSite=Strict
   * and authentication are unaffected. Off by default. */
  allowInsecure?: boolean;
}

/** Parses ALLOW_INSECURE_ORIGINS: absent or exactly `false` is off, exactly `true` is on. */
export function parseAllowInsecureOrigins(value: string | undefined): boolean {
  if (value === undefined || value === '' || value === 'false') return false;
  if (value === 'true') return true;
  throw new Error('ALLOW_INSECURE_ORIGINS must be exactly "true" or "false".');
}

/**
 * Validates one additional trusted origin. It must be written exactly as a browser
 * sends it in the Origin header: lower-case host, no default port, no credentials,
 * path, query, fragment or wildcard. It must be https, with one exception: plain
 * http to a literal Tailscale address with an explicit port (tailnet traffic is
 * WireGuard-encrypted end to end, though such a page is still not a browser secure
 * context, so it gets no Secure cookies and no passkeys). Every other http origin is
 * refused; the only other http origin the API serves is a loopback primary origin.
 * When the operator sets `allowInsecure`, any http origin with an explicit port is
 * accepted as well (still exact, with no credentials, path or wildcard).
 */
export function parseAdditionalOrigin(value: string, policy: OriginPolicy = {}): string {
  const fail = (reason: string) => { throw new Error(`Invalid additional origin ${JSON.stringify(value.slice(0, 200))}: ${reason}`); };
  if (typeof value !== 'string' || value.length === 0 || value.length > 255) fail('expected an https origin of at most 255 characters.');
  if (value.includes('*')) fail('wildcards are not supported; list each origin exactly.');
  let url: URL;
  try { url = new URL(value); } catch { return fail('not a URL.'); }
  if (url.protocol === 'http:') {
    if (!policy.allowInsecure && !isTailscaleAddress(url.hostname)) fail('only https origins, or http to a literal Tailscale address (100.64.0.0/10, fd7a:115c:a1e0::/48), may be added (ALLOW_INSECURE_ORIGINS=true lifts this).');
    if (!url.port) fail('an http origin needs an explicit port.');
  } else if (url.protocol !== 'https:') fail('only https origins, or http to a literal Tailscale address, may be added.');
  if (url.username || url.password) fail('credentials are not allowed.');
  if (!url.hostname) fail('a host name is required.');
  if (url.origin !== value) fail(`write it exactly as the origin ${url.origin} (no path, trailing slash, query, default port or upper case).`);
  return url.origin;
}

/** Parses ADDITIONAL_ORIGINS: comma-separated exact https origins; empty means none. */
export function parseAdditionalOrigins(value: string | readonly string[] | undefined, primary?: string, policy: OriginPolicy = {}): string[] {
  const items = value === undefined ? [] : typeof value === 'string' ? value.split(',').map(item => item.trim()).filter(Boolean) : [...value];
  if (items.length > MAX_ADDITIONAL_ORIGINS) throw new Error(`At most ${MAX_ADDITIONAL_ORIGINS} additional origins are supported.`);
  const origins = items.map(item => parseAdditionalOrigin(item, policy));
  const seen = new Set(primary === undefined ? [] : [primary]);
  for (const origin of origins) {
    if (seen.has(origin)) throw new Error(`Additional origin ${origin} is listed twice or repeats the primary origin.`);
    seen.add(origin);
  }
  return origins;
}

export interface TrustedOrigins {
  primary: string;
  all: readonly string[];
  /** The request's Origin header when it is exactly a trusted origin. */
  matched(request: FastifyRequest): string | undefined;
  /** The trusted origin this request was addressed to: its Origin header when trusted,
   * else the single trusted origin whose host equals the Host header (same-origin GETs
   * carry no Origin), else the primary origin. Never used to admit a request. */
  forRequest(request: FastifyRequest): string;
}

export function trustedOrigins(primary: string, additional: readonly string[] = [], policy: OriginPolicy = {}): TrustedOrigins {
  const all = Object.freeze([primary, ...parseAdditionalOrigins(additional, primary, policy)]);
  const set = new Set(all);
  const byHost = new Map<string, string | null>();
  for (const origin of all) {
    const host = new URL(origin).host;
    byHost.set(host, byHost.has(host) ? null : origin);
  }
  const matched = (request: FastifyRequest) => {
    const header = request.headers.origin;
    return typeof header === 'string' && set.has(header) ? header : undefined;
  };
  return {
    primary, all, matched,
    forRequest(request) {
      const exact = matched(request);
      if (exact) return exact;
      const host = typeof request.headers.host === 'string' ? request.headers.host.toLowerCase() : undefined;
      return (host && byHost.get(host)) || primary;
    },
  };
}
