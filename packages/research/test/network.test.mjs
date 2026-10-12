import test from 'node:test';
import assert from 'node:assert/strict';
import { publicHttpsUrl } from '../dist/urls.js';
import { createInspectionEngine } from '../dist/internal/engine.js';
import { publicAddress, requestPinned, defaultLimits, validateAddresses } from '../dist/internal/network.js';
import { ResearchError } from '../dist/errors.js';
import { authorizer, hop, loopback, policy, publicIP, request } from './helpers.mjs';

test('rejects private, reserved, translation and malformed addresses across both families', () => {
  for (const address of ['0.0.0.0', '10.0.0.1', '100.100.100.200', '127.0.0.1', '169.254.169.254', '172.16.5.1', '192.0.0.9', '192.168.1.1', '192.0.2.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255',
    '::', '::1', 'fc00::1', 'fe80::1', 'ff02::1', '::ffff:8.8.8.8', '64:ff9b::808:808', '2001::1', '2001:db8::1', '2002:7f00:1::', '3fff::1', 'fe80::1%en0', '127.1', '0x7f000001', 'garbage']) {
    assert.equal(publicAddress(address), false, address);
  }
  for (const address of ['93.184.215.14', '8.8.8.8', '2606:4700:4700::1111', '2001:4860:4860::8888']) assert.equal(publicAddress(address), true, address);
  assert.throws(() => validateAddresses([publicIP, { address: '::1', family: 6 }]), { code: 'ADDRESS_REJECTED' });
  assert.throws(() => validateAddresses([{ address: '8.8.8.8', family: 6 }]), { code: 'ADDRESS_REJECTED' });
  assert.throws(() => validateAddresses(Array(17).fill(publicIP)), { code: 'DNS_LIMIT' });
});

test('rejects ambiguous host parsing, userinfo, IP variants, alternate ports and egress queries', () => {
  for (const value of ['http://source.example/a', 'https://127.1/', 'https://2130706433/', 'https://0x7f000001/', 'https://0177.0.0.1/', 'https://[::1]/', 'https://user@source.example/', 'https://source.example@127.0.0.1/',
    'https://source.example:444/', 'https://source.example./', 'https://%73ource.example/', 'https://source.example\\@127.0.0.1/', 'https://source.example/\n', 'https://source.example/?learner=PRIVATE_CANARY',
    'https://source.example/#fragment', 'https://localhost/', 'https://metadata.google.internal/', 'https://source.example.local/', 'https://xn--example-123.example/', 'https://ｅxample.com/', 'https://a..example/', 'https://-a.example/']) {
    assert.throws(() => publicHttpsUrl(value), { code: 'URL_REJECTED' }, value);
  }
  assert.equal(publicHttpsUrl('https://SOURCE.example:443/guide').href, 'https://source.example/guide');
});

test('checks all DNS answers before transport and admits no caller URL/profile/history fields', async () => {
  const { authorize, credential } = authorizer(); let calls = 0;
  const engine = createInspectionEngine(authorize, {}, { now: Date.now, resolve: async () => [publicIP, { address: '127.0.0.1', family: 4 }], request: async () => { calls++; return hop(); } });
  await assert.rejects(engine.inspect(credential, request), { code: 'ADDRESS_REJECTED' }); assert.equal(calls, 0);
  await assert.rejects(engine.inspect(credential, { ...request, learnerProfile: 'PRIVATE_CANARY' }), { code: 'INVALID_INPUT' });
  await assert.rejects(engine.inspect(credential, { ...request, url: 'https://source.example/search/private' }), { code: 'INVALID_INPUT' });
  await assert.rejects(engine.inspect('forged', request), { code: 'NOT_AUTHORIZED' });
  assert.equal(calls, 0);
});

