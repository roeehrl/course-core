import { z } from 'zod';
import {
  assert, authoritySchema, changeSchema, commandFields, id, parse, positive,
  type PolicyState,
} from './contracts.js';
import { buildAdjustment, poolBalances } from './extensions.js';
import { readState, resolveInternal, safeSum, scopePath } from './resolver.js';
import { compareInstants } from './time.js';
import { begin, digest, finish, requireAuthority } from './transitions.js';

/** Revocations, refunds and exceptional grants are separate audited operations.
 * None of them deletes a ledger entry: usage, provenance and receipts remain. */

function findGrant(state: PolicyState, grantId: string) {
  const grant = state.grants.find(g => g.grantId === grantId);
  if (grant) return { kind: 'extension' as const, scopeId: grant.adjustment.scopeId, revocation: grant.revocation };
  const exception = state.exceptionalGrants.find(e => e.exceptionId === grantId);
  assert(exception, 'UNKNOWN_GRANT', 'Unknown grant');
  return { kind: 'exceptional' as const, scopeId: exception.adjustment.scopeId, revocation: exception.revocation };
}

const revocationPreviewSchema = z.strictObject({ grantId: id, reasonRef: id });
/** The exact effect of revoking one grant on every scope it touches, including whether
 * any effective deadline gets earlier. A revocation never refunds allowance by itself. */
export function previewRevocation(input: PolicyState, request: z.input<typeof revocationPreviewSchema>) {
  const state = readState(input), args = parse(revocationPreviewSchema, request);
  assert(state.status === 'active', 'ENROLLMENT_INACTIVE', 'A closed enrollment keeps its final ledger');
  const target = findGrant(state, args.grantId);
  assert(!target.revocation, 'ALREADY_REVOKED', 'Grant is already revoked');
  const candidate = structuredClone(state);
  const marker = { revokedAt: '1970-01-01T00:00:00Z', reasonRef: args.reasonRef, previewDigest: 'preview', newPolicyRevision: state.policyRevision + 1,
    authorityReceipt: { receiptId: 'preview', actorId: 'preview', enrollmentId: state.enrollmentId, scopeId: target.scopeId,
      permission: 'revoke_extension' as const, termsDigest: 'preview', authorizedAt: '1970-01-01T00:00:00Z' } };
  if (target.kind === 'extension') candidate.grants.find(g => g.grantId === args.grantId)!.revocation = marker;
  else candidate.exceptionalGrants.find(e => e.exceptionId === args.grantId)!.revocation = marker;
  const affected = state.scopes.filter(s => scopePath(state, s.scopeId).some(p => p.scopeId === target.scopeId));
  const impacts = affected.map(scope => {
    const before = resolveInternal(state, scope.scopeId), after = resolveInternal(candidate, scope.scopeId);
    return { scopeId: scope.scopeId, effectiveDeadlineBefore: before.effectiveDeadline, effectiveDeadlineAfter: after.effectiveDeadline,
      shortened: before.effectiveDeadline !== null && (after.effectiveDeadline === null ? false : compareInstants(after.effectiveDeadline, before.effectiveDeadline) < 0),
      quotasBefore: before.quotas, quotasAfter: after.quotas };
  });
  const preview = { enrollmentId: state.enrollmentId, policyRevision: state.policyRevision, ledgerRevision: state.ledgerRevision,
    grantId: args.grantId, kind: target.kind, scopeId: target.scopeId, reasonRef: args.reasonRef, impacts,
    shortensDeadline: impacts.some(i => i.shortened), allowanceRefunded: false as const };
  return { ...preview, previewDigest: digest(preview) };
}

const revokeSchema = revocationPreviewSchema.extend({ ...commandFields, previewDigest: id, authorityReceipt: authoritySchema });
export function revokeGrant(input: PolicyState, request: z.input<typeof revokeSchema>) {
  const state = readState(input), args = parse(revokeSchema, request);
  const replay = begin(state, args, 'revoke_grant'); if (replay) return replay;
  const preview = previewRevocation(state, { grantId: args.grantId, reasonRef: args.reasonRef });
  assert(preview.previewDigest === args.previewDigest, 'STALE_PREVIEW', 'Revocation impact changed; review it again');
  requireAuthority(state, args.authorityReceipt, 'revoke_extension', preview.scopeId, preview.previewDigest, args.now);
  const next = structuredClone(state);
  const revocation = { revokedAt: args.now, reasonRef: args.reasonRef, previewDigest: preview.previewDigest,
    authorityReceipt: args.authorityReceipt, newPolicyRevision: safeSum([state.policyRevision, 1]) };
  if (preview.kind === 'extension') next.grants.find(g => g.grantId === args.grantId)!.revocation = revocation;
  else next.exceptionalGrants.find(e => e.exceptionId === args.grantId)!.revocation = revocation;
  return finish(state, next, args, 'revoke_grant', args.grantId, true);
}

