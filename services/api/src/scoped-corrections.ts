import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { z } from "zod";
import { runRefSchema, snapshotSchema } from "@course-core/supervisor";
import type { CourseManifest } from "@course-core/sdk";
import type { Actor, authService } from "./auth.js";
import { transaction, type Database } from "./database.js";
import { requireCondition } from "./errors.js";
import { requireSameRequest } from "./erased-digests.js";
import { appendEvent } from "./events.js";
import { digestJson, loadEnrollmentRecords, type Enrollment } from "./repository.js";
import { catalogFor, enrollmentFor, type Catalog } from "./admin-routes.js";
import { courseRun } from "./run-inspector.js";
import { consentWithdrawn } from "./supervision-control.js";
import { RETRY_EVENT } from "./supervisor-bridge.js";
import { codeView, DETERMINISTIC_ITEM_TYPES, findAssessment, reviewedRubric } from "./gates.js";
import { gradeDeterministic } from "./learning.js";
import { gradeCodeAnswer } from "./generated-content.js";
import { rubricDigest } from "./rubric-evaluator.js";
import { checkFindings, threadOf } from "./rubric-judgment.js";
import { refreshDecisionsForEnrollment } from "./gate-decisions.js";
import type { RuntimeExtension } from "./publication.js";
import { gradingProvenance, provenanceChanges, provenanceColumns } from "./grading-provenance.js";

/**
 * Scoped staff corrections (U07). Each acts on exactly one item, is idempotent under its key
 * (command_receipts, as every enrollment command), is recorded as a staff learning event on the
 * learner's record, and is refused for an erased (410) or closed (409) enrollment.
 *
 * - Cancel: one live supervisor run is stopped before it applies anything (cancelRunWithin).
 * - Retry: one supervisor run that failed, ended uncertain or was cancelled by staff is run again. The retry is a new
 *   staff learning event that the dispatcher prepares into a new run through the normal path
 *   (supervision control, consent, policy, fence and budgets, then the verifier and the
 *   application step). The retried run is never changed or resumed; supervisor_job_retries links
 *   the two runs, and a run is retried at most once.
 * - Regrade: one automated or rubric attempt receives a new decision, linked to the decision it
 *   supersedes (attempt_regrades). An automated attempt is graded again by the course's own
 *   evaluator; a rubric attempt is judged by a second person under the same quoting rules as a
 *   review or appeal (checkFindings). The attempt row and earlier decisions are never edited. When
 *   the outcome changes, the attempt's current evidence is invalidated with a reason, new evidence
 *   names the regrade, and the learner's gate decisions are recomputed; an upheld regrade changes
 *   no evidence.
 */

export const REGRADE_EVENT = "assessment.regraded";
const key = z.string().regex(/^[A-Za-z0-9._:-]{8,200}$/);
export const retryInputSchema = z.strictObject({ idempotencyKey: key, reason: z.string().trim().min(10).max(500) });
export const regradeInputSchema = z.strictObject({
  idempotencyKey: key,
  reason: z.string().trim().min(10).max(2000),
  /** Rubric attempts only: the second reviewer's decision and one finding per criterion. */
  decision: z.enum(["met", "not_met"]).optional(),
  criteria: z.array(z.strictObject({ criterionId: z.string().min(1).max(128), met: z.boolean(), quote: z.string().trim().min(10).max(800).optional(),
    note: z.string().trim().max(500).optional() })).min(1).max(12).optional(),
});
type RetryInput = z.infer<typeof retryInputSchema>;
type RegradeInput = z.infer<typeof regradeInputSchema>;

/** Erased learning data is gone (410). A course that reached closure, completed or closed by
 * its policy, is never silently changed afterwards (closed-record.ts), so corrections stop. */
export function refuseEndedEnrollment(enrollment: Pick<Enrollment, "status">) {
  requireCondition(enrollment.status !== "erased", "ENROLLMENT_ERASED", 410);
  requireCondition(enrollment.status !== "closed" && enrollment.status !== "completed", "ENROLLMENT_CLOSED", 409);
}

/** Replays a stored response for the same key and request; a different request under the same
 * key is a conflict. Otherwise runs `work` and stores its response, in the caller's transaction. */
