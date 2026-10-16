import test from 'node:test';
import assert from 'node:assert/strict';
import { createYouTubeSearch, youtubeSearchParameters, parseIsoDuration, YouTubeSearchError, ResearchError } from '@course-core/research/node';

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
    (e) => e instanceof YouTubeSearchError && e.searchCode === 'SEARCH_UNAUTHORIZED');
  assert.equal(none.calls.length, 0);
  const cases = [
    [new Response('{"error":{"errors":[{"reason":"quotaExceeded"}]}}', { status: 403 }), 'SEARCH_QUOTA'],
    [new Response('{"error":{"errors":[{"reason":"keyInvalid"}]}}', { status: 400 }), 'SEARCH_UNAUTHORIZED'],
    [new Response('{"error":{"errors":[{"reason":"invalidParameter"}]}}', { status: 400 }), 'SEARCH_FAILED'],
    [new Response('forbidden', { status: 403 }), 'SEARCH_UNAUTHORIZED'],
    [new Response('', { status: 429 }), 'SEARCH_QUOTA'],
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
