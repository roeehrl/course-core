import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import * as portable from '../dist/index.js';
import { ModelRegistry, ProviderRouter, ProviderError } from '../dist/index.js';
import { harness, request, textResponse, code, mediaDeclarations } from './helpers.mjs';

const MODEL = 'tenant/models/tutor @ revision+7';
const nativeConfig = z.strictObject({ dialect: z.literal(7), route: z.strictObject({ namespace: z.string(), deployment: z.number().int() }) });
const nativeJob = z.strictObject({ ticket: z.strictObject({ batch: z.number().int(), slot: z.string() }) });
function config() {
  return { revision: 'neutral-v1', models: [{ id: MODEL, providerId: 'other-vendor', remoteModel: 'org/region/deployment:42@revision+7',
    providerConfig: { dialect: 7, route: { namespace: 'teaching', deployment: 42 } }, enabled: true,
    capabilities: ['tutoring', 'video'], tools: ['vendor:retrieval'], limits: { maxInputCharacters: 10000, maxOutputTokens: 1000 } }] };
}
function fakeAdapter(registry) {
  const calls = [];
  const usage = (input, operation) => ({ accounting: input.accounting, providerId: 'other-vendor', modelId: input.modelId,
    operation, attempts: [], inputCharacters: 0, requestedMaxOutputTokens: null, requestedVideoSeconds: null,
    observedImageCount: null, observedVideoCount: null, cost: null });
  const adapter = {
    providerId: 'other-vendor',
    validateModel(model) {
      nativeConfig.parse(model.providerConfig);
      assert.match(model.remoteModel, /^org\/region\/deployment:/);
      assert.equal(model.transport, undefined); assert.equal(model.apiVersion, undefined);
      calls.push('validate');
    },
    ports: {
      tutoring: { async tutor(input) {
        const model = registry.require(input.modelId, 'tutoring', 'other-vendor'); nativeConfig.parse(model.providerConfig);
        calls.push('tutor'); return { output: { text: 'Fake vendor answer' }, usage: usage(input, 'tutor') };
      } },
      video: { ...mediaDeclarations('video', 'other-vendor'),
        async startVideo(input) {
          calls.push('start');
          return { output: { state: 'pending', job: { kind: 'video', providerId: 'other-vendor', modelId: input.modelId,
            registryRevision: registry.revision, providerState: { ticket: { batch: 42, slot: 'north' } },
            accounting: input.accounting, requestedDurationSeconds: input.durationSeconds } }, usage: usage(input, 'video_submit') };
        },
        async pollVideo(job) {
          nativeJob.parse(job.providerState); calls.push('poll');
          return { output: { state: 'completed', job, videos: [{ uri: 'https://example.org/fake.webm', mimeType: 'video/webm' }] }, usage: usage(job, 'video_poll') };
        },
        async cancelVideo(job) {
          nativeJob.parse(job.providerState); calls.push('cancel');
          return { output: { job, state: 'cancelled', remoteMayContinue: false }, usage: usage(job, 'video_poll') };
        },
      },
    },
  };
  return { adapter, calls };
}

test('non-Google model registers opaque IDs/config and dispatches through the neutral tutoring port', async () => {
  const registry = new ModelRegistry(config()); const { adapter, calls } = fakeAdapter(registry);
  registry.registerAdapter(adapter);
  const core = new ProviderRouter(registry);
  const result = await core.tutor(request({ modelId: MODEL }));
  assert.equal(result.output.text, 'Fake vendor answer');
  assert.equal(result.usage.providerId, 'other-vendor'); assert.deepEqual(calls, ['validate', 'tutor']);
  assert.equal(registry.list()[0].remoteModel, 'org/region/deployment:42@revision+7');
  assert.equal(registry.list()[0].providerConfig.dialect, 7);
});

