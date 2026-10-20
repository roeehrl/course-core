import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { clientSourceResolver, parseTrustedProxies, MAX_TRUSTED_PROXIES } from '../src/client-address.js';

const request = (remoteAddress: string | undefined, forwarded?: string | string[]) =>
  ({ socket: { remoteAddress }, ip: remoteAddress, headers: forwarded === undefined ? {} : { 'x-forwarded-for': forwarded } }) as unknown as FastifyRequest;

describe('TRUSTED_PROXIES', () => {
  it('is off when absent or empty', () => {
    expect(parseTrustedProxies(undefined)).toEqual([]);
    expect(parseTrustedProxies('')).toEqual([]);
    expect(parseTrustedProxies(' , ')).toEqual([]);
  });
  it('accepts exact IPv4 and IPv6 addresses', () => {
    expect(parseTrustedProxies('127.0.0.1, ::1,10.0.0.5')).toEqual(['127.0.0.1', '::1', '10.0.0.5']);
    expect(parseTrustedProxies('::ffff:10.0.0.5')).toEqual(['10.0.0.5']);
    expect(parseTrustedProxies(['FD7A:115C:A1E0::1'])).toEqual(['fd7a:115c:a1e0::1']);
  });
  it('refuses ranges, wildcards, "trust all" values, host names and duplicates', () => {
    for (const bad of ['*', 'true', 'all', '0.0.0.0/0', '10.0.0.0/8', '::/0', 'localhost', 'proxy.example', '10.0.0.256', '10.0.0.5:8080', '[::1]']) {
      expect(() => parseTrustedProxies(bad), bad).toThrow(/Invalid trusted proxy/);
    }
    expect(() => parseTrustedProxies('10.0.0.5,10.0.0.5')).toThrow(/listed twice/);
    expect(() => parseTrustedProxies(Array.from({ length: MAX_TRUSTED_PROXIES + 1 }, (_, i) => `10.0.1.${i}`))).toThrow(/At most/);
  });
});

describe('client source', () => {
  it('without trusted proxies uses the TCP peer and ignores X-Forwarded-For', () => {
    const source = clientSourceResolver();
    expect(source(request('203.0.113.7', '198.51.100.1'))).toEqual({ address: '203.0.113.7', shared: false });
    expect(source(request('127.0.0.1', '198.51.100.1'))).toEqual({ address: '127.0.0.1', shared: true });
    expect(source(request('::1'))).toEqual({ address: '::1', shared: true });
    expect(source(request('::ffff:127.0.0.2'))).toEqual({ address: '127.0.0.2', shared: true });
    expect(source(request('100.101.102.103'))).toEqual({ address: '100.101.102.103', shared: false });
    expect(source(request(undefined))).toEqual({ address: 'unknown', shared: true });
  });
  it('reads X-Forwarded-For from the right, only from a listed proxy, skipping listed hops', () => {
    const source = clientSourceResolver(['10.0.0.5', '10.0.0.6']);
    expect(source(request('10.0.0.5', '198.51.100.1'))).toEqual({ address: '198.51.100.1', shared: false });
    expect(source(request('10.0.0.5', '203.0.113.9, 198.51.100.1'))).toEqual({ address: '198.51.100.1', shared: false });
    expect(source(request('10.0.0.5', '198.51.100.1, 10.0.0.6'))).toEqual({ address: '198.51.100.1', shared: false });
    expect(source(request('10.0.0.5', ['203.0.113.9', '198.51.100.2']))).toEqual({ address: '198.51.100.2', shared: false });
    expect(source(request('::ffff:10.0.0.5', '2001:db8::1'))).toEqual({ address: '2001:db8::1', shared: false });
    // Not a listed proxy: the header is the client's own claim and is ignored.
    expect(source(request('10.0.0.7', '198.51.100.1'))).toEqual({ address: '10.0.0.7', shared: false });
  });
  it('a listed proxy that names no usable client is itself a shared source', () => {
    const source = clientSourceResolver(['10.0.0.5']);
    expect(source(request('10.0.0.5'))).toEqual({ address: '10.0.0.5', shared: true });
    expect(source(request('10.0.0.5', 'unknown'))).toEqual({ address: '10.0.0.5', shared: true });
    expect(source(request('10.0.0.5', '198.51.100.1, 198.51.100.2:443'))).toEqual({ address: '10.0.0.5', shared: true });
    expect(source(request('10.0.0.5', '10.0.0.5'))).toEqual({ address: '10.0.0.5', shared: true });
    expect(source(request('10.0.0.5', `${'1.2.3.4,'.repeat(600)}1.2.3.4`))).toEqual({ address: '10.0.0.5', shared: true });
    // A forwarded loopback client is still not one identifiable client.
    expect(source(request('10.0.0.5', '127.0.0.1'))).toEqual({ address: '127.0.0.1', shared: true });
  });
});
