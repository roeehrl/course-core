import {describe,it,expect} from 'vitest';
import {ProviderError,type UsageReceipt} from '@course-core/providers';
import {runSupervisorToolLoop} from '../src/supervisor-tool-loop.js';
import type {TeachingContext} from '../src/provider-runtime.js';
import {randomUUID} from 'node:crypto';
const context:TeachingContext={course:{title:'Public example',digest:'a'.repeat(64)},episode:{id:'minimum',title:'Minimum',teaching:'Compare all members.',objectives:[{id:'minimum',description:'Compare all members.'}]},learner:{profile:{},recentHistory:[]},question:'Review this example.',constraints:{deadline:null,expansionAllowed:true,independentAssessmentActive:false}};
const usage:UsageReceipt={accounting:{accountingKey:'example'},providerId:'test',modelId:'test',operation:'assess',attempts:[{attempt:1,status:200,outcome:'response',tokens:{input:10,output:5,total:15,cachedInput:0,thoughts:0,toolInput:0}}],inputCharacters:100,requestedMaxOutputTokens:100,requestedVideoSeconds:null,observedImageCount:null,observedVideoCount:null,cost:null};
const tool=(name:string,args={})=>({decision:'tool',tool:name,argumentsJson:JSON.stringify(args),summary:''}),finish={decision:'finish',tool:'none',argumentsJson:'{}',summary:'Select the reviewed support.'};
describe('bounded scoped supervisor decisions',()=>{
  it('uses actual tool receipts and keeps the selected action pending host delivery',async()=>{
    const outputs=[tool('get_history'),tool('choose_support',{profileId:'profile',entryId:'entry'}),finish],keys:string[]=[],selection={profileId:'profile',entryId:'entry',permissionRevision:1};
    const result=await runSupervisorToolLoop({context,roundLimit:4,maxInputCharacters:20000,accountingKey:'operation',signal:new AbortController().signal,tools:{async invoke(name){return {receiptId:randomUUID(),result:{available:true},...(name==='choose_support'?{selection}:{})};}},model:async req=>{keys.push(req.accountingKey);return {output:outputs.shift()!,usage};}});
    expect(result.content.selection).toEqual(selection);expect(result.content.toolCallRefs).toHaveLength(2);expect(keys).toEqual(['operation:round-0','operation:round-1','operation:round-2']);expect(result.usage.attempts.map(a=>a.attempt)).toEqual([1,2,3]);expect(result.usage.attempts.reduce((n,a)=>n+a.tokens.total!,0)).toBe(45);
  });
  it('rejects invented tool authority and cannot finish with undeclared extra commands',async()=>{
    for(const output of [{...tool('complete_course'),proof:'forged'},{...finish,grading:{passed:true}}])await expect(runSupervisorToolLoop({context,roundLimit:2,maxInputCharacters:20000,accountingKey:'op',signal:new AbortController().signal,tools:{async invoke(){throw Error('Must not invoke');}},model:async()=>({output,usage})})).rejects.toMatchObject({code:'INVALID_RESPONSE',submission:'unknown'});
  });
  it('bounds rounds and retains earlier actual usage when a later call definitely did not start',async()=>{
    let calls=0;await expect(runSupervisorToolLoop({context,roundLimit:2,maxInputCharacters:20000,accountingKey:'op',signal:new AbortController().signal,tools:{async invoke(){return {receiptId:randomUUID(),result:{available:true}};}},model:async()=>{if(calls++)throw new ProviderError('MISSING_CREDENTIAL',{submission:'not_sent'});return {output:tool('get_profile'),usage};}})).rejects.toMatchObject({submission:'unknown',usage:{attempts:[expect.objectContaining({tokens:{...usage.attempts[0]!.tokens}})]}});
  });
});
it('cannot deliver an unfinished loop or an oversized tool result and retains incurred usage',async()=>{
  for(const oversized of [false,true]){
    let calls=0;
    await expect(runSupervisorToolLoop({context,roundLimit:2,maxInputCharacters:20000,accountingKey:'bounded',signal:new AbortController().signal,tools:{async invoke(){return {receiptId:randomUUID(),result:{text:'x'.repeat(oversized?12001:10)}};}},model:async()=>{calls++;return {output:tool('get_profile'),usage};}})).rejects.toMatchObject({code:oversized?'OUTPUT_TOO_LARGE':'INVALID_RESPONSE',submission:'unknown',usage:{attempts:expect.any(Array)}});
    expect(calls).toBe(oversized?1:2);
  }
});
it('cancellation between a model response and tool dispatch cannot access another tool or finish',async()=>{
  const controller=new AbortController(),invoke=()=>{throw Error('Tool must not run after cancellation');};
  await expect(runSupervisorToolLoop({context,roundLimit:2,maxInputCharacters:20000,accountingKey:'cancelled',signal:controller.signal,tools:{invoke},model:async()=>{controller.abort();return {output:tool('get_history'),usage};}})).rejects.toMatchObject({code:'CANCELLED',submission:'unknown',usage:{attempts:[expect.anything()]}});
});
