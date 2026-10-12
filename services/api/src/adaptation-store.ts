/**
 * Transactional adaptation service. Parent composition installs @course-core/adaptation,
 * registers the routes, and calls resolveEnrollmentCourse with the RAW immutable release.
 * Never pass the returned effective server_bundle back as a new base release.
 *
 * Only approveAdaptationRegistry (owner/admin) installs author/server settings.
 * stageVerifiedAdaptation is a trusted staff/service hook, NOT a browser proposal API.
 * Its candidate cannot contain proofReceipts, assignments or authority assertions.
 * Installed code verifies candidates; this service persists proof/authorization records.
 * All enrollment writes share repository.enrollmentCommand's enrollment row lock.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import type { ActivityAssignmentDecision, ArtifactProofReceipt, ArtifactVerifierPort, Assessment, CourseAdaptation, CourseManifest,
  ExerciseGeneratorPort, Json, NumericalExpression, NumericalRecipeTemplate, RegisteredVerifier, TeachingArtifact } from '@course-core/sdk';
import { digestAdaptationProposal, digestTeachingArtifact, validateCourse, validateCourseAdaptation, validateAssignmentDecisions } from '@course-core/sdk';
import { canonicalJson, compileCourse } from '@course-core/sdk/compiler';
import { AdaptationError, admitAdaptation, applyAdaptation, createAdaptationState, materializeAdaptation,
  createNumericalArtifactVerifier, createNumericalExerciseGenerator, generateFreshNumericalVariant,
  type AdaptationState, type EvidenceFence, type RuntimeContext, type TrustedProof, type TrustedAuthorization } from '@course-core/adaptation';
import { PolicyError, type PolicyState } from '@course-core/policy';
import { transaction, type Database } from './database.js';
import { membership, type Actor } from './auth.js';
import { enrollmentCommand, digestJson, type Enrollment, type Release, type EnrollmentContext, type CommandInput } from './repository.js';
import { ApiError, requireCondition as require } from './errors.js';
import { appendEvent } from './events.js';
import { activateWindows, assertPolicyAction } from './policy-adapter.js';
import { learningSnapshot, publicQuestion, requireAvailable } from './learning.js';

const id = z.string().regex(/^[a-z][a-z0-9._:-]{0,127}$(?![\s\S])/);
const hash = z.string().regex(/^[a-f0-9]{64}$(?![\s\S])/);
const revision = z.number().int().nonnegative().max(2147483646);
const commandFields = { expectedRevision: revision.min(1), idempotencyKey: z.string().regex(/^[A-Za-z0-9:_-]{8,200}$/), expectedPlanRevision: revision };
const operationKind = z.enum(['append_teaching', 'replace_teaching', 'add_assessment_variant', 'attach_visual', 'attach_media']);
const profileSchema = z.strictObject({ id, episodeId: id, operation: operationKind, generatorId: id, verifierId: id,
  adapterId: id, adapterDigest: hash, canonicalAssessmentId: id.optional(), templateId: id.optional(),
  classification: z.enum(['required', 'optional']), plannedMinutes: z.number().int().min(0).max(100000),
  additionalEpisodes: z.number().int().min(0).max(1000),
  bank: z.array(z.strictObject({ id, assessment: z.custom<Assessment>(), sourceRefs: z.array(id).min(1), hiddenFixtures: z.custom<Json>().optional() })).max(256).optional(),
});
const verifierSchema = z.strictObject({ id, version: z.string().min(1).max(128), implementationDigest: hash,
  sourceRefs: z.array(id), artifactKinds: z.array(z.enum(['explanation','practice','assessment_variant','visual','media','profile_suggestion'])), checkIds: z.array(id) });
const configurationSchema = z.strictObject({ verifiers: z.array(verifierSchema).min(1).max(64), profiles: z.array(profileSchema).min(1).max(128),
  authorizationMinutes: z.number().int().min(1).max(60) });
export type AdaptationProfile = z.infer<typeof profileSchema>;
export type AdaptationConfiguration = z.infer<typeof configurationSchema>;
export interface TrustedAdaptationAdapter {
  id: string; implementationDigest: string; kind: 'numeric' | 'bank' | 'custom';
  createPorts(input: { course: CourseManifest; profile: AdaptationProfile; verifier: RegisteredVerifier }): Promise<{
    generator?: ExerciseGeneratorPort; verifier: ArtifactVerifierPort;
  }>;
}
export interface AdaptationRuntime { adapters: readonly TrustedAdaptationAdapter[]; verifierTimeoutMs: number }
/** Explicit composition only. Empty adapters means no executable adaptation capability. */
export function createAdaptationRuntime(adapters: readonly TrustedAdaptationAdapter[], verifierTimeoutMs = 5000): AdaptationRuntime {
  require(Number.isSafeInteger(verifierTimeoutMs) && verifierTimeoutMs >= 10 && verifierTimeoutMs <= 30000, 'INVALID_ADAPTER_TIMEOUT');
  require(new Set(adapters.map(a => `${a.id}:${a.implementationDigest}`)).size === adapters.length, 'DUPLICATE_ADAPTER');
  for (const adapter of adapters) { parse(id, adapter.id); parse(hash, adapter.implementationDigest); require(typeof adapter.createPorts === 'function', 'INVALID_ADAPTER'); }
  return Object.freeze({ adapters: Object.freeze(adapters.map(adapter => Object.freeze({ ...adapter }))), verifierTimeoutMs });
}
function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  try { canonicalJson(value); } catch { throw new ApiError(400, 'INVALID_REQUEST'); }
  const parsed = schema.safeParse(value); require(parsed.success, 'INVALID_REQUEST'); return parsed.data;
}
function installed(runtime: AdaptationRuntime, profile: AdaptationProfile) {
  const adapter = runtime.adapters.find(a => a.id === profile.adapterId && a.implementationDigest === profile.adapterDigest);
  require(adapter, 'ADAPTATION_ADAPTER_NOT_INSTALLED', 503); return adapter;
}
function translated(error: unknown): never {
  if (error instanceof AdaptationError || error instanceof PolicyError) throw new ApiError(409, error.code);
  // Local package links may load a second policy copy. Normalize only its known
  // public denial codes, never an arbitrary adapter message or response body.
  const other = error as { name?: string; code?: string };
  if (other?.name === 'PolicyError' && ['QUOTA_EXCEEDED','DEADLINE_REACHED','ENROLLMENT_INACTIVE','STALE_POLICY_REVISION',
    'STALE_LEDGER_REVISION','STALE_JOB','DUPLICATE_RESERVATION','DUPLICATE_WORK','INVALID_RESERVATION_STATE','UNKNOWN_SCOPE',
    'UNKNOWN_CONCEPT','INVALID_INPUT','INVALID_LEDGER','UNBOUNDED_POLICY'].includes(other.code ?? '')) throw new ApiError(409, other.code!);
  if (other?.name === 'AdaptationDataError') throw new ApiError(409, 'ADAPTATION_REFERENCE_REJECTED');
  if ((error as { constraint?: string })?.constraint === 'adaptation_commit_deadline') throw new ApiError(409, 'ADAPTATION_COMMIT_DEADLINE');
  throw error;
}
async function bounded<T>(runtime: AdaptationRuntime, execute: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([execute(controller.signal), new Promise<never>((_, reject) => { timer = setTimeout(() => {
    controller.abort(); reject(new ApiError(409, 'ADAPTATION_VERIFICATION_TIMEOUT'));
  }, runtime.verifierTimeoutMs); })]); } finally { if (timer) clearTimeout(timer); controller.abort(); }
}

