import type { GateView, ServerSnapshot } from "../client/apiClient";

/**
 * Which question of the lesson's check the learner is on ("Question 2"): one more than the
 * independent successes already counted, objective by objective, capped at the number the lesson
 * needs. The API stores the same number with a message about a check
 * (services/api/src/check-ordinal.ts uses the same formula; both are tested on one example).
 */
export function checkOrdinal(objectives: readonly Pick<GateView["objectives"][number], "families" | "required">[]): number {
  const total = objectives.reduce((sum, objective) => sum + Math.max(0, objective.required), 0);
  const done = objectives.reduce((sum, objective) => sum + Math.min(objective.families.length, Math.max(0, objective.required)), 0);
  return Math.max(1, Math.min(1 + done, total));
}

/** The ordinal of the open question of a lesson, from the snapshot's gate view (1 without one). */
export function questionOrdinal(server: Pick<ServerSnapshot, "lessons">, episodeId: string): number {
  const gate = server.lessons.find((lesson) => lesson.id === episodeId)?.gate;
  return gate ? checkOrdinal(gate.objectives) : 1;
}
