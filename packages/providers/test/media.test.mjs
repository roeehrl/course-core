import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { ModelRegistry, ProviderRouter, priceMediaUnits } from '../dist/index.js';
import { GoogleProvider } from '../dist/google-index.js';
import { KEY, body, code, config, harness, json, videoRequest } from './helpers.mjs';

// Synthetic JPEG: a valid SOI marker and arbitrary public bytes. Never a real generated image.
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Array.from({ length: 60 }, (_, i) => i)]);
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]);
function imageConfig(extra = {}) {
  const base = config();
  base.models.push({ id: 'picture', providerId: 'google-account', remoteModel: 'admin-selected-image-model', enabled: true,
    capabilities: ['image'], tools: [], limits: { maxInputCharacters: 4000, maxOutputTokens: 1 },
    providerConfig: { transport: 'image_interaction', apiVersion: 'v1beta', maxResponseBytes: 4_000_000,
      image: { aspectRatios: ['16:9', '1:1'], imageSizes: ['1K', '2K'], mimeTypes: ['image/jpeg'], maxImageBytes: 1_000_000, ...extra } } });
  return base;
}
const imageRequest = (extra = {}) => ({ modelId: 'picture', accounting: { accountingKey: 'image-job' }, prompt: 'A labelled diagram of a list being scanned.',
  maxOutputTokens: 1, ...extra });
const interaction = (content, extra = {}) => ({ id: 'interaction-1', status: 'completed',
  steps: [{ type: 'thought', content: [{ type: 'text', text: 'hidden reasoning' }] }, { type: 'model_output', content }],
  usage: { total_input_tokens: 12, total_output_tokens: 1290, total_tokens: 1302, total_thought_tokens: 40 }, ...extra });
const imageBlock = (bytes = JPEG, mime = 'image/jpeg') => ({ type: 'image', mime_type: mime, data: bytes.toString('base64') });

test('an image interaction sends the declared settings, stores nothing remotely and returns the validated image', async () => {
  const h = harness([interaction([imageBlock(), { type: 'text', text: 'Here is the diagram.' }])], { config: imageConfig() });
  const result = await h.client.startImage(imageRequest({ aspectRatio: '1:1', imageSize: '2K' }));
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url, 'https://generativelanguage.googleapis.com/v1beta/interactions');
  assert.equal(h.calls[0].init.headers['x-goog-api-key'] ?? new Headers(h.calls[0].init.headers).get('x-goog-api-key'), KEY);
  assert.deepEqual(body(h.calls[0]), { model: 'admin-selected-image-model', input: [{ type: 'text', text: imageRequest().prompt }], store: false,
    response_format: { type: 'image', mime_type: 'image/jpeg', aspect_ratio: '1:1', image_size: '2K', delivery: 'inline' } });
  assert.equal(result.output.images.length, 1);
  assert.equal(result.output.images[0].byteLength, JPEG.byteLength);
  assert.equal(result.output.text, 'Here is the diagram.');
  assert.equal(result.usage.observedImageCount, 1);
  assert.deepEqual(result.usage.attempts[0].tokens, { input: 12, output: 1290, total: 1302, cachedInput: null, thoughts: 40, toolInput: null });
  // Defaults are the first declared values.
  const d = harness([interaction([imageBlock()])], { config: imageConfig() });
  await d.client.startImage(imageRequest());
  assert.deepEqual(body(d.calls[0]).response_format, { type: 'image', mime_type: 'image/jpeg', aspect_ratio: '16:9', image_size: '1K', delivery: 'inline' });
});

test('undeclared image settings are refused before anything is sent', async () => {
  for (const extra of [{ aspectRatio: '9:16' }, { imageSize: '4K' }]) {
    const h = harness([], { config: imageConfig() });
    await assert.rejects(h.client.startImage(imageRequest(extra)), code('CAPABILITY_MISMATCH'));
    assert.equal(h.calls.length, 0);
  }
  // The older generateContent image path declares no settings, so it accepts none.
  const legacy = harness([], { config: imageConfig() });
  await assert.rejects(legacy.client.startImage({ modelId: 'text', accounting: { accountingKey: 'x' }, prompt: 'shape', maxOutputTokens: 128, aspectRatio: '1:1' }), code('CAPABILITY_MISMATCH'));
  assert.equal(legacy.calls.length, 0);
});

