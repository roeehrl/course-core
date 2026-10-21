import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { z } from "zod";
import type { CourseManifest } from "@course-core/sdk";
import { resolveRetentionIntervals } from "@course-core/sdk";
import type { Database } from "./database.js";
import { transaction } from "./database.js";
import type { authService } from "./auth.js";
import { requireCondition } from "./errors.js";
import { appendEvent } from "./events.js";
import { enrollmentCommand, loadEnrollment, type CommandInput, type EnrollmentContext } from "./repository.js";
import { episodes, gateDecision, publicQuestion } from "./learning.js";
import { findAssessment } from "./gates.js";
import { assertPolicyAction } from "./policy-adapter.js";
import { systemClock, type Clock } from "./clock.js";
import { requireEvaluator } from "./assessment-routes.js";
import type { RuntimeExtension } from "./publication.js";

const DAY = 86_400_000;
type Retention = { intervalsDays: number[]; objectiveIds: string[]; assessmentIds: string[] };
/** The course's retention policy with its schedule resolved: author intervals when declared,
 * otherwise the product default of 1, 3, 7 and 21 days. */
const retentionOf = (course: CourseManifest): Retention | undefined =>
  course.retention ? { ...course.retention, intervalsDays: resolveRetentionIntervals(course) } : undefined;

/**
 * How one delayed check moves an objective's review schedule (F06). The intervals are the course's
 * (1, 3, 7 and 21 days by default); `step` is the next interval to reach. The rule is transparent
 * and graded, not a mastery estimate:
 * - retained (an independent success): one step on; the next check is the gap to the next interval;
 * - missed (a wrong answer): one step back, not back to the start; a second miss in a row restarts;
 * - unsure ("I don't know yet"): no step lost, a review soon (the first interval), no lapse counted;
 * - assisted (right with help, so not independent): no step gained or lost, checked again soon.
 * A miss or "unsure" marks the objective for review; demonstrated understanding is never revoked.
 */
export type RetentionOutcome = "retained" | "missed" | "unsure" | "assisted";
export interface ScheduleState { step: number; lapses: number; needsReview: boolean }
export function nextSchedule(state: ScheduleState, outcome: RetentionOutcome, intervals: readonly number[]) {
  const first = intervals[0]!, at = (step: number) => intervals[Math.min(step, intervals.length - 1)]!;
  if (outcome === "retained") {
    const step = state.step + 1;
    const gap = step < intervals.length ? at(step) - at(state.step) : 0;
    return { step, lapses: 0, needsReview: false, offsetDays: step < intervals.length ? (gap > 0 ? gap : at(step)) : null };
  }
  if (outcome === "missed") {
    const lapses = state.lapses + 1, step = lapses >= 2 ? 0 : Math.max(state.step - 1, 0);
    return { step, lapses, needsReview: true, offsetDays: at(step) };
  }
  if (outcome === "unsure") return { step: state.step, lapses: state.lapses, needsReview: true, offsetDays: first };
  return { step: state.step, lapses: state.lapses, needsReview: state.needsReview, offsetDays: first };
}

/** The days a learner can study (bit 0 Sunday … bit 6 Saturday) in their time zone. */
export interface Availability { weekdayMask: number; timeZone: string }
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const validTimeZone = (zone: string) => { try { new Intl.DateTimeFormat("en-US", { timeZone: zone }); return true; } catch { return false; } };
function localParts(at: Date, timeZone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", year: "numeric", month: "numeric", day: "numeric", hour: "numeric",
    minute: "numeric", second: "numeric", hourCycle: "h23" }).formatToParts(at).map(p => [p.type, p.value]));
  return { weekday: WEEKDAYS.indexOf(parts.weekday!), y: Number(parts.year), m: Number(parts.month), d: Number(parts.day), h: Number(parts.hour), min: Number(parts.minute), s: Number(parts.second) };
}
/** The instant of local midnight starting the day `at` falls on in `timeZone`. */
function startOfLocalDay(at: Date, timeZone: string) {
  const p = localParts(at, timeZone), offset = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - Math.floor(at.getTime() / 1000) * 1000;
  return new Date(Date.UTC(p.y, p.m - 1, p.d) - offset);
}
/** `due`, or the start of the learner's next available day after it when `due` falls on a day
 * they said they cannot study. Never earlier than `due`; unchanged without an availability. */
