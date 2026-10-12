import { createHash } from 'node:crypto';
import {
  assert, type AuthorityReceipt, type Command, type PolicyState, type Transition,
} from './contracts.js';
import { compareInstants } from './time.js';
import { readState, safeSum } from './resolver.js';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function digest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }

function requestDigest(operation: string, command: Command) {
  const transportFields = ['expectedPolicyRevision', 'expectedLedgerRevision', 'now', 'idempotencyKey', 'atomicLedgerTransactionId'];
  return digest({ operation, command: Object.fromEntries(Object.entries(command).filter(([k]) => !transportFields.includes(k))) });
}

export function begin(state: PolicyState, command: Command, operation: string): Transition | undefined {
  const previous = state.receipts.find(r => r.idempotencyKey === command.idempotencyKey);
  if (previous) {
    assert(previous.requestDigest === requestDigest(operation, command), 'IDEMPOTENCY_CONFLICT', 'Key was already used for different command terms');
    return { state, receipt: previous, replayed: true, preconditions: preconditions(state) };
  }
  assert(command.expectedPolicyRevision === state.policyRevision, 'STALE_POLICY_REVISION', 'Policy revision changed; rebase visibly');
  assert(command.expectedLedgerRevision === state.ledgerRevision, 'STALE_LEDGER_REVISION', 'Ledger revision changed; retry against a fresh snapshot');
  const latest = state.audit.at(-1);
  assert(!latest || compareInstants(command.now, latest.at) >= 0, 'INVALID_TIME', 'Server command time cannot precede the last transition');
  return undefined;
}

function preconditions(state: PolicyState) {
  return { enrollmentId: state.enrollmentId, policyRevision: state.policyRevision, ledgerRevision: state.ledgerRevision };
}

export function finish(before: PolicyState, state: PolicyState, command: Command, operation: string, resourceId: string, policyChanged = false): Transition {
  state.ledgerRevision = safeSum([before.ledgerRevision, 1]);
  state.policyRevision = safeSum([before.policyRevision, policyChanged ? 1 : 0]);
  const receipt = { idempotencyKey: command.idempotencyKey, requestDigest: requestDigest(operation, command), operation, resourceId,
    policyRevision: state.policyRevision, ledgerRevision: state.ledgerRevision };
  state.receipts.push(receipt);
  state.audit.push({ eventId: `event-${state.ledgerRevision}`, operation, resourceId, at: command.now,
    policyRevision: state.policyRevision, ledgerRevision: state.ledgerRevision, idempotencyKey: command.idempotencyKey });
  return { state: readState(state), receipt, replayed: false, preconditions: preconditions(before) };
}

/** Receipts are claims from a trusted authorization adapter, not authentication. */
export function requireAuthority(state: PolicyState, receipt: AuthorityReceipt, permission: AuthorityReceipt['permission'], scopeId: string, termsDigest: string, now: string) {
  assert(receipt.enrollmentId === state.enrollmentId && receipt.scopeId === scopeId && receipt.permission === permission
    && receipt.termsDigest === termsDigest && compareInstants(receipt.authorizedAt, now) <= 0,
  'AUTHORITY_REQUIRED', 'A verified authority receipt for these exact terms and scope is required');
}
