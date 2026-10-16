import type { PoolClient } from "pg";
import { reviewedRubric } from "./gates.js";
import { requireCondition } from "./errors.js";
import { digestJson } from "./repository.js";
import { readRelease } from "./release-cache.js";
import { rubricDigest } from "./rubric-evaluator.js";
import type { RubricAssistInput } from "./rubric-assist-contracts.js";
import { threadOf } from "./rubric-judgment.js";


/** Re-resolves everything a draft depends on. Throws when consent changed, the
 * answer was already reviewed, or the rubric or answer no longer match. */
export async function resolveRubricAssistWithin(client: PoolClient, enrollmentId: string, workspaceId: string, requestId: string, jobId?: string) {
  const row = (
    await client.query(
      `SELECT r.*,a.response,a.result,a.assessment_id,c.episode_id,e.course_release_id,e.status AS enrollment_status
       FROM rubric_assist_requests r JOIN attempts a ON a.id=r.attempt_id AND a.enrollment_id=r.enrollment_id
       JOIN assessment_challenges c ON c.attempt_id=a.id AND c.enrollment_id=a.enrollment_id JOIN enrollments e ON e.id=r.enrollment_id
       WHERE r.id=$1 AND r.enrollment_id=$2 AND r.workspace_id=$3 FOR SHARE OF r`,
      [requestId, enrollmentId, workspaceId],
    )
  ).rows[0];
  requireCondition(row && row.state === "requested" && (jobId === undefined || row.job_id === null || row.job_id === jobId), "RUBRIC_ASSIST_NOT_PENDING", 409);
  const consent = (await client.query("SELECT granted,revision FROM rubric_assist_consents WHERE enrollment_id=$1 FOR SHARE", [enrollmentId])).rows[0];
  requireCondition(consent?.granted && consent.revision === row.consent_revision, "RUBRIC_ASSIST_CONSENT_CHANGED", 409);
  requireCondition(!(await client.query("SELECT 1 FROM rubric_reviews WHERE attempt_id=$1", [row.attempt_id])).rowCount, "RUBRIC_ALREADY_REVIEWED", 409);
  const release = await readRelease(client, row.course_release_id, workspaceId);
  const assessment = release ? reviewedRubric(release.server_bundle, row.assessment_id) : undefined;
  const response = String(row.response);
  requireCondition(assessment && row.result?.status === "pending_review" && rubricDigest(assessment) === row.rubric_digest
    && digestJson(response) === row.response_digest, "RUBRIC_ASSIST_STALE", 409);
  // A reply in a review conversation is judged with its earlier turns: quotes may come from any learner turn.
  const earlierTurns = (await threadOf(client, row.attempt_id)).flatMap((t) => [{ speaker: "learner" as const, text: t.response },
    ...(t.reviewerNote ? [{ speaker: "reviewer" as const, text: t.reviewerNote }] : [])]);
  const input: RubricAssistInput = {
    requestId, attemptId: row.attempt_id, prompt: assessment.prompt, response, earlierTurns, rubricDigest: row.rubric_digest, responseDigest: row.response_digest,
    criteria: assessment.criteria.map((c) => ({ id: c.id, description: c.description, required: c.required })),
  };
  return { input, episodeId: row.episode_id as string, origin: row.origin as "staff" | "supervisor" };
}

