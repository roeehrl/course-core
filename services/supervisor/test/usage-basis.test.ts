import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { outcomeSchema, snapshotSchema, type Outcome } from '../src/contracts.js';
import { accounting } from '../src/state-machine.js';
import { createActivities } from '../src/activities.js';
import { HttpProviderGateway } from '../src/providers.js';
import { TestHost, TestProvider, success } from './fixtures.js';

function outcome(): Extract<Outcome, { status: 'succeeded' }> {
  const value = success();
  assert.equal(value.status, 'succeeded');
  return value as Extract<Outcome, { status: 'succeeded' }>;
}
async function claim(h: TestHost) {
  await h.transition({ type: 'claim', ref: h.ref, checkpointId: 'plan', ownerId: randomUUID(), availability: { status: 'ready' } });
  return h.snapshot.operations[0]!;
}

test('usage basis is optional for legacy successes, explicit per dimension, strict and success-only', () => {
  const legacy = outcome();
  assert.deepEqual(outcomeSchema.parse(legacy), legacy);
  const value = { ...legacy, usageBasis: { microUsd: 'reserved_ceiling', tokens: 'reported' } };
  assert.deepEqual(outcomeSchema.parse(value), value);
  for (const usageBasis of [null, {}, { microUsd: 'reported' }, { microUsd: 'estimated', tokens: 'reported' },
    { microUsd: 'reported', tokens: 'reported', cost: null }]) {
    assert.equal(outcomeSchema.safeParse({ ...legacy, usageBasis }).success, false);
  }
  assert.equal(outcomeSchema.safeParse({ status: 'uncertain', usageBasis: value.usageBasis }).success, false);
  assert.equal(outcomeSchema.safeParse({ status: 'not_started', retryable: true, usageBasis: value.usageBasis }).success, false);
  assert.equal(outcomeSchema.safeParse({ ...value, artifact: { ...value.artifact, cost: null } }).success, false);
});

test('unknown price consumes full reserved cost while reported tokens settle normally, through replay and apply', async () => {
  const h = new TestHost(), op = await claim(h);
  const value = { ...outcome(), usage: { microUsd: op.reservation.microUsd, tokens: 40 },
    usageBasis: { microUsd: 'reserved_ceiling' as const, tokens: 'reported' as const } };
  const command = { type: 'settle' as const, ref: h.ref, operationId: op.id, ownerId: op.ownerId, outcome: value };
  await h.transition(command);
  h.snapshot = snapshotSchema.parse(JSON.parse(JSON.stringify(h.snapshot)));
  await h.transition(command);
  await h.transition({ type: 'verify', ref: h.ref });
  await h.transition({ type: 'apply', ref: h.ref });
  assert.equal(h.applications, 1);
  assert.deepEqual(accounting(h.snapshot), { microUsd: 100, tokens: 40 });
  assert.deepEqual(h.snapshot.operations[0]!.outcome, value);
  // A completed conservative settlement cannot be replayed as a cheaper reported charge.
  await assert.rejects(h.transition({ ...command, outcome: { ...value, usage: { microUsd: 1, tokens: 40 },
    usageBasis: { microUsd: 'reported', tokens: 'reported' } } }), /settlement_conflict/);
  assert.deepEqual(accounting(h.snapshot), { microUsd: 100, tokens: 40 });
});

test('unknown price and token counts retain both full reservations even on a late cancelled settlement', async () => {
  const h = new TestHost(), op = await claim(h);
  h.host.cancellationRequested = true;
  const value = { ...outcome(), usage: { ...op.reservation },
    usageBasis: { microUsd: 'reserved_ceiling' as const, tokens: 'reserved_ceiling' as const } };
  await h.transition({ type: 'settle', ref: h.ref, operationId: op.id, ownerId: op.ownerId, outcome: value });
  assert.equal(h.snapshot.state, 'cancelled');
  assert.deepEqual(accounting(h.snapshot), { microUsd: 100, tokens: 100 });
  assert.deepEqual(h.snapshot.operations[0]!.outcome, value);
});

for (const dimension of ['microUsd', 'tokens'] as const) {
  test(`reserved_ceiling ${dimension} must equal the persisted reservation; mismatch never frees it`, async () => {
    const h = new TestHost(), op = await claim(h), before = structuredClone(h.snapshot);
    for (const amount of [0, 99, 101]) {
      const value = { ...outcome(), usage: { ...op.reservation, [dimension]: amount },
        usageBasis: { microUsd: 'reserved_ceiling' as const, tokens: 'reserved_ceiling' as const } };
      await assert.rejects(h.transition({ type: 'settle', ref: h.ref, operationId: op.id, ownerId: op.ownerId, outcome: value }), /usage_basis_mismatch/);
      assert.deepEqual(h.snapshot, before);
      assert.deepEqual(accounting(h.snapshot), { microUsd: 100, tokens: 100 });
    }
  });
}

test('reported price with unknown tokens settles the two accounting dimensions independently', async () => {
  const h = new TestHost(), op = await claim(h);
  await h.transition({ type: 'settle', ref: h.ref, operationId: op.id, ownerId: op.ownerId,
    outcome: { ...outcome(), usage: { microUsd: 25, tokens: op.reservation.tokens },
      usageBasis: { microUsd: 'reported', tokens: 'reserved_ceiling' } } });
  assert.deepEqual(accounting(h.snapshot), { microUsd: 25, tokens: 100 });
});

test('activity retry after lost settlement preserves basis and never resubmits the provider operation', async () => {
  const h = new TestHost(), p = new TestProvider();
  p.result = { ...outcome(), usage: { ...h.snapshot.specification.checkpoints[0]!.allowance },
    usageBasis: { microUsd: 'reserved_ceiling', tokens: 'reserved_ceiling' } };
  const activities = createActivities(h, p, () => ({ signal: new AbortController().signal, heartbeat() {} }));
  h.failAfter = 'settle';
  await assert.rejects(activities.executeCheckpoint(h.ref, 'plan'), /lost_commit_response/);
  assert.equal((await activities.executeCheckpoint(h.ref, 'plan')).effect, 'continue');
  assert.equal(p.calls.length, 1);
  assert.deepEqual(h.snapshot.operations[0]!.outcome, p.result);
  assert.deepEqual(accounting(h.snapshot), { microUsd: 100, tokens: 100 });
});

test('HTTP gateway accepts accounting basis without changing the artifact contract or raw provider telemetry', async () => {
  const h = new TestHost(), spec = h.snapshot.specification;
  const value = { ...outcome(), usage: { ...spec.checkpoints[0]!.allowance },
    usageBasis: { microUsd: 'reserved_ceiling', tokens: 'reserved_ceiling' } };
  const gateway = new HttpProviderGateway('https://example.invalid/', 'synthetic-test-token', async () => new Response(JSON.stringify(value)));
  const result = await gateway.invoke({ schemaVersion: 1, operationId: `${h.ref.jobId}/plan`, job: spec.key, role: spec.role,
    checkpoint: spec.checkpoints[0]!, fence: spec.fence }, new AbortController().signal);
  assert.deepEqual(result, value);
  assert.equal(Object.hasOwn(result, 'cost'), false);
});
