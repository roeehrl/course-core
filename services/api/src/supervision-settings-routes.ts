import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { Actor, authService } from './auth.js';
import { catalogOfEnrollment, permitCourse, roleCan, workspaceRole } from './course-access.js';
import { transaction, type Database } from './database.js';
import { appendEvent } from './events.js';
import { requireCondition } from './errors.js';
import { AUTONOMY_LEVELS, supervisionSettingsWithin } from './supervision-settings.js';
import { configureSupervisorPeriodBudgetWithin } from './supervisor-bridge.js';
import { SUPERVISOR_TOOLS, TOOL_FAMILIES, offeredTools } from './supervisor-tool-catalog.js';
import { supervisorToolLoopStrategy } from './agent-strategies.js';

/**
 * Owner/admin settings for AI supervision (requirements Q08, B09), in the supervision admin area:
 * how far the supervisor may act on its own, which tool families it may use, and each learner's
 * daily and per-lesson AI spending limits. Every change is checked against the stored revision,
 * audited as a staff event, and previewed before it is saved.
 */
const uuid = z.uuid();
const parse = <T>(schema: z.ZodType<T>, value: unknown): T => { const r = schema.safeParse(value); requireCondition(r.success, 'INVALID_REQUEST'); return r.data; };
const settingsInput = z.strictObject({
  expectedRevision: z.number().int().nonnegative(),
  autonomyLevel: z.enum(AUTONOMY_LEVELS),
  permittedToolFamilies: z.array(z.enum(TOOL_FAMILIES)).max(TOOL_FAMILIES.length).refine(f => new Set(f).size === f.length),
});
/** Whole US dollars and cents are entered in the admin page; the server stores micro-dollars. */
const limit = z.strictObject({ microUsd: z.number().int().min(0).max(1_000_000_000_000), tokens: z.number().int().min(0).max(1_000_000_000_000) });
const budgetInput = z.strictObject({ daily: limit.nullable(), artifact: limit.nullable() });

async function requireSettingsRole(client: PoolClient, actor: Actor, workspaceId: string) {
  // Workspace-wide only: a course grant never changes workspace settings.
  requireCondition(roleCan(await workspaceRole(client, actor, workspaceId), 'supervision.settings'), 'FORBIDDEN', 403);
}
/** What a settings choice lets the supervisor do, for the page to show before saving. */
async function preview(client: PoolClient, workspaceId: string, input: { autonomyLevel: string; permittedToolFamilies: readonly string[] }) {
  const current = await supervisionSettingsWithin(client, workspaceId);
  const all = supervisorToolLoopStrategy.contract.toolRefs;
  const before = new Set(offeredTools(all, undefined, current.permittedToolFamilies)), after = new Set(offeredTools(all, undefined, input.permittedToolFamilies));
  const counts = (await client.query<{ opted: number; open: number }>(`SELECT
      (SELECT count(*)::int FROM supervisor_permissions p JOIN enrollments e ON e.id=p.enrollment_id WHERE p.workspace_id=$1 AND p.adaptive_teaching AND e.status='active') AS opted,
      (SELECT count(*)::int FROM teaching_actions WHERE workspace_id=$1 AND state IN ('started','scheduled')) AS open`, [workspaceId])).rows[0]!;
  return {
    autonomyLevel: input.autonomyLevel,
    // Plain consequence codes the page translates.
    effects: input.autonomyLevel === 'recommend_only' ? ['records_recommendations_only', 'no_new_teaching_actions', 'scheduled_follow_ups_end']
      : input.autonomyLevel === 'propose_only' ? ['starts_teaching_actions', 'teaching_changes_refused', 'learner_reviewed_proposals_continue']
      : ['starts_teaching_actions', 'verified_personal_changes_apply', 'learner_can_undo'],
    toolsAdded: [...after].filter(t => !before.has(t)), toolsRemoved: [...before].filter(t => !after.has(t)),
    // Without these families the supervisor cannot run its tool loop at all.
    warnings: [...(after.size === 0 ? ['no_tools'] : []), ...(!input.permittedToolFamilies.includes('learner_read') ? ['no_learner_read'] : [])],
    optedInLearners: counts.opted, openTeachingActions: counts.open,
  };
}

