import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { gateConversation, reviewedRubric, type ReviewedRubric } from "./gates.js";
import type { PoolClient } from "pg";
import type { RunRef, Snapshot } from "@course-core/supervisor";
import type { Database } from "./database.js";
import { transaction } from "./database.js";
import type { authService } from "./auth.js";
import { requireCondition } from "./errors.js";
import { appendEvent } from "./events.js";
import { digestJson, enrollmentCommand, loadEnrollment, type CommandInput } from "./repository.js";
import { readRelease } from "./release-cache.js";
import { enrollmentRole, permitCourse, roleCan } from "./course-access.js";
import { rubricDigest } from "./rubric-evaluator.js";
import { recordSupervisorVerification } from "./supervisor-bridge.js";
import { rubricSuggestionProblems, rubricSuggestionSchema } from "./rubric-assist-contracts.js";
import { resolveRubricAssistWithin } from "./rubric-assist-store.js";

const VERIFIER_LABEL = "Written-answer reviewer drafts v1";

/** Host verifier: the draft must answer this exact request and quote the answer
 * verbatim for every met criterion. It authorizes showing a draft to a human
 * reviewer, never a grade, evidence or a learner-visible statement. */
export async function verifyRubricSuggestion(db: Database, ref: RunRef) {
  const job = (await db.query<{ role: string; runtime_snapshot: Snapshot }>("SELECT role,runtime_snapshot FROM supervisor_jobs WHERE id=$1 AND enrollment_id=$2 AND workspace_id=$3",
    [ref.jobId, ref.enrollmentId, ref.workspaceId])).rows[0];
  if (job?.role !== "reviewer" || job.runtime_snapshot.generation !== ref.generation) return;
  const outputs = job.runtime_snapshot.operations.flatMap((o) => (o.outcome?.status === "succeeded" ? [o.outcome.artifact] : []));
  if (outputs.length !== 1) return;
  const row = (await db.query("SELECT content,digest FROM supervisor_artifacts WHERE id=$1 AND job_id=$2 AND enrollment_id=$3 AND workspace_id=$4",
    [outputs[0]!.artifactId, ref.jobId, ref.enrollmentId, ref.workspaceId])).rows[0];
  const parsed = rubricSuggestionSchema.safeParse(row?.content);
  let valid = parsed.success && row?.digest === outputs[0]!.digest && digestJson(row?.content) === row?.digest;
  if (valid && parsed.success) {
    const context = (await db.query("SELECT context FROM supervisor_inputs WHERE job_id=$1 AND enrollment_id=$2 AND workspace_id=$3", [ref.jobId, ref.enrollmentId, ref.workspaceId])).rows[0]?.context;
    try {
      const { input } = await transaction(db, (client) => resolveRubricAssistWithin(client, ref.enrollmentId, ref.workspaceId, context.rubricRequestId, ref.jobId));
      valid = input.requestId === parsed.data.requestId && input.attemptId === parsed.data.attemptId && input.rubricDigest === parsed.data.rubricDigest
        && input.responseDigest === parsed.data.responseDigest && rubricSuggestionProblems(parsed.data, input).length === 0;
    } catch { valid = false; }
  }
  const verifier = await transaction(db, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["rubric-assist:" + ref.workspaceId]);
    const old = (await client.query("SELECT id,enabled FROM supervisor_verifier_authorities WHERE workspace_id=$1 AND label=$2", [ref.workspaceId, VERIFIER_LABEL])).rows[0];
    if (old) return old;
    const id = randomUUID();
    await client.query("INSERT INTO supervisor_verifier_authorities(id,workspace_id,label,can_verify_companion,can_review_adaptation,can_collect_research,can_suggest_rubric) VALUES($1,$2,$3,false,false,false,true)",
      [id, ref.workspaceId, VERIFIER_LABEL]);
    return { id, enabled: true };
  });
  if (verifier.enabled) await recordSupervisorVerification(db, ref, verifier.id, valid ? "verified" : "rejected");
}

/** The live (not superseded) request per answer, with what decides whether it can still produce a draft. */
const LIVE_REQUEST_SQL = `SELECT r.id,r.attempt_id,r.state,r.consent_revision,r.rubric_digest,r.response_digest,r.job_id,r.origin,s.id AS suggestion_id,s.automatic_check,f.content,
    j.state AS job_state,p.disposition,o.quarantined_at
  FROM rubric_assist_requests r LEFT JOIN rubric_suggestions s ON s.request_id=r.id LEFT JOIN supervisor_artifacts f ON f.id=s.artifact_id
  LEFT JOIN supervisor_jobs j ON j.id=r.job_id LEFT JOIN supervisor_preparations p ON p.event_id=r.activation_event_id
  LEFT JOIN outbox o ON o.event_id=r.activation_event_id`;
