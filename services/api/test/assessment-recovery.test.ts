import {it,expect} from 'vitest';
import {assessmentRecovery} from '../src/assessment-recovery.js';
import {fixture} from './fixture.js';
it('uses existing unexposed checks before suggesting generation and never exposes a bank prompt or key',()=>{
  const c=fixture(),approved=[{episodeId:'min',objectiveIds:['minimum'],familyId:'compare',plannedMinutes:2,additionalEpisodes:1}];
  expect(assessmentRecovery(c,'digest',[],[],['min-a'],approved)).toEqual([]);
  const result=assessmentRecovery(c,'digest',[],[],['min-a','min-b'],approved);
  expect(result).toEqual([{episodeId:'min',required:true,freshCheck:{objectiveId:'minimum',familyId:'compare',plannedMinutes:2,additionalEpisodes:1}}]);
  expect(JSON.stringify(result)).not.toMatch(/grading|correctOptionId|Which is smaller/);
});
it('reports unavailable recovery honestly and does not offer an already earned canonical family',()=>{
  const c=fixture(),evidence=[{id:'proof',objective_id:'minimum',family_id:'compare',assessment_id:'min-a',independent:true,course_digest:'digest',result:{passed:true}}];
  const approved=[{episodeId:'min',objectiveIds:['minimum'],familyId:'compare',plannedMinutes:2,additionalEpisodes:1}];
  expect(assessmentRecovery(c,'digest',[],evidence,['min-a','min-b'],approved)[0]!.freshCheck).toBeNull();
  expect(assessmentRecovery(c,'digest',[],[],['min-a','min-b'],[])[0]!.freshCheck).toBeNull();
});