// Independent exact-rational, iterative reference interpreter. It does not call the
// SDK evaluator or read the generated key. Limits bound BigInt growth and node count.
type Fraction = { n: bigint; d: bigint };
function fraction(n: bigint, d = 1n): Fraction {
  require(d !== 0n && n.toString(2).length <= 8192 && d.toString(2).length <= 8192, 'REFERENCE_BOUND');
  if (d < 0n) { n = -n; d = -d; }
  let a = n < 0n ? -n : n, b = d;
  while (b) { const rest = a % b; a = b; b = rest; }
  const divisor = a || 1n; n /= divisor; d /= divisor;
  require(n.toString(2).length <= 4096 && d.toString(2).length <= 4096, 'REFERENCE_BOUND'); return { n, d };
}
function decimal(value: number): Fraction {
  require(Number.isFinite(value), 'REFERENCE_BOUND');
  const [mantissa, exponentText] = String(value).toLowerCase().split('e'), exponent = Number(exponentText ?? 0);
  const decimalPlaces = (mantissa!.split('.')[1] ?? '').length, digits = mantissa!.replace('.', '');
  const scale = decimalPlaces - exponent;
  return scale >= 0 ? fraction(BigInt(digits), 10n ** BigInt(scale)) : fraction(BigInt(digits) * 10n ** BigInt(-scale));
}
function independentReference(template: NumericalRecipeTemplate, variables: Record<string, number>, signal?: AbortSignal): number {
  require(Object.keys(variables).length === template.variables.length, 'REFERENCE_VARIABLES');
  for (const v of template.variables) require(Number.isFinite(variables[v.name]) && variables[v.name]! >= v.minimum && variables[v.name]! <= v.maximum
    && (!v.integer || Number.isSafeInteger(variables[v.name])), 'REFERENCE_VARIABLES');
  const pending: { node: NumericalExpression; expanded: boolean; depth: number }[] = [{ node: template.expression, expanded: false, depth: 1 }];
  const values: Fraction[] = []; let nodes = 0;
  while (pending.length) {
    require(!signal?.aborted, 'ADAPTATION_CANCELLED', 409);
    const { node, expanded, depth } = pending.pop()!;
    if (!expanded) {
      require(++nodes <= Math.min(template.maxNodes, 256) && depth <= Math.min(template.maxDepth, 16), 'REFERENCE_BOUND');
      if (node.type === 'constant') { values.push(decimal(node.value)); continue; }
      if (node.type === 'variable') { values.push(decimal(variables[node.name]!)); continue; }
      pending.push({ node, expanded: true, depth });
      if (node.type === 'binary') { pending.push({ node: node.right, expanded: false, depth: depth + 1 }); pending.push({ node: node.left, expanded: false, depth: depth + 1 }); }
      else pending.push({ node: node.value, expanded: false, depth: depth + 1 });
      continue;
    }
    if (node.type === 'unary') {
      const a = values.pop()!; values.push(fraction(node.operator === 'negate' ? -a.n : a.n < 0n ? -a.n : a.n, a.d));
    } else if (node.type === 'binary') {
      const b = values.pop()!, a = values.pop()!;
      if (node.operator === 'add') values.push(fraction(a.n * b.d + b.n * a.d, a.d * b.d));
      else if (node.operator === 'subtract') values.push(fraction(a.n * b.d - b.n * a.d, a.d * b.d));
      else if (node.operator === 'multiply') values.push(fraction(a.n * b.n, a.d * b.d));
      else if (node.operator === 'divide') values.push(fraction(a.n * b.d, a.d * b.n));
      else { const lower = a.n * b.d <= b.n * a.d; values.push(node.operator === 'min' ? lower ? a : b : lower ? b : a); }
    }
  }
  require(values.length === 1, 'REFERENCE_BOUND'); const answer = Number(values[0]!.n) / Number(values[0]!.d);
  require(Number.isFinite(answer) && Math.abs(answer) <= template.maxAbsoluteValue, 'REFERENCE_BOUND'); return answer;
}
async function numericPorts({ course, profile, verifier }: Parameters<TrustedAdaptationAdapter['createPorts']>[0]) {
  require(profile.canonicalAssessmentId && profile.templateId, 'NUMERIC_PROFILE_INVALID');
  const template = course.adaptation!.numericalRecipes.find(t => t.id === profile.templateId)!;
  const templateDigest = digestJson(template), options = { course, canonicalAssessmentId: profile.canonicalAssessmentId, templateId: profile.templateId, generatorId: profile.generatorId };
  return { generator: await createNumericalExerciseGenerator(options), verifier: await createNumericalArtifactVerifier({ ...options, registration: verifier }, {
    verifierId: template.referenceCheck.verifierId, verifierVersion: template.referenceCheck.verifierVersion, checkId: template.referenceCheck.checkId,
    async evaluate(input, options) { require(input.templateDigest === templateDigest, 'REFERENCE_TEMPLATE_CHANGED', 409); return independentReference(template, input.variables, options.signal); },
  }) };
}
/** Fingerprint of this reference/port implementation; not a receipt or credential. Pin
 * the deployed build's returned fingerprint in author extensions and stored approval. */
export function boundedNumericalAdapter(): TrustedAdaptationAdapter {
  return { id: 'bounded-numeric-v1', kind: 'numeric', implementationDigest: digestJson({ protocol: 'bounded-rational-v1', sdk: '0.2.0',
    source: [boundedNumericalAdapter.toString(), fraction.toString(), decimal.toString(), independentReference.toString(), numericPorts.toString(), createNumericalExerciseGenerator.toString(), createNumericalArtifactVerifier.toString()] }), createPorts: numericPorts };
}
/** Trusted authored-bank hook chooses a stored candidate ID only; it cannot supply keys.
 * Register this adapter explicitly. The approval configuration contains the reviewed bank.
 * It proves exact bank membership, not arbitrary subject-matter correctness.
 * Direct fresh delivery supports choice/numeric items; practical/code creator and
 * evaluator orchestration remains a separate parent integration. */
export function authoredVariantBankAdapter(select: (availableIds: readonly string[]) => string | undefined = ids => ids[0]): TrustedAdaptationAdapter {
  const implementationDigest = digestJson({ protocol: 'authored-bank-match-v1', source: [authoredVariantBankAdapter.toString(), select.toString(), bankMatch.toString()] });
  return { id: 'authored-bank-v1', implementationDigest, kind: 'bank', async createPorts({ course, profile, verifier }) {
    const registration = course.adaptation!.generators.find(g => g.id === profile.generatorId)!;
    return { generator: { registration, async generate(input) {
      const request = parse(z.strictObject({ artifactId: id, assessmentId: id, excludedBankIds: z.array(id) }), input.specification);
      const available = profile.bank!.filter(b => !request.excludedBankIds.includes(b.id)); const selected = select(Object.freeze(available.map(b => b.id)));
      const entry = available.find(b => b.id === selected); require(entry, 'AUTHORED_VARIANT_BANK_EXHAUSTED', 409);
      return { id: request.artifactId, kind: 'assessment_variant', objectiveIds: [...entry.assessment.objectiveIds], sourceRefs: [...entry.sourceRefs],
        generator: { id: registration.id, version: registration.version }, canonicalAssessmentId: profile.canonicalAssessmentId!,
        assessment: { ...structuredClone(entry.assessment), id: request.assessmentId }, ...(entry.hiddenFixtures === undefined ? {} : { hiddenFixtures: structuredClone(entry.hiddenFixtures) }) };
    } }, verifier: { registration: verifier, async verify(input) {
      require(input.requiredCheckIds.length === 1 && input.requiredCheckIds[0] === 'authored-bank-match', 'UNSUPPORTED_BANK_CHECK', 409);
      const matched = bankMatch(profile, input.artifact);
      return { artifactDigest: await digestTeachingArtifact(input.artifact), checks: [{ id: 'authored-bank-match', result: matched ? 'passed' : 'failed' }],
        evidenceRefs: matched ? [`bank:${digestJson({ profileId: profile.id, entry: matched })}`] : [] };
    } } };
  } };
}
function bankMatch(profile: AdaptationProfile, artifact: TeachingArtifact) {
  if (artifact.kind !== 'assessment_variant' || artifact.recipe || artifact.canonicalAssessmentId !== profile.canonicalAssessmentId) return undefined;
  const withoutId = ({ id: _id, ...value }: Assessment) => value;
  return profile.bank?.find(entry => digestJson(withoutId(entry.assessment)) === digestJson(withoutId(artifact.assessment))
    && digestJson(entry.sourceRefs) === digestJson(artifact.sourceRefs) && digestJson(entry.hiddenFixtures ?? null) === digestJson(artifact.hiddenFixtures ?? null));
}

