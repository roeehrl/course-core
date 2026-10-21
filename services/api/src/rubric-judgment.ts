import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { ReviewedRubric } from "./gates.js";
import { replayRetention } from "./retention.js";
import { refreshDecisionsForEnrollment } from "./gate-decisions.js";
import type { Database } from "./database.js";
import { requireCondition } from "./errors.js";
import { appendEvent } from "./events.js";
import { rubricDigest } from "./rubric-evaluator.js";

/** Every criterion exactly once; each met criterion quotes the learner's own
 * words; the decision matches the required criteria. */
export function checkFindings(rubric: ReviewedRubric["criteria"], learnerWords: string[], decision: string, criteria: { criterionId: string; met: boolean; quote?: string | undefined }[]) {
  requireCondition(criteria.length === rubric.length && rubric.every((c) => criteria.filter((x) => x.criterionId === c.id).length === 1), "RUBRIC_CRITERIA_INCOMPLETE", 400);
  // A met criterion must cite the learner's own words; reviewer agreement alone is not evidence.
  for (const finding of criteria)
    if (finding.met) requireCondition(finding.quote && learnerWords.some((w) => w.includes(finding.quote!)), "RUBRIC_QUOTE_REQUIRED", 409);
  const requiredMet = rubric.filter((c) => c.required).every((c) => criteria.find((x) => x.criterionId === c.id)!.met);
  if (decision === "met") requireCondition(requiredMet, "RUBRIC_DECISION_INCONSISTENT", 409);
  if (decision === "not_met") requireCondition(!requiredMet, "RUBRIC_DECISION_INCONSISTENT", 409);
}

/** Earlier turns of a written-answer conversation, oldest first: each learner
 * answer and the reviewer's clarification request that followed it. */
export async function threadOf(client: { query: Database["query"] }, attemptId: string) {
  const rows = (await client.query(
    `WITH RECURSIVE chain AS (
       SELECT a.id,a.continues_attempt_id,a.response,a.submitted_at,0 AS depth FROM attempts a WHERE a.id=(SELECT continues_attempt_id FROM attempts WHERE id=$1)
       UNION ALL SELECT p.id,p.continues_attempt_id,p.response,p.submitted_at,c.depth+1 FROM attempts p JOIN chain c ON p.id=c.continues_attempt_id WHERE c.depth<20)
     SELECT c.id,c.response,c.submitted_at,v.learner_note,v.probe_only FROM chain c LEFT JOIN rubric_reviews v ON v.attempt_id=c.id ORDER BY c.depth DESC`, [attemptId])).rows;
  return rows.map((r) => ({ attemptId: r.id as string, response: String(r.response), submittedAt: r.submitted_at.toISOString() as string, reviewerNote: (r.learner_note ?? null) as string | null, probeOnly: Boolean(r.probe_only) }));
}

/** Who confirmed a judgment: an authorized human reviewer, or an installed deterministic
 * evaluator checking a verified, quoted proposal (conversation-confirmation.ts). */
export type JudgmentConfirmation =
  | { kind: "human"; reviewerId: string; learnerNote: string | null; probeOnly: boolean }
  | { kind: "deterministic"; confirmer: { evaluatorId: string; evaluatorVersion: string; extensionId: string; extensionVersion: string; integrity: string } };

/**
 * Records a judgment whose findings checkFindings already accepted: the review row, evidence
 * backed by the quoted learner spans (none for a clarification request), the learning event and
 * the learner's refreshed gate decisions. Callers hold the attempt row lock.
 */
export async function recordRubricJudgment(client: PoolClient, input: {
  attempt: { enrollment_id: string; workspace_id: string; assessment_id: string; response: unknown; result: { independentEligible?: boolean; conversation?: unknown } };
  attemptId: string; assessment: ReviewedRubric; thread: Awaited<ReturnType<typeof threadOf>>;
  decision: "met" | "not_met" | "needs_clarification"; criteria: { criterionId: string; met: boolean; quote?: string | undefined; note?: string | undefined }[];
  requestDigest: string; suggestionId: string | null; confirmation: JudgmentConfirmation;
}) {
  const { attempt: row, attemptId, assessment, confirmation } = input, human = confirmation.kind === "human";
  await client.query(
    `INSERT INTO rubric_reviews(id,attempt_id,enrollment_id,reviewer_id,decision,criteria,learner_note,rubric_digest,suggestion_id,probe_only,confirmation,confirmer)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [randomUUID(), attemptId, row.enrollment_id, human ? confirmation.reviewerId : null, input.decision, JSON.stringify({ findings: input.criteria, requestDigest: input.requestDigest }),
      human ? confirmation.learnerNote : null, rubricDigest(assessment), input.suggestionId, human && confirmation.probeOnly,
      confirmation.kind, human ? null : JSON.stringify(confirmation.confirmer)],
  );
  // Clarification is not a judgement either way and creates no evidence.
  // Quoted learner spans back the judgment; a conversation records which turn each quote came from.
  const turns = [...input.thread.map((t) => ({ turnId: t.attemptId, text: t.response })), { turnId: attemptId, text: String(row.response) }];
  const citedSpans = input.criteria.filter((c) => c.met && c.quote).map((c) => ({ turnId: turns.find((t) => t.text.includes(c.quote!))!.turnId, quote: c.quote! }));
  // Course-rubric items (0.5 production tasks and gate conversations) carry their quoted spans; 0.4 rubric evidence keeps its shape.
  const reviewed = { passed: input.decision === "met", reviewed: true, ...(assessment.rubricRef ? { citedSpans } : {}),
    ...(assessment.conversationGateId && row.result.conversation ? { conversation: row.result.conversation } : {}),
    ...(human ? {} : { confirmation: "deterministic" }) };
  if (input.decision !== "needs_clarification")
    for (const objectiveId of assessment.objectiveIds)
      await client.query(
        "INSERT INTO evidence (id,enrollment_id,attempt_id,objective_id,evaluator_ref,result,independent) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [randomUUID(), row.enrollment_id, attemptId, objectiveId, "reviewed-rubric@1", JSON.stringify(reviewed), Boolean(row.result.independentEligible)],
      );
  await client.query("UPDATE enrollments SET revision=revision+1 WHERE id=$1", [row.enrollment_id]);
  await appendEvent(client, {
    workspaceId: row.workspace_id,
    enrollmentId: row.enrollment_id,
    ...(human ? { actorId: confirmation.reviewerId } : {}),
    actorKind: human ? "staff" : "system",
    type: "assessment.reviewed",
    payload: { attemptId, assessmentId: row.assessment_id, decision: input.decision, met: input.criteria.filter((c) => c.met).length, total: assessment.criteria.length,
      ...(human ? {} : { confirmation: "deterministic" }) },
    idempotencyKey: "rubric-review:" + attemptId,
    supervise: true,
  });
  // The learner's gate decision now reflects the review.
  await refreshDecisionsForEnrollment(client, row.enrollment_id, row.assessment_id);
  // A reviewed written retention check moves its review schedule now.
  if (input.decision !== "needs_clarification" && (await client.query("SELECT 1 FROM attempts WHERE id=$1 AND mode='retention'", [attemptId])).rowCount)
    await replayRetention(client, row.enrollment_id, assessment.objectiveIds);
}
