import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Assessment } from "@course-core/sdk";
import type { Database } from "./database.js";
import { transaction } from "./database.js";
import { membership, type authService } from "./auth.js";
import { requireCondition } from "./errors.js";
import { appendEvent } from "./events.js";
import { digestJson, enrollmentCommand, loadEnrollment, policyEpisodeId, type CommandInput } from "./repository.js";
import { requireAvailable } from "./learning.js";
import { assertPolicyAction } from "./policy-adapter.js";
import { adminPermissionMatrix } from "./admin-routes.js";
import { RUBRIC_RESPONSE_LIMITS, rubricDigest } from "./rubric-evaluator.js";
import { rubricAssistViews } from "./rubric-assist.js";

type Rubric = Extract<Assessment, { type: "rubric" }>;
const reviewSchema = z.strictObject({
  decision: z.enum(["met", "not_met", "needs_clarification"]),
  criteria: z
    .array(
      z.strictObject({
        criterionId: z.string().min(1).max(128),
        met: z.boolean(),
        quote: z.string().trim().min(10).max(800).optional(),
        note: z.string().trim().max(500).optional(),
      }),
    )
    .min(1)
    .max(12),
  learnerNote: z.string().trim().min(1).max(2000).optional(),
  /** Clarification only: the reviewer declares the note is a neutral question with
   * no hint, so the learner's reply can still count as independent. */
  probeOnly: z.boolean().optional(),
  /** The AI draft the reviewer had open, if any; recorded for agreement metrics only. */
  suggestionId: z.string().uuid().optional(),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/),
});
const PENDING_SQL = `SELECT a.id,a.enrollment_id,a.assessment_id,a.response,a.result,a.submitted_at,a.course_digest,c.episode_id,
  e.workspace_id,e.user_id,e.course_release_id,e.status,u.display_name,r.server_bundle
  FROM attempts a JOIN assessment_challenges c ON c.attempt_id=a.id AND c.enrollment_id=a.enrollment_id
  JOIN enrollments e ON e.id=a.enrollment_id JOIN app_users u ON u.id=e.user_id JOIN course_releases r ON r.id=e.course_release_id
  LEFT JOIN rubric_reviews v ON v.attempt_id=a.id`;

/** Earlier turns of a written-answer conversation, oldest first: each learner
 * answer and the reviewer's clarification request that followed it. */
async function threadOf(client: { query: Database["query"] }, attemptId: string) {
  const rows = (await client.query(
    `WITH RECURSIVE chain AS (
       SELECT a.id,a.continues_attempt_id,a.response,a.submitted_at,0 AS depth FROM attempts a WHERE a.id=(SELECT continues_attempt_id FROM attempts WHERE id=$1)
       UNION ALL SELECT p.id,p.continues_attempt_id,p.response,p.submitted_at,c.depth+1 FROM attempts p JOIN chain c ON p.id=c.continues_attempt_id WHERE c.depth<20)
     SELECT c.id,c.response,c.submitted_at,v.learner_note,v.probe_only FROM chain c LEFT JOIN rubric_reviews v ON v.attempt_id=c.id ORDER BY c.depth DESC`, [attemptId])).rows;
  return rows.map((r) => ({ attemptId: r.id as string, response: String(r.response), submittedAt: r.submitted_at.toISOString() as string, reviewerNote: (r.learner_note ?? null) as string | null, probeOnly: Boolean(r.probe_only) }));
}

