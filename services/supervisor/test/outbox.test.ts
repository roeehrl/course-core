import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { deliverCancellationsOnce, deliverControlsOnce, deliverCrossCourseOnce, dispatchOnce, reconcileOnce } from '../src/outbox.js';
import { enrollmentWorkflowId, workflowId, type CrossCourseWake } from '../src/contracts.js';
import { TestHost } from './fixtures.js';
import { BridgeError, HttpHostBridge } from '../src/bridge.js';

test('crash after start before ack redelivers identical workflow identity', async () => {
  const h = new TestHost(); h.events = [h.outboxEvent()];
  const accepted = new Set<string>(); let attempts = 0;
  const starter = { async start(_ref: unknown, id: string) { accepted.add(id); attempts++; } };
  const ack = h.ackOutbox.bind(h); let lost = true;
  h.ackOutbox = async () => { if (lost) { lost = false; throw new Error('ack_response_lost'); } return ack(); };
  assert.equal((await dispatchOnce(h, starter)).deferred, 1);
  assert.equal((await dispatchOnce(h, starter)).delivered, 1);
  assert.equal(attempts, 2); assert.deepEqual([...accepted], [workflowId(h.ref)]);
});
test('partial fanout replays stable starts and acknowledges only when all start', async () => {
  const h = new TestHost(); h.events = [h.outboxEvent()];
  const second = { ...h.ref, jobId: randomUUID() };
  h.prepareOutbox = async () => [h.ref, second];
  const attempts: string[] = []; let fail = true;
  const starter = { async start(_ref: unknown, id: string) {
    attempts.push(id); if (id === workflowId(second) && fail) { fail = false; throw new Error('network'); }
  } };
  await dispatchOnce(h, starter); assert.equal(h.acks, 0);
  await dispatchOnce(h, starter); assert.equal(h.acks, 1);
  assert.deepEqual(attempts, [workflowId(h.ref), workflowId(second), workflowId(h.ref), workflowId(second)]);
});
test('delivery failures back off and quarantine at bounded attempt count', async () => {
  const h = new TestHost(); h.events = [{ ...h.outboxEvent(), attempts: 8 }];
  const totals = await dispatchOnce(h, { async start() { throw new Error('unavailable'); } });
  assert.equal(totals.quarantined, 1); assert.equal(h.acks, 0);
  assert.deepEqual(h.nacks, [{ delayMs: 128_000, quarantine: true }]);
  h.events[0]!.attempts = 9; let started = 0;
  await dispatchOnce(h, { async start() { started++; } }); assert.equal(started, 0);
});
test('lost lease cannot acknowledge delivery; malformed/foreign identities do not start', async () => {
  const h = new TestHost(); h.events = [h.outboxEvent()]; h.ackOutbox = async () => false;
  assert.equal((await dispatchOnce(h, { async start() {} })).leaseLost, 1);
  h.prepareOutbox = async () => [{ ...h.ref, enrollmentId: randomUUID() }];
  let starts = 0;
  assert.equal((await dispatchOnce(h, { async start() { starts++; } })).deferred, 1);
  assert.equal(starts, 0);
  h.events[0]!.payload.eventId = randomUUID();
  assert.equal((await dispatchOnce(h, { async start() { starts++; } })).failed, 1);
  assert.equal(starts, 0);
});
test('a failed row does not cause early return while another row is starting', async () => {
  const h = new TestHost(); const bad = h.outboxEvent(); bad.payload.eventId = randomUUID();
  h.events = [bad, h.outboxEvent()]; let finished = false;
  const result = await dispatchOnce(h, { async start() { await new Promise(resolve => setTimeout(resolve, 20)); finished = true; } });
  assert.equal(finished, true); assert.equal(result.failed, 1); assert.equal(result.delivered, 1);
});

