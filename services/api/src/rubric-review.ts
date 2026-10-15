import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { z } from "zod";
import type { CourseManifest } from "@course-core/sdk";
import { reviewedRubric, type ReviewedRubric } from "./gates.js";
import { refreshDecisionsForEnrollment } from "./gate-decisions.js";
import type { Database } from "./database.js";
import { transaction } from "./database.js";
import type { authService } from "./auth.js";
import { requireCondition } from "./errors.js";
import { appendEvent } from "./events.js";
import { digestJson, enrollmentCommand, loadEnrollment, policyEpisodeId, type CommandInput, type EnrollmentContext } from "./repository.js";
import { requireAvailable } from "./learning.js";
import { assertGradeAllowed, assertPolicyAction } from "./policy-adapter.js";
import { enrollmentRole, permitCourse, roleCan } from "./course-access.js";
import { RUBRIC_RESPONSE_LIMITS, rubricDigest } from "./rubric-evaluator.js";
import { rubricAssistViews } from "./rubric-assist.js";
import { mayRead, type LearnerDataAudience } from "./learner-privacy.js";

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
export async function threadOf(client: { query: Database["query"] }, attemptId: string) {
  const rows = (await client.query(
    `WITH RECURSIVE chain AS (
       SELECT a.id,a.continues_attempt_id,a.response,a.submitted_at,0 AS depth FROM attempts a WHERE a.id=(SELECT continues_attempt_id FROM attempts WHERE id=$1)
       UNION ALL SELECT p.id,p.continues_attempt_id,p.response,p.submitted_at,c.depth+1 FROM attempts p JOIN chain c ON p.id=c.continues_attempt_id WHERE c.depth<20)
     SELECT c.id,c.response,c.submitted_at,v.learner_note,v.probe_only FROM chain c LEFT JOIN rubric_reviews v ON v.attempt_id=c.id ORDER BY c.depth DESC`, [attemptId])).rows;
  return rows.map((r) => ({ attemptId: r.id as string, response: String(r.response), submittedAt: r.submitted_at.toISOString() as string, reviewerNote: (r.learner_note ?? null) as string | null, probeOnly: Boolean(r.probe_only) }));
}

/** True when the answer was a placement item issued inside this enrollment's own
 * placement run for the current course version. Anything else (practice or
 * independent work, a placement-mode row outside a run, another version) is not. */
