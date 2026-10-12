import * as policy from '../dist/index.js';

export const NOW = '2030-01-02T12:00:00Z';
export const at = day => `2030-01-${String(day).padStart(2, '0')}T12:00:00Z`;
export const hard = day => ({ at: at(day), timeZone: 'UTC', disambiguation: 'reject' });
export function initial() {
  const extensions = poolIds => ({ enabled: true, learnerAcceptanceRequired: true, poolIds,
    requiredAuthorityIds: [], offerCooldownHours: 0, maxOutstandingOffersPerScope: 3, maxOffersPerScope: 20 });
  return {
    enrollmentId: 'enrollment', learnerId: 'learner', coreObjectiveIds: ['objective-a', 'objective-b'], conceptIds: ['concept-a', 'concept-b'],
    scopes: [
      { scopeId: 'course', parentScopeId: null, policyId: 'course-policy', kind: 'course', mode: 'bounded',
        hardDeadline: hard(20), work: { additionalMinutes: 120, additionalEpisodes: 12, remediationCyclesPerConcept: 2 },
        extensions: extensions(['course-days']), existingMaterialAccess: 'read_only' },
      ...['chapter', 'sibling'].map(scopeId => ({ scopeId, parentScopeId: 'course', policyId: `${scopeId}-policy`, kind: 'chapter', mode: 'bounded',
        hardDeadline: hard(10), work: { additionalMinutes: 60, additionalEpisodes: 6, remediationCyclesPerConcept: 2 },
        extensions: extensions(['shared-days', 'minutes', 'episodes']), existingMaterialAccess: 'read_only' })),
    ],
    pools: [
      { poolId: 'course-days', scopeIds: ['course'], unit: 'calendar_day', total: 6, maxPerGrant: 2, maxGrants: 3 },
      { poolId: 'shared-days', scopeIds: ['chapter', 'sibling'], unit: 'scope_calendar_day', total: 4, maxPerGrant: 2, maxGrants: 2 },
      { poolId: 'minutes', scopeIds: ['chapter', 'sibling'], unit: 'planned_minute', total: 40, maxPerGrant: 20, maxGrants: 2 },
      { poolId: 'episodes', scopeIds: ['chapter', 'sibling'], unit: 'episode', total: 4, maxPerGrant: 2, maxGrants: 2 },
    ],
  };
}
export function state(modify = () => {}) { const input = initial(); modify(input); return policy.createPolicyState(input); }
export function cmd(s, idempotencyKey, extra = {}) {
  return { expectedPolicyRevision: s.policyRevision, expectedLedgerRevision: s.ledgerRevision, idempotencyKey, now: NOW, ...extra };
}
export function proposal(s, offerId = 'offer', overrides = {}) {
  return cmd(s, `propose-${offerId}`, { offerId, scopeId: 'chapter', change: { deadline: { kind: 'absolute', calendarDays: 2 } },
    addedWork: { additionalMinutes: 10, additionalEpisodes: 1 }, poolDebits: [{ poolId: 'shared-days', amount: 2 }],
    rationaleEvidenceRefs: ['evidence-ref'], proposedActivities: ['practice-ref'], planImpact: 'Schedule one additional practice activity.',
    alternatives: ['Continue with documented gaps.'], expiresAt: at(5), ...overrides });
}
export function proposed(s = state(), offerId = 'offer', overrides = {}) { return policy.proposeExtension(s, proposal(s, offerId, overrides)).state; }
export function acceptance(s, offerId = 'offer', overrides = {}) {
  const offer = s.offers.find(o => o.terms.offerId === offerId);
  return { receiptId: `consent-${offerId}`, learnerId: s.learnerId, enrollmentId: s.enrollmentId, offerId,
    termsDigest: offer.termsDigest, explicit: true, acceptedAt: NOW, ...overrides };
}
export function grant(s, offerId = 'offer', overrides = {}) {
  return cmd(s, `grant-${offerId}`, { offerId, grantId: `grant-${offerId}`, atomicLedgerTransactionId: `transaction-${offerId}`,
    acceptance: acceptance(s, offerId), authorityReceipts: [], ...overrides });
}
export function authority(s, permission, termsDigest, scopeId = 'course', extra = {}) {
  return { receiptId: 'authority-receipt', actorId: 'admin', enrollmentId: s.enrollmentId, scopeId,
    permission, termsDigest, authorizedAt: NOW, ...extra };
}
export function migration(s, scopes = structuredClone(s.scopes), extra = {}) {
  const preview = policy.previewPolicyChange(s, { scopes });
  return cmd(s, 'migration', { migrationId: 'migration', reasonRef: 'reviewed-change', scopes,
    previewDigest: preview.previewDigest, authorityReceipt: authority(s, 'migrate_policy', preview.previewDigest), ...extra });
}
export function errorCode(code) { return error => error instanceof policy.PolicyError && error.code === code; }
export function deepFreeze(value) {
  Object.freeze(value);
  for (const child of Object.values(value)) if (child && typeof child === 'object') deepFreeze(child);
  return value;
}