const refundPreviewSchema = z.strictObject({ refundId: id, grantId: id, poolId: id, amount: positive, reasonRef: id });
export function previewRefund(input: PolicyState, request: z.input<typeof refundPreviewSchema>) {
  const state = readState(input), args = parse(refundPreviewSchema, request);
  assert(!state.refunds.some(r => r.refundId === args.refundId), 'DUPLICATE_REFUND', 'Refund ID already exists');
  const grant = state.grants.find(g => g.grantId === args.grantId);
  assert(grant, 'UNKNOWN_GRANT', 'Only a pool-funded grant can be refunded');
  const debit = grant.poolDebits.find(d => d.poolId === args.poolId);
  assert(debit, 'POOL_NOT_DEBITED', 'This grant did not debit that pool');
  const already = safeSum(state.refunds.filter(r => r.grantId === args.grantId && r.poolId === args.poolId).map(r => r.amount));
  assert(already + args.amount <= debit.amount, 'REFUND_EXCEEDS_DEBIT', 'A refund cannot return more than the grant debited');
  const before = poolBalances(state).find(b => b.poolId === args.poolId)!;
  const preview = { enrollmentId: state.enrollmentId, ledgerRevision: state.ledgerRevision, ...args,
    balanceBefore: before, balanceAfter: { ...before, remaining: before.remaining + args.amount },
    grantRevoked: Boolean(grant.revocation), deadlineChanged: false as const };
  return { ...preview, previewDigest: digest(preview) };
}

const refundSchema = refundPreviewSchema.extend({ ...commandFields, previewDigest: id, authorityReceipt: authoritySchema });
export function refundAllowance(input: PolicyState, request: z.input<typeof refundSchema>) {
  const state = readState(input), args = parse(refundSchema, request);
  const replay = begin(state, args, 'refund_allowance'); if (replay) return replay;
  const { previewDigest, authorityReceipt, expectedLedgerRevision: _l, expectedPolicyRevision: _p, idempotencyKey: _k, now, ...terms } = args;
  const preview = previewRefund(state, terms);
  assert(preview.previewDigest === previewDigest, 'STALE_PREVIEW', 'Refund terms changed; review them again');
  const grant = state.grants.find(g => g.grantId === args.grantId)!;
  requireAuthority(state, authorityReceipt, 'refund_allowance', grant.adjustment.scopeId, previewDigest, now);
  const next = structuredClone(state);
  next.refunds.push({ refundId: args.refundId, grantId: args.grantId, poolId: args.poolId, amount: args.amount, reasonRef: args.reasonRef,
    previewDigest, authorityReceipt, refundedAt: now });
  // Ledger only: a refund changes balances, never deadlines or quotas.
  return finish(state, next, args, 'refund_allowance', args.refundId);
}

const exceptionalPreviewSchema = z.strictObject({ exceptionId: id, scopeId: id, reasonRef: id, change: changeSchema });
/** An authorized grant outside the allowance pools. It names the policy level it changes;
 * a binding ancestor still binds unless the exception is made at that ancestor. */
export function previewExceptionalGrant(input: PolicyState, request: z.input<typeof exceptionalPreviewSchema>) {
  const state = readState(input), args = parse(exceptionalPreviewSchema, request);
  assert(state.status === 'active', 'ENROLLMENT_INACTIVE', 'An exception cannot silently reopen an enrollment');
  assert(!state.exceptionalGrants.some(e => e.exceptionId === args.exceptionId), 'DUPLICATE_EXCEPTION', 'Exception ID already exists');
  const adjustment = buildAdjustment(state, args.scopeId, args.change);
  const before = resolveInternal(state, args.scopeId), after = resolveInternal(state, args.scopeId, adjustment);
  const preview = { ...args, enrollmentId: state.enrollmentId, policyRevision: state.policyRevision, ledgerRevision: state.ledgerRevision, adjustment,
    effectiveDeadlineBefore: before.effectiveDeadline, effectiveDeadlineAfter: after.effectiveDeadline, quotasBefore: before.quotas, quotasAfter: after.quotas,
    poolDebits: [] as const, addedRequiredWork: false as const };
  return { ...preview, previewDigest: digest(preview) };
}

const exceptionalSchema = exceptionalPreviewSchema.extend({ ...commandFields, previewDigest: id, authorityReceipt: authoritySchema });
export function grantExceptional(input: PolicyState, request: z.input<typeof exceptionalSchema>) {
  const state = readState(input), args = parse(exceptionalSchema, request);
  const replay = begin(state, args, 'exceptional_grant'); if (replay) return replay;
  const preview = previewExceptionalGrant(state, { exceptionId: args.exceptionId, scopeId: args.scopeId, reasonRef: args.reasonRef, change: args.change });
  assert(preview.previewDigest === args.previewDigest, 'STALE_PREVIEW', 'Exception terms changed; review them again');
  requireAuthority(state, args.authorityReceipt, 'exceptional_grant', args.scopeId, preview.previewDigest, args.now);
  const next = structuredClone(state);
  next.exceptionalGrants.push({ exceptionId: args.exceptionId, reasonRef: args.reasonRef, previewDigest: preview.previewDigest,
    authorityReceipt: args.authorityReceipt, adjustment: preview.adjustment, newPolicyRevision: safeSum([state.policyRevision, 1]), grantedAt: args.now });
  return finish(state, next, args, 'exceptional_grant', args.exceptionId, true);
}