test('pins one DNS result and rejects rebinding on the next redirect resolution', async () => {
  const { authorize, credential } = authorizer(); let dns = 0, fetched = 0;
  const engine = createInspectionEngine(authorize, {}, { now: Date.now,
    resolve: async () => ++dns === 1 ? [publicIP] : [{ address: '127.0.0.1', family: 4 }],
    request: async (url, address) => { fetched++; assert.deepEqual(address, publicIP); assert.equal(url.hostname, 'source.example'); return hop({ status: 302, location: '/next' }); } });
  await assert.rejects(engine.inspect(credential, request), { code: 'ADDRESS_REJECTED' }); assert.equal(dns, 2); assert.equal(fetched, 1);
  let reads = 0;
  const fixed = createInspectionEngine(authorize, {}, { now: Date.now, resolve: async () => { reads++; return reads === 1 ? [publicIP] : [{ address: '10.0.0.1', family: 4 }]; },
    request: async (_url, address) => { assert.deepEqual(address, publicIP); return hop(); } });
  await fixed.inspect(credential, request); assert.equal(reads, 1);
});

test('revalidates redirect protocol, host, URL normalization, loops and hop limits', async () => {
  const { authorize, credential } = authorizer();
  for (const [location, code] of [['http://source.example/next', 'URL_REJECTED'], ['https://127.0.0.1/', 'URL_REJECTED'], ['https://source.example.evil/next', 'DOMAIN_REJECTED'], ['https://other.example/next?secret=x', 'URL_REJECTED'], ['\\127.0.0.1/x', 'URL_REJECTED'], ['/guide', 'REDIRECT_LOOP']]) {
    let fetched = 0;
    const engine = createInspectionEngine(authorize, {}, { now: Date.now, resolve: async () => [publicIP], request: async () => { fetched++; return hop({ status: 302, location }); } });
    await assert.rejects(engine.inspect(credential, request), { code }); assert.equal(fetched, 1);
  }
  let fetched = 0;
  const looping = createInspectionEngine(authorize, {}, { now: Date.now, resolve: async () => [publicIP], request: async () => hop({ status: 307, location: `/next-${++fetched}` }) });
  await assert.rejects(looping.inspect(credential, request), { code: 'REDIRECT_LIMIT' }); assert.equal(fetched, 4);
});

test('bounds authorizer/DNS waits, caller cancellation and concurrent inspection capacity', async () => {
  const { authorize, credential } = authorizer();
  const engine = createInspectionEngine(authorize, { limits: { totalMs: 40 }, maxConcurrent: 1 }, { now: Date.now, resolve: async () => new Promise(() => {}), request: async () => hop() });
  const running = engine.inspect(credential, request);
  await assert.rejects(engine.inspect(credential, request), { code: 'CAPACITY' });
  await assert.rejects(running, { code: 'TIMEOUT' });
  const abort = new AbortController(); abort.abort();
  await assert.rejects(engine.inspect(credential, request, abort.signal), { code: 'CANCELLED' });
  await assert.rejects(createInspectionEngine(async () => new Promise(() => {}), { limits: { totalMs: 30 } }).inspect(credential, request), { code: 'TIMEOUT' });
});