test('control changes signal every listed workflow, skip closed ones and retry only on a failed signal', async () => {
  const h = new TestHost(); const closed = { ...h.ref, jobId: randomUUID() };
  const delivery = () => ({ changeId: randomUUID(), leaseToken: randomUUID(), attempts: 1, workspaceId: h.ref.workspaceId,
    signal: { schemaVersion: 1 as const, enrollmentId: h.ref.enrollmentId, state: 'paused' as const, revision: 1 }, jobs: [h.ref, closed] });
  const sent: string[] = []; let fail = true;
  const signaller = { async signal(id: string) {
    sent.push(id);
    if (id === workflowId(closed)) return 'closed' as const;
    if (fail) { fail = false; throw new Error('network'); }
    return 'delivered' as const;
  } };
  const first = delivery(); h.controls = [first];
  assert.deepEqual(await deliverControlsOnce(h, signaller), { claimed: 1, delivered: 0, retried: 1, signalled: 0, closed: 1, leaseLost: 0 });
  h.controls = [first];
  assert.deepEqual(await deliverControlsOnce(h, signaller), { claimed: 1, delivered: 1, retried: 0, signalled: 1, closed: 1, leaseLost: 0 });
  assert.deepEqual(h.controlAcks.map(a => a.delivered), [false, true]);
  const coordinator = enrollmentWorkflowId(h.ref.workspaceId, h.ref.enrollmentId);
  assert.deepEqual(sent, [workflowId(h.ref), workflowId(closed), coordinator, workflowId(h.ref), workflowId(closed), coordinator]);
  // A delivery naming another enrollment's workflow is refused before any signal is sent.
  const foreign = delivery(); foreign.jobs = [{ ...h.ref, enrollmentId: randomUUID() }]; h.controls = [foreign];
  const before = sent.length;
  assert.equal((await deliverControlsOnce(h, signaller)).delivered, 0);
  assert.equal(sent.length, before);
});
test('reconciliation starts every resumed generation and reports failed starts for the next pass', async () => {
  const h = new TestHost(); const second = { ...h.ref, jobId: randomUUID(), generation: 2 };
  h.reconciled = { settled: 2, resume: [{ ...h.ref, generation: 2 }, second] };
  const started: string[] = [];
  const starter = { async start(_ref: unknown, id: string) { started.push(id); if (id === workflowId(second)) throw new Error('network'); } };
  assert.deepEqual(await reconcileOnce(h, starter), { settled: 2, resumed: 1, failed: 1 });
  assert.deepEqual(started, [workflowId({ ...h.ref, generation: 2 }), workflowId(second)]);
  assert.deepEqual(await reconcileOnce(h, starter), { settled: 0, resumed: 0, failed: 0 });
});
test('cancellation delivery signals each job and its coordinator, and retries until every signal is sent', async () => {
  const h = new TestHost(); h.cancelJob('data_erasure');
  const first = h.cancellations[0]!;
  const sent: { id: string; jobId: string; reason: string }[] = []; let fail = true;
  const signaller = { async cancel(id: string, signal: { jobId: string; reason: string }) {
    if (fail && id === workflowId(h.ref)) { fail = false; throw new Error('network'); }
    sent.push({ id, jobId: signal.jobId, reason: signal.reason });
    return id === workflowId(h.ref) ? 'delivered' as const : 'closed' as const;
  } };
  assert.deepEqual(await deliverCancellationsOnce(h, signaller), { claimed: 1, delivered: 0, retried: 1, signalled: 0, closed: 0, leaseLost: 0 });
  h.cancellations = [first];
  assert.deepEqual(await deliverCancellationsOnce(h, signaller), { claimed: 1, delivered: 1, retried: 0, signalled: 1, closed: 0, leaseLost: 0 });
  assert.deepEqual(h.cancellationAcks.map(a => a.delivered), [false, true]);
  const coordinator = enrollmentWorkflowId(h.ref.workspaceId, h.ref.enrollmentId);
  assert.deepEqual(sent.map(x => x.id), [coordinator, workflowId(h.ref), coordinator]);
  assert.ok(sent.every(x => x.jobId === h.ref.jobId && x.reason === 'data_erasure'));
  // A delivery naming another enrollment's job is refused before any signal is sent.
  h.cancellations = [{ ...first, jobs: [{ ...h.ref, enrollmentId: randomUUID() }] }];
  const before = sent.length;
  assert.equal((await deliverCancellationsOnce(h, signaller)).delivered, 0);
  assert.equal(sent.length, before);
  await assert.rejects(deliverCancellationsOnce(h, signaller, { leaseMs: 1 }), /invalid_cancellation_options/);
});

