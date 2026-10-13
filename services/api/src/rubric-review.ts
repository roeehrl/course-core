import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Assessment } from "@course-core/sdk";
import type { Database } from "./database.js";
import { transaction } from "./database.js";
import { membership, type authService } from "./auth.js";
import { requireCondition } from "./errors.js";
import { appendEvent } from "./events.js";
import { digestJson, loadEnrollment } from "./repository.js";
import { adminPermissionMatrix } from "./admin-routes.js";
import { rubricDigest } from "./rubric-evaluator.js";

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
  idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/),
});
const PENDING_SQL = `SELECT a.id,a.enrollment_id,a.assessment_id,a.response,a.result,a.submitted_at,a.course_digest,c.episode_id,
  e.workspace_id,e.user_id,e.course_release_id,e.status,u.display_name,r.server_bundle
  FROM attempts a JOIN assessment_challenges c ON c.attempt_id=a.id AND c.enrollment_id=a.enrollment_id
  JOIN enrollments e ON e.id=a.enrollment_id JOIN app_users u ON u.id=e.user_id JOIN course_releases r ON r.id=e.course_release_id
  LEFT JOIN rubric_reviews v ON v.attempt_id=a.id`;

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
        };
      }),
    };
  });
  app.post("/api/admin/rubric-reviews/:attemptId", { schema: { params: params("attemptId") } }, async (request) => {
    const actor = await auth.authenticate(request), { attemptId } = request.params as { attemptId: string };
    const parsed = reviewSchema.safeParse(request.body);
    requireCondition(parsed.success, "INVALID_INPUT", 400);
    const input = parsed.data;
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
      const rubric = assessment.grading.rubric, response = String(row.response);
      requireCondition(
        input.criteria.length === rubric.length && rubric.every((c) => input.criteria.filter((x) => x.criterionId === c.id).length === 1),
        "RUBRIC_CRITERIA_INCOMPLETE",
        400,
      );
      // A met criterion must cite the learner's own words; reviewer agreement alone is not evidence.
      for (const finding of input.criteria)
        if (finding.met) requireCondition(finding.quote && response.includes(finding.quote), "RUBRIC_QUOTE_REQUIRED", 409);
      const requiredMet = rubric.filter((c) => c.required).every((c) => input.criteria.find((x) => x.criterionId === c.id)!.met);
      if (input.decision === "met") requireCondition(requiredMet, "RUBRIC_DECISION_INCONSISTENT", 409);
      if (input.decision === "not_met") requireCondition(!requiredMet, "RUBRIC_DECISION_INCONSISTENT", 409);
      if (input.decision === "needs_clarification") requireCondition(input.learnerNote, "CLARIFICATION_NOTE_REQUIRED", 400);
      await client.query(
        "INSERT INTO rubric_reviews(id,attempt_id,enrollment_id,reviewer_id,decision,criteria,learner_note,rubric_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [randomUUID(), attemptId, row.enrollment_id, actor.id, input.decision, JSON.stringify({ findings: input.criteria, requestDigest: digest }), input.learnerNote ?? null, rubricDigest(assessment)],
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
  /** The learner's own written answers and their review outcomes. */
  app.get("/api/enrollments/:enrollmentId/reviews", { schema: { params: params("enrollmentId") } }, async (request) => {
    const actor = await auth.authenticate(request), { enrollmentId } = request.params as { enrollmentId: string };
    const context = await loadEnrollment(db, actor, enrollmentId);
    const rows = (
      await db.query(
        `SELECT a.id,a.assessment_id,a.submitted_at,c.episode_id,v.decision,v.criteria,v.learner_note,v.created_at AS reviewed_at
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
          criteria: r.criteria
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
