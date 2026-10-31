/**
 * In-app notifications (owner decision 8, requirement Q08): a bell in the admin app for staff and a
 * smaller one in the learner app. Nothing leaves the host: no email, push or other service.
 *
 * A notification is a kind code with parameters (identifiers, counts, versions; never prose, so each
 * app words it in the reader's language), a link to the place to act (an app path) and a read state
 * per person.
 *
 * - Staff notifications describe a condition that holds now. They are refreshed from their sources
 *   when the person opens the list (at most every REFRESH_SECONDS per person and workspace): the
 *   course overview's approval queue, the AI quality-check gate (a role whose setup has no passing
 *   check, for example after a Core upgrade), failed AI runs, the workspace AI budget, AI help held
 *   back by a spending limit (`help_paused`, also written at once when a job stops at a limit) and
 *   the backup recovery target. Each kind is shown only to roles that can act on it. A notification whose
 *   condition cleared is deleted; one whose condition got worse (more approvals waiting, a later
 *   failure) is unread again. An unencrypted backup is not a problem here, only an overdue one.
 * - Learner notifications record something that happened: the course moved to a newer version, a
 *   move to a newer version is offered, an answer from the tutor arrived while they were away.
 *   notifyUser adds them, idempotently per person and key.
 *
 * Bounded: at most MAX_PER_PERSON rows per person and audience, read ones are deleted after
 * READ_RETENTION_DAYS and every one after MAX_AGE_DAYS, a list returns at most LIST_LIMIT rows,
 * parameters are at most 2 KB. Erasing an enrollment deletes its notifications; erasing an account
 * deletes all of the person's notifications.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { authService } from './auth.js';
import { resolveRole, roleCan, workspaceRole } from './course-access.js';
import { transaction, type Database } from './database.js';
import { requireCondition } from './errors.js';
import { approvalQueue } from './course-overview.js';
import { backupStatus } from './platform-operations.js';
import { uncheckedRoles } from './agent-evals/gate.js';
import { providerConfigurationSchema } from './provider-composition.js';
import type { WorkspaceProviders } from './provider-setup.js';

type Sql = Database | PoolClient;
type Auth = ReturnType<typeof authService>;

export const NOTIFICATION_LIMITS = Object.freeze({
  maxPerPerson: 200,
  readRetentionDays: 30,
  maxAgeDays: 180,
  listLimit: 50,
  refreshSeconds: 30,
  /** Courses whose conditions one refresh reads. */
  courses: 50,
  /** The AI budget counts as near its limit from this share of it. */
  budgetPercent: 80,
});
export const STAFF_NOTIFICATION_KINDS = ['approvals_waiting', 'ai_check_needed', 'jobs_failed', 'budget_near_limit', 'help_paused', 'backups_overdue', 'questions_exhausted'] as const;
export const LEARNER_NOTIFICATION_KINDS = ['course_updated', 'move_offer', 'reply_ready'] as const;
/** Workspace roles that have a staff bell. Course-scoped members and service principals have none. */
export const STAFF_ROLES = ['owner', 'admin', 'author', 'instructor', 'reviewer', 'observer', 'support_observer'] as const;

type Params = Record<string, string | number | boolean | null>;
interface Upsert {
  workspaceId: string; userId: string; audience: 'learner' | 'staff'; kind: string; params?: Params | undefined; link?: string | null | undefined;
  dedupeKey: string; enrollmentId?: string | null | undefined; fingerprint?: string; rank?: number;
}

async function upsert(client: Sql, input: Upsert) {
  await client.query(`INSERT INTO notifications(id,workspace_id,user_id,audience,kind,params,link,dedupe_key,fingerprint,rank,enrollment_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    ON CONFLICT (user_id,dedupe_key) DO UPDATE SET kind=EXCLUDED.kind,params=EXCLUDED.params,link=EXCLUDED.link,
      updated_at=CASE WHEN notifications.fingerprint<>EXCLUDED.fingerprint THEN clock_timestamp() ELSE notifications.updated_at END,
      read_at=CASE WHEN notifications.fingerprint<>EXCLUDED.fingerprint AND EXCLUDED.rank>=notifications.rank THEN NULL ELSE notifications.read_at END,
      fingerprint=EXCLUDED.fingerprint,rank=EXCLUDED.rank`,
  [randomUUID(), input.workspaceId, input.userId, input.audience, input.kind, JSON.stringify(input.params ?? {}), input.link ?? null,
    input.dedupeKey.slice(0, 300), input.fingerprint ?? '', input.rank ?? 0, input.enrollmentId ?? null]);
}

