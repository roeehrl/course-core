import { z } from 'zod';
import { digestJson as sdkDigestJson, digestTeachingArtifact, instantiateNumericalRecipe, checkNumericalReference, validateCourse } from '@course-core/sdk';
import type { ArtifactVerifierPort, Assessment, CourseManifest, ExerciseGeneratorPort, NumericalRecipeTemplate,
  NumericalReferencePort, RegisteredVerifier, TeachingArtifact } from '@course-core/sdk';
import { AdaptationError, requireCondition as assert } from './contracts.js';
import type { AdaptationState } from './contracts.js';
import { capture, count, counters, hash, id, parse, recordedCourse, same, stateSchema, registeredVerifierSchema } from './validation.js';

/** The SDK digest, except that a validated base course this process holds deeply frozen
 * returns the digest recorded when it was validated: such an object cannot have changed. */
async function digestJson(value: unknown): Promise<string> {
  return recordedCourse(value)?.digest ?? sdkDigestJson(value);
}

interface NumericalOptions { course: CourseManifest; canonicalAssessmentId: string; templateId: string; generatorId: string }
const numericalOptionsSchema = z.strictObject({ course: z.custom<CourseManifest>(), canonicalAssessmentId: id, templateId: id, generatorId: id });
const numericalDraftSchema = z.strictObject({ id, kind: z.literal('assessment_variant'), objectiveIds: z.array(id).min(1), sourceRefs: z.array(id),
  generator: z.strictObject({ id, version: z.string().min(1).max(128) }), canonicalAssessmentId: id,
  assessment: z.strictObject({ id, type: z.literal('numeric'), objectiveIds: z.array(id).min(1), familyId: id, prompt: z.string().min(1).max(100000),
    grading: z.strictObject({ expected: z.number(), absoluteTolerance: z.number().nonnegative(), explanation: z.string().min(1).max(100000) }) }),
  recipe: z.strictObject({ templateId: id, templateVersion: z.string().min(1).max(128), templateDigest: hash, variables: z.record(z.string(), z.number()) }),
  hiddenFixtures: z.unknown().optional() });
type NumericArtifact = Extract<TeachingArtifact, { kind: 'assessment_variant' }>;
function configuration(options: NumericalOptions) {
  // A recorded frozen base course already passed this exact validation (see validatedCourses).
  const recorded = recordedCourse(options.course);
  if (recorded) counters.courseReuses++; else counters.courseValidations++;
  const checked = recorded ? { valid: true as const, course: recorded.course } : validateCourse(options.course);
  assert(checked.valid && checked.course.adaptation, 'INVALID_COURSE', 'A valid numerical author configuration is required.');
  const course = checked.course, authoring = course.adaptation!;
  const canonical = course.assessments.find(a => a.id === options.canonicalAssessmentId);
  const family = authoring.families.find(f => f.canonicalAssessmentId === options.canonicalAssessmentId);
  const template = authoring.numericalRecipes.find(t => t.id === options.templateId);
  const generator = authoring.generators.find(g => g.id === options.generatorId);
  assert(canonical?.type === 'numeric' && family && template && generator
    && family.numericalRecipeIds.includes(template.id) && family.generatorIds.includes(generator.id)
    && generator.artifactKinds.includes('assessment_variant'), 'NUMERICAL_BINDING', 'Numerical recipe, canonical family and generator must be author-approved together.');
  return { course, authoring, canonical, family, template, generator };
}
function variablesAt(template: NumericalRecipeTemplate, ordinal: number): Record<string, number> {
  let remaining = BigInt(ordinal); const variables: Record<string, number> = {};
  for (const variable of template.variables) {
    assert(variable.integer, 'CREATOR_REQUIRED', 'This enumerator supports integer variable bounds; other creators use the SDK port.');
    const width = BigInt(variable.maximum - variable.minimum + 1);
    variables[variable.name] = variable.minimum + Number(remaining % width); remaining /= width;
  }
  assert(remaining === 0n, 'RECIPE_SPACE_EXHAUSTED', 'All bounded variable combinations have been enumerated.');
  return variables;
}
function abort(signal?: AbortSignal) { assert(!signal?.aborted, 'ABORTED', 'Generation or verification was cancelled.'); }

