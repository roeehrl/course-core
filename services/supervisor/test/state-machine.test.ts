import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createJob, transition, accounting } from '../src/state-machine.js';
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