interface RegistryRow { revision: number; status: string; configuration: AdaptationConfiguration; configuration_digest: string; base_digest: string }
interface StateRow { snapshot: AdaptationState; ledger_revision: number; plan_revision: number; plan_digest: string; base_digest: string }
interface ProposalRow { id: string; body: CourseAdaptation; assignments: ActivityAssignmentDecision[]; status: string; authority_ref: string;
  registry_revision: number; evidence_fence: EvidenceFence; proposal_digest: string; base_digest: string; expected_plan_revision: number; verified_policy_revision: number }
async function clock(client: PoolClient) { return (await client.query<{ now: string }>("SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS now")).rows[0]!.now; }
async function rawRelease(client: PoolClient, enrollment: Enrollment): Promise<Release> {
  const row = (await client.query<Release>('SELECT * FROM course_releases WHERE id=$1 AND workspace_id=$2', [enrollment.course_release_id, enrollment.workspace_id])).rows[0];
  require(row && row.digest === digestJson(row.server_bundle), 'BASE_COURSE_INTEGRITY', 409); return row;
}
async function registry(client: PoolClient, release: Release, active = true, lock = true): Promise<RegistryRow> {
  const row = (await client.query<RegistryRow>(`SELECT r.revision,r.status,v.configuration,v.configuration_digest,v.base_digest
    FROM adaptation_registries r JOIN adaptation_registry_versions v ON v.course_release_id=r.course_release_id AND v.revision=r.revision
    WHERE r.course_release_id=$1 AND r.workspace_id=$2 ${lock ? 'FOR SHARE OF r' : ''}`, [release.id, release.workspace_id])).rows[0];
  require(row && (!active || row.status === 'active'), 'ADAPTATION_NOT_APPROVED', 409);
  row.configuration = parse(configurationSchema, row.configuration);
  require(row.base_digest === release.digest && digestJson(row.configuration) === row.configuration_digest, 'REGISTRY_INTEGRITY', 409); return row;
}
async function evidenceFence(client: PoolClient, enrollment: Enrollment, baseDigest: string, lock = true): Promise<EvidenceFence> {
  const attempts = (await client.query<{ data: Json }>(`SELECT to_jsonb(a) AS data FROM attempts a WHERE enrollment_id=$1 ORDER BY id ${lock ? 'FOR SHARE' : ''}`, [enrollment.id])).rows.map(r => r.data);
  const evidence = (await client.query<{ data: Json }>(`SELECT to_jsonb(e) AS data FROM evidence e WHERE enrollment_id=$1 ORDER BY id ${lock ? 'FOR SHARE' : ''}`, [enrollment.id])).rows.map(r => r.data);
  return { enrollmentId: enrollment.id, baseCourseDigest: baseDigest, revision: attempts.length + evidence.length, digest: digestJson({ attempts, evidence }) };
}
async function runtimeContext(client: PoolClient, enrollment: Enrollment, release: Release, reg: RegistryRow, lock = true): Promise<RuntimeContext> {
  const policy = (await client.query<{ snapshot: PolicyState }>(`SELECT snapshot FROM policy_states WHERE enrollment_id=$1 ${lock ? 'FOR UPDATE' : ''}`, [enrollment.id])).rows[0]?.snapshot;
  require(policy, 'POLICY_STATE_MISSING', 500);
  const proofs = (await client.query<{ trusted_record: TrustedProof }>('SELECT trusted_record FROM adaptation_proofs WHERE enrollment_id=$1 ORDER BY receipt_ref', [enrollment.id])).rows.map(r => r.trusted_record);
  const authorizations = (await client.query<{ trusted_record: TrustedAuthorization }>('SELECT trusted_record FROM adaptation_authorizations WHERE enrollment_id=$1 ORDER BY receipt_ref', [enrollment.id])).rows.map(r => r.trusted_record);
  return { course: release.server_bundle, policy, evidence: await evidenceFence(client, enrollment, release.digest, lock), registry: { revision: reg.revision,
    verifiers: reg.configuration.verifiers, proofs, authorizations,
    episodeScopes: release.server_bundle.chapters.flatMap(c => c.episodes).map(e => ({ episodeId: e.id, scopeId: `episode:${e.id}` })),
    objectiveConcepts: release.server_bundle.objectives.map(o => ({ objectiveId: o.id, conceptId: o.id })),
    protectedReservationIds: policy.reservations.filter(r => !r.reservationId.startsWith('adapt-') && r.state !== 'cancelled').map(r => r.reservationId),
  } };
}
async function loadState(client: PoolClient, enrollment: Enrollment, context: RuntimeContext) {
  const row = (await client.query<StateRow>('SELECT * FROM adaptation_states WHERE enrollment_id=$1 FOR UPDATE', [enrollment.id])).rows[0];
  if (row) {
    require(row.base_digest === context.evidence.baseCourseDigest && row.snapshot.plan.revision === row.plan_revision && row.snapshot.plan.digest === row.plan_digest
      && row.snapshot.ledgerRevision === row.ledger_revision, 'ADAPTATION_STATE_INTEGRITY', 409); return row.snapshot;
  }
  const state = await createAdaptationState(context);
  await client.query('INSERT INTO adaptation_states(enrollment_id,workspace_id,base_digest,ledger_revision,plan_revision,plan_digest,snapshot) VALUES($1,$2,$3,0,0,$4,$5)',
    [enrollment.id, enrollment.workspace_id, state.baseCourseDigest, state.plan.digest, JSON.stringify(state)]); return state;
}