async function receipted<T extends object>(client: PoolClient, enrollmentId: string, actorId: string, operation: string, idempotencyKey: string,
  semantic: unknown, work: () => Promise<T>): Promise<T & { replayed: boolean }> {
  const digest = digestJson({ actorId, operation, semantic });
  const old = (await client.query<{ request_digest: string; response: T }>(
    "SELECT request_digest,response FROM command_receipts WHERE enrollment_id=$1 AND idempotency_key=$2", [enrollmentId, idempotencyKey])).rows[0];
  if (old) {
    requireSameRequest(old.request_digest, digest, "IDEMPOTENCY_CONFLICT");
    return { ...old.response, replayed: true };
  }
  const response = await work();
  await client.query("INSERT INTO command_receipts(enrollment_id,idempotency_key,request_digest,response) VALUES($1,$2,$3,$4)",
    [enrollmentId, idempotencyKey, digest, JSON.stringify(response)]);
  return { ...response, replayed: false };
}

/** How a run ended, for a retry: failed, ended with a provider call whose outcome is unknown, or
 * was cancelled by staff before it applied anything. A run cancelled for any other reason (erasure,
 * a provider change, a stopped supervision) is not retried: that reason still holds. */
function retryOutcome(state: string, runtime: unknown, staffCancelled: boolean): "failed" | "uncertain" | "cancelled" | null {
  const parsed = snapshotSchema.safeParse(runtime);
  const uncertain = parsed.success && parsed.data.operations.some((op) => op.status === "uncertain");
  if ((state === "failed" || state === "cancelled") && uncertain) return "uncertain";
  if (state === "cancelled" && staffCancelled) return "cancelled";
  return state === "failed" ? "failed" : null;
}

/** Retries one supervisor run of the course, in the caller's transaction (which checked
 * `run.retry` on the course). */
