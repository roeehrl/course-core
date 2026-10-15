import type { Assessment, CourseManifest, Episode } from '@course-core/sdk';
import { getEpisodeRequirement } from '@course-core/sdk';
import { ApiError, requireCondition } from './errors.js';
import { evaluateGate, gateObjectives, reviewedRubric, type AttemptSignal, type DecisionContext, type Gate, type GateEvidence } from './gates.js';

export type EvidenceRow = GateEvidence;
export interface ProgressRow { episode_id: string; state: 'started' | 'completed' | 'placed'; completed_block_ids: string[]; evidence_refs: string[]; gate_decision_id?: string | null;
  /** Set when a staff exception authorized the completion: the grant, and the course version it was granted for. */
  gate_exception_id?: string | null; exception_course_digest?: string | null }
export const episodes = (course: CourseManifest) => course.chapters.flatMap(chapter => chapter.episodes);
export function coreObjectiveIds(course: CourseManifest) {
  return [...new Set([...episodes(course).filter(episode => getEpisodeRequirement(episode) === 'required').flatMap(episode => episode.objectiveIds), ...course.objectives.filter(objective => objective.critical).map(objective => objective.id)])];
}

/** Gate readiness for either gate shape; see evaluateGate. */
export function gateDecision(course: CourseManifest, gate: Gate, evidence: readonly EvidenceRow[], digest: string, context: DecisionContext = {}) {
  return evaluateGate(course, gate, evidence, digest, context);
}
export interface SnapshotContext { signals?: readonly AttemptSignal[]; policyRevision?: number; capReached?: (episodeId: string) => boolean }

export function learningSnapshot(course: CourseManifest, digest: string, progress: ProgressRow[], evidence: EvidenceRow[], context: SnapshotContext = {}) {
  let unlocked = true;
  const decisionContext = (episodeId: string): DecisionContext => ({ ...(context.signals ? { signals: context.signals } : {}),
    policyRevision: context.policyRevision ?? 0, capReached: context.capReached?.(episodeId) ?? false });
  const demonstrated = new Set(course.gates.flatMap(gate => gateDecision(course, gate, evidence, digest).objectives.filter(objective => objective.passed).map(objective => objective.id)));
  // A staff exception lets the learner advance past one checkpoint on this course version. Its
  // objectives are waived as prerequisites only; they are never counted as demonstrated.
  const excepted = (record: ProgressRow | undefined) => Boolean(record && record.state === 'completed' && record.gate_exception_id && record.exception_course_digest === digest);
  const waived = new Set(episodes(course).flatMap(episode => {
    const gate = episode.gateId ? course.gates.find(row => row.id === episode.gateId) : undefined;
    return gate && excepted(progress.find(row => row.episode_id === episode.id)) ? gateObjectives(gate) : [];
  }));
  const lessons = episodes(course).map(episode => {
    const record = progress.find(row => row.episode_id === episode.id);
    const gate = course.gates.find(row => row.id === episode.gateId);
    const decision = gate ? gateDecision(course, gate, evidence, digest, decisionContext(episode.id)) : null;
    // Evidence revocation must lock downstream lessons even if old coverage rows remain.
    const requirement = getEpisodeRequirement(episode);
    const prerequisites = course.objectives.filter(objective => episode.objectiveIds.includes(objective.id)).flatMap(objective => objective.prerequisites).filter(id => !episode.objectiveIds.includes(id));
    const ready = unlocked && prerequisites.every(id => demonstrated.has(id) || waived.has(id));
    const credited = Boolean(record && ['completed', 'placed'].includes(record.state) && (!gate || decision?.passed || excepted(record)) && ready);
    const status = credited ? record!.state : ready ? 'available' : 'locked';
    const value = { id: episode.id, requirement, status, completedBlockIds: record?.completed_block_ids ?? [], gate: decision, ...(credited && excepted(record) ? { exception: true } : {}) };
    if (requirement === 'required' && !credited) unlocked = false;
    return value;
  });
  const required = lessons.filter(lesson => lesson.requirement === 'required');
  return { lessons, complete: required.length > 0 && required.every(row => row.status === 'completed' || row.status === 'placed'),
    nextEpisodeId: required.find(row => row.status === 'available')?.id ?? null };
}