export function onAvailableDay(due: Date, availability: Availability | null): Date {
  if (!availability) return due;
  if (availability.weekdayMask & (1 << localParts(due, availability.timeZone).weekday)) return due;
  let day = startOfLocalDay(due, availability.timeZone);
  for (let i = 0; i < 8; i++) {
    // Noon of the next local day, then back to its midnight: safe across daylight-saving changes.
    day = startOfLocalDay(new Date(day.getTime() + DAY + 12 * 3_600_000), availability.timeZone);
    if (availability.weekdayMask & (1 << localParts(day, availability.timeZone).weekday)) return day;
  }
  return due;
}
async function availabilityOf(client: PoolClient, enrollmentId: string): Promise<Availability | null> {
  const row = (await client.query<{ weekday_mask: number; time_zone: string }>("SELECT weekday_mask,time_zone FROM retention_availability WHERE enrollment_id=$1", [enrollmentId])).rows[0];
  return row && validTimeZone(row.time_zone) ? { weekdayMask: row.weekday_mask, timeZone: row.time_zone } : null;
}

/** When each retention objective was first demonstrated: the time the evidence
 * completing its gate was recorded. Gates evaluate demonstrated understanding;
 * retention items are held out of them by contract. */
function demonstrations(context: EnrollmentContext, created: Map<string, Date>) {
  const course = context.release.server_bundle, retention = retentionOf(course);
  const result = new Map<string, Date>();
  if (!retention) return result;
  for (const gate of course.gates) {
    const decision = gateDecision(course, gate, context.evidence, context.release.digest);
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
  const availability = await availabilityOf(client, context.enrollment.id);
  for (const [objectiveId, at] of demonstrations(context, created)) {
    const base = new Date(at.getTime() + retention.intervalsDays[0]! * DAY);
    await client.query(
      "INSERT INTO retention_schedules(enrollment_id,objective_id,demonstrated_at,step,due_at,base_due_at) VALUES($1,$2,$3,0,$4,$5) ON CONFLICT DO NOTHING",
      [context.enrollment.id, objectiveId, at, onAvailableDay(base, availability), base],
    );
  }
}
async function view(client: PoolClient, context: EnrollmentContext, clock: Clock) {
  const course = context.release.server_bundle, retention = retentionOf(course);
  if (!retention) return { available: false, items: [] };
  await syncSchedules(client, context);
  const rows = (await client.query("SELECT * FROM retention_schedules WHERE enrollment_id=$1 ORDER BY due_at NULLS LAST,objective_id", [context.enrollment.id])).rows;
  const now = clock.now().getTime();
  const exposed = new Set((await client.query<{ assessment_id: string }>("SELECT assessment_id FROM assessment_challenges WHERE enrollment_id=$1", [context.enrollment.id])).rows.map((r) => r.assessment_id));
  const availability = await availabilityOf(client, context.enrollment.id);
  return {
    available: true,
    intervalsDays: retention.intervalsDays,
    grantsCompletion: false,
    availability: availability ? { weekdays: WEEKDAYS.map((_, i) => i).filter((i) => availability.weekdayMask & (1 << i)), timeZone: availability.timeZone } : null,
    items: rows.map((r) => ({
      objectiveId: r.objective_id,
      description: course.objectives.find((o) => o.id === r.objective_id)?.description ?? r.objective_id,
      state: r.needs_review ? "needs_review" : r.retained_at ? "retained" : "demonstrated",
      demonstratedAt: r.demonstrated_at.toISOString(),
      retainedAt: r.retained_at?.toISOString() ?? null,
      dueAt: r.due_at?.toISOString() ?? null,
      due: Boolean(r.due_at && r.due_at.getTime() <= now),
      /** How far along the schedule this objective is (0 = before the first interval), and what moved it last. */
      step: r.step,
      lastOutcome: r.last_outcome ?? null,
      /** Moved to a later day because the schedule's day is not one the learner studies. */
      movedForAvailability: Boolean(r.due_at && r.base_due_at && r.due_at.getTime() !== r.base_due_at.getTime()),
      freshItemsLeft: retention.assessmentIds.filter((id) => !exposed.has(id) && course.assessments.find((a) => a.id === id)?.objectiveIds.includes(r.objective_id)).length,
    })),
  };
}

interface ScheduleRow { step: number; lapses: number; needs_review: boolean; demonstrated_at: Date; retained_at: Date | null; base_due_at: Date | null }
async function applyOutcome(client: PoolClient, enrollmentId: string, objectiveId: string, row: ScheduleRow, outcome: RetentionOutcome, attemptId: string | null,
  now: Date, intervals: readonly number[], availability: Availability | null) {
  const next = nextSchedule({ step: row.step, lapses: row.lapses, needsReview: row.needs_review }, outcome, intervals);
  // On time, a retained check keeps the schedule's own rhythm (from when it was due); late, the gap counts from now.
  const anchor = outcome === "retained" && row.base_due_at && row.base_due_at.getTime() + (next.offsetDays ?? 0) * DAY > now.getTime() ? row.base_due_at : now;
  const base = next.offsetDays === null ? null : new Date(anchor.getTime() + next.offsetDays * DAY);
  await client.query(
    `UPDATE retention_schedules SET step=$3,lapses=$4,needs_review=$5,last_outcome=$6,base_due_at=$7,due_at=$8,
       retained_at=CASE WHEN $6='retained' THEN coalesce(retained_at,$9::timestamptz) ELSE retained_at END,last_attempt_id=coalesce($10,last_attempt_id),updated_at=$9
     WHERE enrollment_id=$1 AND objective_id=$2`,
    [enrollmentId, objectiveId, next.step, next.lapses, next.needsReview, outcome, base, base && onAvailableDay(base, availability), now, attemptId],
  );
  return { ...row, step: next.step, lapses: next.lapses, needs_review: next.needsReview, base_due_at: base, retained_at: outcome === "retained" ? row.retained_at ?? now : row.retained_at };
}
const outcomeOf = (passed: boolean, independent: boolean, abstained: boolean): RetentionOutcome =>
  abstained ? "unsure" : !passed ? "missed" : independent ? "retained" : "assisted";

/** Applies a submitted retention answer to its schedule. Called inside the answer transaction;
 * never changes gates, completion or demonstrated status. `now` comes from the same server clock
 * that decided the check was due. */
export async function recordRetentionOutcome(client: PoolClient, context: EnrollmentContext, attemptId: string, objectiveIds: string[], passed: boolean, independent: boolean,
  now: Date = systemClock.now(), abstained = false) {
  const retention = retentionOf(context.release.server_bundle);
  if (!retention) return;
  const availability = await availabilityOf(client, context.enrollment.id);
  for (const objectiveId of objectiveIds) {
    const row = (await client.query<ScheduleRow>("SELECT * FROM retention_schedules WHERE enrollment_id=$1 AND objective_id=$2 FOR UPDATE", [context.enrollment.id, objectiveId])).rows[0];
    if (!row) continue;
    await applyOutcome(client, context.enrollment.id, objectiveId, row, outcomeOf(passed, independent, abstained), attemptId, now, retention.intervalsDays, availability);
  }
}

/**
 * Rebuilds the schedules of these objectives from the enrollment's retention answers that still
 * stand, in the order they were submitted: after staff invalidate a retention result (a dispute
 * upheld, a defective item) or a written retention answer is reviewed. An answer awaiting review
 * or whose evidence was invalidated does not move the schedule.
 */
export async function replayRetention(client: PoolClient, enrollmentId: string, objectiveIds: readonly string[], now: Date = systemClock.now()) {
  const release = (await client.query<{ server_bundle: CourseManifest }>("SELECT r.server_bundle FROM enrollments e JOIN course_releases r ON r.id=e.course_release_id WHERE e.id=$1",
    [enrollmentId])).rows[0];
  const retention = release && retentionOf(release.server_bundle);
  if (!retention) return;
  const availability = await availabilityOf(client, enrollmentId);
  const answers = (await client.query<{ id: string; assessment_id: string; submitted_at: Date; result: { abstained?: boolean }; evidence: { objectiveId: string; passed: boolean; independent: boolean; valid: boolean }[] }>(
    `SELECT a.id,a.assessment_id,a.submitted_at,a.result,
        coalesce(json_agg(json_build_object('objectiveId',e.objective_id,'passed',(e.result->>'passed')::boolean,'independent',e.independent,'valid',e.invalidated_at IS NULL))
          FILTER (WHERE e.id IS NOT NULL),'[]') AS evidence
       FROM attempts a LEFT JOIN evidence e ON e.attempt_id=a.id AND e.enrollment_id=a.enrollment_id
      WHERE a.enrollment_id=$1 AND a.mode='retention' GROUP BY a.id ORDER BY a.submitted_at,a.id`, [enrollmentId])).rows;
  const course = release.server_bundle;
  for (const objectiveId of objectiveIds) {
    const stored = (await client.query<ScheduleRow>("SELECT * FROM retention_schedules WHERE enrollment_id=$1 AND objective_id=$2 FOR UPDATE", [enrollmentId, objectiveId])).rows[0];
    if (!stored) continue;
    const base = new Date(stored.demonstrated_at.getTime() + retention.intervalsDays[0]! * DAY);
    let row: ScheduleRow = { ...stored, step: 0, lapses: 0, needs_review: false, retained_at: null, base_due_at: base };
    await client.query(`UPDATE retention_schedules SET step=0,lapses=0,needs_review=false,last_outcome=NULL,retained_at=NULL,base_due_at=$3,due_at=$4,updated_at=$5
      WHERE enrollment_id=$1 AND objective_id=$2`, [enrollmentId, objectiveId, base, onAvailableDay(base, availability), now]);
    for (const answer of answers) {
      if (answer.submitted_at < stored.demonstrated_at) continue;
      const evidence = answer.evidence.find((e) => e.objectiveId === objectiveId);
      const abstained = answer.result?.abstained === true && findAssessment(course, answer.assessment_id)?.objectiveIds.includes(objectiveId);
      if (!abstained && (!evidence || !evidence.valid)) continue;
      row = await applyOutcome(client, enrollmentId, objectiveId, row, outcomeOf(Boolean(evidence?.passed), Boolean(evidence?.independent), Boolean(abstained)), answer.id,
        answer.submitted_at, retention.intervalsDays, availability);
    }
  }
}

const availabilitySchema = z.strictObject({
  expectedRevision: z.number().int().min(1),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9:_-]{8,200}$/),
  /** Days of the week (0 Sunday … 6 Saturday) the learner can study; null clears the setting. */
  weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7).refine((days) => new Set(days).size === days.length).nullable(),
  timeZone: z.string().min(1).max(64).refine(validTimeZone),
});

