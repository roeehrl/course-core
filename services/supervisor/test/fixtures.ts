import { randomUUID } from 'node:crypto';
import { createJob, transition, type HostContext } from '../src/state-machine.js';
import type { HostBridge } from '../src/bridge.js';
import type { ProviderGateway } from '../src/providers.js';
import type { Command, ControlDelivery, JobSpec, Outcome, OutboxEvent, ProviderRequest, RunRef, Snapshot } from '../src/contracts.js';

export function specification(): JobSpec {
  return { schemaVersion: 1, key: { jobId: randomUUID(), workspaceId: randomUUID(), enrollmentId: randomUUID() },
    inputEventId: randomUUID(), role: 'supervisor',
    fence: { enrollmentRevision: 1, profileRevision: 1, policyRevision: 1, ledgerRevision: 0, courseDigest: 'a'.repeat(64) },
    checkpoints: [{ id: 'plan', capability: 'supervisor', inputRef: randomUUID(), allowance: { microUsd: 100, tokens: 100 }, timeoutMs: 1_000, maxAttempts: 3 }],
    budget: { microUsd: 200, tokens: 200 }, deadlineAtMs: Date.now() + 60_000 };
}
export function success(): Outcome {
  return { status: 'succeeded', artifact: { artifactId: randomUUID(), digest: 'b'.repeat(64) }, usage: { microUsd: 25, tokens: 40 } };
}
// TEST ONLY. This deliberately does not pretend to provide durable production storage.
export class TestHost implements HostBridge {
  snapshot: Snapshot;
  host: HostContext;
  verificationEnabled = true;
  applications = 0;
  commands: Command[] = [];
  events: OutboxEvent[] = [];
  acks = 0;
  nacks: { quarantine: boolean; delayMs: number }[] = [];
  failAfter: Command['type'] | null = null;
  controls: ControlDelivery[] = [];
  controlAcks: { changeId: string; delivered: boolean }[] = [];
  constructor(spec = specification()) {
    this.snapshot = createJob(spec);
    this.host = { nowMs: Date.now(), currentFence: structuredClone(spec.fence), enrollmentActive: true, cancellationRequested: false,
      availableBudget: { microUsd: 1_000_000, tokens: 1_000_000 } };
  }
  get ref(): RunRef { return { ...this.snapshot.specification.key, generation: this.snapshot.generation }; }
  async load(_ref?: RunRef) { return structuredClone(this.snapshot); }
  async transition(command: Command) {
    this.commands.push(command);
    const context = { ...this.host };
    if (command.type === 'verify' && this.verificationEnabled) {
      context.verification = { receiptId: randomUUID(), jobId: this.ref.jobId, fence: this.snapshot.specification.fence,
        artifacts: this.snapshot.operations.flatMap(o => o.outcome?.status === 'succeeded' ? [o.outcome.artifact] : []), verdict: 'verified' };
    }
    if (command.type === 'apply') context.applicationReceiptId = this.snapshot.applicationReceiptId ?? randomUUID();
    const previous = this.snapshot;
    const result = transition(this.snapshot, command, context);
    this.snapshot = result.snapshot;
    if (result.snapshot.state === 'applied' && previous.state !== 'applied') this.applications++;
    if (this.failAfter === command.type) { this.failAfter = null; throw new Error('lost_commit_response'); }
    return structuredClone(result);
  }
  async claimOutbox() { return this.events; }
  async prepareOutbox() { return [this.ref]; }
  async ackOutbox() { this.acks++; return true; }
  async nackOutbox(_event: OutboxEvent, _code: unknown, delayMs: number, quarantine: boolean) {
    this.nacks.push({ delayMs, quarantine }); return true;
  }
  reconciled: { settled: number; resume: RunRef[] } = { settled: 0, resume: [] };
  async reconcile() { const out = this.reconciled; this.reconciled = { settled: 0, resume: [] }; return out; }
  async claimControls() { const claimed = this.controls; this.controls = []; return claimed; }
  async ackControl(delivery: ControlDelivery, delivered: boolean) { this.controlAcks.push({ changeId: delivery.changeId, delivered }); return true; }
  outboxEvent(): OutboxEvent {
    const eventId = this.snapshot.specification.inputEventId;
    return { eventId, kind: 'supervisor.event', payload: { eventId, enrollmentId: this.ref.enrollmentId }, leaseToken: randomUUID(), attempts: 1 };
  }
}
export class TestProvider implements ProviderGateway {
  calls: ProviderRequest[] = [];
  result: Outcome = success();
  async availability() { return { status: 'ready' as const }; }
  async invoke(request: ProviderRequest) { this.calls.push(request); return this.result; }
}
