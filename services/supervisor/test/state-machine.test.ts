import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createJob, transition, accounting, nextGeneration, resumable } from '../src/state-machine.js';
import { jobSpecSchema, jobCommandSchema, outcomeSchema, operationId, type Command } from '../src/contracts.js';
import { specification, success, TestHost } from './fixtures.js';

async function claim(h: TestHost, id = 'plan') {
  return h.transition({ type: 'claim', ref: h.ref, checkpointId: id, ownerId: randomUUID(), availability: { status: 'ready' } });
}
async function settle(h: TestHost, outcome = success()) {
  const op = h.snapshot.operations.at(-1)!;
  return h.transition({ type: 'settle', ref: h.ref, operationId: op.id, ownerId: op.ownerId, outcome });
}
test('pure state machine preserves input, verifies references, applies exactly once', async () => {
  const h = new TestHost(); const before = structuredClone(h.snapshot);
  await claim(h); assert.equal(before.state, 'queued'); assert.equal(before.operations.length, 0);
  assert.equal(h.snapshot.operations[0]!.id, operationId(h.ref.jobId, 'plan'));
  await settle(h); assert.deepEqual(accounting(h.snapshot), { microUsd: 25, tokens: 40 });
  await assert.rejects(h.transition({ type: 'apply', ref: h.ref }), /unverified_application/);
  await h.transition({ type: 'verify', ref: h.ref });
  assert.equal(h.snapshot.state, 'ready');
  await h.transition({ type: 'apply', ref: h.ref });
  const receipt = h.snapshot.applicationReceiptId;
  await h.transition({ type: 'apply', ref: h.ref });
  assert.equal(h.applications, 1); assert.equal(h.snapshot.applicationReceiptId, receipt);
});
for (const dimension of ['enrollmentRevision', 'profileRevision', 'policyRevision', 'ledgerRevision', 'courseDigest'] as const) {
  test(`fences ${dimension} before dispatch and again at application`, async () => {
    for (const phase of ['claim', 'apply'] as const) {
      const h = new TestHost();
      if (phase === 'apply') { await claim(h); await settle(h); await h.transition({ type: 'verify', ref: h.ref }); }
      if (dimension === 'courseDigest') h.host.currentFence.courseDigest = 'f'.repeat(64);
      else h.host.currentFence[dimension]++;
      if (phase === 'claim') await claim(h); else await h.transition({ type: 'apply', ref: h.ref });
      assert.equal(h.snapshot.reason, 'stale_revision'); assert.equal(h.applications, 0);
      if (phase === 'claim') assert.equal(h.snapshot.operations.length, 0);
    }
  });
}
test('missing capability/configuration are explicit and cost nothing', async () => {
  for (const status of ['configuration_missing', 'capability_missing'] as const) {
    const h = new TestHost();
    await h.transition({ type: 'claim', ref: h.ref, checkpointId: 'plan', ownerId: randomUUID(), availability: { status } });
    assert.equal(h.snapshot.reason, status); assert.equal(h.snapshot.state, 'waiting');
    assert.deepEqual(accounting(h.snapshot), { microUsd: 0, tokens: 0 });
  }
});
test('replayed dispatch permit becomes uncertain and reservations never multiply', async () => {
  const h = new TestHost();
  const command: Command = { type: 'claim', ref: h.ref, checkpointId: 'plan', ownerId: randomUUID(), availability: { status: 'ready' } };
  assert.equal((await h.transition(command)).effect, 'invoke');
  for (let i = 0; i < 30; i++) assert.equal((await h.transition(command)).effect, 'stop');
  assert.equal(h.snapshot.reason, 'provider_uncertain');
  assert.equal(h.snapshot.operations[0]!.attempt, 1);
  assert.deepEqual(accounting(h.snapshot), { microUsd: 100, tokens: 100 });
});
test('only certified not-started outcomes may retry, bounded across generations', async () => {
  const h = new TestHost();
  for (let i = 1; i <= 3; i++) {
    assert.equal((await claim(h)).effect, 'invoke');
    assert.equal(h.snapshot.operations[0]!.attempt, i);
    const result = await settle(h, { status: 'not_started', retryable: true });
    assert.equal(result.effect, i < 3 ? 'retry' : 'stop');
    if (i < 3) h.snapshot.generation++;
  }
  assert.equal(h.snapshot.reason, 'attempts_exhausted');
  assert.equal((await claim(h)).effect, 'stop');
  assert.deepEqual(accounting(h.snapshot), { microUsd: 0, tokens: 0 });
});
test('generation and tenant/enrollment identity are independently fenced', async () => {
  const h = new TestHost();
  for (const ref of [{ ...h.ref, generation: 2 }, { ...h.ref, workspaceId: randomUUID() }, { ...h.ref, enrollmentId: randomUUID() }])
    await assert.rejects(h.transition({ type: 'claim', ref, checkpointId: 'plan', ownerId: randomUUID(), availability: { status: 'ready' } }), /stale_generation|job_identity_mismatch/);
});
test('budget caps reject reservations; usage overruns fail without further calls', async () => {
  const h = new TestHost(); h.snapshot.specification.budget.microUsd = 99;
  assert.equal((await claim(h)).snapshot.reason, 'budget_exhausted');
  assert.equal(h.snapshot.operations.length, 0);
  const h2 = new TestHost(); await claim(h2);
  const outcome = success(); assert.equal(outcome.status, 'succeeded');
  if (outcome.status === 'succeeded') outcome.usage.tokens = 101;
  await settle(h2, outcome); assert.equal(h2.snapshot.reason, 'usage_exceeded');
  assert.equal((await claim(h2)).effect, 'stop');
});
test('cancel, deadline, and inactive enrollment prevent application, but late costs settle', async () => {
  for (const cause of ['cancel', 'deadline', 'inactive'] as const) {
    const h = new TestHost(); await claim(h);
    if (cause === 'cancel') h.host.cancellationRequested = true;
    if (cause === 'deadline') h.host.nowMs = h.snapshot.specification.deadlineAtMs;
    if (cause === 'inactive') h.host.enrollmentActive = false;
    await settle(h);
    assert.equal(h.snapshot.state, cause === 'deadline' ? 'failed' : 'cancelled');
    assert.deepEqual(accounting(h.snapshot), { microUsd: 25, tokens: 40 });
    await h.transition({ type: 'apply', ref: h.ref }); assert.equal(h.applications, 0);
  }
});
test('checkpoint ordering, receipt binding and owner checks reject forged operations', async () => {
  const spec = specification(); spec.checkpoints.push({ ...spec.checkpoints[0]!, id: 'media', capability: 'media' });
  const h = new TestHost(spec);
  await assert.rejects(claim(h, 'media'), /checkpoint_order/);
  await claim(h);
  await assert.rejects(h.transition({ type: 'settle', ref: h.ref, operationId: h.snapshot.operations[0]!.id, ownerId: randomUUID(), outcome: success() }), /operation_owner_mismatch/);
  const result = success(); await settle(h, result);
  await assert.rejects(settle(h, success()), /settlement_conflict/);
  await assert.rejects(h.transition({ type: 'verify', ref: h.ref }), /incomplete_checkpoints/);
  await claim(h, 'media'); await settle(h);
  const forged = { receiptId: randomUUID(), jobId: h.ref.jobId, fence: spec.fence,
    artifacts: [{ artifactId: randomUUID(), digest: 'e'.repeat(64) }], verdict: 'verified' as const };
  assert.throws(() => transition(h.snapshot, { type: 'verify', ref: h.ref }, { ...h.host, verification: forged }), /verification_binding_mismatch/);
});
test('verification wait and rejection never publish unverified content', async () => {
  const h = new TestHost(); await claim(h); await settle(h); h.verificationEnabled = false;
  await h.transition({ type: 'verify', ref: h.ref }); assert.equal(h.snapshot.reason, 'verification_required');
  await assert.rejects(h.transition({ type: 'apply', ref: h.ref }), /unverified_application/);
  const artifact = h.snapshot.operations[0]!.outcome;
  assert.equal(artifact?.status, 'succeeded');
  const receipt = { receiptId: randomUUID(), jobId: h.ref.jobId, fence: h.snapshot.specification.fence,
    artifacts: artifact?.status === 'succeeded' ? [artifact.artifact] : [], verdict: 'rejected' as const };
  assert.equal(transition(h.snapshot, { type: 'verify', ref: h.ref }, { ...h.host, verification: receipt }).snapshot.reason, 'verification_rejected');
});
test('strict boundaries reject secrets, raw content, model mastery and unbounded work', () => {
  assert.equal(jobSpecSchema.safeParse({ ...specification(), learnerSecret: 'private' }).success, false);
  assert.equal(outcomeSchema.safeParse({ ...success(), mastery: true }).success, false);
  assert.equal(outcomeSchema.safeParse({ status: 'succeeded', text: 'unverified' }).success, false);
  assert.equal(jobCommandSchema.safeParse({ type: 'apply', ref: new TestHost().ref, verification: { verdict: 'verified' } }).success, false);
  const spec = specification(); spec.checkpoints.push(spec.checkpoints[0]!);
  assert.throws(() => createJob(spec), /duplicate_checkpoint/);
  spec.checkpoints = Array.from({ length: 17 }, (_, i) => ({ ...spec.checkpoints[0]!, id: `step${i}` }));
  assert.equal(jobSpecSchema.safeParse(spec).success, false);
});

