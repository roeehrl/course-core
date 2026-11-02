/**
 * Which question of a lesson's check the learner is on ("Question 2"): one more than the
 * independent successes already counted, objective by objective, capped at the number the lesson
 * needs. It is stored with a companion message about a check, so the conversation can name the
 * question later. The learner app numbers questions with the same formula
 * (apps/learner/src/connected/checkOrdinal.ts); both are tested on one example.
 */
export function checkOrdinal(objectives: readonly { families: readonly string[]; required: number }[]): number {
  const total = objectives.reduce((sum, objective) => sum + Math.max(0, objective.required), 0);
  const done = objectives.reduce((sum, objective) => sum + Math.min(objective.families.length, Math.max(0, objective.required)), 0);
  return Math.max(1, Math.min(1 + done, total));
}