test('a host state conflict is quarantined at once under its own code; outages and lost leases keep their retries', async () => {
  const h = new TestHost(); h.events = [h.outboxEvent()];
  h.prepareOutbox = async () => { throw new BridgeError(409, 'RESEARCH_REQUEST_NOT_ACTIVATED'); };
  let starts = 0; const starter = { async start() { starts++; } };
  assert.deepEqual(await dispatchOnce(h, starter), { claimed: 1, delivered: 0, deferred: 0, quarantined: 1, leaseLost: 0, failed: 0 });
  assert.deepEqual(h.nacks, [{ delayMs: 0, quarantine: true }]); assert.deepEqual(h.nackCodes, ['prepare_conflict']);
  for (const error of [new BridgeError(409, 'SUPERVISOR_LEASE_LOST'), new BridgeError(503, 'SUPERVISOR_UNCONFIGURED'), new BridgeError(0, null), new BridgeError(429, null),
    new BridgeError(408, null), new BridgeError(401, 'SUPERVISOR_UNAUTHENTICATED'), new BridgeError(403, 'SUPERVISOR_FORBIDDEN'), new BridgeError(500, 'SUPERVISOR_STORAGE_ERROR')]) {
    h.nacks = []; h.nackCodes = []; h.prepareOutbox = async () => { throw error; };
    assert.equal((await dispatchOnce(h, starter)).deferred, 1, `${error.status}`);
    assert.deepEqual(h.nackCodes, ['dispatch_unavailable']); assert.equal(h.nacks[0]!.quarantine, false); assert.ok(h.nacks[0]!.delayMs > 0);
  }
  assert.equal(starts, 0);
});
test('a definite client error (not found, erased, invalid) is a terminal refusal under its own code; timeouts and rate limits still retry', async () => {
  const h = new TestHost(); h.events = [h.outboxEvent()];
  let starts = 0; const starter = { async start() { starts++; } };
  for (const error of [new BridgeError(404, 'SUPERVISOR_NOT_FOUND'), new BridgeError(410, 'ENROLLMENT_ERASED'), new BridgeError(422, null), new BridgeError(400, 'SUPERVISOR_INVALID_REQUEST')]) {
    h.nacks = []; h.nackCodes = []; h.prepareOutbox = async () => { throw error; };
    assert.deepEqual(await dispatchOnce(h, starter), { claimed: 1, delivered: 0, deferred: 0, quarantined: 1, leaseLost: 0, failed: 0 }, `${error.status}`);
    assert.deepEqual(h.nacks, [{ delayMs: 0, quarantine: true }]); assert.deepEqual(h.nackCodes, ['prepare_refused']);
    assert.deepEqual([error.refusal, error.conflict, error.rejected], [true, false, true]);
  }
  for (const status of [408, 429]) {
    h.nacks = []; h.nackCodes = []; h.prepareOutbox = async () => { throw new BridgeError(status, null); };
    assert.equal((await dispatchOnce(h, starter)).deferred, 1);
    assert.deepEqual(h.nackCodes, ['dispatch_unavailable']); assert.equal(h.nacks[0]!.quarantine, false);
  }
  // A refusal whose quarantine lost its lease is counted as such, never as delivered.
  h.nackOutbox = async () => false; h.prepareOutbox = async () => { throw new BridgeError(404, 'SUPERVISOR_NOT_FOUND'); };
  assert.deepEqual(await dispatchOnce(h, starter), { claimed: 1, delivered: 0, deferred: 0, quarantined: 0, leaseLost: 1, failed: 0 });
  assert.equal(starts, 0);
});
test('the HTTP host bridge keeps the status and a bounded host error code, never response text', async () => {
  const h = new TestHost(), event = { ...h.outboxEvent(), leaseToken: randomUUID() };
  const answer = (status: number, body: string) => new HttpHostBridge('https://example.invalid', 'test-only', 1000, async () => new Response(body, { status }));
  const caught = async (bridge: HttpHostBridge) => { try { await bridge.prepareOutbox(event); } catch (error) { return error; } assert.fail('expected a rejection'); };
  const conflict = await caught(answer(409, JSON.stringify({ error: 'RUBRIC_ASSIST_CONSENT_CHANGED' })));
  assert.ok(conflict instanceof BridgeError);
  assert.deepEqual([conflict.status, conflict.errorCode, conflict.code, conflict.conflict, conflict.rejected], [409, 'RUBRIC_ASSIST_CONSENT_CHANGED', 'bridge_rejected', true, true]);
  const lost = await caught(answer(409, JSON.stringify({ error: 'SUPERVISOR_LEASE_LOST' }))) as BridgeError;
  assert.deepEqual([lost.conflict, lost.rejected], [false, true]);
  const outage = await caught(answer(500, JSON.stringify({ error: 'SUPERVISOR_STORAGE_ERROR' }))) as BridgeError;
  assert.deepEqual([outage.status, outage.code, outage.conflict, outage.rejected], [500, 'bridge_unavailable', false, false]);
  const missing = await caught(answer(404, JSON.stringify({ error: 'SUPERVISOR_NOT_FOUND' }))) as BridgeError;
  assert.deepEqual([missing.status, missing.errorCode, missing.conflict, missing.refusal], [404, 'SUPERVISOR_NOT_FOUND', false, true]);
  const unauthenticated = await caught(answer(401, JSON.stringify({ error: 'SUPERVISOR_UNAUTHENTICATED' }))) as BridgeError;
  assert.deepEqual([unauthenticated.rejected, unauthenticated.refusal], [true, false]);
  assert.equal(lost.refusal, false); assert.equal(conflict.refusal, true);
  // Free text, oversized or malformed bodies never become an error code.
  for (const body of [JSON.stringify({ error: 'learner wrote: private text' }), 'not json', JSON.stringify({ error: 'A'.repeat(5000) })]) {
    const error = await caught(answer(409, body)) as BridgeError;
    assert.equal(error.errorCode, null); assert.equal(error.conflict, true); assert.doesNotMatch(JSON.stringify(error) + error.message, /private|AAAA/);
  }
  const transport = await caught(new HttpHostBridge('https://example.invalid', 'test-only', 1000, async () => { throw new Error('ECONNREFUSED secret'); })) as BridgeError;
  assert.deepEqual([transport.status, transport.errorCode, transport.code, transport.conflict], [0, null, 'bridge_unavailable', false]);
});