test('terminal fencing converts outstanding dispatch into explicit uncertainty and retains cost', async () => {
  const h = new TestHost(); await claim(h);
  h.host.cancellationRequested = true;
  await h.transition({ type: 'halt', ref: h.ref, reason: 'cancel_requested' });
  assert.equal(h.snapshot.operations[0]!.status, 'uncertain');
  assert.deepEqual(h.snapshot.operations[0]!.outcome, { status: 'uncertain' });
  assert.deepEqual(accounting(h.snapshot), { microUsd: 100, tokens: 100 });
});
test('all four roles share checkpoint accounting and cannot bypass the cumulative cap', async () => {
  const spec = specification();
  spec.checkpoints = ['supervisor', 'companion', 'research', 'media'].map(capability => ({ ...spec.checkpoints[0]!,
    id: capability, capability: capability as JobSpecRole, allowance: { microUsd: 60, tokens: 60 } }));
  spec.budget = { microUsd: 100, tokens: 180 };
  const h = new TestHost(spec);
  for (const role of ['supervisor', 'companion']) { await claim(h, role); await settle(h); }
  const result = await claim(h, 'research');
  assert.equal(result.snapshot.reason, 'budget_exhausted'); assert.equal(h.snapshot.operations.length, 2);
  assert.deepEqual(accounting(h.snapshot), { microUsd: 50, tokens: 80 });
});
type JobSpecRole = 'supervisor' | 'companion' | 'research' | 'media';

