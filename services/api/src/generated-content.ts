import type { PoolClient } from 'pg';
import type { Assessment, CourseManifest, Json, TeachingArtifactDraft, VisualExperience } from '@course-core/sdk';
import type { Case } from '@course-core/sandbox';
import { checkFrame, evaluate, flattenNodes, fromVisualExperience, layoutModes, parseScene, runSceneChecks, toVisualExperience,
  type Scene } from '@course-core/visuals/headless';
import { ApiError, requireCondition } from './errors.js';
import { digestJson } from './repository.js';
import { declarationMatchesInstalled } from './extension-identity.js';
import { codeView } from './gates.js';
import { generatedFixtureRef, isGeneratedFixtureRef, qualifiedCodeEvaluator, qualifiedGeneratedCodeEvaluator } from './code-evaluator.js';
import type { GeneratedTeachingInput, GeneratedTeachingSelection, SceneModelBinding } from './generated-teaching.js';
import type { RuntimeExtension } from './publication.js';

/**
 * Generated interactive content: simulations, check questions and code exercises the supervisor
 * writes for one learner (requirements E01, E04, E05). The model supplies a candidate; the host
 * builds the SDK artifact and owns every check below, on top of the course's own installed
 * verifier and the accessibility check. A failure is feedback the supervisor can repair; nothing
 * reaches a learner, or counts towards mastery, until every check passes at delivery.
 *
 * - A simulation is data in the released scene contract (packages/visuals), never code. It runs
 *   in the installed renderer only, must pass the renderer's own publication checks and must
 *   declare at least one invariant tying its representations together.
 * - A check question's answer key is never the model's: the host derives it from the scene the
 *   question names (a formula value, trace-table cell or node property at a stated model state),
 *   after the scene's invariants hold at that state. A key the model claims is only compared.
 * - A code exercise's hidden tests are run in the installed isolated grader (the networkless,
 *   read-only Docker sandbox) against the generated reference, which must pass, and against the
 *   starter and every wrong solution, which must fail. Generated code never runs in the API
 *   process or in the learner's page.
 */

export const MODEL_CHECK_ID = 'host-model-agreement';
export const ANSWER_KEY_CHECK_ID = 'host-answer-key';
export const CODE_REFERENCE_CHECK_ID = 'host-code-reference';
export type ContentProblem =
  | 'scene_invalid' | 'renderer_unavailable' | 'render_feature_unsupported' | 'no_model_invariant' | 'model_invariant_failed'
  | 'model_unknown_visual' | 'model_state_invalid' | 'model_read_invalid' | 'answer_key_diverges' | 'prompt_missing_inputs'
  | 'canonical_mismatch' | 'objective_scope' | 'code_runner_unavailable' | 'code_fixture_mismatch' | 'reference_failed'
  | 'starter_passes' | 'wrong_solution_passes';
type Kind = 'simulation' | 'check_item' | 'code_exercise';
type Input<K extends Kind> = Extract<GeneratedTeachingInput, { kind: K }>;
type Artifact = GeneratedTeachingSelection['artifact'];
type Common = { id: string; objectiveIds: string[]; sourceRefs: string[]; generator: { id: string; version: string } };
export type DraftResult = { draft: TeachingArtifactDraft } | { problems: ContentProblem[] };

const NUMERIC_TYPES = new Set(['numeric', 'prediction']);
const sameIds = (a: readonly string[], b: readonly string[]) => digestJson([...a].sort()) === digestJson([...b].sort());
/** Whether a numeric item's key accepts `value`, with the canonical item's tolerances. */
function accepts(grading: { expected: number; absoluteTolerance: number; relativeTolerance?: number }, value: number) {
  const allowed = Math.max(grading.absoluteTolerance, (grading.relativeTolerance ?? 0) * Math.abs(grading.expected));
  return Math.abs(value - grading.expected) <= allowed + 1e-12;
}
/** Twelve significant digits: a key derived on any platform is the same number. */
const stable = (value: number) => Number(value.toPrecision(12));
const sceneId = (artifactId: string) => `${artifactId}--scene`;

// ------------------------------------------------------------------- the common model (E04)

