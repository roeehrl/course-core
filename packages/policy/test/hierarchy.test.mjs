import test from 'node:test';
import assert from 'node:assert/strict';
import * as policy from '../dist/index.js';
import { NOW, at, hard, cmd, authority, errorCode, initial, migration, proposal } from './helpers.mjs';

/** The full level order: organization → course → enrollment → chapter → episode. */
function layered(modify = () => {}) {
  const input = initial();
  const [course, chapter, sibling] = input.scopes;
  course.parentScopeId = 'organization';
  chapter.parentScopeId = 'enrollment';
  sibling.parentScopeId = 'enrollment';
  input.scopes = [
    { scopeId: 'organization', parentScopeId: null, policyId: 'org-policy', kind: 'organization', mode: 'bounded',
      ultimateDeadline: at(25), work: { additionalMinutes: 200 }, existingMaterialAccess: 'read_only' },
    course,
    { scopeId: 'enrollment', parentScopeId: 'course', policyId: 'enrollment-policy', kind: 'enrollment', mode: 'bounded', work: {}, existingMaterialAccess: 'read_only' },
    chapter, sibling,
  ];
  modify(input);
  return policy.createPolicyState(input);
}

test('G03: organization and enrollment levels bind below them, and the explanation names the binding level', () => {
  const s = layered(input => { input.scopes[2].hardDeadline = hard(8); });
  const chapter = policy.resolveConstraints(s, 'chapter');
  assert.deepEqual(chapter.ancestorScopeIds, ['organization', 'course', 'enrollment', 'chapter']);
  // The enrollment's own day-8 deadline is earlier than the chapter's day 10 and the course's day 20.
  assert.equal(chapter.effectiveDeadline, at(8));
  assert.deepEqual(chapter.binding.deadline, { scopeId: 'enrollment', level: 'enrollment', kind: 'absolute', at: at(8) });
  // Minutes: organization 200, course 120, chapter 60 — the chapter has the least room.
  const minutes = chapter.binding.quotas.find(q => q.metric === 'additionalMinutes');
  assert.deepEqual([minutes.scopeId, minutes.level, minutes.remaining], ['chapter', 'chapter', 60]);
  // The organization's ultimate ceiling is part of every level's deadlines.
  assert.ok(chapter.deadlines.some(d => d.scopeId === 'organization' && d.kind === 'ultimate'));
  assert.equal(policy.envelopeScopeId(s), 'enrollment');
});

test('G03: on a tie the outermost level is named, because it binds everything below it too', () => {
  const s = layered(input => { input.scopes[0].work = { additionalMinutes: 60 }; });
  const minutes = policy.resolveConstraints(s, 'chapter').binding.quotas.find(q => q.metric === 'additionalMinutes');
  assert.deepEqual([minutes.scopeId, minutes.level], ['organization', 'organization']);
});

test('G03: a changed child level can only tighten its parent; an unchanged looser setting is not re-judged', () => {
  const s = layered();
  const looser = structuredClone(s.scopes);
  looser.find(x => x.scopeId === 'enrollment').hardDeadline = hard(22);
  assert.throws(() => policy.previewPolicyChange(s, { scopes: looser }), errorCode('LOOSER_THAN_PARENT'));
  const moreWork = structuredClone(s.scopes);
  moreWork.find(x => x.scopeId === 'enrollment').work = { additionalMinutes: 150 };
  assert.throws(() => policy.previewPolicyChange(s, { scopes: moreWork }), errorCode('LOOSER_THAN_PARENT'));
  assert.deepEqual(policy.looserThanParent({ ...s, scopes: moreWork }, 'enrollment').map(v => [v.field, v.bindingScopeId]), [['additionalMinutes', 'course']]);
  // Tightening is fine and goes through the audited migration.
  const tighter = structuredClone(s.scopes);
  tighter.find(x => x.scopeId === 'enrollment').hardDeadline = hard(9);
  const reviewed = policy.previewPolicyChange(s, { scopes: tighter });
  const applied = policy.applyPolicyChange(s, migration(s, tighter, { authorityReceipt: authority(s, 'migrate_policy', reviewed.previewDigest, 'organization') }));
  assert.equal(policy.resolveConstraints(applied.state, 'chapter').binding.deadline.scopeId, 'enrollment');
  // The chapters' authored day-10 deadlines are later than the new day-9 enrollment end, but they did not change.
  const targetOnly = structuredClone(applied.state.scopes);
  targetOnly.find(x => x.scopeId === 'chapter').targetDate = at(7);
  assert.doesNotThrow(() => policy.previewPolicyChange(applied.state, { scopes: targetOnly }));
});

