import test from 'node:test';
import assert from 'node:assert/strict';
import { compileOutputSchema } from '../dist/index.js';
import { harness, request, textResponse, body, KEY, PROMPT, assessmentSchema, ASSESSMENT, code } from './helpers.mjs';

test('generateContent REST contract uses configured model, text history, system instruction and a server-only header', async () => {
  const h = harness([textResponse()]);
  const result = await h.client.tutor(request({ systemInstruction: 'Guide the learner.', messages: [
    { role: 'user', text: 'Earlier question' }, { role: 'assistant', text: 'Earlier explanation' }, { role: 'user', text: PROMPT },
  ] }));
  assert.equal(h.calls[0].url, 'https://generativelanguage.googleapis.com/v1beta/models/admin-selected-text-model:generateContent');
  assert.equal(h.calls[0].init.headers['x-goog-api-key'], KEY); assert.equal(h.calls[0].init.redirect, 'error');
  assert.equal(h.calls[0].url.includes(KEY), false);
  const sent = body(h.calls[0]);
  assert.deepEqual(sent.contents.map(c => c.role), ['user', 'model', 'user']);
  assert.deepEqual(sent.systemInstruction, { parts: [{ text: 'Guide the learner.' }] });
  assert.deepEqual(sent.generationConfig, { candidateCount: 1, maxOutputTokens: 128 });
  assert.equal(sent.tools, undefined);
  assert.equal(result.output.text, 'A useful explanation.');
  assert.deepEqual(result.usage.attempts[0].tokens, { input: 11, output: 7, total: 21, cachedInput: 4, thoughts: 3, toolInput: null });
  assert.equal(result.usage.cost, null); assert.equal(result.usage.accounting.estimatedInputTokens, 10);
});

test('missing usage is unknown, never zero or a fabricated total', async () => {
  const raw = textResponse(); delete raw.usageMetadata;
  const result = await harness([raw]).client.tutor(request());
  assert.deepEqual(Object.values(result.usage.attempts[0].tokens), [null, null, null, null, null, null]);
});

test('thought text/signatures are not exposed in normal output', async () => {
  const raw = textResponse(); raw.candidates[0].content.parts = [{ text: 'hidden thought', thought: true, thoughtSignature: 'secret-signature' }, { text: 'Visible answer' }];
  const result = await harness([raw]).client.tutor(request());
  assert.deepEqual(result.output, { text: 'Visible answer' });
  assert.equal(JSON.stringify(result).includes('hidden thought'), false);
});

test('malformed, truncated, unsafe or unexpected content never becomes a successful tutoring result', async () => {
  const cases = [
    [{}, 'INVALID_RESPONSE'], [{ candidates: [] }, 'INVALID_RESPONSE'],
    [textResponse('', {}), 'INVALID_RESPONSE'],
    [textResponse('answer', { candidates: [textResponse().candidates[0], textResponse().candidates[0]] }), 'INVALID_RESPONSE'],
    [textResponse('answer', { promptFeedback: { blockReason: 'SAFETY' } }), 'BLOCKED'],
    [textResponse('answer', { usageMetadata: { promptTokenCount: '11' } }), 'INVALID_RESPONSE'],
    [textResponse('answer', { usageMetadata: { totalTokenCount: -1 } }), 'INVALID_RESPONSE'],
  ];
  for (const [raw, expected] of cases) await assert.rejects(harness([raw]).client.tutor(request()), code(expected));
  for (const reason of ['MAX_TOKENS', 'UNKNOWN_NEW_REASON']) {
    const raw = textResponse(); raw.candidates[0].finishReason = reason;
    await assert.rejects(harness([raw]).client.tutor(request()), code('INCOMPLETE_OUTPUT'));
  }
  for (const part of [{ functionCall: { name: 'delete_records', args: {} } }, { text: 'visible', executableCode: { code: 'bad' } }, { text: 42 }]) {
    const raw = textResponse(); raw.candidates[0].content.parts = [part];
    await assert.rejects(harness([raw]).client.tutor(request()), code('INVALID_RESPONSE'));
  }
});

test('structured assessment sends current responseFormat JSON schema and validates exact typed output', async () => {
  const h = harness([textResponse(JSON.stringify(ASSESSMENT))]);
  const result = await h.client.assess({ ...request(), outputSchema: assessmentSchema });
  assert.deepEqual(result.output, ASSESSMENT);
  const generation = body(h.calls[0]).generationConfig;
  assert.equal(generation.responseFormat.text.mimeType, 'application/json');
  assert.equal(generation.responseFormat.text.schema.additionalProperties, false);
  assert.equal(generation.responseSchema, undefined); assert.equal(generation.responseJsonSchema, undefined);
  assert.equal(body(h.calls[0]).tools, undefined);
});

