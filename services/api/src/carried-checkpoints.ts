/**
 * Unchanged checkpoints carry over a course-version move (owner decision 2026-10-24, #5).
 *
 * Evidence stays bound to the version it was earned on (course-version-moves.ts). One exception: a
 * checkpoint the learner passed on the old version counts as passed on the new one when nothing that
 * decided it changed:
 * - the checkpoint itself (its rules and the objectives it checks) is byte-identical in both versions;
 * - every item it lists has the same item, answer key or rubric, and evaluator digest in both versions
 *   (M03 grading provenance, grading-provenance.ts);
 * - each carried attempt was graded with exactly that item, key and evaluator (its stored provenance).
 * A checkpoint judged in conversation does not carry: its evidence is a reviewed conversation, not a
 * graded item. Nothing is rewritten: carried_checkpoint_attempts records, per attempt, the version it
 * now also counts on, and the evidence readers use effectiveDigestSql in place of the attempt's own
 * course digest.
 */
import type { CourseManifest } from '@course-core/sdk';
import { gateAssessmentIds } from '@course-core/sdk';
import { findAssessment, gateConversation, gateObjectives, type AttemptSignal, type Gate, type GateEvidence } from './gates.js';
import { gateDecision, episodes } from './learning.js';
import { gradingProvenance, type GradingProvenance } from './grading-provenance.js';
import { digestJson } from './repository.js';
import type { RuntimeExtension } from './publication.js';

export { effectiveDigestSql } from './carried-digest.js';

/** Why a passed checkpoint does or does not carry over: stable codes the admin app words. */
export type CarryCode = 'CARRIED' | 'CHECKPOINT_REMOVED' | 'CHECKPOINT_RULES_CHANGED' | 'CHECKPOINT_IN_CONVERSATION'
  | 'ITEM_REMOVED' | 'ITEM_CHANGED' | 'ANSWER_KEY_CHANGED' | 'EVALUATOR_CHANGED' | 'GRADED_WITHOUT_RECORD' | 'GRADED_ON_OTHER_TERMS';
export interface AttemptProvenance { id: string; assessment_id: string; course_digest: string; item_digest: string | null; answer_key_digest: string | null; evaluator_digest: string | null }
export interface CheckpointCarry { gateId: string; lessonId: string | null; code: CarryCode; items: number; attempts: string[] }

type Release = { digest: string; server_bundle: CourseManifest };
const lessonOf = (course: CourseManifest, gateId: string) => episodes(course).find(e => e.gateId === gateId)?.id ?? null;
const objectivesOf = (course: CourseManifest, gate: Gate) => gateObjectives(gate).map(id => course.objectives.find(o => o.id === id) ?? null);
function provenanceCode(from: GradingProvenance, to: GradingProvenance): CarryCode | null {
  // The item digest covers the whole item, key included: name the most specific change.
  return from.answerKeyDigest !== to.answerKeyDigest ? 'ANSWER_KEY_CHANGED' : from.evaluatorDigest !== to.evaluatorDigest ? 'EVALUATOR_CHANGED'
    : from.itemDigest !== to.itemDigest ? 'ITEM_CHANGED' : null;
}
const sameAsGraded = (row: AttemptProvenance, p: GradingProvenance) =>
  row.item_digest === p.itemDigest && row.answer_key_digest === p.answerKeyDigest && row.evaluator_digest === p.evaluatorDigest;

/** Evidence and signals as they read after the given attempts count on `digest`. */
export function withCarried<T extends { course_digest: string }>(rows: readonly T[], attemptOf: (row: T) => string | undefined, carried: ReadonlySet<string>, digest: string): T[] {
  return rows.map(row => { const id = attemptOf(row); return id && carried.has(id) ? { ...row, course_digest: digest } : row; });
}

/**
 * For each checkpoint the learner has passed on `from`, whether it carries over to `to` and which
 * attempts carry it. Reads nothing: the caller passes the learner's evidence, attempt signals and
 * attempt provenance (on the effective digest). Checkpoints not passed on `from` are not listed.
 */
export function planCarryOver(from: Release, to: Release, installed: readonly RuntimeExtension[],
  learner: { evidence: readonly GateEvidence[]; signals: readonly AttemptSignal[]; attempts: readonly AttemptProvenance[] }): CheckpointCarry[] {
  const out: CheckpointCarry[] = [];
  for (const gate of from.server_bundle.gates) {
    if (!gateDecision(from.server_bundle, gate, learner.evidence, from.digest, { signals: learner.signals }).passed) continue;
    const lessonId = lessonOf(to.server_bundle, gate.id) ?? lessonOf(from.server_bundle, gate.id);
    const result = (code: CarryCode, items = 0, attempts: string[] = []) => out.push({ gateId: gate.id, lessonId, code, items, attempts });
    const next = to.server_bundle.gates.find(g => g.id === gate.id);
    if (!next) { result('CHECKPOINT_REMOVED'); continue; }
    if (digestJson(gate) !== digestJson(next) || digestJson(objectivesOf(from.server_bundle, gate)) !== digestJson(objectivesOf(to.server_bundle, next))) { result('CHECKPOINT_RULES_CHANGED'); continue; }
    if (gateConversation(from.server_bundle, gate) || gateConversation(to.server_bundle, next)) { result('CHECKPOINT_IN_CONVERSATION'); continue; }
    const items = gateAssessmentIds(next);
    const target = new Map<string, GradingProvenance>();
    let refused: CarryCode | null = null;
    for (const id of items) {
      if (!findAssessment(to.server_bundle, id) || !findAssessment(from.server_bundle, id)) { refused = 'ITEM_REMOVED'; break; }
      const before = gradingProvenance(from.server_bundle, id, installed), after = gradingProvenance(to.server_bundle, id, installed);
      refused = provenanceCode(before, after);
      if (refused) break;
      target.set(id, after);
    }
    if (refused) { result(refused, items.length); continue; }
    const candidates = learner.attempts.filter(a => a.course_digest === from.digest && target.has(a.assessment_id));
    const carried = candidates.filter(a => sameAsGraded(a, target.get(a.assessment_id)!)).map(a => a.id).sort();
    const set = new Set(carried);
    const evidence = withCarried(learner.evidence, row => row.attempt_id, set, to.digest);
    const signals = withCarried(learner.signals, row => row.id, set, to.digest);
    if (carried.length && gateDecision(to.server_bundle, next, evidence, to.digest, { signals }).passed) { result('CARRIED', items.length, carried); continue; }
    result(candidates.some(a => !a.item_digest) ? 'GRADED_WITHOUT_RECORD' : 'GRADED_ON_OTHER_TERMS', items.length);
  }
  return out;
}
