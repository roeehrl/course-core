import type { CompanionContext, CompanionMessage } from "../src/client/companionClient";

/*
 * The companion's shared test data: a lesson context with an open independent check, one queued
 * question and the receipt the server gives for it. Used by the companion test files.
 */
export const context: CompanionContext = {
  enrollmentId: "e",
  courseDigest: "digest",
  snapshotRevision: 1,
  courseTitle: "Study",
  episodeId: "intro",
  episodeTitle: "Notice change",
  independentChallengeIds: ["active-check"],
};
export const message: CompanionMessage = {
  id: "m",
  role: "learner",
  content: "Why does it change?",
  context: { episodeId: "intro" },
  created_at: "2026-01-01",
  job_state: "queued",
  job_id: "job",
};
export const receipt = {
  messageId: "m",
  eventId: "event",
  revision: 2,
  state: "queued" as const,
  downgradedChallengeIds: ["active-check"],
};