/** The scene a binding names, with its model state set to the binding's state. */
function modelAt(course: CourseManifest, model: SceneModelBinding): { scene: Scene; visual: VisualExperience } | ContentProblem {
  const visual = course.visuals.find(v => v.id === model.visualId);
  if (!visual) return 'model_unknown_visual';
  let scene: Scene;
  try { scene = fromVisualExperience(visual); } catch { return 'model_unknown_visual'; }
  if (!scene.invariants?.length) return 'no_model_invariant';
  const json = JSON.parse(JSON.stringify(scene)) as { state: Record<string, { kind: string; initial: unknown; min?: number; max?: number; options?: unknown[] }> };
  for (const [name, value] of Object.entries(model.state)) {
    const field = Object.hasOwn(json.state, name) ? json.state[name] : undefined;
    if (!field) return 'model_state_invalid';
    const ok = field.kind === 'number' ? typeof value === 'number' && (field.min === undefined || value >= field.min) && (field.max === undefined || value <= field.max)
      : field.kind === 'boolean' ? typeof value === 'boolean'
        : field.kind === 'enum' && Array.isArray(field.options) && field.options.includes(value);
    if (!ok) return 'model_state_invalid';
    field.initial = value;
  }
  try { return { scene: parseScene(json), visual }; } catch { return 'model_state_invalid'; }
}
/**
 * The answer the course's own model gives for a binding. The scene's invariants must hold at the
 * bound state first, at every layout: a question cannot be keyed from a state where its visual,
 * formula and trace disagree (a contradictory-representations scene is refused here).
 */
export function modelAnswer(course: CourseManifest, model: SceneModelBinding): { value: number; visualDigest: string } | { problem: ContentProblem } {
  const at = modelAt(course, model);
  if (typeof at === 'string') return { problem: at };
  const { scene, visual } = at;
  if ((model.atMs ?? 0) > scene.timeline.durationMs) return { problem: 'model_read_invalid' };
  // Goldens pin the authored initial frame, not this state; only the invariants speak for the model.
  if (runSceneChecks(scene).some(f => f.check === 'invariant')) return { problem: 'model_invariant_failed' };
  try {
    const frame = checkFrame(scene, layoutModes(scene)[0]!, model.atMs ?? 0);
    const context = { state: frame.state, timeMs: frame.timeMs, seed: scene.simulation?.seed ?? 1,
      tick: scene.simulation ? Math.floor(frame.timeMs / scene.simulation.stepMs) : 0, budget: { remaining: 50_000 } };
    const read = model.read;
    let value: unknown;
    if ('value' in read) {
      const pane = scene.panes?.find(p => p.id === read.value.pane);
      const row = pane?.kind === 'formula' ? pane.values?.find(v => v.symbol === read.value.symbol) : undefined;
      value = row ? evaluate(row.value, context) : undefined;
    } else if ('cell' in read) {
      const pane = scene.panes?.find(p => p.id === read.cell.pane);
      const cell = pane?.kind === 'table' ? pane.rows[read.cell.row]?.[read.cell.column] : undefined;
      value = cell === undefined ? undefined : evaluate(cell, context);
    } else {
      const node = flattenNodes(frame.nodes).find(n => n.id === read.node && n.visible);
      value = node ? (node as unknown as Record<string, unknown>)[read.property] : undefined;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) return { problem: 'model_read_invalid' };
    return { value: stable(value), visualDigest: digestJson(visual) };
  } catch { return { problem: 'model_read_invalid' }; }
}

// ------------------------------------------------------------------- building candidates

/** A simulation candidate as the SDK visual artifact the installed renderer draws. */
export function simulationDraft(input: Input<'simulation'>, common: Common): DraftResult {
  try {
    // The host names the scene; a model cannot collide with or shadow a course visual.
    const visual = toVisualExperience(parseScene({ ...input.scene, id: sceneId(common.id) }));
    return { draft: { ...common, kind: 'visual', visual } };
  } catch { return { problems: ['scene_invalid'] }; }
}
const variantBase = (canonical: Assessment, id: string, prompt: string) => ({ id, objectiveIds: [...canonical.objectiveIds], familyId: canonical.familyId, prompt,
  // Declared misconceptions and roles describe the author's item; a generated variant claims neither.
  ...(canonical.allowAbstain !== undefined ? { allowAbstain: canonical.allowAbstain } : {}),
  ...(canonical.confidence ? { confidence: structuredClone(canonical.confidence) } : {}) });
