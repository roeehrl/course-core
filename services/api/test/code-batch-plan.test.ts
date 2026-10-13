import {it,expect} from 'vitest';
import {codeFixtureBatchPlan} from '../src/code-evaluator.js';
it('partitions large references without omitting a later required result',()=>{
  const cases=[0,1,2].map(i=>({id:'part-'+i,input:i,expected:'x'.repeat(20000)}));
  expect(codeFixtureBatchPlan(cases)).toEqual([1,1,1]);
  expect(codeFixtureBatchPlan([{id:'short',input:1,expected:2},{id:'next',input:2,expected:4}])).toEqual([2]);
});
it('rejects oversized individual or total reference envelopes rather than silently dropping cases',()=>{
  expect(()=>codeFixtureBatchPlan([{id:'large',input:0,expected:'x'.repeat(40000)}])).toThrow('CODE_FIXTURE_OUTPUT_ENVELOPE_EXCEEDED');
  expect(()=>codeFixtureBatchPlan([0,1,2,3].map(i=>({id:'part-'+i,input:i,expected:'x'.repeat(20000)})))).toThrow('CODE_FIXTURE_OUTPUT_ENVELOPE_EXCEEDED');
});
