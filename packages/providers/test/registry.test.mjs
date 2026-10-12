import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelRegistry, compileOutputSchema } from '../dist/index.js';
import { GoogleProvider } from '../dist/google-index.js';
import { config, harness, request, code, KEY } from './helpers.mjs';

test('registry requires admin declarations and contains no implicit model selection or capability claims', async () => {
  const registry = new ModelRegistry({ revision: 'empty', models: [] });
  assert.deepEqual(registry.list(), []);
  const h = harness([], { config: { revision: 'empty', models: [] } });
  await assert.rejects(h.client.tutor(request()), code('UNKNOWN_MODEL'));
  assert.deepEqual(h.client.capabilities('unknown'), []); assert.equal(h.calls.length, 0);
});

test('disabled models, wrong provider bindings and missing capabilities fail before credentials or HTTP', async () => {
  for (const edit of [
    m => m.enabled = false, m => m.providerId = 'other-account',
    m => { m.capabilities = ['image']; m.tools = []; },
  ]) {
    const cfg = config(); edit(cfg.models[0]);
    const h = harness([], { config: cfg, client: { getApiKey: () => { assert.fail('Credential must not be requested'); } } });
    await assert.rejects(h.client.tutor(request()), code('CAPABILITY_MISMATCH'));
    assert.equal(h.calls.length, 0);
  }
});

test('portable config rejects duplicate identities, invalid capabilities and unknown envelope fields', () => {
  for (const edit of [
    c => c.models.push(c.models[0]), c => c.models[0].capabilities.push('unlimited'),
    c => c.models[0].limits.maxOutputTokens = Infinity,
    c => c.models[0].apiKey = KEY, c => c.models[0].capabilities.push('tutoring'),
  ]) { const cfg = config(); edit(cfg); assert.throws(() => new ModelRegistry(cfg), code('INVALID_CONFIG')); }
});

test('Google adapter retains strict native config validation at registration and direct require', async () => {
  for (const edit of [
    c => c.models[0].tools.push('code_execution'), c => c.models[0].tools = [],
    c => c.models[0].capabilities.push('video'), c => delete c.models[1].providerConfig.video,
    c => c.models[0].remoteModel = '../evil?key=secret', c => c.models[0].providerConfig.apiVersion = 'vendor-version',
    c => c.models[0].providerConfig.apiKey = KEY, c => c.models[0].providerConfig.maxResponseBytes = -1,
  ]) {
    const cfg = config(); edit(cfg);
    assert.doesNotThrow(() => new ModelRegistry(cfg));
    assert.throws(() => harness([], { config: cfg }), code('INVALID_CONFIG'));
  }
  const cfg = config(); cfg.models[0].providerConfig = { nativeOtherVendorField: true };
  const client = new GoogleProvider({ providerId: 'google-account', registry: new ModelRegistry(cfg), getApiKey: () => { assert.fail('Must validate before credentials'); } });
  await assert.rejects(client.tutor(request()), code('INVALID_CONFIG'));
});

test('config and list mutations do not alter the registry snapshot', () => {
  const cfg = config(), registry = new ModelRegistry(cfg);
  cfg.models[0].enabled = false;
  const listing = registry.list(); listing[0].remoteModel = 'changed'; listing[0].capabilities.length = 0;
  const actual = registry.require('text', 'tutoring', 'google-account');
  assert.equal(actual.remoteModel, 'admin-selected-text-model'); assert.equal(actual.enabled, true);
});

test('strict message and option contracts reject unknown tools, invalid roles and budgets', async () => {
  const h = harness();
  for (const patch of [
    { tools: ['web_search'] }, { maxOutputTokens: 0 }, { maxOutputTokens: NaN }, { maxOutputTokens: 5000 },
    { messages: [] }, { messages: [{ role: 'system', text: 's' }] }, { messages: [{ role: 'assistant', text: 'a' }] },
    { messages: [{ role: 'user', text: 'a' }, { role: 'user', text: 'b' }] },
    { messages: [{ role: 'user', text: 'x'.repeat(20_001) }] }, { apiKey: KEY },
  ]) await assert.rejects(h.client.tutor(request(patch)), code('INVALID_INPUT'));
  await assert.rejects(h.client.tutor(request(), { timeoutMs: 0 }), code('INVALID_INPUT'));
  await assert.rejects(h.client.tutor(request(), { signal: 'aborted' }), code('INVALID_INPUT'));
  assert.equal(h.calls.length, 0);
});

test('server-only constructor rejects browser-like runtimes', () => {
  globalThis.window = {};
  try { assert.throws(() => new GoogleProvider({ providerId: 'google-account', registry: new ModelRegistry(config()), getApiKey: () => KEY }), code('SERVER_ONLY')); }
  finally { delete globalThis.window; }
});

test('output contracts reject remote refs, executable validators, cycles, unsafe keys and excessive nesting', () => {
  const cyclic = { type: 'array', minItems: 0, maxItems: 1 }; cyclic.items = cyclic;
  let deep = { type: 'string' }; for (let i = 0; i < 30; i++) deep = { type: 'array', minItems: 0, maxItems: 1, items: deep };
  for (const schema of [
    { type: 'string', $ref: 'https://example.invalid/schema' }, { type: 'string', validate: () => true }, cyclic, deep,
    JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"}},"required":[]}'),
    { type: 'object', properties: {}, required: ['absent'] }, { type: 'array', items: { type: 'string' }, minItems: 3, maxItems: 1 },
    { type: 'number', minimum: 4, maximum: 2 },
  ]) assert.throws(() => compileOutputSchema(schema), code('INVALID_INPUT'));
});