/** A check question keyed by the course's model. `course` is the learner's delivered course. */
export function checkItemDraft(input: Input<'check_item'>, common: Common, course: CourseManifest, canonical: Assessment): DraftResult {
  if (!NUMERIC_TYPES.has(canonical.type)) return { problems: ['canonical_mismatch'] };
  if (!sameIds(input.objectiveIds, canonical.objectiveIds)) return { problems: ['objective_scope'] };
  const derived = modelAnswer(course, input.model);
  if ('problem' in derived) return { problems: [derived.problem] };
  const grading = canonical.grading as { absoluteTolerance: number; relativeTolerance?: number; unit?: string };
  const assessment = { ...variantBase(canonical, `${common.id}--item`, input.prompt), type: canonical.type,
    grading: { expected: derived.value, absoluteTolerance: grading.absoluteTolerance,
      ...(grading.relativeTolerance !== undefined ? { relativeTolerance: grading.relativeTolerance } : {}),
      ...(grading.unit !== undefined ? { unit: grading.unit } : {}), explanation: input.explanation } } as Assessment;
  const hiddenFixtures = { protocol: 'scene-model-v1', model: input.model, visualDigest: derived.visualDigest,
    ...(input.answer !== undefined ? { claimedAnswer: input.answer } : {}) } as unknown as Json;
  const draft = { ...common, objectiveIds: [...canonical.objectiveIds], kind: 'assessment_variant' as const, canonicalAssessmentId: canonical.id, assessment, hiddenFixtures };
  // A claimed key that disagrees, or a prompt missing a number the key depends on, is fed back at once.
  const checked = answerKeyChecks({ ...draft, digest: '' }, course);
  return checked.problems.length ? { problems: checked.problems } : { draft };
}
/** A code exercise of the canonical item's language, graded by its installed evaluator. */
export function codeExerciseDraft(input: Input<'code_exercise'>, common: Common, canonical: Assessment): DraftResult {
  if (canonical.type !== 'code') return { problems: ['canonical_mismatch'] };
  if (!sameIds(input.objectiveIds, canonical.objectiveIds)) return { problems: ['objective_scope'] };
  const cases = input.tests.map(c => ({ id: c.id, input: (c.input ?? null) as Json, expected: (c.expected ?? null) as Json }));
  const assessment = { ...variantBase(canonical, `${common.id}--item`, input.prompt), type: 'code', language: canonical.language, starterCode: input.starterCode,
    grading: { evaluatorId: canonical.grading.evaluatorId, fixtureRef: generatedFixtureRef(cases) } } as Assessment;
  // Hidden tests and solutions stay in server data; the learner bundle carries only the item.
  const hiddenFixtures = { protocol: 'generated-code-v1', cases, referenceSolution: input.referenceSolution, wrongSolutions: input.wrongSolutions } as unknown as Json;
  return { draft: { ...common, objectiveIds: [...canonical.objectiveIds], kind: 'assessment_variant', canonicalAssessmentId: canonical.id, assessment, hiddenFixtures } };
}

// ------------------------------------------------------------------- host checks

export interface ContentCheck { failedCheckIds: string[]; problems: ContentProblem[] }
export interface ContentCheckContext {
  /** The learner's delivered course: base course plus applied personal changes. */
  course: CourseManifest;
  installed: readonly RuntimeExtension[];
  signal?: AbortSignal | undefined;
}
/** The host's content checks for one generated artifact (none for text, which has its own). */
export async function generatedContentChecks(artifact: Artifact, context: ContentCheckContext): Promise<ContentCheck> {
  if (artifact.kind === 'visual') return visualChecks(artifact.visual, context);
  if (artifact.kind !== 'assessment_variant') return { failedCheckIds: [], problems: [] };
  const fixtures = artifact.hiddenFixtures as { protocol?: unknown };
  if (fixtures.protocol === 'scene-model-v1') return answerKeyChecks(artifact, context.course);
  if (fixtures.protocol === 'generated-code-v1') return codeChecks(artifact, context);
  return { failedCheckIds: [ANSWER_KEY_CHECK_ID], problems: ['canonical_mismatch'] };
}
const failed = (id: string, problems: ContentProblem[]): ContentCheck => problems.length ? { failedCheckIds: [id], problems } : { failedCheckIds: [], problems: [] };

