import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { deliverControlsOnce, dispatchOnce, reconcileOnce } from '../src/outbox.js';
import { workflowId } from '../src/contracts.js';
import { TestHost } from './fixtures.js';

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
  assert.deepEqual(sent, [workflowId(h.ref), workflowId(closed), workflowId(h.ref), workflowId(closed)]);
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
