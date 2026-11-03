import {describe,it,expect,vi} from 'vitest';
import type {RuntimeExtension} from '../src/publication.js';
import {ApiError} from '../src/errors.js';
import {authoredCodeVariantBankAdapter,checkAdaptationConfiguration,createAdaptationRuntime,withInstalledExtensions,withProspectiveExtensions} from '../src/adaptation-store.js';
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
    const {validateCodeAssessment:_,...withoutValidator}=registry;
    const cases:RuntimeExtension[][]=[[],[{...registry,codeReady:false}],[{...registry,integrity:'sha256-'+'b'.repeat(64)}],[{...registry,version:'0.2.0'}],[withoutValidator],[{...registry,capabilities:[]}],[{...registry,platforms:['ios']}]];
    for(const extensions of cases){
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
  it('checks a registry as it will be once course-supplied graders are installed, without changing the runtime',()=>{
    const registry=installed(),f=codeRecoveryFixture(registry),host:RuntimeExtension[]=[];
    const runtime=withInstalledExtensions(createAdaptationRuntime([authoredCodeVariantBankAdapter(host)]),host);
    expect(checkAdaptationConfiguration(f.course,f.config,runtime)).toEqual({valid:false,code:'EVALUATOR_NOT_CONFIGURED'});
    const prospective=withProspectiveExtensions(runtime,host,[registry]);
    expect(checkAdaptationConfiguration(f.course,f.config,prospective)).toEqual({valid:true,profiles:1});
    // Same reviewed code, so the same digest an approved registry pins; the host's runtime is untouched.
    expect(prospective.adapters[0]!.implementationDigest).toBe(runtime.adapters[0]!.implementationDigest);
    expect(prospective.installed).toEqual([registry]);
    expect(host).toEqual([]);
    expect(checkAdaptationConfiguration(f.course,f.config,runtime)).toEqual({valid:false,code:'EVALUATOR_NOT_CONFIGURED'});
    expect(withProspectiveExtensions(runtime,host,[])).toBe(runtime);
    // A grader that would not qualify still refuses.
    expect(checkAdaptationConfiguration(f.course,f.config,withProspectiveExtensions(runtime,host,[{...registry,codeReady:false}]))).toEqual({valid:false,code:'EVALUATOR_NOT_CONFIGURED'});
    expect(registry.evaluateCode).not.toHaveBeenCalled();
  });
  it('sees extensions added to the live installed list later, as an approved install adds them',()=>{
    const registry=installed(),f=codeRecoveryFixture(registry),host:RuntimeExtension[]=[];
    const runtime=withInstalledExtensions(createAdaptationRuntime([authoredCodeVariantBankAdapter(host)]),host);
    host.push(registry);
    expect(runtime.installed).toContain(registry);
    expect(checkAdaptationConfiguration(f.course,f.config,runtime)).toEqual({valid:true,profiles:1});
  });
});
