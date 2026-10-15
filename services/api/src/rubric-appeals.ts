import { recordGradeChallenge } from "./teaching-hypotheses.js";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { reviewedRubric } from "./gates.js";
import { refreshDecisionsForEnrollment } from "./gate-decisions.js";
import type { Database } from "./database.js";
import { transaction } from "./database.js";
import { membership, type authService } from "./auth.js";
import { requireCondition } from "./errors.js";
import { appendEvent } from "./events.js";
import { digestJson, enrollmentCommand, type CommandInput } from "./repository.js";
import { readRelease } from "./release-cache.js";
import { adminPermissionMatrix } from "./admin-routes.js";
import { rubricDigest } from "./rubric-evaluator.js";
import { checkFindings, threadOf } from "./rubric-review.js";

const decisionSchema = z.strictObject({
  decision: z.enum(["met", "not_met"]),
  criteria: z.array(z.strictObject({ criterionId: z.string().min(1).max(128), met: z.boolean(), quote: z.string().trim().min(10).max(800).optional(), note: z.string().trim().max(500).optional() })).min(1).max(12),
  note: z.string().trim().min(1).max(2000),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/),
});
const APPEAL_SQL = `SELECT p.*,a.response,a.result,a.assessment_id,v.decision AS original_decision,v.reviewer_id AS original_reviewer,v.criteria AS original_criteria,
  e.user_id,e.workspace_id,e.course_release_id,e.status,u.display_name
  FROM rubric_appeals p JOIN attempts a ON a.id=p.attempt_id AND a.enrollment_id=p.enrollment_id
  JOIN rubric_reviews v ON v.attempt_id=p.attempt_id JOIN enrollments e ON e.id=p.enrollment_id JOIN app_users u ON u.id=e.user_id`;

/** A learner may ask once for a second opinion on a judged written answer. A
 * different reviewer re-reviews it under the same quoting rules; only a changed
 * decision replaces the original evidence, and the learner sees the reason. */