export async function retryRunWithin(client: PoolClient, actor: Actor, catalog: Catalog, runId: string, input: RetryInput) {
  const run = await courseRun(client, catalog, runId);
  const enrollment = (await client.query<Enrollment>("SELECT * FROM enrollments WHERE id=$1 AND workspace_id=$2 FOR UPDATE", [run.enrollment_id, run.workspace_id])).rows[0]!;
  requireCondition(enrollment.status !== "erased", "ENROLLMENT_ERASED", 410);
  return receipted(client, enrollment.id, actor.id, "supervisor.run_retry", input.idempotencyKey, { runId, reason: input.reason }, async () => {
    refuseEndedEnrollment(enrollment);
    const job = (await client.query<{ role: string; state: string; runtime_snapshot: unknown; input_event_id: string | null }>(
      "SELECT role,state,runtime_snapshot,input_event_id FROM supervisor_jobs WHERE id=$1 AND enrollment_id=$2 AND workspace_id=$3 FOR UPDATE",
      [runId, enrollment.id, enrollment.workspace_id])).rows[0]!;
    // Companion, research and written-answer runs answer one learner or staff request that is
    // linked to its run; those are asked again through their own flows instead.
    requireCondition(job.role === "supervisor", "RUN_RETRY_UNSUPPORTED", 409);
    requireCondition(!(await client.query("SELECT 1 FROM supervisor_job_retries WHERE job_id=$1", [runId])).rowCount, "RUN_ALREADY_RETRIED", 409);
    // A live run (also one waiting on an uncertain call) is never run twice at once.
    requireCondition(["applied", "cancelled", "failed"].includes(job.state), "RUN_NOT_ENDED", 409);
    const staffCancelled = Boolean((await client.query("SELECT 1 FROM supervisor_run_cancellations WHERE job_id=$1", [runId])).rowCount);
    const outcome = retryOutcome(job.state, job.runtime_snapshot, staffCancelled);
    requireCondition(outcome, "RUN_NOT_RETRYABLE", 409);
    const control = (await client.query<{ state: string }>("SELECT state FROM supervisor_controls WHERE enrollment_id=$1 FOR SHARE", [enrollment.id])).rows[0];
    requireCondition(control?.state !== "stopped", "SUPERVISION_STOPPED", 409);
    const source = job.input_event_id ? (await client.query<{ id: string; event_type: string; payload: unknown; created_at: Date }>(
      "SELECT id,event_type,payload,created_at FROM learning_events WHERE id=$1", [job.input_event_id])).rows[0] : undefined;
    if (source) {
      const withdrawn = await consentWithdrawn(client, source, enrollment.id, enrollment.workspace_id);
      requireCondition(!withdrawn, withdrawn ?? "", 409);
    }
    const parsed = snapshotSchema.safeParse(job.runtime_snapshot), previousReason = parsed.success ? parsed.data.reason : null;
    const event = await appendEvent(client, { workspaceId: enrollment.workspace_id, enrollmentId: enrollment.id, actorId: actor.id, actorKind: "staff", type: RETRY_EVENT,
      payload: { runId, role: job.role, outcome, previousState: job.state, previousReason }, ...(source ? { causationId: source.id } : {}),
      idempotencyKey: `supervisor:retry:${runId}`, supervise: true });
    await client.query(`INSERT INTO supervisor_job_retries(job_id,enrollment_id,workspace_id,retry_event_id,actor_id,reason,outcome,previous_state,previous_reason,idempotency_key)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [runId, enrollment.id, enrollment.workspace_id, event.id, actor.id, input.reason, outcome, job.state, previousReason, input.idempotencyKey]);
    return { runId, retryEventId: event.id, outcome, previousState: job.state, previousReason, state: "queued" as const };
  });
}

export const CANCEL_EVENT = "supervisor.run_cancel_requested";
export const cancelInputSchema = z.strictObject({ idempotencyKey: key, reason: z.string().trim().min(10).max(500) });

/** Cancels one live supervisor run of the course, in the caller's transaction (which checked
 * `supervision.control` on the course). The job's cancellation flag is the authority: the bridge
 * stops a flagged job at its next step, before any provider call, and nothing it planned is
 * applied. A queued wake-up signal makes a running call or wait end now. The learner's other
 * runs and their supervision control are untouched. */
export async function cancelRunWithin(client: PoolClient, actor: Actor, catalog: Catalog, runId: string, input: z.infer<typeof cancelInputSchema>) {
  const run = await courseRun(client, catalog, runId);
  const enrollment = (await client.query<Enrollment>("SELECT * FROM enrollments WHERE id=$1 AND workspace_id=$2 FOR UPDATE", [run.enrollment_id, run.workspace_id])).rows[0]!;
  requireCondition(enrollment.status !== "erased", "ENROLLMENT_ERASED", 410);
  return receipted(client, enrollment.id, actor.id, "supervisor.run_cancel", input.idempotencyKey, { runId, reason: input.reason }, async () => {
    const job = (await client.query<{ role: string; state: string; cancellation_requested: boolean; generation: number | null }>(
      "SELECT role,state,cancellation_requested,(runtime_snapshot->>'generation')::integer AS generation FROM supervisor_jobs WHERE id=$1 AND enrollment_id=$2 AND workspace_id=$3 FOR UPDATE",
      [runId, enrollment.id, enrollment.workspace_id])).rows[0]!;
    requireCondition(!["applied", "cancelled", "failed"].includes(job.state), "RUN_ALREADY_ENDED", 409);
    requireCondition(!job.cancellation_requested, "RUN_CANCEL_ALREADY_REQUESTED", 409);
    await client.query("UPDATE supervisor_jobs SET cancellation_requested=true WHERE id=$1", [runId]);
    const signalled = job.generation !== null;
    if (signalled) await client.query("INSERT INTO supervisor_job_cancellations(id,enrollment_id,workspace_id,reason,jobs) VALUES($1,$2,$3,'staff_cancelled',$4)",
      [randomUUID(), enrollment.id, enrollment.workspace_id, JSON.stringify([runRefSchema.parse({ jobId: runId, workspaceId: enrollment.workspace_id, enrollmentId: enrollment.id, generation: job.generation })])]);
    const event = await appendEvent(client, { workspaceId: enrollment.workspace_id, enrollmentId: enrollment.id, actorId: actor.id, actorKind: "staff", type: CANCEL_EVENT,
      payload: { runId, role: job.role, previousState: job.state, signalled }, idempotencyKey: `supervisor:cancel:${runId}`, supervise: false });
    await client.query(`INSERT INTO supervisor_run_cancellations(job_id,enrollment_id,workspace_id,actor_id,reason,previous_state,event_id,idempotency_key)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [runId, enrollment.id, enrollment.workspace_id, actor.id, input.reason, job.state, event.id, input.idempotencyKey]);
    return { runId, previousState: job.state, state: "cancel_requested" as const, signalled, eventId: event.id };
  });
}

