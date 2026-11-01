import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Database } from './database.js';
import { authService } from './auth.js';
import { enrollmentCommand, loadEnrollment, type CommandInput } from './repository.js';
import { requireCondition } from './errors.js';
import { COMPANION_QUESTION_EVENTS_SQL, REFUSED_QUESTION_SQL } from './closure.js';
import { appendEvent } from './events.js';
import type { RuntimeExtension } from './publication.js';
import { contextUsedView, revokeCapsuleSources, type CompanionCapsule } from './context-capsule.js';
import { revokeProposalsCitingEvents } from './learner-model.js';
import { requestSupervisorCancellation } from './supervisor-cancellation.js';
import { replyDrafts } from './reply-drafts.js';
import { registerCompanionAskRoute } from './companion-ask-route.js';

const path = '/api/enrollments/:enrollmentId/companion';
const params = { type: 'object', required: ['enrollmentId'], properties: { enrollmentId: { type: 'string', format: 'uuid' } } };
/** A page of the conversation: at most 100 messages, before a cursor a page returned. */
const pageQuery = z.strictObject({ before: z.string().min(1).max(200).optional(), limit: z.coerce.number().int().min(1).max(100).default(100) });
const feedbackBody = z.strictObject({ expectedRevision: z.number().int().positive().max(2147483646), idempotencyKey: z.string().regex(/^[A-Za-z0-9:_-]{8,200}$/),
  vote: z.enum(['helpful', 'not_helpful']).nullable(), comment: z.string().max(500).optional(), report: z.boolean().optional() });