function validateConfiguration(course: CourseManifest, configuration: AdaptationConfiguration, runtime: AdaptationRuntime) {
  require(validateCourse(course).valid && course.adaptation, 'ADAPTATION_DISABLED', 409);
  require(new Set(configuration.profiles.map(p => p.id)).size === configuration.profiles.length
    && new Set(configuration.verifiers.map(v => v.id)).size === configuration.verifiers.length, 'DUPLICATE_REGISTRY_ENTRY');
  for (const profile of configuration.profiles) {
    const adapter = installed(runtime, profile), author = course.adaptation;
    const target = author.targets.find(t => t.episodeId === profile.episodeId);
    const generator = author.generators.find(g => g.id === profile.generatorId);
    const declaration = author.verifiers.find(v => v.id === profile.verifierId);
    const verifier = configuration.verifiers.find(v => v.id === profile.verifierId);
    require(target?.allowedOperations.includes(profile.operation) && generator && declaration && verifier, 'UNAPPROVED_ADAPTATION_PROFILE', 409);
    require(verifier.version === declaration.version && verifier.implementationDigest === adapter.implementationDigest
      && course.extensions.find(e => e.id === declaration.extensionId)?.integrity === `sha256-${adapter.implementationDigest}`
      && course.extensions.find(e => e.id === generator.extensionId)?.integrity === `sha256-${adapter.implementationDigest}`
      && digestJson([...verifier.sourceRefs].sort()) === digestJson([...declaration.sourceRefs].sort())
      && verifier.artifactKinds.every(k => declaration.artifactKinds.includes(k)) && declaration.requiredCheckIds.every(k => verifier.checkIds.includes(k)),
    'ADAPTER_REGISTRY_BINDING', 409);
    require(author.limits.allowedClassifications.includes(profile.classification) && profile.plannedMinutes <= author.limits.maxPlannedMinutesPerAssignment
      && profile.additionalEpisodes <= author.limits.maxAdditionalEpisodesPerAssignment, 'AUTHOR_LIMIT', 409);
    if (profile.operation === 'add_assessment_variant') {
      const canonical = course.assessments.find(a => a.id === profile.canonicalAssessmentId);
      const family = author.families.find(f => f.canonicalAssessmentId === canonical?.id);
      require(canonical && family && family.generatorIds.includes(generator.id) && family.verifierIds.includes(verifier.id)
        && canonical.objectiveIds.every(o => target!.objectiveIds.includes(o)), 'CANONICAL_FAMILY_BINDING', 409);
      if (adapter.kind === 'numeric') {
        const template = author.numericalRecipes.find(t => t.id === profile.templateId);
        require(canonical.type === 'numeric' && template && family.numericalRecipeIds.includes(template.id) && !profile.bank
          && template.variables.every(v => v.integer) && template.referenceCheck.verifierId === verifier.id
          && declaration.requiredCheckIds.length === 1 && declaration.requiredCheckIds[0] === template.referenceCheck.checkId, 'NUMERIC_PROFILE_INVALID', 409);
      } else if (adapter.kind === 'bank') {
        require(canonical.type === 'choice' || canonical.type === 'numeric', 'FRESH_GRADER_NOT_CONFIGURED', 409);
        require(profile.bank?.length && !profile.templateId && declaration.requiredCheckIds.length === 1
          && declaration.requiredCheckIds[0] === 'authored-bank-match', 'BANK_PROFILE_INVALID', 409);
        require(new Set(profile.bank.map(b => b.id)).size === profile.bank.length, 'DUPLICATE_BANK_ITEM');
        require(validateCourse({ ...course, assessments: [...course.assessments, ...profile.bank.map(b => b.assessment)] }).valid, 'BANK_PROFILE_INVALID', 409);
        for (const entry of profile.bank) require(entry.assessment.familyId === canonical.familyId && entry.assessment.type === canonical.type
          && digestJson([...entry.assessment.objectiveIds].sort()) === digestJson([...canonical.objectiveIds].sort())
          && entry.sourceRefs.every(s => author.sourceRefs.includes(s) && course.sources.some(source => source.id === s)), 'BANK_PROFILE_INVALID', 409);
      }
    } else require(adapter.kind === 'custom' && !profile.bank && !profile.templateId, 'ADAPTER_CAPABILITY_MISMATCH', 409);
  }
}
/** Trusted administration hook; no learner/browser registry-write endpoint is exposed.
 * Registry replacement/revocation takes the same registry row lock used by apply. */
export async function approveAdaptationRegistry(db: Database, actor: Actor, raw: {
  releaseId: string; expectedRegistryRevision: number; configuration: AdaptationConfiguration;
}, runtime: AdaptationRuntime) {
  const input = parse(z.strictObject({ releaseId: z.string().uuid(), expectedRegistryRevision: revision, configuration: configurationSchema }), raw);
  return transaction(db, async client => {
    const release = (await client.query<Release>('SELECT * FROM course_releases WHERE id=$1 FOR UPDATE', [input.releaseId])).rows[0];
    require(release, 'RELEASE_NOT_FOUND', 404); await membership(client, actor, release.workspace_id, ['owner', 'admin']);
    require(release.digest === digestJson(release.server_bundle), 'BASE_COURSE_INTEGRITY', 409);
    validateConfiguration(release.server_bundle, input.configuration, runtime);
    const current = (await client.query<{ revision: number }>('SELECT revision FROM adaptation_registries WHERE course_release_id=$1 FOR UPDATE', [release.id])).rows[0];
    require((current?.revision ?? 0) === input.expectedRegistryRevision, 'STALE_REGISTRY', 409);
    const next = (current?.revision ?? 0) + 1;
    await client.query(`INSERT INTO adaptation_registry_versions(course_release_id,workspace_id,revision,base_digest,configuration,configuration_digest,approved_by)
      VALUES($1,$2,$3,$4,$5,$6,$7)`, [release.id, release.workspace_id, next, release.digest, JSON.stringify(input.configuration), digestJson(input.configuration), actor.id]);
    await client.query(`INSERT INTO adaptation_registries(course_release_id,workspace_id,revision,status) VALUES($1,$2,$3,'active')
      ON CONFLICT(course_release_id) DO UPDATE SET revision=EXCLUDED.revision,status='active'`, [release.id, release.workspace_id, next]);
    await appendEvent(client, { workspaceId: release.workspace_id, actorId: actor.id, actorKind: 'staff', type: 'adaptation.registry_approved',
      payload: { releaseId: release.id, registryRevision: next }, idempotencyKey: `adapt-registry:${release.id}:${next}` });
    return { registryRevision: next };
  });
}

const candidateSchema = z.strictObject({ schemaVersion: z.literal(1), id, baseCourseDigest: hash, expectedPlanRevision: revision, expectedPlanDigest: hash,
  rationale: z.string().min(1).max(10000), artifacts: z.array(z.custom<TeachingArtifact>(v => v !== null && typeof v === 'object')).min(1).max(64),
  operations: z.array(z.custom<CourseAdaptation['operations'][number]>(v => v !== null && typeof v === 'object')).min(1).max(64) });
