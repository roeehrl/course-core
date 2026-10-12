import { Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Agent, request } from 'node:https';
import { checkServerIdentity, type TLSSocket } from 'node:tls';
import ipaddr from 'ipaddr.js';
import { ResearchError, requireResearch } from '../errors.js';

export interface Address { address: string; family: 4 | 6 }
export interface FetchLimits { totalMs: number; dnsMs: number; connectMs: number; idleMs: number; maxBytes: number; maxRedirects: number }
export const defaultLimits: Readonly<FetchLimits> = Object.freeze({ totalMs: 8000, dnsMs: 1500, connectMs: 2000, idleMs: 1500, maxBytes: 524288, maxRedirects: 3 });
export function limits(input: Partial<FetchLimits> = {}): FetchLimits {
  requireResearch(Object.keys(input).every(key => key in defaultLimits), 'INVALID_INPUT');
  const value = { ...defaultLimits, ...input };
  for (const [key, max] of Object.entries({ totalMs: 10000, dnsMs: 3000, connectMs: 3000, idleMs: 3000, maxBytes: 1048576, maxRedirects: 3 })) {
    const n = value[key as keyof FetchLimits];
    requireResearch(Number.isSafeInteger(n) && n >= (key === 'maxRedirects' ? 0 : 1) && n <= max, 'INVALID_INPUT');
  }
  return value;
}
// Conservative IANA special-purpose exclusions, including transition/translation
// networks. Unknown future global ranges fail closed until deliberately reviewed.
const v4Denied = ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12',
  '192.0.0.0/24', '192.0.2.0/24', '192.88.99.0/24', '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4'].map(value => ipaddr.parseCIDR(value));
const v6Denied = ['2001::/23', '2001:db8::/32', '2002::/16', '3fff::/20'].map(value => ipaddr.parseCIDR(value));
export function publicAddress(address: string): boolean {
  if (!isIP(address) || address.includes('%')) return false;
  const parsed = ipaddr.parse(address);
  if (parsed.range() !== 'unicast') return false;
  if (parsed.kind() === 'ipv4') return !v4Denied.some(range => parsed.match(range));
  return parsed.match(ipaddr.parseCIDR('2000::/3')) && !v6Denied.some(range => parsed.match(range));
}
export function validateAddresses(values: readonly Address[]): Address {
  requireResearch(values.length > 0 && values.length <= 16, 'DNS_LIMIT');
  requireResearch(values.every(value => value && isIP(value.address) === value.family && publicAddress(value.address)), 'ADDRESS_REJECTED');
  // One destination, one attempt; no unchecked retry, Happy Eyeballs or failover.
  return values.find(value => value.family === 4) ?? values[0]!;
}
export function abortReason(signal: AbortSignal): ResearchError {
  return signal.reason instanceof ResearchError ? signal.reason : new ResearchError('CANCELLED');
}
export async function resolvePublic(hostname: string, signal: AbortSignal, timeout: number): Promise<Address[]> {
  if (signal.aborted) throw abortReason(signal);
  const resolver = new Resolver({ timeout, tries: 1 });
  const cancel = () => resolver.cancel();
  signal.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(cancel, timeout);
  try {
    const results = await Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)]);
    if (signal.aborted) throw abortReason(signal);
    const addresses: Address[] = [];
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') addresses.push(...result.value.map(address => ({ address, family: (index === 0 ? 4 : 6) as 4 | 6 })));
      else requireResearch(['ENODATA', 'ENOTFOUND'].includes((result.reason as NodeJS.ErrnoException).code ?? ''), 'DNS_FAILED');
    });
    validateAddresses(addresses);
    return addresses;
  } finally { clearTimeout(timer); signal.removeEventListener('abort', cancel); }
}
export interface HopResponse { status: number; location?: string; body: Uint8Array; mediaType: string; charset: string; address: Address }
export type Resolve = (hostname: string, signal: AbortSignal, timeout: number) => Promise<Address[]>;
export type FetchHop = (url: URL, address: Address, bounds: FetchLimits, signal: AbortSignal) => Promise<HopResponse>;
const redirects = new Set([301, 302, 303, 307, 308]);
export const isRedirect = (status: number) => redirects.has(status);

/** Private transport seam for real TLS loopback tests. No connection/CA/lookup
 * override is exported from the public package entrypoints. The inspector must
 * validate addresses before calling this low-level single-hop function. */
