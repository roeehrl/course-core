import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { isVersionedGate } from '@course-core/sdk';
import type { Database } from './database.js';
import { transaction } from './database.js';
import type { authService } from './auth.js';
import { ApiError, requireCondition } from './errors.js';
import { appendEvent } from './events.js';
import { digestJson, enrollmentCommand, loadEnrollment, loadEnrollmentRecords, type CommandInput, type Enrollment } from './repository.js';
import { catalogOfEnrollment, resolveRole, roleCan, type AdminPermission } from './course-access.js';
import { episodes } from './learning.js';
import { gateItemIds } from './gates.js';
import { decisionRecord, refreshGateDecision, standingException, type DecisionRow } from './gate-decisions.js';

/** Decision statuses a learner can ask staff to look at again. `ready` needs nothing and
 * `under_review` is already waiting for a reviewer. */
const REVIEWABLE = new Set(['needs_evidence', 'needs_help', 'closed_with_gaps']);
const DAY_MS = 86_400_000;

const resolutionSchema = z.strictObject({
  outcome: z.enum(['upheld', 'exception']),
  note: z.string().trim().min(10).max(2000),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/),
});
interface RequestRow {
  id: string; enrollment_id: string; workspace_id: string; gate_id: string; decision_id: string; reason: string; state: 'open' | 'upheld' | 'exception_granted';
  reviewer_id: string | null; reviewer_note: string | null; exception_course_digest: string | null; exception_gate_version: string | null; request_digest: string | null; created_at: Date; decided_at: Date | null;
}
const requestView = (row: RequestRow) => ({ requestId: row.id, gateId: row.gate_id, decisionId: row.decision_id, reason: row.reason, state: row.state,
  reviewerNote: row.reviewer_note, exception: row.state === 'exception_granted' ? { courseDigest: row.exception_course_digest, gateVersion: row.exception_gate_version } : null, requestedAt: row.created_at.toISOString(), decidedAt: row.decided_at?.toISOString() ?? null });

/** The gate an enrollment's course declares under this ID, with the episode it holds. */
function gateOf(course: Parameters<typeof episodes>[0], gateId: string) {
  const gate = course.gates.find(g => g.id === gateId), episode = episodes(course).find(e => e.gateId === gateId);
  return gate && episode ? { gate, episode } : null;
}

/**
 * Gate review and exception. A learner asks for a review of the current decision on a gate whose
 * appeal policy allows it, within its window. Staff with evidence review rights uphold it with a
 * reason the learner reads; staff who may change enrollments can instead authorize an exception: a
 * separate audited grant that lets the learner advance past this checkpoint on the course and gate
 * version it names. It is not a gate decision and creates no evidence: the decision keeps its status
 * and open criteria, and the objectives are not counted as demonstrated.
 */