export function requireAvailable(course: CourseManifest, digest: string, progress: ProgressRow[], evidence: EvidenceRow[], episodeId: string): Episode {
  const episode = episodes(course).find(row => row.id === episodeId);
  requireCondition(episode, 'EPISODE_NOT_FOUND', 404);
  const state = learningSnapshot(course, digest, progress, evidence).lessons.find(row => row.id === episodeId);
  requireCondition(state && state.status !== 'locked', 'PREREQUISITE_NOT_READY', 409);
  return episode;
}

/** The learner-visible question: never a key, family, role, misconception link or tolerance. */
export function publicQuestion(assessment: Assessment, course?: CourseManifest) {
  const { grading: _private, familyId: _family, role: _role, misconceptionIds: _misconceptions, ...question } = assessment;
  const common = { ...question, allowAbstain: assessment.allowAbstain !== false };
  // Rubric criteria are the visible success requirements, not a hidden key.
  if (assessment.type === 'rubric')
    return { ...common, criteria: assessment.grading.rubric.map(({ id, description, required }) => ({ id, description, required })) };
  if (assessment.type === 'counterexample' || assessment.type === 'experiment_design' || assessment.type === 'teach_back')
    return { ...common, criteria: (course && reviewedRubric(course, assessment.id)?.criteria) ?? [] };
  // A distractor's misconception link would reveal that it is wrong.
  if (assessment.type === 'choice') return { ...common, options: assessment.options.map(({ id, text }) => ({ id, text })) };
  if ((assessment.type === 'numeric' || assessment.type === 'prediction') && assessment.grading.unit !== undefined) return { ...common, unit: assessment.grading.unit };
  return common;
}

const numericPasses = (answer: number, grading: { expected: number; absoluteTolerance: number; relativeTolerance?: number }) =>
  Math.abs(answer - grading.expected) <= Math.max(grading.absoluteTolerance, (grading.relativeTolerance ?? 0) * Math.abs(grading.expected));
const traceForms = { exact: (v: string) => v, case_insensitive: (v: string) => v.trim().toLowerCase(), normalized_whitespace: (v: string) => v.trim().replace(/\s+/g, ' ') };

export interface DeterministicGrade { passed: boolean; explanation: string; evaluator: string; misconceptionIds?: string[]; steps?: { stepId: string; correct: boolean }[] }
/** Author-keyed items scored on the server. A distractor tied to a declared misconception records
 * that signal; it is diagnostic data for the gate, never a penalty on its own. */
export function gradeDeterministic(assessment: Assessment, answer: unknown): DeterministicGrade {
  if (assessment.type === 'choice') {
    requireCondition(typeof answer === 'string' && assessment.options.some(option => option.id === answer), 'INVALID_ANSWER');
    const chosen = assessment.options.find(option => option.id === answer)!;
    return { passed: answer === assessment.grading.correctOptionId, explanation: assessment.grading.explanation, evaluator: 'deterministic-choice@1',
      ...(chosen.misconceptionId && answer !== assessment.grading.correctOptionId ? { misconceptionIds: [chosen.misconceptionId] } : {}) };
  }
  if (assessment.type === 'numeric' || assessment.type === 'prediction') {
    requireCondition(typeof answer === 'number' && Number.isFinite(answer), 'INVALID_ANSWER');
    return { passed: numericPasses(answer, assessment.grading), explanation: assessment.grading.explanation,
      evaluator: assessment.type === 'numeric' ? 'deterministic-numeric@1' : 'deterministic-prediction@1' };
  }
  if (assessment.type === 'trace') {
    requireCondition(answer && typeof answer === 'object' && !Array.isArray(answer), 'INVALID_ANSWER');
    const values = answer as Record<string, unknown>, ids = assessment.steps.map(step => step.id);
    requireCondition(Object.keys(values).length === ids.length && ids.every(id => typeof values[id] === 'string' && (values[id] as string).length <= 2000), 'INVALID_ANSWER');
    const form = traceForms[assessment.grading.match];
    const steps = assessment.grading.expected.map(key => ({ stepId: key.stepId, correct: form(values[key.stepId] as string) === form(key.answer) }));
    return { passed: steps.every(step => step.correct), explanation: assessment.grading.explanation, evaluator: 'deterministic-trace@1', steps };
  }
  throw new ApiError(409, 'EVALUATOR_NOT_CONFIGURED');
}
