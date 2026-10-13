import {describe,it,expect} from 'vitest';
import {composeAdaptation,adaptationDescriptors} from '../src/adaptation-composition.js';
describe('trusted generic adaptation composition',()=>{
  it('defaults to no installed code and rejects arbitrary modules or duplicate selections',()=>{
    expect(composeAdaptation([]).adapters).toHaveLength(0);
    for(const value of [null,{},['unknown-plugin'],['bounded-numeric-v1','bounded-numeric-v1'],['file:untrusted.mjs']])expect(()=>composeAdaptation(value)).toThrow();
  });
  it('advertises exact generic implementations without granting any release authorization',()=>{
    const descriptors=adaptationDescriptors(composeAdaptation(['bounded-numeric-v1','authored-bank-v1']));
    expect(descriptors.map(d=>d.id)).toEqual(['bounded-numeric-v1','authored-bank-v1']);
    for(const descriptor of descriptors){expect(descriptor.implementationDigest).toMatch(/^[a-f0-9]{64}$/);expect(descriptor.authorization).toBe('release_registry_approval_required');}
  });
});