type Candidate = Omit<CourseAdaptation, 'proofReceipts'>;
type ProfileSelection = { operationId: string; profileId: string };
function selectProfile(reg: RegistryRow, selection: ProfileSelection[], operationId: string) {
  const matches = selection.filter(s => s.operationId === operationId); require(matches.length === 1, 'PROFILE_BINDING', 409);
  const profile = reg.configuration.profiles.find(p => p.id === matches[0]!.profileId); require(profile, 'PROFILE_BINDING', 409); return profile;
}
async function checkedPorts(runtime: AdaptationRuntime, course: CourseManifest, profile: AdaptationProfile, reg: RegistryRow) {
  const adapter = installed(runtime, profile), verifier = reg.configuration.verifiers.find(v => v.id === profile.verifierId)!;
  const ports = await bounded(runtime, () => adapter.createPorts({ course: structuredClone(course), profile: structuredClone(profile), verifier: structuredClone(verifier) }));
  const actual = ports.verifier.registration;
  require(actual.id === verifier.id && actual.version === verifier.version && actual.implementationDigest === verifier.implementationDigest
    && digestJson([...actual.sourceRefs].sort()) === digestJson([...verifier.sourceRefs].sort()), 'VERIFIER_REGISTRATION_MISMATCH', 409);
  return ports;
}
async function prepare(client: PoolClient, enrollment: Enrollment, actor: Actor, base: Release, reg: RegistryRow, context: RuntimeContext,
  state: AdaptationState, candidateInput: Candidate, selections: ProfileSelection[], runtime: AdaptationRuntime) {
  const candidate = parse(candidateSchema, candidateInput);
  require(candidate.expectedPlanRevision === state.plan.revision && candidate.expectedPlanDigest === state.plan.digest, 'STALE_PLAN', 409);
  require(candidate.baseCourseDigest === base.digest && selections.length === candidate.operations.length, 'BASE_OR_PROFILE_BINDING', 409);
  const count = (await client.query<{ count: string }>("SELECT count(*) FROM adaptation_proposals WHERE enrollment_id=$1 AND status='verified'", [enrollment.id])).rows[0]!;
  require(Number(count.count) < 64, 'PENDING_ADAPTATION_LIMIT', 409);
  const proposalId = randomUUID(), authorityRef = `authority-${proposalId}`, now = await clock(client);
  const proposal: CourseAdaptation = { ...structuredClone(candidate), proofReceipts: [] };
  const proposalDigest = await digestAdaptationProposal(proposal), assignments: ActivityAssignmentDecision[] = [];
  for (const operation of proposal.operations) {
    const profile = selectProfile(reg, selections, operation.id);
    require(operation.type === profile.operation && 'episodeId' in operation && operation.episodeId === profile.episodeId, 'PROFILE_BINDING', 409);
    const artifact = proposal.artifacts.find(a => a.id === operation.artifactId); require(artifact, 'ARTIFACT_BINDING', 409);
    require(artifact.generator.id === profile.generatorId, 'PROFILE_BINDING', 409);
    if (artifact.kind === 'assessment_variant') require(artifact.canonicalAssessmentId === profile.canonicalAssessmentId, 'PROFILE_BINDING', 409);
    const verifier = reg.configuration.verifiers.find(v => v.id === profile.verifierId)!;
    const declaration = base.server_bundle.adaptation!.verifiers.find(v => v.id === verifier.id)!;
    const receiptId = `proof-${randomUUID()}`;
    // Expected claims let SDK check data/author constraints BEFORE invoking code.
    // They become trusted records ONLY after the installed verifier actually passes.
    proposal.proofReceipts.push({ id: receiptId, receiptRef: receiptId, proposalDigest, artifactId: artifact.id, artifactDigest: artifact.digest,
      verifierId: verifier.id, verifierVersion: verifier.version, verifierImplementationDigest: verifier.implementationDigest,
      sourceRefs: [...artifact.sourceRefs], verifierSourceRefs: [...verifier.sourceRefs], checks: declaration.requiredCheckIds.map(id => ({ id, result: 'passed' })),
      outcome: 'passed', issuedAt: now });
    assignments.push({ operationId: operation.id, proposalDigest, classification: profile.classification, plannedMinutes: profile.plannedMinutes,
      additionalEpisodes: profile.additionalEpisodes, authority: 'server', authorityReceiptRef: authorityRef });
  }
  const sdkContext = { course: base.server_bundle, baseCourseDigest: base.digest, plan: state.plan, registeredVerifiers: reg.configuration.verifiers };
  const checked = await validateCourseAdaptation(proposal, sdkContext);
  require(checked.valid, checked.issues[0]?.code ?? 'INVALID_ADAPTATION', 409);
  const assigned = await validateAssignmentDecisions(proposal, sdkContext, assignments); require(assigned.valid, assigned.issues[0]?.code ?? 'INVALID_ASSIGNMENTS', 409);
  const verifications: { receipt: ArtifactProofReceipt; profile: AdaptationProfile; evidenceRefs: string[] }[] = [];
  for (const operation of proposal.operations) {
    const profile = selectProfile(reg, selections, operation.id), ports = await checkedPorts(runtime, base.server_bundle, profile, reg);
    const artifact = proposal.artifacts.find(a => a.id === operation.artifactId)!, receipt = proposal.proofReceipts.find(r => r.artifactId === artifact.id)!;
    require(ports.verifier.registration.artifactKinds.includes(artifact.kind), 'VERIFIER_CAPABILITY_MISMATCH', 409);
    const result = parse(z.strictObject({ artifactDigest: hash, checks: z.array(z.strictObject({ id, result: z.enum(['passed','failed']) })).min(1),
      evidenceRefs: z.array(z.string().min(1).max(256)).max(32) }), await bounded(runtime, signal => ports.verifier.verify({
        baseCourseDigest: base.digest, proposalDigest, artifact: structuredClone(artifact), requiredCheckIds: receipt.checks.map(c => c.id),
      }, { signal })));
    require(result.evidenceRefs.length > 0 && result.artifactDigest === artifact.digest && digestJson([...result.checks].sort((a,b) => a.id.localeCompare(b.id)))
      === digestJson([...receipt.checks].sort((a,b) => a.id.localeCompare(b.id))), 'ADAPTATION_VERIFICATION_FAILED', 409);
    verifications.push({ receipt, profile, evidenceRefs: result.evidenceRefs });
  }
  const expiry = new Date(new Date(now).getTime() + reg.configuration.authorizationMinutes * 60000).toISOString();
  const authority: TrustedAuthorization = { receiptRef: authorityRef, enrollmentId: enrollment.id, baseCourseDigest: base.digest, proposalDigest,
    assignmentsDigest: digestJson(assignments), evidenceRevision: context.evidence.revision, evidenceDigest: context.evidence.digest,
    authorizedAt: now, expiresAt: expiry, status: 'active' };
  await client.query(`INSERT INTO adaptation_proposals(id,enrollment_id,workspace_id,course_release_id,registry_revision,proposal_key,base_digest,proposal_digest,
    expected_plan_revision,body,assignments,evidence_fence,authority_ref,created_by,verified_policy_revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [proposalId, enrollment.id, enrollment.workspace_id, base.id, reg.revision, proposal.id, base.digest, proposalDigest, state.plan.revision,
      JSON.stringify(proposal), JSON.stringify(assignments), JSON.stringify(context.evidence), authorityRef, actor.id, context.policy.policyRevision]);
  for (const artifact of proposal.artifacts) await client.query(`INSERT INTO adaptation_artifacts(enrollment_id,artifact_id,proposal_id,artifact_digest,body) VALUES($1,$2,$3,$4,$5)`,
    [enrollment.id, artifact.id, proposalId, artifact.digest, JSON.stringify(artifact)]);
  for (const verification of verifications) {
    const proof: TrustedProof = { enrollmentId: enrollment.id, baseCourseDigest: base.digest, status: 'active',
      authenticationRef: `registry:${base.id}:${reg.revision}:${verification.profile.adapterId}`, receipt: verification.receipt };
    await client.query(`INSERT INTO adaptation_proofs(enrollment_id,receipt_ref,proposal_id,artifact_id,registry_revision,adapter_id,adapter_digest,trusted_record,verification_evidence)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [enrollment.id, verification.receipt.receiptRef, proposalId, verification.receipt.artifactId,
      reg.revision, verification.profile.adapterId, verification.profile.adapterDigest, JSON.stringify(proof), JSON.stringify(verification.evidenceRefs)]);
  }
  await client.query('INSERT INTO adaptation_authorizations(enrollment_id,receipt_ref,proposal_id,trusted_record) VALUES($1,$2,$3,$4)',
    [enrollment.id, authorityRef, proposalId, JSON.stringify(authority)]);
  return { proposalId, proposal, assignments, authorityRef };
}

export async function stageVerifiedAdaptation(db: Database, actor: Actor, raw: CommandInput & { enrollmentId: string; expectedPlanRevision: number;
  proposal: Candidate; profiles: ProfileSelection[] }, runtime: AdaptationRuntime) {
  const input = parse(z.strictObject({ ...commandFields, enrollmentId: z.string().uuid(), proposal: candidateSchema,
    profiles: z.array(z.strictObject({ operationId: id, profileId: id })).min(1).max(64) }), raw);
  try { return await enrollmentCommand(db, actor, input.enrollmentId, 'adaptation.stage', input, async (client, loaded) => {
    await membership(client, actor, loaded.enrollment.workspace_id, ['owner','admin','instructor']);
    require(loaded.enrollment.status === 'active', 'ENROLLMENT_INACTIVE', 409);
    const base = await rawRelease(client, loaded.enrollment), reg = await registry(client, base);
    for (const selection of input.profiles) {
      const profile = reg.configuration.profiles.find(p => p.id === selection.profileId); require(profile, 'PROFILE_BINDING', 409);
      await assertPolicyAction(client, loaded.enrollment.id, profile.episodeId, 'plan', await clock(client));
    }
    const context = await runtimeContext(client, loaded.enrollment, base, reg), state = await loadState(client, loaded.enrollment, context);
    require(input.expectedPlanRevision === state.plan.revision, 'STALE_PLAN', 409);
    const prepared = await prepare(client, loaded.enrollment, actor, base, reg, context, state, input.proposal, input.profiles, runtime);
    await client.query('UPDATE enrollments SET revision=revision+1 WHERE id=$1', [loaded.enrollment.id]);
    await appendEvent(client, { workspaceId: loaded.enrollment.workspace_id, enrollmentId: loaded.enrollment.id, actorId: actor.id, actorKind: 'staff',
      type: 'adaptation.verified', payload: { proposalId: prepared.proposalId, baseCourseDigest: base.digest, planRevision: state.plan.revision },
      idempotencyKey: `adaptation-stage:${loaded.enrollment.id}:${input.idempotencyKey}`, supervise: true });
    return { proposalId: prepared.proposalId, revision: loaded.enrollment.revision + 1, planRevision: state.plan.revision, status: 'verified' as const };
  }, true); } catch (error) { translated(error); }
}

