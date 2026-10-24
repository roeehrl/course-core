import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { Actor, authService } from './auth.js';
import { roleCan, workspaceRole } from './course-access.js';
import { transaction, type Database } from './database.js';
import { requireCondition } from './errors.js';

/**
 * What learners actually spend on AI (admin "AI services" -> Spending), so the owner can choose a
 * per-learner limit from real use instead of a guess. Read-only, from the spend ledger
 * (provider-costs.ts): per learner the total, each day, each lesson and each AI job, with the
 * spread (median, 90th percentile, highest) of a learner's day and of an active hour.
 *
 * - Days are UTC days, like the spend history. A learner-day is a day a learner's AI use cost
 *   something. An active hour is a clock hour in which the learner did something Core recorded
 *   (a learning event they sent, or an AI call for them); a day's spend is divided by its active
 *   hours (at least one).
 * - "Charged" is what the budgets hold (the estimate, or the price of the provider's reported
 *   usage once reconciled); "reserved" is the up-front estimate; "actual" is the price of the
 *   provider's reported usage, known only for reconciled calls. None of it is an invoice.
 * - Privacy: learners appear by enrollment id and course, never by name, email or anything they
 *   wrote. Who may look: a workspace role that may view enrollments (enrollment.read). A course
 *   grant does not open it: this is workspace-wide data, like the workspace audit log.
 * - Bounded: at most 93 days, 25 learners a page, 10 lessons and 93 days per learner, 20 lessons
 *   and 8 jobs in the summary.
 */
export const RECOMMENDATION = {
  /** Fewer learners or learner-days than this and no recommendation is made. */
  minimumLearners: 5,
  minimumLearnerDays: 20,
  /** Headroom over the 90th percentile, so a typical heavy learner is not stopped. */
  margin: 1.5,
  /** The recommended total is rounded up to this step (micro-USD): $0.50. */
  stepMicroUsd: 500_000,
  /** The daily figure is rounded up to this step: $0.10. */
  dailyStepMicroUsd: 100_000,
} as const;
const DAY = 86_400_000;
const querySchema = z.strictObject({
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(25).default(10),
});
type Sql = Database | PoolClient;
const ceilTo = (value: number, step: number) => Math.max(step, Math.ceil(value / step) * step);

export interface SpendDistribution { p50: number; p90: number; max: number }
/**
 * A per-learner total limit from the data: the 90th percentile of what a learner spent in the
 * window, with a margin, rounded up, and never above the workspace total. With too little data
 * there is none, and the counts say how far off it is.
 */
export function recommendLearnerLimit(input: { learners: number; learnerDays: number; learnerTotal: SpendDistribution; learnerDay: SpendDistribution;
  windowDays: number; workspaceLimitMicroUsd: number }) {
  const r = RECOMMENDATION;
  if (input.learners < r.minimumLearners || input.learnerDays < r.minimumLearnerDays)
    return { status: 'not_enough_data' as const, learners: input.learners, learnerDays: input.learnerDays,
      minimumLearners: r.minimumLearners, minimumLearnerDays: r.minimumLearnerDays };
  const raw = ceilTo(input.learnerTotal.p90 * r.margin, r.stepMicroUsd);
  const capped = input.workspaceLimitMicroUsd > 0 && raw > input.workspaceLimitMicroUsd;
  return { status: 'ready' as const, microUsd: capped ? input.workspaceLimitMicroUsd : raw,
    dailyMicroUsd: ceilTo(input.learnerDay.p90 * r.margin, r.dailyStepMicroUsd),
    basis: { learners: input.learners, learnerDays: input.learnerDays, windowDays: input.windowDays, margin: r.margin,
      p90LearnerTotalMicroUsd: input.learnerTotal.p90, p90LearnerDayMicroUsd: input.learnerDay.p90, cappedAtWorkspaceTotal: capped } };
}

/** Workspace-wide spending data: a workspace role that may view enrollments. A course grant
 * never opens it, like the workspace audit log. */
async function permitSpendData(client: Sql, actor: Pick<Actor, 'id'>, workspaceId: string) {
  requireCondition(roleCan(await workspaceRole(client, actor, workspaceId), 'enrollment.read'), 'FORBIDDEN', 403);
}
function spendRange(query: z.infer<typeof querySchema>, now: Date) {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const to = query.to ? Date.parse(`${query.to}T00:00:00Z`) + DAY : today + DAY;
  const from = query.from ? Date.parse(`${query.from}T00:00:00Z`) : to - 30 * DAY;
  requireCondition(Number.isFinite(from) && Number.isFinite(to) && from < to && to - from <= 93 * DAY, 'PROVIDER_SPEND_RANGE_INVALID', 400);
  return { from: new Date(from), to: new Date(to), days: Math.round((to - from) / DAY) };
}
/** The workspace learners' ledger rows in the window ($1 workspace, $2 from, $3 to), each
 * learner-day with its active hours, and each learner's totals. */