function visualChecks(visual: VisualExperience, { course, installed }: ContentCheckContext): ContentCheck {
  const declaration = course.extensions.find(e => e.id === visual.rendererId), adapter = installed.find(e => e.id === visual.rendererId);
  if (!declaration || !adapter?.validateVisual || !declarationMatchesInstalled(declaration, adapter) || !declaration.capabilities.includes('visual.render'))
    return failed(MODEL_CHECK_ID, ['renderer_unavailable']);
  let scene: Scene;
  try { scene = fromVisualExperience(visual); } catch { return failed(MODEL_CHECK_ID, ['scene_invalid']); }
  if (!scene.invariants?.length) return failed(MODEL_CHECK_ID, ['no_model_invariant']);
  // The renderer's own publication check: runtime at every layout, reduced motion, invariants, goldens.
  try { adapter.validateVisual(visual); } catch (error) {
    return failed(MODEL_CHECK_ID, [(error as { code?: unknown })?.code === 'INVARIANT_FAILED' ? 'model_invariant_failed' : 'scene_invalid']);
  }
  const required = adapter.visualFeatures?.(visual) ?? [], supported = adapter.renderFeatures?.({ version: declaration.version, integrity: declaration.integrity }) ?? [];
  return failed(MODEL_CHECK_ID, required.every(f => supported.includes(f)) ? [] : ['render_feature_unsupported']);
}

function answerKeyChecks(artifact: Extract<Artifact, { kind: 'assessment_variant' }>, course: CourseManifest): ContentCheck {
  const fixtures = artifact.hiddenFixtures as { model?: SceneModelBinding; visualDigest?: string; claimedAnswer?: number };
  const assessment = artifact.assessment;
  if (!NUMERIC_TYPES.has(assessment.type) || !fixtures.model) return failed(ANSWER_KEY_CHECK_ID, ['canonical_mismatch']);
  const grading = assessment.grading as { expected: number; absoluteTolerance: number; relativeTolerance?: number };
  // Derived again from the course as it is now: a model that changed since the key was made fails.
  const derived = modelAnswer(course, fixtures.model);
  if ('problem' in derived) return failed(ANSWER_KEY_CHECK_ID, [derived.problem]);
  const problems: ContentProblem[] = [];
  if (derived.visualDigest !== fixtures.visualDigest || !accepts(grading, derived.value) || !accepts({ ...grading, expected: derived.value }, grading.expected))
    problems.push('answer_key_diverges');
  if (fixtures.claimedAnswer !== undefined && !accepts({ ...grading, expected: derived.value }, fixtures.claimedAnswer)) problems.push('answer_key_diverges');
  // The question states every number the answer depends on, so it can be answered from the prompt.
  if (Object.values(fixtures.model.state).some(v => typeof v === 'number' && !new RegExp(`(^|[^0-9.])${String(v).replace(/[.+-]/g, c => '\\' + c)}([^0-9]|\\.(?![0-9])|$)`).test(assessment.prompt)))
    problems.push('prompt_missing_inputs');
  return failed(ANSWER_KEY_CHECK_ID, [...new Set(problems)]);
}

async function codeChecks(artifact: Extract<Artifact, { kind: 'assessment_variant' }>, { course, installed, signal }: ContentCheckContext): Promise<ContentCheck> {
  const fixtures = artifact.hiddenFixtures as { cases?: Case[]; referenceSolution?: string; wrongSolutions?: string[] };
  const view = codeView(course, artifact.assessment);
  if (!view || !fixtures.cases || !fixtures.referenceSolution || !fixtures.wrongSolutions?.length) return failed(CODE_REFERENCE_CHECK_ID, ['canonical_mismatch']);
  if (!isGeneratedFixtureRef(view.grading.fixtureRef) || view.grading.fixtureRef !== generatedFixtureRef(fixtures.cases)) return failed(CODE_REFERENCE_CHECK_ID, ['code_fixture_mismatch']);
  let grade: ReturnType<typeof qualifiedGeneratedCodeEvaluator>;
  try { grade = qualifiedGeneratedCodeEvaluator(view, course.extensions, installed); } catch { return failed(CODE_REFERENCE_CHECK_ID, ['code_runner_unavailable']); }
  const run = async (source: string) => {
    if (signal?.aborted) throw new ApiError(409, 'ADAPTATION_CANCELLED');
    return (await grade(view, fixtures.cases!, source)).passed;
  };
  const problems: ContentProblem[] = [];
  try {
    if (!await run(fixtures.referenceSolution)) problems.push('reference_failed');
    // Hidden tests a blank or wrong program passes would grade nothing.
    if (view.starterCode.trim() && await run(view.starterCode)) problems.push('starter_passes');
    for (const wrong of fixtures.wrongSolutions) if (await run(wrong)) { problems.push('wrong_solution_passes'); break; }
  } catch (error) {
    if (error instanceof ApiError && error.code === 'ADAPTATION_CANCELLED') throw error;
    return failed(CODE_REFERENCE_CHECK_ID, ['code_runner_unavailable']);
  }
  return failed(CODE_REFERENCE_CHECK_ID, problems);
}

