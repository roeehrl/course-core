import type { Assessment, CourseManifest, Episode, ProgressionGate } from '@course-core/sdk';
import { getEpisodeRequirement } from '@course-core/sdk';
import { ApiError, requireCondition } from './errors.js';

export interface EvidenceRow {
  id: string; objective_id: string; family_id: string; assessment_id: string;
  independent: boolean; course_digest: string; result: { passed: boolean };
  mode?: string;
}
export interface ProgressRow { episode_id: string; state: 'started' | 'completed' | 'placed'; completed_block_ids: string[]; evidence_refs: string[] }
export const episodes = (course: CourseManifest) => course.chapters.flatMap(chapter => chapter.episodes);
export function coreObjectiveIds(course: CourseManifest) {
  return [...new Set([...episodes(course).filter(episode => getEpisodeRequirement(episode) === 'required').flatMap(episode => episode.objectiveIds), ...course.objectives.filter(objective => objective.critical).map(objective => objective.id)])];
}

export function gateDecision(gate: ProgressionGate, evidence: EvidenceRow[], digest: string) {
  const relevant = evidence.filter(row => row.independent && row.result.passed && row.course_digest === digest && gate.assessmentIds.includes(row.assessment_id));
  const objectives = gate.objectiveIds.map(id => {
    const rows = relevant.filter(row => row.objective_id === id);
    const families = [...new Set(rows.map(row => row.family_id))];
    return { id, families, required: gate.minimumIndependentFamilies, passed: families.length >= gate.minimumIndependentFamilies, evidenceIds: rows.map(row => row.id) };
  });
  return { passed: gate.requireAllObjectives ? objectives.every(row => row.passed) : objectives.some(row => row.passed), objectives };
}

export function learningSnapshot(course: CourseManifest, digest: string, progress: ProgressRow[], evidence: EvidenceRow[]) {
  let unlocked = true;
  const demonstrated = new Set(course.gates.flatMap(gate => gateDecision(gate, evidence, digest).objectives.filter(objective => objective.passed).map(objective => objective.id)));
  const lessons = episodes(course).map(episode => {
    const record = progress.find(row => row.episode_id === episode.id);
    const gate = course.gates.find(row => row.id === episode.gateId);
    const decision = gate ? gateDecision(gate, evidence, digest) : null;
    // Evidence revocation must lock downstream lessons even if old coverage rows remain.
    const requirement = getEpisodeRequirement(episode);
    const prerequisites = course.objectives.filter(objective => episode.objectiveIds.includes(objective.id)).flatMap(objective => objective.prerequisites).filter(id => !episode.objectiveIds.includes(id));
    const ready = unlocked && prerequisites.every(id => demonstrated.has(id));
    const credited = Boolean(record && ['completed', 'placed'].includes(record.state) && (!gate || decision?.passed) && ready);
    const status = credited ? record!.state : ready ? 'available' : 'locked';
    const value = { id: episode.id, requirement, status, completedBlockIds: record?.completed_block_ids ?? [], gate: decision };
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

export function publicQuestion(assessment: Assessment) {
  // SDK 0.5 misconception links name which wrong option means what: a hidden key.
  const { grading: _private, familyId: _family, misconceptionIds: _links, ...question } = assessment as Assessment & { misconceptionIds?: unknown };
  // Rubric criteria are the visible success requirements, not a hidden key.
  if (assessment.type === 'rubric')
    return { ...question, criteria: assessment.grading.rubric.map(({ id, description, required }) => ({ id, description, required })) };
  if (assessment.type === 'choice')
    return { ...question, options: assessment.options.map(({ misconceptionId: _link, ...option }: (typeof assessment.options)[number] & { misconceptionId?: unknown }) => option) };
  return question;
}

export function gradeDeterministic(assessment: Assessment, answer: unknown) {
  if (assessment.type === 'choice') {
    requireCondition(typeof answer === 'string' && assessment.options.some(option => option.id === answer), 'INVALID_ANSWER');
    return { passed: answer === assessment.grading.correctOptionId, explanation: assessment.grading.explanation, evaluator: 'deterministic-choice@1' };
  }
  if (assessment.type === 'numeric') {
    requireCondition(typeof answer === 'number' && Number.isFinite(answer), 'INVALID_ANSWER');
    return { passed: Math.abs(answer - assessment.grading.expected) <= assessment.grading.absoluteTolerance,
      explanation: assessment.grading.explanation, evaluator: 'deterministic-numeric@1' };
  }
  throw new ApiError(409, 'EVALUATOR_NOT_CONFIGURED');
}