/** Deletes old and surplus notifications of one person and audience. */
async function prune(client: Sql, userId: string, audience: 'learner' | 'staff') {
  const { readRetentionDays, maxAgeDays, maxPerPerson } = NOTIFICATION_LIMITS;
  await client.query(`DELETE FROM notifications WHERE user_id=$1 AND audience=$2 AND
      ((read_at IS NOT NULL AND read_at < clock_timestamp()-make_interval(days=>$3)) OR created_at < clock_timestamp()-make_interval(days=>$4))`,
  [userId, audience, readRetentionDays, maxAgeDays]);
  await client.query(`DELETE FROM notifications WHERE id IN (SELECT id FROM notifications WHERE user_id=$1 AND audience=$2
      ORDER BY updated_at DESC,id DESC OFFSET $3)`, [userId, audience, maxPerPerson]);
}

/**
 * Adds a notification for one person, or leaves the one with the same key as it is. The kind needs
 * an English and a Hebrew message in the app that shows it.
 */
export async function notifyUser(client: PoolClient | Database, input: { workspaceId: string; userId: string; audience: 'learner' | 'staff'; kind: string;
  params?: Record<string, string | number | boolean | null>; link?: string | null; dedupeKey: string; enrollmentId?: string | null;
  /** A changed fingerprint with a rank at least the old one makes a read notification unread again. */
  fingerprint?: string; rank?: number }): Promise<void> {
  await upsert(client, input);
  await prune(client, input.userId, input.audience);
}

interface Condition { kind: (typeof STAFF_NOTIFICATION_KINDS)[number]; subject: string; params: Params; link: string; fingerprint: string; rank: number }
export interface StaffSources { providers?: WorkspaceProviders | undefined }

/** Who is told that AI help is paused: the roles that can change the spending limits. */
const canChangeLimits = (role: string) => roleCan(role, 'supervision.settings');
/** The window in which a held question counts: a stop the owner has not seen stays visible a day. */
const HELD_WINDOW_MS = 86_400_000;
/**
 * AI work held back by a spending limit in the last day (`help_paused`): one condition for the
 * workspace total (every learner's help is paused) and one for learners who reached their own
 * limit (total, per day or per lesson). Counts learners and held requests (learners' questions and
 * their AI tutor's work); never names a learner.
 */
export async function heldWorkConditions(client: Sql, workspaceId: string, now = new Date()): Promise<Condition[]> {
  const rows = (await client.query<{ scope: 'workspace' | 'learner'; learners: number; requests: number }>(
    `SELECT CASE WHEN j.result->>'ceiling'='workspace' THEN 'workspace' ELSE 'learner' END AS scope,
        count(DISTINCT j.enrollment_id)::int AS learners,count(*)::int AS requests
      FROM supervisor_jobs j WHERE j.workspace_id=$1 AND j.state='budget_wait' AND NOT j.cancellation_requested
        AND j.result->>'reason'='budget_exhausted' AND j.result->>'ceiling' IN ('workspace','enrollment','daily','artifact') AND j.updated_at > $2
      GROUP BY 1 ORDER BY 1`, [workspaceId, new Date(now.getTime() - HELD_WINDOW_MS)])).rows;
  // More learners held makes a read notice unread again; fewer leaves it as it is.
  return rows.map(row => ({ kind: 'help_paused' as const, subject: row.scope, params: { scope: row.scope, learners: row.learners, requests: row.requests },
    link: '/providers', fingerprint: String(row.learners), rank: row.learners }));
}
/**
 * Tells the staff who can change the limits, at once, that AI work is held by a spending limit
 * (called in the transaction that stopped a job at a limit). The same notice the staff bell's own
 * refresh keeps while the condition holds, so the learner's "staff have been told" is true from
 * the moment their question is held.
 */