export function registerSupervisionSettingsRoutes(app: FastifyInstance, db: Database, auth: ReturnType<typeof authService>) {
  const base = '/api/admin/workspaces/:workspaceId/supervision';
  app.get(`${base}/settings`, async request => {
    const actor = await auth.authenticate(request), { workspaceId } = parse(z.object({ workspaceId: uuid }), request.params);
    return transaction(db, async client => {
      await requireSettingsRole(client, actor, workspaceId);
      const settings = await supervisionSettingsWithin(client, workspaceId);
      return { ...settings, levels: AUTONOMY_LEVELS,
        families: TOOL_FAMILIES.map(family => ({ id: family, tools: SUPERVISOR_TOOLS.filter(t => t.family === family).map(t => ({ id: t.contract.id, sideEffects: t.contract.sideEffects })) })) };
    });
  });
  /** Test before save: what the chosen settings would allow, and who they would affect. Saves nothing. */
  app.post(`${base}/settings/preview`, { bodyLimit: 4096 }, async request => {
    const actor = await auth.authenticate(request), { workspaceId } = parse(z.object({ workspaceId: uuid }), request.params);
    const input = parse(settingsInput.omit({ expectedRevision: true }), request.body);
    return transaction(db, async client => { await requireSettingsRole(client, actor, workspaceId); return preview(client, workspaceId, input); });
  });
  app.put(`${base}/settings`, { bodyLimit: 4096 }, async request => {
    const actor = await auth.authenticate(request), { workspaceId } = parse(z.object({ workspaceId: uuid }), request.params);
    const input = parse(settingsInput, request.body);
    return transaction(db, async client => {
      await requireSettingsRole(client, actor, workspaceId);
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`supervision-settings:${workspaceId}`]);
      const before = await supervisionSettingsWithin(client, workspaceId);
      requireCondition(before.revision === input.expectedRevision, 'SUPERVISION_SETTINGS_CHANGED', 409);
      const families = TOOL_FAMILIES.filter(f => input.permittedToolFamilies.includes(f));
      const saved = (await client.query<{ revision: number }>(`INSERT INTO supervision_settings(workspace_id,autonomy_level,permitted_tool_families,revision,updated_by)
        VALUES($1,$2,$3,1,$4) ON CONFLICT (workspace_id) DO UPDATE SET autonomy_level=EXCLUDED.autonomy_level,permitted_tool_families=EXCLUDED.permitted_tool_families,
        revision=supervision_settings.revision+1,updated_by=EXCLUDED.updated_by,updated_at=clock_timestamp() RETURNING revision`,
        [workspaceId, input.autonomyLevel, families, actor.id])).rows[0]!;
      await appendEvent(client, { workspaceId, actorId: actor.id, actorKind: 'staff', type: 'supervision.settings_changed',
        payload: { revision: saved.revision, from: { autonomyLevel: before.autonomyLevel, permittedToolFamilies: before.permittedToolFamilies },
          to: { autonomyLevel: input.autonomyLevel, permittedToolFamilies: families } },
        idempotencyKey: `supervision-settings:${workspaceId}:${saved.revision}`, supervise: false });
      return { ...(await supervisionSettingsWithin(client, workspaceId)) };
    });
  });

  /** One learner's AI spending limits: overall (set elsewhere), per day and per lesson per day. */
  const enrollmentBase = `${base}/enrollments/:enrollmentId/budget`;
  async function enrollmentScope(client: PoolClient, actor: Actor, workspaceId: string, enrollmentId: string) {
    const enrollment = (await client.query<{ workspace_id: string; course_release_id: string; status: string; current_episode_id: string | null }>(
      'SELECT workspace_id,course_release_id,status,current_episode_id FROM enrollments WHERE id=$1 AND workspace_id=$2 FOR UPDATE', [enrollmentId, workspaceId])).rows[0];
    requireCondition(enrollment, 'ENROLLMENT_NOT_FOUND', 404);
    await permitCourse(client, actor, workspaceId, await catalogOfEnrollment(client, enrollment), 'supervision.settings');
    requireCondition(enrollment.status !== 'erased', 'ENROLLMENT_ERASED', 410);
    return enrollment;
  }
  async function budgetView(client: PoolClient, workspaceId: string, enrollmentId: string, episodeId: string | null) {
    const row = (await client.query<{ limit_micro_usd: string; limit_tokens: string; limit_source: string; used_micro_usd: string; used_tokens: string;
      daily_limit_micro_usd: string | null; daily_limit_tokens: string | null; artifact_limit_micro_usd: string | null; artifact_limit_tokens: string | null }>(
      'SELECT * FROM supervisor_enrollment_budgets WHERE enrollment_id=$1 AND workspace_id=$2', [enrollmentId, workspaceId])).rows[0];
    const used = async (episode: string | null) => (await client.query<{ usd: string; tokens: string }>(`SELECT COALESCE(sum(s.micro_usd),0) AS usd,COALESCE(sum(s.tokens),0) AS tokens
      FROM supervisor_job_spend s JOIN supervisor_jobs j ON j.id=s.job_id AND j.enrollment_id=s.enrollment_id WHERE s.enrollment_id=$1 AND s.workspace_id=$2
        AND j.created_at>=date_trunc('day',clock_timestamp(),'UTC') AND ($3::text IS NULL OR EXISTS (SELECT 1 FROM supervisor_inputs i WHERE i.job_id=j.id AND i.context->>'episodeId'=$3))`,
      [enrollmentId, workspaceId, episode])).rows[0]!;
    const pair = (usd: string | null | undefined, tokens: string | null | undefined) => usd === null || usd === undefined || tokens === null || tokens === undefined ? null : { microUsd: Number(usd), tokens: Number(tokens) };
    const today = await used(null), lesson = episodeId ? await used(episodeId) : null;
    return { enrollmentId, overall: row?.limit_source === 'own' ? pair(row.limit_micro_usd, row.limit_tokens) : null,
      daily: pair(row?.daily_limit_micro_usd, row?.daily_limit_tokens), artifact: pair(row?.artifact_limit_micro_usd, row?.artifact_limit_tokens),
      usedToday: { microUsd: Number(today.usd), tokens: Number(today.tokens) },
      usedInCurrentLessonToday: lesson ? { microUsd: Number(lesson.usd), tokens: Number(lesson.tokens) } : null, currentEpisodeId: episodeId,
      // Days are counted in UTC.
      dayBoundary: 'utc' as const };
  }
  app.get(enrollmentBase, async request => {
    const actor = await auth.authenticate(request), { workspaceId, enrollmentId } = parse(z.object({ workspaceId: uuid, enrollmentId: uuid }), request.params);
    return transaction(db, async client => {
      const enrollment = await enrollmentScope(client, actor, workspaceId, enrollmentId);
      return budgetView(client, workspaceId, enrollmentId, enrollment.current_episode_id);
    });
  });
  app.put(enrollmentBase, { bodyLimit: 2048 }, async request => {
    const actor = await auth.authenticate(request), { workspaceId, enrollmentId } = parse(z.object({ workspaceId: uuid, enrollmentId: uuid }), request.params);
    const input = parse(budgetInput, request.body);
    return transaction(db, async client => {
      const enrollment = await enrollmentScope(client, actor, workspaceId, enrollmentId);
      // A per-lesson limit above the daily one could never be reached; say so instead of saving it.
      requireCondition(!input.daily || !input.artifact || (input.artifact.microUsd <= input.daily.microUsd && input.artifact.tokens <= input.daily.tokens), 'SUPERVISION_LESSON_LIMIT_ABOVE_DAILY', 400);
      await configureSupervisorPeriodBudgetWithin(client, { workspaceId, enrollmentId }, input);
      await appendEvent(client, { workspaceId, enrollmentId, actorId: actor.id, actorKind: 'staff', type: 'supervision.budget_changed',
        payload: { daily: input.daily, artifact: input.artifact }, idempotencyKey: `supervision-budget:${enrollmentId}:${randomUUID()}`, supervise: false });
      return budgetView(client, workspaceId, enrollmentId, enrollment.current_episode_id);
    });
  });
}
