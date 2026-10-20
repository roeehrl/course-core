import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Client, WorkflowNotFoundError } from '@temporalio/client';
import { bundleWorkflowCode, DefaultLogger, Runtime, Worker } from '@temporalio/worker';
import { temporalActivities } from '../src/temporal/activities.js';
import { crossCourseSignaller, enrollmentStarter, temporalCancellationSignaller, temporalSignaller, temporalStarter } from '../src/temporal/client.js';
import { deliverCancellationsOnce, deliverCrossCourseOnce } from '../src/outbox.js';
import { enrollmentWorkflowId, learnerCoordinatorWorkflowId, workflowId, type Command, type CrossCoursePlan, type CrossCourseReason, type EnrollmentInput,
  type LearnerCoordinatorInput, type LearnerCoordinatorSummary, type RunRef, type Summary } from '../src/contracts.js';
import { accounting, nextGeneration } from '../src/state-machine.js';
import { UnconfiguredProvider, type ProviderGateway } from '../src/providers.js';
import { specification, TestHost, TestProvider } from './fixtures.js';
import { startTelemetry } from '../src/telemetry.js';
import { activityTraceInterceptor, workflowTraceInterceptor } from '../src/temporal/tracing.js';
import { otlpReceiver } from './otlp-receiver.js';

// The worker's interceptors, as in production (no-ops while telemetry is off).
const interceptors = { activity: [() => ({ inbound: activityTraceInterceptor() })] };

let env: TestWorkflowEnvironment;
let bundle: Awaited<ReturnType<typeof bundleWorkflowCode>>;
before(async () => {
  Runtime.install({ logger: new DefaultLogger('ERROR', () => {}) });
  const downloadDir = fileURLToPath(new URL('../.local/temporal', import.meta.url));
  await mkdir(downloadDir, { recursive: true });
  // The repository's pinned Temporal CLI: the official archive and the extracted binary are both
  // checked against deploy/local/temporal-cli.mjs digests, and a mismatch fails the suite.
  const installer = new URL('../../../deploy/local/temporal-cli.mjs', import.meta.url).href;
  const { installTemporalCli } = await import(installer) as { installTemporalCli(target: string): Promise<{ target: string }> };
  const { target } = await installTemporalCli(`${downloadDir}/temporal-verified`);
  // Dedicated loopback ephemeral port; in-memory DB, no UI, never attaches to an existing service.
  env = await TestWorkflowEnvironment.createLocal({ server: { ip: '127.0.0.1', ui: false,
    executable: { type: 'existing-path', path: target }, log: { format: 'json', level: 'error' } } });
  bundle = await bundleWorkflowCode({ workflowsPath: fileURLToPath(new URL('../dist/src/temporal/workflows.js', import.meta.url)),
    workflowInterceptorModules: [fileURLToPath(new URL('../dist/src/temporal/workflow-interceptors.js', import.meta.url))],
    logger: new DefaultLogger('ERROR', () => {}) });
}, { timeout: 180_000 });
after(async () => { await env?.teardown(); });

