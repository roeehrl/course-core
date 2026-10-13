import {authoredTeachingBankAdapter,authoredCodeVariantBankAdapter,authoredVariantBankAdapter,boundedNumericalAdapter,createAdaptationRuntime,type AdaptationRuntime} from './adaptation-store.js';
import type {RuntimeExtension} from './publication.js';

/** Operator composition installs known code, not authorizations or proof claims.
 * A release still needs an authenticated registry approval before fresh delivery. */
export function composeAdaptation(value:unknown,extensions:readonly RuntimeExtension[]=[]):AdaptationRuntime{
  if(!Array.isArray(value)||value.length>4||value.some(v=>typeof v!=='string')||new Set(value).size!==value.length)throw new Error('Invalid adaptation adapter selection');
  const adapters=value.map(id=>{
    if(id==='bounded-numeric-v1')return boundedNumericalAdapter();
    if(id==='authored-bank-v1')return authoredVariantBankAdapter();
    if(id==='authored-code-bank-v1')return authoredCodeVariantBankAdapter(extensions);
    if(id==='authored-teaching-bank-v1')return authoredTeachingBankAdapter();
    throw new Error('Unknown trusted adaptation adapter');
  });
  const generated=extensions.flatMap(e=>e.adaptationAdapter?[e.adaptationAdapter]:[]);
  for(const adapter of generated){const extension=extensions.find(e=>e.adaptationAdapter===adapter)!;if(adapter.kind!=='generated-teaching'||extension.integrity!==`sha256-${adapter.implementationDigest}`||!extension.capabilities.includes('teaching.verify')||!extension.capabilities.includes('teaching.generate'))throw new Error('Invalid isolated teaching adapter binding');}
  return createAdaptationRuntime([...adapters,...generated],generated.length?15000:5000);
}
export function adaptationDescriptors(runtime:AdaptationRuntime){
  return runtime.adapters.map(a=>({id:a.id,implementationDigest:a.implementationDigest,kind:a.kind,authorization:'release_registry_approval_required'}));
}
