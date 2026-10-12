import test from 'node:test';
import assert from 'node:assert/strict';
import { parseYouTubeId, youtubeDescriptor } from '@course-core/research';
import { createInspectionEngine, createReviewEngine } from '../dist/internal/engine.js';
import { authorizer, hop, policy, publicIP, request } from './helpers.mjs';
import { ResearchError } from '../dist/errors.js';

const videoId = 'aB_cD-eF123'; // synthetic shape, not a live video
const transcript = { text: 'A public comparison exercise: compare the pair and select the smaller value.', language: 'en', obtainedVia: 'author_supplied',
  rights: { basis: 'owned', reference: 'Synthetic author-owned fixture', attribution: 'Public fixture author' } };
function mediaPolicy() { const saved = policy(); saved.allowedHosts = ['www.youtube.com']; saved.sources[0] = { id: 'guide', kind: 'youtube', url: `https://youtu.be/${videoId}`, topicIds: ['ordering'] }; return saved; }
const metadata = { type: 'video', title: '<b>Provider title stays text</b>', provider_name: 'YouTube', provider_url: 'https://www.youtube.com/', author_name: 'Original channel', author_url: 'https://www.youtube.com/@public-author', html: '<iframe src="https://127.0.0.1/DO_NOT_RENDER"></iframe>', thumbnail_url: 'https://127.0.0.1/DO_NOT_FETCH' };

test('parses supported YouTube IDs/URLs and rejects lookalikes, encoded paths, playlists and credentialed URLs', () => {
  for (const value of [videoId, `https://youtu.be/${videoId}`, `https://www.youtube.com/watch?v=${videoId}`, `https://m.youtube.com/shorts/${videoId}?si=share`, `https://www.youtube-nocookie.com/embed/${videoId}`]) assert.equal(parseYouTubeId(value), videoId);
  for (const value of [`https://youtube.com.evil/watch?v=${videoId}`, `https://user@youtube.com/watch?v=${videoId}`, `https://youtu.be/${videoId}/extra`, `https://www.youtube.com/watch?v=${videoId}&v=${videoId}`, `https://www.youtube.com/playlist?list=x`, `https://www.youtube.com/embed/%61B_cD-eF123`, 'not-an-id', `http://youtu.be/${videoId}`]) assert.throws(() => parseYouTubeId(value));
});

test('provides an activation-gated nocookie descriptor, attributed rights and a real fallback without raw HTML', () => {
  const descriptor = youtubeDescriptor({ urlOrId: videoId, transcript, title: 'Public lesson', fallback: { text: 'Read the author’s comparison exercise instead.', reference: 'author-alternative-1' },
    attribution: { trust: 'untrusted_provider_metadata', providerName: 'YouTube', authorName: 'Original author', authorUrl: 'https://www.youtube.com/@author', requiredNotice: 'Keep this attribution.' } });
  assert.equal(new URL(descriptor.embed.src).hostname, 'www.youtube-nocookie.com'); assert.equal(descriptor.embed.requiresUserActivation, true);
  assert.equal(descriptor.embed.referrerPolicy, 'strict-origin-when-cross-origin'); assert.equal(descriptor.transcript.status, 'provided_with_rights');
  assert.equal(descriptor.attribution.requiredNotice, 'Keep this attribution.'); assert.equal(descriptor.fallback.source, 'author');
  assert.equal('html' in descriptor, false); assert.equal('text' in descriptor.transcript, false);
  assert.throws(() => youtubeDescriptor({ urlOrId: videoId, transcript: { text: 'No permissions provided.', language: 'en' } }));
  assert.throws(() => youtubeDescriptor({ urlOrId: videoId, attribution: { trust: 'untrusted_provider_metadata', providerName: 'Example', authorUrl: 'javascript:alert(1)' } }));
});

test('fetches only server-derived oEmbed metadata; no transcript scraping, thumbnails or embedded HTML', async () => {
  const saved = mediaPolicy(), auth = authorizer(saved), calls = [];
  const inspector = createInspectionEngine(auth.authorize, {}, { now: Date.now, resolve: async () => [publicIP], request: async url => {
    calls.push(url.href); return hop({ mediaType: 'application/json', body: Buffer.from(JSON.stringify(metadata)) });
  } });
  const result = await inspector.inspect(auth.credential, request);
  const url = new URL(calls[0]); assert.equal(url.pathname, '/oembed'); assert.equal(url.searchParams.get('url'), `https://www.youtube.com/watch?v=${videoId}`);
  assert.equal(calls.length, 1); assert.equal(result.content.basis, 'metadata_only'); assert.equal(result.content.text, ''); assert.equal(result.state, 'unreviewed');
  assert.equal(result.title, metadata.title); assert.equal(result.attributions[0].authorName, metadata.author_name);
  assert.ok(!JSON.stringify(result).includes('DO_NOT_RENDER')); assert.ok(!JSON.stringify(result).includes('DO_NOT_FETCH'));
  const review = { ...request, inspectionId: result.inspectionId, contentDigest: result.content.digest, decision: 'approved', rationale: 'The title is relevant but is not content evidence.', evidence: [],
    suitability: { topicRelevant: true, accurateEnoughForUse: true, safeForAudience: true }, rights: { use: 'embed', basis: 'provider_embed', reference: 'Standard provider player.' }, acknowledgesTruncation: false };
  await assert.rejects(createReviewEngine(auth.authorize, async () => result).review(auth.credential, review), { code: 'REVIEW_EVIDENCE_REQUIRED' });
});

test('supports author-authorized transcripts and fallback on unavailable metadata, but never hides SSRF failures', async () => {
  const saved = mediaPolicy(); saved.sources[0].transcript = transcript;
  saved.sources[0].fallback = { text: 'Use this accessible author-written comparison example.', authorId: 'author-1', reference: 'alternative-1' };
  const auth = authorizer(saved);
  const inspector = createInspectionEngine(auth.authorize, {}, { now: Date.now, resolve: async () => [publicIP], request: async () => { throw new ResearchError('HTTP_STATUS'); } });
  const result = await inspector.inspect(auth.credential, request);
  assert.equal(result.provenance.metadataAvailability, 'unavailable'); assert.equal(result.provenance.bodyDigest, null);
  assert.equal(result.content.text, transcript.text); assert.equal(result.content.basis, 'transcript'); assert.equal(result.youtube.fallback.source, 'author');
  const rejected = createInspectionEngine(auth.authorize, {}, { now: Date.now, resolve: async () => [{ address: '127.0.0.1', family: 4 }], request: async () => { throw Error('must not fetch'); } });
  await assert.rejects(rejected.inspect(auth.credential, request), { code: 'ADDRESS_REJECTED' });
});
