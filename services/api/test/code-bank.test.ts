import {describe,it,expect,vi} from 'vitest';
import type {RuntimeExtension} from '../src/publication.js';
import {ApiError} from '../src/errors.js';
import {authoredCodeVariantBankAdapter} from '../src/adaptation-store.js';
import {codeRecoveryFixture} from './code-recovery-fixture.js';

// These only test preflight boundaries. Real grading is required separately by
// qualification/practical-flow.ts; a stub cannot establish execution correctness.
function installed():RuntimeExtension{return {id:'public-comparison-code',version:'0.1.0',integrity:'sha256-'+'a'.repeat(64),capabilities:['assessment.evaluate'],platforms:['web'],codeReady:true,
  validateCodeAssessment(assessment){if(assessment.type!=='code'||!['minimum-json','minimum-index','minimum-count'].includes(assessment.grading.fixtureRef))throw new ApiError(409,'CODE_FIXTURE_NOT_FOUND');},
  evaluateCode:vi.fn().mockRejectedValue(new Error('Preflight must not execute learner code'))};}
describe('reviewed code-bank boundary',()=>{
  it('validates registered fixtures without running code or granting authorization',()=>{
    const registry=installed(),f=codeRecoveryFixture(registry);f.adapter.validateProfile!(f.course,f.config.profiles[0]!);
    expect(registry.evaluateCode).not.toHaveBeenCalled();
    expect(authoredCodeVariantBankAdapter([]).implementationDigest).toBe(f.adapter.implementationDigest);
  });
  it('rejects missing, unready, mismatched or unqualified graders',()=>{
    const registry=installed(),f=codeRecoveryFixture(registry),profile=f.config.profiles[0]!;
    for(const extensions of [[],[{...registry,codeReady:false}],[{...registry,integrity:'sha256-'+'b'.repeat(64)}],[{...registry,version:'0.2.0'}],[{...registry,validateCodeAssessment:undefined}],[{...registry,capabilities:[]}],[{...registry,platforms:['ios']}]]){
      expect(()=>authoredCodeVariantBankAdapter(extensions).validateProfile!(f.course,profile)).toThrow('EVALUATOR_NOT_CONFIGURED');
    }
    const wrong=structuredClone(profile);(wrong.bank![0]!.assessment as {grading:{fixtureRef:string}}).grading.fixtureRef='not-installed';
    expect(()=>f.adapter.validateProfile!(f.course,wrong)).toThrow('CODE_FIXTURE_NOT_FOUND');
  });
  it('rejects embedded fixtures and evaluator/language substitution',()=>{
    const f=codeRecoveryFixture(installed());
    for(const modify of [(p:typeof f.config.profiles[number])=>{p.bank![0]!.hiddenFixtures={expected:123};},
      (p:typeof f.config.profiles[number])=>{(p.bank![0]!.assessment as {grading:{evaluatorId:string}}).grading.evaluatorId='arbitrary-code';},
      (p:typeof f.config.profiles[number])=>{(p.bank![0]!.assessment as {language:string}).language='javascript';}]){
      const wrong=structuredClone(f.config.profiles[0]!);modify(wrong);expect(()=>f.adapter.validateProfile!(f.course,wrong)).toThrow('CODE_BANK_PROFILE_INVALID');
    }
  });
});
