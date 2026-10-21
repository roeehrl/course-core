import {
  allowanceSchema, fenceSchema, jobCommandSchema, jobSpecSchema, snapshotSchema, verificationSchema, operationId, MAX_PARK_MS, PARKED_STATES,
  type Command, type Fence, type JobSpec, type Snapshot, type Transition, type Verification,
} from './contracts.js';

// Supplied by the host INSIDE its transaction, never by a provider or a browser.
export interface HostContext {
  nowMs: number;
  currentFence: Fence;
  enrollmentActive: boolean;
  cancellationRequested: boolean;
  // Staff supervision control for the enrollment, read under the enrollment lock. Omitted = active.
  supervision?: 'active' | 'paused' | 'stopped';
  // Remaining shared provider budget, read under the same ledger lock as reservation persistence.
  availableBudget: { microUsd: number; tokens: number };
  verification?: Verification;
  // Created in the SAME transaction as authorized proposal application and its event/outbox.
  applicationReceiptId?: string;
}
export class ContractError extends Error {
  constructor(readonly code: string) { super(code); }
}
export function sameFence(a: Fence, b: Fence): boolean {
  return a.enrollmentRevision === b.enrollmentRevision && a.profileRevision === b.profileRevision
    && a.policyRevision === b.policyRevision && a.ledgerRevision === b.ledgerRevision && a.courseDigest === b.courseDigest;
}
export function createJob(input: JobSpec): Snapshot {
  return { specification: jobSpecSchema.parse(input), generation: 1, version: 0, state: 'queued',
    reason: null, operations: [], verification: null, applicationReceiptId: null };
}
/** Budget consumption, including conservative ceilings; never an invoice or proof of billed cost. */
export function accounting(snapshot: Snapshot) {
  return snapshot.operations.reduce((total, op) => {
    const used = op.outcome?.status === 'succeeded' ? op.outcome.usage
      : op.status === 'in_flight' || op.status === 'uncertain' ? op.reservation : { microUsd: 0, tokens: 0 };
    return { microUsd: total.microUsd + used.microUsd, tokens: total.tokens + used.tokens };
  }, { microUsd: 0, tokens: 0 });
}
const terminal = (s: Snapshot) => ['applied', 'cancelled', 'failed'].includes(s.state);
const parked = (s: Snapshot) => (PARKED_STATES as readonly string[]).includes(s.state);
const PHASE_STATE = { analyze: 'analyzing', build: 'building', evaluate: 'evaluating' } as const;
function stop(s: Snapshot, state: Snapshot['state'], reason: Snapshot['reason']): Transition {
  s.state = state; s.reason = reason;
  if (state === 'cancelled' || state === 'failed') {
    for (const op of s.operations) if (op.status === 'in_flight') {
      op.status = 'uncertain'; op.outcome = { status: 'uncertain' };
    }
  }
  return { snapshot: s, effect: 'stop' };
}
function guard(s: Snapshot, host: HostContext): Transition | undefined {
  if (terminal(s)) return { snapshot: s, effect: 'stop' };
  if (host.supervision === 'stopped') return stop(s, 'cancelled', 'supervision_stopped');
  if (host.cancellationRequested) return stop(s, 'cancelled', 'cancel_requested');
  if (!sameFence(s.specification.fence, host.currentFence)) return stop(s, 'cancelled', 'stale_revision');
  if (!host.enrollmentActive) return stop(s, 'cancelled', 'inactive_enrollment');
  if (host.nowMs >= s.specification.deadlineAtMs) return stop(s, 'failed', 'deadline_exceeded');
}

