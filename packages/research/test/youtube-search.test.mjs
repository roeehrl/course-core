import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createYouTubeSearch, youtubeSearchParameters, parseIsoDuration, YouTubeSearchError, ResearchError, YOUTUBE_QUOTA, quotaDay, quotaResetsAt } from '@course-core/research/node';

// Synthetic, test-only key material assembled from pieces; never a real credential.
const key = ['synthetic', 'test', 'key', '0001'].join('-');
const ids = ['aB_cD-eF123', 'zZ9_yY8-xX7'];
function json(body, init = {}) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });
}
function stub(responses) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: new URL(url), init });
    const next = responses.shift();
    if (typeof next === 'function') return next(url, init);
    return next;
  };
  return { calls, fetch };
}
const searchBody = {
  items: [
    { id: { kind: 'youtube#video', videoId: ids[0] }, snippet: { title: 'Ordering <b>numbers</b>', channelTitle: 'Public channel', publishedAt: '2024-02-03T04:05:06Z' } },
    { id: { kind: 'youtube#channel', channelId: 'UCx' }, snippet: { title: 'A channel, not a video' } },
    { id: { kind: 'youtube#video', videoId: 'bad id' }, snippet: { title: 'Rejected shape' } },
    { id: { kind: 'youtube#video', videoId: ids[1] }, snippet: { title: 'Second', channelTitle: 'Other' } },
    { id: { kind: 'youtube#video', videoId: ids[0] }, snippet: { title: 'Duplicate' } },
  ],
};
const videosBody = { items: [
  { id: ids[0], contentDetails: { duration: 'PT4M13S', caption: 'true' }, status: { embeddable: true } },
  { id: ids[1], contentDetails: { duration: 'nonsense', caption: 'false' }, status: { embeddable: false } },
  { id: 'notReturned1', contentDetails: { duration: 'PT1S' } },
] };

test('sends only the approved query, with the key in a header and never in a URL', async () => {
  const { calls, fetch } = stub([json(searchBody), json(videosBody)]);
  const search = createYouTubeSearch({ apiKey: () => key, fetch });
  const result = await search.search({ queryText: '  ordering   small numbers ', relevanceLanguage: 'en', maxResults: 5 });
  assert.equal(calls.length, 2);
  const [first, second] = calls;
  assert.equal(first.url.origin + first.url.pathname, 'https://www.googleapis.com/youtube/v3/search');
  assert.deepEqual(Object.fromEntries(first.url.searchParams), { part: 'snippet', type: 'video', maxResults: '5', q: 'ordering small numbers',
    safeSearch: 'strict', videoEmbeddable: 'true', relevanceLanguage: 'en' });
  assert.equal(second.url.pathname, '/youtube/v3/videos');
  assert.deepEqual(Object.fromEntries(second.url.searchParams), { part: 'contentDetails,status', id: ids.join(','), maxResults: '2' });
  for (const call of calls) {
    assert.ok(!call.url.href.includes(key), 'key never in a URL');
    assert.equal(call.init.headers['x-goog-api-key'], key);
    assert.equal(call.init.redirect, 'error');
    assert.equal(call.init.credentials, 'omit');
  }
  assert.deepEqual(result.sent, { q: 'ordering small numbers', relevanceLanguage: 'en', maxResults: 5 });
  assert.ok(!JSON.stringify(result).includes(key));
  assert.deepEqual(result.hits.map(h => h.videoId), ids);
  const [a, b] = result.hits;
  assert.equal(a.title, 'Ordering <b>numbers</b>'); // text, never markup
  assert.equal(a.durationSeconds, 253); assert.equal(a.embeddable, true); assert.equal(a.captions, 'creator_captions');
  assert.equal(a.publishedAt, '2024-02-03T04:05:06.000Z'); assert.equal(a.watchUrl, `https://www.youtube.com/watch?v=${ids[0]}`);
  assert.equal(b.durationSeconds, null); assert.equal(b.embeddable, false); assert.equal(b.captions, 'unknown');
  for (const hit of result.hits) {
    // F09: metadata is a lead, never reviewed content; it carries no claims or segment.
    assert.equal(hit.reviewStatus, 'unreviewed'); assert.equal(hit.inspectedEvidence, 'metadata_only');
    assert.equal('claims' in hit, false); assert.equal('segment' in hit, false);
    assert.equal(hit.attribution.trust, 'untrusted_provider_metadata');
  }
  assert.equal(a.attribution.searchRank, 1); assert.equal(b.attribution.searchRank, 2);
});

