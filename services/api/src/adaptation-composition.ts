import {authoredVariantBankAdapter,boundedNumericalAdapter,createAdaptationRuntime,type AdaptationRuntime} from './adaptation-store.js';

/** Operator composition installs known code, not authorizations or proof claims.
 * A release still needs an authenticated registry approval before fresh delivery. */
export function composeAdaptation(value:unknown):AdaptationRuntime{
  if(!Array.isArray(value)||value.length>2||value.some(v=>typeof v!=='string')||new Set(value).size!==value.length)throw new Error('Invalid adaptation adapter selection');
  const adapters=value.map(id=>{
    if(id==='bounded-numeric-v1')return boundedNumericalAdapter();
    if(id==='authored-bank-v1')return authoredVariantBankAdapter();
    throw new Error('Unknown trusted adaptation adapter');
  });
  return createAdaptationRuntime(adapters);
}
export function adaptationDescriptors(runtime:AdaptationRuntime){
  return runtime.adapters.map(a=>({id:a.id,implementationDigest:a.implementationDigest,kind:a.kind,authorization:'release_registry_approval_required'}));
}
