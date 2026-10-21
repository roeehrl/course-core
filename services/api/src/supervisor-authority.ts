import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { RunRef } from '@course-core/supervisor';
import type { Actor, authService } from './auth.js';
import { afterCommitTransaction } from './after-commit.js';
import { catalogOfEnrollment, permitCourse, workspaceRole, roleCan } from './course-access.js';
import { transaction, type Database } from './database.js';
import { appendEvent } from './events.js';
import { requireCondition } from './errors.js';
import { digestJson, loadEnrollment } from './repository.js';
import { requireSameRequest } from './erased-digests.js';
import { parkDeadlineWithin, parkSupervisorJobWithin, resumeSupervisorJobWithin, transitionWithin } from './supervisor-bridge.js';
import type { AuthorityRequest } from './supervisor-tool-loop.js';
import { listTeachingActions } from './teaching-actions.js';

/**
 * Separate authority (design §4 autonomy, requirement B06). After the learner's opt-in the
 * supervisor may change personal teaching on its own, and the learner can undo those changes
 * (personal-changes.ts). It may NOT change the overall goal, required objectives, grading standards
 * or a paid ceiling. It can only ask: its plan carries one authority request and nothing else, the
 * verifier records the request and parks the job (needs_input), and the person with authority
 * decides. The learner decides their own goal; a workspace owner or admin decides the rest. An
 * approval is applied by the decider, under their own authority, in the decision's transaction; the
 * job then resumes on the new state and records that it finished. A rejection ends the job. The
 * learner can undo an approved goal change.
 */
export type AuthorityKind = AuthorityRequest['kind'];
export const approverOf = (kind: AuthorityKind): 'learner' | 'staff' => kind === 'goal_change' ? 'learner' : 'staff';
/** How long a request waits for its decider before the job's deadline ends it. */
export const AUTHORITY_WAIT_MS = 7 * 86_400_000;

interface RequestRow {
  id: string; enrollment_id: string; workspace_id: string; job_id: string; kind: AuthorityKind; approver: 'learner' | 'staff';
  proposal: { goal?: string; objectiveIds?: string[]; limitMicroUsd?: number; reason?: string }; state: 'pending' | 'approved' | 'rejected' | 'expired' | 'undone';
  previous: { goal?: string } | null; decided_by: string | null; decided_at: Date | null; created_at: Date;
}
const view = (row: RequestRow) => ({ requestId: row.id, jobId: row.job_id, kind: row.kind, approver: row.approver,
  proposal: { ...(row.proposal.goal !== undefined ? { goal: row.proposal.goal } : {}), ...(row.proposal.objectiveIds ? { objectiveIds: row.proposal.objectiveIds } : {}),
    ...(row.proposal.limitMicroUsd !== undefined ? { limitMicroUsd: row.proposal.limitMicroUsd } : {}) },
  reason: row.proposal.reason ?? null, state: row.state, decidedAt: row.decided_at?.toISOString() ?? null, createdAt: row.created_at.toISOString(),
  canUndo: row.kind === 'goal_change' && row.state === 'approved' });

/** Called by the plan verifier for a plan that asks for authority. First time: records the request
 * and parks the job until the decision (`pending`). Later passes read the decision. */