test('rejects anything beyond the approved public query (no learner fields reach search)', async () => {
  const { calls, fetch } = stub([]);
  const search = createYouTubeSearch({ apiKey: () => key, fetch });
  for (const query of [
    { queryText: 'ordering', learnerId: 'u-1' },
    { queryText: 'ordering', profile: { goal: 'private' } },
    { queryText: 'ordering', misconception: 'thinks 10 < 9' },
    { queryText: '' }, { queryText: 'x'.repeat(501) }, { queryText: 'line\nbreak' },
    { queryText: 'ordering', maxResults: 11 }, { queryText: 'ordering', maxResults: 0 }, { queryText: 'ordering', relevanceLanguage: 'en us' },
    'ordering', null, [],
  ]) await assert.rejects(search.search(query), (error) => error instanceof ResearchError && error.code === 'INVALID_INPUT');
  assert.equal(calls.length, 0, 'nothing was sent');
  assert.deepEqual(youtubeSearchParameters({ queryText: 'a' }), { q: 'a', relevanceLanguage: null, maxResults: 5 });
});

test('refuses to search without an admin-configured key and maps provider failures to stable codes', async () => {
  const none = stub([]);
  await assert.rejects(createYouTubeSearch({ apiKey: () => undefined, fetch: none.fetch }).search({ queryText: 'ordering' }),
    (e) => e instanceof YouTubeSearchError && e.searchCode === 'SEARCH_KEY_INVALID');
  assert.equal(none.calls.length, 0);
  const cases = [
    [new Response('{"error":{"errors":[{"reason":"quotaExceeded"}]}}', { status: 403 }), 'SEARCH_QUOTA'],
    [new Response('{"error":{"errors":[{"reason":"dailyLimitExceeded"}]}}', { status: 403 }), 'SEARCH_QUOTA'],
    [new Response('{"error":{"errors":[{"reason":"keyInvalid"}]}}', { status: 400 }), 'SEARCH_KEY_INVALID'],
    [new Response('{"error":{"code":400,"status":"INVALID_ARGUMENT","details":[{"@type":"type.googleapis.com/google.rpc.ErrorInfo","reason":"API_KEY_INVALID"}]}}', { status: 400 }), 'SEARCH_KEY_INVALID'],
    [new Response('{"error":{"errors":[{"reason":"accessNotConfigured"}]}}', { status: 403 }), 'SEARCH_API_DISABLED'],
    [new Response('{"error":{"details":[{"reason":"SERVICE_DISABLED"}]}}', { status: 403 }), 'SEARCH_API_DISABLED'],
    [new Response('{"error":{"errors":[{"reason":"rateLimitExceeded"}]}}', { status: 403 }), 'SEARCH_RATE_LIMITED'],
    [new Response('{"error":{"errors":[{"reason":"invalidParameter"}]}}', { status: 400 }), 'SEARCH_FAILED'],
    [new Response('forbidden', { status: 403 }), 'SEARCH_UNAUTHORIZED'],
    [new Response('', { status: 429 }), 'SEARCH_RATE_LIMITED'],
    [new Response('', { status: 500 }), 'SEARCH_FAILED'],
    [new Response('not json', { status: 200 }), 'SEARCH_FAILED'],
  ];
  for (const [response, code] of cases) {
    const s = stub([response]);
    await assert.rejects(createYouTubeSearch({ apiKey: async () => key, fetch: s.fetch }).search({ queryText: 'ordering' }),
      (e) => e instanceof YouTubeSearchError && e.searchCode === code && !e.message.includes(key));
  }
  const thrown = stub([() => { throw new TypeError('network down'); }]);
  await assert.rejects(createYouTubeSearch({ apiKey: () => key, fetch: thrown.fetch }).search({ queryText: 'ordering' }),
    (e) => e instanceof YouTubeSearchError && e.searchCode === 'SEARCH_FAILED');
});

test('bounds response size, honours cancellation and skips the details call when nothing matched', async () => {
  const big = stub([new Response('x'.repeat(2000), { status: 200 })]);
  await assert.rejects(createYouTubeSearch({ apiKey: () => key, fetch: big.fetch, maxResponseBytes: 1000 }).search({ queryText: 'ordering' }),
    (e) => e instanceof ResearchError && e.code === 'BYTES_LIMIT');
  const controller = new AbortController();
  const slow = stub([(_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)))]);
  const pending = createYouTubeSearch({ apiKey: () => key, fetch: slow.fetch }).search({ queryText: 'ordering' }, controller.signal);
  controller.abort();
  await assert.rejects(pending, (e) => e instanceof ResearchError && e.code === 'CANCELLED');
  const timed = stub([(_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)))]);
  await assert.rejects(createYouTubeSearch({ apiKey: () => key, fetch: timed.fetch, timeoutMs: 20 }).search({ queryText: 'ordering' }),
    (e) => e instanceof ResearchError && e.code === 'TIMEOUT');
  const empty = stub([json({ items: [] })]);
  const result = await createYouTubeSearch({ apiKey: () => key, fetch: empty.fetch }).search({ queryText: 'ordering' });
  assert.deepEqual(result.hits, []); assert.equal(empty.calls.length, 1);
});

