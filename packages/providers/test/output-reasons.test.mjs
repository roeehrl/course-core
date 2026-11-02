import test from 'node:test';
import assert from 'node:assert/strict';
import { ProviderError } from '../dist/index.js';
import { GOOGLE_OUTPUT_REASONS } from '../dist/google-index.js';
import { harness, config, request, textResponse, json, body } from './helpers.mjs';

// Synthetic generateContent / streamGenerateContent fixtures shaped like a thinking Gemini
// model's replies. No live provider call is made.
const usage = (thoughts) => ({ promptTokenCount: 2002, candidatesTokenCount: 0, thoughtsTokenCount: thoughts, totalTokenCount: 2002 + thoughts });
/** The limit reached while thinking: no visible part; without includeThoughts Google returns no thought part either. */
function thoughtsUsedLimit({ content = { role: 'model' } } = {}) {
  return { candidates: [{ index: 0, finishReason: 'MAX_TOKENS', ...(content === null ? {} : { content }) }], usageMetadata: usage(4096) };
}
function sse(frames) {
  const text = frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('');
  return new Response(text, { headers: { 'content-type': 'text/event-stream' } });
}
async function refusal(promise) {
  const error = await promise.then(() => null, e => e);
  assert.ok(error instanceof ProviderError, String(error));
  return error;
}
const whole = (raw, extra = {}) => refusal(harness([raw]).client.tutor(request(extra)));
const streamed = (frames, extra = {}) => refusal(harness([sse(frames)]).client.tutorStream(request(extra), {}, () => {}));

test('thoughts that used the whole output limit are INCOMPLETE_OUTPUT with reason MAX_TOKENS_THINKING, whole or streamed, cut short allowed or not', async () => {
  for (const allowCutShort of [false, true]) {
    for (const raw of [thoughtsUsedLimit(), thoughtsUsedLimit({ content: null }),
      thoughtsUsedLimit({ content: { role: 'model', parts: [{ text: 'private reasoning', thought: true }] } })]) {
      const error = await whole(raw, { allowCutShort });
      assert.deepEqual([error.code, error.reason], ['INCOMPLETE_OUTPUT', 'MAX_TOKENS_THINKING'], JSON.stringify(raw));
      // The model ran: its usage is kept, so the call is settled at that usage (a definite outcome).
      assert.equal(error.usage.attempts[0].outcome, 'response');
      assert.equal(error.usage.attempts[0].tokens.thoughts, 4096);
      assert.equal(JSON.stringify(error).includes('private reasoning'), false);
    }
    const error = await streamed([{ candidates: [{ index: 0, finishReason: 'MAX_TOKENS', content: { role: 'model', parts: [] } }], usageMetadata: usage(4096) }], { allowCutShort });
    assert.deepEqual([error.code, error.reason], ['INCOMPLETE_OUTPUT', 'MAX_TOKENS_THINKING']);
  }
  // A visible start that is too short to deliver is the plain limit, not the thinking one.
  const short = textResponse('Short start of'); short.candidates[0].finishReason = 'MAX_TOKENS';
  for (const allowCutShort of [false, true]) assert.equal((await whole(short, { allowCutShort })).reason, 'MAX_TOKENS');
  // No thinking reported: the plain limit.
  const plain = thoughtsUsedLimit(); plain.usageMetadata = { promptTokenCount: 10, candidatesTokenCount: 128, totalTokenCount: 138 };
  assert.equal((await whole(plain, { allowCutShort: true })).reason, 'MAX_TOKENS');
});