async function placementRunAnswer(
  client: { query: Database["query"] },
  enrollmentId: string,
  digest: string,
  prior: { mode: string; challenge_mode: string; course_digest: string; issued_at: Date },
) {
  if (prior.mode !== "placement" || prior.challenge_mode !== "placement" || prior.course_digest !== digest) return false;
  return Boolean((await client.query(
    "SELECT 1 FROM placement_runs WHERE enrollment_id=$1 AND state<>'declined' AND started_at IS NOT NULL AND started_at<=$2",
    [enrollmentId, prior.issued_at])).rowCount);
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
    await permitCourse(db, actor, catalog.workspace_id, catalogId, "evidence.review");
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
        const assessment = reviewedRubric(row.server_bundle as CourseManifest, row.assessment_id)!;
        return {
          attemptId: row.id,
          enrollmentId: row.enrollment_id,
          learner: row.display_name,
          episodeId: row.episode_id,
          assessmentId: row.assessment_id,
          prompt: assessment.prompt,
          rubric: assessment.criteria,
          ...(assessment.conversationGateId ? { conversationGateId: assessment.conversationGateId } : {}),
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
      requireCondition(roleCan(await enrollmentRole(client, actor, row), "evidence.review"), "FORBIDDEN", 403);
      requireCondition(row.user_id !== actor.id, "SELF_REVIEW_FORBIDDEN", 403);
      requireCondition(row.status !== "erased", "ENROLLMENT_ERASED", 410);
      const assessment = reviewedRubric(row.server_bundle as CourseManifest, row.assessment_id);
      requireCondition(assessment && row.result.status === "pending_review", "NOT_A_PENDING_RUBRIC_ATTEMPT", 409);
      const { idempotencyKey: _key, ...semantic } = input;
      const digest = digestJson({ reviewer: actor.id, ...semantic });
      const existing = (await client.query("SELECT * FROM rubric_reviews WHERE attempt_id=$1", [attemptId])).rows[0];
      if (existing) {
        requireCondition(existing.criteria.requestDigest === digest, "ALREADY_REVIEWED", 409);
        return { attemptId, decision: existing.decision, replayed: true };
      }
      requireCondition(rubricDigest(assessment) === row.result.rubricDigest, "RUBRIC_CHANGED", 409);
      // Grading an on-time submission may finish after the cutoff or closure without reopening it (P08).
      if (input.decision !== "needs_clarification")
        await assertGradeAllowed(client, { enrollmentId: row.enrollment_id, attemptId, episodeId: row.episode_id, submittedAt: row.submitted_at }, new Date().toISOString());
      const rubric = assessment.criteria, thread = await threadOf(client, attemptId);
      // In a conversation the reviewer may cite any of the learner's own turns.
      const learnerWords = [...thread.map((t) => t.response), String(row.response)];
      checkFindings(rubric, learnerWords, input.decision, input.criteria);
      if (input.decision === "needs_clarification") requireCondition(input.learnerNote, "CLARIFICATION_NOTE_REQUIRED", 400);
      // A draft counts as "open" only while the learner's consent is still the grant it was requested under.
      if (input.suggestionId)
        requireCondition((await client.query(
          `SELECT 1 FROM rubric_suggestions s JOIN rubric_assist_requests r ON r.id=s.request_id
           JOIN rubric_assist_consents c ON c.enrollment_id=r.enrollment_id AND c.granted AND c.revision=r.consent_revision
           WHERE s.id=$1 AND r.attempt_id=$2 AND r.state<>'superseded'`, [input.suggestionId, attemptId])).rowCount, "RUBRIC_SUGGESTION_MISMATCH", 409);
      await client.query(
        "INSERT INTO rubric_reviews(id,attempt_id,enrollment_id,reviewer_id,decision,criteria,learner_note,rubric_digest,suggestion_id,probe_only) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [randomUUID(), attemptId, row.enrollment_id, actor.id, input.decision, JSON.stringify({ findings: input.criteria, requestDigest: digest }), input.learnerNote ?? null, rubricDigest(assessment), input.suggestionId ?? null, input.probeOnly === true],
      );
      // Clarification is not a judgement either way and creates no evidence.
      // Quoted learner spans back the judgment; a conversation records which turn each quote came from.
      const turns = [...thread.map((t) => ({ turnId: t.attemptId, text: t.response })), { turnId: attemptId, text: String(row.response) }];
      const citedSpans = input.criteria.filter((c) => c.met && c.quote).map((c) => ({ turnId: turns.find((t) => t.text.includes(c.quote!))!.turnId, quote: c.quote! }));
      // Course-rubric items (0.5 production tasks and gate conversations) carry their quoted spans; 0.4 rubric evidence keeps its shape.
      const reviewed = { passed: input.decision === "met", reviewed: true, ...(assessment.rubricRef ? { citedSpans } : {}),
        ...(assessment.conversationGateId && row.result.conversation ? { conversation: row.result.conversation } : {}) };
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
        actorId: actor.id,
        actorKind: "staff",
        type: "assessment.reviewed",
        payload: { attemptId, assessmentId: row.assessment_id, decision: input.decision, met: input.criteria.filter((c) => c.met).length, total: rubric.length },
        idempotencyKey: "rubric-review:" + attemptId,
        supervise: true,
      });
      // The learner's gate decision now reflects the review.
      await refreshDecisionsForEnrollment(client, row.enrollment_id, row.assessment_id);
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
        `SELECT a.id,a.assessment_id,a.mode,a.result,a.course_digest,c.episode_id,c.mode AS challenge_mode,c.issued_at,v.decision,v.probe_only,v.created_at AS reviewed_at
         FROM attempts a JOIN assessment_challenges c ON c.attempt_id=a.id AND c.enrollment_id=a.enrollment_id JOIN rubric_reviews v ON v.attempt_id=a.id
         WHERE a.id=$1 AND a.enrollment_id=$2 FOR UPDATE OF a`, [attemptId, enrollmentId])).rows[0];
      requireCondition(prior?.decision === "needs_clarification", "NO_CLARIFICATION_REQUESTED", 409);
      requireCondition(!(await client.query("SELECT 1 FROM attempts WHERE continues_attempt_id=$1", [attemptId])).rowCount, "ALREADY_REPLIED", 409);
      const course = context.release.server_bundle, assessment = reviewedRubric(course, prior.assessment_id);
      requireCondition(assessment && rubricDigest(assessment) === prior.result.rubricDigest, "RUBRIC_CHANGED", 409);
      requireCondition(input.answer.trim().length >= RUBRIC_RESPONSE_LIMITS.min && input.answer.length <= RUBRIC_RESPONSE_LIMITS.max, "INVALID_ANSWER");
      // A placement item probes material that is still locked on purpose. Replying to
      // the reviewer's question about it continues an answer the learner was
      // legitimately given, so it needs that run, not an unlocked episode.
      if (!(await placementRunAnswer(client, enrollmentId, context.release.digest, prior)))
        requireAvailable(course, context.release.digest, context.progress, context.evidence, prior.episode_id);
      await assertPolicyAction(client, enrollmentId, policyEpisodeId(context.release, prior.episode_id), "submit", new Date().toISOString());
      // Companion help after the clarification request makes the reply assisted.
      const helped = (await client.query("SELECT 1 FROM companion_messages WHERE enrollment_id=$1 AND role='learner' AND created_at>$2 LIMIT 1", [enrollmentId, prior.reviewed_at])).rowCount;
      const independent = Boolean(prior.result.independentEligible) && prior.probe_only && !helped;
      const challengeId = randomUUID(), replyId = randomUUID();
      const pending = { status: "pending_review", passed: false, evaluator: "reviewed-rubric@1", rubricDigest: rubricDigest(assessment), independentEligible: independent,
        ...(prior.result.conversation ? { conversation: prior.result.conversation } : {}) };
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
    return learnerReviews(db, await loadEnrollment(db, actor, enrollmentId), "learner");
  });
}