export function registerGateReviewRoutes(app: FastifyInstance, db: Database, auth: ReturnType<typeof authService>) {
  const uuid = { type: 'string', format: 'uuid' };
  const gateParams = { type: 'object', additionalProperties: false, required: ['enrollmentId', 'gateId'],
    properties: { enrollmentId: uuid, gateId: { type: 'string', minLength: 1, maxLength: 200 } } };

  app.post('/api/enrollments/:enrollmentId/gates/:gateId/review-requests', {
    schema: { params: gateParams, body: { type: 'object', additionalProperties: false, required: ['expectedRevision', 'idempotencyKey', 'decisionId', 'reason'],
      properties: { expectedRevision: { type: 'integer', minimum: 1 }, idempotencyKey: { type: 'string', minLength: 8, maxLength: 200 }, decisionId: uuid, reason: { type: 'string', maxLength: 2000 } } } },
  }, async request => {
    const actor = await auth.authenticate(request), { enrollmentId, gateId } = request.params as { enrollmentId: string; gateId: string };
    const input = request.body as CommandInput & { decisionId: string; reason: string };
    return enrollmentCommand(db, actor, enrollmentId, 'gate.review_request', input, async (client, context) => {
      requireCondition(context.enrollment.user_id === actor.id, 'LEARNER_ONLY', 403);
      requireCondition(input.reason.trim().length >= 10, 'REVIEW_REASON_REQUIRED', 400);
      const found = gateOf(context.release.server_bundle, gateId);
      requireCondition(found, 'GATE_NOT_FOUND', 404);
      const { gate, episode } = found;
      // Unversioned 0.4 gates declare no appeal policy, so they offer no gate review.
      requireCondition(isVersionedGate(gate) && gate.appealPolicy.allowed, 'GATE_REVIEW_NOT_OFFERED', 409);
      // The request must name the decision Core holds now; another tab's or a forged one is refused.
      const { record } = (await refreshGateDecision(client, context, episode.id))!;
      if (input.decisionId !== record.decisionId) {
        const named = (await client.query<{ gate_id: string }>('SELECT gate_id FROM gate_decisions WHERE id=$1 AND enrollment_id=$2', [input.decisionId, enrollmentId])).rows[0];
        throw new ApiError(409, named?.gate_id === gateId ? 'GATE_DECISION_STALE' : 'GATE_DECISION_UNLINKED', named?.gate_id === gateId ? 'GATE_DECISION_STALE' : 'GATE_DECISION_UNLINKED', { decision: record });
      }
      requireCondition(REVIEWABLE.has(record.status), 'GATE_DECISION_NOT_REVIEWABLE', 409);
      requireCondition(!(await standingException(client, enrollmentId, record)), 'GATE_EXCEPTION_GRANTED', 409);
      const windowDays = gate.appealPolicy.windowDays;
      if (windowDays !== undefined) {
        // The window runs from when the learner first received this outcome, not from the latest recomputation.
        const since = (await client.query<{ at: Date }>(`SELECT min(decided_at) AS at FROM gate_decisions WHERE enrollment_id=$1 AND gate_id=$2 AND status=$3
          AND decided_at > coalesce((SELECT max(decided_at) FROM gate_decisions WHERE enrollment_id=$1 AND gate_id=$2 AND status<>$3), '-infinity')`, [enrollmentId, gateId, record.status])).rows[0]?.at;
        requireCondition(!since || Date.now() - since.getTime() <= windowDays * DAY_MS, 'GATE_REVIEW_WINDOW_CLOSED', 409);
      }
      requireCondition(!(await client.query("SELECT 1 FROM gate_review_requests WHERE enrollment_id=$1 AND gate_id=$2 AND state='open'", [enrollmentId, gateId])).rowCount, 'GATE_REVIEW_OPEN', 409);
      const id = randomUUID();
      await client.query('INSERT INTO gate_review_requests(id,enrollment_id,workspace_id,gate_id,decision_id,reason) VALUES($1,$2,$3,$4,$5,$6)',
        [id, enrollmentId, context.enrollment.workspace_id, gateId, record.decisionId, input.reason.trim()]);
      await client.query('UPDATE enrollments SET revision=revision+1 WHERE id=$1', [enrollmentId]);
      await appendEvent(client, { workspaceId: context.enrollment.workspace_id, enrollmentId, actorId: actor.id, actorKind: 'learner', type: 'gate.review_requested',
        payload: { requestId: id, gateId, decisionId: record.decisionId, status: record.status }, idempotencyKey: `${enrollmentId}:${input.idempotencyKey}`, supervise: true });
      return { requestId: id, state: 'open' as const, revision: context.enrollment.revision + 1 };
    });
  });

  /** The learner's (or enrollment staff's) review requests for one gate, newest first. */
  app.get('/api/enrollments/:enrollmentId/gates/:gateId/review-requests', { schema: { params: gateParams } }, async request => {
    const actor = await auth.authenticate(request), { enrollmentId, gateId } = request.params as { enrollmentId: string; gateId: string };
    return transaction(db, async client => {
      await loadEnrollment(client, actor, enrollmentId, false, true);
      const rows = (await client.query<RequestRow>('SELECT * FROM gate_review_requests WHERE enrollment_id=$1 AND gate_id=$2 ORDER BY created_at DESC,id LIMIT 50', [enrollmentId, gateId])).rows;
      return { requests: rows.map(requestView) };
    });
  });

  /** The shared course-scoped rule: a course grant counts on its own course only. */
  const can = async (client: Database | PoolClient, actor: { id: string }, workspaceId: string, catalogId: string | null, permission: AdminPermission) =>
    roleCan(await resolveRole(client, actor, workspaceId, catalogId), permission);

  /** Open gate review requests for one course, with the decision under review. */
  app.get('/api/admin/courses/:catalogId/gate-reviews', { schema: { params: { type: 'object', additionalProperties: false, required: ['catalogId'], properties: { catalogId: uuid } } } }, async request => {
    const actor = await auth.authenticate(request), { catalogId } = request.params as { catalogId: string };
    const catalog = (await db.query<{ workspace_id: string; course_key: string }>('SELECT workspace_id,course_key FROM admin_course_catalog WHERE id=$1', [catalogId])).rows[0];
    requireCondition(catalog, 'COURSE_NOT_FOUND', 404);
    requireCondition(await can(db, actor, catalog.workspace_id, catalogId, 'evidence.review'), 'FORBIDDEN', 403);
    const mayGrant = await can(db, actor, catalog.workspace_id, catalogId, 'enrollment.write');
    const rows = (await db.query<RequestRow & { decision: DecisionRow; user_id: string; display_name: string }>(
      `SELECT q.*,to_jsonb(d) AS decision,e.user_id,u.display_name FROM gate_review_requests q
         JOIN gate_decisions d ON d.id=q.decision_id JOIN enrollments e ON e.id=q.enrollment_id JOIN app_users u ON u.id=e.user_id
         JOIN course_releases r ON r.id=e.course_release_id
       WHERE e.workspace_id=$1 AND r.course_key=$2 AND q.state='open' AND e.status<>'erased' ORDER BY q.created_at LIMIT 200`, [catalog.workspace_id, catalog.course_key])).rows;
    return { reviews: rows.map(row => {
      const decision = decisionRecord({ ...row.decision, decided_at: new Date(row.decision.decided_at), superseded_at: row.decision.superseded_at ? new Date(row.decision.superseded_at) : null });
      return { ...requestView(row), enrollmentId: row.enrollment_id, learner: row.display_name, decision,
        canUphold: row.user_id !== actor.id, canGrantException: mayGrant && row.user_id !== actor.id };
    }) };
  });

  app.post('/api/admin/gate-reviews/:requestId', { schema: { params: { type: 'object', additionalProperties: false, required: ['requestId'], properties: { requestId: uuid } } } }, async request => {
    const actor = await auth.authenticate(request), { requestId } = request.params as { requestId: string };
    const parsed = resolutionSchema.safeParse(request.body);
    requireCondition(parsed.success, 'INVALID_INPUT', 400);
    const input = parsed.data, { idempotencyKey: _key, ...semantic } = input, digest = digestJson({ reviewer: actor.id, ...semantic });
    return transaction(db, async client => {
      const row = (await client.query<RequestRow>('SELECT * FROM gate_review_requests WHERE id=$1 FOR UPDATE', [requestId])).rows[0];
      requireCondition(row, 'GATE_REVIEW_NOT_FOUND', 404);
      const catalogId = await catalogOfEnrollment(client, (await client.query<{ workspace_id: string; course_release_id: string }>(
        'SELECT workspace_id,course_release_id FROM enrollments WHERE id=$1', [row.enrollment_id])).rows[0]!);
      requireCondition(await can(client, actor, row.workspace_id, catalogId, 'evidence.review'), 'FORBIDDEN', 403);
      if (input.outcome === 'exception') requireCondition(await can(client, actor, row.workspace_id, catalogId, 'enrollment.write'), 'FORBIDDEN', 403);
      const enrollment = (await client.query<Enrollment>('SELECT * FROM enrollments WHERE id=$1 FOR UPDATE', [row.enrollment_id])).rows[0]!;
      requireCondition(enrollment.status !== 'erased', 'ENROLLMENT_ERASED', 410);
      requireCondition(enrollment.user_id !== actor.id, 'SELF_REVIEW_FORBIDDEN', 403);
      if (row.state !== 'open') {
        requireCondition(row.request_digest === digest, 'GATE_REVIEW_ALREADY_DECIDED', 409);
        return { ...requestView(row), replayed: true };
      }
      const context = await loadEnrollmentRecords(client, enrollment), course = context.release.server_bundle;
      const found = gateOf(course, row.gate_id);
      requireCondition(found && isVersionedGate(found.gate), 'GATE_CHANGED', 409);
      const { gate, episode } = found;
      if (gate.appealPolicy.reviewer === 'independent_evaluator') {
        // An independent review is not given by anyone who judged this learner's evidence for the gate.
        const judged = await client.query('SELECT 1 FROM rubric_reviews v JOIN attempts a ON a.id=v.attempt_id WHERE a.enrollment_id=$1 AND a.assessment_id=ANY($2) AND v.reviewer_id=$3 LIMIT 1',
          [row.enrollment_id, gateItemIds(gate), actor.id]);
        requireCondition(!judged.rowCount, 'INDEPENDENT_REVIEWER_REQUIRED', 403);
      }
      let exception: { courseDigest: string; gateVersion: string } | null = null;
      if (input.outcome === 'exception') {
        // Bound to the course and gate version the current decision was made on, which stays as computed.
        const { record } = (await refreshGateDecision(client, context, episode.id))!;
        requireCondition(record.status !== 'ready', 'GATE_ALREADY_READY', 409);
        // The course limit stays above the checkpoint: an exception does not lift a reached cap or deadline.
        requireCondition(record.status !== 'closed_with_gaps', 'GATE_CAP_REACHED', 409);
        exception = { courseDigest: record.courseDigest, gateVersion: record.gateVersion };
      }
      const updated = (await client.query<RequestRow>(`UPDATE gate_review_requests SET state=$2,reviewer_id=$3,reviewer_note=$4,exception_course_digest=$5,exception_gate_version=$6,
        request_digest=$7,decided_at=clock_timestamp() WHERE id=$1 RETURNING *`,
        [requestId, exception ? 'exception_granted' : 'upheld', actor.id, input.note, exception?.courseDigest ?? null, exception?.gateVersion ?? null, digest])).rows[0]!;
      await client.query('UPDATE enrollments SET revision=revision+1 WHERE id=$1', [row.enrollment_id]);
      await appendEvent(client, { workspaceId: row.workspace_id, enrollmentId: row.enrollment_id, actorId: actor.id, actorKind: 'staff', type: 'gate.review_decided',
        payload: { requestId, gateId: row.gate_id, outcome: updated.state, decisionId: row.decision_id }, idempotencyKey: `gate-review:${requestId}`, supervise: true });
      return { ...requestView(updated), replayed: false };
    });
  });
}