test('failed, unfinished, empty, malformed and oversized image answers are rejected', async () => {
  const cases = [
    [interaction([imageBlock()], { status: 'failed' }), 'OPERATION_FAILED'],
    [interaction([imageBlock()], { status: 'in_progress' }), 'INVALID_RESPONSE'],
    [interaction([{ type: 'text', text: 'No image this time.' }]), 'INVALID_RESPONSE'],
    [interaction([{ type: 'image', mime_type: 'image/jpeg', data: '$$not-base64' }]), 'INVALID_RESPONSE'],
    [interaction([imageBlock(Buffer.from('<html>payload</html>'))]), 'INVALID_RESPONSE'],
    [interaction([imageBlock(Buffer.from('<svg/>'), 'image/svg+xml')]), 'INVALID_RESPONSE'],
    [interaction([imageBlock(PNG, 'image/jpeg')]), 'INVALID_RESPONSE'],
    [{ status: 'completed', steps: [{ type: 'thought', content: [imageBlock()] }] }, 'INVALID_RESPONSE'],
  ];
  for (const [answer, expected] of cases)
    await assert.rejects(harness([answer], { config: imageConfig() }).client.startImage(imageRequest()), code(expected), expected);
  const small = harness([interaction([imageBlock(Buffer.concat([JPEG, Buffer.alloc(2000)]))])], { config: imageConfig({ maxImageBytes: 1000 }) });
  await assert.rejects(small.client.startImage(imageRequest()), code('OUTPUT_TOO_LARGE'));
});

test('an image model must be image-only with no tools', () => {
  const bad = imageConfig(); bad.models[2].capabilities = ['image', 'tutoring'];
  assert.throws(() => harness([], { config: bad }), code('INVALID_CONFIG'));
  const tools = imageConfig(); tools.models[2].tools = ['web_search'];
  assert.throws(() => harness([], { config: tools }), code('INVALID_CONFIG'));
  const ratio = imageConfig({ aspectRatios: ['7:3'] });
  assert.throws(() => harness([], { config: ratio }), code('INVALID_CONFIG'));
});

test('capabilities are declared from configuration with retention and billing units', () => {
  const { client, registry } = harness([], { config: imageConfig() });
  assert.deepEqual(client.discoverCapabilities('video'), { modelId: 'video', providerId: 'google-account', maxPromptCharacters: 20_000, kind: 'video',
    cancellation: 'local_abort_only', billing: 'per_output_second', video: { durationSeconds: [4, 6], aspectRatios: ['16:9', '9:16'], resolutions: ['720p'] },
    retention: { outputHours: 48, providerStoresRequest: true } });
  assert.deepEqual(client.discoverCapabilities('picture'), { modelId: 'picture', providerId: 'google-account', maxPromptCharacters: 4000, kind: 'image',
    cancellation: 'not_applicable', billing: 'per_image', image: { aspectRatios: ['16:9', '1:1'], imageSizes: ['1K', '2K'], mimeTypes: ['image/jpeg'], maxImagesPerRequest: 1 },
    retention: { outputHours: null, providerStoresRequest: false } });
  assert.throws(() => client.discoverCapabilities('missing'), code('CAPABILITY_MISMATCH'));
  // The router reaches the same declaration by model, without a provider call.
  const router = new ProviderRouter(registry);
  assert.equal(router.discoverCapabilities('picture', 'image').billing, 'per_image');
  assert.throws(() => router.discoverCapabilities('picture', 'video'));
});