export function registerRetentionRoutes(app: FastifyInstance, db: Database, auth: ReturnType<typeof authService>, clock: Clock = systemClock, installed: RuntimeExtension[] = []) {
  const base = "/api/enrollments/:enrollmentId/retention";
  const params = { type: "object", additionalProperties: false, required: ["enrollmentId"], properties: { enrollmentId: { type: "string", format: "uuid" } } };
  app.get(base, { schema: { params } }, async (request) => {
    const actor = await auth.authenticate(request), { enrollmentId } = request.params as { enrollmentId: string };
    return transaction(db, async (client) => view(client, await loadEnrollment(client, actor, enrollmentId), clock));
  });
  /** The learner's study days. Checks then fall due only on those days; the schedule itself is unchanged. */
  app.post(`${base}/availability`, { schema: { params } }, async (request) => {
    const actor = await auth.authenticate(request), { enrollmentId } = request.params as { enrollmentId: string };
    const parsed = availabilitySchema.safeParse(request.body);
    requireCondition(parsed.success, "INVALID_AVAILABILITY", 400);
    const input = parsed.data;
    return enrollmentCommand(db, actor, enrollmentId, "retention.availability", input, async (client, context) => {
      requireCondition(retentionOf(context.release.server_bundle), "RETENTION_UNAVAILABLE", 409);
      if (input.weekdays === null) await client.query("DELETE FROM retention_availability WHERE enrollment_id=$1", [enrollmentId]);
      else await client.query(
        `INSERT INTO retention_availability(enrollment_id,workspace_id,weekday_mask,time_zone) VALUES($1,$2,$3,$4)
         ON CONFLICT (enrollment_id) DO UPDATE SET weekday_mask=EXCLUDED.weekday_mask,time_zone=EXCLUDED.time_zone,revision=retention_availability.revision+1,updated_at=clock_timestamp()`,
        [enrollmentId, context.enrollment.workspace_id, input.weekdays.reduce((mask, day) => mask | (1 << day), 0), input.timeZone]);
      // Every open schedule moves to the learner's days from its own schedule time, never earlier than that.
      const availability = await availabilityOf(client, enrollmentId);
      for (const row of (await client.query<{ objective_id: string; base_due_at: Date | null; due_at: Date | null }>(
        "SELECT objective_id,base_due_at,due_at FROM retention_schedules WHERE enrollment_id=$1 AND due_at IS NOT NULL FOR UPDATE", [enrollmentId])).rows) {
        const scheduled = row.base_due_at ?? row.due_at!;
        await client.query("UPDATE retention_schedules SET base_due_at=$3,due_at=$4 WHERE enrollment_id=$1 AND objective_id=$2", [enrollmentId, row.objective_id, scheduled, onAvailableDay(scheduled, availability)]);
      }
      await client.query("UPDATE enrollments SET revision=revision+1 WHERE id=$1", [enrollmentId]);
      await appendEvent(client, { workspaceId: context.enrollment.workspace_id, enrollmentId, actorId: actor.id, actorKind: "learner", type: "retention.availability_changed",
        payload: { weekdays: input.weekdays, timeZone: input.weekdays ? input.timeZone : null }, idempotencyKey: `${enrollmentId}:${input.idempotencyKey}` });
      return { ...(await view(client, await loadEnrollment(client, actor, enrollmentId), clock)), revision: context.enrollment.revision + 1 };
    });
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
      requireCondition(!(await client.query("SELECT 1 FROM assessment_challenges WHERE enrollment_id=$1 AND mode='retention' AND attempt_id IS NULL AND expires_at>$2", [enrollmentId, now])).rowCount, "RETENTION_CHECK_PENDING", 409);
      // A written retention answer still awaiting its review is a check in progress too.
      const awaiting = (await client.query<{ assessment_id: string }>(
        `SELECT a.assessment_id FROM attempts a WHERE a.enrollment_id=$1 AND a.mode='retention' AND a.result->>'status'='pending_review'
           AND NOT EXISTS (SELECT 1 FROM evidence e WHERE e.attempt_id=a.id) AND NOT EXISTS (SELECT 1 FROM attempts r WHERE r.continues_attempt_id=a.id)`, [enrollmentId])).rows;
      requireCondition(!awaiting.some((a) => findAssessment(course, a.assessment_id)?.objectiveIds.includes(input.objectiveId)), "RETENTION_CHECK_PENDING", 409);
      const exposed = new Set((await client.query<{ assessment_id: string }>("SELECT assessment_id FROM assessment_challenges WHERE enrollment_id=$1", [enrollmentId])).rows.map((r) => r.assessment_id));
      const assessment = course.assessments.find((a) => retention!.assessmentIds.includes(a.id) && a.objectiveIds.includes(input.objectiveId) && !exposed.has(a.id));
      // Honest exhaustion: a repeated item would not be independent evidence.
      requireCondition(assessment, "RETENTION_ITEMS_EXHAUSTED", 409);
      // Any item this host can evaluate: deterministic, code with a qualified evaluator, or a
      // written answer for the installed reviewer (its outcome lands when it is reviewed).
      requireEvaluator(context, assessment, installed);
      const episode = episodes(course).find((e) => e.objectiveIds.includes(input.objectiveId))!;
      await assertPolicyAction(client, enrollmentId, episode.id, "plan", now.toISOString());
      const challengeId = randomUUID();
      await client.query(
        `INSERT INTO assessment_challenges (id,enrollment_id,episode_id,assessment_id,course_digest,mode,independent_eligible,expires_at)
         VALUES ($1,$2,$3,$4,$5,'retention',true,$6)`,
        [challengeId, enrollmentId, episode.id, assessment.id, context.release.digest, new Date(now.getTime() + 60 * 60_000)],
      );
      await client.query("UPDATE enrollments SET revision=revision+1 WHERE id=$1", [enrollmentId]);
      await appendEvent(client, { workspaceId: context.enrollment.workspace_id, enrollmentId, actorId: actor.id, actorKind: "learner", type: "assessment.issued", payload: { challengeId, assessmentId: assessment.id, mode: "retention", independentEligible: true }, idempotencyKey: `${enrollmentId}:${input.idempotencyKey}` });
      return { challengeId, episodeId: episode.id, question: publicQuestion(assessment, course), independentEligible: true, revision: context.enrollment.revision + 1 };
    });
  });
}
