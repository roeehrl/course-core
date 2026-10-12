import {checkAction,poolBalances,type PolicyState,type ConstraintSnapshot} from '@course-core/policy';

export interface TeachingPolicyView {
  authority:'server_resolved_policy_not_model_permission';
  evaluatedAt:string;scopeId:string;policyRevision:number;ledgerRevision:number;
  ancestorScopeIds:string[];existingMaterialAccess:'read_only'|'closed';
  deadlines:ConstraintSnapshot['deadlines'];bindingDeadlines:ConstraintSnapshot['bindingDeadlines'];
  quotas:ConstraintSnapshot['quotas'];omittedOtherConceptQuotas:number;
  scopes:{scopeId:string;kind:string;mode:'bounded'|'open_ended';targetDate:string|null}[];
  extensions:{scopeId:string;enabled:boolean;learnerAcceptanceRequired:true;
    cooldownHours:number;maxOutstandingOffers:number;outstandingOffers:number;
    maxOffers:number;offersMade:number;requiredAuthorityIds:string[];
    pools:{poolId:string;unit:string;remaining:number;grantsRemaining:number;maxPerGrant:number}[]}[];
  minimumExpansionProbe:{additionalMinutes:1;additionalEpisodes:1;remediation:never[];allowed:boolean;violations:{code:string;scopeId:string}[]};
  extensionConsent:'a_suggestion_is_not_consent_or_a_grant';
}
/** A bounded projection for the current teaching scope. Omitted concept counters
 * are explicitly identified; a proposal for another concept/scope needs its own
 * server resolution. All deadlines and global work caps on this ancestor path
 * remain present. No receipts, actor credentials or another learner's state. */
export function teachingPolicyView(state:PolicyState,episodeId:string,objectiveIds:readonly string[],now:string):TeachingPolicyView{
  const scopeId=`episode:${episodeId}`,decision=checkAction(state,{scopeId,now,kind:'publish',expectedPolicyRevision:state.policyRevision,
    work:{additionalEpisodes:1,additionalMinutes:1,remediation:[]}});
  const snapshot=decision.snapshot,path=new Set(snapshot.ancestorScopeIds),concepts=new Set(objectiveIds);
  const quotas=snapshot.quotas.filter(q=>q.conceptId===null||concepts.has(q.conceptId));
  const balances=new Map(poolBalances(state).map(p=>[p.poolId,p]));
  return {
    authority:'server_resolved_policy_not_model_permission',evaluatedAt:now,scopeId,policyRevision:snapshot.policyRevision,ledgerRevision:snapshot.ledgerRevision,
    ancestorScopeIds:[...snapshot.ancestorScopeIds],existingMaterialAccess:snapshot.existingMaterialAccess,
    deadlines:structuredClone(snapshot.deadlines),bindingDeadlines:structuredClone(snapshot.bindingDeadlines),quotas:structuredClone(quotas),
    omittedOtherConceptQuotas:snapshot.quotas.length-quotas.length,
    scopes:state.scopes.filter(s=>path.has(s.scopeId)).map(s=>({scopeId:s.scopeId,kind:s.kind,mode:s.mode,targetDate:s.targetDate??null})),
    extensions:state.scopes.filter(s=>path.has(s.scopeId)&&s.extensions).map(s=>{
      const e=s.extensions!,offers=state.offers.filter(o=>o.terms.scopeId===s.scopeId);
      return {scopeId:s.scopeId,enabled:e.enabled,learnerAcceptanceRequired:true as const,cooldownHours:e.offerCooldownHours,
        maxOutstandingOffers:e.maxOutstandingOffersPerScope,outstandingOffers:offers.filter(o=>o.state==='proposed'||o.state==='accepted_pending_admin').length,
        maxOffers:e.maxOffersPerScope,offersMade:offers.length,requiredAuthorityIds:[...e.requiredAuthorityIds],
        pools:e.poolIds.map(id=>{const pool=state.pools.find(p=>p.poolId===id)!,balance=balances.get(id)!;
          return {poolId:id,unit:pool.unit,remaining:balance.remaining,grantsRemaining:balance.grantsRemaining,maxPerGrant:pool.maxPerGrant};})};
    }),
    minimumExpansionProbe:{additionalMinutes:1,additionalEpisodes:1,remediation:[],allowed:decision.allowed,
      violations:decision.violations.map(v=>({code:v.code,scopeId:v.scopeId}))},
    extensionConsent:'a_suggestion_is_not_consent_or_a_grant',
  };
}