const BASE = `WITH visible AS (
    SELECT e.id,r.course_key FROM enrollments e JOIN course_releases r ON r.id=e.course_release_id AND r.workspace_id=e.workspace_id
    WHERE e.workspace_id=$1),
  spend AS (
    SELECT l.* FROM provider_spend_ledger l JOIN visible v ON v.id=l.enrollment_id
    WHERE l.workspace_id=$1 AND l.reserved_at>=$2 AND l.reserved_at<$3 AND l.state<>'not_started'),
  days AS (
    SELECT enrollment_id,date_trunc('day',reserved_at AT TIME ZONE 'UTC') AS day,sum(charged_micro_usd) AS charged
    FROM spend GROUP BY 1,2 HAVING sum(charged_micro_usd)>0),
  hours AS (
    SELECT enrollment_id,date_trunc('day',hour) AS day,count(DISTINCT hour) AS hours FROM (
      SELECT enrollment_id,date_trunc('hour',reserved_at AT TIME ZONE 'UTC') AS hour FROM spend
      UNION ALL
      SELECT le.enrollment_id,date_trunc('hour',le.created_at AT TIME ZONE 'UTC') FROM learning_events le
      WHERE le.enrollment_id IN (SELECT DISTINCT enrollment_id FROM days) AND le.workspace_id=$1 AND le.actor_kind='learner'
        AND le.created_at>=$2 AND le.created_at<$3) h
    GROUP BY 1,2),
  learner_days AS (
    SELECT d.enrollment_id,d.day,d.charged,COALESCE(h.hours,1) AS hours,d.charged::numeric/GREATEST(COALESCE(h.hours,1),1) AS per_hour
    FROM days d LEFT JOIN hours h USING (enrollment_id,day)),
  learners AS (
    SELECT enrollment_id,sum(charged) AS charged,count(*) AS days,sum(hours) AS hours FROM learner_days GROUP BY 1)`;
const spread = (column: string, from: string) => `(SELECT json_build_object(
    'p50',COALESCE(round(percentile_cont(0.5) WITHIN GROUP (ORDER BY ${column})),0),
    'p90',COALESCE(round(percentile_cont(0.9) WITHIN GROUP (ORDER BY ${column})),0),
    'max',COALESCE(round(max(${column})),0)) FROM ${from})`;
const SUMS = `count(*)::int AS calls,COALESCE(sum(reserved_micro_usd),0)::text AS reserved,COALESCE(sum(charged_micro_usd),0)::text AS charged,
  COALESCE(sum(actual_micro_usd),0)::text AS actual,(count(*) FILTER (WHERE state='reconciled'))::int AS "reconciledCalls",
  COALESCE(sum(charged_micro_usd) FILTER (WHERE state='reconciled'),0)::text AS "reconciledCharged"`;
/** The lesson a ledger row was for: its own episode (media) or the episode of the supervisor job
 * whose provider call it records. */
const LESSON = `COALESCE(s.episode_id,(SELECT i.context->>'episodeId' FROM provider_dispatches d JOIN supervisor_inputs i ON i.job_id=d.job_id AND i.enrollment_id=d.enrollment_id
    WHERE s.source='supervisor' AND d.operation_id=s.source_ref ORDER BY i.checkpoint_id LIMIT 1))`;
const toNumbers = (value: { p50: number | string; p90: number | string; max: number | string }): SpendDistribution =>
  ({ p50: Number(value.p50), p90: Number(value.p90), max: Number(value.max) });