test('estimates are billable units times the operator price, never a built-in rate', () => {
  const { client, registry } = harness([], { config: imageConfig() });
  assert.deepEqual(client.estimateCost(videoRequest({ durationSeconds: 6 }), { microUsdPerOutputSecond: 50_000, microUsdPerRequest: 1_000, pricingVersionId: 'p-1' }),
    { currency: 'USD', microUsd: 301_000, pricingVersionId: 'p-1', units: { outputSeconds: 6, images: 0, requests: 1 }, basis: 'operator_price', reason: null });
  assert.equal(client.estimateCost(videoRequest(), null).reason, 'pricing_incomplete');
  assert.equal(client.estimateCost(videoRequest(), { microUsdPerImage: 5 }).microUsd, null);
  assert.throws(() => client.estimateCost(videoRequest({ durationSeconds: 8 }), { microUsdPerOutputSecond: 1 }), code('CAPABILITY_MISMATCH'));
  assert.equal(client.estimateCost(imageRequest(), { microUsdPerImage: 39_000 }).microUsd, 39_000);
  // A per-request price alone prices the whole call.
  assert.equal(client.estimateCost(imageRequest(), { microUsdPerRequest: 40_000 }).microUsd, 40_000);
  assert.throws(() => client.estimateCost(imageRequest({ aspectRatio: '4:3' }), { microUsdPerImage: 1 }), code('CAPABILITY_MISMATCH'));
  const router = new ProviderRouter(registry);
  assert.equal(router.estimateImageCost(imageRequest(), { microUsdPerImage: 7 }).microUsd, 7);
  assert.equal(router.estimateVideoCost(videoRequest(), { microUsdPerOutputSecond: 10 }).microUsd, 40);
});

test('priceMediaUnits refuses unsafe totals and missing rates', () => {
  assert.equal(priceMediaUnits({ outputSeconds: 4, images: 0, requests: 1 }, { microUsdPerOutputSecond: Number.MAX_SAFE_INTEGER }).microUsd, null);
  assert.equal(priceMediaUnits({ outputSeconds: 0, images: 2, requests: 1 }, { microUsdPerOutputSecond: 3 }).reason, 'pricing_incomplete');
  assert.equal(priceMediaUnits({ outputSeconds: 0, images: 0, requests: 1 }, {}).microUsd, 0);
});

test('an image interaction runs end to end against a local stub HTTP server', async () => {
  const seen = [];
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      seen.push({ method: request.method, url: request.url, key: request.headers['x-goog-api-key'], body: JSON.parse(raw) });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(interaction([imageBlock()])));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    // The adapter fixes the Google origin; only the test's fetch points it at the loopback stub.
    const fetch = (url, init) => globalThis.fetch(String(url).replace('https://generativelanguage.googleapis.com', `http://127.0.0.1:${port}`), init);
    const registry = new ModelRegistry(imageConfig());
    const client = new GoogleProvider({ providerId: 'google-account', registry, getApiKey: () => KEY, fetch,
      settings: { attemptTimeoutMs: 2000, totalTimeoutMs: 4000, maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 10 } });
    registry.registerAdapter(client);
    const result = await new ProviderRouter(registry).startImage(imageRequest());
    assert.equal(result.output.images[0].base64, JPEG.toString('base64'));
    assert.equal(seen.length, 1);
    assert.deepEqual({ method: seen[0].method, url: seen[0].url, key: seen[0].key, store: seen[0].body.store },
      { method: 'POST', url: '/v1beta/interactions', key: KEY, store: false });
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('a refused image request is classified like any other call', async () => {
  const h = harness([json({ error: { code: 400, message: 'bad' } }, 400)], { config: imageConfig() });
  await assert.rejects(h.client.startImage(imageRequest()), error => error.submission === 'rejected');
});

test('a media adapter that does not declare capabilities and cost units cannot register', () => {
  const registry = new ModelRegistry({ revision: 'r', models: [{ id: 'clip', providerId: 'vendor', remoteModel: 'native/clip', providerConfig: {}, enabled: true,
    capabilities: ['video'], tools: [], limits: { maxInputCharacters: 1000 } }] });
  const run = { async startVideo() { throw new Error('unused'); }, async pollVideo() { throw new Error('unused'); } };
  assert.throws(() => registry.registerAdapter({ providerId: 'vendor', validateModel() {}, ports: { video: run } }), code('INVALID_CONFIG'));
  assert.throws(() => registry.registerAdapter({ providerId: 'vendor', validateModel() {}, ports: { video: { ...run, discoverCapabilities: () => ({}) } } }), code('INVALID_CONFIG'));
});