interface LiveRequest { job_id: string | null; job_state: string | null; suggestion_id: string | null; disposition: string | null; quarantined_at: Date | null }
/** The request will never produce a draft: its job failed, was cancelled or ended
 * without one, or its event was never admitted (refused by policy, an inactive
 * enrollment, or quarantined after failing preparation). */
function requestEnded(r: LiveRequest) {
  if (r.job_id) return r.job_state === "failed" || r.job_state === "cancelled" || (r.job_state === "applied" && !r.suggestion_id);
  return (r.disposition !== null && r.disposition !== "prepared") || r.quarantined_at !== null;
}

/** Per-attempt assistance state for the reviewer queue. A stored draft is shown
 * only while the learner's consent is still the grant it was requested under and
 * the rubric and answer still match what it was drafted from. */
export async function rubricAssistViews(db: Database, attempts: { attemptId: string; enrollmentId: string; response: string; rubricDigest: string }[]) {
  if (!attempts.length) return new Map<string, unknown>();
  const ids = attempts.map((a) => a.attemptId), enrollments = [...new Set(attempts.map((a) => a.enrollmentId))];
  const consents = new Map((await db.query("SELECT enrollment_id,granted,revision FROM rubric_assist_consents WHERE enrollment_id=ANY($1::uuid[])", [enrollments])).rows
    .map((r) => [r.enrollment_id, r as { granted: boolean; revision: number }]));
  const requests = new Map((await db.query(`${LIVE_REQUEST_SQL} WHERE r.attempt_id=ANY($1::uuid[]) AND r.state<>'superseded'`, [ids])).rows.map((r) => [r.attempt_id, r]));
  return new Map(attempts.map((a) => {
    const consent = consents.get(a.enrollmentId), consented = consent?.granted === true;
    // A request made under an earlier grant is void once consent was revoked, even if granted again.
    const request = consented ? requests.get(a.attemptId) : undefined;
    const valid = request !== undefined && request.consent_revision === consent!.revision;
    const parsed = rubricSuggestionSchema.safeParse(request?.content);
    const current = valid && parsed.success && request.rubric_digest === a.rubricDigest && request.response_digest === digestJson(a.response);
    return [a.attemptId, {
      learnerConsented: consented,
      state: !consented ? "not_consented" : !valid ? "available" : current ? "suggested" : requestEnded(request) ? "failed" : "requested",
      /** "supervisor": proposed when the learner submitted a gate conversation; "staff": a reviewer asked. */
      origin: valid ? request.origin : null,
      draft: current && parsed.success ? { suggestionId: request.suggestion_id, summary: parsed.data.summary, criteria: parsed.data.criteria, notAGrade: true } : null,
      /** What the gate's deterministic evaluator concluded, when it has one; a declined check leaves the answer to a person. */
      automaticCheck: current && request.automatic_check ? request.automatic_check : null,
    }];
  }));
}

/**
 * The supervisor proposes quoted findings for a gate-conversation turn by itself, as soon as the
 * learner submits it, when the learner has allowed AI drafts and a reviewer model is configured.
 * The proposal is only a draft: the host verifier rechecks every quote, and a human reviewer or
 * the gate's installed deterministic evaluator must confirm it before anything counts.
 */
export async function proposeConversationFindings(client: PoolClient, input: { attemptId: string; enrollmentId: string; workspaceId: string; assessment: ReviewedRubric; response: string }) {
  if (!input.assessment.conversationGateId) return null;
  const consent = (await client.query("SELECT granted,revision FROM rubric_assist_consents WHERE enrollment_id=$1 FOR SHARE", [input.enrollmentId])).rows[0];
  if (!consent?.granted) return null;
  const id = randomUUID();
  await client.query(
    "INSERT INTO rubric_assist_requests(id,attempt_id,enrollment_id,workspace_id,requested_by,origin,consent_revision,rubric_digest,response_digest) VALUES($1,$2,$3,$4,NULL,'supervisor',$5,$6,$7)",
    [id, input.attemptId, input.enrollmentId, input.workspaceId, consent.revision, rubricDigest(input.assessment), digestJson(input.response)]);
  const event = await appendEvent(client, { workspaceId: input.workspaceId, enrollmentId: input.enrollmentId, actorKind: "system",
    type: "rubric.assist_requested", payload: { requestId: id, origin: "supervisor" }, idempotencyKey: "rubric-assist:supervisor:" + input.attemptId, supervise: true });
  await client.query("UPDATE rubric_assist_requests SET activation_event_id=$2 WHERE id=$1", [id, event.id]);
  return id;
}