test('shared host budget independently denies a call even when the job has headroom', async () => {
  const h = new TestHost(); h.host.availableBudget = { microUsd: 99, tokens: 1_000 };
  assert.equal((await claim(h)).snapshot.reason, 'budget_exhausted');
  assert.equal(h.snapshot.operations.length, 0);
  h.host.availableBudget = { microUsd: 1_000, tokens: 99 };
  assert.equal((await claim(h)).snapshot.reason, 'budget_exhausted');
  assert.equal(h.snapshot.operations.length, 0);
});

test('a paused enrollment holds new calls and publication but still settles, verifies and expires', async () => {
  const h = new TestHost(); h.host.supervision = 'paused';
  const held = await claim(h);
  assert.equal(held.effect, 'hold'); assert.equal(h.snapshot.state, 'queued'); assert.equal(h.snapshot.operations.length, 0);
  h.host.supervision = 'active';
  assert.equal((await claim(h)).effect, 'invoke');
  // Paused while the provider call is out: the call settles and is accounted.
  h.host.supervision = 'paused';
  assert.equal((await settle(h)).effect, 'continue');
  assert.deepEqual(accounting(h.snapshot), { microUsd: 25, tokens: 40 });
  assert.equal((await h.transition({ type: 'verify', ref: h.ref })).effect, 'continue');
  assert.equal(h.snapshot.state, 'ready');
  assert.equal((await h.transition({ type: 'apply', ref: h.ref })).effect, 'hold');
  assert.equal(h.applications, 0); assert.equal(h.snapshot.state, 'ready');
  // The deadline is not suspended by a pause.
  const late = new TestHost(); late.host.supervision = 'paused'; late.host.nowMs = late.snapshot.specification.deadlineAtMs;
  const expired = await claim(late);
  assert.equal(expired.effect, 'stop'); assert.equal(late.snapshot.reason, 'deadline_exceeded');
  h.host.supervision = 'active';
  assert.equal((await h.transition({ type: 'apply', ref: h.ref })).snapshot.state, 'applied');
  assert.equal(h.applications, 1);
});
test('a stopped enrollment cancels with its own reason, keeps the uncertain reservation and never publishes', async () => {
  const h = new TestHost();
  await claim(h);
  h.host.supervision = 'stopped';
  const stopped = await claim(h);
  assert.equal(stopped.effect, 'stop');
  assert.equal(h.snapshot.state, 'cancelled'); assert.equal(h.snapshot.reason, 'supervision_stopped');
  assert.equal(h.snapshot.operations[0]!.status, 'uncertain');
  assert.deepEqual(accounting(h.snapshot), { microUsd: 100, tokens: 100 });
  // A late success still settles its real cost but stays unpublishable, even after a resume.
  h.host.supervision = 'active';
  await settle(h);
  assert.deepEqual(accounting(h.snapshot), { microUsd: 25, tokens: 40 });
  assert.equal((await h.transition({ type: 'apply', ref: h.ref })).snapshot.state, 'cancelled');
  assert.equal(h.applications, 0);
  // A workflow that saw the stop signal first halts with the same terminal reason.
  const signalled = new TestHost();
  const halted = await signalled.transition({ type: 'halt', ref: signalled.ref, reason: 'supervision_stopped' });
  assert.equal(halted.snapshot.state, 'cancelled'); assert.equal(halted.snapshot.reason, 'supervision_stopped');
});