/** Deterministic enumeration through the SDK's bounded AST; no eval or random seed. */
export async function createNumericalExerciseGenerator(input: NumericalOptions): Promise<ExerciseGeneratorPort> {
  const options = parse(numericalOptionsSchema, await capture(input)), config = configuration(options), base = await digestJson(config.course);
  const { canonical, template, generator } = config;
  return {
    registration: { ...structuredClone(generator), artifactKinds: ['assessment_variant'] },
    async generate(raw, callOptions) {
      abort(callOptions.signal);
      const request = await capture(raw);
      const specification = parse(z.strictObject({ artifactId: id, assessmentId: id, ordinal: count }), request.specification);
      assert(request.baseCourseDigest === base && await same(request.canonicalAssessment, canonical)
        && await same(request.objectiveIds, canonical.objectiveIds) && await same(request.sourceRefs, template.sourceRefs),
      'GENERATOR_BINDING', 'Generator request must bind the immutable canonical item and author sources.');
      const generated = await instantiateNumericalRecipe(template, variablesAt(template, specification.ordinal));
      abort(callOptions.signal);
      return { id: specification.artifactId, kind: 'assessment_variant', objectiveIds: [...canonical.objectiveIds],
        sourceRefs: [...template.sourceRefs], generator: { id: generator.id, version: generator.version }, canonicalAssessmentId: canonical.id,
        recipe: generated.instance, assessment: { ...structuredClone(canonical), id: specification.assessmentId,
          prompt: generated.prompt, grading: { ...structuredClone(canonical.grading), expected: generated.value } } };
    },
  };
}

/** The reference implementation is supplied independently; the AST cannot verify itself. */
export async function createNumericalArtifactVerifier(input: NumericalOptions & { registration: RegisteredVerifier }, reference: NumericalReferencePort): Promise<ArtifactVerifierPort> {
  const options = parse(numericalOptionsSchema.extend({ registration: registeredVerifierSchema }), await capture(input)), config = configuration(options), base = await digestJson(config.course);
  const registration = structuredClone(options.registration), check = config.template.referenceCheck;
  const declaration = config.authoring.verifiers.find(v => v.id === registration.id && v.version === registration.version);
  assert(declaration && registration.id === check.verifierId && registration.version === check.verifierVersion
    && config.course.extensions.find(e => e.id === declaration.extensionId)?.integrity === `sha256-${registration.implementationDigest}`
    && config.family.verifierIds.includes(registration.id) && registration.artifactKinds.includes('assessment_variant')
    && registration.checkIds.includes(check.checkId) && await same(registration.sourceRefs, declaration.sourceRefs),
  'VERIFIER_BINDING', 'Use the author-declared independent numerical verifier.');
  return {
    registration: { ...registration, artifactKinds: ['assessment_variant'], checkIds: [check.checkId] },
    async verify(raw, callOptions) {
      abort(callOptions.signal); const request = await capture(raw), artifact = request.artifact;
      parse(z.strictObject({ baseCourseDigest: hash, proposalDigest: hash, artifact: z.unknown(), requiredCheckIds: z.array(id).min(1) }), request);
      assert(request.baseCourseDigest === base && artifact.kind === 'assessment_variant' && artifact.recipe && artifact.assessment.type === 'numeric',
        'VERIFIER_BINDING', 'Verifier accepts only this base and numerical recipe variants.');
      assert(request.requiredCheckIds.length === 1 && request.requiredCheckIds[0] === check.checkId,
        'UNSUPPORTED_CHECK', 'This verifier performs only its declared independent numerical check.');
      assert(artifact.digest === await digestTeachingArtifact(artifact) && artifact.canonicalAssessmentId === config.canonical.id
        && artifact.assessment.familyId === config.canonical.familyId && await same(artifact.sourceRefs, config.template.sourceRefs)
        && await same(artifact.objectiveIds, config.canonical.objectiveIds) && await same(artifact.assessment.objectiveIds, config.canonical.objectiveIds)
        && artifact.assessment.grading.absoluteTolerance === config.canonical.grading.absoluteTolerance,
      'ARTIFACT_BINDING', 'Artifact digest, sources or canonical scoring standard differs.');
      const computed = await instantiateNumericalRecipe(config.template, artifact.recipe.variables);
      assert(await same(computed.instance, artifact.recipe) && computed.prompt === artifact.assessment.prompt,
        'RECIPE_BINDING', 'Prompt and variables must bind the exact author recipe.');
      const checked = await checkNumericalReference(config.template, artifact.recipe, reference, callOptions);
      abort(callOptions.signal);
      const passed = checked.matched && artifact.assessment.grading.expected === checked.value;
      return { artifactDigest: artifact.digest, checks: [{ id: check.checkId, result: passed ? 'passed' : 'failed' }],
        evidenceRefs: [await digestJson({ templateDigest: artifact.recipe.templateDigest, variables: artifact.recipe.variables,
          referenceValue: checked.referenceValue, generatedValue: checked.value, artifactDigest: artifact.digest })] };
    },
  };
}
const freshSchema = z.strictObject({ artifactId: id, assessmentId: id, canonicalAssessmentId: id, templateId: id,
  episodeId: id, startOrdinal: count, maximumCandidates: count.min(1).max(256) });