export async function notifyStaffOfHeldWork(client: PoolClient, workspaceId: string, now = new Date()) {
  const conditions = await heldWorkConditions(client, workspaceId, now);
  if (!conditions.length) return;
  const staff = (await client.query<{ user_id: string; role: string }>(
    'SELECT user_id,role FROM memberships WHERE workspace_id=$1 AND role=ANY($2::text[]) ORDER BY user_id LIMIT 200',
    [workspaceId, STAFF_ROLES.filter(canChangeLimits)])).rows;
  for (const person of staff)
    for (const condition of conditions)
      await notifyUser(client, { workspaceId, userId: person.user_id, audience: 'staff', kind: condition.kind, params: condition.params, link: condition.link,
        dedupeKey: staffKey(workspaceId, condition), fingerprint: condition.fingerprint, rank: condition.rank });
}
/** How long a lesson that ran out of questions stays on the staff list while it is not finished. */
const EXHAUSTED_WINDOW_MS = 14 * 86_400_000;
/**
 * Learners in a course whose lesson needs another independent question while none is left
 * (`questions_exhausted`, questions-exhausted.ts), in the last two weeks and not finished since.
 * Counts learners and lessons; never names a learner.
 */
async function exhaustedQuestionsCondition(client: Sql, workspaceId: string, catalog: { id: string; course_key: string }, now: Date): Promise<Condition | null> {
  const row = (await client.query<{ learners: number; lessons: number; latest: Date | null }>(
    `SELECT count(DISTINCT l.enrollment_id)::int AS learners,count(DISTINCT l.payload->>'episodeId')::int AS lessons,max(l.created_at) AS latest
      FROM learning_events l JOIN enrollments e ON e.id=l.enrollment_id JOIN course_releases r ON r.id=e.course_release_id
      WHERE l.workspace_id=$1 AND r.course_key=$2 AND l.event_type='assessment.questions_exhausted' AND l.created_at > $3 AND e.status='active'
        AND NOT EXISTS (SELECT 1 FROM episode_progress p WHERE p.enrollment_id=l.enrollment_id AND p.episode_id=l.payload->>'episodeId' AND p.state IN ('completed','placed'))`,
    [workspaceId, catalog.course_key, new Date(now.getTime() - EXHAUSTED_WINDOW_MS)])).rows[0]!;
  if (!row.learners) return null;
  return { kind: 'questions_exhausted', subject: catalog.id, params: { courseId: catalog.id, learners: row.learners, lessons: row.lessons },
    link: `/courses/${catalog.id}/overview`, fingerprint: String(row.learners), rank: row.learners };
}
/** Tells the staff who can add questions, at once, that a learner ran out of them (in the transaction
 * that recorded it), so the learner's "your course team has been told" is true from that moment. */
export async function notifyStaffOfExhaustedQuestions(client: PoolClient, workspaceId: string, now = new Date()) {
  const catalogs = (await client.query<{ id: string; course_key: string }>(
    'SELECT id,course_key FROM admin_course_catalog WHERE workspace_id=$1 ORDER BY created_at,id LIMIT $2', [workspaceId, NOTIFICATION_LIMITS.courses])).rows;
  const staff = (await client.query<{ user_id: string }>(
    'SELECT user_id FROM memberships WHERE workspace_id=$1 AND role=ANY($2::text[]) ORDER BY user_id LIMIT 200',
    [workspaceId, STAFF_ROLES.filter(role => roleCan(role, 'release.review'))])).rows;
  for (const catalog of catalogs) {
    const condition = await exhaustedQuestionsCondition(client, workspaceId, catalog, now);
    if (!condition) continue;
    for (const person of staff)
      await notifyUser(client, { workspaceId, userId: person.user_id, audience: 'staff', kind: condition.kind, params: condition.params, link: condition.link,
        dedupeKey: staffKey(workspaceId, condition), fingerprint: condition.fingerprint, rank: condition.rank });
  }
}
const staffKey = (workspaceId: string, condition: Pick<Condition, 'kind' | 'subject'>) => `staff:${workspaceId}:${condition.kind}:${condition.subject}`;