test('neutral assessment port revalidates structured output from a non-Google adapter', async () => {
  const cfg = config(); cfg.models[0].capabilities.push('structured_assessment');
  const registry = new ModelRegistry(cfg), { adapter } = fakeAdapter(registry);
  let output = { score: 2 };
  adapter.ports.structured_assessment = { async assess(input) {
    const { usage } = await adapter.ports.tutoring.tutor(input);
    return { output, usage: { ...usage, operation: 'assess' } };
  } };
  registry.registerAdapter(adapter);
  const core = new ProviderRouter(registry);
  const input = { ...request({ modelId: MODEL }), outputSchema: {
    type: 'object', properties: { score: { type: 'integer', minimum: 0, maximum: 3 } }, required: ['score'],
  } };
  assert.deepEqual((await core.assess(input)).output, { score: 2 });
  output = { score: '2' };
  await assert.rejects(core.assess(input), error => {
    assert.equal(error.code, 'INVALID_RESPONSE'); assert.equal(error.submission, 'unknown');
    assert.equal(error.usage.operation, 'assess'); assert.equal(error.usage.accounting.accountingKey, 'accounting-1'); return true;
  });
  output = { score: 2, unauthorizedCredit: true };
  await assert.rejects(core.assess(input), code('INVALID_RESPONSE'));
});

test('neutral video jobs and optional cancellation dispatch without Google operation/version/format assumptions', async () => {
  const registry = new ModelRegistry(config()), { adapter, calls } = fakeAdapter(registry); registry.registerAdapter(adapter);
  const core = new ProviderRouter(registry);
  const pending = await core.startVideo({ modelId: MODEL, prompt: 'fake prompt', accounting: { accountingKey: 'fake-job' },
    durationSeconds: 9, aspectRatio: '4:3', resolution: 'custom-size' });
  const job = JSON.parse(JSON.stringify(pending.output.job));
  for (const field of ['operationName', 'apiVersion', 'remoteModel', 'transport', 'videoCancellation']) assert.equal(job[field], undefined);
  assert.deepEqual(job.providerState, { ticket: { batch: 42, slot: 'north' } });
  const ready = await core.pollVideo(job);
  assert.equal(ready.output.state, 'completed'); assert.equal(ready.output.videos[0].mimeType, 'video/webm');
  const cancelled = await core.cancelVideo(job);
  assert.deepEqual(cancelled.output, { job, state: 'cancelled', remoteMayContinue: false });
  assert.deepEqual(calls, ['validate', 'start', 'poll', 'cancel']);
});

test('portable config validates bounded data-only JSON without evaluating accessors or accepting opaque executable values', () => {
  let reads = 0;
  const getter = {}; Object.defineProperty(getter, 'value', { get() { reads++; return 'not data'; }, enumerable: true });
  const cycle = {}; cycle.self = cycle;
  const hidden = {}; Object.defineProperty(hidden, 'secret', { value: 1, enumerable: false });
  for (const payload of [undefined, () => true, { fn: () => true }, { n: NaN }, { n: Infinity }, { n: 1n }, new Date(), getter,
    cycle, hidden, { [Symbol('extra')]: 1 }, Array(2), JSON.parse('{"__proto__":{"polluted":true}}'), 'x'.repeat(65537)]) {
    const cfg = config(); cfg.models[0].providerConfig = payload;
    assert.throws(() => new ModelRegistry(cfg), code('INVALID_CONFIG'));
  }
  assert.equal(reads, 0); assert.equal({}.polluted, undefined);
  const cfg = config(); cfg.models[0].providerConfig = ['vendor-dialect', { version: 7 }, null, true];
  assert.doesNotThrow(() => new ModelRegistry(cfg));
});