export async function learnerSpend(client: Sql, actor: Pick<Actor, 'id'>, workspaceId: string, raw: unknown) {
  await permitSpendData(client, actor, workspaceId);
  const parsed = querySchema.safeParse(raw ?? {});
  requireCondition(parsed.success, 'PROVIDER_SPEND_RANGE_INVALID', 400);
  const query = parsed.data, now = (await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0]!.now, range = spendRange(query, now);
  const args = [workspaceId, range.from, range.to];
  const summary = (await client.query<{ learners: number; learner_days: number; day: SpendDistribution; hour: SpendDistribution; total: SpendDistribution }>(
    `${BASE} SELECT (SELECT count(*) FROM learners)::int AS learners,(SELECT count(*) FROM learner_days)::int AS learner_days,
       ${spread('charged', 'learner_days')} AS day,${spread('per_hour', 'learner_days')} AS hour,${spread('charged', 'learners')} AS total`, args)).rows[0]!;
  const totals = (await client.query(`${BASE} SELECT ${SUMS} FROM spend`, args)).rows[0];
  const byRole = (await client.query(`${BASE} SELECT role,count(DISTINCT enrollment_id)::int AS learners,${SUMS} FROM spend GROUP BY role ORDER BY sum(charged_micro_usd) DESC,role LIMIT 8`, args)).rows;
  const byLesson = (await client.query(`${BASE} SELECT lesson AS "episodeId",count(DISTINCT enrollment_id)::int AS learners,${SUMS}
      FROM (SELECT s.*,${LESSON} AS lesson FROM spend s) x GROUP BY lesson ORDER BY sum(charged_micro_usd) DESC,lesson NULLS LAST LIMIT 20`, args)).rows;
  const offset = (query.page - 1) * query.pageSize;
  const page = (await client.query<{ enrollment_id: string; course_key: string; charged: string; days: number; hours: number; day: SpendDistribution }>(
    `${BASE} SELECT l.enrollment_id,v.course_key,l.charged::text,l.days::int,l.hours::int,
       (SELECT json_build_object('p50',round(percentile_cont(0.5) WITHIN GROUP (ORDER BY d.charged)),'p90',round(percentile_cont(0.9) WITHIN GROUP (ORDER BY d.charged)),
         'max',max(d.charged)) FROM learner_days d WHERE d.enrollment_id=l.enrollment_id) AS day
     FROM learners l JOIN visible v ON v.id=l.enrollment_id ORDER BY l.charged DESC,l.enrollment_id LIMIT $4 OFFSET $5`, [...args, query.pageSize, offset])).rows;
  const ids = page.map((row) => row.enrollment_id), detail = [workspaceId, range.from, range.to, ids];
  const where = `s.workspace_id=$1 AND s.reserved_at>=$2 AND s.reserved_at<$3 AND s.enrollment_id=ANY($4::uuid[]) AND s.state<>'not_started'`;
  const sums = ids.length ? (await client.query(`SELECT enrollment_id,${SUMS} FROM provider_spend_ledger s WHERE ${where} GROUP BY enrollment_id`, detail)).rows : [];
  const roles = ids.length ? (await client.query(`SELECT enrollment_id,role,${SUMS} FROM provider_spend_ledger s WHERE ${where} GROUP BY enrollment_id,role ORDER BY role`, detail)).rows : [];
  const lessons = ids.length ? (await client.query(`SELECT * FROM (SELECT enrollment_id,lesson AS "episodeId",${SUMS},
      row_number() OVER (PARTITION BY enrollment_id ORDER BY sum(charged_micro_usd) DESC,lesson NULLS LAST) AS n
      FROM (SELECT s.*,${LESSON} AS lesson FROM provider_spend_ledger s WHERE ${where}) x GROUP BY enrollment_id,lesson) y WHERE n<=10 ORDER BY enrollment_id,n`, detail)).rows : [];
  const days = ids.length ? (await client.query<{ enrollment_id: string; day: string; charged: string; calls: number }>(
    `SELECT enrollment_id,to_char(date_trunc('day',reserved_at AT TIME ZONE 'UTC'),'YYYY-MM-DD') AS day,sum(charged_micro_usd)::text AS charged,count(*)::int AS calls
     FROM provider_spend_ledger s WHERE ${where} GROUP BY 1,2 HAVING sum(charged_micro_usd)>0 ORDER BY 1,2 DESC`, detail)).rows : [];
  const strip = <T extends { enrollment_id: string; n?: unknown }>(rows: T[], id: string) =>
    rows.filter((row) => row.enrollment_id === id).map(({ enrollment_id: _id, n: _n, ...rest }) => rest);
  const workspaceLimit = Number((await client.query<{ limit: string }>('SELECT limit_micro_usd::text AS limit FROM supervisor_workspace_budgets WHERE workspace_id=$1', [workspaceId])).rows[0]?.limit ?? 0);
  const distributions = { learnerDay: toNumbers(summary.day), activeHour: toNumbers(summary.hour), learnerTotal: toNumbers(summary.total) };
  return {
    from: range.from.toISOString(), to: range.to.toISOString(), days: range.days, timeZone: 'UTC' as const, currency: 'USD' as const,
    learners: summary.learners, learnerDays: summary.learner_days, distributions, totals, byRole, byLesson,
    page: query.page, pageSize: query.pageSize, totalLearners: summary.learners,
    rows: page.map((row) => ({ enrollmentId: row.enrollment_id, courseKey: row.course_key, activeDays: row.days, activeHours: row.hours,
      perDay: toNumbers(row.day), ...(strip(sums, row.enrollment_id)[0] ?? {}), charged: row.charged,
      byRole: strip(roles, row.enrollment_id), byLesson: strip(lessons, row.enrollment_id), byDay: strip(days, row.enrollment_id) })),
    recommendation: recommendLearnerLimit({ learners: summary.learners, learnerDays: summary.learner_days, learnerTotal: distributions.learnerTotal,
      learnerDay: distributions.learnerDay, windowDays: range.days, workspaceLimitMicroUsd: workspaceLimit }),
    notAnInvoice: true as const,
  };
}

export function registerLearnerSpendRoutes(app: FastifyInstance, db: Database, auth: ReturnType<typeof authService>) {
  const params = { type: 'object', additionalProperties: false, required: ['workspaceId'], properties: { workspaceId: { type: 'string', format: 'uuid' } } };
  app.get('/api/admin/workspaces/:workspaceId/provider-spend/learners', { schema: { params }, logLevel: 'silent' }, async (request) => {
    const actor = await auth.authenticate(request), { workspaceId } = request.params as { workspaceId: string };
    // One snapshot: the summary, the page and the recommendation describe the same rows.
    return transaction(db, async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      return learnerSpend(client, actor, workspaceId, request.query);
    });
  });
}