// A page's cursor is the database's text of its oldest message's time, a bar and its id (as notifications.ts pages).
const encodeCursor = (at: string, id: string) => Buffer.from(`${at}|${id}`).toString('base64url');
function decodeCursor(value: string) {
  const [at, id, ...rest] = Buffer.from(value, 'base64url').toString('utf8').split('|');
  requireCondition(!rest.length && at && id && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(\.\d{1,6})?[+-]\d\d(:\d\d)?$/.test(at) && z.uuid().safeParse(id).success, 'INVALID_REQUEST');
  return { at: at!, id: id! };
}
export function registerCompanionRoutes(app: FastifyInstance, db: Database, auth: ReturnType<typeof authService>, installedExtensions: RuntimeExtension[] = []) {
  /** The learner's conversation, newest page first read: the latest 100 messages, or with `before`
   * (the cursor a page returned) the `limit` messages before it. `earlier` says older messages
   * remain; `before` is the cursor that reads them. Excerpts, exclusions and feedback are read for
   * the page only. */
  app.get(path, { schema: { params } }, async request => {
    const actor = await auth.authenticate(request), { enrollmentId } = request.params as { enrollmentId: string };
    const query = pageQuery.safeParse(request.query ?? {});
    requireCondition(query.success, 'INVALID_REQUEST');
    const cursor = query.data!.before === undefined ? null : decodeCursor(query.data!.before);
    const limit = query.data!.limit;
    await loadEnrollment(db, actor, enrollmentId);
    // A question the supervisor refused has no job; it reads as 'refused' instead of queued forever.
    const found = (await db.query<{ id: string; role: string; content: string; context: Record<string, unknown>; created_at: Date; job_id: string | null; job_state: string | null; job_reason: string | null;
      job_sent: boolean | null; job_ceiling: string | null; refusal_reason: string | null; job_stalled: boolean | null; capsule: CompanionCapsule | null; at: string }>(
      // An answer recorded before it carried its lesson takes the lesson of the question it answers.
      `SELECT m.id,m.role,m.content,CASE WHEN m.role='assistant' AND m.context->>'episodeId' IS NULL AND q.context->>'episodeId' IS NOT NULL
          THEN m.context||jsonb_build_object('episodeId',q.context->'episodeId','blockId',COALESCE(q.context->'blockId','null'::jsonb)) ELSE m.context END AS context,m.created_at,m.job_id,
        -- A cancellation the learner (or staff) asked for reads as cancelled at once, before the job's next step ends it.
        CASE WHEN m.role='learner' AND m.job_id IS NULL AND EXISTS (SELECT 1 FROM learning_events ce WHERE ce.enrollment_id=m.enrollment_id
            AND ce.event_type='companion.question.cancelled' AND ce.payload->>'messageId'=m.id::text) THEN 'cancelled'
          WHEN m.role='learner' AND m.job_id IS NULL AND ${REFUSED_QUESTION_SQL} THEN 'refused'
          WHEN j.cancellation_requested AND j.state NOT IN ('applied','cancelled','failed') THEN 'cancelled' ELSE j.state END AS job_state,j.result->>'reason' AS job_reason,
        -- Whether a provider call for the question was started (a reservation that was sent, settled or is still unknown):
        -- a question cancelled after that may still be charged for what the call used; one cancelled before it costs nothing.
        CASE WHEN m.role='learner' AND j.id IS NOT NULL THEN EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(j.runtime_snapshot->'operations','[]'::jsonb)) o
          WHERE o->>'status' IN ('in_flight','succeeded','uncertain')) END AS job_sent,
        -- Which spending limit holds a question back (workspace, enrollment, daily, artifact), so the learner can be told.
        CASE WHEN m.role='learner' AND j.state='budget_wait' AND NOT j.cancellation_requested THEN j.result->>'ceiling' END AS job_ceiling,
        -- Why Core refused the reply it received (a reason code only; the refused text is never stored).
        CASE WHEN m.role='learner' AND j.state='failed' THEN (SELECT a.content->>'reason' FROM supervisor_artifacts a WHERE a.job_id=j.id AND a.enrollment_id=j.enrollment_id
          AND a.content->>'kind'='output_refusal' LIMIT 1) END AS refusal_reason,
        -- A question whose call ended uncertain (no reply came) with no gateway receipt that can still settle it:
        -- nothing more will come for it, so the learner is told and offered to ask again.
        CASE WHEN m.role='learner' AND j.state='waiting' AND j.result->>'reason'='provider_uncertain' AND NOT j.cancellation_requested
          THEN NOT EXISTS (SELECT 1 FROM provider_dispatches d WHERE d.job_id=j.id AND d.enrollment_id=j.enrollment_id
            AND d.state IN ('in_flight','completed','not_started')) END AS job_stalled,
        CASE WHEN m.role='assistant' THEN c.capsule END AS capsule,
        -- The database's own text of the time, so a page's cursor keeps its microseconds.
        m.created_at::text AS at
      FROM companion_messages m LEFT JOIN supervisor_jobs j ON j.id=m.job_id LEFT JOIN companion_context_capsules c ON c.job_id=m.job_id AND c.enrollment_id=m.enrollment_id
        LEFT JOIN LATERAL (SELECT q.context FROM companion_messages q WHERE m.role='assistant' AND q.job_id=m.job_id AND q.enrollment_id=m.enrollment_id AND q.role='learner' LIMIT 1) q ON true
      WHERE m.enrollment_id=$1 AND ($2::timestamptz IS NULL OR (m.created_at,m.id) < ($2::timestamptz,$3::uuid))
      ORDER BY m.created_at DESC,m.id DESC LIMIT $4`, [enrollmentId, cursor?.at ?? null, cursor?.id ?? null, limit + 1])).rows;
    // One more row than the page says whether older messages remain.
    const earlier = found.length > limit, rows = found.slice(0, limit).reverse(), oldest = rows[0];
    // Short excerpts of the learner's own earlier messages that an answer used, and which of them they excluded.
    const referenced = [...new Set(rows.flatMap(row => row.capsule?.historyRefs?.map(ref => ref.messageId) ?? []))].slice(0, 400);
    const excerpts = new Map((await db.query<{ id: string; excerpt: string }>("SELECT id,left(content,160) AS excerpt FROM companion_messages WHERE enrollment_id=$1 AND id=ANY($2::uuid[])",
      [enrollmentId, referenced])).rows.map(row => [row.id, row.excerpt]));
    const summarized = rows.flatMap(row => row.capsule?.summary?.items?.map(item => item.messageId) ?? []);
    const excluded = new Set((await db.query<{ message_id: string }>('SELECT message_id FROM companion_context_exclusions WHERE enrollment_id=$1 AND ended_at IS NULL AND message_id=ANY($2::uuid[])',
      [enrollmentId, [...new Set([...rows.map(row => row.id), ...referenced, ...summarized])]])).rows.map(row => row.message_id));
    // The learner's vote on each reply and whether they reported it (never the comment: it is only theirs to export).
    const feedback = new Map((await db.query<{ message_id: string; vote: 'helpful' | 'not_helpful' | null; reported: boolean }>(
      'SELECT message_id,vote,reported FROM companion_reply_feedback WHERE enrollment_id=$1 AND message_id=ANY($2::uuid[])',
      [enrollmentId, rows.filter(row => row.role === 'assistant').map(row => row.id)])).rows.map(row => [row.message_id, { vote: row.vote, reported: row.reported }]));
    const messages = rows.map(({ capsule, at: _at, ...row }) => ({ ...row, excluded: excluded.has(row.id),
      ...(row.role === 'assistant' ? { context_used: contextUsedView(capsule, excerpts, excluded), feedback: feedback.get(row.id) ?? null } : {}) }));
    return { messages, earlier, before: earlier && oldest ? encodeCursor(oldest.at, oldest.id) : null };
  });
  /** The learner's feedback on one of the companion's replies: Helpful, Not helpful or neither, an
   * optional short comment and "Report a problem". Stored as one row per reply, changed in place.
   * A vote fences nothing and is not learning evidence: it bumps no revision and records no event,
   * and nothing that teaches or grades reads it. */
  app.post(`${path}/messages/:messageId/feedback`, { bodyLimit: 4096 }, async request => {
    const actor = await auth.authenticate(request);
    const ids = z.object({ enrollmentId: z.uuid(), messageId: z.uuid() }).safeParse(request.params), body = feedbackBody.safeParse(request.body);
    requireCondition(ids.success && body.success, 'INVALID_REQUEST');
    const { enrollmentId, messageId } = ids.data!, input = body.data!;
    const comment = input.comment === undefined ? undefined : input.comment.trim() || null;
    return enrollmentCommand(db, actor, enrollmentId, 'companion.feedback', { ...input, messageId }, async (client, context) => {
      const reply = (await client.query("SELECT 1 FROM companion_messages WHERE id=$1 AND enrollment_id=$2 AND role='assistant' AND content NOT IN ('[deleted]','[erased]')",
        [messageId, enrollmentId])).rowCount;
      requireCondition(reply, 'MESSAGE_NOT_FOUND', 404);
      // A comment or a report left out of the request keeps what was saved.
      const saved = (await client.query<{ vote: 'helpful' | 'not_helpful' | null; reported: boolean }>(`INSERT INTO companion_reply_feedback(enrollment_id,workspace_id,message_id,vote,comment,reported)
          VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (enrollment_id,message_id) DO UPDATE SET vote=EXCLUDED.vote,
          comment=CASE WHEN $7 THEN EXCLUDED.comment ELSE companion_reply_feedback.comment END,
          reported=CASE WHEN $8 THEN EXCLUDED.reported ELSE companion_reply_feedback.reported END,updated_at=clock_timestamp()
        RETURNING vote,reported`, [enrollmentId, context.enrollment.workspace_id, messageId, input.vote, comment ?? null, input.report ?? false,
        comment !== undefined, input.report !== undefined])).rows[0]!;
      return { messageId, feedback: { vote: saved.vote, reported: saved.reported } };
    });
  });
  /** The learner deletes one of their questions. Its text and the answer to it are removed, an answer
   * still being prepared is cancelled and fenced, and what was derived from it is revoked: capsules of
   * other answers drop it, and learner-model suggestions citing it are revoked (C08). */
  app.post(`${path}/messages/:messageId/delete`, { schema: { params: { type: 'object', required: ['enrollmentId', 'messageId'],
    properties: { enrollmentId: { type: 'string', format: 'uuid' }, messageId: { type: 'string', format: 'uuid' } } },
    body: { type: 'object', additionalProperties: false, required: ['expectedRevision', 'idempotencyKey'], properties: {
      expectedRevision: { type: 'integer', minimum: 1 }, idempotencyKey: { type: 'string', minLength: 8, maxLength: 200, pattern: '^[A-Za-z0-9:_-]+$' } } } } }, async request => {
    const actor = await auth.authenticate(request), { enrollmentId, messageId } = request.params as { enrollmentId: string; messageId: string };
    const input = request.body as CommandInput;
    let jobId: string | null = null;
    const deleted = await enrollmentCommand(db, actor, enrollmentId, 'companion.delete', { ...input, messageId }, async (client, context) => {
      const message = (await client.query<{ job_id: string | null; content: string }>("SELECT job_id,content FROM companion_messages WHERE id=$1 AND enrollment_id=$2 AND role='learner' FOR UPDATE",
        [messageId, enrollmentId])).rows[0];
      requireCondition(message, 'MESSAGE_NOT_FOUND', 404);
      requireCondition(message.content !== '[deleted]', 'MESSAGE_ALREADY_DELETED', 409);
      jobId = message.job_id;
      const requested = (await client.query<{ id: string }>(`SELECT id FROM learning_events WHERE enrollment_id=$1 AND event_type IN ${COMPANION_QUESTION_EVENTS_SQL} AND payload->>'messageId'=$2::text`,
        [enrollmentId, messageId])).rows.map(row => row.id);
      // A real context change: an answer still being prepared from it is fenced as well as cancelled.
      context.enrollment.revision = (await client.query<{ revision: number }>('UPDATE enrollments SET revision=revision+1 WHERE id=$1 RETURNING revision', [enrollmentId])).rows[0]!.revision;
      await client.query("UPDATE companion_messages SET content='[deleted]',context='{}'::jsonb WHERE id=$1 AND enrollment_id=$2", [messageId, enrollmentId]);
      // The learner's feedback on the answers that go with it goes too.
      if (message.job_id) await client.query(`DELETE FROM companion_reply_feedback WHERE enrollment_id=$1 AND message_id IN
        (SELECT id FROM companion_messages WHERE enrollment_id=$1 AND job_id=$2 AND role='assistant')`, [enrollmentId, message.job_id]);
      const answers = message.job_id ? (await client.query("UPDATE companion_messages SET content='[deleted]',context='{}'::jsonb WHERE enrollment_id=$1 AND job_id=$2 AND role='assistant'",
        [enrollmentId, message.job_id])).rowCount ?? 0 : 0;
      const cancelled = message.job_id ? (await client.query("UPDATE supervisor_jobs SET cancellation_requested=true WHERE id=$1 AND enrollment_id=$2 AND state NOT IN ('applied','cancelled','failed')",
        [message.job_id, enrollmentId])).rowCount ?? 0 : 0;
      await client.query('UPDATE outbox SET quarantined_at=clock_timestamp() WHERE event_id=ANY($1::uuid[]) AND delivered_at IS NULL AND quarantined_at IS NULL', [requested]);
      const capsules = await revokeCapsuleSources(client, enrollmentId, messageId, requested);
      const revokedProposalIds = await revokeProposalsCitingEvents(client, context, actor, requested, input.idempotencyKey);
      const event = await appendEvent(client, { workspaceId: context.enrollment.workspace_id, enrollmentId, actorId: actor.id, actorKind: 'learner', type: 'companion.message.deleted',
        payload: { messageId, answersDeleted: answers, jobCancelled: cancelled > 0, capsulesRevised: capsules, revokedProposalIds }, idempotencyKey: `${enrollmentId}:${input.idempotencyKey}` });
      return { messageId, deleted: true, eventId: event.id, revision: context.enrollment.revision, answersDeleted: answers, jobCancelled: cancelled > 0, capsulesRevised: capsules, revokedProposalIds };
    });
    // A reply still streaming for the deleted question stops showing at once.
    if (jobId) replyDrafts().cancel(enrollmentId, jobId);
    return deleted;
  });
  /** The learner stops waiting for the answer to one of their questions (also the "Stop" on a reply
   * that is streaming). The question stays (it is not deleted and can be asked again). Its
   * undelivered request is withdrawn; the job preparing its answer is cancelled, so no new provider
   * call starts for it, and a call under way is aborted: the gateway sees the committed
   * cancellation and closes its provider request (provider-gateway.ts, docs/provider-stalls.md); a
   * draft being shown is withdrawn at once. Nothing the job produced is kept or shown. The aborted
   * call is settled at the usage reported up to the stop (or stays uncertain for the owner), never
   * resent; a job with no call out is ended by the dispatcher's reconcile pass. */
  app.post(`${path}/messages/:messageId/cancel`, { schema: { params: { type: 'object', required: ['enrollmentId', 'messageId'],
    properties: { enrollmentId: { type: 'string', format: 'uuid' }, messageId: { type: 'string', format: 'uuid' } } },
    body: { type: 'object', additionalProperties: false, required: ['expectedRevision', 'idempotencyKey'], properties: {
      expectedRevision: { type: 'integer', minimum: 1 }, idempotencyKey: { type: 'string', minLength: 8, maxLength: 200, pattern: '^[A-Za-z0-9:_-]+$' } } } } }, async request => {
    const actor = await auth.authenticate(request), { enrollmentId, messageId } = request.params as { enrollmentId: string; messageId: string };
    const input = request.body as CommandInput;
    let jobId: string | null = null;
    const result = await enrollmentCommand(db, actor, enrollmentId, 'companion.cancel', { ...input, messageId }, async (client, context) => {
      const message = (await client.query<{ job_id: string | null; content: string }>("SELECT job_id,content FROM companion_messages WHERE id=$1 AND enrollment_id=$2 AND role='learner' FOR UPDATE",
        [messageId, enrollmentId])).rows[0];
      requireCondition(message, 'MESSAGE_NOT_FOUND', 404);
      requireCondition(message.content !== '[deleted]', 'MESSAGE_ALREADY_DELETED', 409);
      jobId = message.job_id;
      const answered = message.job_id ? (await client.query("SELECT 1 FROM companion_messages WHERE enrollment_id=$1 AND job_id=$2 AND role='assistant' LIMIT 1",
        [enrollmentId, message.job_id])).rowCount : 0;
      requireCondition(!answered, 'MESSAGE_ALREADY_ANSWERED', 409);
      const requested = (await client.query<{ id: string }>(`SELECT id FROM learning_events WHERE enrollment_id=$1 AND event_type IN ${COMPANION_QUESTION_EVENTS_SQL} AND payload->>'messageId'=$2::text`,
        [enrollmentId, messageId])).rows.map(row => row.id);
      // Not yet prepared into a job: withdrawing the request is the whole cancellation.
      const withdrawn = (await client.query('UPDATE outbox SET quarantined_at=clock_timestamp() WHERE event_id=ANY($1::uuid[]) AND delivered_at IS NULL AND quarantined_at IS NULL',
        [requested])).rowCount ?? 0;
      const cancelled = message.job_id ? (await requestSupervisorCancellation(client,
        { workspaceId: context.enrollment.workspace_id, enrollmentId, jobIds: [message.job_id] }, 'learner_cancelled')).newlyCancelled : 0;
      requireCondition(withdrawn > 0 || cancelled > 0, 'MESSAGE_NOT_PENDING', 409);
      const event = await appendEvent(client, { workspaceId: context.enrollment.workspace_id, enrollmentId, actorId: actor.id, actorKind: 'learner', type: 'companion.question.cancelled',
        payload: { messageId, jobCancelled: cancelled > 0, requestWithdrawn: withdrawn > 0 }, idempotencyKey: `${enrollmentId}:${input.idempotencyKey}` });
      return { messageId, cancelled: true, eventId: event.id, revision: context.enrollment.revision };
    });
    // A reply still streaming for this question stops showing at once.
    if (jobId) replyDrafts().cancel(enrollmentId, jobId);
    return result;
  });
  // Asking the companion (the POST) lives in companion-ask-route.ts.
  registerCompanionAskRoute(app, db, auth, installedExtensions);
}
