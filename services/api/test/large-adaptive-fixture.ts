import type { CourseManifest } from '@course-core/sdk';
import type { AdaptationConfiguration, TrustedAdaptationAdapter } from '../src/adaptation-store.js';
import { largeCourse } from './large-course-fixture.js';

/** Public synthetic adapters for the large adaptive course. */
export interface LargeAdapters { numeric: TrustedAdaptationAdapter; bank: TrustedAdaptationAdapter; teaching: TrustedAdaptationAdapter }

/** A public synthetic course of about 2 MB with `visuals` visual blocks and an author adaptation
 * declaration for numeric, authored-bank and reviewed-teaching recovery, shaped like a large
 * real course with many reviewed recovery profiles. */
export function largeAdaptiveCourse(id: string, renderer: { version: string; integrity: string }, adapters: LargeAdapters, visuals = 39): CourseManifest {
  const course = largeCourse(id, renderer, visuals);
  course.policy.work = { additionalMinutes: 400, additionalEpisodes: 100, remediationCyclesPerConcept: 100 };
  const extension = (extensionId: string, digest: string) => ({ id: extensionId, version: '1.0.0', platforms: ['web' as const], execution: 'server' as const,
    capabilities: ['teaching.generate', 'teaching.verify'], entrypoint: `extensions/${extensionId}.js`, integrity: `sha256-${digest}`,
    accessibility: { keyboard: true, reducedMotion: true, textAlternative: 'Reviewed public recovery material.' } });
  course.extensions.push(extension('numeric-extension', adapters.numeric.implementationDigest), extension('bank-extension', adapters.bank.implementationDigest),
    extension('teaching-extension', adapters.teaching.implementationDigest));
  course.sources.push(...['teaching', 'reference'].map(source => ({ id: source, title: 'Public synthetic author reference', url: `urn:example:${source}`, reviewedAt: '2026-01-01T00:00:00Z' })));
  course.adaptation = { schemaVersion: 1, sourceRefs: ['teaching', 'reference'], profileFieldIds: [],
    targets: [{ episodeId: 'min', objectiveIds: ['minimum'], allowedOperations: ['add_assessment_variant', 'append_teaching'], replaceableBlockIds: [] },
      { episodeId: 'max', objectiveIds: ['maximum'], allowedOperations: ['append_teaching'], replaceableBlockIds: [] }],
    families: [{ familyId: 'select', canonicalAssessmentId: 'min-b', generatorIds: ['numeric-creator'], verifierIds: ['numeric-checker'], numericalRecipeIds: ['recipe'], maxVariantsPerPlan: 50 },
      { familyId: 'compare', canonicalAssessmentId: 'min-a', generatorIds: ['bank-creator'], verifierIds: ['bank-checker'], numericalRecipeIds: [], maxVariantsPerPlan: 50 }],
    generators: [{ id: 'numeric-creator', version: '1.0.0', extensionId: 'numeric-extension', sourceRefs: ['teaching'], artifactKinds: ['assessment_variant'] },
      { id: 'bank-creator', version: '1.0.0', extensionId: 'bank-extension', sourceRefs: ['teaching'], artifactKinds: ['assessment_variant'] },
      { id: 'teaching-creator', version: '1.0.0', extensionId: 'teaching-extension', sourceRefs: ['teaching'], artifactKinds: ['explanation'] }],
    verifiers: [{ id: 'numeric-checker', version: '1.0.0', extensionId: 'numeric-extension', sourceRefs: ['reference'], artifactKinds: ['assessment_variant'], requiredCheckIds: ['reference'] },
      { id: 'bank-checker', version: '1.0.0', extensionId: 'bank-extension', sourceRefs: ['reference'], artifactKinds: ['assessment_variant'], requiredCheckIds: ['authored-bank-match'] },
      { id: 'teaching-checker', version: '1.0.0', extensionId: 'teaching-extension', sourceRefs: ['teaching'], artifactKinds: ['explanation'], requiredCheckIds: ['reviewed-teaching-match'] }],
    numericalRecipes: [{ id: 'recipe', version: '1.0.0', sourceRefs: ['teaching'], promptTemplate: 'Choose the smaller of {{a}} and {{b}}.',
      variables: [{ name: 'a', minimum: 1, maximum: 50, integer: true }, { name: 'b', minimum: 51, maximum: 100, integer: true }],
      expression: { type: 'binary', operator: 'min', left: { type: 'variable', name: 'a' }, right: { type: 'variable', name: 'b' } }, maxNodes: 3, maxDepth: 2, maxAbsoluteValue: 1000,
      referenceCheck: { verifierId: 'numeric-checker', verifierVersion: '1.0.0', checkId: 'reference', absoluteTolerance: 0 } }],
    limits: { maxOperations: 5, maxArtifacts: 5, maxArtifactBytes: 30000, maxPlannedMinutesPerAssignment: 5, maxAdditionalEpisodesPerAssignment: 1, allowedClassifications: ['required', 'optional'] } };
  return course;
}