export function registerRubricAssistRoutes(app: FastifyInstance, db: Database, auth: ReturnType<typeof authService>, reviewerAvailable: (workspaceId: string) => Promise<boolean>) {
  const uuid = { type: "string", format: "uuid" };
  const params = (name: string) => ({ type: "object", additionalProperties: false, required: [name], properties: { [name]: uuid } });
  app.get("/api/enrollments/:enrollmentId/review-assist", { schema: { params: params("enrollmentId") } }, async (request) => {
    const actor = await auth.authenticate(request), { enrollmentId } = request.params as { enrollmentId: string };
    const context = await loadEnrollment(db, actor, enrollmentId);
    const row = (await db.query("SELECT granted,revision FROM rubric_assist_consents WHERE enrollment_id=$1", [context.enrollment.id])).rows[0];
    // Whether this course has any answer a person (or a gate's deterministic evaluator) reviews, including gate conversations.
    const course = context.release.server_bundle;
    const applies = course.assessments.some((a) => reviewedRubric(course, a.id) !== undefined) || course.gates.some((g) => gateConversation(course, g) !== undefined);
    return { applies, granted: row?.granted ?? false, consentRevision: row?.revision ?? 0,
      sharedWithModel: ["question", "rubric", "your written answer", "your earlier answers and the reviewer's questions in the same review conversation"],
      notShared: ["your name", "your profile", "your history"] };
  });
  app.post("/api/enrollments/:enrollmentId/review-assist", {
    schema: { params: params("enrollmentId"), body: { type: "object", additionalProperties: false, required: ["expectedRevision", "idempotencyKey", "granted"],
      properties: { expectedRevision: { type: "integer", minimum: 1 }, idempotencyKey: { type: "string", minLength: 8, maxLength: 200 }, granted: { type: "boolean" } } } },
  }, async (request) => {
    const actor = await auth.authenticate(request), { enrollmentId } = request.params as { enrollmentId: string }, input = request.body as CommandInput & { granted: boolean };
    return enrollmentCommand(db, actor, enrollmentId, "review_assist.consent", input, async (client, context) => {
      requireCondition(context.enrollment.user_id === actor.id, "LEARNER_ONLY", 403);
      const saved = (await client.query(
        `INSERT INTO rubric_assist_consents(enrollment_id,workspace_id,granted) VALUES($1,$2,$3)
         ON CONFLICT(enrollment_id) DO UPDATE SET granted=EXCLUDED.granted,revision=rubric_assist_consents.revision+1,changed_at=clock_timestamp() RETURNING revision`,
        [enrollmentId, context.enrollment.workspace_id, input.granted])).rows[0];
      await client.query("UPDATE enrollments SET revision=revision+1 WHERE id=$1", [enrollmentId]);
      await appendEvent(client, { workspaceId: context.enrollment.workspace_id, enrollmentId, actorId: actor.id, actorKind: "learner",
        type: input.granted ? "review_assist.granted" : "review_assist.revoked", payload: { consentRevision: saved.revision }, idempotencyKey: `${enrollmentId}:${input.idempotencyKey}` });
      return { granted: input.granted, consentRevision: saved.revision };
    });
  });
  const requestSchema = z.strictObject({ idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/) });
  app.post("/api/admin/rubric-reviews/:attemptId/assist", { schema: { params: params("attemptId") } }, async (request) => {
    const actor = await auth.authenticate(request), { attemptId } = request.params as { attemptId: string };
    const parsed = requestSchema.safeParse(request.body);
    requireCondition(parsed.success, "INVALID_INPUT", 400);
    const target = (await db.query("SELECT a.enrollment_id,e.workspace_id,e.course_release_id FROM attempts a JOIN enrollments e ON e.id=a.enrollment_id WHERE a.id=$1", [attemptId])).rows[0];
    requireCondition(target, "ATTEMPT_NOT_FOUND", 404);
    requireCondition(roleCan(await enrollmentRole(db, actor, target), "evidence.review"), "FORBIDDEN", 403);
    // Fail before queueing anything when no reviewer model is configured for this workspace.
    requireCondition(await reviewerAvailable(target.workspace_id), "RUBRIC_ASSIST_UNAVAILABLE", 503);
    return transaction(db, async (client) => {
      const row = (await client.query(
        `SELECT a.id,a.response,a.result,a.assessment_id,e.id AS enrollment_id,e.workspace_id,e.user_id,e.status,e.course_release_id
         FROM attempts a JOIN enrollments e ON e.id=a.enrollment_id WHERE a.id=$1 FOR UPDATE OF a`, [attemptId])).rows[0];
      requireCondition(row.user_id !== actor.id, "SELF_REVIEW_FORBIDDEN", 403);
      requireCondition(row.status === "active", "ENROLLMENT_INACTIVE", 409);
      const consent = (await client.query("SELECT granted,revision FROM rubric_assist_consents WHERE enrollment_id=$1 FOR SHARE", [row.enrollment_id])).rows[0];
      const existing = (await client.query(`${LIVE_REQUEST_SQL} WHERE r.attempt_id=$1 AND r.state<>'superseded' FOR UPDATE OF r`, [attemptId])).rows[0];
      // A request that can still produce a draft under the current grant is replayed; one that never will is superseded below.
      if (existing && consent?.granted && consent.revision === existing.consent_revision && !requestEnded(existing))
        return { requestId: existing.id, state: existing.state, replayed: true };
      const release = await readRelease(client, row.course_release_id, row.workspace_id);
      const assessment = release ? reviewedRubric(release.server_bundle, row.assessment_id) : undefined;
      requireCondition(assessment && row.result?.status === "pending_review", "NOT_A_PENDING_RUBRIC_ATTEMPT", 409);
      requireCondition(!(await client.query("SELECT 1 FROM rubric_reviews WHERE attempt_id=$1", [attemptId])).rowCount, "RUBRIC_ALREADY_REVIEWED", 409);
      requireCondition(consent?.granted, "RUBRIC_ASSIST_CONSENT_REQUIRED", 409);
      if (existing) await client.query("UPDATE rubric_assist_requests SET state='superseded' WHERE id=$1", [existing.id]);
      const id = randomUUID();
      await client.query(
        "INSERT INTO rubric_assist_requests(id,attempt_id,enrollment_id,workspace_id,requested_by,consent_revision,rubric_digest,response_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [id, attemptId, row.enrollment_id, row.workspace_id, actor.id, consent.revision, rubricDigest(assessment), digestJson(String(row.response))]);
      const event = await appendEvent(client, { workspaceId: row.workspace_id, enrollmentId: row.enrollment_id, actorId: actor.id, actorKind: "staff",
        type: "rubric.assist_requested", payload: { requestId: id }, idempotencyKey: "rubric-assist:" + (existing ? id : attemptId), supervise: true });
      await client.query("UPDATE rubric_assist_requests SET activation_event_id=$2 WHERE id=$1", [id, event.id]);
      return { requestId: id, state: "requested", replayed: false };
    });
  });
  /** How often reviewers agreed with drafts they had open. A measure of the
   * model's usefulness here, not proof of its accuracy or of learning. */
  app.get("/api/admin/courses/:catalogId/rubric-assist/agreement", { schema: { params: params("catalogId") } }, async (request) => {
    const actor = await auth.authenticate(request), { catalogId } = request.params as { catalogId: string };
    const catalog = (await db.query("SELECT workspace_id,course_key FROM admin_course_catalog WHERE id=$1", [catalogId])).rows[0];
    requireCondition(catalog, "COURSE_NOT_FOUND", 404);
    await permitCourse(db, actor, catalog.workspace_id, catalogId, "evidence.review");
    const rows = (await db.query(
      `SELECT v.criteria->'findings' AS findings,f.content FROM rubric_reviews v JOIN rubric_suggestions s ON s.id=v.suggestion_id
       JOIN supervisor_artifacts f ON f.id=s.artifact_id JOIN enrollments e ON e.id=v.enrollment_id JOIN course_releases r ON r.id=e.course_release_id
       WHERE e.workspace_id=$1 AND r.course_key=$2 AND e.status<>'erased'`, [catalog.workspace_id, catalog.course_key])).rows;
    let criteria = 0, agreed = 0;
    for (const row of rows) {
      const draft = rubricSuggestionSchema.safeParse(row.content);
      if (!draft.success) continue;
      for (const finding of row.findings as { criterionId: string; met: boolean }[]) {
        const suggested = draft.data.criteria.find((c) => c.criterionId === finding.criterionId);
        if (!suggested) continue;
        criteria += 1;
        if (suggested.met === finding.met) agreed += 1;
      }
    }
    return { reviewsWithDraft: rows.length, criteriaCompared: criteria, criteriaAgreed: agreed, interpretation: "reviewer agreement with drafts they saw; not accuracy and not learning outcomes" };
  });
}