test('G03: closure at the cap judges the whole enrollment envelope, not only the root', () => {
  const s = layered(input => { input.scopes[2].hardDeadline = hard(8); });
  const before = policy.previewClosure(s, { now: at(7), reason: 'withdrawn', coveredObjectiveIds: [], demonstratedConceptIds: [] });
  assert.equal(before.report.reason, 'withdrawn');
  assert.throws(() => policy.previewClosure(s, { now: at(7), reason: 'cap', coveredObjectiveIds: [], demonstratedConceptIds: [] }), errorCode('CAP_NOT_REACHED'));
  const preview = policy.previewClosure(s, { now: at(8), reason: 'cap', coveredObjectiveIds: [], demonstratedConceptIds: [] });
  const closed = policy.closeEnrollment(s, { ...cmd(s, 'close', { now: at(8) }), reason: 'cap', coveredObjectiveIds: [], demonstratedConceptIds: [],
    previewDigest: preview.previewDigest, authorityReceipt: authority(s, 'close_enrollment', preview.previewDigest, 'enrollment', { authorizedAt: at(8) }) });
  assert.equal(closed.state.status, 'closed');
  // Authority over a level above the enrollment may close it; authority over one chapter may not.
  assert.equal(policy.closeEnrollment(s, { ...cmd(s, 'close-2', { now: at(8) }), reason: 'cap', coveredObjectiveIds: [], demonstratedConceptIds: [],
    previewDigest: preview.previewDigest, authorityReceipt: authority(s, 'close_enrollment', preview.previewDigest, 'organization', { authorizedAt: at(8) }) }).state.status, 'closed');
  assert.throws(() => policy.closeEnrollment(s, { ...cmd(s, 'close-3', { now: at(8) }), reason: 'cap', coveredObjectiveIds: [], demonstratedConceptIds: [],
    previewDigest: preview.previewDigest, authorityReceipt: authority(s, 'close_enrollment', preview.previewDigest, 'chapter', { authorizedAt: at(8) }) }), errorCode('AUTHORITY_REQUIRED'));
});

test('G03: an organization that disables extensions disables them for every level below', () => {
  const s = layered(input => {
    input.scopes[0].extensions = { enabled: false, learnerAcceptanceRequired: true, poolIds: [], requiredAuthorityIds: [], offerCooldownHours: 0,
      maxOutstandingOffersPerScope: 1, maxOffersPerScope: 1 };
  });
  assert.throws(() => policy.proposeExtension(s, proposal(s)), errorCode('EXTENSIONS_DISABLED'));
});

test('G05: an outage adjustment moves a deadline, never adds work, and records its batch', () => {
  const s = layered();
  const base = { scopeId: 'chapter', accommodationId: 'outage-1', reasonRef: 'incident-ref', kind: 'outage', batchId: 'batch-1' };
  assert.throws(() => policy.previewAccommodation(s, { ...base, change: { work: { additionalMinutes: 10 } } }), errorCode('OUTAGE_DEADLINE_ONLY'));
  assert.throws(() => policy.previewAccommodation(s, { ...base, change: { deadline: { kind: 'absolute', calendarDays: 1 }, work: { additionalMinutes: 10 } } }), errorCode('OUTAGE_DEADLINE_ONLY'));
  const change = { deadline: { kind: 'absolute', calendarDays: 2 } };
  const preview = policy.previewAccommodation(s, { ...base, change });
  const applied = policy.applyAccommodation(s, { ...cmd(s, 'outage'), ...base, change, previewDigest: preview.previewDigest,
    authorityReceipt: authority(s, 'accommodate', preview.previewDigest, 'chapter') });
  const entry = applied.state.accommodations[0];
  assert.deepEqual([entry.kind, entry.batchId], ['outage', 'batch-1']);
  assert.equal(policy.resolveConstraints(applied.state, 'chapter').effectiveDeadline, at(12));
  // Separate from discretionary pools: no balance moved.
  assert.deepEqual(policy.poolBalances(applied.state), policy.poolBalances(s));
  // A preview for one batch is not a preview for another.
  assert.throws(() => policy.applyAccommodation(s, { ...cmd(s, 'outage'), ...base, batchId: 'batch-2', change, previewDigest: preview.previewDigest,
    authorityReceipt: authority(s, 'accommodate', preview.previewDigest, 'chapter') }), errorCode('STALE_PREVIEW'));
});