/** A reviewed registry with `profiles` recovery profiles split across numeric, authored-bank and
 * reviewed-teaching adapters. Bank and teaching profiles carry their own reviewed entries. */
export function largeAdaptiveRegistry(adapters: LargeAdapters, profiles = 158): AdaptationConfiguration {
  const verifier = (id: string, digest: string, kinds: ('assessment_variant' | 'explanation')[], check: string, source: string) =>
    ({ id, version: '1.0.0', implementationDigest: digest, sourceRefs: [source], artifactKinds: kinds, checkIds: [check] });
  const common = { classification: 'required' as const, plannedMinutes: 2, additionalEpisodes: 1 };
  return { authorizationMinutes: 10,
    verifiers: [verifier('numeric-checker', adapters.numeric.implementationDigest, ['assessment_variant'], 'reference', 'reference'),
      verifier('bank-checker', adapters.bank.implementationDigest, ['assessment_variant'], 'authored-bank-match', 'reference'),
      verifier('teaching-checker', adapters.teaching.implementationDigest, ['explanation'], 'reviewed-teaching-match', 'teaching')],
    profiles: Array.from({ length: profiles }, (_, i) => {
      if (i % 3 === 0) return { ...common, id: `numeric-${i}`, episodeId: 'min', operation: 'add_assessment_variant' as const, generatorId: 'numeric-creator', verifierId: 'numeric-checker',
        adapterId: adapters.numeric.id, adapterDigest: adapters.numeric.implementationDigest, canonicalAssessmentId: 'min-b', templateId: 'recipe' };
      if (i % 3 === 1) return { ...common, id: `bank-${i}`, episodeId: 'min', operation: 'add_assessment_variant' as const, generatorId: 'bank-creator', verifierId: 'bank-checker',
        adapterId: adapters.bank.id, adapterDigest: adapters.bank.implementationDigest, canonicalAssessmentId: 'min-a',
        bank: [0, 1, 2, 3].map(n => ({ id: `entry-${i}-${n}`, sourceRefs: ['teaching'], assessment: { id: `authored-${i}-${n}`, type: 'choice' as const, objectiveIds: ['minimum'],
          familyId: 'compare', prompt: `Which is smaller, ${i + n} or ${i + n + 5}?`, options: [{ id: 'smaller', text: String(i + n) }, { id: 'larger', text: String(i + n + 5) }],
          grading: { correctOptionId: 'smaller', explanation: 'The first quantity is smaller.' } } })) };
      const episodeId = i % 2 ? 'min' : 'max', objective = episodeId === 'min' ? 'minimum' : 'maximum';
      return { ...common, id: `teaching-${i}`, episodeId, operation: 'append_teaching' as const, generatorId: 'teaching-creator', verifierId: 'teaching-checker',
        adapterId: adapters.teaching.id, adapterDigest: adapters.teaching.implementationDigest,
        teachingBank: [0, 1, 2].map(n => ({ id: `note-${i}-${n}`, kind: 'explanation' as const, objectiveIds: [objective], sourceRefs: ['teaching'],
          markdown: `Reviewed note ${i}.${n}: compare each value with the one kept so far, then keep the ${episodeId === 'min' ? 'smaller' : 'larger'}.` })) };
    }) };
}