interface AttemptRow {
  id: string; enrollment_id: string; assessment_id: string; course_digest: string; mode: string; response: unknown;
  result: { passed?: boolean; abstained?: boolean; status?: string; rubricDigest?: string; independentEligible?: boolean; conversation?: unknown; evaluator?: string };
  item_digest: string | null; answer_key_digest: string | null; evaluator_digest: string | null; code_image: string | null;
}
interface Decision { kind: "attempt" | "review" | "appeal" | "regrade"; id: string; passed: boolean; actorId: string | null; decision?: "met" | "not_met" }

/** The decision on an attempt that is in force now: its newest regrade, else (rubric) a decided
 * appeal or the review, else (automated) the attempt's own result. Null when nothing is decided. */
async function currentDecision(client: PoolClient | Database, attempt: AttemptRow, rubric: boolean): Promise<Decision | null> {
  const regrade = (await client.query<{ id: string; passed: boolean; actor_id: string; result: { decision?: "met" | "not_met" } }>(
    `SELECT g.id,g.passed,g.actor_id,g.result FROM attempt_regrades g WHERE g.attempt_id=$1 AND g.enrollment_id=$2
      AND NOT EXISTS (SELECT 1 FROM attempt_regrades n WHERE n.supersedes_kind='regrade' AND n.supersedes_id=g.id)`, [attempt.id, attempt.enrollment_id])).rows[0];
  if (regrade) return { kind: "regrade", id: regrade.id, passed: regrade.passed, actorId: regrade.actor_id, ...(regrade.result.decision ? { decision: regrade.result.decision } : {}) };
  if (!rubric) return typeof attempt.result.passed === "boolean" ? { kind: "attempt", id: attempt.id, passed: attempt.result.passed, actorId: null } : null;
  const appeal = (await client.query<{ id: string; reviewer_id: string; decision: "met" | "not_met"; state: string }>(
    "SELECT id,reviewer_id,decision,state FROM rubric_appeals WHERE attempt_id=$1 AND enrollment_id=$2 AND state IN ('upheld','changed')", [attempt.id, attempt.enrollment_id])).rows[0];
  if (appeal) return { kind: "appeal", id: appeal.id, passed: appeal.decision === "met", actorId: appeal.reviewer_id, decision: appeal.decision };
  const review = (await client.query<{ id: string; reviewer_id: string | null; decision: string }>(
    "SELECT id,reviewer_id,decision FROM rubric_reviews WHERE attempt_id=$1 AND enrollment_id=$2", [attempt.id, attempt.enrollment_id])).rows[0];
  if (!review || (review.decision !== "met" && review.decision !== "not_met")) return null;
  return { kind: "review", id: review.id, passed: review.decision === "met", actorId: review.reviewer_id, decision: review.decision };
}

/** The course version the attempt was answered on (its own evaluator and rubric). */
async function attemptCourse(client: PoolClient | Database, enrollment: Enrollment, attempt: AttemptRow, current: { digest: string; server_bundle: CourseManifest }) {
  if (attempt.course_digest === current.digest) return current.server_bundle;
  const row = (await client.query<{ server_bundle: CourseManifest }>("SELECT server_bundle FROM course_releases WHERE workspace_id=$1 AND digest=$2 LIMIT 1",
    [enrollment.workspace_id, attempt.course_digest])).rows[0];
  requireCondition(row, "COURSE_VERSION_UNAVAILABLE", 409);
  return row.server_bundle;
}

async function lockedAttempt(client: PoolClient, enrollmentId: string, attemptId: string, lock: boolean) {
  const row = (await client.query<AttemptRow>(
    `SELECT id,enrollment_id,assessment_id,course_digest,mode,response,result,item_digest,answer_key_digest,evaluator_digest,code_image FROM attempts WHERE id=$1 AND enrollment_id=$2 ${lock ? "FOR UPDATE" : ""}`,
    [attemptId, enrollmentId])).rows[0];
  requireCondition(row, "ATTEMPT_NOT_FOUND", 404);
  return row;
}

/** What a regrade of this attempt would act on, and the attempt's decision history. */
const bound = (row: { item_digest: string | null; answer_key_digest: string | null; evaluator_digest: string | null; code_image: string | null }) =>
  ({ itemDigest: row.item_digest, answerKeyDigest: row.answer_key_digest, evaluatorDigest: row.evaluator_digest, codeImage: row.code_image });