// ------------------------------------------------------------------- safe boundary (E03)

export type BoundaryReason = 'attempt_in_progress' | 'activity_in_progress';
/**
 * The rule for when a personal change may land in a lesson (E03). Inserting a whole lesson after
 * the current one is a clearly marked insertion and is always safe: it never changes the lesson
 * the learner is in. Anything added to a lesson waits while the learner is mid-attempt there:
 * an issued, unanswered and unexpired question, or an activity they changed in the last ten
 * minutes and have not finished. Additions only ever append, so the learner's place, read parts,
 * code drafts and activity state are kept when they land.
 */
export async function safeBoundary(client: PoolClient, enrollmentId: string, episodeId: string, operation: string): Promise<{ safe: true } | { safe: false; reason: BoundaryReason }> {
  if (operation === 'insert_episode') return { safe: true };
  const attempt = await client.query("SELECT 1 FROM assessment_challenges WHERE enrollment_id=$1 AND episode_id=$2 AND attempt_id IS NULL AND expires_at>clock_timestamp() LIMIT 1",
    [enrollmentId, episodeId]);
  if (attempt.rowCount) return { safe: false, reason: 'attempt_in_progress' };
  const activity = await client.query(`SELECT 1 FROM activity_instances WHERE enrollment_id=$1 AND episode_id=$2 AND satisfied_at IS NULL AND state_revision>1
    AND updated_at>clock_timestamp()-interval '10 minutes' LIMIT 1`, [enrollmentId, episodeId]);
  if (activity.rowCount) return { safe: false, reason: 'activity_in_progress' };
  return { safe: true };
}

// ------------------------------------------------------------------- grading generated exercises

/** Whether this host can grade a code item now: its installed evaluator, offering generated tests when the item is generated. */
export function requireCodeEvaluator(code: Assessment, course: CourseManifest, installed: RuntimeExtension[]) {
  if (code.type === 'code' && isGeneratedFixtureRef(code.grading.fixtureRef)) qualifiedGeneratedCodeEvaluator(code, course.extensions, installed);
  else qualifiedCodeEvaluator(code, course.extensions, installed);
}
/** Grades a code answer with the item's installed evaluator. A generated exercise is graded on the
 * hidden tests verified and stored with it for this enrollment, never on anything the answer sends. */
export async function gradeCodeAnswer(client: PoolClient, enrollmentId: string, code: Assessment, answer: unknown, course: CourseManifest, installed: RuntimeExtension[]) {
  if (code.type !== 'code' || !isGeneratedFixtureRef(code.grading.fixtureRef)) return qualifiedCodeEvaluator(code, course.extensions, installed)(code, answer);
  const grade = qualifiedGeneratedCodeEvaluator(code, course.extensions, installed);
  const row = (await client.query<{ cases: Case[] | null }>(`SELECT a.body->'hiddenFixtures'->'cases' AS cases FROM adaptation_artifacts a
    JOIN adaptation_proposals p ON p.id=a.proposal_id AND p.enrollment_id=a.enrollment_id
    WHERE a.enrollment_id=$1 AND p.status='applied' AND a.body->>'kind'='assessment_variant' AND a.body->'assessment'->>'id'=$2 LIMIT 1`, [enrollmentId, code.id])).rows[0];
  requireCondition(row?.cases && generatedFixtureRef(row.cases) === code.grading.fixtureRef, 'CODE_FIXTURE_NOT_FOUND', 409);
  return grade(code, row.cases, answer);
}