test('structured output rejects coercion, extra keys, bounds, prototype attacks and Markdown wrappers', async () => {
  for (const output of [
    { ...ASSESSMENT, score: '2' }, { ...ASSESSMENT, score: 4 }, { ...ASSESSMENT, score: 1.5 },
    { ...ASSESSMENT, passed: true }, { ...ASSESSMENT, labels: ['invented'] }, { ...ASSESSMENT, labels: ['gap', 'gap', 'gap'] },
    { score: 2 }, { ...ASSESSMENT, feedback: null },
  ]) await assert.rejects(harness([textResponse(JSON.stringify(output))]).client.assess({ ...request(), outputSchema: assessmentSchema }), code('INVALID_RESPONSE'));
  for (const output of ['```json\n{}\n```', '{bad-json', '{"__proto__":{"polluted":true}}', '1e999']) {
    await assert.rejects(harness([textResponse(output)]).client.assess({ ...request(), outputSchema: assessmentSchema }), code('INVALID_RESPONSE'));
  }
  assert.equal({}.polluted, undefined);
});

test('nested optional fields and primitive contracts validate without accepting unknown object keys', () => {
  const compiled = compileOutputSchema({ type: 'object', properties: { optional: { type: 'null' }, required: { type: 'array', minItems: 1, maxItems: 2, items: { type: 'number', minimum: 0 } } }, required: ['required'] });
  assert.deepEqual(compiled.validate({ required: [1.25] }), { required: [1.25] });
  assert.throws(() => compiled.validate({ required: [1], optional: 0 }), code('INVALID_RESPONSE'));
  assert.equal(compileOutputSchema({ type: 'boolean' }).validate(true), true);
});

test('Google Search is sent only for explicitly configured research; byte citations and untrusted suggestions are retained', async () => {
  const raw = textResponse('é🙂 fact');
  raw.candidates[0].groundingMetadata = {
    groundingChunks: [{ web: { uri: 'https://example.org/source', title: 'Source' } }],
    groundingSupports: [{ segment: { startIndex: 0, endIndex: 6, text: 'é🙂' }, groundingChunkIndices: [0] }],
    webSearchQueries: ['synthetic query'], searchEntryPoint: { renderedContent: '<div>Provider suggestions</div>' },
  };
  const h = harness([raw]); const result = await h.client.research(request());
  assert.deepEqual(body(h.calls[0]).tools, [{ googleSearch: {} }]);
  assert.equal(result.output.grounding, 'grounded');
  assert.deepEqual(result.output.parts, [{ partIndex: 0, text: 'é🙂 fact' }]);
  assert.deepEqual(result.output.citations, [{ partIndex: 0, startByte: 0, endByte: 6, sourceIndices: [0] }]);
  assert.equal(result.output.searchSuggestionsHtml, '<div>Provider suggestions</div>');
});

test('research without citations is explicitly not grounded and does not fabricate sources', async () => {
  const result = await harness([textResponse()]).client.research(request());
  assert.equal(result.output.grounding, 'not_grounded'); assert.deepEqual(result.output.sources, []);
});

test('malicious grounding URLs, invalid source indices and split UTF-8 ranges are rejected', async () => {
  for (const patch of [
    m => m.groundingChunks[0].web.uri = 'javascript:alert(1)',
    m => m.groundingChunks[0].web.uri = 'https://user:password@example.org',
    m => m.groundingSupports[0].groundingChunkIndices = [99],
    m => m.groundingSupports[0].segment.endIndex = 1,
    m => m.groundingSupports[0].segment.partIndex = 5,
    m => m.groundingSupports[0].segment.text = 'fabricated',
  ]) {
    const raw = textResponse('é🙂'); const metadata = { groundingChunks: [{ web: { uri: 'https://example.org', title: 'Source' } }],
      groundingSupports: [{ segment: { startIndex: 0, endIndex: 6, text: 'é🙂' }, groundingChunkIndices: [0] }] };
    patch(metadata); raw.candidates[0].groundingMetadata = metadata;
    await assert.rejects(harness([raw]).client.research(request()), code('INVALID_RESPONSE'));
  }
});

test('image jobs return validated media data and count observed images independently of token usage', async () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6fGQAAAAASUVORK5CYII=';
  const raw = textResponse(); raw.candidates[0].content.parts = [{ inlineData: { mimeType: 'image/png', data: png } }];
  const h = harness([raw]);
  const result = await h.client.startImage({ modelId: 'text', accounting: { accountingKey: 'image' }, prompt: 'A simple shape.', maxOutputTokens: 128 });
  assert.deepEqual(body(h.calls[0]).generationConfig.responseModalities, ['TEXT', 'IMAGE']);
  assert.equal(result.output.state, 'completed'); assert.equal(result.output.images[0].byteLength, Buffer.from(png, 'base64').length);
  assert.equal(result.usage.observedImageCount, 1);
});

test('image generation fails on missing images, invalid base64, MIME mismatches and active formats', async () => {
  for (const part of [{ text: 'No image' }, { inlineData: { mimeType: 'image/png', data: '$$invalid' } },
    { inlineData: { mimeType: 'image/png', data: Buffer.from('html payload').toString('base64') } },
    { inlineData: { mimeType: 'image/svg+xml', data: Buffer.from('<svg/>').toString('base64') } }]) {
    const raw = textResponse(); raw.candidates[0].content.parts = [part];
    await assert.rejects(harness([raw]).client.startImage({ modelId: 'text', accounting: { accountingKey: 'image' }, prompt: 'shape', maxOutputTokens: 128 }), code('INVALID_RESPONSE'));
  }
});