export function registerRubricAppealRoutes(app: FastifyInstance, db: Database, auth: ReturnType<typeof authService>) {
  const uuid = { type: "string", format: "uuid" };
  const params = (...names: string[]) => ({ type: "object", additionalProperties: false, required: names, properties: Object.fromEntries(names.map((n) => [n, uuid])) });
  app.post("/api/enrollments/:enrollmentId/reviews/:attemptId/appeal", {
    schema: { params: params("enrollmentId", "attemptId"), body: { type: "object", additionalProperties: false, required: ["expectedRevision", "idempotencyKey", "reason"],
      properties: { expectedRevision: { type: "integer", minimum: 1 }, idempotencyKey: { type: "string", minLength: 8, maxLength: 200 }, reason: { type: "string", maxLength: 2000 } } } },
  }, async (request) => {
    const actor = await auth.authenticate(request), { enrollmentId, attemptId } = request.params as { enrollmentId: string; attemptId: string };
    const input = request.body as CommandInput & { reason: string };
    return enrollmentCommand(db, actor, enrollmentId, "rubric.appeal", input, async (client, context) => {
      requireCondition(context.enrollment.user_id === actor.id, "LEARNER_ONLY", 403);
      requireCondition(input.reason.trim().length >= 10, "APPEAL_REASON_REQUIRED", 400);
      const review = (await client.query("SELECT decision FROM rubric_reviews WHERE attempt_id=$1 AND enrollment_id=$2 FOR SHARE", [attemptId, enrollmentId])).rows[0];
      requireCondition(review && (review.decision === "met" || review.decision === "not_met"), "NOTHING_TO_APPEAL", 409);
      requireCondition(!(await client.query("SELECT 1 FROM rubric_appeals WHERE attempt_id=$1", [attemptId])).rowCount, "ALREADY_APPEALED", 409);
      const id = randomUUID();
      await client.query("INSERT INTO rubric_appeals(id,attempt_id,enrollment_id,reason) VALUES($1,$2,$3,$4)", [id, attemptId, enrollmentId, input.reason.trim()]);
      await recordGradeChallenge(client, context, attemptId);
      await client.query("UPDATE enrollments SET revision=revision+1 WHERE id=$1", [enrollmentId]);
      await appendEvent(client, { workspaceId: context.enrollment.workspace_id, enrollmentId, actorId: actor.id, actorKind: "learner", type: "assessment.appeal_requested",
        payload: { appealId: id, attemptId }, idempotencyKey: `${enrollmentId}:${input.idempotencyKey}`, supervise: true });
      return { appealId: id, state: "open" };
    });
  });
  app.get("/api/admin/courses/:catalogId/rubric-appeals", { schema: { params: params("catalogId") } }, async (request) => {
    const actor = await auth.authenticate(request), { catalogId } = request.params as { catalogId: string };
    const catalog = (await db.query("SELECT workspace_id,course_key FROM admin_course_catalog WHERE id=$1", [catalogId])).rows[0];
    requireCondition(catalog, "COURSE_NOT_FOUND", 404);
    requireCondition(adminPermissionMatrix[await membership(db, actor, catalog.workspace_id).catch(() => "")]?.includes("evidence.review"), "FORBIDDEN", 403);
    const rows = (await db.query(`${APPEAL_SQL} JOIN course_releases r ON r.id=e.course_release_id
      WHERE e.workspace_id=$1 AND r.course_key=$2 AND p.state='open' AND e.status<>'erased' ORDER BY p.created_at LIMIT 200`, [catalog.workspace_id, catalog.course_key])).rows;
    return { appeals: await Promise.all(rows.map(async (row) => {
      const release = await readRelease(db, row.course_release_id, row.workspace_id);
      const assessment = release ? reviewedRubric(release.server_bundle, row.assessment_id) : undefined;
      return {
        appealId: row.id, attemptId: row.attempt_id, enrollmentId: row.enrollment_id, learner: row.display_name, reason: row.reason, createdAt: row.created_at.toISOString(),
        prompt: assessment?.prompt ?? "", rubric: assessment?.criteria ?? [], response: String(row.response), thread: await threadOf(db, row.attempt_id),
        original: { decision: row.original_decision, findings: row.original_criteria?.findings ?? [] },
        // The original reviewer and the learner cannot give the second opinion.
        canDecide: row.user_id !== actor.id && row.original_reviewer !== actor.id,
      };
    })) };
  });
  app.post("/api/admin/rubric-appeals/:appealId", { schema: { params: params("appealId") } }, async (request) => {
    const actor = await auth.authenticate(request), { appealId } = request.params as { appealId: string };
    const parsed = decisionSchema.safeParse(request.body);
    requireCondition(parsed.success, "INVALID_INPUT", 400);
    const input = parsed.data, { idempotencyKey: _key, ...semantic } = input, digest = digestJson({ reviewer: actor.id, ...semantic });
    return transaction(db, async (client) => {
      const row = (await client.query(`${APPEAL_SQL} WHERE p.id=$1 FOR UPDATE OF p`, [appealId])).rows[0];
      requireCondition(row, "APPEAL_NOT_FOUND", 404);
      requireCondition(adminPermissionMatrix[await membership(client, actor, row.workspace_id).catch(() => "")]?.includes("evidence.review"), "FORBIDDEN", 403);
      requireCondition(row.user_id !== actor.id, "SELF_REVIEW_FORBIDDEN", 403);
      requireCondition(row.original_reviewer !== actor.id, "SECOND_REVIEWER_REQUIRED", 403);
      requireCondition(row.status !== "erased", "ENROLLMENT_ERASED", 410);
      if (row.state !== "open") {
        requireCondition(row.findings?.requestDigest === digest, "APPEAL_ALREADY_DECIDED", 409);
        return { appealId, state: row.state, replayed: true };
      }
      const release = await readRelease(client, row.course_release_id, row.workspace_id);
      const assessment = release ? reviewedRubric(release.server_bundle, row.assessment_id) : undefined;
      requireCondition(assessment && rubricDigest(assessment) === row.result.rubricDigest, "RUBRIC_CHANGED", 409);
      const thread = await threadOf(client, row.attempt_id);
      checkFindings(assessment.criteria, [...thread.map((t) => t.response), String(row.response)], input.decision, input.criteria);
      const turns = [...thread.map((t) => ({ turnId: t.attemptId, text: t.response })), { turnId: row.attempt_id as string, text: String(row.response) }];
      const citedSpans = input.criteria.filter((c) => c.met && c.quote).map((c) => ({ turnId: turns.find((t) => t.text.includes(c.quote!))!.turnId, quote: c.quote! }));
      const changed = input.decision !== row.original_decision;
      await client.query("UPDATE rubric_appeals SET state=$2,reviewer_id=$3,decision=$4,findings=$5,reviewer_note=$6,decided_at=clock_timestamp() WHERE id=$1",
        [appealId, changed ? "changed" : "upheld", actor.id, input.decision, JSON.stringify({ findings: input.criteria, requestDigest: digest }), input.note]);
      if (changed) {
        await client.query("UPDATE evidence SET invalidated_at=now(),invalidation_reason='Decision changed on appeal' WHERE attempt_id=$1 AND enrollment_id=$2 AND invalidated_at IS NULL",
          [row.attempt_id, row.enrollment_id]);
        for (const objectiveId of assessment.objectiveIds)
          await client.query("INSERT INTO evidence (id,enrollment_id,attempt_id,objective_id,evaluator_ref,result,independent) VALUES ($1,$2,$3,$4,$5,$6,$7)",
            [randomUUID(), row.enrollment_id, row.attempt_id, objectiveId, "reviewed-rubric-appeal@1", JSON.stringify({ passed: input.decision === "met", reviewed: true, appealed: true, ...(assessment.rubricRef ? { citedSpans } : {}), ...(row.result.conversation ? { conversation: row.result.conversation } : {}) }), Boolean(row.result.independentEligible)]);
      }
      await client.query("UPDATE enrollments SET revision=revision+1 WHERE id=$1", [row.enrollment_id]);
      await appendEvent(client, { workspaceId: row.workspace_id, enrollmentId: row.enrollment_id, actorId: actor.id, actorKind: "staff", type: "assessment.appeal_decided",
        payload: { appealId, attemptId: row.attempt_id, outcome: changed ? "changed" : "upheld", decision: input.decision }, idempotencyKey: "rubric-appeal:" + appealId, supervise: true });
      if (changed) await refreshDecisionsForEnrollment(client, row.enrollment_id, row.assessment_id);
      return { appealId, state: changed ? "changed" : "upheld", replayed: false };
    });
  });
}