async function setup(host: TestHost, provider: ProviderGateway = new TestProvider()) {
  const taskQueue = `supervisor-test-${randomUUID()}`;
  const worker = await Worker.create({ connection: env.nativeConnection, taskQueue, workflowBundle: bundle,
    activities: temporalActivities(host, provider), maxConcurrentActivityTaskExecutions: 2, interceptors,
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

const control = (h: TestHost, state: 'active' | 'paused' | 'stopped', revision: number) =>
  ({ schemaVersion: 1 as const, enrollmentId: h.ref.enrollmentId, state, revision });
test('real server: a paused job holds before its provider call and resumes on the signal', { timeout: 45_000 }, async () => {
  const h = new TestHost(); h.host.supervision = 'paused'; const p = new TestProvider();
  const { worker, starter } = await setup(h, p); const id = workflowId(h.ref); const signals = temporalSignaller(env.client);
  await worker.runUntil(async () => {
    await starter.start(h.ref, id);
    while (!h.commands.some(c => c.type === 'claim')) await new Promise(resolve => setTimeout(resolve, 50));
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(p.calls.length, 0); assert.equal(h.snapshot.state, 'queued');
    h.host.supervision = 'active'; // The host commits the resume before the dispatcher signals.
    const started = Date.now();
    assert.equal(await signals.signal(id, control(h, 'active', 2)), 'delivered');
    assert.equal((await env.client.workflow.getHandle(id).result() as Summary).state, 'applied');
    assert.ok(Date.now() - started < 10_000, 'resumed by the signal, not the poll');
    // A finished workflow needs no wake-up.
    assert.equal(await signals.signal(id, control(h, 'paused', 3)), 'closed');
  });
  assert.equal(p.calls.length, 1); assert.equal(h.applications, 1);
  await replay(id);
});
test('real server: a pause during the provider call settles it and holds publication until resume', { timeout: 45_000 }, async () => {
  const h = new TestHost(); const p = new TestProvider(); const invoke = p.invoke.bind(p);
  p.invoke = async request => { h.host.supervision = 'paused'; return invoke(request); };
  const { worker, starter } = await setup(h, p); const id = workflowId(h.ref);
  await worker.runUntil(async () => {
    await starter.start(h.ref, id);
    while (!h.commands.some(c => c.type === 'apply')) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(h.applications, 0); assert.equal(h.snapshot.state, 'ready');
    assert.deepEqual(accounting(h.snapshot), { microUsd: 25, tokens: 40 });
    h.host.supervision = 'active';
    await temporalSignaller(env.client).signal(id, control(h, 'active', 2));
    assert.equal((await env.client.workflow.getHandle(id).result() as Summary).state, 'applied');
  });
  assert.equal(p.calls.length, 1); assert.equal(h.applications, 1);
  await replay(id);
});
test('real server: a stop signal cancels the in-flight call and nothing is published later', { timeout: 45_000 }, async () => {
  const h = new TestHost(); h.snapshot.specification.checkpoints[0]!.timeoutMs = 20_000;
  const p = new TestProvider(); let entered!: () => void;
  const began = new Promise<void>(resolve => { entered = resolve; });
  p.invoke = async req => { p.calls.push(req); entered(); return new Promise(() => {}); };
  const { worker, starter } = await setup(h, p); const id = workflowId(h.ref);
  await worker.runUntil(async () => {
    await starter.start(h.ref, id); await began;
    h.host.supervision = 'stopped'; h.host.cancellationRequested = true; // As the host's stop commits.
    await temporalSignaller(env.client).signal(id, control(h, 'stopped', 1));
    const result = await env.client.workflow.getHandle(id).result() as Summary;
    assert.equal(result.state, 'cancelled'); assert.equal(result.reason, 'supervision_stopped');
  });
  assert.equal(p.calls.length, 1); assert.equal(h.applications, 0);
  assert.equal(h.snapshot.operations[0]!.status, 'uncertain');
  assert.deepEqual(accounting(h.snapshot), { microUsd: 100, tokens: 100 });
  await replay(id);
});
test('real server: a stale or foreign control signal is ignored and a held job still meets its deadline', { timeout: 45_000 }, async () => {
  const h = new TestHost(); h.host.supervision = 'paused'; h.snapshot.specification.deadlineAtMs = Date.now() + 3_000;
  const p = new TestProvider(); const { worker, starter } = await setup(h, p); const id = workflowId(h.ref);
  await worker.runUntil(async () => {
    await starter.start(h.ref, id);
    const handle = env.client.workflow.getHandle(id);
    await handle.signal('supervisionControl', { ...control(h, 'stopped', 5), enrollmentId: randomUUID() });
    await handle.signal('supervisionControl', { not: 'a signal' });
    const result = await handle.result() as Summary;
    assert.equal(result.state, 'failed'); assert.equal(result.reason, 'deadline_exceeded');
  });
  assert.equal(p.calls.length, 0); assert.equal(h.applications, 0);
  await replay(id);
});
test('real server: an uncertain call settled from its receipt resumes in a new generation without calling again', { timeout: 45_000 }, async () => {
  const h = new TestHost(); const p = new TestProvider(); const receipt = p.result;
  p.invoke = async request => { p.calls.push(request); return { status: 'uncertain' }; };
  const { worker, starter } = await setup(h, p); const first = workflowId(h.ref);
  await worker.runUntil(async () => {
    await starter.start(h.ref, first);
    assert.equal((await env.client.workflow.getHandle(first).result() as Summary).reason, 'provider_uncertain');
    // Host reconciliation: the gateway's finished receipt settles the same operation and owner.
    const op = h.snapshot.operations[0]!;
    await h.transition({ type: 'settle', ref: h.ref, operationId: op.id, ownerId: op.ownerId, outcome: receipt });
    h.snapshot = nextGeneration(h.snapshot);
    const second = workflowId(h.ref);
    assert.notEqual(second, first);
    await starter.start(h.ref, second);
    assert.equal((await env.client.workflow.getHandle(second).result() as Summary).state, 'applied');
    await replay(second);
  });
  assert.equal(p.calls.length, 1); assert.equal(h.applications, 1); assert.equal(h.snapshot.generation, 2);
  await replay(first);
});

/** TEST ONLY: one enrollment's jobs, each backed by its own TestHost. */
class EnrollmentHosts extends TestHost {
  readonly jobs = new Map<string, TestHost>();
  readonly workspaceId = randomUUID(); readonly enrollmentId = randomUUID();
  add(configure: (h: TestHost) => void = () => {}) {
    const spec = specification(); spec.key.workspaceId = this.workspaceId; spec.key.enrollmentId = this.enrollmentId;
    const h = new TestHost(spec); configure(h); this.jobs.set(spec.key.jobId, h); return h;
  }
  override async load(ref: RunRef) { return this.jobs.get(ref.jobId)!.load(); }
  override async transition(command: Command) { return this.jobs.get(command.ref.jobId)!.transition(command); }
}
async function coordinator(hosts: EnrollmentHosts, provider: ProviderGateway, input: Partial<EnrollmentInput> = {}) {
  const taskQueue = `supervisor-test-${randomUUID()}`;
  const worker = await Worker.create({ connection: env.nativeConnection, taskQueue, workflowBundle: bundle,
    activities: temporalActivities(hosts, provider), maxConcurrentActivityTaskExecutions: 4, interceptors,
    maxHeartbeatThrottleInterval: '500ms', defaultHeartbeatThrottleInterval: '500ms', shutdownGraceTime: '2 seconds' });
  const id = enrollmentWorkflowId(hosts.workspaceId, hosts.enrollmentId);
  const open = () => env.client.workflow.start('enrollmentSupervisor', { workflowId: id, taskQueue,
    args: [{ schemaVersion: 1, workspaceId: hosts.workspaceId, enrollmentId: hosts.enrollmentId, ...input }] });
  return { worker, id, open, taskQueue, starter: enrollmentStarter(env.client, taskQueue) };
}
/** The child is started by the coordinator shortly after the signal; wait for it to exist. */
async function settledJob(h: TestHost): Promise<Summary> {
  for (let tries = 0; ; tries++) {
    try { return (await env.client.workflow.getHandle(workflowId(h.ref)).result()) as Summary; }
    catch (error) { if (!(error instanceof WorkflowNotFoundError) || tries > 200) throw error; await new Promise(resolve => setTimeout(resolve, 100)); }
  }
}

test('real server: the enrollment coordinator runs prepared jobs as children, once each, and replays', { timeout: 60_000 }, async () => {
  const hosts = new EnrollmentHosts(), p = new TestProvider(); const a = hosts.add(), b = hosts.add();
  const { worker, id, starter } = await coordinator(hosts, p);
  await worker.runUntil(async () => {
    await starter.start(a.ref, workflowId(a.ref)); await starter.start(b.ref, workflowId(b.ref));
    await starter.start(a.ref, workflowId(a.ref)); // A redelivered event: no second child.
    assert.equal((await settledJob(a)).state, 'applied'); assert.equal((await settledJob(b)).state, 'applied');
    const parent = await env.client.workflow.getHandle(workflowId(a.ref)).describe();
    assert.equal(parent.parentExecution?.workflowId, id);
  });
  assert.equal(p.calls.length, 2); assert.equal(a.applications + b.applications, 2);
  await replay(id);
});
test('real server: the coordinator continues as new with its queue and control, and the chain replays', { timeout: 90_000 }, async () => {
  const hosts = new EnrollmentHosts(), p = new TestProvider(); const jobs = [hosts.add(), hosts.add(), hosts.add()];
  const { worker, id, open, starter } = await coordinator(hosts, p, { maxJobsPerRun: 1, maxConcurrent: 1 });
  let firstRun = '';
  await worker.runUntil(async () => {
    firstRun = (await open()).firstExecutionRunId;
    for (const job of jobs) await starter.start(job.ref, workflowId(job.ref));
    for (const job of jobs) assert.equal((await settledJob(job)).state, 'applied');
    // The coordinator continues as new once each child finishes; wait for the run after the third.
    let carried: { started: number; pending: unknown[]; maxJobsPerRun: number } | undefined, latestRun = firstRun;
    for (let tries = 0; tries < 100 && carried?.started !== 3; tries++) {
      const history = await env.client.workflow.getHandle(id).fetchHistory();
      const started = history.events![0]!.workflowExecutionStartedEventAttributes!;
      latestRun = (await env.client.workflow.getHandle(id).describe()).runId;
      carried = started.continuedExecutionRunId ? JSON.parse(Buffer.from(started.input!.payloads![0]!.data!).toString('utf8')) : undefined;
      if (carried?.started !== 3) await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.notEqual(latestRun, firstRun);
    assert.equal(carried?.started, 3); assert.deepEqual(carried?.pending, []); assert.equal(carried?.maxJobsPerRun, 1);
  });
  assert.equal(p.calls.length, 3);
  const first = await env.client.workflow.getHandle(id, firstRun).fetchHistory();
  assert.equal(first.events!.at(-1)!.workflowExecutionContinuedAsNewEventAttributes ? 'continued' : 'other', 'continued');
  await Worker.runReplayHistory({ workflowBundle: bundle }, first);
});
test('real server: a stop sent to the coordinator reaches its running child', { timeout: 60_000 }, async () => {
  const hosts = new EnrollmentHosts(), p = new TestProvider(); let entered!: () => void;
  const began = new Promise<void>(resolve => { entered = resolve; });
  p.invoke = async req => { p.calls.push(req); entered(); return new Promise(() => {}); };
  const job = hosts.add(h => { h.snapshot.specification.checkpoints[0]!.timeoutMs = 20_000; });
  const { worker, id, starter } = await coordinator(hosts, p);
  await worker.runUntil(async () => {
    await starter.start(job.ref, workflowId(job.ref)); await began;
    job.host.supervision = 'stopped'; job.host.cancellationRequested = true;
    await temporalSignaller(env.client).signal(id, { schemaVersion: 1, enrollmentId: hosts.enrollmentId, state: 'stopped', revision: 1 });
    const result = await settledJob(job);
    assert.equal(result.state, 'cancelled'); assert.equal(result.reason, 'supervision_stopped');
  });
  assert.equal(job.applications, 0);
  await replay(id);
});
test('real server: an idle coordinator closes and the next job opens it again', { timeout: 60_000 }, async () => {
  const hosts = new EnrollmentHosts(), p = new TestProvider(); const a = hosts.add(), b = hosts.add();
  const { worker, id, open, starter } = await coordinator(hosts, p, { idleMs: 1_000 });
  await worker.runUntil(async () => {
    await open(); await starter.start(a.ref, workflowId(a.ref));
    assert.equal((await settledJob(a)).state, 'applied');
    assert.deepEqual(await env.client.workflow.getHandle(id).result(), { started: 1, reason: 'idle' });
    await starter.start(b.ref, workflowId(b.ref)); // Signal-with-start opens a new run.
    assert.equal((await settledJob(b)).state, 'applied');
  });
  assert.equal(p.calls.length, 2);
});

// Data erasure and provider changes: the host records the cancellation, then the dispatcher signals.
const deliverCancellations = (bridge: TestHost) => deliverCancellationsOnce(bridge, temporalCancellationSignaller(env.client));
const waitFor = async (check: () => boolean) => { while (!check()) await new Promise(resolve => setTimeout(resolve, 50)); };
function blockedCall(p: TestProvider) {
  let entered!: () => void; const began = new Promise<void>(resolve => { entered = resolve; });
  p.invoke = async req => { p.calls.push(req); entered(); return new Promise(() => {}); };
  return began;
}
for (const reason of ['data_erasure', 'provider_changed'] as const) {
  test(`real server (${reason}): a job with its provider call out stops at once and never calls again`, { timeout: 45_000 }, async () => {
    const h = new TestHost(); const cp = h.snapshot.specification.checkpoints[0]!; cp.timeoutMs = 20_000; cp.phase = 'analyze';
    const p = new TestProvider(); const began = blockedCall(p);
    const { worker, starter } = await setup(h, p); const id = workflowId(h.ref);
    await worker.runUntil(async () => {
      await starter.start(h.ref, id); await began;
      assert.equal(h.snapshot.state, 'analyzing');
      h.cancelJob(reason); const started = Date.now();
      assert.deepEqual(await deliverCancellations(h), { claimed: 1, delivered: 1, retried: 0, signalled: 1, closed: 0, leaseLost: 0 });
      const result = await env.client.workflow.getHandle(id).result() as Summary;
      assert.equal(result.state, 'cancelled'); assert.equal(result.reason, 'cancel_requested');
      assert.ok(Date.now() - started < 10_000, 'stopped by the signal, not the call timeout');
    });
    assert.equal(p.calls.length, 1); assert.equal(h.applications, 0);
    assert.equal(h.snapshot.operations[0]!.status, 'uncertain'); // The call that was out stays accounted.
    assert.deepEqual(h.cancellationAcks.map(a => a.delivered), [true]);
    await replay(id);
  });
}
test('real server: a job waiting to retry stops at once, without the retry call', { timeout: 45_000 }, async () => {
  const h = new TestHost(); const p = new TestProvider();
  p.invoke = async request => { p.calls.push(request); return { status: 'not_started', retryable: true, retryAfterMs: 60_000 }; };
  const { worker, starter } = await setup(h, p); const id = workflowId(h.ref);
  await worker.runUntil(async () => {
    await starter.start(h.ref, id);
    await waitFor(() => h.commands.some(c => c.type === 'settle'));
    await new Promise(resolve => setTimeout(resolve, 300)); // Inside the retry sleep.
    h.cancelJob('provider_changed'); const started = Date.now();
    await deliverCancellations(h);
    const result = await env.client.workflow.getHandle(id).result() as Summary;
    assert.equal(result.state, 'cancelled'); assert.equal(result.reason, 'cancel_requested');
    assert.ok(Date.now() - started < 10_000, 'the 60-second retry wait was interrupted');
  });
  assert.equal(p.calls.length, 1);
  await replay(id);
});
test('real server: a job held by a pause stops at once and never calls', { timeout: 45_000 }, async () => {
  const h = new TestHost(); h.host.supervision = 'paused'; const p = new TestProvider();
  const { worker, starter } = await setup(h, p); const id = workflowId(h.ref);
  await worker.runUntil(async () => {
    await starter.start(h.ref, id);
    await waitFor(() => h.commands.some(c => c.type === 'claim'));
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(h.snapshot.state, 'queued');
    h.cancelJob('data_erasure'); const started = Date.now();
    await deliverCancellations(h);
    const result = await env.client.workflow.getHandle(id).result() as Summary;
    assert.equal(result.state, 'cancelled'); assert.equal(result.reason, 'cancel_requested');
    assert.ok(Date.now() - started < 10_000, 'woken by the signal, not the hold poll');
  });
  assert.equal(p.calls.length, 0);
  await replay(id);
});
test('real server: a queued job cancelled before its workflow starts never calls', { timeout: 45_000 }, async () => {
  const h = new TestHost(); const p = new TestProvider();
  const { worker, starter } = await setup(h, p); const id = workflowId(h.ref);
  h.cancelJob('data_erasure');
  assert.deepEqual(await deliverCancellations(h), { claimed: 1, delivered: 1, retried: 0, signalled: 0, closed: 1, leaseLost: 0 });
  await worker.runUntil(async () => {
    await starter.start(h.ref, id);
    const result = await env.client.workflow.getHandle(id).result() as Summary;
    assert.equal(result.state, 'cancelled'); assert.equal(result.reason, 'cancel_requested');
  });
  assert.equal(p.calls.length, 0);
  await replay(id);
});
test('real server: with the signal lost, the stored cancellation still stops the job before another call', { timeout: 45_000 }, async () => {
  const h = new TestHost(); const p = new TestProvider();
  p.invoke = async request => { p.calls.push(request); return { status: 'not_started', retryable: true, retryAfterMs: 2_000 }; };
  const { worker, starter } = await setup(h, p); const id = workflowId(h.ref);
  await worker.runUntil(async () => {
    await starter.start(h.ref, id);
    await waitFor(() => h.commands.some(c => c.type === 'settle'));
    h.cancelJob('provider_changed'); h.cancellations = []; // Recorded by the host; the signal never arrives.
    const result = await env.client.workflow.getHandle(id).result() as Summary;
    assert.equal(result.state, 'cancelled'); assert.equal(result.reason, 'cancel_requested');
  });
  assert.equal(p.calls.length, 1);
  assert.equal(h.commands.filter(c => c.type === 'claim').length, 2); // The retry asked the host, which refused it.
  await replay(id);
});
test('real server: a cancellation for another job or enrollment is ignored', { timeout: 45_000 }, async () => {
  const h = new TestHost(); h.host.supervision = 'paused'; const p = new TestProvider();
  const { worker, starter } = await setup(h, p); const id = workflowId(h.ref);
  await worker.runUntil(async () => {
    await starter.start(h.ref, id);
    await waitFor(() => h.commands.some(c => c.type === 'claim'));
    const handle = env.client.workflow.getHandle(id);
    await handle.signal('jobCancellation', { schemaVersion: 1, enrollmentId: h.ref.enrollmentId, jobId: randomUUID(), reason: 'data_erasure' });
    await handle.signal('jobCancellation', { schemaVersion: 1, enrollmentId: randomUUID(), jobId: h.ref.jobId, reason: 'data_erasure' });
    await handle.signal('jobCancellation', { schemaVersion: 2, jobId: h.ref.jobId });
    h.host.supervision = 'active';
    await temporalSignaller(env.client).signal(id, { schemaVersion: 1, enrollmentId: h.ref.enrollmentId, state: 'active', revision: 2 });
    assert.equal((await handle.result() as Summary).state, 'applied');
  });
  assert.equal(p.calls.length, 1);
  await replay(id);
});
function queueCancellation(hosts: EnrollmentHosts, job: TestHost, reason: 'data_erasure' | 'provider_changed') {
  job.host.cancellationRequested = true;
  hosts.cancellations.push({ cancellationId: randomUUID(), leaseToken: randomUUID(), attempts: 1, workspaceId: hosts.workspaceId,
    enrollmentId: hosts.enrollmentId, reason, jobs: [job.ref] });
}
test('real server: a cancellation sent to the coordinator stops its running child and drops a queued one', { timeout: 60_000 }, async () => {
  const hosts = new EnrollmentHosts(), p = new TestProvider(); const began = blockedCall(p);
  const running = hosts.add(h => { h.snapshot.specification.checkpoints[0]!.timeoutMs = 20_000; }), waiting = hosts.add();
  const { worker, id, open, starter } = await coordinator(hosts, p, { maxConcurrent: 1 });
  // Only the coordinator is reachable: the job workflows look closed to this signaller.
  const signaller = temporalCancellationSignaller(env.client);
  const onlyCoordinator = { cancel: (target: string, signal: Parameters<typeof signaller.cancel>[1]) => target === id ? signaller.cancel(target, signal) : Promise.resolve('closed' as const) };
  await worker.runUntil(async () => {
    await open(); await starter.start(running.ref, workflowId(running.ref)); await began;
    await starter.start(waiting.ref, workflowId(waiting.ref));
    queueCancellation(hosts, waiting, 'data_erasure'); queueCancellation(hosts, running, 'data_erasure');
    await deliverCancellationsOnce(hosts, onlyCoordinator);
    const result = await settledJob(running);
    assert.equal(result.state, 'cancelled'); assert.equal(result.reason, 'cancel_requested');
    await new Promise(resolve => setTimeout(resolve, 1_000));
    await assert.rejects(env.client.workflow.getHandle(workflowId(waiting.ref)).describe(), WorkflowNotFoundError);
  });
  assert.equal(p.calls.length, 1); assert.equal(waiting.commands.length, 0);
  await replay(id);
});

/** TEST ONLY: one learner's opt-in and planning answers, as the host keeps them. */
class CrossCourseHost extends TestHost {
  readonly learnerId = randomUUID();
  consent = { active: true, consentRevision: 1 };
  plans: number[] = [];
  /** Suggestions stored by passes that found the opt-in still in force. */
  stored = 0;
  /** When set, a pass waits here (a slow host transaction) before it decides. */
  hold: Promise<void> | null = null;
  entered: (() => void) | null = null;
  budgetWaitMs: number | null = null;
  override async crossCourseConsent() { return { ...this.consent }; }
  override async planCrossCourse(_learnerId: string, consentRevision: number): Promise<CrossCoursePlan> {
    this.plans.push(consentRevision); this.entered?.();
    if (this.hold) await this.hold;
    // The host re-reads the opt-in under its lock: a revocation committed meanwhile wins.
    if (!this.consent.active) return { status: 'no_consent', consentRevision: this.consent.consentRevision, created: 0 };
    if (this.budgetWaitMs !== null) return { status: 'budget_wait', consentRevision: this.consent.consentRevision, created: 0, retryAfterMs: this.budgetWaitMs };
    this.stored++;
    return { status: 'planned', consentRevision: this.consent.consentRevision, created: 1 };
  }
  wake(reason: CrossCourseReason) {
    this.crossCourseDeliveries.push({ wakeupId: randomUUID(), leaseToken: randomUUID(), attempts: 1, learnerId: this.learnerId,
      consentRevision: this.consent.consentRevision, active: this.consent.active, reason });
  }
}
async function learnerWorker(host: TestHost) {
  const taskQueue = `supervisor-test-${randomUUID()}`;
  const worker = await Worker.create({ connection: env.nativeConnection, taskQueue, workflowBundle: bundle,
    activities: temporalActivities(host, new TestProvider()), maxConcurrentActivityTaskExecutions: 2, interceptors, shutdownGraceTime: '2 seconds' });
  return { worker, taskQueue, deliver: () => deliverCrossCourseOnce(host, crossCourseSignaller(env.client, taskQueue)) };
}
const until = async (check: () => boolean, limitMs = 20_000) => {
  const deadline = Date.now() + limitMs;
  while (!check()) { if (Date.now() > deadline) throw new Error('condition not reached'); await new Promise(resolve => setTimeout(resolve, 50)); }
};
const learnerResult = (learnerId: string) => env.client.workflow.getHandle(learnerCoordinatorWorkflowId(learnerId)).result() as Promise<LearnerCoordinatorSummary>;

test('real server (cross-course): host wake-ups and coalesced enrollment signals lead to host passes, and the history replays', { timeout: 60_000 }, async () => {
  const host = new CrossCourseHost(); const { worker, taskQueue, deliver } = await learnerWorker(host);
  const id = learnerCoordinatorWorkflowId(host.learnerId);
  await worker.runUntil(async () => {
    // Opened with a short quiet period; the dispatcher's signal-with-start then reuses this run.
    await env.client.workflow.start('learnerCoordinator', { workflowId: id, taskQueue,
      args: [{ schemaVersion: 1, learnerId: host.learnerId, dirty: false, coalesceMs: 1_500 } satisfies LearnerCoordinatorInput] });
    host.wake('consent_granted');
    assert.deepEqual(await deliver(), { claimed: 1, delivered: 1, retried: 0, opened: 1, closed: 0, leaseLost: 0 });
    await until(() => host.plans.length === 1);
    // Three signals from enrollment coordinators during the quiet period: one more pass, not three.
    const handle = env.client.workflow.getHandle(id);
    for (let i = 0; i < 3; i++)
      await handle.signal('enrollmentObserved', { schemaVersion: 1, learnerId: host.learnerId, workspaceId: randomUUID(), enrollmentId: randomUUID() });
    await until(() => host.plans.length === 2);
    await new Promise(resolve => setTimeout(resolve, 2_500));
    assert.equal(host.plans.length, 2);
    // Foreign and malformed signals are ignored rather than failing the coordinator.
    await handle.signal('enrollmentObserved', { schemaVersion: 1, learnerId: randomUUID(), workspaceId: randomUUID(), enrollmentId: randomUUID() });
    await handle.signal('enrollmentObserved', { nonsense: true });
    await handle.signal('crossCourseWake', { schemaVersion: 1, learnerId: host.learnerId, consentRevision: 0, active: false, reason: 'consent_revoked' }); // Older than the host's: ignored.
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(host.plans.length, 2);
    // Revocation: the dispatcher's inactive wake-up stops it.
    host.consent = { active: false, consentRevision: 2 }; host.wake('consent_revoked');
    assert.equal((await deliver()).opened, 1);
    assert.deepEqual(await learnerResult(host.learnerId), { planned: 2, reason: 'consent_revoked' });
  });
  assert.deepEqual(host.crossCourseAcks.map(a => a.delivered), [true, true]);
  assert.deepEqual(host.plans, [1, 1]);
  await replay(id);
});
test('real server (cross-course): an enrollment coordinator reports ended jobs to the learner coordinator only under an opt-in', { timeout: 60_000 }, async () => {
  const hosts = new EnrollmentHosts(), p = new TestProvider();
  const learner = new CrossCourseHost();
  // One worker serves both: the enrollment host answers observe with the learner (an opt-in covers it).
  const combined = Object.assign(hosts, {
    crossCourseConsent: learner.crossCourseConsent.bind(learner), planCrossCourse: learner.planCrossCourse.bind(learner),
  });
  hosts.observedLearner = learner.learnerId;
  const a = hosts.add(), b = hosts.add();
  const { worker, id, taskQueue, starter } = await coordinator(combined, p, { maxConcurrent: 1 });
  await worker.runUntil(async () => {
    await env.client.workflow.start('learnerCoordinator', { workflowId: learnerCoordinatorWorkflowId(learner.learnerId), taskQueue,
      args: [{ schemaVersion: 1, learnerId: learner.learnerId, coalesceMs: 0 } satisfies LearnerCoordinatorInput] });
    await until(() => learner.plans.length === 1); // Its first pass, on opening.
    await starter.start(a.ref, workflowId(a.ref));
    assert.equal((await settledJob(a)).state, 'applied');
    // The ended job reached the learner's coordinator as a signal: one more host pass.
    await until(() => hosts.observedEnrollments.length === 1 && learner.plans.length === 2);
    // Without an opt-in the host answers null: no signal is sent and no pass follows.
    hosts.observedLearner = null;
    await starter.start(b.ref, workflowId(b.ref));
    assert.equal((await settledJob(b)).state, 'applied');
    await until(() => hosts.observedEnrollments.length === 2);
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(learner.plans.length, 2);
    await env.client.workflow.getHandle(learnerCoordinatorWorkflowId(learner.learnerId)).signal('crossCourseWake',
      { schemaVersion: 1, learnerId: learner.learnerId, consentRevision: 2, active: false, reason: 'consent_revoked' });
    assert.equal((await learnerResult(learner.learnerId)).reason, 'consent_revoked');
  });
  assert.deepEqual(hosts.observedEnrollments, [hosts.enrollmentId, hosts.enrollmentId]);
  await replay(id);
});
test('real server (cross-course): the coordinator continues as new with bounded state, and the chain replays', { timeout: 90_000 }, async () => {
  const host = new CrossCourseHost(); const { worker, taskQueue } = await learnerWorker(host);
  const id = learnerCoordinatorWorkflowId(host.learnerId);
  let firstRun = '';
  await worker.runUntil(async () => {
    const handle = await env.client.workflow.start('learnerCoordinator', { workflowId: id, taskQueue,
      args: [{ schemaVersion: 1, learnerId: host.learnerId, consentRevision: 1, maxPlansPerRun: 1, coalesceMs: 0 } satisfies LearnerCoordinatorInput] });
    firstRun = handle.firstExecutionRunId;
    await until(() => host.plans.length === 1);
    for (let i = 0; i < 3; i++) {
      await env.client.workflow.getHandle(id).signal('enrollmentObserved', { schemaVersion: 1, learnerId: host.learnerId, workspaceId: randomUUID(), enrollmentId: randomUUID() });
      await until(() => host.plans.length === 2 + i);
    }
    let carried: { planned: number; consentRevision: number; maxPlansPerRun: number; dirty: boolean } | undefined;
    for (let tries = 0; tries < 100 && carried?.planned !== 3; tries++) {
      const history = await env.client.workflow.getHandle(id).fetchHistory();
      const started = history.events![0]!.workflowExecutionStartedEventAttributes!;
      carried = started.continuedExecutionRunId ? JSON.parse(Buffer.from(started.input!.payloads![0]!.data!).toString('utf8')) : undefined;
      if (carried?.planned !== 3) await new Promise(resolve => setTimeout(resolve, 100));
    }
    // Only a revision, a flag and counters cross the boundary: no queue of enrollments or evidence.
    assert.deepEqual(Object.keys(carried!).sort(), ['coalesceMs', 'consentRevision', 'dirty', 'idleMs', 'learnerId', 'maxBudgetWaitMs', 'maxPlansPerRun', 'planned', 'schemaVersion']);
    assert.equal(carried!.consentRevision, 1); assert.equal(carried!.maxPlansPerRun, 1);
    host.consent = { active: false, consentRevision: 2 };
    await env.client.workflow.getHandle(id).signal('crossCourseWake', { schemaVersion: 1, learnerId: host.learnerId, consentRevision: 2, active: false, reason: 'consent_revoked' });
    assert.equal((await learnerResult(host.learnerId)).reason, 'consent_revoked');
  });
  const first = await env.client.workflow.getHandle(id, firstRun).fetchHistory();
  assert.ok(first.events!.at(-1)!.workflowExecutionContinuedAsNewEventAttributes);
  await Worker.runReplayHistory({ workflowBundle: bundle }, first);
});
test('real server (cross-course): no coordinator runs or plans without an opt-in', { timeout: 60_000 }, async () => {
  const host = new CrossCourseHost(); host.consent = { active: false, consentRevision: 3 };
  const { worker, taskQueue, deliver } = await learnerWorker(host);
  const id = learnerCoordinatorWorkflowId(host.learnerId);
  await worker.runUntil(async () => {
    // A revocation wake-up never starts a coordinator.
    host.wake('consent_revoked');
    assert.deepEqual(await deliver(), { claimed: 1, delivered: 1, retried: 0, opened: 0, closed: 1, leaseLost: 0 });
    await assert.rejects(env.client.workflow.getHandle(id).describe(), WorkflowNotFoundError);
    // A coordinator opened anyway (a stale wake-up, a manual start) asks the host first and stops.
    await env.client.workflow.start('learnerCoordinator', { workflowId: id, taskQueue, args: [{ schemaVersion: 1, learnerId: host.learnerId }] });
    assert.deepEqual(await learnerResult(host.learnerId), { planned: 0, reason: 'no_consent' });
  });
  assert.deepEqual(host.plans, []);
  await replay(id);
});
test('real server (cross-course): a revocation during a pass ends the run and nothing is stored after it', { timeout: 60_000 }, async () => {
  const host = new CrossCourseHost(); const { worker, deliver } = await learnerWorker(host);
  let release!: () => void; host.hold = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { host.entered = resolve; });
  await worker.runUntil(async () => {
    host.wake('evidence_changed'); await deliver(); await entered;
    // The learner revokes while the host is still deciding: the revocation commits first.
    host.consent = { active: false, consentRevision: 2 }; host.wake('consent_revoked');
    const started = Date.now();
    assert.equal((await deliver()).opened, 1);
    assert.deepEqual(await learnerResult(host.learnerId), { planned: 0, reason: 'consent_revoked' });
    assert.ok(Date.now() - started < 10_000, 'stopped by the signal, not by the pass finishing');
    release();
  });
  await until(() => host.plans.length === 1);
  assert.equal(host.stored, 0);
  await replay(learnerCoordinatorWorkflowId(host.learnerId));
});
test('real server (cross-course): the learner\'s daily allowance makes the coordinator wait, then plan again', { timeout: 60_000 }, async () => {
  const host = new CrossCourseHost(); host.budgetWaitMs = 1_000;
  const { worker, deliver } = await learnerWorker(host);
  await worker.runUntil(async () => {
    host.wake('consent_granted'); await deliver();
    await until(() => host.plans.length === 1);
    host.budgetWaitMs = null;
    await until(() => host.plans.length === 2 && host.stored === 1);
    host.consent = { active: false, consentRevision: 2 }; host.wake('consent_revoked'); await deliver();
    assert.deepEqual(await learnerResult(host.learnerId), { planned: 1, reason: 'consent_revoked' });
  });
});

// Last: it starts the process telemetry runtime.
test('real server: a traced start links the workflow, its child jobs and their activities to the starting trace', { timeout: 60_000 }, async () => {
  const receiver = await otlpReceiver();
  try {
    const runtime = await startTelemetry({ serviceName: 'course-core-dispatcher', env: { OTEL_EXPORTER_OTLP_ENDPOINT: receiver.url, OTEL_METRICS_EXPORTER: 'none' } });
    const traced = new Client({ connection: env.connection, namespace: env.namespace ?? 'default', interceptors: { workflow: [workflowTraceInterceptor()] } });
    const hosts = new EnrollmentHosts(), p = new TestProvider(); const first = hosts.add(), second = hosts.add();
    const { worker, id, taskQueue } = await coordinator(hosts, p);
    const direct = new TestHost(), directSetup = await setup(direct);
    const dispatched = new Map<string, string>();
    await worker.runUntil(async () => {
      for (const job of [first, second]) await runtime.span('supervisor.dispatch', {}, async () => {
        dispatched.set(job.ref.jobId, runtime.traceId()!);
        await enrollmentStarter(traced, taskQueue).start(job.ref, workflowId(job.ref));
      });
      assert.equal((await settledJob(first)).state, 'applied'); assert.equal((await settledJob(second)).state, 'applied');
    });
    await directSetup.worker.runUntil(async () => {
      await runtime.span('supervisor.dispatch', {}, async () => {
        dispatched.set(direct.ref.jobId, runtime.traceId()!);
        await temporalStarter(traced, directSetup.taskQueue).start(direct.ref, workflowId(direct.ref));
      });
      assert.equal((await env.client.workflow.getHandle(workflowId(direct.ref)).result() as Summary).state, 'applied');
    });
    await runtime.shutdown();
    const spans = receiver.spans();
    const starts = spans.filter(span => span.name === 'supervisor.workflow.start');
    assert.equal(starts.length, 3);
    assert.deepEqual(new Set(starts.map(span => span.traceId)), new Set(dispatched.values()));
    const all = spans.filter(span => span.name === 'supervisor.activity');
    // The coordinator also asks the host, after each job, whether a learner coordinator should hear of it
    // (the worker may stop before those calls run; at most one per job).
    const observed = all.filter(span => span.attributes['course.supervisor.activity'] === 'cross_course_observe');
    assert.ok(observed.length <= 2);
    const activities = all.filter(span => !observed.includes(span));
    for (const traceId of dispatched.values()) {
      const start = starts.find(span => span.traceId === traceId)!;
      const linked = activities.filter(span => span.traceId === traceId);
      // Every activity of that job is a direct child of the start span, across the workflow boundary.
      assert.deepEqual(linked.map(span => span.attributes['course.supervisor.activity']).sort(), ['apply_job', 'execute_checkpoint', 'load_job', 'verify_job']);
      for (const span of linked) assert.equal(span.parentSpanId, start.spanId);
    }
    assert.equal(activities.length, 12);
    await replay(id); await replay(workflowId(first.ref)); await replay(workflowId(direct.ref));
  } finally { await receiver.close(); }
});