// ------------------------------------------------------------------- what a profile creates

export type Creates = 'teaching_block' | 'episode' | 'simulation' | 'check_item' | 'code_exercise';
/** What a generated-teaching profile lets the supervisor create, from its approved operation. */
export function profileCreates(profile: { operation: string; canonicalAssessmentId?: string | undefined }, course: CourseManifest): Creates {
  if (profile.operation === 'insert_episode') return 'episode';
  if (profile.operation === 'attach_visual') return 'simulation';
  if (profile.operation === 'add_assessment_variant')
    return course.assessments.find(a => a.id === profile.canonicalAssessmentId)?.type === 'code' ? 'code_exercise' : 'check_item';
  return 'teaching_block';
}
/** The candidate kinds a profile accepts, and the SDK artifact kind each becomes. */
export const CREATES_INPUT: Record<Creates, readonly GeneratedTeachingInput['kind'][]> = {
  teaching_block: ['explanation', 'practice'], episode: ['episode'], simulation: ['simulation'], check_item: ['check_item'], code_exercise: ['code_exercise'],
};
export const sdkKind = (kind: GeneratedTeachingInput['kind']) =>
  kind === 'simulation' ? 'visual' : kind === 'check_item' || kind === 'code_exercise' ? 'assessment_variant' : kind;
/**
 * The scenes of a lesson a generated question may be keyed by, described by structure only: the
 * model state it can set (with bounds) and the reads it can name. Values and keys are never listed.
 * Only scenes whose invariants tie their representations together can key a question.
 */
export function sceneModels(course: CourseManifest, episodeId: string) {
  const episode = course.chapters.flatMap(c => c.episodes).find(e => e.id === episodeId);
  const models = [];
  for (const block of episode?.blocks ?? []) {
    if (block.type !== 'visual' || models.length >= 4) continue;
    const visual = course.visuals.find(v => v.id === block.visualId);
    let scene: Scene;
    try { if (!visual) continue; scene = fromVisualExperience(visual); } catch { continue; }
    if (!scene.invariants?.length) continue;
    models.push({ visualId: visual.id, title: scene.title.slice(0, 200), durationMs: scene.timeline.durationMs,
      state: Object.entries(scene.state).slice(0, 16).map(([name, field]) => ({ name, label: field.label.slice(0, 120),
        ...(typeof field.initial === 'number' ? { type: 'number', min: (field as { min?: number }).min, max: (field as { max?: number }).max }
          : typeof field.initial === 'boolean' ? { type: 'boolean' } : { type: 'enum', options: ((field as { options?: string[] }).options ?? []).slice(0, 16) }) })),
      formulas: (scene.panes ?? []).flatMap(p => p.kind === 'formula' ? [{ pane: p.id, symbols: (p.values ?? []).map(v => v.symbol).slice(0, 16) }] : []).slice(0, 8),
      tables: (scene.panes ?? []).flatMap(p => p.kind === 'table' ? [{ pane: p.id, columns: p.columns.slice(0, 16), rows: p.rows.length }] : []).slice(0, 8) });
  }
  return models;
}
/** Builds the SDK artifact draft for a candidate under its profile. `course` is the learner's
 * delivered course (for the scene a question is keyed by); `canonical` the profile's item. */
export function generatedDraft(input: GeneratedTeachingInput, common: Common, course: CourseManifest, canonical: Assessment | undefined): DraftResult {
  if (input.kind === 'simulation') return simulationDraft(input, common);
  if (input.kind === 'check_item') return canonical ? checkItemDraft(input, common, course, canonical) : { problems: ['canonical_mismatch'] };
  if (input.kind === 'code_exercise') return canonical ? codeExerciseDraft(input, common, canonical) : { problems: ['canonical_mismatch'] };
  if (input.kind === 'episode')
    return { draft: { ...common, kind: 'episode', title: input.title, blocks: input.blocks.map((b, i) => ({ id: `${common.id}--part-${i + 1}`, markdown: b.markdown })) } };
  return { draft: { ...common, kind: input.kind, markdown: input.markdown } };
}