/** Pure reducer. Host MUST serialize, persist before returning effects, and enforce generation CAS. */
export function transition(input: Snapshot, raw: Command, host: HostContext): Transition {
  const s = snapshotSchema.parse(input);
  const cmd = jobCommandSchema.parse(raw);
  const spec = s.specification;
  if (!Number.isSafeInteger(host.nowMs) || host.nowMs < 0) throw new ContractError('invalid_clock');
  const available = allowanceSchema.parse(host.availableBudget);
  if (cmd.ref.jobId !== spec.key.jobId || cmd.ref.workspaceId !== spec.key.workspaceId
    || cmd.ref.enrollmentId !== spec.key.enrollmentId) throw new ContractError('job_identity_mismatch');
  if (cmd.ref.generation !== s.generation) throw new ContractError('stale_generation');
  s.version += 1;

  // Settle budget consumption even if cancelled/stale/expired. Late output cannot become applicable.
  if (cmd.type === 'settle') {
    const op = s.operations.find(o => o.id === cmd.operationId);
    if (!op || op.ownerId !== cmd.ownerId) throw new ContractError('operation_owner_mismatch');
    if (cmd.outcome.status === 'succeeded') {
      for (const dimension of ['microUsd', 'tokens'] as const) {
        if (cmd.outcome.usageBasis?.[dimension] === 'reserved_ceiling'
          && cmd.outcome.usage[dimension] !== op.reservation[dimension]) {
          throw new ContractError('usage_basis_mismatch');
        }
      }
    }
    if (op.outcome && op.outcome.status !== 'uncertain') {
      if (JSON.stringify(op.outcome) !== JSON.stringify(cmd.outcome)) throw new ContractError('settlement_conflict');
      return guard(s, host) ?? { snapshot: s, effect: op.status === 'succeeded' ? 'continue' : 'retry' };
    }
    op.outcome = cmd.outcome;
    op.status = cmd.outcome.status;
    const blocked = guard(s, host);
    if (blocked) return blocked;
    if (cmd.outcome.status === 'uncertain') return stop(s, 'waiting', 'provider_uncertain');
    if (cmd.outcome.status === 'not_started') {
      if (!cmd.outcome.retryable) return stop(s, 'failed', 'provider_rejected');
      const cp = spec.checkpoints.find(c => c.id === op.checkpointId)!;
      if (op.attempt >= cp.maxAttempts) return stop(s, 'failed', 'attempts_exhausted');
      s.state = 'running'; s.reason = null;
      return { snapshot: s, effect: 'retry' };
    }
    const usage = cmd.outcome.usage;
    if (usage.microUsd > op.reservation.microUsd || usage.tokens > op.reservation.tokens)
      return stop(s, 'failed', 'usage_exceeded');
    // A concurrent builder's call may still be out: the job shows what that call is doing.
    const open = s.operations.find(o => o.status === 'in_flight');
    const phase = open && spec.checkpoints.find(c => c.id === open.checkpointId)?.phase;
    s.state = phase ? PHASE_STATE[phase] : 'running'; s.reason = null;
    return { snapshot: s, effect: 'continue' };
  }
  const blocked = guard(s, host);
  if (blocked) return blocked;
  if (cmd.type === 'halt') {
    for (const op of s.operations) if (op.status === 'in_flight') {
      op.status = 'uncertain'; op.outcome = { status: 'uncertain' };
    }
    return stop(s, cmd.reason === 'cancel_requested' || cmd.reason === 'supervision_stopped' ? 'cancelled' : 'failed', cmd.reason);
  }
  // A parked job waits for the host to resume it in a new generation; a late step of the old
  // generation changes nothing.
  if (parked(s) && cmd.type !== 'park') return { snapshot: s, effect: 'stop' };
  // A pause starts no provider call and publishes nothing. Settling, verifying and halting go on,
  // so money already committed is still accounted and the deadline still ends a held job.
  if (host.supervision === 'paused' && (cmd.type === 'claim' || cmd.type === 'apply')) return { snapshot: s, effect: 'hold' };
  if (cmd.type === 'park') {
    // Only between calls: a call that is out must settle (or be reconciled) first.
    if (s.operations.some(o => o.status === 'in_flight' || o.status === 'uncertain')) throw new ContractError('park_with_open_call');
    if (cmd.deadlineAtMs !== undefined) {
      if (cmd.deadlineAtMs < spec.deadlineAtMs || cmd.deadlineAtMs > host.nowMs + MAX_PARK_MS) throw new ContractError('invalid_park_deadline');
      spec.deadlineAtMs = cmd.deadlineAtMs;
    }
    if (cmd.reason === 'follow_up_due' && (cmd.dueAtMs === undefined || cmd.dueAtMs >= spec.deadlineAtMs)) throw new ContractError('invalid_follow_up');
    s.state = cmd.reason; s.reason = cmd.reason === 'needs_input' ? 'input_required' : 'follow_up_scheduled';
    if (cmd.dueAtMs !== undefined) s.dueAtMs = cmd.dueAtMs; else delete s.dueAtMs;
    return { snapshot: s, effect: 'stop' };
  }

  if (cmd.type === 'claim') {
    const index = spec.checkpoints.findIndex(c => c.id === cmd.checkpointId);
    const cp = spec.checkpoints[index];
    if (!cp) throw new ContractError('unknown_checkpoint');
    // Earlier checkpoints must have succeeded, except the claimed one's concurrent group.
    const previous = spec.checkpoints.slice(0, index).filter(c => cp.group === undefined || c.group !== cp.group);
    if (previous.some(c => !s.operations.some(o => o.checkpointId === c.id && o.status === 'succeeded')))
      throw new ContractError('checkpoint_order');
    const op = s.operations.find(o => o.checkpointId === cp.id);
    if (op?.status === 'succeeded') return { snapshot: s, effect: 'continue' };
    if (op?.status === 'in_flight' || op?.status === 'uncertain') {
      // A lost permit response or overlapping activity NEVER reissues a billable invocation.
      op.status = 'uncertain'; op.outcome = { status: 'uncertain' };
      return stop(s, 'waiting', 'provider_uncertain');
    }
    if (op && (op.attempt >= cp.maxAttempts || op.outcome?.status !== 'not_started' || !op.outcome.retryable))
      return stop(s, 'failed', 'attempts_exhausted');
    if (cmd.availability.status !== 'ready') return stop(s, 'waiting', cmd.availability.status);
    const total = accounting(s);
    if (total.microUsd + cp.allowance.microUsd > spec.budget.microUsd || total.tokens + cp.allowance.tokens > spec.budget.tokens
      || cp.allowance.microUsd > available.microUsd || cp.allowance.tokens > available.tokens)
      return stop(s, 'budget_wait', 'budget_exhausted');
    const next = { id: operationId(spec.key.jobId, cp.id), checkpointId: cp.id, ownerId: cmd.ownerId,
      attempt: (op?.attempt ?? 0) + 1, status: 'in_flight' as const, reservation: cp.allowance, outcome: null };
    if (op) s.operations[s.operations.indexOf(op)] = next; else s.operations.push(next);
    s.state = cp.phase ? PHASE_STATE[cp.phase] : 'running'; s.reason = null;
    return { snapshot: s, effect: 'invoke' };
  }
  const artifacts = spec.checkpoints.map(cp => s.operations.find(o => o.checkpointId === cp.id)?.outcome)
    .filter(o => o?.status === 'succeeded').map(o => o.artifact);
  if (artifacts.length !== spec.checkpoints.length) throw new ContractError('incomplete_checkpoints');
  if (cmd.type === 'verify') {
    if (!host.verification) return stop(s, 'verifying', 'verification_required');
    const receipt = verificationSchema.parse(host.verification);
    const expected = artifacts.map(a => `${a.artifactId}/${a.digest}`).sort();
    const actual = receipt.artifacts.map(a => `${a.artifactId}/${a.digest}`).sort();
    if (receipt.jobId !== spec.key.jobId || !sameFence(receipt.fence, spec.fence)
      || JSON.stringify(expected) !== JSON.stringify(actual)) throw new ContractError('verification_binding_mismatch');
    s.verification = receipt;
    if (receipt.verdict === 'rejected') return stop(s, 'failed', 'verification_rejected');
    s.state = 'ready'; s.reason = null;
    return { snapshot: s, effect: 'continue' };
  }
  if (s.state !== 'ready' || s.verification?.verdict !== 'verified') throw new ContractError('unverified_application');
  if (!host.applicationReceiptId) throw new ContractError('missing_application_receipt');
  s.applicationReceiptId = host.applicationReceiptId;
  s.state = 'applied'; s.reason = null;
  return { snapshot: snapshotSchema.parse(s), effect: 'stop' };
}

