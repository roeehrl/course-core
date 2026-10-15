import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { bundleWorkflowCode, DefaultLogger, Runtime, Worker } from '@temporalio/worker';
import { temporalActivities } from '../src/temporal/activities.js';
import { temporalStarter } from '../src/temporal/client.js';
import { workflowId, type Summary } from '../src/contracts.js';
import { accounting } from '../src/state-machine.js';
import { UnconfiguredProvider, type ProviderGateway } from '../src/providers.js';
import { TestHost, TestProvider } from './fixtures.js';

let env: TestWorkflowEnvironment;
let bundle: Awaited<ReturnType<typeof bundleWorkflowCode>>;
before(async () => {
  Runtime.install({ logger: new DefaultLogger('ERROR', () => {}) });
  const downloadDir = fileURLToPath(new URL('../.local/temporal', import.meta.url));
  await mkdir(downloadDir, { recursive: true });
  // Dedicated loopback ephemeral port; in-memory DB, no UI, never attaches to an existing service.
  env = await TestWorkflowEnvironment.createLocal({ server: { ip: '127.0.0.1', ui: false,
    executable: { type: 'cached-download', downloadDir }, log: { format: 'json', level: 'error' } } });
  bundle = await bundleWorkflowCode({ workflowsPath: fileURLToPath(new URL('../dist/src/temporal/workflows.js', import.meta.url)),
    logger: new DefaultLogger('ERROR', () => {}) });
}, { timeout: 180_000 });
after(async () => { await env?.teardown(); });

async function setup(host: TestHost, provider: ProviderGateway = new TestProvider()) {
  const taskQueue = `supervisor-test-${randomUUID()}`;
  const worker = await Worker.create({ connection: env.nativeConnection, taskQueue, workflowBundle: bundle,
    activities: temporalActivities(host, provider), maxConcurrentActivityTaskExecutions: 2,
    maxHeartbeatThrottleInterval: '500ms', defaultHeartbeatThrottleInterval: '500ms', shutdownGraceTime: '2 seconds' });
  return { worker, taskQueue, starter: temporalStarter(env.client, taskQueue) };
}
async function replay(id: string) {
  const history = await env.client.workflow.getHandle(id).fetchHistory();
  assert.ok(history.events!.length > 10);
  await Worker.runReplayHistory({ workflowBundle: bundle }, history);
}

test('real server: complete, deduplicate CLOSED workflow and replay full history', { timeout: 45_000 }, async () => {
  const h = new TestHost(); const p = new TestProvider(); const { worker, starter } = await setup(h, p);
  const id = workflowId(h.ref);
  await worker.runUntil(async () => {
    await starter.start(h.ref, id);
    assert.equal((await env.client.workflow.getHandle(id).result() as Summary).state, 'applied');
    await starter.start(h.ref, id); // REJECT_DUPLICATE also protects a closed execution.
    assert.equal(h.applications, 1); assert.equal(p.calls.length, 1);
  });
  await replay(id);
  assert.equal(p.calls.length, 1);
});
test('real server: Temporal activity retry after lost settle response does not rebill', { timeout: 45_000 }, async () => {
  const h = new TestHost(); h.failAfter = 'settle'; const p = new TestProvider();
  const { worker, starter } = await setup(h, p); const id = workflowId(h.ref);
  await worker.runUntil(async () => {
    await starter.start(h.ref, id);
    assert.equal((await env.client.workflow.getHandle(id).result() as Summary).state, 'applied');
  });
  assert.equal(p.calls.length, 1); assert.equal(h.applications, 1);
  await replay(id);
});
test('real server: lost claim response yields uncertainty without invoking provider', { timeout: 45_000 }, async () => {
  const h = new TestHost(); h.failAfter = 'claim'; const p = new TestProvider();
  const { worker, starter } = await setup(h, p); const id = workflowId(h.ref);
  await worker.runUntil(async () => {
    await starter.start(h.ref, id);
    assert.equal((await env.client.workflow.getHandle(id).result() as Summary).reason, 'provider_uncertain');
  });
  assert.equal(p.calls.length, 0); assert.equal(h.snapshot.operations[0]!.attempt, 1);
  await replay(id);
});
test('real server: missing configuration is a durable visible state', { timeout: 45_000 }, async () => {
  const h = new TestHost(); const { worker, starter } = await setup(h, new UnconfiguredProvider());
  const id = workflowId(h.ref);
  await worker.runUntil(async () => {
    await starter.start(h.ref, id);
    const result = await env.client.workflow.getHandle(id).result() as Summary;
    assert.equal(result.state, 'waiting'); assert.equal(result.reason, 'configuration_missing');
  });
  assert.equal(h.applications, 0); await replay(id);
});
test('real server: native cancellation persists cancellation and retains uncertain reservation', { timeout: 45_000 }, async () => {
  const h = new TestHost(); h.snapshot.specification.checkpoints[0]!.timeoutMs = 20_000;
  const p = new TestProvider(); let entered!: () => void;
  const began = new Promise<void>(resolve => { entered = resolve; });
  p.invoke = async req => { p.calls.push(req); entered(); return new Promise(() => {}); };
  const { worker, starter } = await setup(h, p); const id = workflowId(h.ref);
  await worker.runUntil(async () => {
    await starter.start(h.ref, id); await began;
    h.host.cancellationRequested = true; // Host commits this before forwarding Temporal cancellation.
    const handle = env.client.workflow.getHandle(id); await handle.cancel();
    const result = await handle.result() as Summary;
    assert.equal(result.state, 'cancelled'); assert.equal(result.reason, 'cancel_requested');
  });
  assert.equal(p.calls.length, 1); assert.equal(h.applications, 0);
  assert.deepEqual(accounting(h.snapshot), { microUsd: 100, tokens: 100 });
  await replay(id);
});
test('real server: application rejects a revision changed after verification', { timeout: 45_000 }, async () => {
  const h = new TestHost(); const original = h.transition.bind(h);
  h.transition = async command => {
    const result = await original(command);
    if (command.type === 'verify') h.host.currentFence.enrollmentRevision++;
    return result;
  };
  const { worker, starter } = await setup(h); const id = workflowId(h.ref);
  await worker.runUntil(async () => {
    await starter.start(h.ref, id);
    assert.equal((await env.client.workflow.getHandle(id).result() as Summary).reason, 'stale_revision');
  });
  assert.equal(h.applications, 0); await replay(id);
});

