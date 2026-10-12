import test from 'node:test';
import assert from 'node:assert/strict';
import { createActivities } from '../src/activities.js';
import { UnconfiguredProvider } from '../src/providers.js';
import { accounting } from '../src/state-machine.js';
import { TestHost, TestProvider, success } from './fixtures.js';
import type { Outcome } from '../src/contracts.js';
const runtime = () => ({ signal: new AbortController().signal, heartbeat() {} });

test('lost claim acknowledgement never reaches provider, replay records uncertainty', async () => {
  const h = new TestHost(); const p = new TestProvider(); const a = createActivities(h, p, runtime);
  h.failAfter = 'claim';
  await assert.rejects(a.executeCheckpoint(h.ref, 'plan'), /lost_commit_response/);
  assert.equal((await a.executeCheckpoint(h.ref, 'plan')).snapshot.reason, 'provider_uncertain');
  assert.equal(p.calls.length, 0); assert.equal(h.snapshot.operations[0]!.attempt, 1);
});
test('lost settlement acknowledgement replays checkpoint without a second provider cost', async () => {
  const h = new TestHost(); const p = new TestProvider(); const a = createActivities(h, p, runtime);
  h.failAfter = 'settle';
  await assert.rejects(a.executeCheckpoint(h.ref, 'plan'), /lost_commit_response/);
  p.availability = async () => { throw new Error('gateway offline'); };
  assert.equal((await a.executeCheckpoint(h.ref, 'plan')).effect, 'continue');
  assert.equal(p.calls.length, 1); assert.deepEqual(accounting(h.snapshot), { microUsd: 25, tokens: 40 });
});
test('overlapping retries cannot obtain a second provider permit', async () => {
  const h = new TestHost(); const p = new TestProvider(); const a = createActivities(h, p, runtime);
  let finish!: (v: Outcome) => void; let started!: () => void;
  const entered = new Promise<void>(r => { started = r; });
  p.invoke = async req => { p.calls.push(req); started(); return new Promise<Outcome>(r => { finish = r; }); };
  const first = a.executeCheckpoint(h.ref, 'plan'); await entered;
  assert.equal((await a.executeCheckpoint(h.ref, 'plan')).snapshot.reason, 'provider_uncertain');
  finish(success()); await first;
  assert.equal(p.calls.length, 1); assert.equal(h.snapshot.operations[0]!.status, 'succeeded');
});
test('unknown provider error remains bounded across any number of activity retries', async () => {
  const h = new TestHost(); const p = new TestProvider(); const a = createActivities(h, p, runtime);
  p.invoke = async req => { p.calls.push(req); throw new Error('private learner content and API secret'); };
  for (let i = 0; i < 10; i++) assert.equal((await a.executeCheckpoint(h.ref, 'plan')).snapshot.reason, 'provider_uncertain');
  assert.equal(p.calls.length, 1);
  assert.deepEqual(accounting(h.snapshot), { microUsd: 100, tokens: 100 });
  assert.doesNotMatch(JSON.stringify(h.snapshot), /private learner|API secret/);
});
test('provider timeout and abort preserve uncertain cost even for a noncooperative adapter', async () => {
  const h = new TestHost(); const p = new TestProvider(); h.snapshot.specification.checkpoints[0]!.timeoutMs = 100;
  p.invoke = async req => { p.calls.push(req); return new Promise(() => {}); };
  const a = createActivities(h, p, runtime);
  // Keep the test process alive: AbortSignal.timeout deliberately uses an unref timer.
  const keepAlive = setInterval(() => {}, 500);
  try { assert.equal((await a.executeCheckpoint(h.ref, 'plan')).snapshot.reason, 'provider_uncertain'); }
  finally { clearInterval(keepAlive); }
  assert.equal(p.calls.length, 1);
});
test('missing config and capability do not call providers', async () => {
  const h = new TestHost();
  assert.equal((await createActivities(h, new UnconfiguredProvider(), runtime).executeCheckpoint(h.ref, 'plan')).snapshot.reason, 'configuration_missing');
  assert.equal(h.snapshot.operations.length, 0);
});
test('an adapter returning arbitrary text or model-granted mastery is treated as uncertain', async () => {
  const h = new TestHost(); const p = new TestProvider();
  p.invoke = async () => ({ ...success(), mastery: true, chainOfThought: 'sensitive' } as unknown as Outcome);
  assert.equal((await createActivities(h, p, runtime).executeCheckpoint(h.ref, 'plan')).snapshot.reason, 'provider_uncertain');
  assert.doesNotMatch(JSON.stringify(h.snapshot), /sensitive|mastery|chainOfThought/);
});
test('job identity mismatch in host response blocks invocation', async () => {
  const h = new TestHost(); const p = new TestProvider(); const requested = { ...h.ref };
  h.snapshot.specification.key.enrollmentId = new TestHost().ref.enrollmentId;
  await assert.rejects(createActivities(h, p, runtime).executeCheckpoint(requested, 'plan'), /invalid_response/);
  assert.equal(p.calls.length, 0);
});
