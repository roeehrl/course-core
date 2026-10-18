import { describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { MAX_ADDITIONAL_ORIGINS, parseAdditionalOrigin, parseAdditionalOrigins, trustedOrigins } from '../src/origins.js';

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
    ['http://100.64.0.1:4310', /only https/],
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
});
