import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import type { CourseManifest } from "@course-core/sdk";
import type { Database } from "./database.js";
import { transaction } from "./database.js";
import type { authService } from "./auth.js";
import { requireCondition } from "./errors.js";
import { appendEvent } from "./events.js";
import { enrollmentCommand, loadEnrollment, type CommandInput, type EnrollmentContext } from "./repository.js";
import { episodes, gateDecision, publicQuestion } from "./learning.js";
import { assertPolicyAction } from "./policy-adapter.js";
import { systemClock, type Clock } from "./clock.js";

const DAY = 86_400_000;
type Retention = { intervalsDays: number[]; objectiveIds: string[]; assessmentIds: string[] };
const retentionOf = (course: CourseManifest) => (course as CourseManifest & { retention?: Retention }).retention;

/** When each retention objective was first demonstrated: the time the evidence
 * completing its gate was recorded. Gates evaluate demonstrated understanding;
 * retention items are held out of them by contract. */
function demonstrations(context: EnrollmentContext, created: Map<string, Date>) {
  const course = context.release.server_bundle, retention = retentionOf(course);
  const result = new Map<string, Date>();
  if (!retention) return result;
  for (const gate of course.gates) {
    const decision = gateDecision(gate, context.evidence, context.release.digest);
    for (const objective of decision.objectives) {
      if (!objective.passed || !retention.objectiveIds.includes(objective.id) || result.has(objective.id)) continue;
      const times = objective.evidenceIds.map((id) => created.get(id)).filter((t): t is Date => Boolean(t));
      if (times.length) result.set(objective.id, new Date(Math.max(...times.map((t) => t.getTime()))));
    }
  }
  return result;
}
/** Idempotently opens a schedule for every newly demonstrated objective. */
async function syncSchedules(client: PoolClient, context: EnrollmentContext) {
  const retention = retentionOf(context.release.server_bundle);
  if (!retention) return;
  const created = new Map(
    (await client.query<{ id: string; created_at: Date }>("SELECT id,created_at FROM evidence WHERE enrollment_id=$1", [context.enrollment.id])).rows.map((r) => [r.id, r.created_at]),
  );
  for (const [objectiveId, at] of demonstrations(context, created))
    await client.query(
      "INSERT INTO retention_schedules(enrollment_id,objective_id,demonstrated_at,step,due_at) VALUES($1,$2,$3,0,$4) ON CONFLICT DO NOTHING",
      [context.enrollment.id, objectiveId, at, new Date(at.getTime() + retention.intervalsDays[0]! * DAY)],
    );
}
async function view(client: PoolClient, context: EnrollmentContext, clock: Clock) {
  const course = context.release.server_bundle, retention = retentionOf(course);
  if (!retention) return { available: false, items: [] };
  await syncSchedules(client, context);
  const rows = (await client.query("SELECT * FROM retention_schedules WHERE enrollment_id=$1 ORDER BY due_at NULLS LAST,objective_id", [context.enrollment.id])).rows;
  const now = clock.now().getTime();
  const exposed = new Set((await client.query<{ assessment_id: string }>("SELECT assessment_id FROM assessment_challenges WHERE enrollment_id=$1", [context.enrollment.id])).rows.map((r) => r.assessment_id));
  return {
    available: true,
    intervalsDays: retention.intervalsDays,
    grantsCompletion: false,
    items: rows.map((r) => ({
      objectiveId: r.objective_id,
      description: course.objectives.find((o) => o.id === r.objective_id)?.description ?? r.objective_id,
      state: r.needs_review ? "needs_review" : r.retained_at ? "retained" : "demonstrated",
      demonstratedAt: r.demonstrated_at.toISOString(),
      retainedAt: r.retained_at?.toISOString() ?? null,
      dueAt: r.due_at?.toISOString() ?? null,
      due: Boolean(r.due_at && r.due_at.getTime() <= now),
      freshItemsLeft: retention.assessmentIds.filter((id) => !exposed.has(id) && course.assessments.find((a) => a.id === id)?.objectiveIds.includes(r.objective_id)).length,
    })),
  };
}
/** Applies a submitted retention answer to its schedule. Called inside the
 * answer transaction; never changes gates, completion or demonstrated status.
 * `now` comes from the same server clock that decided the check was due. */