test('real TLS loopback uses pinned lookup, original SNI/Host and no ambient credentials/proxies', async () => {
  const fixture = await loopback((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Readable synthetic public lesson content.'); });
  const savedProxy = process.env.HTTPS_PROXY, savedNodeProxy = process.env.NODE_USE_ENV_PROXY;
  process.env.HTTPS_PROXY = 'http://127.0.0.1:1'; process.env.NODE_USE_ENV_PROXY = '1';
  try {
    const result = await requestPinned(new URL('https://source.example/guide'), { address: '127.0.0.1', family: 4 }, defaultLimits, new AbortController().signal, fixture);
    assert.equal(Buffer.from(result.body).toString(), 'Readable synthetic public lesson content.');
    assert.equal(fixture.seen[0].servername, 'source.example'); assert.equal(fixture.seen[0].headers.host, `source.example:${fixture.port}`);
    assert.equal(fixture.seen[0].headers['accept-encoding'], 'identity');
    for (const name of ['authorization', 'cookie', 'referer', 'proxy-authorization']) assert.equal(fixture.seen[0].headers[name], undefined);
    assert.equal(fixture.seen.length, 1);
  } finally {
    if (savedProxy === undefined) delete process.env.HTTPS_PROXY; else process.env.HTTPS_PROXY = savedProxy;
    if (savedNodeProxy === undefined) delete process.env.NODE_USE_ENV_PROXY; else process.env.NODE_USE_ENV_PROXY = savedNodeProxy;
    await fixture.close();
  }
});

test('real TLS rejects untrusted certificates and hostname mismatch before sending HTTP', async () => {
  const fixture = await loopback((_req, res) => res.end('must not be reached'));
  try {
    await assert.rejects(requestPinned(new URL('https://source.example/'), { address: '127.0.0.1', family: 4 }, defaultLimits, new AbortController().signal, { port: fixture.port }), { code: 'TLS_FAILED' });
    await assert.rejects(requestPinned(new URL('https://other.example/'), { address: '127.0.0.1', family: 4 }, defaultLimits, new AbortController().signal, fixture), { code: 'TLS_FAILED' });
    assert.equal(fixture.seen.length, 0);
  } finally { await fixture.close(); }
});

test('real loopback rejects declared/chunked oversize, compression, bad content and oversized headers', async () => {
  const fixture = await loopback((req, res) => {
    const mode = req.url;
    if (mode === '/headers') { res.setHeader('x-enormous', 'x'.repeat(20000)); res.end(); return; }
    res.setHeader('Content-Type', mode === '/binary' ? 'application/octet-stream' : mode === '/charset' ? 'text/plain; charset=latin1' : 'text/plain');
    if (mode === '/length') res.setHeader('Content-Length', '10000');
    if (mode === '/compressed') res.setHeader('Content-Encoding', 'gzip');
    if (mode === '/chunked') { res.write('a'.repeat(60)); res.end('b'.repeat(60)); } else res.end('x'.repeat(40));
  });
  try {
    for (const [path, code] of [['/length', 'BYTES_LIMIT'], ['/chunked', 'BYTES_LIMIT'], ['/compressed', 'UNSUPPORTED_ENCODING'], ['/binary', 'UNSUPPORTED_CONTENT'], ['/charset', 'UNSUPPORTED_ENCODING'], ['/headers', 'HEADERS_LIMIT']]) {
      await assert.rejects(requestPinned(new URL(`https://source.example${path}`), { address: '127.0.0.1', family: 4 }, { ...defaultLimits, maxBytes: 100 }, new AbortController().signal, fixture), { code });
    }
  } finally { await fixture.close(); }
});

test('real loopback closes redirect bodies immediately and enforces idle/total cancellation', async () => {
  const timers = new Set();
  const fixture = await loopback((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { Location: '/next', 'Content-Length': '100000000' }); res.flushHeaders(); return; }
    if (req.url === '/idle') return;
    res.writeHead(200, { 'Content-Type': 'text/plain' }); res.flushHeaders();
    const timer = setInterval(() => res.write('x'), 10); timers.add(timer); res.once('close', () => { clearInterval(timer); timers.delete(timer); });
  });
  try {
    const redirect = await requestPinned(new URL('https://source.example/redirect'), { address: '127.0.0.1', family: 4 }, defaultLimits, new AbortController().signal, fixture);
    assert.equal(redirect.status, 302); assert.equal(redirect.body.length, 0); assert.equal(fixture.seen.length, 1);
    await assert.rejects(requestPinned(new URL('https://source.example/idle'), { address: '127.0.0.1', family: 4 }, { ...defaultLimits, idleMs: 40 }, new AbortController().signal, fixture), { code: 'TIMEOUT' });
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(new ResearchError('TIMEOUT')), 70);
    try { await assert.rejects(requestPinned(new URL('https://source.example/trickle'), { address: '127.0.0.1', family: 4 }, defaultLimits, controller.signal, fixture), { code: 'TIMEOUT' }); }
    finally { clearTimeout(timer); }
  } finally { for (const timer of timers) clearInterval(timer); await fixture.close(); }
});