/** The learner's own written answers and review outcomes, as the learner sees them.
 * For a 'staff' copy (the read-only learner view) the learner's own appeal
 * reason is withheld under the shared privacy rule (learner-privacy.ts). */
export async function learnerReviews(db: Database | PoolClient, context: EnrollmentContext, audience: LearnerDataAudience) {
  const withReason = mayRead(audience, "written-answer-appeal-reason");
  const rows = (
    await db.query(
      `SELECT a.id,a.assessment_id,a.submitted_at,a.continues_attempt_id,a.mode,c.episode_id,v.decision,v.criteria,v.learner_note,v.created_at AS reviewed_at,
         EXISTS(SELECT 1 FROM attempts r WHERE r.continues_attempt_id=a.id) AS replied,
         p.state AS appeal_state,p.decision AS appeal_decision,p.findings AS appeal_findings,p.reviewer_note AS appeal_note,
         ${withReason ? "p.reason" : "NULL"} AS appeal_reason
       FROM attempts a JOIN assessment_challenges c ON c.attempt_id=a.id AND c.enrollment_id=a.enrollment_id
       LEFT JOIN rubric_reviews v ON v.attempt_id=a.id LEFT JOIN rubric_appeals p ON p.attempt_id=a.id
       WHERE a.enrollment_id=$1 AND a.result->>'evaluator'='reviewed-rubric@1' ORDER BY a.submitted_at DESC LIMIT 50`,
      [context.enrollment.id],
    )
  ).rows;
  const course = context.release.server_bundle;
  return {
    reviews: rows.map((r) => {
      const rubric = reviewedRubric(course, r.assessment_id)?.criteria ?? [];
      // A decision changed on appeal replaces the original for the learner too.
      const changed = r.appeal_state === "changed", decision = changed ? r.appeal_decision : r.decision, findings = changed ? r.appeal_findings : r.criteria;
      return {
        attemptId: r.id,
        episodeId: r.episode_id,
        assessmentId: r.assessment_id,
        submittedAt: r.submitted_at.toISOString(),
        status: decision ?? "pending_review",
        reviewedAt: r.reviewed_at?.toISOString() ?? null,
        learnerNote: r.learner_note ?? null,
        continuesAttemptId: r.continues_attempt_id ?? null,
        /** Given as a placement question: shown with the placement run, not only in its (possibly locked) episode. */
        placement: r.mode === "placement",
        canReply: r.decision === "needs_clarification" && !r.replied,
        canAppeal: (r.decision === "met" || r.decision === "not_met") && !r.appeal_state,
        appeal: r.appeal_state ? { state: r.appeal_state, note: r.appeal_note ?? null, reason: r.appeal_reason ?? null } : null,
        // A clarification request shows the learner only the reviewer's note:
        // per-criterion findings would coach a reply that may still count as independent.
        criteria: findings && decision !== "needs_clarification"
          ? rubric.map((c) => {
              const f = findings.findings.find((x: { criterionId: string }) => x.criterionId === c.id);
              return { id: c.id, description: c.description, required: c.required, met: Boolean(f?.met), quote: f?.quote ?? null, note: f?.note ?? null };
            })
          : rubric.map((c) => ({ id: c.id, description: c.description, required: c.required, met: null, quote: null, note: null })),
      };
    }),
  };
}
