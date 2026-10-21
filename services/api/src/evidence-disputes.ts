import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { authService } from './auth.js';
import { transaction, type Database } from './database.js';
import { requireCondition } from './errors.js';
import { requireSameRequest } from './erased-digests.js';
import { appendEvent } from './events.js';
import { acknowledgeable, catalogFor, reviewEvidenceWithin } from './admin-routes.js';
import { OPEN_DISPUTE } from './learner-model.js';
import { digestJson, type Release } from './repository.js';
import { codeView, DETERMINISTIC_ITEM_TYPES, findAssessment } from './gates.js';

/** The kind of answer a disputed result came from, in words staff recognise. */
function answerKind(type: string | undefined) {
  if (!type) return 'other' as const;
  if (type === 'choice') return 'choice' as const;
  if (type === 'numeric' || type === 'prediction') return 'number' as const;
  if (type === 'trace') return 'trace' as const;
  if (type === 'code' || type === 'code_repair') return 'code' as const;
  if (type === 'rubric' || type === 'counterexample' || type === 'experiment_design' || type === 'teach_back') return 'written' as const;
  return 'other' as const;
}

/**
 * Staff queue of learners' open evidence disputes (learner-model.ts, migration 044) for one
 * course. A row shows the dispute's state, objective, evidence reference and age. It never
 * carries the learner's reason: that is 'evidence-dispute-reason' in learner-privacy.ts.
 *
 * A dispute of any result (a choice, a number, code, a written answer, a delayed check) is resolved
 * the way #83 closes it: staff review the disputed evidence. "Uphold" keeps the result: any result
 * that did not pass, or a pass Core can re-check (an independent, unassisted, passing deterministic
 * answer). "Invalidate" removes the evidence and recomputes progress, and for a delayed check the
 * review schedule. An automatically graded answer can also be graded again (scoped-corrections.ts). Neither grants credit. Both go
 * through the same review as the enrollment's evidence list (reviewEvidenceWithin), require
 * `evidence.review` on the course through permit(), and are audited.
 */
const DAY_MS = 86_400_000;
const QUEUE_LIMIT = 200;
const uuid = { type: 'string', format: 'uuid' };
const resolutionSchema = z.strictObject({
  decision: z.enum(['accept', 'reject']),
  note: z.string().trim().min(1).max(600),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9:_-]{8,200}$/),
});

interface QueueRow {
  dispute_id: string; created_at: Date; enrollment_id: string; user_id: string; display_name: string; course_release_id: string; release_version: string;
  evidence_id: string; objective_id: string; attempt_id: string; assessment_id: string; result: { passed?: unknown }; attempt_result: { passed?: unknown };
  independent: boolean; independent_eligible: boolean | null; assistance: string; challenge_assistance: string | null; mode: string; course_digest: string;
}