test('a checkpoint phase names the state while its call is out, and settling returns to running', async () => {
  const spec = specification(); spec.checkpoints[0]!.phase = 'analyze';
  const h = new TestHost(spec);
  await claim(h); assert.equal(h.snapshot.state, 'analyzing');
  await settle(h); assert.equal(h.snapshot.state, 'running');
  for (const [phase, state] of [['build', 'building'], ['evaluate', 'evaluating']] as const) {
    const s = specification(); s.checkpoints[0]!.phase = phase;
    const other = new TestHost(s); await claim(other); assert.equal(other.snapshot.state, state);
  }
  const plain = new TestHost(); await claim(plain); assert.equal(plain.snapshot.state, 'running');
  assert.throws(() => jobSpecSchema.parse({ ...specification(), checkpoints: [{ ...specification().checkpoints[0], phase: 'think' }] }));
});
test('parking waits for input or a due follow-up between calls, and a new generation resumes it', async () => {
  const h = new TestHost();
  await claim(h);
  await assert.rejects(h.transition({ type: 'park', ref: h.ref, reason: 'needs_input' }), /park_with_open_call/);
  await settle(h);
  const parked = await h.transition({ type: 'park', ref: h.ref, reason: 'needs_input' });
  assert.equal(parked.effect, 'stop'); assert.equal(h.snapshot.state, 'needs_input'); assert.equal(h.snapshot.reason, 'input_required');
  assert.equal(resumable(h.snapshot), true);
  const resumed = nextGeneration(h.snapshot);
  assert.equal(resumed.generation, 2); assert.equal(resumed.state, 'queued'); assert.deepEqual(resumed.operations, h.snapshot.operations);
  assert.deepEqual(accounting(resumed), accounting(h.snapshot));
  // The old generation is fenced out; the new one continues from its settled checkpoint.
  h.snapshot = resumed;
  await assert.rejects(h.transition({ type: 'claim', ref: { ...h.ref, generation: 1 }, checkpointId: 'plan', ownerId: randomUUID(), availability: { status: 'ready' } }), /stale_generation/);
  assert.equal((await claim(h)).effect, 'continue');
  const later = new TestHost();
  await assert.rejects(later.transition({ type: 'park', ref: later.ref, reason: 'follow_up_due' }), /invalid_follow_up/);
  await assert.rejects(later.transition({ type: 'park', ref: later.ref, reason: 'follow_up_due', dueAtMs: later.snapshot.specification.deadlineAtMs }), /invalid_follow_up/);
  await later.transition({ type: 'park', ref: later.ref, reason: 'follow_up_due', dueAtMs: Date.now() + 1_000 });
  assert.equal(later.snapshot.state, 'follow_up_due'); assert.equal(typeof later.snapshot.dueAtMs, 'number');
  assert.equal(nextGeneration(later.snapshot).dueAtMs, undefined);
  // Uncertain or terminal jobs never resume.
  const uncertain = new TestHost(); await claim(uncertain); await settle(uncertain, { status: 'uncertain' });
  assert.equal(resumable(uncertain.snapshot), false); assert.throws(() => nextGeneration(uncertain.snapshot), /not_resumable/);
  const done = new TestHost(); await done.transition({ type: 'halt', ref: done.ref, reason: 'cancel_requested' });
  assert.equal(resumable(done.snapshot), false);
});