/** A parked job with nothing pending from its old context is re-based on the host's current
 * revisions when it resumes: a follow-up that never called a provider, or a job whose only output
 * waited for a person's decision that the person has now applied under their own authority. The
 * host decides which; the reducer only refuses anything else. The deadline may be extended. */
export function refence(input: Snapshot, fence: Fence, deadlineAtMs: number, nowMs: number): Snapshot {
  const s = snapshotSchema.parse(input);
  if (!parked(s) || s.operations.some(o => o.status === 'in_flight' || o.status === 'uncertain')) throw new ContractError('not_refenceable');
  if (!Number.isSafeInteger(deadlineAtMs) || deadlineAtMs <= nowMs || deadlineAtMs > nowMs + MAX_PARK_MS) throw new ContractError('invalid_park_deadline');
  s.specification.fence = fenceSchema.parse(fence);
  s.specification.deadlineAtMs = Math.max(deadlineAtMs, s.specification.deadlineAtMs);
  s.version += 1;
  return snapshotSchema.parse(s);
}
/** Whether a non-terminal job may restart in a new generation: no call may be out or unknown. */
export function resumable(input: Snapshot): boolean {
  const s = snapshotSchema.parse(input);
  return !terminal(s) && s.generation < 16 && !s.operations.some(o => o.status === 'in_flight' || o.status === 'uncertain');
}
/** The host's restart of a parked, waiting or reconciled job: same specification, operations and
 * accounting, next generation. The previous generation's workflow must have closed. */
export function nextGeneration(input: Snapshot): Snapshot {
  if (!resumable(input)) throw new ContractError('not_resumable');
  const s = snapshotSchema.parse(input);
  s.generation += 1; s.version += 1; s.state = 'queued'; s.reason = null; delete s.dueAtMs;
  return snapshotSchema.parse(s);
}