/** The conditions one staff member should be told about now, by what their role can act on. */
export async function staffConditions(client: Sql, workspaceId: string, role: string, sources: StaffSources, now = new Date()): Promise<Condition[]> {
  const conditions: Condition[] = [];
  const catalogs = (await client.query<{ id: string; workspace_id: string; course_key: string }>(
    'SELECT id,workspace_id,course_key FROM admin_course_catalog WHERE workspace_id=$1 ORDER BY created_at,id LIMIT $2', [workspaceId, NOTIFICATION_LIMITS.courses])).rows;
  for (const catalog of catalogs) {
    if (roleCan(role, 'release.review') || roleCan(role, 'evidence.review')) {
      const queue = await approvalQueue(client, catalog);
      const count = Object.values(queue).reduce((n, v) => n + v, 0);
      if (count) conditions.push({ kind: 'approvals_waiting', subject: catalog.id, params: { courseId: catalog.id, count, ...queue },
        link: `/courses/${catalog.id}/overview`, fingerprint: String(count), rank: count });
    }
    if (roleCan(role, 'release.review')) {
      const exhausted = await exhaustedQuestionsCondition(client, workspaceId, catalog, now);
      if (exhausted) conditions.push(exhausted);
    }
    if (roleCan(role, 'run.inspect')) {
      const failed = (await client.query<{ n: number; latest: Date | null }>(
        `SELECT count(*)::int AS n,max(j.updated_at) AS latest FROM supervisor_jobs j JOIN enrollments e ON e.id=j.enrollment_id JOIN course_releases r ON r.id=e.course_release_id
          WHERE e.workspace_id=$1 AND r.course_key=$2 AND j.state='failed' AND j.updated_at > $3`,
        [workspaceId, catalog.course_key, new Date(now.getTime() - 86_400_000)])).rows[0]!;
      if (failed.n) conditions.push({ kind: 'jobs_failed', subject: catalog.id, params: { courseId: catalog.id, count: failed.n },
        link: `/courses/${catalog.id}/runs`, fingerprint: failed.latest!.toISOString(), rank: 0 });
    }
  }
  if (roleCan(role, 'provider.configure') && sources.providers) {
    const version = await sources.providers.version(client, workspaceId);
    const parsed = version ? providerConfigurationSchema.safeParse(version.configuration) : null;
    if (parsed?.success)
      for (const item of await uncheckedRoles(client, workspaceId, sources.providers.evalSuite, parsed.data))
        conditions.push({ kind: 'ai_check_needed', subject: item.role, params: { role: item.role, failed: item.failed, checkable: item.covered },
          link: '/providers', fingerprint: `${item.revisionDigest}:${item.failed}`, rank: 0 });
  }
  if (canChangeLimits(role)) conditions.push(...await heldWorkConditions(client, workspaceId, now));
  if (roleCan(role, 'supervision.settings')) {
    const budget = (await client.query<{ limit_micro_usd: string; limit_tokens: string; used_micro_usd: string; used_tokens: string }>(
      'SELECT limit_micro_usd,limit_tokens,used_micro_usd,used_tokens FROM supervisor_workspace_budgets WHERE workspace_id=$1', [workspaceId])).rows[0];
    const share = (used: string, limit: string) => (Number(limit) > 0 ? Math.floor((Number(used) * 100) / Number(limit)) : 0);
    const percent = budget ? Math.max(share(budget.used_micro_usd, budget.limit_micro_usd), share(budget.used_tokens, budget.limit_tokens)) : 0;
    if (percent >= NOTIFICATION_LIMITS.budgetPercent) {
      const level = percent >= 100 ? 100 : percent >= 90 ? 90 : 80;
      conditions.push({ kind: 'budget_near_limit', subject: 'workspace', params: { percent: Math.min(percent, 999), level }, link: '/providers', fingerprint: String(level), rank: level });
    }
  }
  if (role === 'owner' || role === 'admin') {
    // Only an overdue backup is a problem; whether it was encrypted is not (owner decision 9).
    const { rpo } = await backupStatus(client, now);
    if (rpo.status === 'warning' || rpo.status === 'failing')
      conditions.push({ kind: 'backups_overdue', subject: 'workspace', params: { minutes: rpo.currentMinutes, targetMinutes: rpo.targetMinutes, severe: rpo.status === 'failing' },
        link: '/platform', fingerprint: rpo.status, rank: rpo.status === 'failing' ? 2 : 1 });
  }
  return conditions;
}

