import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelRegistry, ProviderRouter, ProviderError } from '../dist/index.js';

const PROMPT = 'Learner wrote: my email is dana@example.com and my answer is 42';
const KEY = 'synthetic-observer-key';
function setup(behaviour) {
  const registry = new ModelRegistry({ revision: 'observer-v1', models: [{ id: 'tutor-model', providerId: 'observer-vendor', remoteModel: 'native/model',
    providerConfig: {}, enabled: true, capabilities: ['tutoring', 'structured_assessment'], tools: [], limits: { maxInputCharacters: 10000, maxOutputTokens: 1000 } }] });
  const usage = (input, attempts) => ({ accounting: input.accounting, providerId: 'observer-vendor', modelId: input.modelId, operation: 'tutor', attempts,
    inputCharacters: PROMPT.length, requestedMaxOutputTokens: 1000, requestedVideoSeconds: null, observedImageCount: null, observedVideoCount: null, cost: null });
  const attempt = (n, tokens) => ({ attempt: n, status: 200, outcome: 'response', tokens: { input: tokens.input, output: tokens.output, total: tokens.total, cachedInput: null, thoughts: null, toolInput: null } });
  registry.registerAdapter({ providerId: 'observer-vendor', validateModel() {}, ports: {
    tutoring: { async tutor(input) { return behaviour(input, usage, attempt); } },
    structured_assessment: { async assess(input) { return { output: { free: PROMPT }, usage: usage(input, [attempt(1, { input: 3, output: 4, total: 7 })]) }; } },
  } });
  return registry;
}
const request = { modelId: 'tutor-model', accounting: { accountingKey: `acct:${KEY}` }, systemInstruction: PROMPT, messages: [{ role: 'user', text: PROMPT }], maxOutputTokens: 100 };

test('router observer receives only allowlisted call metadata with summed token counters', async () => {
  const events = [];
  const router = new ProviderRouter(setup((input, usage, attempt) => ({ output: { text: PROMPT },
    usage: usage(input, [attempt(1, { input: 10, output: 0, total: 10 }), attempt(2, { input: 20, output: 5, total: 25 })]) })),
  { observe: start => { events.push(['start', start]); return end => events.push(['end', end]); } });
  const result = await router.tutor(request);
  assert.equal(result.output.text, PROMPT);
  assert.equal(events.length, 2);
  assert.deepEqual(events[0][1], { operation: 'tutor', modelId: 'tutor-model' });
  const end = events[1][1];
  assert.deepEqual(Object.keys(end).sort(), ['access', 'attempts', 'code', 'elapsedMs', 'outcome', 'providerId', 'tokens']);
  assert.deepEqual({ ...end, elapsedMs: 0 }, { outcome: 'response', code: null, providerId: 'observer-vendor', attempts: 2,
    tokens: { input: 30, output: 5, total: 35 }, access: null, elapsedMs: 0 });
  assert.ok(Object.isFrozen(end) && Object.isFrozen(events[0][1]));
  const serialized = JSON.stringify(events);
  for (const secret of [PROMPT, KEY, 'acct:', 'dana@example.com']) assert.ok(!serialized.includes(secret), secret);
});
test('observer reports errors by code and unknown counters as null, and output validation failures keep usage', async () => {
  const events = [];
  const observe = () => end => events.push(end);
  const failing = new ProviderRouter(setup((input, usage) => {
    const error = new ProviderError('THROTTLED', { submission: 'rejected' });
    error.usage = usage(input, [{ attempt: 1, status: 429, outcome: 'rejected', tokens: { input: null, output: null, total: null, cachedInput: null, thoughts: null, toolInput: null } }]);
    throw error;
  }), { observe });
  await assert.rejects(failing.tutor(request), error => error instanceof ProviderError && error.code === 'THROTTLED');
  assert.deepEqual({ ...events[0], elapsedMs: 0 }, { outcome: 'error', code: 'THROTTLED', providerId: 'observer-vendor', attempts: 1,
    tokens: { input: null, output: null, total: null }, access: null, elapsedMs: 0 });
  const unexpected = new ProviderRouter(setup(() => { throw new Error(PROMPT); }), { observe });
  await assert.rejects(unexpected.tutor(request), new RegExp(PROMPT));
  assert.deepEqual({ ...events[1], elapsedMs: 0 }, { outcome: 'error', code: 'UNEXPECTED', providerId: null, attempts: 0, tokens: null, access: null, elapsedMs: 0 });
  await assert.rejects(unexpected.assess({ ...request, outputSchema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] } }),
    error => error instanceof ProviderError && error.code === 'INVALID_RESPONSE');
  assert.deepEqual({ ...events[2], elapsedMs: 0 }, { outcome: 'error', code: 'INVALID_RESPONSE', providerId: 'observer-vendor', attempts: 1,
    tokens: { input: 3, output: 4, total: 7 }, access: null, elapsedMs: 0 });
  assert.ok(!JSON.stringify(events).includes(PROMPT));
});
test('throwing observers can neither fail nor replay a call', async () => {
  let calls = 0;
  const registry = setup((input, usage, attempt) => { calls++; return { output: { text: 'ok' }, usage: usage(input, [attempt(1, { input: 1, output: 1, total: 2 })]) }; });
  for (const observe of [() => { throw new Error(KEY); }, () => () => { throw new Error(KEY); }]) {
    assert.equal((await new ProviderRouter(registry, { observe }).tutor(request)).output.text, 'ok');
  }
  assert.equal((await new ProviderRouter(registry).tutor(request)).output.text, 'ok');
  assert.equal(calls, 3);
});