test('parses ISO 8601 video durations', () => {
  assert.equal(parseIsoDuration('PT1H2M3S'), 3723); assert.equal(parseIsoDuration('PT45S'), 45); assert.equal(parseIsoDuration('P1DT1S'), 86401);
  for (const bad of ['P', 'PT', '1H', 'PT-1S', 12, undefined]) assert.equal(parseIsoDuration(bad), null);
});

test('a rate limit carries its Retry-After hint; quota and key errors never echo the key', async () => {
  const s = stub([new Response('', { status: 429, headers: { 'retry-after': '30' } })]);
  await assert.rejects(createYouTubeSearch({ apiKey: () => key, fetch: s.fetch }).search({ queryText: 'ordering' }),
    (e) => e instanceof YouTubeSearchError && e.searchCode === 'SEARCH_RATE_LIMITED' && e.retryAfterMs === 30_000);
});

test('quota days follow Pacific time, including daylight saving changes', () => {
  assert.equal(YOUTUBE_QUOTA.defaultDailyUnits, 10_000);
  assert.equal(YOUTUBE_QUOTA.defaultDailySearches, 100);
  // 06:59 UTC on 21 October 2026 is still 20 October in Pacific daylight time.
  assert.equal(quotaDay(new Date('2026-10-21T06:59:00Z')), '2026-10-20');
  assert.equal(quotaDay(new Date('2026-10-21T07:00:00Z')), '2026-10-21');
  assert.equal(quotaResetsAt(new Date('2026-10-21T12:00:00Z')).toISOString(), '2026-10-22T07:00:00.000Z');
  // In winter (standard time) the day ends at 08:00 UTC; the day DST ends is 25 hours long.
  assert.equal(quotaResetsAt(new Date('2026-12-01T12:00:00Z')).toISOString(), '2026-12-02T08:00:00.000Z');
  assert.equal(quotaResetsAt(new Date('2026-11-01T12:00:00Z')).toISOString(), '2026-11-02T08:00:00.000Z');
});

test('search and the connection check run end to end against a local stub HTTP server', async () => {
  const seen = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://stub');
    seen.push({ path: url.pathname, key: request.headers['x-goog-api-key'], query: url.searchParams.get('q'), hasKeyParam: url.searchParams.has('key') });
    response.setHeader('content-type', 'application/json');
    if (url.pathname.endsWith('/i18nLanguages')) return response.end(JSON.stringify({ kind: 'youtube#i18nLanguageListResponse', items: [] }));
    if (url.pathname.endsWith('/search')) return response.end(JSON.stringify(searchBody));
    if (url.pathname.endsWith('/videos')) return response.end(JSON.stringify(videosBody));
    response.statusCode = 404; response.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    // The adapter fixes the API origin; only the test's fetch points it at the loopback stub.
    const fetch = (url, init) => globalThis.fetch(String(url).replace('https://www.googleapis.com', `http://127.0.0.1:${port}`), init);
    const youtube = createYouTubeSearch({ apiKey: () => key, fetch });
    assert.deepEqual(await youtube.check(), { ok: true });
    const result = await youtube.search({ queryText: 'ordering numbers' });
    assert.deepEqual(result.hits.map((h) => h.videoId), ids);
    assert.deepEqual(seen.map((c) => c.path), ['/youtube/v3/i18nLanguages', '/youtube/v3/search', '/youtube/v3/videos']);
    assert.ok(seen.every((c) => c.key === key && !c.hasKeyParam));
    assert.equal(seen[1].query, 'ordering numbers');
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('the connection check refuses an unexpected answer', async () => {
  const s = stub([json({ kind: 'something#else' })]);
  await assert.rejects(createYouTubeSearch({ apiKey: () => key, fetch: s.fetch }).check(), (e) => e instanceof YouTubeSearchError && e.searchCode === 'SEARCH_FAILED');
  assert.equal(s.calls[0].url.pathname, '/youtube/v3/i18nLanguages');
});