test('real server: only definite non-start retries, using the same logical operation ID', { timeout: 45_000 }, async () => {
  const h = new TestHost(); const p = new TestProvider();
  const invoke = p.invoke.bind(p);
  p.invoke = async request => {
    if (p.calls.length === 0) { p.calls.push(request); return { status: 'not_started', retryable: true }; }
    return invoke(request);
  };
  const { worker, starter } = await setup(h, p); const id = workflowId(h.ref);
  await worker.runUntil(async () => {
    await starter.start(h.ref, id);
    assert.equal((await env.client.workflow.getHandle(id).result() as Summary).state, 'applied');
  });
  assert.equal(p.calls.length, 2); assert.equal(p.calls[0]!.operationId, p.calls[1]!.operationId);
  assert.equal(h.snapshot.operations[0]!.attempt, 2);
  assert.deepEqual(accounting(h.snapshot), { microUsd: 25, tokens: 40 });
  await replay(id);
});
test('real server: a rate-limited non-start waits for the provider Retry-After before the next attempt', { timeout: 45_000 }, async () => {
  const h = new TestHost(); const p = new TestProvider(); const at: number[] = [];
  const invoke = p.invoke.bind(p);
  p.invoke = async request => {
    at.push(Date.now());
    if (at.length === 1) { p.calls.push(request); return { status: 'not_started', retryable: true, retryAfterMs: 3_000 }; }
    return invoke(request);
  };
  const { worker, starter } = await setup(h, p); const id = workflowId(h.ref);
  await worker.runUntil(async () => {
    await starter.start(h.ref, id);
    assert.equal((await env.client.workflow.getHandle(id).result() as Summary).state, 'applied');
  });
  assert.equal(p.calls.length, 2); assert.equal(p.calls[0]!.operationId, p.calls[1]!.operationId);
  // Without the hint the first backoff is one second.
  assert.ok(at[1]! - at[0]! >= 3_000, `retried after ${at[1]! - at[0]!} ms`);
  await replay(id);
});
test('real server: a permanent provider rejection fails the job without another attempt', { timeout: 45_000 }, async () => {
  const h = new TestHost(); const p = new TestProvider();
  p.invoke = async request => { p.calls.push(request); return { status: 'not_started', retryable: false }; };
  const { worker, starter } = await setup(h, p); const id = workflowId(h.ref);
  await worker.runUntil(async () => {
    await starter.start(h.ref, id);
    const result = await env.client.workflow.getHandle(id).result() as Summary;
    assert.equal(result.state, 'failed'); assert.equal(result.reason, 'provider_rejected');
  });
  assert.equal(p.calls.length, 1); assert.equal(h.applications, 0);
  assert.deepEqual(accounting(h.snapshot), { microUsd: 0, tokens: 0 });
  await replay(id);
});
test('real server: deadline interrupts provider wait and records a bounded terminal result', { timeout: 45_000 }, async () => {
  const h = new TestHost(); const p = new TestProvider();
  h.snapshot.specification.deadlineAtMs = Date.now() + 2_000;
  h.snapshot.specification.checkpoints[0]!.timeoutMs = 20_000;
  p.invoke = async request => { p.calls.push(request); return new Promise(() => {}); };
  const { worker, starter } = await setup(h, p); const id = workflowId(h.ref);
  await worker.runUntil(async () => {
    await starter.start(h.ref, id);
    const result = await env.client.workflow.getHandle(id).result() as Summary;
    assert.equal(result.state, 'failed'); assert.equal(result.reason, 'deadline_exceeded');
  });
  assert.equal(p.calls.length, 1); assert.equal(h.applications, 0);
  assert.deepEqual(accounting(h.snapshot), { microUsd: 100, tokens: 100 });
  await replay(id);
});

test('real server: reserved-ceiling basis survives activity retry and full history replay', { timeout: 45_000 }, async () => {
  const h = new TestHost(); const p = new TestProvider(); h.failAfter = 'settle';
  assert.equal(p.result.status, 'succeeded');
  if (p.result.status !== 'succeeded') throw new Error('invalid_test_fixture');
  p.result = { ...p.result, usage: { ...h.snapshot.specification.checkpoints[0]!.allowance },
    usageBasis: { microUsd: 'reserved_ceiling', tokens: 'reserved_ceiling' } };
  const { worker, starter } = await setup(h, p); const id = workflowId(h.ref);
  await worker.runUntil(async () => {
    await starter.start(h.ref, id);
    assert.equal((await env.client.workflow.getHandle(id).result() as Summary).state, 'applied');
  });
  assert.equal(p.calls.length, 1);
  assert.deepEqual(h.snapshot.operations[0]!.outcome, p.result);
  assert.deepEqual(accounting(h.snapshot), { microUsd: 100, tokens: 100 });
  await replay(id);
  assert.equal(p.calls.length, 1);
});