export async function authorityGate(db: Database, ref: RunRef, request: AuthorityRequest): Promise<'pending' | 'approved' | 'rejected'> {
  return afterCommitTransaction(db, async client => {
    const row = (await client.query<RequestRow>('SELECT * FROM supervisor_authority_requests WHERE job_id=$1 AND enrollment_id=$2 FOR UPDATE', [ref.jobId, ref.enrollmentId])).rows[0];
    if (row) return row.state === 'approved' ? 'approved' : row.state === 'pending' ? 'pending' : 'rejected';
    const id = randomUUID();
    await client.query(`INSERT INTO supervisor_authority_requests(id,enrollment_id,workspace_id,job_id,kind,approver,proposal) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [id, ref.enrollmentId, ref.workspaceId, ref.jobId, request.kind, approverOf(request.kind), JSON.stringify({ ...request.proposal, reason: request.reason })]);
    await parkSupervisorJobWithin(client, ref, 'needs_input', { deadlineAtMs: await parkDeadlineWithin(client, ref, AUTHORITY_WAIT_MS) });
    await appendEvent(client, { workspaceId: ref.workspaceId, enrollmentId: ref.enrollmentId, actorKind: 'system', type: 'supervisor.authority_requested',
      payload: { requestId: id, jobId: ref.jobId, kind: request.kind, approver: approverOf(request.kind) }, idempotencyKey: `authority:request:${id}`, supervise: false });
    return 'pending';
  });
}

async function jobRef(client: PoolClient, row: RequestRow): Promise<RunRef> {
  const job = (await client.query<{ generation: number; state: string }>("SELECT (runtime_snapshot->>'generation')::integer AS generation,state FROM supervisor_jobs WHERE id=$1 AND enrollment_id=$2",
    [row.job_id, row.enrollment_id])).rows[0];
  requireCondition(job?.state === 'needs_input', 'AUTHORITY_REQUEST_CLOSED', 409);
  return { jobId: row.job_id, workspaceId: row.workspace_id, enrollmentId: row.enrollment_id, generation: job.generation };
}
/** Applies `decision` to a pending request inside the caller's transaction (which holds the enrollment). */
async function decideWithin(client: PoolClient, row: RequestRow, actor: Actor, actorKind: 'learner' | 'staff', decision: 'approve' | 'reject', idempotencyKey: string) {
  requireCondition(row.state === 'pending', 'AUTHORITY_REQUEST_CLOSED', 409);
  const ref = await jobRef(client, row);
  let previous: { goal?: string } | null = null;
  if (decision === 'approve') {
    if (row.kind === 'goal_change') {
      // The learner's own goal, exactly as their profile edit would change it (server.ts /profile).
      const enrollment = (await client.query<{ profile: Record<string, unknown>; profile_revision: number }>('SELECT profile,profile_revision FROM enrollments WHERE id=$1', [row.enrollment_id])).rows[0]!;
      previous = { goal: typeof enrollment.profile.goal === 'string' ? enrollment.profile.goal : '' };
      await client.query("UPDATE enrollments SET profile=jsonb_set(profile,'{goal}',to_jsonb($2::text)),profile_revision=profile_revision+1,revision=revision+1 WHERE id=$1", [row.enrollment_id, row.proposal.goal]);
      await client.query(`UPDATE learner_model_profiles SET profile=jsonb_set(profile,'{preferences}',COALESCE(profile->'preferences','{}'::jsonb)||$2::jsonb)
        WHERE enrollment_id=$1 AND manually_edited`, [row.enrollment_id, JSON.stringify({ goal: row.proposal.goal })]);
    } else if (row.kind === 'paid_ceiling') {
      const budget = (await client.query<{ limit_tokens: string; limit_source: string }>('SELECT limit_tokens,limit_source FROM supervisor_enrollment_budgets WHERE enrollment_id=$1', [row.enrollment_id])).rows[0];
      const workspace = (await client.query<{ default_enrollment_limit_tokens: string | null }>('SELECT default_enrollment_limit_tokens FROM supervisor_workspace_budgets WHERE workspace_id=$1', [row.workspace_id])).rows[0];
      const tokens = Number(budget?.limit_source === 'own' ? budget.limit_tokens : workspace?.default_enrollment_limit_tokens ?? 0);
      // configureSupervisorBudget opens its own transaction; this decision holds the enrollment, so
      // write the same row here instead.
      await client.query(`INSERT INTO supervisor_enrollment_budgets (enrollment_id,workspace_id,limit_micro_usd,limit_tokens,limit_source) VALUES ($1,$2,$3,$4,'own')
        ON CONFLICT (enrollment_id) DO UPDATE SET limit_micro_usd=EXCLUDED.limit_micro_usd,limit_tokens=EXCLUDED.limit_tokens,limit_source='own'`,
        [row.enrollment_id, row.workspace_id, row.proposal.limitMicroUsd, Math.max(tokens, 1)]);
    }
    // Required objectives and grading standards belong to the course's authors: an approval is a
    // recorded staff decision for them to act on; Core never edits a published release.
  }
  await client.query(`UPDATE supervisor_authority_requests SET state=$2,previous=$3,decided_by=$4,decided_at=clock_timestamp() WHERE id=$1`,
    [row.id, decision === 'approve' ? 'approved' : 'rejected', previous ? JSON.stringify(previous) : null, actor.id]);
  await appendEvent(client, { workspaceId: row.workspace_id, enrollmentId: row.enrollment_id, actorId: actor.id, actorKind, type: 'supervisor.authority_decided',
    payload: { requestId: row.id, jobId: row.job_id, kind: row.kind, decision }, idempotencyKey: `authority:decision:${row.id}:${idempotencyKey}`, supervise: false });
  if (decision === 'approve') await resumeSupervisorJobWithin(client, ref, { rebase: true });
  else await transitionWithin(client, { type: 'halt', ref, reason: 'cancel_requested' });
  return view((await client.query<RequestRow>('SELECT * FROM supervisor_authority_requests WHERE id=$1', [row.id])).rows[0]!);
}
/** The learner undoes an approved goal change: the goal they had returns, if it is still the approved one. */
async function undoWithin(client: PoolClient, row: RequestRow, actor: Actor, idempotencyKey: string) {
  requireCondition(row.kind === 'goal_change' && row.state === 'approved', 'AUTHORITY_UNDO_UNAVAILABLE', 409);
  const current = (await client.query<{ goal: string | null }>("SELECT profile->>'goal' AS goal FROM enrollments WHERE id=$1", [row.enrollment_id])).rows[0]!;
  requireCondition(current.goal === row.proposal.goal, 'AUTHORITY_UNDO_SUPERSEDED', 409);
  await client.query("UPDATE enrollments SET profile=jsonb_set(profile,'{goal}',to_jsonb($2::text)),profile_revision=profile_revision+1,revision=revision+1 WHERE id=$1", [row.enrollment_id, row.previous?.goal ?? '']);
  await client.query(`UPDATE learner_model_profiles SET profile=jsonb_set(profile,'{preferences}',COALESCE(profile->'preferences','{}'::jsonb)||$2::jsonb)
    WHERE enrollment_id=$1 AND manually_edited`, [row.enrollment_id, JSON.stringify({ goal: row.previous?.goal ?? '' })]);
  await client.query("UPDATE supervisor_authority_requests SET state='undone' WHERE id=$1", [row.id]);
  await appendEvent(client, { workspaceId: row.workspace_id, enrollmentId: row.enrollment_id, actorId: actor.id, actorKind: 'learner', type: 'supervisor.authority_undone',
    payload: { requestId: row.id, kind: row.kind }, idempotencyKey: `authority:undo:${row.id}:${idempotencyKey}`, supervise: false });
  return view((await client.query<RequestRow>('SELECT * FROM supervisor_authority_requests WHERE id=$1', [row.id])).rows[0]!);
}

const uuid = z.uuid();
const key = z.string().regex(/^[A-Za-z0-9:_-]{8,200}$/);
const parse = <T>(schema: z.ZodType<T>, value: unknown): T => { const r = schema.safeParse(value); requireCondition(r.success, 'INVALID_REQUEST'); return r.data; };
const learnerDecision = z.strictObject({ expectedRevision: z.number().int().positive(), idempotencyKey: key, decision: z.enum(['approve', 'reject', 'undo']) });
const staffDecision = z.strictObject({ idempotencyKey: key, decision: z.enum(['approve', 'reject']) });

export function registerSupervisorAuthorityRoutes(app: FastifyInstance, db: Database, auth: ReturnType<typeof authService>) {
  const base = '/api/enrollments/:enrollmentId/supervision';
  /** The learner's view: what the supervisor asked them to decide, and the teaching actions it took. */
  app.get(`${base}/requests`, async request => {
    const actor = await auth.authenticate(request), enrollmentId = parse(z.object({ enrollmentId: uuid }), request.params).enrollmentId;
    return transaction(db, async client => {
      const enrollment = (await client.query<{ user_id: string; status: string; revision: number }>('SELECT user_id,status,revision FROM enrollments WHERE id=$1', [enrollmentId])).rows[0];
      // Only the learner: these are their own decisions (staff use the admin view).
      requireCondition(enrollment && enrollment.user_id === actor.id, 'ENROLLMENT_NOT_FOUND', 404);
      requireCondition(enrollment.status !== 'erased', 'ENROLLMENT_ERASED', 410);
      const rows = (await client.query<RequestRow>('SELECT * FROM supervisor_authority_requests WHERE enrollment_id=$1 ORDER BY created_at DESC LIMIT 50', [enrollmentId])).rows;
      return { enrollmentId, revision: enrollment.revision, requests: rows.map(view), actions: await listTeachingActions(client, enrollmentId, 30) };
    });
  });
  app.post(`${base}/requests/:requestId/decision`, { bodyLimit: 4096 }, async request => {
    const actor = await auth.authenticate(request);
    const { enrollmentId, requestId } = parse(z.object({ enrollmentId: uuid, requestId: uuid }), request.params), input = parse(learnerDecision, request.body);
    // enrollmentCommand's receipt and revision rules, on the after-commit transaction the job's own
    // transitions need (supervisor-bridge.ts).
    return afterCommitTransaction(db, async client => {
      const context = await loadEnrollment(client, actor, enrollmentId, true);
      requireCondition(context.enrollment.user_id === actor.id, 'LEARNER_ONLY', 403);
      const digest = digestJson({ actorId: actor.id, operation: 'supervision.authority', requestId, decision: input.decision });
      const old = (await client.query<{ request_digest: string; response: unknown }>('SELECT request_digest,response FROM command_receipts WHERE enrollment_id=$1 AND idempotency_key=$2', [enrollmentId, input.idempotencyKey])).rows[0];
      if (old) { requireSameRequest(old.request_digest, digest, 'IDEMPOTENCY_CONFLICT'); return old.response; }
      requireCondition(context.enrollment.revision === input.expectedRevision, 'STALE_REVISION', 409);
      const response = await (async () => {
      const row = (await client.query<RequestRow>('SELECT * FROM supervisor_authority_requests WHERE id=$1 AND enrollment_id=$2 FOR UPDATE', [requestId, enrollmentId])).rows[0];
      requireCondition(row, 'AUTHORITY_REQUEST_NOT_FOUND', 404);
      if (input.decision === 'undo') return undoWithin(client, row, actor, input.idempotencyKey);
      // Staff decisions are not the learner's to make.
      requireCondition(row.approver === 'learner', 'AUTHORITY_DECIDED_BY_STAFF', 403);
      return decideWithin(client, row, actor, 'learner', input.decision, input.idempotencyKey);
      })();
      await client.query('INSERT INTO command_receipts (enrollment_id,idempotency_key,request_digest,response) VALUES ($1,$2,$3,$4)', [enrollmentId, input.idempotencyKey, digest, JSON.stringify(response)]);
      return response;
    });
  });

  const admin = '/api/admin/workspaces/:workspaceId/supervision/requests';
  /** Owner/admin: requests waiting for staff (required objectives, grading standards, paid ceilings). */
  app.get(admin, async request => {
    const actor = await auth.authenticate(request), { workspaceId } = parse(z.object({ workspaceId: uuid }), request.params);
    return transaction(db, async client => {
      requireCondition(roleCan(await workspaceRole(client, actor, workspaceId), 'supervision.settings'), 'FORBIDDEN', 403);
      const rows = (await client.query<RequestRow & { display_name: string }>(`SELECT r.*,COALESCE(e.profile->>'displayName','') AS display_name FROM supervisor_authority_requests r
        JOIN enrollments e ON e.id=r.enrollment_id WHERE r.workspace_id=$1 AND r.approver='staff' AND e.status<>'erased' ORDER BY (r.state='pending') DESC,r.created_at DESC LIMIT 100`, [workspaceId])).rows;
      return { requests: rows.map(row => ({ ...view(row), enrollmentId: row.enrollment_id, learnerName: row.display_name })) };
    });
  });
  app.post(`${admin}/:requestId/decision`, { bodyLimit: 4096 }, async request => {
    const actor = await auth.authenticate(request), { workspaceId, requestId } = parse(z.object({ workspaceId: uuid, requestId: uuid }), request.params);
    const input = parse(staffDecision, request.body);
    return afterCommitTransaction(db, async client => {
      const head = (await client.query<{ enrollment_id: string }>('SELECT enrollment_id FROM supervisor_authority_requests WHERE id=$1 AND workspace_id=$2', [requestId, workspaceId])).rows[0];
      requireCondition(head, 'AUTHORITY_REQUEST_NOT_FOUND', 404);
      // Lock order of every supervisor path: enrollment first.
      const enrollment = (await client.query<{ workspace_id: string; course_release_id: string; status: string }>('SELECT workspace_id,course_release_id,status FROM enrollments WHERE id=$1 FOR UPDATE', [head.enrollment_id])).rows[0]!;
      await permitCourse(client, actor, workspaceId, await catalogOfEnrollment(client, enrollment), 'supervision.settings');
      requireCondition(enrollment.status !== 'erased', 'ENROLLMENT_ERASED', 410);
      const row = (await client.query<RequestRow>('SELECT * FROM supervisor_authority_requests WHERE id=$1 FOR UPDATE', [requestId])).rows[0]!;
      requireCondition(row.approver === 'staff', 'AUTHORITY_DECIDED_BY_LEARNER', 403);
      // A repeated request with the same key answers with the recorded decision.
      if (row.state !== 'pending' && row.decided_by === actor.id) return view(row);
      return decideWithin(client, row, actor, 'staff', input.decision, input.idempotencyKey);
    });
  });
}