test('cross-course wake-ups: each is signalled once, a failed one is released for retry, and malformed rows are not signalled', async () => {
  const h = new TestHost(), learnerId = randomUUID();
  const row = (active: boolean) => ({ wakeupId: randomUUID(), leaseToken: randomUUID(), attempts: 1, learnerId, consentRevision: 4, active,
    reason: active ? 'evidence_changed' as const : 'consent_revoked' as const });
  h.crossCourseDeliveries = [row(true), row(false)];
  const woken: CrossCourseWake[] = [];
  const totals = await deliverCrossCourseOnce(h, { async wake(signal) { woken.push(signal); return signal.active ? 'delivered' : 'closed'; } });
  assert.deepEqual(totals, { claimed: 2, delivered: 2, retried: 0, opened: 1, closed: 1, leaseLost: 0 });
  // The signal carries identifiers and the host's decision only.
  assert.deepEqual(woken.map(w => Object.keys(w).sort()), [['active', 'consentRevision', 'learnerId', 'reason', 'schemaVersion'], ['active', 'consentRevision', 'learnerId', 'reason', 'schemaVersion']]);
  h.crossCourseDeliveries = [row(true)];
  assert.equal((await deliverCrossCourseOnce(h, { async wake() { throw new Error('temporal_unavailable'); } })).retried, 1);
  assert.deepEqual(h.crossCourseAcks.map(a => a.delivered), [true, true, false]);
  h.crossCourseDeliveries = [{ ...row(true), learnerId: 'not-a-uuid' }];
  let called = 0;
  await deliverCrossCourseOnce(h, { async wake() { called++; return 'delivered'; } });
  assert.equal(called, 0);
  await assert.rejects(deliverCrossCourseOnce(h, { async wake() { return 'delivered'; } }, { limit: 0 }), /invalid_cross_course_options/);
});
