import { describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { isTailscaleAddress, MAX_ADDITIONAL_ORIGINS, parseAdditionalOrigin, parseAdditionalOrigins, parseAllowInsecureOrigins, trustedOrigins } from '../src/origins.js';

// An origin carrying credentials, built so the public audit sees no literal URL credential.
const withCredentials = (value: string, password = false) => { const url = new URL(value); url.username = 'someone'; if (password) url.password = 'secret'; return url.href.replace(/\/$/, ''); };
const request = (headers: Record<string, string>) => ({ headers }) as unknown as FastifyRequest;

describe('additional origin validation', () => {
  it('accepts exact https origins, with or without a non-default port', () => {
    expect(parseAdditionalOrigin('https://pilot.tailnet.example')).toBe('https://pilot.tailnet.example');
    expect(parseAdditionalOrigin('https://pilot.tailnet.example:8443')).toBe('https://pilot.tailnet.example:8443');
  });
  it.each([
    ['http://pilot.tailnet.example', /only https/],
    ['http://127.0.0.1:4310', /only https/],
    ['https://pilot.tailnet.example/', /exactly as the origin/],
    ['https://pilot.tailnet.example/learn', /exactly as the origin/],
    ['https://pilot.tailnet.example?x=1', /exactly as the origin/],
    ['https://pilot.tailnet.example#x', /exactly as the origin/],
    ['https://Pilot.Tailnet.Example', /exactly as the origin/],
    ['https://pilot.tailnet.example:443', /exactly as the origin/],
    ['https://*.tailnet.example', /wildcards/],
    ['*', /wildcards/],
    ['pilot.tailnet.example', /not a URL/],
    ['', /at most 255/],
    [`https://${'a'.repeat(250)}.example`, /at most 255/],
    ['ftp://pilot.tailnet.example', /only https/],
  ])('refuses %s', (value, message) => {
    expect(() => parseAdditionalOrigin(value)).toThrow(message);
  });
  it('accepts plain http only to a literal Tailscale address with an explicit port', () => {
    for (const value of ['http://100.99.0.1:4310', 'http://100.64.0.0:4310', 'http://100.127.255.255:4310', 'http://[fd7a:115c:a1e0::1]:4310', 'http://[fd7a:115c:a1e0:ab12::42]:8080'])
      expect(parseAdditionalOrigin(value)).toBe(value);
    for (const value of ['http://100.63.255.255:4310', 'http://100.128.0.1:4310', 'http://192.168.1.5:4310', 'http://10.0.0.1:4310', 'http://[fd7a:115c:a1e1::1]:4310',
      'http://[fd00::1]:4310', 'http://[::ffff:100.99.0.1]:4310', 'http://[::ffff:6463:1]:4310', 'http://example.com', 'http://example.com:4310', 'http://pilot.tailnet.example:4310', 'http://localhost:4310'])
      expect(() => parseAdditionalOrigin(value), value).toThrow(/Tailscale address/);
    expect(() => parseAdditionalOrigin('http://100.99.0.1')).toThrow(/explicit port/);
    // Non-canonical spellings are refused with the exact origin to use instead.
    for (const value of ['http://100.99.0.1:80', 'http://[FD7A:115C:A1E0::1]:4310', 'http://[fd7a:115c:a1e0:0::1]:4310', 'http://100.99.1:4310', 'http://100.99.0.1:4310/'])
      expect(() => parseAdditionalOrigin(value), value).toThrow(/exactly as the origin|explicit port|Tailscale address/);
    expect(isTailscaleAddress('100.100.100.100')).toBe(true); expect(isTailscaleAddress('[fd7a:115c:a1e0::]')).toBe(true);
    expect(isTailscaleAddress('pilot.tailnet.example')).toBe(false); expect(isTailscaleAddress('[zz::1]')).toBe(false);
  });
  it('refuses credentials', () => {
    expect(() => parseAdditionalOrigin(withCredentials('https://pilot.tailnet.example'))).toThrow(/credentials/);
    expect(() => parseAdditionalOrigin(withCredentials('https://pilot.tailnet.example', true))).toThrow(/credentials/);
  });
  it('parses a comma-separated list, ignoring blanks and surrounding spaces', () => {
    expect(parseAdditionalOrigins(undefined)).toEqual([]);
    expect(parseAdditionalOrigins('')).toEqual([]);
    expect(parseAdditionalOrigins(' https://a.tailnet.example , ,https://b.tailnet.example ')).toEqual(['https://a.tailnet.example', 'https://b.tailnet.example']);
  });
  it('refuses duplicates, the primary origin again, too many entries, and any one bad entry', () => {
    expect(() => parseAdditionalOrigins('https://a.tailnet.example,https://a.tailnet.example')).toThrow(/listed twice/);
    expect(() => parseAdditionalOrigins('https://learn.example.org', 'https://learn.example.org')).toThrow(/primary/);
    const many = Array.from({ length: MAX_ADDITIONAL_ORIGINS + 1 }, (_, i) => `https://n${i}.tailnet.example`);
    expect(parseAdditionalOrigins(many.slice(0, MAX_ADDITIONAL_ORIGINS).join(','))).toHaveLength(MAX_ADDITIONAL_ORIGINS);
    expect(() => parseAdditionalOrigins(many.join(','))).toThrow(/At most/);
    expect(() => parseAdditionalOrigins('https://a.tailnet.example,http://b.tailnet.example')).toThrow(/only https/);
  });
});

describe('trusted origin matching', () => {
  const origins = trustedOrigins('http://127.0.0.1:4310', ['https://pilot.tailnet.example']);
  it('matches only an exact Origin header', () => {
    expect(origins.matched(request({ origin: 'http://127.0.0.1:4310' }))).toBe('http://127.0.0.1:4310');
    expect(origins.matched(request({ origin: 'https://pilot.tailnet.example' }))).toBe('https://pilot.tailnet.example');
    for (const origin of ['https://pilot.tailnet.example/', 'http://pilot.tailnet.example', 'https://evil.example', 'null', 'HTTPS://PILOT.TAILNET.EXAMPLE'])
      expect(origins.matched(request({ origin }))).toBeUndefined();
    expect(origins.matched(request({ host: 'pilot.tailnet.example' }))).toBeUndefined();
  });
  it('resolves a request without Origin by its Host among trusted origins only, else the primary', () => {
    expect(origins.forRequest(request({ host: 'pilot.tailnet.example' }))).toBe('https://pilot.tailnet.example');
    expect(origins.forRequest(request({ host: '127.0.0.1:4310' }))).toBe('http://127.0.0.1:4310');
    expect(origins.forRequest(request({ host: 'evil.example' }))).toBe('http://127.0.0.1:4310');
    expect(origins.forRequest(request({}))).toBe('http://127.0.0.1:4310');
    // An untrusted Origin header never selects anything but by Host.
    expect(origins.forRequest(request({ origin: 'https://evil.example', host: 'pilot.tailnet.example' }))).toBe('https://pilot.tailnet.example');
  });
  it('refuses invalid additional origins at construction', () => {
    expect(() => trustedOrigins('http://localhost:4310', ['http://pilot.tailnet.example'])).toThrow(/only https/);
  });
  it('resolves a Tailscale-address origin by Origin or by Host', () => {
    const ip = trustedOrigins('http://127.0.0.1:4310', ['http://100.99.0.1:4310', 'http://[fd7a:115c:a1e0::1]:4310']);
    expect(ip.matched(request({ origin: 'http://100.99.0.1:4310' }))).toBe('http://100.99.0.1:4310');
    expect(ip.matched(request({ origin: 'http://100.99.0.1:4311' }))).toBeUndefined();
    expect(ip.forRequest(request({ host: '100.99.0.1:4310' }))).toBe('http://100.99.0.1:4310');
    expect(ip.forRequest(request({ host: '[fd7a:115c:a1e0::1]:4310' }))).toBe('http://[fd7a:115c:a1e0::1]:4310');
  });
});

describe('ALLOW_INSECURE_ORIGINS operator switch', () => {
  const allow = { allowInsecure: true };
  it('is off unless exactly "true"', () => {
    for (const value of [undefined, '', 'false']) expect(parseAllowInsecureOrigins(value), String(value)).toBe(false);
    expect(parseAllowInsecureOrigins('true')).toBe(true);
    for (const value of ['TRUE', 'True', '1', '0', 'yes', 'on', ' true', 'true ', 'false\n'])
      expect(() => parseAllowInsecureOrigins(value), value).toThrow(/exactly "true" or "false"/);
  });
  it('refuses a LAN or host-name http origin by default and accepts it with the switch on', () => {
    for (const value of ['http://192.168.1.5:4310', 'http://10.0.0.1:4310', 'http://pilot.home.example:4310', 'http://localhost:4310', 'http://[fd00::1]:4310']) {
      expect(() => parseAdditionalOrigin(value), value).toThrow(/Tailscale address.*ALLOW_INSECURE_ORIGINS=true/);
      expect(() => parseAdditionalOrigin(value, { allowInsecure: false }), value).toThrow(/Tailscale address/);
      expect(parseAdditionalOrigin(value, allow)).toBe(value);
    }
    expect(parseAdditionalOrigins('https://a.tailnet.example,http://192.168.1.5:4310', undefined, allow)).toEqual(['https://a.tailnet.example', 'http://192.168.1.5:4310']);
    expect(() => parseAdditionalOrigins('http://192.168.1.5:4310')).toThrow(/Tailscale address/);
  });
  it('still requires an explicit port and the exact origin form, and refuses credentials and wildcards', () => {
    for (const value of ['http://192.168.1.5', 'http://example.com']) expect(() => parseAdditionalOrigin(value, allow), value).toThrow(/explicit port/);
    for (const value of ['http://192.168.1.5:4310/', 'http://192.168.1.5:4310/learn', 'http://Pilot.Home.Example:4310', 'http://192.168.1.5:4310?x=1', 'http://192.168.1.5:80'])
      expect(() => parseAdditionalOrigin(value, allow), value).toThrow(/exactly as the origin|explicit port/);
    expect(() => parseAdditionalOrigin(withCredentials('http://192.168.1.5:4310'), allow)).toThrow(/credentials/);
    expect(() => parseAdditionalOrigin(withCredentials('http://192.168.1.5:4310', true), allow)).toThrow(/credentials/);
    expect(() => parseAdditionalOrigin('http://*.home.example:4310', allow)).toThrow(/wildcards/);
    expect(() => parseAdditionalOrigin('ftp://192.168.1.5:4310', allow)).toThrow(/only https/);
    expect(() => parseAdditionalOrigins('http://192.168.1.5:4310,http://192.168.1.5:4310', undefined, allow)).toThrow(/listed twice/);
  });
  it('trusts only the exact listed http origin when on', () => {
    expect(() => trustedOrigins('http://127.0.0.1:4310', ['http://192.168.1.5:4310'])).toThrow(/Tailscale address/);
    const lan = trustedOrigins('http://127.0.0.1:4310', ['http://192.168.1.5:4310'], allow);
    expect(lan.matched(request({ origin: 'http://192.168.1.5:4310' }))).toBe('http://192.168.1.5:4310');
    for (const origin of ['http://192.168.1.6:4310', 'http://192.168.1.5:4311', 'https://192.168.1.5:4310', 'http://192.168.1.5'])
      expect(lan.matched(request({ origin })), origin).toBeUndefined();
    expect(lan.forRequest(request({ host: '192.168.1.5:4310' }))).toBe('http://192.168.1.5:4310');
  });
});
