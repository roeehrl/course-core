import test from 'node:test';
import assert from 'node:assert/strict';
import { MIN_CUT_SHORT_CHARACTERS, ProviderError } from '../dist/index.js';
import { googleModelConfigSchema } from '../dist/google-index.js';
import { harness, config, request, textResponse, body, code } from './helpers.mjs';

// Synthetic generateContent fixtures shaped like a thinking model's response (thought parts,
// thoughtsTokenCount). No live provider call is made.
function thinkingConfig(thinking) {
  const c = config();
  c.models[0].providerConfig = { ...c.models[0].providerConfig, ...(thinking ? { thinking } : {}) };
  return c;
}
/** A response stopped at the output limit: the thinking used most of it. */
function cutOff(visible, { thoughts = 947, candidates = 49 } = {}) {
  return { candidates: [{ index: 0, finishReason: 'MAX_TOKENS', content: { role: 'model', parts: [
    { text: 'private reasoning', thought: true }, ...(visible === null ? [] : [{ text: visible }]) ] } }],
    usageMetadata: { promptTokenCount: 2002, candidatesTokenCount: candidates, thoughtsTokenCount: thoughts, totalTokenCount: 2002 + candidates + thoughts } };
}

test('a configured thinking level is sent as generationConfig.thinkingConfig.thinkingLevel', async () => {
  const h = harness([textResponse()], { config: thinkingConfig({ level: 'low' }) });
  await h.client.tutor(request());
  assert.deepEqual(body(h.calls[0]).generationConfig, { candidateCount: 1, maxOutputTokens: 128, thinkingConfig: { thinkingLevel: 'low' } });
});

test('a Gemini 2.5 thinking budget is sent as thinkingBudget, never together with a level', async () => {
  const h = harness([textResponse()], { config: thinkingConfig({ budget: 512 }) });
  await h.client.tutor(request());
  assert.deepEqual(body(h.calls[0]).generationConfig.thinkingConfig, { thinkingBudget: 512 });
  // Both at once is a 400 at the API; the configuration refuses it before anything is sent.
  assert.equal(googleModelConfigSchema.safeParse({ transport: 'generate_content', apiVersion: 'v1beta', maxResponseBytes: 1000, thinking: { level: 'low', budget: 0 } }).success, false);
  assert.equal(googleModelConfigSchema.safeParse({ transport: 'generate_content', apiVersion: 'v1beta', maxResponseBytes: 1000, thinking: { level: 'extreme' } }).success, false);
});

test('without a thinking setting no thinkingConfig is sent (the model default applies)', async () => {
  const h = harness([textResponse()]);
  await h.client.tutor(request());
  assert.equal(body(h.calls[0]).generationConfig.thinkingConfig, undefined);
});

test('thinking usage is reported separately from the visible output and is part of the total', async () => {
  const raw = textResponse('Visible answer that is long enough.');
  raw.candidates[0].content.parts.unshift({ text: 'private reasoning', thought: true, thoughtSignature: 'sig' });
  raw.usageMetadata = { promptTokenCount: 2002, candidatesTokenCount: 395, thoughtsTokenCount: 461, totalTokenCount: 2858 };
  const result = await harness([raw]).client.tutor(request());
  assert.equal(result.output.text, 'Visible answer that is long enough.');
  assert.equal(result.output.cutShort, undefined);
  assert.deepEqual(result.usage.attempts[0].tokens, { input: 2002, output: 395, total: 2858, cachedInput: null, thoughts: 461, toolInput: null });
  assert.equal(JSON.stringify(result).includes('private reasoning'), false);
});

test('MAX_TOKENS is refused as INCOMPLETE_OUTPUT with its usage kept, unless the request allows a cut-short reply', async () => {
  const long = 'The weight increases because gradient descent moves against the gradient. '.repeat(4);
  const refused = await harness([cutOff(long)]).client.tutor(request()).catch(e => e);
  assert.ok(refused instanceof ProviderError); assert.equal(refused.code, 'INCOMPLETE_OUTPUT');
  assert.equal(refused.usage.attempts[0].outcome, 'response');
  assert.equal(refused.usage.attempts[0].tokens.thoughts, 947); assert.equal(refused.usage.attempts[0].tokens.total, 2998);
  const delivered = await harness([cutOff(long)]).client.tutor(request({ allowCutShort: true }));
  assert.deepEqual(delivered.output, { text: long, cutShort: true });
  assert.equal(delivered.usage.attempts[0].tokens.total, 2998);
});

test('a cut-short reply with too little visible text, or only thoughts, stays incomplete even when allowed', async () => {
  for (const visible of [null, 'Short start of', ' '.repeat(MIN_CUT_SHORT_CHARACTERS + 5)]) {
    const error = await harness([cutOff(visible)]).client.tutor(request({ allowCutShort: true })).catch(e => e);
    assert.equal(error.code, 'INCOMPLETE_OUTPUT', String(visible));
    assert.equal(error.usage.attempts[0].tokens.total, 2998);
  }
  const noContent = cutOff(null); delete noContent.candidates[0].content;
  await assert.rejects(harness([noContent]).client.tutor(request({ allowCutShort: true })), code('INCOMPLETE_OUTPUT'));
});

test('structured and research output stopped at MAX_TOKENS is never accepted, whatever the request says', async () => {
  const raw = cutOff('{"score": 2, "feedback": "x"}');
  await assert.rejects(harness([raw]).client.research(request({ allowCutShort: true })), code('INCOMPLETE_OUTPUT'));
  const schema = { type: 'object', properties: { score: { type: 'integer' } }, required: ['score'] };
  await assert.rejects(harness([cutOff('{"score": 2}')]).client.assess({ ...request({ allowCutShort: true }), outputSchema: schema }), code('INCOMPLETE_OUTPUT'));
});