test('adapter-specific validation is mandatory and failed registration cannot create a dispatch route', async () => {
  const cfg = config(); cfg.models[0].providerConfig = { dialect: 999 };
  const registry = new ModelRegistry(cfg), { adapter } = fakeAdapter(registry);
  assert.throws(() => registry.registerAdapter(adapter), code('INVALID_CONFIG'));
  await assert.rejects(new ProviderRouter(registry).tutor(request({ modelId: MODEL })), code('ADAPTER_UNAVAILABLE'));
  const good = new ModelRegistry(config()), fake = fakeAdapter(good);
  assert.throws(() => good.registerAdapter({ ...fake.adapter, validateModel: undefined }), code('INVALID_CONFIG'));
  assert.throws(() => good.registerAdapter({ ...fake.adapter, validateModel: async () => {} }), code('INVALID_CONFIG'));
  assert.throws(() => good.registerAdapter({ ...fake.adapter, ports: { tutoring: { tutor: true } } }), code('INVALID_CONFIG'));
  assert.throws(() => good.registerAdapter({ ...fake.adapter, ports: { tutoring: fake.adapter.ports.tutoring } }), code('INVALID_CONFIG'));
  assert.throws(() => good.registerAdapter({ ...fake.adapter, ports: { ...fake.adapter.ports, imaginary: {} } }), code('INVALID_CONFIG'));
});

test('registration snapshots config/ports and rejects duplicate adapters and capability/account mismatches', async () => {
  const cfg = config(), registry = new ModelRegistry(cfg), { adapter } = fakeAdapter(registry); registry.registerAdapter(adapter);
  cfg.models[0].providerConfig.route.deployment = 0;
  adapter.ports.tutoring.tutor = async () => { throw new Error('Mutated method must not replace registered port'); };
  assert.equal((await new ProviderRouter(registry).tutor(request({ modelId: MODEL }))).output.text, 'Fake vendor answer');
  assert.equal(registry.list()[0].providerConfig.route.deployment, 42);
  assert.throws(() => registry.registerAdapter(adapter), code('INVALID_CONFIG'));
  assert.throws(() => registry.port(MODEL, 'research'), code('CAPABILITY_MISMATCH'));
  assert.throws(() => registry.port(MODEL, 'tutoring', 'different-account'), code('CAPABILITY_MISMATCH'));
  assert.throws(() => registry.port(MODEL, 'unknown'), code('INVALID_INPUT'));
});

test('router checks job ownership and JSON state before dispatch; cancellation is not assumed', async () => {
  const registry = new ModelRegistry(config()), { adapter, calls } = fakeAdapter(registry); delete adapter.ports.video.cancelVideo;
  registry.registerAdapter(adapter); const core = new ProviderRouter(registry);
  const job = { kind: 'video', providerId: 'other-vendor', modelId: MODEL, registryRevision: 'neutral-v1',
    accounting: { accountingKey: 'job' }, requestedDurationSeconds: 9, providerState: { ticket: { batch: 42, slot: 'north' } } };
  await assert.rejects(core.pollVideo({ ...job, providerId: 'another-account' }), code('CAPABILITY_MISMATCH'));
  await assert.rejects(core.pollVideo({ ...job, providerState: { execute: () => {} } }), code('INVALID_INPUT'));
  await assert.rejects(core.cancelVideo(job), code('CAPABILITY_MISMATCH'));
  assert.deepEqual(calls, ['validate']);
});

test('core-facing package graph has no Google adapter imports; Google also dispatches through neutral ports', async () => {
  assert.equal('GoogleProvider' in portable, false);
  const visited = new Set();
  function inspect(url) {
    if (visited.has(url.href)) return; visited.add(url.href);
    const source = readFileSync(fileURLToPath(url), 'utf8');
    for (const match of source.matchAll(/(?:from\s*|import\s*)['"](\.\/[^'"]+)['"]/g)) {
      assert.equal(match[1].includes('google'), false);
      assert.notEqual(match[1], './http.js');
      inspect(new URL(match[1], url));
    }
  }
  inspect(new URL('../dist/index.js', import.meta.url));
  const h = harness([textResponse()]); const result = await new ProviderRouter(h.registry).tutor(request());
  assert.equal(result.output.text, 'A useful explanation.'); assert.equal(h.calls.length, 1);
});