export function registerRubricReviewRoutes(app: FastifyInstance, db: Database, auth: ReturnType<typeof authService>) {
  const uuid = { type: "string", format: "uuid" };
  const params = (name: string) => ({ type: "object", additionalProperties: false, required: [name], properties: { [name]: uuid } });
  /** Pending written answers for a course catalogue. Reviewers see the answer
   * text and rubric; no grading key exists to leak. */
  app.get("/api/admin/courses/:catalogId/rubric-reviews", { schema: { params: params("catalogId") } }, async (request) => {
    const actor = await auth.authenticate(request), { catalogId } = request.params as { catalogId: string };
    const catalog = (await db.query("SELECT workspace_id,course_key FROM admin_course_catalog WHERE id=$1", [catalogId])).rows[0];
    requireCondition(catalog, "COURSE_NOT_FOUND", 404);
    const role = await membership(db, actor, catalog.workspace_id);
    requireCondition(adminPermissionMatrix[role]?.includes("evidence.review"), "FORBIDDEN", 403);
    const rows = (
      await db.query(
        `${PENDING_SQL} WHERE e.workspace_id=$1 AND r.course_key=$2 AND v.id IS NULL AND a.result->>'status'='pending_review'
         AND e.status<>'erased' ORDER BY a.submitted_at LIMIT 200`,
        [catalog.workspace_id, catalog.course_key],
      )
    ).rows;
    const threads = new Map(await Promise.all(rows.map(async (row) => [row.id, await threadOf(db, row.id)] as const)));
    const assist = await rubricAssistViews(db, rows.map((row) => ({ attemptId: row.id, enrollmentId: row.enrollment_id, response: String(row.response), rubricDigest: row.result.rubricDigest })));
    return {
      pending: rows.map((row) => {
        const assessment = row.server_bundle.assessments.find((a: Assessment) => a.id === row.assessment_id) as Rubric;
        return {
          attemptId: row.id,
          enrollmentId: row.enrollment_id,
          learner: row.display_name,
          episodeId: row.episode_id,
          assessmentId: row.assessment_id,
          prompt: assessment.prompt,
          rubric: assessment.grading.rubric,
          response: row.response,
          submittedAt: row.submitted_at.toISOString(),
          independentEligible: Boolean(row.result.independentEligible),
          ownSubmission: row.user_id === actor.id,
          assist: assist.get(row.id),
          /** Earlier turns when this answer replies to a clarification request. */
          thread: threads.get(row.id) ?? [],
        };
      }),
    };
  });
  app.post("/api/admin/rubric-reviews/:attemptId", { schema: { params: params("attemptId") } }, async (request) => {
    const actor = await auth.authenticate(request), { attemptId } = request.params as { attemptId: string };
    const parsed = reviewSchema.safeParse(request.body);
    requireCondition(parsed.success, "INVALID_INPUT", 400);
    const input = parsed.data;
    requireCondition(!input.probeOnly || input.decision === "needs_clarification", "PROBE_ONLY_FOR_CLARIFICATION", 400);
    return transaction(db, async (client) => {
      const row = (await client.query(`${PENDING_SQL} WHERE a.id=$1 FOR UPDATE OF a`, [attemptId])).rows[0];
      requireCondition(row, "ATTEMPT_NOT_FOUND", 404);
      const role = await membership(client, actor, row.workspace_id).catch(() => "");
      requireCondition(adminPermissionMatrix[role]?.includes("evidence.review"), "FORBIDDEN", 403);
      requireCondition(row.user_id !== actor.id, "SELF_REVIEW_FORBIDDEN", 403);
      requireCondition(row.status !== "erased", "ENROLLMENT_ERASED", 410);
      const assessment = row.server_bundle.assessments.find((a: Assessment) => a.id === row.assessment_id) as Rubric | undefined;
      requireCondition(assessment?.type === "rubric" && row.result.status === "pending_review", "NOT_A_PENDING_RUBRIC_ATTEMPT", 409);
      const { idempotencyKey: _key, ...semantic } = input;
      const digest = digestJson({ reviewer: actor.id, ...semantic });
      const existing = (await client.query("SELECT * FROM rubric_reviews WHERE attempt_id=$1", [attemptId])).rows[0];
      if (existing) {
        requireCondition(existing.criteria.requestDigest === digest, "ALREADY_REVIEWED", 409);
        return { attemptId, decision: existing.decision, replayed: true };
      }
      requireCondition(rubricDigest(assessment) === row.result.rubricDigest, "RUBRIC_CHANGED", 409);
      const rubric = assessment.grading.rubric, thread = await threadOf(client, attemptId);
      // In a conversation the reviewer may cite any of the learner's own turns.
      const learnerWords = [...thread.map((t) => t.response), String(row.response)];
      requireCondition(
        input.criteria.length === rubric.length && rubric.every((c) => input.criteria.filter((x) => x.criterionId === c.id).length === 1),
        "RUBRIC_CRITERIA_INCOMPLETE",
        400,
      );
      // A met criterion must cite the learner's own words; reviewer agreement alone is not evidence.
      for (const finding of input.criteria)
        if (finding.met) requireCondition(finding.quote && learnerWords.some((w) => w.includes(finding.quote!)), "RUBRIC_QUOTE_REQUIRED", 409);
      const requiredMet = rubric.filter((c) => c.required).every((c) => input.criteria.find((x) => x.criterionId === c.id)!.met);
      if (input.decision === "met") requireCondition(requiredMet, "RUBRIC_DECISION_INCONSISTENT", 409);
      if (input.decision === "not_met") requireCondition(!requiredMet, "RUBRIC_DECISION_INCONSISTENT", 409);
      if (input.decision === "needs_clarification") requireCondition(input.learnerNote, "CLARIFICATION_NOTE_REQUIRED", 400);
      if (input.suggestionId)
        requireCondition((await client.query("SELECT 1 FROM rubric_suggestions s JOIN rubric_assist_requests r ON r.id=s.request_id WHERE s.id=$1 AND r.attempt_id=$2", [input.suggestionId, attemptId])).rowCount, "RUBRIC_SUGGESTION_MISMATCH", 409);
      await client.query(
        "INSERT INTO rubric_reviews(id,attempt_id,enrollment_id,reviewer_id,decision,criteria,learner_note,rubric_digest,suggestion_id,probe_only) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [randomUUID(), attemptId, row.enrollment_id, actor.id, input.decision, JSON.stringify({ findings: input.criteria, requestDigest: digest }), input.learnerNote ?? null, rubricDigest(assessment), input.suggestionId ?? null, input.probeOnly === true],
      );
      // Clarification is not a judgement either way and creates no evidence.
      if (input.decision !== "needs_clarification")
        for (const objectiveId of assessment.objectiveIds)
          await client.query(
            "INSERT INTO evidence (id,enrollment_id,attempt_id,objective_id,evaluator_ref,result,independent) VALUES ($1,$2,$3,$4,$5,$6,$7)",
            [randomUUID(), row.enrollment_id, attemptId, objectiveId, "reviewed-rubric@1", JSON.stringify({ passed: input.decision === "met", reviewed: true }), Boolean(row.result.independentEligible)],
          );
      await client.query("UPDATE enrollments SET revision=revision+1 WHERE id=$1", [row.enrollment_id]);
      await appendEvent(client, {
        workspaceId: row.workspace_id,
        enrollmentId: row.enrollment_id,
        actorId: actor.id,
        actorKind: "staff",
        type: "assessment.reviewed",
        payload: { attemptId, assessmentId: row.assessment_id, decision: input.decision, met: input.criteria.filter((c) => c.met).length, total: rubric.length },
        idempotencyKey: "rubric-review:" + attemptId,
        supervise: true,
      });
      return { attemptId, decision: input.decision, replayed: false };
    });
  });
  /** The learner answers a reviewer's clarification request. The reply joins the
   * same conversation and waits for review; it stays independent only when the
   * reviewer declared a neutral probe and the learner used no companion help since. */
  app.post("/api/enrollments/:enrollmentId/reviews/:attemptId/reply", {
    schema: { params: { type: "object", additionalProperties: false, required: ["enrollmentId", "attemptId"], properties: { enrollmentId: uuid, attemptId: uuid } },
      body: { type: "object", additionalProperties: false, required: ["expectedRevision", "idempotencyKey", "answer"],
        properties: { expectedRevision: { type: "integer", minimum: 1 }, idempotencyKey: { type: "string", minLength: 8, maxLength: 200 }, answer: { type: "string", maxLength: 64000 } } } },
  }, async (request) => {
    const actor = await auth.authenticate(request), { enrollmentId, attemptId } = request.params as { enrollmentId: string; attemptId: string };
    const input = request.body as CommandInput & { answer: string };
    return enrollmentCommand(db, actor, enrollmentId, "rubric.reply", input, async (client, context) => {
      requireCondition(context.enrollment.user_id === actor.id, "LEARNER_ONLY", 403);
      requireCondition(context.enrollment.status === "active", "ENROLLMENT_INACTIVE", 409);
      const prior = (await client.query(
        `SELECT a.id,a.assessment_id,a.mode,a.result,c.episode_id,v.decision,v.probe_only,v.created_at AS reviewed_at
         FROM attempts a JOIN assessment_challenges c ON c.attempt_id=a.id AND c.enrollment_id=a.enrollment_id JOIN rubric_reviews v ON v.attempt_id=a.id
         WHERE a.id=$1 AND a.enrollment_id=$2 FOR UPDATE OF a`, [attemptId, enrollmentId])).rows[0];
      requireCondition(prior?.decision === "needs_clarification", "NO_CLARIFICATION_REQUESTED", 409);
      requireCondition(!(await client.query("SELECT 1 FROM attempts WHERE continues_attempt_id=$1", [attemptId])).rowCount, "ALREADY_REPLIED", 409);
      const course = context.release.server_bundle, assessment = course.assessments.find((a) => a.id === prior.assessment_id) as Rubric | undefined;
      requireCondition(assessment?.type === "rubric" && rubricDigest(assessment) === prior.result.rubricDigest, "RUBRIC_CHANGED", 409);
      requireCondition(input.answer.trim().length >= RUBRIC_RESPONSE_LIMITS.min && input.answer.length <= RUBRIC_RESPONSE_LIMITS.max, "INVALID_ANSWER");
      requireAvailable(course, context.release.digest, context.progress, context.evidence, prior.episode_id);
      await assertPolicyAction(client, enrollmentId, policyEpisodeId(context.release, prior.episode_id), "submit", new Date().toISOString());
      // Companion help after the clarification request makes the reply assisted.
      const helped = (await client.query("SELECT 1 FROM companion_messages WHERE enrollment_id=$1 AND role='learner' AND created_at>$2 LIMIT 1", [enrollmentId, prior.reviewed_at])).rowCount;
      const independent = Boolean(prior.result.independentEligible) && prior.probe_only && !helped;
      const challengeId = randomUUID(), replyId = randomUUID();
      const pending = { status: "pending_review", passed: false, evaluator: "reviewed-rubric@1", rubricDigest: rubricDigest(assessment), independentEligible: independent };
      await client.query(`INSERT INTO attempts (id,enrollment_id,assessment_id,course_digest,family_id,mode,assistance,response,result,idempotency_key,continues_attempt_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [replyId, enrollmentId, assessment.id, context.release.digest, assessment.familyId, prior.mode, independent ? "none" : "hint", JSON.stringify(input.answer), JSON.stringify(pending), input.idempotencyKey, attemptId]);
      await client.query(`INSERT INTO assessment_challenges (id,enrollment_id,episode_id,assessment_id,course_digest,mode,assistance,independent_eligible,expires_at,attempt_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now()+interval '1 minute',$9)`, [challengeId, enrollmentId, prior.episode_id, assessment.id, context.release.digest, prior.mode, independent ? "none" : "hint", independent, replyId]);
      await client.query("UPDATE enrollments SET revision=revision+1 WHERE id=$1", [enrollmentId]);
      await appendEvent(client, { workspaceId: context.enrollment.workspace_id, enrollmentId, actorId: actor.id, actorKind: "learner", type: "assessment.submitted",
        payload: { attemptId: replyId, assessmentId: assessment.id, pendingReview: true, independent, continuesAttemptId: attemptId }, idempotencyKey: `${enrollmentId}:${input.idempotencyKey}`, supervise: true });
      return { attemptId: replyId, pendingReview: true, independent };
    });
  });
  /** The learner's own written answers and their review outcomes. */
  app.get("/api/enrollments/:enrollmentId/reviews", { schema: { params: params("enrollmentId") } }, async (request) => {
    const actor = await auth.authenticate(request), { enrollmentId } = request.params as { enrollmentId: string };
    const context = await loadEnrollment(db, actor, enrollmentId);
    const rows = (
      await db.query(
        `SELECT a.id,a.assessment_id,a.submitted_at,a.continues_attempt_id,c.episode_id,v.decision,v.criteria,v.learner_note,v.created_at AS reviewed_at,
           EXISTS(SELECT 1 FROM attempts r WHERE r.continues_attempt_id=a.id) AS replied
         FROM attempts a JOIN assessment_challenges c ON c.attempt_id=a.id AND c.enrollment_id=a.enrollment_id
         LEFT JOIN rubric_reviews v ON v.attempt_id=a.id
         WHERE a.enrollment_id=$1 AND a.result->>'evaluator'='reviewed-rubric@1' ORDER BY a.submitted_at DESC LIMIT 50`,
        [enrollmentId],
      )
    ).rows;
    const course = context.release.server_bundle;
    return {
      reviews: rows.map((r) => {
        const rubric = (course.assessments.find((a) => a.id === r.assessment_id) as Rubric | undefined)?.grading.rubric ?? [];
        return {
          attemptId: r.id,
          episodeId: r.episode_id,
          assessmentId: r.assessment_id,
          submittedAt: r.submitted_at.toISOString(),
          status: r.decision ?? "pending_review",
          reviewedAt: r.reviewed_at?.toISOString() ?? null,
          learnerNote: r.learner_note ?? null,
          continuesAttemptId: r.continues_attempt_id ?? null,
          canReply: r.decision === "needs_clarification" && !r.replied,
          // A clarification request shows the learner only the reviewer's note:
          // per-criterion findings would coach a reply that may still count as independent.
          criteria: r.criteria && r.decision !== "needs_clarification"
            ? rubric.map((c) => {
                const f = r.criteria.findings.find((x: { criterionId: string }) => x.criterionId === c.id);
                return { id: c.id, description: c.description, required: c.required, met: Boolean(f?.met), quote: f?.quote ?? null, note: f?.note ?? null };
              })
            : rubric.map((c) => ({ id: c.id, description: c.description, required: c.required, met: null, quote: null, note: null })),
        };
      }),
    };
  });
}