test('a safety or recitation stop is BLOCKED with the finish reason; a blocked prompt names its block reason', async () => {
  for (const finish of ['SAFETY', 'RECITATION', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII']) {
    const raw = textResponse('partial'); raw.candidates[0].finishReason = finish;
    assert.deepEqual([(await whole(raw)).code, (await whole(raw)).reason], ['BLOCKED', finish]);
  }
  const rated = textResponse('x'); rated.candidates[0].safetyRatings = [{ blocked: true }];
  assert.deepEqual([(await whole(rated)).code, (await whole(rated)).reason], ['BLOCKED', 'SAFETY']);
  const prompt = { promptFeedback: { blockReason: 'SAFETY' }, usageMetadata: { promptTokenCount: 10, totalTokenCount: 10 } };
  assert.deepEqual([(await whole(prompt)).code, (await whole(prompt)).reason], ['BLOCKED', 'PROMPT_SAFETY']);
  const blocked = await streamed([{ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' }, usageMetadata: { promptTokenCount: 10, totalTokenCount: 10 } }]);
  assert.deepEqual([blocked.code, blocked.reason], ['BLOCKED', 'PROMPT_PROHIBITED_CONTENT']);
  const stoppedStream = await streamed([{ candidates: [{ index: 0, finishReason: 'RECITATION', content: { role: 'model', parts: [{ text: 'quoted' }] } }] }]);
  assert.deepEqual([stoppedStream.code, stoppedStream.reason], ['BLOCKED', 'RECITATION']);
});

test('an empty reply is INVALID_RESPONSE with NO_CANDIDATE, THOUGHTS_ONLY or EMPTY_OUTPUT; another stop keeps its finish reason', async () => {
  const cases = [
    [{ candidates: [], usageMetadata: { promptTokenCount: 10, totalTokenCount: 10 } }, 'INVALID_RESPONSE', 'NO_CANDIDATE'],
    [{ usageMetadata: { promptTokenCount: 10, totalTokenCount: 10 } }, 'INVALID_RESPONSE', 'NO_CANDIDATE'],
    // Finished after thinking with nothing visible: thought parts only, or no parts with thought tokens reported.
    [{ candidates: [{ index: 0, finishReason: 'STOP', content: { role: 'model', parts: [{ text: 'private reasoning', thought: true }] } }], usageMetadata: usage(300) }, 'INVALID_RESPONSE', 'THOUGHTS_ONLY'],
    [{ candidates: [{ index: 0, finishReason: 'STOP', content: { role: 'model' } }], usageMetadata: usage(300) }, 'INVALID_RESPONSE', 'THOUGHTS_ONLY'],
    [{ candidates: [{ index: 0, finishReason: 'STOP', content: { role: 'model' } }], usageMetadata: { promptTokenCount: 10, totalTokenCount: 10 } }, 'INVALID_RESPONSE', 'EMPTY_OUTPUT'],
    [{ candidates: [{ index: 0, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, totalTokenCount: 10 } }, 'INVALID_RESPONSE', 'EMPTY_OUTPUT'],
    [textResponse('   ', { usageMetadata: { promptTokenCount: 10, totalTokenCount: 10 } }), 'INVALID_RESPONSE', 'EMPTY_OUTPUT'],
    [(() => { const raw = textResponse(); raw.candidates[0].finishReason = 'OTHER'; return raw; })(), 'INCOMPLETE_OUTPUT', 'OTHER'],
  ];
  for (const [raw, code, reason] of cases) {
    for (const allowCutShort of [false, true]) {
      const error = await whole(raw, { allowCutShort });
      assert.deepEqual([error.code, error.reason], [code, reason], JSON.stringify(raw));
    }
  }
  const unfinished = await streamed([{ candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'Half an ans' }] } }] }]);
  assert.deepEqual([unfinished.code, unfinished.reason], ['INCOMPLETE_OUTPUT', 'NO_FINISH_REASON']);
  const thoughtOnly = await streamed([{ candidates: [{ index: 0, finishReason: 'STOP', content: { role: 'model', parts: [] } }], usageMetadata: usage(250) }]);
  assert.deepEqual([thoughtOnly.code, thoughtOnly.reason], ['INVALID_RESPONSE', 'THOUGHTS_ONLY']);
  // Every named cause is an upper snake case code, never provider text.
  for (const reason of GOOGLE_OUTPUT_REASONS) assert.match(reason, /^[A-Z][A-Z0-9_]{0,63}$/);
});

test('none of the output checks says NO_RESPONSE: that is only a first-byte bound expiring before the finished whole reply arrives', async () => {
  // A whole generateContent reply sends nothing until the model finished thinking and writing.
  const after = (ms, raw) => () => new Promise(resolve => setTimeout(() => resolve(json(raw)), ms));
  const late = await refusal(harness([after(120, textResponse())]).client.tutor(request(), { firstByteTimeoutMs: 40 }));
  assert.equal(late.code, 'NO_RESPONSE');
  assert.equal(late.reason, null);
  assert.deepEqual(late.usage.attempts.map(a => [a.status, a.outcome]), [[null, 'unknown']]);
  // Sent, outcome unknown: never replayed automatically, even with attempts to spare.
  assert.equal(late.usage.attempts.length, 1);
  // The same reply within the bound is delivered.
  const result = await harness([after(20, textResponse())]).client.tutor(request(), { firstByteTimeoutMs: 150 });
  assert.equal(result.output.text, 'A useful explanation.');
});

test('a thinking budget above half the output limit is sent as half of it, so visible text keeps room', async () => {
  const budgeted = (budget) => { const c = config(); c.models[0].providerConfig = { ...c.models[0].providerConfig, thinking: { budget } }; return c; };
  const sent = async (budget, maxOutputTokens) => {
    const h = harness([textResponse()], { config: budgeted(budget) });
    await h.client.tutor(request({ maxOutputTokens }));
    return body(h.calls[0]).generationConfig.thinkingConfig.thinkingBudget;
  };
  assert.equal(await sent(4096, 1024), 512);
  assert.equal(await sent(512, 1024), 512);
  assert.equal(await sent(300, 1024), 300);
  // Dynamic and off are sent as configured; a half below every model's minimum budget is not sent.
  assert.equal(await sent(-1, 1024), -1);
  assert.equal(await sent(0, 1024), 0);
  assert.equal(await sent(4096, 1000), 4096);
  // The streamed path uses the same generationConfig.
  const h = harness([sse([{ candidates: [{ index: 0, finishReason: 'STOP', content: { role: 'model', parts: [{ text: 'ok' }] } }] }])], { config: budgeted(8000) });
  await h.client.tutorStream(request({ maxOutputTokens: 1024 }), {}, () => {});
  assert.equal(body(h.calls[0]).generationConfig.thinkingConfig.thinkingBudget, 512);
});
