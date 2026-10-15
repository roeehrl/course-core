import {describe,it,expect} from 'vitest';
import {reserveWork,commitWork,cancelReservation,proposeExtension,grantExtension,type PolicyState} from '@course-core/policy';
import {teachingPolicyView} from '../src/teaching-constraints.js';
import {initialPolicy} from '../src/policy-adapter.js';
import {fixture} from './fixture.js';
const now='2026-01-01T00:00:00Z';
const command=(s:PolicyState,key:string)=>({expectedPolicyRevision:s.policyRevision,expectedLedgerRevision:s.ledgerRevision,idempotencyKey:key,now});
function state(){const c=fixture();c.policy={mode:'bounded',hardDeadline:'2026-01-30T00:00:00Z',work:{additionalMinutes:50,additionalEpisodes:8,remediationCyclesPerConcept:3},existingMaterialAccess:'read_only',extensions:{enabled:true,calendarDays:12,maxGrants:3,maxDaysPerGrant:4,learnerAcceptanceRequired:true}};
  c.chapters[0]!.policy={mode:'bounded',hardDeadline:'2026-01-10T00:00:00Z',work:{additionalMinutes:15,additionalEpisodes:4,remediationCyclesPerConcept:2},existingMaterialAccess:'read_only'};
  c.chapters[0]!.episodes[0]!.policy={mode:'bounded',hardDeadline:'2026-01-08T00:00:00Z',targetDate:'2026-01-03T00:00:00Z',work:{additionalMinutes:6,additionalEpisodes:3,remediationCyclesPerConcept:2},existingMaterialAccess:'read_only'};
  return initialPolicy(c,'enrollment','learner',now);
}
describe('authoritative teaching constraint projection',()=>{
  it('reports parent/sibling costs and current lesson costs from actual reservations and commits',()=>{
    let s=state();s=reserveWork(s,{...command(s,'reserve-local'),reservationId:'local',scopeId:'episode:min',work:{additionalMinutes:4,additionalEpisodes:1,remediation:[{conceptId:'minimum',cycles:1}]}}).state;
    s=commitWork(s,{...command(s,'commit-local'),reservationId:'local',workId:'published-example'}).state;
    s=reserveWork(s,{...command(s,'reserve-sibling'),reservationId:'sibling',scopeId:'episode:max',work:{additionalMinutes:3,additionalEpisodes:2,remediation:[{conceptId:'maximum',cycles:1}]}}).state;
    const view=teachingPolicyView(s,'min',['minimum'],now);
    expect(view.quotas.find(q=>q.scopeId==='course'&&q.metric==='additionalMinutes')).toMatchObject({limit:50,consumed:4,reserved:3,remaining:43});
    expect(view.quotas.find(q=>q.scopeId==='chapter:order'&&q.metric==='additionalMinutes')).toMatchObject({limit:15,consumed:4,reserved:3,remaining:8});
    expect(view.quotas.find(q=>q.scopeId==='episode:min'&&q.metric==='additionalMinutes')).toMatchObject({limit:6,consumed:4,reserved:0,remaining:2});
    expect(view.quotas.some(q=>q.conceptId==='maximum')).toBe(false);expect(view.omittedOtherConceptQuotas).toBeGreaterThan(0);expect(view.ledgerRevision).toBe(3);
    s=cancelReservation(s,{...command(s,'cancel-sibling'),reservationId:'sibling'}).state;
    expect(teachingPolicyView(s,'min',['minimum'],now).quotas.find(q=>q.scopeId==='course'&&q.metric==='additionalMinutes')!.remaining).toBe(46);
  });
  it('keeps suggested dates distinct from binding deadlines and denies expansion after the earliest cap',()=>{
    const s=state(),v=teachingPolicyView(s,'min',['minimum'],now);
    expect(v.bindingDeadlines).toEqual([{scopeId:'episode:min',kind:'absolute',at:'2026-01-08T00:00:00Z'}]);
    expect(v.scopes.find(s=>s.scopeId==='episode:min')!.targetDate).toBe('2026-01-03T00:00:00Z');
    expect(teachingPolicyView(s,'min',['minimum'],'2026-01-09T00:00:00Z').minimumExpansionProbe).toMatchObject({allowed:false,violations:expect.arrayContaining([expect.objectContaining({code:'DEADLINE_REACHED'})])});
  });
  it('does not treat a feasible minimum probe as permission for arbitrary additional work',()=>{
    const s=state(),v=teachingPolicyView(s,'min',['minimum'],now);expect(v.minimumExpansionProbe.allowed).toBe(true);expect(v.authority).toBe('server_resolved_policy_not_model_permission');
    expect(()=>reserveWork(s,{...command(s,'too-large'),reservationId:'large',scopeId:'episode:min',work:{additionalMinutes:7,additionalEpisodes:1,remediation:[]}})).toThrow();
    expect(v.quotas.find(q=>q.scopeId==='episode:min'&&q.metric==='additionalMinutes')!.remaining).toBe(6);
  });
  it('a suggestion consumes nothing; explicit grant changes balances and grant count without hiding child bounds',()=>{
    let s=state();const initial=teachingPolicyView(s,'min',['minimum'],now);
    expect(initial.extensions[0]!.pools[0]).toMatchObject({remaining:12,grantsRemaining:3,maxPerGrant:4});
    s=proposeExtension(s,{...command(s,'suggest'),offerId:'offer',scopeId:'course',change:{deadline:{kind:'absolute',calendarDays:2}},addedWork:{additionalMinutes:0,additionalEpisodes:0,remediation:[]},poolDebits:[{poolId:'course:calendar',amount:2}],rationaleEvidenceRefs:['current-scope-gap'],proposedActivities:['existing-topic-review'],planImpact:'Make room for review within a later course deadline.',alternatives:['Continue within current limits.'],expiresAt:'2026-01-02T00:00:00Z'}).state;
    let view=teachingPolicyView(s,'min',['minimum'],now);expect(view.extensions[0]!.outstandingOffers).toBe(1);expect(view.extensions[0]!.pools[0]!.remaining).toBe(12);
    const offer=s.offers[0]!;s=grantExtension(s,{...command(s,'grant'),offerId:'offer',grantId:'grant',atomicLedgerTransactionId:'transaction',acceptance:{receiptId:'consent',learnerId:'learner',enrollmentId:'enrollment',offerId:'offer',termsDigest:offer.termsDigest,explicit:true,acceptedAt:now},authorityReceipts:[]}).state;
    view=teachingPolicyView(s,'min',['minimum'],now);expect(view.extensions[0]!.pools[0]).toMatchObject({remaining:10,grantsRemaining:2});expect(view.extensions[0]!.outstandingOffers).toBe(0);
    expect(view.bindingDeadlines[0]!.scopeId).toBe('episode:min');expect(view.extensionConsent).toBe('a_suggestion_is_not_consent_or_a_grant');expect(view.policyRevision).toBe(2);
  });
  it('projections cannot mutate the authoritative ledger and carry no offer/receipt history',()=>{
    const s=state(),before=JSON.stringify(s),v=teachingPolicyView(s,'min',['minimum'],now);v.quotas[0]!.remaining=999;v.deadlines[0]!.at='2099-01-01T00:00:00Z';v.extensions[0]!.pools[0]!.remaining=999;
    expect(JSON.stringify(s)).toBe(before);expect(v).not.toHaveProperty('offers');expect(v).not.toHaveProperty('receipts');expect(()=>teachingPolicyView(s,'foreign',['minimum'],now)).toThrow();
  });
});