export function requestPinned(url: URL, address: Address, bounds: FetchLimits, signal: AbortSignal,
  testing?: { ca?: string; port?: number }): Promise<HopResponse> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(abortReason(signal)); return; }
    const agent = new Agent({ keepAlive: false, maxSockets: 1, maxCachedSessions: 0, proxyEnv: {} });
    let settled = false, connected = false;
    const finish = (error?: ResearchError, result?: HopResponse) => {
      if (settled) return;
      settled = true; clearTimeout(connectTimer); signal.removeEventListener('abort', abort);
      req.destroy(); agent.destroy();
      if (error) reject(error); else resolve(result!);
    };
    const abort = () => finish(abortReason(signal));
    // Never inherit HTTP(S)_PROXY, authorization, cookies, Referer, caller headers
    // or globalAgent. Preserve Host + TLS hostname while lookup returns only the
    // validated literal; Node cannot perform a second DNS resolution.
    const req = request({ protocol: 'https:', hostname: url.hostname, port: testing?.port ?? 443,
      path: url.pathname + url.search, method: 'GET', agent, family: address.family, ...{ autoSelectFamily: false },
      lookup: (_hostname, options, callback) => {
        if (typeof options === 'object' && options.all) callback(null, [address]);
        else callback(null, address.address, address.family);
      },
      servername: url.hostname, rejectUnauthorized: true, minVersion: 'TLSv1.2',
      checkServerIdentity: (_name, certificate) => checkServerIdentity(url.hostname, certificate),
      ...(testing?.ca ? { ca: testing.ca } : {}), maxHeaderSize: 16384,
      headers: { Accept: 'text/html, text/plain, application/json;q=0.5', 'Accept-Encoding': 'identity',
        'User-Agent': 'course-core-research/0.1 source-inspection', Connection: 'close' },
    });
    const connectTimer = setTimeout(() => finish(new ResearchError('TIMEOUT')), bounds.connectMs);
    signal.addEventListener('abort', abort, { once: true });
    req.setTimeout(bounds.idleMs, () => finish(new ResearchError('TIMEOUT')));
    req.once('socket', socket => {
      const secure = socket as TLSSocket;
      secure.once('secureConnect', () => {
        if (settled) return;
        try {
          requireResearch(secure.authorized && !checkServerIdentity(url.hostname, secure.getPeerCertificate()), 'TLS_FAILED');
          requireResearch(secure.remoteAddress && ipaddr.process(secure.remoteAddress).toString() === ipaddr.process(address.address).toString(), 'PEER_MISMATCH');
          connected = true; clearTimeout(connectTimer);
          // No HTTP request headers/body are released before peer/TLS checks.
          req.end();
        } catch (error) { finish(error instanceof ResearchError ? error : new ResearchError('TLS_FAILED')); }
      });
    });
    req.once('error', error => finish(new ResearchError(
      (error as NodeJS.ErrnoException).code === 'HPE_HEADER_OVERFLOW' ? 'HEADERS_LIMIT' : connected ? 'FETCH_FAILED' : 'TLS_FAILED')));
    req.once('response', incoming => {
      const status = incoming.statusCode ?? 0;
      if (redirects.has(status)) {
        const location = incoming.headers.location;
        if (!location || location.length > 2048) { finish(new ResearchError('URL_REJECTED')); return; }
        finish(undefined, { status, location, body: new Uint8Array(), mediaType: '', charset: '', address }); return;
      }
      if (status !== 200) { finish(new ResearchError('HTTP_STATUS')); return; }
      const encoding = incoming.headers['content-encoding'];
      if (encoding && encoding.toLowerCase() !== 'identity') { finish(new ResearchError('UNSUPPORTED_ENCODING')); return; }
      const declared = incoming.headers['content-length'];
      if (declared && (!/^\d+$/.test(declared) || Number(declared) > bounds.maxBytes)) { finish(new ResearchError('BYTES_LIMIT')); return; }
      const rawType = incoming.headers['content-type'] ?? '';
      const mediaType = rawType.split(';')[0]!.trim().toLowerCase();
      const charset = /charset\s*=\s*"?([^;"\s]+)/i.exec(rawType)?.[1]?.toLowerCase() ?? 'utf-8';
      if (!['text/html', 'text/plain', 'application/json'].includes(mediaType)) { finish(new ResearchError('UNSUPPORTED_CONTENT')); return; }
      if (!['utf-8', 'utf8', 'us-ascii'].includes(charset)) { finish(new ResearchError('UNSUPPORTED_ENCODING')); return; }
      const chunks: Buffer[] = []; let bytes = 0;
      incoming.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > bounds.maxBytes) finish(new ResearchError('BYTES_LIMIT'));
        else chunks.push(chunk);
      });
      incoming.once('aborted', () => finish(new ResearchError('FETCH_FAILED')));
      incoming.once('error', () => finish(new ResearchError('FETCH_FAILED')));
      incoming.once('end', () => {
        if (declared && Number(declared) !== bytes) { finish(new ResearchError('FETCH_FAILED')); return; }
        finish(undefined, { status, body: Buffer.concat(chunks), mediaType, charset, address });
      });
    });
  });
}