export function registerEvidenceDisputeRoutes(app: FastifyInstance, db: Database, auth: ReturnType<typeof authService>) {
  app.get('/api/admin/courses/:courseId/evidence-disputes', {
    schema: { params: { type: 'object', additionalProperties: false, required: ['courseId'], properties: { courseId: uuid } } },
  }, async request => {
    const actor = await auth.authenticate(request), { courseId } = request.params as { courseId: string };
    return transaction(db, async client => {
      const { catalog } = await catalogFor(client, actor, courseId, 'evidence.review');
      // The alias `c` is the control row, as OPEN_DISPUTE expects. No reason column is read.
      const rows = (await client.query<QueueRow>(
        `SELECT c.id AS dispute_id,c.created_at,c.enrollment_id,en.user_id,u.display_name,en.course_release_id,rel.version AS release_version,
            e.id AS evidence_id,e.objective_id,e.attempt_id,e.result,e.independent,a.assessment_id,a.result AS attempt_result,a.assistance,a.mode,a.course_digest,
            ch.independent_eligible,ch.assistance AS challenge_assistance
           FROM learner_evidence_controls c
           JOIN evidence e ON e.id=c.evidence_id AND e.enrollment_id=c.enrollment_id
           JOIN attempts a ON a.id=e.attempt_id AND a.enrollment_id=e.enrollment_id
           LEFT JOIN assessment_challenges ch ON ch.attempt_id=a.id AND ch.enrollment_id=e.enrollment_id
           JOIN enrollments en ON en.id=c.enrollment_id
           JOIN course_releases rel ON rel.id=en.course_release_id AND rel.workspace_id=en.workspace_id
           JOIN app_users u ON u.id=en.user_id
          WHERE en.workspace_id=$1 AND rel.course_key=$2 AND en.status<>'erased' AND ${OPEN_DISPUTE}
          ORDER BY c.created_at,c.id LIMIT ${QUEUE_LIMIT + 1}`, [catalog.workspace_id, catalog.course_key])).rows;
      const releaseIds = [...new Set(rows.map(row => row.course_release_id))];
      const releases = new Map((await client.query<Release>('SELECT * FROM course_releases WHERE id=ANY($1::uuid[]) AND workspace_id=$2', [releaseIds, catalog.workspace_id]))
        .rows.map(release => [release.id, release]));
      const now = Date.now();
      return {
        disputes: rows.slice(0, QUEUE_LIMIT).map(row => {
          const release = releases.get(row.course_release_id)!, own = row.user_id === actor.id;
          const item = findAssessment(release.server_bundle, row.assessment_id), passed = row.result.passed === true;
          return {
            disputeId: row.dispute_id,
            state: 'open' as const,
            enrollmentId: row.enrollment_id,
            learner: row.display_name,
            objectiveId: row.objective_id,
            evidence: { evidenceId: row.evidence_id, attemptId: row.attempt_id, assessmentId: row.assessment_id, passed,
              independent: row.independent, mode: row.mode, releaseVersion: row.release_version, kind: answerKind(item?.type) },
            raisedAt: row.created_at.toISOString(),
            ageDays: Math.max(0, Math.floor((now - row.created_at.getTime()) / DAY_MS)),
            /** Nobody resolves a dispute of their own evidence. */
            canResolve: !own,
            /** Keeping a result that did not pass is always possible (it grants nothing); upholding a
             * pass needs a result Core can acknowledge without grading it. Invalidating is always possible. */
            canUphold: !own && (!passed || acknowledgeable(row, release)),
            /** Graded automatically on the gate path, so staff can also grade the stored answer again (regrade). */
            canRegrade: !own && (row.mode === 'independent' || row.mode === 'practice') && Boolean(item && (codeView(release.server_bundle, item) || DETERMINISTIC_ITEM_TYPES.has(item.type))),
          };
        }),
        truncated: rows.length > QUEUE_LIMIT,
      };
    });
  });

  app.post('/api/admin/courses/:courseId/evidence-disputes/:disputeId/resolve', {
    schema: { params: { type: 'object', additionalProperties: false, required: ['courseId', 'disputeId'], properties: { courseId: uuid, disputeId: uuid } } },
  }, async request => {
    const actor = await auth.authenticate(request), { courseId, disputeId } = request.params as { courseId: string; disputeId: string };
    const parsed = resolutionSchema.safeParse(request.body);
    requireCondition(parsed.success, 'INVALID_INPUT', 400);
    const { idempotencyKey, ...semantic } = parsed.data;
    return transaction(db, async client => {
      const { catalog } = await catalogFor(client, actor, courseId, 'evidence.review', true);
      const operation = 'admin.evidence_dispute.resolved';
      const requestDigest = digestJson({ actorId: actor.id, operation, semantic: { disputeId, ...semantic } });
      const previous = (await client.query<{ request_digest: string; response: Record<string, unknown> }>(
        'SELECT request_digest,response FROM admin_command_receipts WHERE catalog_id=$1 AND idempotency_key=$2', [catalog.id, idempotencyKey])).rows[0];
      if (previous) {
        requireSameRequest(previous.request_digest, requestDigest, 'IDEMPOTENCY_CONFLICT');
        return { ...previous.response, replayed: true };
      }
      const dispute = (await client.query<{ evidence_id: string; enrollment_id: string; user_id: string; status: string; open: boolean }>(
        `SELECT c.evidence_id,c.enrollment_id,en.user_id,en.status,(${OPEN_DISPUTE}) AS open FROM learner_evidence_controls c
           JOIN enrollments en ON en.id=c.enrollment_id JOIN course_releases rel ON rel.id=en.course_release_id AND rel.workspace_id=en.workspace_id
          WHERE c.id=$1 AND c.kind='dispute' AND en.workspace_id=$2 AND rel.course_key=$3 FOR UPDATE OF c`,
        [disputeId, catalog.workspace_id, catalog.course_key])).rows[0];
      requireCondition(dispute, 'EVIDENCE_DISPUTE_NOT_FOUND', 404);
      requireCondition(dispute.status !== 'erased', 'ENROLLMENT_ERASED', 410);
      requireCondition(dispute.user_id !== actor.id, 'SELF_REVIEW_FORBIDDEN', 403);
      requireCondition(dispute.open, 'EVIDENCE_DISPUTE_CLOSED', 409);
      const review = await reviewEvidenceWithin(client, actor, catalog, {
        enrollmentId: dispute.enrollment_id, evidenceId: dispute.evidence_id, decision: semantic.decision, note: semantic.note, disputeId,
      });
      await client.query('UPDATE admin_course_catalog SET revision=revision+1 WHERE id=$1', [catalog.id]);
      // The course-level audit record, like every other admin command.
      const audit = await appendEvent(client, { workspaceId: catalog.workspace_id, actorId: actor.id, actorKind: 'staff', type: operation,
        payload: { catalogId: catalog.id, disputeId, evidenceId: dispute.evidence_id, decision: semantic.decision }, idempotencyKey: `admin:${catalog.id}:${idempotencyKey}` });
      const response = { disputeId, state: 'resolved' as const, decision: semantic.decision, evidenceId: dispute.evidence_id,
        reviewEventId: review.eventId, auditEventId: audit.id, message: review.message, invalidated: semantic.decision === 'reject' };
      await client.query('INSERT INTO admin_command_receipts(catalog_id,idempotency_key,request_digest,actor_id,response,enrollment_id) VALUES($1,$2,$3,$4,$5,$6)',
        [catalog.id, idempotencyKey, requestDigest, actor.id, JSON.stringify(response), dispute.enrollment_id]);
      return { ...response, replayed: false };
    });
  });
}
