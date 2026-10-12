import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { dispatchOnce } from '../src/outbox.js';
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