const refreshedAt = new Map<string, number>();
/** Brings one staff member's notifications in a workspace up to date with their sources. */
export async function refreshStaffNotifications(client: Sql, workspaceId: string, userId: string, role: string, sources: StaffSources, now = new Date()) {
  const conditions = await staffConditions(client, workspaceId, role, sources, now);
  const keys: string[] = [];
  for (const condition of conditions) {
    const dedupeKey = staffKey(workspaceId, condition);
    keys.push(dedupeKey);
    await upsert(client, { workspaceId, userId, audience: 'staff', kind: condition.kind, params: condition.params, link: condition.link, dedupeKey,
      fingerprint: condition.fingerprint, rank: condition.rank });
  }
  await client.query("DELETE FROM notifications WHERE user_id=$1 AND workspace_id=$2 AND audience='staff' AND NOT (dedupe_key = ANY($3::text[]))", [userId, workspaceId, keys]);
  await prune(client, userId, 'staff');
}

/** Clears the refresh throttle (tests). */
export function resetNotificationRefresh() { refreshedAt.clear(); }

interface Row { id: string; kind: string; params: Params; link: string | null; enrollment_id: string | null; workspace_id: string; created_at: Date; updated_at: Date; read_at: Date | null; at: string }
/** A page of one person's notifications, newest first, with the unread count of all of them. */
export async function listNotifications(client: Sql, input: { userId: string; audience: 'learner' | 'staff'; workspaceId?: string | null; limit: number; before?: string | undefined }) {
  const cursor = input.before ? decodeCursor(input.before) : null;
  const rows = (await client.query<Row>(
    `SELECT id,kind,params,link,enrollment_id,workspace_id,created_at,updated_at,read_at,updated_at::text AS at FROM notifications
      WHERE user_id=$1 AND audience=$2 AND ($3::uuid IS NULL OR workspace_id=$3)
        AND ($4::timestamptz IS NULL OR (updated_at,id) < ($4::timestamptz,$5::uuid))
      ORDER BY updated_at DESC,id DESC LIMIT $6`,
    [input.userId, input.audience, input.workspaceId ?? null, cursor?.at ?? null, cursor?.id ?? null, input.limit + 1])).rows;
  const unread = (await client.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM notifications WHERE user_id=$1 AND audience=$2 AND ($3::uuid IS NULL OR workspace_id=$3) AND read_at IS NULL',
    [input.userId, input.audience, input.workspaceId ?? null])).rows[0]!.n;
  const page = rows.slice(0, input.limit), last = page.at(-1);
  return {
    unread,
    items: page.map(row => ({ id: row.id, kind: row.kind, params: row.params, link: row.link, enrollmentId: row.enrollment_id, workspaceId: row.workspace_id,
      createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(), read: row.read_at !== null })),
    nextCursor: rows.length > input.limit && last ? encodeCursor(last.at, last.id) : null,
  };
}
// The database's own text of the time, so the cursor keeps its microseconds.
const encodeCursor = (at: string, id: string) => Buffer.from(`${at}|${id}`).toString('base64url');
function decodeCursor(value: string) {
  const [at, id] = Buffer.from(value, 'base64url').toString('utf8').split('|');
  requireCondition(at && id && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(\.\d{1,6})?[+-]\d\d(:\d\d)?$/.test(at) && z.uuid().safeParse(id).success, 'INVALID_REQUEST');
  return { at: at!, id: id! };
}

/** Marks some or all of one person's notifications read; returns how many changed. */
export async function markNotificationsRead(client: Sql, input: { userId: string; audience: 'learner' | 'staff'; workspaceId?: string | null; ids?: string[] | undefined }) {
  return (await client.query(`UPDATE notifications SET read_at=clock_timestamp() WHERE user_id=$1 AND audience=$2 AND ($3::uuid IS NULL OR workspace_id=$3)
      AND read_at IS NULL AND ($4::uuid[] IS NULL OR id=ANY($4::uuid[]))`, [input.userId, input.audience, input.workspaceId ?? null, input.ids ?? null])).rowCount ?? 0;
}

/** Deletes every notification about one enrollment (enrollment erasure). */
export async function eraseEnrollmentNotifications(client: PoolClient, enrollmentId: string) {
  return (await client.query('DELETE FROM notifications WHERE enrollment_id=$1', [enrollmentId])).rowCount ?? 0;
}
/** Deletes every notification of one person (account erasure). */
export async function eraseUserNotifications(client: PoolClient, userId: string) {
  return (await client.query('DELETE FROM notifications WHERE user_id=$1', [userId])).rowCount ?? 0;
}