test('G15: the continuation track permits reading and review only after an explicit opt-in on a closed enrollment', () => {
  const s = layered();
  const open = policy.checkContinuation(s, { scopeId: 'chapter', now: NOW, kind: 'review', track: { state: 'active', optedInAt: NOW } });
  assert.deepEqual(open.violations, ['ENROLLMENT_NOT_CLOSED']);
  const preview = policy.previewClosure(s, { now: NOW, reason: 'withdrawn', coveredObjectiveIds: [], demonstratedConceptIds: [] });
  const closed = policy.closeEnrollment(s, { ...cmd(s, 'close'), reason: 'withdrawn', coveredObjectiveIds: [], demonstratedConceptIds: [],
    previewDigest: preview.previewDigest, authorityReceipt: authority(s, 'close_enrollment', preview.previewDigest, 'enrollment') }).state;
  assert.equal(closed.closure.continuation, 'explicit_opt_in_separate_track');
  const check = (kind, track) => policy.checkContinuation(closed, { scopeId: 'chapter', now: NOW, kind, track });
  assert.deepEqual(check('review', null).violations, ['CONTINUATION_NOT_OPTED_IN']);
  assert.deepEqual(check('review', { state: 'stopped', optedInAt: NOW }).violations, ['CONTINUATION_NOT_OPTED_IN']);
  assert.equal(check('review', { state: 'active', optedInAt: NOW }).allowed, true);
  assert.equal(check('read', { state: 'active', optedInAt: NOW }).allowed, true);
  for (const kind of ['plan', 'admit_job', 'publish', 'submit', 'question'])
    assert.deepEqual(check(kind, { state: 'active', optedInAt: NOW }).violations, ['CONTINUATION_NO_REQUIRED_WORK'], kind);
  // Closed material stays closed on the track too.
  const sealed = structuredClone(closed);
  sealed.scopes.find(x => x.scopeId === 'organization').existingMaterialAccess = 'closed';
  assert.deepEqual(policy.checkContinuation(sealed, { scopeId: 'chapter', now: NOW, kind: 'review', track: { state: 'active', optedInAt: NOW } }).violations, ['ACCESS_CLOSED']);
});

test('G09: one grant can draw minutes and episodes from separate pools, and a shared pool is one balance for every scope it covers', () => {
  const s = layered();
  const change = { work: { additionalMinutes: 20, additionalEpisodes: 2 } };
  const preview = policy.previewExtension(s, { scopeId: 'chapter', change, addedWork: { additionalMinutes: 0, additionalEpisodes: 0 },
    poolDebits: [{ poolId: 'minutes', amount: 20 }, { poolId: 'episodes', amount: 2 }] });
  assert.deepEqual(preview.balanceAfter.map(b => [b.poolId, b.remaining]), [['episodes', 2], ['minutes', 20]]);
  // Paying minutes from the episode pool is refused: every unit has its exact pool cost.
  assert.throws(() => policy.previewExtension(s, { scopeId: 'chapter', change: { work: { additionalMinutes: 2 } }, addedWork: { additionalMinutes: 0, additionalEpisodes: 0 },
    poolDebits: [{ poolId: 'episodes', amount: 2 }] }), errorCode('DEBIT_MISMATCH'));
  const offered = policy.proposeExtension(s, proposal(s, 'shared-a', { change: { deadline: { kind: 'absolute', calendarDays: 2 } }, addedWork: { additionalMinutes: 0, additionalEpisodes: 0 } })).state;
  const accepted = policy.grantExtension(offered, { ...cmd(offered, 'grant-shared-a'), offerId: 'shared-a', grantId: 'grant-a', atomicLedgerTransactionId: 'tx-a',
    acceptance: { receiptId: 'c', learnerId: 'learner', enrollmentId: 'enrollment', offerId: 'shared-a', termsDigest: offered.offers[0].termsDigest, explicit: true, acceptedAt: NOW },
    authorityReceipts: [] }).state;
  // The sibling chapter sees the same shared balance drop.
  assert.equal(policy.poolBalances(accepted).find(b => b.poolId === 'shared-days').remaining, 2);
  const sibling = policy.previewExtension(accepted, { scopeId: 'sibling', change: { deadline: { kind: 'absolute', calendarDays: 2 } },
    addedWork: { additionalMinutes: 0, additionalEpisodes: 0 }, poolDebits: [{ poolId: 'shared-days', amount: 2 }] });
  assert.deepEqual(sibling.balanceAfter, [{ poolId: 'shared-days', remaining: 0, grantsRemaining: 0 }]);
});