export async function recordRetentionOutcome(client: PoolClient, context: EnrollmentContext, attemptId: string, objectiveIds: string[], passed: boolean, independent: boolean, now: Date = systemClock.now()) {
  const retention = retentionOf(context.release.server_bundle);
  if (!retention) return;
  for (const objectiveId of objectiveIds) {
    const row = (await client.query("SELECT * FROM retention_schedules WHERE enrollment_id=$1 AND objective_id=$2 FOR UPDATE", [context.enrollment.id, objectiveId])).rows[0];
    if (!row) continue;
    const success = passed && independent;
    const step = success ? row.step + 1 : row.step;
    const due = success
      ? step < retention.intervalsDays.length ? new Date(row.demonstrated_at.getTime() + retention.intervalsDays[step]! * DAY) : null
      : new Date(now.getTime() + retention.intervalsDays[0]! * DAY);
    await client.query(
      `UPDATE retention_schedules SET step=$3,due_at=$4,retained_at=CASE WHEN $5 THEN coalesce(retained_at,$7::timestamptz) ELSE retained_at END,
         needs_review=NOT $5,last_attempt_id=$6,updated_at=clock_timestamp() WHERE enrollment_id=$1 AND objective_id=$2`,
      [context.enrollment.id, objectiveId, step, due, success, attemptId, now],
    );
  }
}
export function registerRetentionRoutes(app: FastifyInstance, db: Database, auth: ReturnType<typeof authService>, clock: Clock = systemClock) {
  const base = "/api/enrollments/:enrollmentId/retention";
  const params = { type: "object", additionalProperties: false, required: ["enrollmentId"], properties: { enrollmentId: { type: "string", format: "uuid" } } };
  app.get(base, { schema: { params } }, async (request) => {
    const actor = await auth.authenticate(request), { enrollmentId } = request.params as { enrollmentId: string };
    return transaction(db, async (client) => view(client, await loadEnrollment(client, actor, enrollmentId), clock));
  });
  app.post(`${base}/check`, {
    schema: { params, body: { type: "object", additionalProperties: false, required: ["expectedRevision", "idempotencyKey", "objectiveId"],
      properties: { expectedRevision: { type: "integer", minimum: 1 }, idempotencyKey: { type: "string", minLength: 8, maxLength: 200 }, objectiveId: { type: "string", minLength: 1, maxLength: 200 } } } },
  }, async (request) => {
    const actor = await auth.authenticate(request), { enrollmentId } = request.params as { enrollmentId: string },
      input = request.body as CommandInput & { objectiveId: string };
    return enrollmentCommand(db, actor, enrollmentId, "retention.check", input, async (client, context) => {
      const course = context.release.server_bundle, retention = retentionOf(course);
      requireCondition(retention?.objectiveIds.includes(input.objectiveId), "RETENTION_UNAVAILABLE", 409);
      requireCondition(context.enrollment.status === "active" || context.enrollment.status === "completed", "ENROLLMENT_INACTIVE", 409);
      await syncSchedules(client, context);
      const schedule = (await client.query("SELECT * FROM retention_schedules WHERE enrollment_id=$1 AND objective_id=$2 FOR UPDATE", [enrollmentId, input.objectiveId])).rows[0];
      requireCondition(schedule, "OBJECTIVE_NOT_DEMONSTRATED", 409);
      const now = clock.now();
      requireCondition(schedule.due_at && schedule.due_at.getTime() <= now.getTime(), "RETENTION_NOT_DUE", 409);
      requireCondition(!(await client.query("SELECT 1 FROM assessment_challenges WHERE enrollment_id=$1 AND mode='retention' AND attempt_id IS NULL AND expires_at>clock_timestamp()", [enrollmentId])).rowCount, "RETENTION_CHECK_PENDING", 409);
      const exposed = new Set((await client.query<{ assessment_id: string }>("SELECT assessment_id FROM assessment_challenges WHERE enrollment_id=$1", [enrollmentId])).rows.map((r) => r.assessment_id));
      const assessment = course.assessments.find((a) => retention!.assessmentIds.includes(a.id) && a.objectiveIds.includes(input.objectiveId) && !exposed.has(a.id));
      // Honest exhaustion: a repeated item would not be independent evidence.
      requireCondition(assessment, "RETENTION_ITEMS_EXHAUSTED", 409);
      requireCondition(assessment.type === "choice" || assessment.type === "numeric", "EVALUATOR_NOT_CONFIGURED", 409);
      const episode = episodes(course).find((e) => e.objectiveIds.includes(input.objectiveId))!;
      await assertPolicyAction(client, enrollmentId, episode.id, "plan", now.toISOString());
      const challengeId = randomUUID();
      await client.query(
        `INSERT INTO assessment_challenges (id,enrollment_id,episode_id,assessment_id,course_digest,mode,independent_eligible,expires_at)
         VALUES ($1,$2,$3,$4,$5,'retention',true,now()+interval '60 minutes')`,
        [challengeId, enrollmentId, episode.id, assessment.id, context.release.digest],
      );
      await client.query("UPDATE enrollments SET revision=revision+1 WHERE id=$1", [enrollmentId]);
      await appendEvent(client, { workspaceId: context.enrollment.workspace_id, enrollmentId, actorId: actor.id, actorKind: "learner", type: "assessment.issued", payload: { challengeId, assessmentId: assessment.id, mode: "retention", independentEligible: true }, idempotencyKey: `${enrollmentId}:${input.idempotencyKey}` });
      return { challengeId, episodeId: episode.id, question: publicQuestion(assessment), independentEligible: true, revision: context.enrollment.revision + 1 };
    });
  });
}