function domainCommand(context: RuntimeContext, state: AdaptationState, key: string, now: string) {
  return { idempotencyKey: key, now, expectedAdaptationRevision: state.ledgerRevision, expectedPolicyRevision: context.policy.policyRevision,
    expectedPolicyLedgerRevision: context.policy.ledgerRevision, expectedRegistryRevision: context.registry.revision, expectedEvidenceRevision: context.evidence.revision };
}
async function applyStored(client: PoolClient, loaded: EnrollmentContext, actor: Actor, proposalId: string, expectedPlanRevision: number, key: string) {
  const enrollment = loaded.enrollment, base = await rawRelease(client, enrollment), reg = await registry(client, base);
  const context = await runtimeContext(client, enrollment, base, reg), before = await loadState(client, enrollment, context);
  require(expectedPlanRevision === before.plan.revision, 'STALE_PLAN', 409);
  const row = (await client.query<ProposalRow>('SELECT * FROM adaptation_proposals WHERE id=$1 AND enrollment_id=$2 FOR UPDATE', [proposalId, enrollment.id])).rows[0];
  require(row, 'ADAPTATION_PROPOSAL_NOT_FOUND', 404); require(row.status === 'verified', 'ADAPTATION_ALREADY_APPLIED', 409);
  require(row.registry_revision === reg.revision, 'STALE_REGISTRY', 409);
  require(row.verified_policy_revision === context.policy.policyRevision, 'STALE_POLICY_REVISION', 409);
  require(row.base_digest === base.digest && row.proposal_digest === await digestAdaptationProposal(row.body), 'PROPOSAL_INTEGRITY', 409);
  require(digestJson(row.evidence_fence) === digestJson(context.evidence), 'STALE_EVIDENCE', 409);
  require(enrollment.status === 'active', 'ENROLLMENT_INACTIVE', 409);
  const admitted = await admitAdaptation(context, before, { ...domainCommand(context, before, `admit-${proposalId}`, await clock(client)),
    admissionId: `admission-${proposalId}`, authorizationRef: row.authority_ref, proposal: row.body, assignments: row.assignments });
  const admittedContext = { ...context, policy: admitted.policy };
  const applied = await applyAdaptation(admittedContext, admitted.state, { ...domainCommand(admittedContext, admitted.state, `apply-${proposalId}`, await clock(client)), admissionId: `admission-${proposalId}` });
  // Enrollment + registry + policy locks have remained held throughout verification.
  // CAS the original policy snapshot, not the intermediate unpersisted reservation.
  require(digestJson(await evidenceFence(client, enrollment, base.digest)) === digestJson(context.evidence), 'STALE_EVIDENCE', 409);
  const policySaved = await client.query(`UPDATE policy_states SET policy_revision=$2,ledger_revision=$3,snapshot=$4,updated_at=clock_timestamp()
    WHERE enrollment_id=$1 AND policy_revision=$5 AND ledger_revision=$6 AND snapshot=$7::jsonb`, [enrollment.id, applied.policy.policyRevision,
    applied.policy.ledgerRevision, JSON.stringify(applied.policy), context.policy.policyRevision, context.policy.ledgerRevision, JSON.stringify(context.policy)]);
  require(policySaved.rowCount === 1, 'STALE_POLICY_REVISION', 409);
  const saved = await client.query(`UPDATE adaptation_states SET ledger_revision=$2,plan_revision=$3,plan_digest=$4,snapshot=$5,updated_at=clock_timestamp()
    WHERE enrollment_id=$1 AND ledger_revision=$6 AND plan_digest=$7 AND snapshot=$8::jsonb`, [enrollment.id, applied.state.ledgerRevision,
    applied.state.plan.revision, applied.state.plan.digest, JSON.stringify(applied.state), before.ledgerRevision, before.plan.digest, JSON.stringify(before)]);
  require(saved.rowCount === 1, 'STALE_ADAPTATION', 409);
  await client.query("UPDATE adaptation_proposals SET status='applied',applied_revision=$3 WHERE id=$1 AND enrollment_id=$2", [proposalId, enrollment.id, applied.state.plan.revision]);
  await client.query('UPDATE enrollments SET revision=revision+1,policy_revision=$2 WHERE id=$1', [enrollment.id, applied.policy.policyRevision]);
  const event = await appendEvent(client, { workspaceId: enrollment.workspace_id, enrollmentId: enrollment.id, actorId: actor.id,
    actorKind: actor.id === enrollment.user_id ? 'learner' : 'staff', type: 'adaptation.applied', payload: { proposalId, baseCourseDigest: base.digest,
      planRevision: applied.state.plan.revision, planDigest: applied.state.plan.digest, artifactDigests: row.body.artifacts.map(a => a.digest) },
    idempotencyKey: `adaptation-apply:${enrollment.id}:${key}`, supervise: true });
  await client.query(`INSERT INTO adaptation_applications(enrollment_id,proposal_id,plan_revision,plan_digest,policy_ledger_revision,event_id,commit_before) VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [enrollment.id, proposalId, applied.state.plan.revision, applied.state.plan.digest, applied.policy.ledgerRevision, event.id, applied.preconditions.mustCommitBefore]);
  const stillEligible = (await client.query<{ eligible: boolean }>('SELECT $1::timestamptz IS NULL OR clock_timestamp()<$1::timestamptz AS eligible', [applied.preconditions.mustCommitBefore])).rows[0]!;
  require(stillEligible.eligible, 'ADAPTATION_COMMIT_DEADLINE', 409);
  return { proposalId, revision: enrollment.revision + 1, baseCourseDigest: base.digest, planRevision: applied.state.plan.revision, planDigest: applied.state.plan.digest,
    eventId: event.id, mustCommitBefore: applied.preconditions.mustCommitBefore };
}

export async function applyVerifiedAdaptation(db: Database, actor: Actor, raw: CommandInput & { enrollmentId: string; proposalId: string; expectedPlanRevision: number }) {
  const input = parse(z.strictObject({ ...commandFields, enrollmentId: z.string().uuid(), proposalId: z.string().uuid() }), raw);
  try { return await enrollmentCommand(db, actor, input.enrollmentId, 'adaptation.apply', input, async (client, loaded) => {
    await membership(client, actor, loaded.enrollment.workspace_id, ['owner','admin','instructor']);
    return applyStored(client, loaded, actor, input.proposalId, input.expectedPlanRevision, input.idempotencyKey);
  }, true); } catch (error) { translated(error); }
}

export interface ResolvedEnrollmentCourse extends Release {
  baseCourseDigest: string; planRevision: number; planDigest: string;
  /** Parent coverage logic must use these author/server decisions for generated blocks,
   * never infer that an optional generated block makes a fixed episode optional. */
  adaptationRequirements: { blockId: string; episodeId: string; classification: 'required'|'optional'; artifactDigest: string; replacesBaseBlock: boolean }[];
}
/** Parent repository/learning/provider integration point. Call with the authenticated
 * enrollment and RAW release, inside its enrollment transaction/read snapshot. Returns
 * Release-shaped server/learner views; digest remains the immutable base digest. Gate
 * thresholds are unchanged; only verified variants of already-listed canonicals join.
 * This never creates evidence, invalidates prior evidence, or republishes the base. */
export async function resolveEnrollmentCourse(client: PoolClient, enrollment: Enrollment, baseRelease: Release): Promise<ResolvedEnrollmentCourse> {
  require(enrollment.course_release_id === baseRelease.id && enrollment.workspace_id === baseRelease.workspace_id
    && digestJson(baseRelease.server_bundle) === baseRelease.digest, 'BASE_COURSE_INTEGRITY', 409);
  const row = (await client.query<StateRow>('SELECT * FROM adaptation_states WHERE enrollment_id=$1', [enrollment.id])).rows[0];
  if (!row) return { ...structuredClone(baseRelease), baseCourseDigest: baseRelease.digest, planRevision: 0, adaptationRequirements: [],
    planDigest: digestJson({ baseCourseDigest: baseRelease.digest, revision: 0 }) };
  const reg = await registry(client, baseRelease, false, false), context = await runtimeContext(client, enrollment, baseRelease, reg, false);
  require(row.base_digest === baseRelease.digest && row.plan_digest === row.snapshot.plan.digest && row.plan_revision === row.snapshot.plan.revision,
    'ADAPTATION_STATE_INTEGRITY', 409);
  const view = await materializeAdaptation(context, row.snapshot);
  const published = (await client.query<{ body: TeachingArtifact; artifact_digest: string; proposal_body: CourseAdaptation; assignments: ActivityAssignmentDecision[]; plan_revision: number }>(
    `SELECT a.body,a.artifact_digest,p.body AS proposal_body,p.assignments,x.plan_revision FROM adaptation_artifacts a
      JOIN adaptation_proposals p ON p.id=a.proposal_id AND p.enrollment_id=a.enrollment_id
      JOIN adaptation_applications x ON x.proposal_id=p.id AND x.enrollment_id=p.enrollment_id
      WHERE a.enrollment_id=$1 AND p.status='applied' ORDER BY x.plan_revision,a.artifact_id`, [enrollment.id])).rows;
  const applied = row.snapshot.admissions.filter(a => a.status === 'applied');
  require(published.length === applied.reduce((n,a) => n + a.proposal.artifacts.length, 0), 'PUBLISHED_ARTIFACT_INTEGRITY', 409);
  for (const record of published) {
    const admission = applied.find(a => a.proposal.id === record.proposal_body.id);
    require(admission && digestJson(admission.proposal) === digestJson(record.proposal_body) && digestJson(admission.assignments) === digestJson(record.assignments)
      && record.body.digest === record.artifact_digest && await digestTeachingArtifact(record.body) === record.artifact_digest
      && record.plan_revision <= row.plan_revision, 'PUBLISHED_ARTIFACT_INTEGRITY', 409);
    for (const receipt of record.proposal_body.proofReceipts.filter(r => r.artifactId === record.body.id)) {
      require(context.registry.proofs.some(p => p.status === 'active' && p.baseCourseDigest === baseRelease.digest && digestJson(p.receipt) === digestJson(receipt)),
        'PUBLISHED_PROOF_INTEGRITY', 409);
    }
  }
  for (const variant of view.variants) {
    const canonical = baseRelease.server_bundle.assessments.find(a => a.id === variant.canonicalAssessmentId)!;
    require(canonical && canonical.familyId === variant.canonicalFamilyId
      && published.some(a => a.body.kind === 'assessment_variant' && a.body.assessment.id === variant.assessmentId && a.artifact_digest === variant.artifactDigest), 'CANONICAL_FAMILY_BINDING', 409);
    for (const gate of view.server.gates) if (gate.assessmentIds.includes(canonical.id) && variant.objectiveIds.every(o => gate.objectiveIds.includes(o))) {
      if (!gate.assessmentIds.includes(variant.assessmentId)) gate.assessmentIds.push(variant.assessmentId);
    }
  }
  const requirements = new Map<string, ResolvedEnrollmentCourse['adaptationRequirements'][number]>();
  for (const assignment of view.assignments) {
    const operation = applied.flatMap(a => a.proposal.operations).find(o => o.id === assignment.operationId)!;
    const blockId = operation.type === 'replace_teaching' ? operation.blockId : operation.id;
    requirements.set(`${assignment.episodeId}/${blockId}`, { blockId, episodeId: assignment.episodeId,
      classification: assignment.decision.classification, artifactDigest: assignment.artifactDigest, replacesBaseBlock: operation.type === 'replace_teaching' });
  }
  return { ...structuredClone(baseRelease), digest: baseRelease.digest, baseCourseDigest: baseRelease.digest,
    planRevision: view.planRevision, planDigest: view.planDigest, server_bundle: view.server, learner_bundle: compileCourse(view.server).learner,
    adaptationRequirements: [...requirements.values()] };
}

export const freshQuestionSchema = z.strictObject({ ...commandFields, enrollmentId: z.string().uuid(), episodeId: id, objectiveId: id, familyId: id,
  mode: z.enum(['independent','practice']), allowAssessmentAssistance: z.boolean().optional() });
export type FreshQuestionInput = z.infer<typeof freshQuestionSchema>;
/** No browser recipe, variable, ordinal, proof, grading, cost, adapter or classification
 * inputs. Selection comes solely from the approved release registry and installed code.
 * Bounded CPU adapters run under the enrollment lock; remote model/plugin execution
 * belongs in the parent's durable pipeline, then stageVerifiedAdaptation. */
export async function requestFreshQuestion(db: Database, actor: Actor, raw: FreshQuestionInput, runtime: AdaptationRuntime) {
  const input = parse(freshQuestionSchema, raw);
  try { return await enrollmentCommand(db, actor, input.enrollmentId, 'adaptation.fresh_question', input, async (client, loaded) => {
    const enrollment = loaded.enrollment; require(enrollment.status === 'active', 'ENROLLMENT_INACTIVE', 409);
    const base = await rawRelease(client, enrollment), reg = await registry(client, base);
    const effective = await resolveEnrollmentCourse(client, enrollment, base), course = effective.server_bundle;
    const episode = requireAvailable(course, base.digest, loaded.progress, loaded.evidence, input.episodeId);
    const current = (enrollment as Enrollment & { current_episode_id?: string | null }).current_episode_id
      ?? learningSnapshot(course, base.digest, loaded.progress, loaded.evidence).nextEpisodeId;
    require(episode.id === current && episode.objectiveIds.includes(input.objectiveId), 'ADAPTATION_OBJECTIVE_OUT_OF_SCOPE', 409);
    const gate = course.gates.find(g => g.id === episode.gateId);
    const profiles = reg.configuration.profiles.filter(p => p.episodeId === episode.id && p.operation === 'add_assessment_variant'
      && base.server_bundle.assessments.some(a => a.id === p.canonicalAssessmentId && a.familyId === input.familyId && a.objectiveIds.includes(input.objectiveId)
        && gate?.assessmentIds.includes(a.id))).sort((a,b) => a.id < b.id ? -1 : 1);
    require(profiles.length, 'APPROVED_FRESH_VARIANT_UNAVAILABLE', 409);
    const profile = profiles[0]!, adapter = installed(runtime, profile);
    require(adapter.kind === 'numeric' || adapter.kind === 'bank', 'ADAPTER_NOT_A_FRESH_CREATOR', 409);
    const eligibleIds = course.assessments.filter(a => a.familyId === input.familyId && a.objectiveIds.includes(input.objectiveId)
      && gate!.assessmentIds.includes(a.id)).map(a => a.id);
    const exposures = (await client.query<{ assessment_id: string }>('SELECT assessment_id FROM assessment_challenges WHERE enrollment_id=$1 AND course_digest=$2', [enrollment.id, base.digest])).rows;
    const failed = (await client.query<{ found: boolean }>(`SELECT EXISTS(SELECT 1 FROM attempts WHERE enrollment_id=$1 AND course_digest=$2 AND family_id=$3
      AND assessment_id=ANY($4::text[]) AND result->'passed'='false'::jsonb) AS found`, [enrollment.id, base.digest, input.familyId, eligibleIds])).rows[0]!.found;
    require(failed || (eligibleIds.length > 0 && eligibleIds.every(id => exposures.some(e => e.assessment_id === id))), 'USE_EXISTING_ASSESSMENT_FIRST', 409);
    const pending = (await client.query<{ id: string }>(`SELECT id FROM assessment_challenges WHERE enrollment_id=$1 AND attempt_id IS NULL
      AND independent_eligible AND expires_at>clock_timestamp() FOR UPDATE`, [enrollment.id])).rows;
    require(!pending.length || input.allowAssessmentAssistance === true, 'ASSESSMENT_HELP_CONSENT_REQUIRED', 409);
    await activateWindows(client, base.server_bundle, enrollment.id, episode.id, await clock(client));
    await assertPolicyAction(client, enrollment.id, episode.id, 'plan', await clock(client));
    const context = await runtimeContext(client, enrollment, base, reg), state = await loadState(client, enrollment, context);
    require(state.plan.revision === input.expectedPlanRevision, 'STALE_PLAN', 409);
    const ports = await checkedPorts(runtime, base.server_bundle, profile, reg); require(ports.generator, 'GENERATOR_NOT_INSTALLED', 503);
    const artifactId = `artifact-${randomUUID()}`, assessmentId = `assessment-${randomUUID()}`;
    let artifact: TeachingArtifact;
    if (adapter.kind === 'numeric') {
      const generated = await bounded(runtime, signal => generateFreshNumericalVariant(base.server_bundle, state, { artifactId, assessmentId,
        canonicalAssessmentId: profile.canonicalAssessmentId!, templateId: profile.templateId!, episodeId: profile.episodeId, startOrdinal: 0, maximumCandidates: 256 },
      ports.generator!, ports.verifier, { signal })); artifact = generated.artifact;
    } else {
      const fingerprint = ({ id: _id, grading: _grading, ...value }: Assessment) => digestJson(value);
      const used = new Set(course.assessments.map(fingerprint));
      const excludedBankIds = profile.bank!.filter(b => used.has(fingerprint(b.assessment))).map(b => b.id);
      const generator = base.server_bundle.adaptation!.generators.find(g => g.id === profile.generatorId)!;
      const draft = await bounded(runtime, signal => ports.generator!.generate({ baseCourseDigest: base.digest, objectiveIds: [input.objectiveId],
        canonicalAssessment: base.server_bundle.assessments.find(a => a.id === profile.canonicalAssessmentId)!, sourceRefs: generator.sourceRefs,
        specification: { artifactId, assessmentId, excludedBankIds } }, { signal }));
      artifact = { ...draft, digest: await digestTeachingArtifact(draft as TeachingArtifact) } as TeachingArtifact;
    }
    require(artifact.kind === 'assessment_variant' && artifact.assessment.id === assessmentId && artifact.id === artifactId, 'GENERATOR_OUTPUT_BINDING', 409);
    const operationId = `operation-${randomUUID()}`;
    const prepared = await prepare(client, enrollment, actor, base, reg, context, state, { schemaVersion: 1, id: `proposal-${randomUUID()}`,
      baseCourseDigest: base.digest, expectedPlanRevision: state.plan.revision, expectedPlanDigest: state.plan.digest,
      rationale: 'Learner requested a fresh verified question within an existing canonical family.', artifacts: [artifact],
      operations: [{ id: operationId, type: 'add_assessment_variant', episodeId: episode.id, artifactId }] }, [{ operationId, profileId: profile.id }], runtime);
    const applied = await applyStored(client, loaded, actor, prepared.proposalId, input.expectedPlanRevision, input.idempotencyKey);
    if (pending.length) {
      await client.query("UPDATE assessment_challenges SET assistance='hint',independent_eligible=false WHERE id=ANY($1::uuid[])", [pending.map(p => p.id)]);
      await appendEvent(client, { workspaceId: enrollment.workspace_id, enrollmentId: enrollment.id, actorId: actor.id, actorKind: 'learner',
        type: 'assessment.assisted', payload: { reason: 'fresh_question_requested', explicitConsent: true, downgradedChallengeIds: pending.map(p => p.id) },
        idempotencyKey: `adaptation-assistance:${enrollment.id}:${input.idempotencyKey}` });
    }
    const challengeId = randomUUID(), independentEligible = input.mode === 'independent' && !exposures.some(e => e.assessment_id === assessmentId);
    await client.query(`INSERT INTO assessment_challenges(id,enrollment_id,episode_id,assessment_id,course_digest,mode,independent_eligible,expires_at,
      adaptation_artifact_digest,adaptation_plan_revision,canonical_assessment_id) VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp()+interval '60 minutes',$8,$9,$10)`,
      [challengeId,enrollment.id,episode.id,assessmentId,base.digest,input.mode,independentEligible,artifact.digest,applied.planRevision,artifact.canonicalAssessmentId]);
    await appendEvent(client, { workspaceId: enrollment.workspace_id, enrollmentId: enrollment.id, actorId: actor.id, actorKind: 'learner',
      type: 'assessment.issued', payload: { challengeId, assessmentId, mode: input.mode, independentEligible, canonicalAssessmentId: artifact.canonicalAssessmentId,
        artifactDigest: artifact.digest, planRevision: applied.planRevision }, idempotencyKey: `adaptation-challenge:${enrollment.id}:${input.idempotencyKey}` });
    return { ...applied, challengeId, question: publicQuestion(artifact.assessment), independentEligible,
      downgradedChallengeIds: pending.map(p => p.id) };
  }); } catch (error) { translated(error); }
}

/** Metadata only: no stored candidate, bank, recipe, key, hidden fixture, verifier
 * receipts or raw learner evidence is sent to a general learner request. */
export async function adaptationSummary(client: PoolClient, enrollment: Enrollment, base: Release) {
  const row = (await client.query<StateRow>('SELECT * FROM adaptation_states WHERE enrollment_id=$1', [enrollment.id])).rows[0];
  const reg = (await client.query<RegistryRow>(`SELECT r.revision,r.status,v.configuration FROM adaptation_registries r
    JOIN adaptation_registry_versions v ON v.course_release_id=r.course_release_id AND v.revision=r.revision WHERE r.course_release_id=$1 AND r.workspace_id=$2`, [base.id, enrollment.workspace_id])).rows[0];
  return { baseCourseDigest: base.digest, planRevision: row?.plan_revision ?? 0,
    planDigest: row?.plan_digest ?? digestJson({ baseCourseDigest: base.digest, revision: 0 }), configured: reg?.status === 'active',
    registryRevision: reg?.revision ?? 0, approvedFamilies: reg?.status === 'active' ? reg.configuration.profiles.filter(p => p.operation === 'add_assessment_variant').map(p => {
      const a = base.server_bundle.assessments.find(a => a.id === p.canonicalAssessmentId)!;
      return { episodeId: p.episodeId, objectiveIds: a.objectiveIds, familyId: a.familyId };
    }) : [] };
}
