import type {CourseManifest} from '@course-core/sdk';
import type {RuntimeExtension} from '../src/publication.js';
import {fixture} from './fixture.js';
import {authoredCodeVariantBankAdapter,createAdaptationRuntime,type AdaptationConfiguration} from '../src/adaptation-store.js';

/** Public domain-neutral tasks. Hidden outputs remain in the host fixture registry. */
export const comparisonFixtures={schemaVersion:1,id:'public-comparison-code',version:'0.1.0',fixtures:[
  {id:'minimum-json',language:'python',cases:[
    {id:'negative',input:[-3,-8],expected:-8},{id:'positive',input:[4,1],expected:1},
    {id:'zero',input:[0,3],expected:0},{id:'reversed',input:[9,2],expected:2},
  ]},
  {id:'minimum-index',language:'python',cases:[
    {id:'negative',input:[-3,-8],expected:1},{id:'duplicate',input:[2,1,1],expected:1},
    {id:'singleton',input:[0],expected:0},{id:'first',input:[-8,9,4],expected:0},
  ]},
  {id:'minimum-count',language:'python',cases:[
    {id:'negative',input:[-3,-8],expected:{minimum:-8,count:1}},
    {id:'duplicate',input:[2,1,1],expected:{minimum:1,count:2}},
    {id:'singleton',input:[0],expected:{minimum:0,count:1}},
    {id:'all-equal',input:[4,4,4],expected:{minimum:4,count:3}},
  ]},
]};

export function codeRecoveryFixture(registry:RuntimeExtension){
  const course=fixture(),adapter=authoredCodeVariantBankAdapter([registry]),runtime=createAdaptationRuntime([adapter]);
  course.policy.work={additionalMinutes:8,additionalEpisodes:4,remediationCyclesPerConcept:4};
  course.extensions.push({id:registry.id,version:registry.version,integrity:registry.integrity,execution:'server',entrypoint:'fixtures/comparison.json',platforms:['web'],capabilities:['assessment.evaluate'],accessibility:{keyboard:true,reducedMotion:true,textAlternative:'Submit a Python comparison function.'}});
  const canonical:Extract<CourseManifest['assessments'][number],{type:'code'}>={id:'min-code',type:'code',familyId:'implementation',objectiveIds:['minimum'],language:'python',starterCode:'def solve(values):\n    pass\n',prompt:'Implement solve(values), returning the minimum of a nonempty number list.',grading:{evaluatorId:registry.id,fixtureRef:'minimum-json'}};
  course.assessments.push(canonical);course.gates[0]!.assessmentIds.push(canonical.id);course.gates[0]!.minimumIndependentFamilies=3;
  const source='reviewed-comparison-tasks',extensionId='comparison-recovery-creator';
  course.sources.push({id:source,title:'Reviewed public comparison contracts',url:'urn:example:comparison-recovery',reviewedAt:'2026-01-01T00:00:00Z'});
  course.extensions.push({id:extensionId,version:'1.0.0',integrity:`sha256-${adapter.implementationDigest}`,execution:'server',entrypoint:'extensions/authored-code-bank-v1.js',platforms:['web'],capabilities:['teaching.generate','teaching.verify'],accessibility:{keyboard:true,reducedMotion:true,textAlternative:'Reviewed alternative code contracts.'}});
  course.adaptation={schemaVersion:1,sourceRefs:[source],profileFieldIds:[],targets:[{episodeId:'min',objectiveIds:['minimum'],allowedOperations:['add_assessment_variant'],replaceableBlockIds:[]}],
    families:[{familyId:canonical.familyId,canonicalAssessmentId:canonical.id,generatorIds:['code-bank-generator'],verifierIds:['code-bank-verifier'],numericalRecipeIds:[],maxVariantsPerPlan:2}],
    generators:[{id:'code-bank-generator',version:'1.0.0',extensionId,sourceRefs:[source],artifactKinds:['assessment_variant']}],
    verifiers:[{id:'code-bank-verifier',version:'1.0.0',extensionId,sourceRefs:[source],artifactKinds:['assessment_variant'],requiredCheckIds:['authored-bank-match']}],numericalRecipes:[],
    limits:{maxOperations:1,maxArtifacts:1,maxArtifactBytes:10000,maxPlannedMinutesPerAssignment:5,maxAdditionalEpisodesPerAssignment:1,allowedClassifications:['required']}};
  const config:AdaptationConfiguration={authorizationMinutes:30,verifiers:[{id:'code-bank-verifier',version:'1.0.0',implementationDigest:adapter.implementationDigest,sourceRefs:[source],artifactKinds:['assessment_variant'],checkIds:['authored-bank-match']}],profiles:[
    {id:'code-bank-profile',episodeId:'min',operation:'add_assessment_variant',generatorId:'code-bank-generator',verifierId:'code-bank-verifier',adapterId:adapter.id,adapterDigest:adapter.implementationDigest,canonicalAssessmentId:canonical.id,classification:'required',plannedMinutes:2,additionalEpisodes:1,
      bank:[
        {id:'index-task',sourceRefs:[source],assessment:{...structuredClone(canonical),id:'min-code-index',prompt:'Implement solve(values), returning the zero-based index of the first minimum in a nonempty list. Ties select the first position.',grading:{evaluatorId:registry.id,fixtureRef:'minimum-index'}}},
        {id:'count-task',sourceRefs:[source],assessment:{...structuredClone(canonical),id:'min-code-count',prompt:'Implement solve(values), returning {"minimum": the minimum, "count": its number of occurrences} for a nonempty list.',grading:{evaluatorId:registry.id,fixtureRef:'minimum-count'}}},
      ]},
  ]};
  return {course,adapter,runtime,config};
}