export async function regradeView(client: PoolClient, context: { enrollment: Enrollment; release: { digest: string; server_bundle: CourseManifest } }, attemptId: string,
  installed: RuntimeExtension[] = []) {
  const attempt = await lockedAttempt(client, context.enrollment.id, attemptId, false);
  const course = await attemptCourse(client, context.enrollment, attempt, context.release);
  const rubric = attempt.result.status === "pending_review" ? reviewedRubric(course, attempt.assessment_id) : undefined;
  const current = await currentDecision(client, attempt, attempt.result.status === "pending_review");
  const history = (await client.query<{ id: string; kind: string; outcome: string; passed: boolean; previous_passed: boolean; supersedes_kind: string; supersedes_id: string;
    evaluator_ref: string; reason: string; display_name: string; created_at: Date; item_digest: string | null; answer_key_digest: string | null; evaluator_digest: string | null; code_image: string | null }>(
    `SELECT g.id,g.kind,g.outcome,g.passed,g.previous_passed,g.supersedes_kind,g.supersedes_id,g.evaluator_ref,g.reason,u.display_name,g.created_at,
        g.item_digest,g.answer_key_digest,g.evaluator_digest,g.code_image
       FROM attempt_regrades g JOIN app_users u ON u.id=g.actor_id WHERE g.attempt_id=$1 AND g.enrollment_id=$2 ORDER BY g.created_at,g.id`,
    [attempt.id, context.enrollment.id])).rows;
  const thread = rubric ? await threadOf(client, attempt.id) : [];
  return {
    attemptId: attempt.id,
    assessmentId: attempt.assessment_id,
    kind: attempt.result.status === "pending_review" ? "rubric" as const : "automated" as const,
    current: current ? { kind: current.kind, id: current.id, passed: current.passed, decision: current.decision ?? null } : null,
    // What the original grading was bound to, and what differs in the course version's item now.
    provenance: { ...bound(attempt), changedSince: findAssessment(course, attempt.assessment_id) ? provenanceChanges(attempt, gradingProvenance(course, attempt.assessment_id, installed)) : null },
    history: history.map((row) => ({ regradeId: row.id, kind: row.kind, outcome: row.outcome, passed: row.passed, previousPassed: row.previous_passed,
      supersedes: { kind: row.supersedes_kind, id: row.supersedes_id }, evaluatorRef: row.evaluator_ref, reason: row.reason, actor: row.display_name, at: row.created_at.toISOString(),
      provenance: bound(row) })),
    ...(rubric ? { rubric: { prompt: rubric.prompt, criteria: rubric.criteria, answers: [...thread.map((t) => t.response), String(attempt.response)] } } : {}),
  };
}

/** Regrades one attempt of the enrollment, in the caller's transaction (which checked
 * `evidence.regrade` and holds the enrollment lock). */