export type FreshNumericalRequest = z.infer<typeof freshSchema>;
export interface FreshNumericalResult {
  artifact: Extract<TeachingArtifact, { kind: 'assessment_variant' }>;
  ordinal: number; verification: Awaited<ReturnType<ArtifactVerifierPort['verify']>>;
  verificationBinding: string; publicationAuthority: 'not_granted';
}

/** Returns an artifact and verification DATA, not an authenticated publication receipt. */
export async function generateFreshNumericalVariant(courseInput: CourseManifest, stateInput: AdaptationState, raw: FreshNumericalRequest,
  generator: ExerciseGeneratorPort, verifier: ArtifactVerifierPort, options: { signal?: AbortSignal } = {}): Promise<FreshNumericalResult> {
  const captured = await capture({ course: courseInput, state: stateInput, request: raw });
  const request = parse(freshSchema, captured.request), course = captured.course, state = parse(stateSchema, captured.state);
  const { digest: stateDigest, ...stateData } = state;
  assert(stateDigest === await digestJson(stateData), 'STATE_DIGEST_MISMATCH', 'Freshness history integrity failed.');
  const config = configuration({ course, canonicalAssessmentId: request.canonicalAssessmentId, templateId: request.templateId, generatorId: generator.registration.id });
  assert(await digestJson(course) === state.baseCourseDigest
    && generator.registration.artifactKinds.includes('assessment_variant')
    && generator.registration.artifactKinds.every(kind => config.generator.artifactKinds.includes(kind))
    && await same(generator.registration, { ...config.generator, artifactKinds: generator.registration.artifactKinds }),
  'GENERATOR_BINDING', 'Generation must use the registered author identity/sources and a supported subset of its allowed kinds.');
  const target = config.authoring.targets.find(t => t.episodeId === request.episodeId);
  assert(target?.allowedOperations.includes('add_assessment_variant') && config.canonical.objectiveIds.every(id => target.objectiveIds.includes(id)),
    'AUTHOR_TARGET', 'Fresh variants need an approved episode/objective target.');
  assert(config.family.verifierIds.includes(verifier.registration.id), 'VERIFIER_BINDING', 'Family does not approve this verifier.');
  assert((state.plan.variantCounts.find(c => c.familyId === config.family.familyId)?.count ?? 0) < config.family.maxVariantsPerPlan,
    'AUTHOR_LIMIT', 'The canonical family variant bound is exhausted.');
  const usedPrompts = new Set(course.assessments.filter(a => a.familyId === config.family.familyId).map(a => a.prompt));
  for (const admission of state.admissions.filter(a => a.status !== 'cancelled')) for (const artifact of admission.proposal.artifacts) {
    // Pending/applied questions are occupied; an unused cancelled draft was not served.
    if (artifact.kind === 'assessment_variant' && artifact.assessment.familyId === config.family.familyId) usedPrompts.add(artifact.assessment.prompt);
  }
  for (let offset = 0; offset < request.maximumCandidates; offset++) {
    abort(options.signal); const ordinal = request.startOrdinal + offset;
    assert(Number.isSafeInteger(ordinal), 'RECIPE_SPACE_EXHAUSTED', 'Enumeration ordinal overflow.');
    const draft = await generator.generate({ baseCourseDigest: state.baseCourseDigest, objectiveIds: config.canonical.objectiveIds,
      canonicalAssessment: config.canonical, sourceRefs: config.template.sourceRefs,
      specification: { artifactId: request.artifactId, assessmentId: request.assessmentId, ordinal } }, options);
    abort(options.signal);
    assert(draft.kind === 'assessment_variant' && draft.assessment.type === 'numeric' && draft.recipe,
      'GENERATOR_OUTPUT', 'Generator must return a numerical recipe variant.');
    const capturedDraft = parse(numericalDraftSchema, await capture(draft));
    const artifact: NumericArtifact = { ...capturedDraft, digest: await digestTeachingArtifact(capturedDraft as TeachingArtifact) } as NumericArtifact;
    assert(artifact.id === request.artifactId && artifact.assessment.id === request.assessmentId && artifact.canonicalAssessmentId === config.canonical.id
      && artifact.assessment.familyId === config.canonical.familyId && await same(artifact.generator, { id: config.generator.id, version: config.generator.version }),
    'GENERATOR_OUTPUT', 'A generator cannot invent IDs, canonical families or provenance.');
    if (usedPrompts.has(artifact.assessment.prompt)) continue;
    const checkIds = config.authoring.verifiers.find(v => v.id === verifier.registration.id && v.version === verifier.registration.version)?.requiredCheckIds;
    assert(checkIds?.length, 'VERIFIER_BINDING', 'Author verifier declaration is missing.');
    // Verification can bind the artifact before a later host proposal is assembled.
    const verificationBinding = await digestJson({ baseCourseDigest: state.baseCourseDigest, planDigest: state.plan.digest, artifactDigest: artifact.digest });
    const verification = await capture(await verifier.verify({ baseCourseDigest: state.baseCourseDigest, proposalDigest: verificationBinding,
      artifact: structuredClone(artifact), requiredCheckIds: [...checkIds] }, options));
    parse(z.strictObject({ artifactDigest: hash, checks: z.array(z.strictObject({ id, result: z.enum(['passed', 'failed']) })), evidenceRefs: z.array(z.string().min(1).max(256)) }), verification);
    abort(options.signal);
    assert(verification.artifactDigest === artifact.digest && verification.checks.length === checkIds.length
      && checkIds.every(id => verification.checks.filter(c => c.id === id && c.result === 'passed').length === 1)
      && verification.evidenceRefs.length > 0, 'NUMERICAL_VERIFICATION_FAILED', 'Independent verification did not pass every required check.');
    return { artifact, ordinal, verification, verificationBinding, publicationAuthority: 'not_granted' as const };
  }
  throw new AdaptationError('FRESH_VARIANT_UNAVAILABLE', 'No fresh prompt within the bounded search; use another approved creator or report the limit.');
}
