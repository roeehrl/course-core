import {ProviderError,type OutputSchema,type Json,type UsageReceipt} from '@course-core/providers';
import {z} from 'zod';
import type {TeachingContext} from './provider-runtime.js';

export const supervisorToolDecisionSchema:OutputSchema={type:'object',required:['decision','tool','argumentsJson','summary'],properties:{decision:{type:'string',enum:['tool','finish']},tool:{type:'string',enum:['get_history','get_profile','get_evidence','list_sources','list_support','choose_support','none']},argumentsJson:{type:'string'},summary:{type:'string'}}};
const decisionSchema=z.strictObject({decision:z.enum(['tool','finish']),tool:z.enum(['get_history','get_profile','get_evidence','list_sources','list_support','choose_support','none']),argumentsJson:z.string().max(5000),summary:z.string().max(16000)});
export interface SupportSelection{profileId:string;entryId:string;permissionRevision:number}
export interface SupervisorToolPort{invoke(name:string,args:unknown,step:number):Promise<{receiptId:string;result:Json;selection?:SupportSelection}>}
export interface SupervisedPlan{kind:'supervised_plan';summary:string;selection:SupportSelection|null;toolCallRefs:string[]}
export const supervisedPlanSchema=z.strictObject({kind:z.literal('supervised_plan'),summary:z.string().min(1).max(16000),selection:z.strictObject({profileId:z.string().regex(/^[a-z][a-z0-9._:-]{0,127}$/),entryId:z.string().regex(/^[a-z][a-z0-9._:-]{0,127}$/),permissionRevision:z.number().int().positive()}).nullable(),toolCallRefs:z.array(z.string().uuid()).max(8)});
export async function runSupervisorToolLoop(options:{context:TeachingContext;roundLimit:number;maxInputCharacters:number;accountingKey:string;signal:AbortSignal;tools:SupervisorToolPort;model:(input:{prompt:string;accountingKey:string;outputSchema:OutputSchema},signal:AbortSignal)=>Promise<{output:Json;usage:UsageReceipt}>}){
  const receipts:UsageReceipt[]=[],toolCallRefs:string[]=[],trace:{tool:string;result:Json}[]=[];let selected:SupportSelection|null=null;
  try{
    for(let step=0;step<options.roundLimit;step++){
      if(options.signal.aborted)throw new ProviderError('CANCELLED',{submission:receipts.length?'unknown':'not_sent'});
      const encode=()=>JSON.stringify({context:options.context,toolResults:trace,earlierToolResultsRetainedInReceipts:toolCallRefs.length-trace.length,instructions:{availableTools:['get_history','get_profile','get_evidence','list_sources','list_support','choose_support'],delivery:'Choose only a supplied author-reviewed support profile. A selected item is pending until host verification/application. Finish explicitly. No tool can grant credit, change goals, policy or paid ceilings.'}});
      while(encode().length>options.maxInputCharacters&&trace.length)trace.shift();const prompt=encode();
      if(prompt.length>options.maxInputCharacters)throw new ProviderError('INVALID_INPUT',{submission:receipts.length?'unknown':'not_sent'});
      const response=await options.model({prompt,accountingKey:options.accountingKey+':round-'+step,outputSchema:supervisorToolDecisionSchema},options.signal);receipts.push(response.usage);
      if(options.signal.aborted)throw new ProviderError('CANCELLED',{submission:'unknown'});
      const parsed=decisionSchema.safeParse(response.output);if(!parsed.success)throw new ProviderError('INVALID_RESPONSE',{submission:'unknown'});const d=parsed.data;
      if(d.decision==='finish'){
        if(d.tool!=='none'||d.argumentsJson!=='{}'||!d.summary.trim())throw new ProviderError('INVALID_RESPONSE',{submission:'unknown'});
        return {content:{kind:'supervised_plan',summary:d.summary,selection:selected,toolCallRefs} satisfies SupervisedPlan,usage:aggregateSupervisorUsage(receipts,options.accountingKey)};
      }
      if(d.tool==='none')throw new ProviderError('INVALID_RESPONSE',{submission:'unknown'});
      let args:unknown;try{args=JSON.parse(d.argumentsJson);}catch{throw new ProviderError('INVALID_RESPONSE',{submission:'unknown'});}
      const called=await options.tools.invoke(d.tool,args,step);toolCallRefs.push(called.receiptId);if(called.selection)selected=called.selection;
      if(JSON.stringify(called.result).length>12000)throw new ProviderError('OUTPUT_TOO_LARGE',{submission:'unknown'});trace.push({tool:d.tool,result:called.result});
    }
    throw new ProviderError('INVALID_RESPONSE',{submission:'unknown'});
  }catch(error){
    const original=error instanceof ProviderError?error:undefined,failure=new ProviderError(original?.code??'INVALID_RESPONSE',{submission:receipts.length?'unknown':original?.submission??'not_sent'});
    if(receipts.length){if(original?.usage)receipts.push(original.usage);failure.usage=aggregateSupervisorUsage(receipts,options.accountingKey);}else if(original?.usage)failure.usage=original.usage;throw failure;
  }
}
export function aggregateSupervisorUsage(receipts:UsageReceipt[],accountingKey:string):UsageReceipt{
  if(!receipts.length)throw new ProviderError('INVALID_RESPONSE');const first=receipts[0]!;
  if(receipts.some(r=>r.modelId!==first.modelId||r.providerId!==first.providerId))throw new ProviderError('INVALID_RESPONSE',{submission:'unknown'});
  let ordinal=0;return {...structuredClone(first),accounting:{accountingKey},attempts:receipts.flatMap(r=>r.attempts.map(a=>({...structuredClone(a),attempt:++ordinal}))),inputCharacters:receipts.reduce((n,r)=>n+r.inputCharacters,0),requestedMaxOutputTokens:receipts.every(r=>r.requestedMaxOutputTokens!==null)?receipts.reduce((n,r)=>n+r.requestedMaxOutputTokens!,0):null,cost:null};
}