export async function regradeAttemptWithin(client: PoolClient, actor: Actor, context: { enrollment: Enrollment; release: { digest: string; server_bundle: CourseManifest } },
  attemptId: string, input: RegradeInput, installed: RuntimeExtension[]) {
  const { enrollment } = context;
  requireCondition(enrollment.status !== "erased", "ENROLLMENT_ERASED", 410);
  // Nobody regrades their own answer.
  requireCondition(enrollment.user_id !== actor.id, "SELF_REVIEW_FORBIDDEN", 403);
  const { idempotencyKey: _key, ...semantic } = input;
  return receipted(client, enrollment.id, actor.id, "assessment.regrade", input.idempotencyKey, { attemptId, ...semantic }, async () => {
    refuseEndedEnrollment(enrollment);
    const attempt = await lockedAttempt(client, enrollment.id, attemptId, true);
    // Placement and retention answers feed their own runs and schedules, not the gate path.
    requireCondition(attempt.mode === "practice" || attempt.mode === "independent", "REGRADE_UNSUPPORTED", 409);
    requireCondition(attempt.result.abstained !== true, "NOTHING_TO_REGRADE", 409);
    const course = await attemptCourse(client, enrollment, attempt, context.release);
    const assessment = findAssessment(course, attempt.assessment_id);
    requireCondition(assessment, "NOTHING_TO_REGRADE", 409);
    const isRubric = attempt.result.status === "pending_review";
    // A learner's open appeal is decided in the appeal queue first; the regrade then supersedes it.
    if (isRubric) requireCondition(!(await client.query("SELECT 1 FROM rubric_appeals WHERE attempt_id=$1 AND state='open'", [attempt.id])).rowCount, "APPEAL_OPEN", 409);
    const current = await currentDecision(client, attempt, isRubric);
    requireCondition(current, isRubric ? "NOT_YET_REVIEWED" : "NOTHING_TO_REGRADE", 409);
    // Evidence staff invalidated (a defective item, a rejection) stays withdrawn: a regrade never restores it.
    const valid = (await client.query<{ id: string; independent: boolean }>(
      "SELECT id,independent FROM evidence WHERE attempt_id=$1 AND enrollment_id=$2 AND invalidated_at IS NULL FOR UPDATE", [attempt.id, enrollment.id])).rows;
    requireCondition(valid.length, "EVIDENCE_INVALIDATED", 409);
    let passed: boolean, evaluatorRef: string, result: Record<string, unknown>, evidenceResult: Record<string, unknown>, independent: boolean;
    let graded: { execution?: { runtime?: { image?: string } } } | undefined;
    if (isRubric) {
      const rubric = reviewedRubric(course, attempt.assessment_id);
      requireCondition(rubric && rubricDigest(rubric) === attempt.result.rubricDigest, "RUBRIC_CHANGED", 409);
      requireCondition(input.decision && input.criteria, "RUBRIC_FINDINGS_REQUIRED", 400);
      // A second person: never the one whose decision this replaces.
      requireCondition(current.actorId !== actor.id, "SECOND_REVIEWER_REQUIRED", 403);
      const thread = await threadOf(client, attempt.id);
      checkFindings(rubric.criteria, [...thread.map((t) => t.response), String(attempt.response)], input.decision, input.criteria);
      const turns = [...thread.map((t) => ({ turnId: t.attemptId, text: t.response })), { turnId: attempt.id, text: String(attempt.response) }];
      const citedSpans = input.criteria.filter((c) => c.met && c.quote).map((c) => ({ turnId: turns.find((t) => t.text.includes(c.quote!))!.turnId, quote: c.quote! }));
      passed = input.decision === "met";
      evaluatorRef = "reviewed-rubric-regrade@1";
      result = { decision: input.decision, findings: input.criteria };
      evidenceResult = { passed, reviewed: true, ...(rubric.rubricRef ? { citedSpans } : {}),
        ...(rubric.conversationGateId && attempt.result.conversation ? { conversation: attempt.result.conversation } : {}) };
      independent = Boolean(attempt.result.independentEligible);
    } else {
      requireCondition(!input.decision && !input.criteria, "INVALID_INPUT", 400);
      // The course's own evaluator for this item, as the answer route runs it.
      const code = codeView(course, assessment);
      requireCondition(code || DETERMINISTIC_ITEM_TYPES.has(assessment.type), "EVALUATOR_NOT_CONFIGURED", 409);
      const grade = code ? await gradeCodeAnswer(client, enrollment.id, code, attempt.response, course, installed) : gradeDeterministic(assessment, attempt.response);
      passed = grade.passed;
      graded = "execution" in grade ? grade : undefined;
      evaluatorRef = grade.evaluator;
      result = { ...grade };
      evidenceResult = { passed };
      independent = valid.some((row) => row.independent);
    }
    const regradeId = randomUUID(), changed = passed !== current.passed;
    if (changed) {
      await client.query("UPDATE evidence SET invalidated_at=now(),invalidation_reason='Superseded by a regrade' WHERE id=ANY($1::uuid[])", [valid.map((row) => row.id)]);
      for (const objectiveId of assessment.objectiveIds)
        await client.query("INSERT INTO evidence (id,enrollment_id,attempt_id,objective_id,evaluator_ref,result,independent) VALUES ($1,$2,$3,$4,$5,$6,$7)",
          // Evidence is unique per attempt, objective and evaluator reference: each regrade names its own.
          [randomUUID(), enrollment.id, attempt.id, objectiveId, `${evaluatorRef}#regrade:${regradeId}`, JSON.stringify({ ...evidenceResult, regraded: true, regradeId }), independent]);
    }
    const outcome = changed ? "changed" as const : "upheld" as const, supersedes = { kind: current.kind, id: current.id };
    const kind = isRubric ? "rubric" as const : "automated" as const;
    const event = await appendEvent(client, { workspaceId: enrollment.workspace_id, enrollmentId: enrollment.id, actorId: actor.id, actorKind: "staff", type: REGRADE_EVENT,
      payload: { regradeId, attemptId: attempt.id, assessmentId: attempt.assessment_id, kind, outcome, passed, previousPassed: current.passed, supersedes },
      idempotencyKey: `regrade:${regradeId}`, supervise: true });
    // The regrade binds the item, key and evaluator it graded with (M03), like an attempt does.
    await client.query(`INSERT INTO attempt_regrades(id,attempt_id,enrollment_id,workspace_id,kind,supersedes_kind,supersedes_id,previous_passed,passed,outcome,evaluator_ref,result,reason,actor_id,event_id,idempotency_key,
        item_digest,answer_key_digest,evaluator_digest,code_image)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
      [regradeId, attempt.id, enrollment.id, enrollment.workspace_id, kind, current.kind, current.id, current.passed, passed, outcome, evaluatorRef, JSON.stringify(result),
        input.reason, actor.id, event.id, input.idempotencyKey, ...provenanceColumns(gradingProvenance(course, attempt.assessment_id, installed, graded))]);
    await client.query("UPDATE enrollments SET revision=revision+1 WHERE id=$1", [enrollment.id]);
    // The gate path: decisions that relied on the superseded evidence are recomputed.
    if (changed) await refreshDecisionsForEnrollment(client, enrollment.id, attempt.assessment_id);
    return { regradeId, attemptId: attempt.id, kind, outcome, passed, previousPassed: current.passed, supersedes, eventId: event.id,
      evidence: { invalidated: changed ? valid.length : 0, created: changed ? assessment.objectiveIds.length : 0 } };
  });
}

/** Staff routes for the two corrections and the regrade view. */
export function registerScopedCorrectionRoutes(app: FastifyInstance, db: Database, auth: ReturnType<typeof authService>, installed: () => RuntimeExtension[]) {
  const uuid = z.string().uuid();
  const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
    const parsed = schema.safeParse(value);
    requireCondition(parsed.success, "INVALID_INPUT", 400);
    return parsed.data!;
  };
  app.post("/api/admin/courses/:courseId/runs/:runId/retry", async (request) => {
    const actor = await auth.authenticate(request), params = request.params as { courseId: string; runId: string };
    const runId = parse(uuid, params.runId), input = parse(retryInputSchema, request.body);
    return transaction(db, async (client) => {
      const { catalog } = await catalogFor(client, actor, params.courseId, "run.retry");
      return retryRunWithin(client, actor, catalog, runId, input);
    });
  });
  app.post("/api/admin/courses/:courseId/runs/:runId/cancel", async (request) => {
    const actor = await auth.authenticate(request), params = request.params as { courseId: string; runId: string };
    const runId = parse(uuid, params.runId), input = parse(cancelInputSchema, request.body);
    return transaction(db, async (client) => {
      const { catalog } = await catalogFor(client, actor, params.courseId, "supervision.control");
      return cancelRunWithin(client, actor, catalog, runId, input);
    });
  });
  const attemptPath = "/api/admin/enrollments/:enrollmentId/attempts/:attemptId/regrade";
  app.get(attemptPath, async (request, reply) => {
    const actor = await auth.authenticate(request), params = request.params as { enrollmentId: string; attemptId: string };
    const attemptId = parse(uuid, params.attemptId);
    const view = await transaction(db, async (client) => {
      const { enrollment } = await enrollmentFor(client, actor, params.enrollmentId, "evidence.regrade");
      requireCondition(enrollment.status !== "erased", "ENROLLMENT_ERASED", 410);
      // The learner's resolved course (personal additions included), as their answers were graded.
      return regradeView(client, await loadEnrollmentRecords(client, enrollment), attemptId, installed());
    });
    reply.header("Cache-Control", "no-store");
    return view;
  });
  app.post(attemptPath, async (request) => {
    const actor = await auth.authenticate(request), params = request.params as { enrollmentId: string; attemptId: string };
    const attemptId = parse(uuid, params.attemptId), input = parse(regradeInputSchema, request.body);
    return transaction(db, async (client) => {
      const { enrollment } = await enrollmentFor(client, actor, params.enrollmentId, "evidence.regrade", true);
      requireCondition(enrollment.status !== "erased", "ENROLLMENT_ERASED", 410);
      return regradeAttemptWithin(client, actor, await loadEnrollmentRecords(client, enrollment), attemptId, input, installed());
    });
  });
}