/** Whether a learner is using the app right now (a study session with activity in the last two minutes). */
export async function learnerPresent(client: Sql, enrollmentId: string) {
  return ((await client.query("SELECT 1 FROM learner_sessions WHERE enrollment_id=$1 AND ended_at IS NULL AND last_activity_at > clock_timestamp()-interval '2 minutes'",
    [enrollmentId])).rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------- routes

const listQuery = z.strictObject({ limit: z.coerce.number().int().min(1).max(NOTIFICATION_LIMITS.listLimit).default(20), before: z.string().min(1).max(200).optional() });
const readBody = z.union([z.strictObject({ ids: z.array(z.uuid()).min(1).max(NOTIFICATION_LIMITS.listLimit) }), z.strictObject({ all: z.literal(true) })]);
const workspaceParams = z.strictObject({ workspaceId: z.uuid() });
function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value ?? {});
  requireCondition(parsed.success, 'INVALID_REQUEST');
  return parsed.data;
}

export function registerNotificationRoutes(app: FastifyInstance, db: Database, auth: Auth, sources: StaffSources = {}) {
  const staff = '/api/admin/workspaces/:workspaceId/notifications';
  app.get(staff, async (request, reply) => {
    const actor = await auth.authenticate(request), { workspaceId } = parse(workspaceParams, request.params), query = parse(listQuery, request.query);
    reply.header('Cache-Control', 'no-store');
    return transaction(db, async client => {
      const role = (await workspaceRole(client, actor, workspaceId, STAFF_ROLES))!;
      const key = `${workspaceId}:${actor.id}`, last = refreshedAt.get(key) ?? 0;
      if (!query.before && Date.now() - last >= NOTIFICATION_LIMITS.refreshSeconds * 1000) {
        await refreshStaffNotifications(client, workspaceId, actor.id, role, sources);
        if (refreshedAt.size > 10_000) refreshedAt.clear();
        refreshedAt.set(key, Date.now());
      }
      return listNotifications(client, { userId: actor.id, audience: 'staff', workspaceId, limit: query.limit, before: query.before });
    });
  });
  app.post(`${staff}/read`, { bodyLimit: 8192 }, async request => {
    const actor = await auth.authenticate(request), { workspaceId } = parse(workspaceParams, request.params), body = parse(readBody, request.body);
    return transaction(db, async client => {
      await workspaceRole(client, actor, workspaceId, STAFF_ROLES);
      const changed = await markNotificationsRead(client, { userId: actor.id, audience: 'staff', workspaceId, ids: 'ids' in body ? body.ids : undefined });
      return { changed, ...(await listNotifications(client, { userId: actor.id, audience: 'staff', workspaceId, limit: 20 })) };
    });
  });
  // A learner's own notifications across their enrollments: only ever the signed-in person's rows.
  app.get('/api/me/notifications', async (request, reply) => {
    const actor = await auth.authenticate(request), query = parse(listQuery, request.query);
    reply.header('Cache-Control', 'no-store');
    return listNotifications(db, { userId: actor.id, audience: 'learner', limit: query.limit, before: query.before });
  });
  app.post('/api/me/notifications/read', { bodyLimit: 8192 }, async request => {
    const actor = await auth.authenticate(request), body = parse(readBody, request.body);
    return transaction(db, async client => {
      const changed = await markNotificationsRead(client, { userId: actor.id, audience: 'learner', ids: 'ids' in body ? body.ids : undefined });
      return { changed, ...(await listNotifications(client, { userId: actor.id, audience: 'learner', limit: 20 })) };
    });
  });
}

/** Staff refresh for tests and tools that want the current state without the throttle. */
export async function staffNotificationsNow(db: Database, workspaceId: string, userId: string, sources: StaffSources = {}) {
  return transaction(db, async client => {
    const role = await resolveRole(client, { id: userId }, workspaceId);
    requireCondition(role && (STAFF_ROLES as readonly string[]).includes(role), 'FORBIDDEN', 403);
    await refreshStaffNotifications(client, workspaceId, userId, role!, sources);
    return listNotifications(client, { userId, audience: 'staff', workspaceId, limit: NOTIFICATION_LIMITS.listLimit });
  });
}
