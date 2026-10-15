import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { currentClientEnvelope } from './event-envelope.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const field = (payload: unknown, key: string) =>
  payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>)[key] : undefined;

/**
 * Appends one learning event (and, when supervised, its outbox row) in the
 * caller's transaction. The envelope records the client that caused it (the
 * current request's X-Course-* headers), the course version of the enrollment,
 * the attempt and check instance it concerns (from the input, the payload's
 * attemptId/challengeId, or the check the attempt answered) and the event that caused it.
 */
export async function appendEvent(client: PoolClient, input: {
  workspaceId: string; enrollmentId?: string; actorId?: string;
  actorKind: 'learner' | 'staff' | 'agent' | 'system'; type: string;
  payload: unknown; idempotencyKey: string; correlationId?: string; supervise?: boolean;
  attemptId?: string; activityInstanceId?: string; causationId?: string; payloadRef?: string;
}) {
  // Background work (no request) records no client facts.
  const id = randomUUID(), client_ = currentClientEnvelope();
  const attemptId = input.attemptId ?? (typeof field(input.payload, 'attemptId') === 'string' && UUID.test(field(input.payload, 'attemptId') as string) ? field(input.payload, 'attemptId') as string : null);
  const instance = input.activityInstanceId ?? (typeof field(input.payload, 'challengeId') === 'string' ? (field(input.payload, 'challengeId') as string).slice(0, 200) : null);
  const result = await client.query<{ sequence: string }>(
    `INSERT INTO learning_events (id,workspace_id,enrollment_id,actor_id,actor_kind,event_type,payload,correlation_id,idempotency_key,
       platform,app_version,client_sequence,occurred_at,course_digest,activity_instance_id,attempt_id,payload_ref,causation_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
       (SELECT c.digest FROM enrollments e JOIN course_releases c ON c.id=e.course_release_id WHERE e.id=$3),
       COALESCE($14,(SELECT c.id::text FROM assessment_challenges c WHERE c.attempt_id=$15::uuid AND c.enrollment_id=$3)),$15,$16,$17) RETURNING sequence`,
    [id, input.workspaceId, input.enrollmentId ?? null, input.actorId ?? null, input.actorKind, input.type,
      JSON.stringify(input.payload), input.correlationId ?? randomUUID(), input.idempotencyKey,
      client_.platform ?? null, client_.appVersion ?? null, client_.clientSequence ?? null, client_.occurredAt ?? null,
      instance, attemptId, input.payloadRef ?? null, input.causationId ?? null]);
  if (input.supervise && input.enrollmentId) {
    await client.query('INSERT INTO outbox (event_id,kind,payload) VALUES ($1,$2,$3)',
      [id, 'supervisor.event', JSON.stringify({ eventId: id, enrollmentId: input.enrollmentId })]);
  }
  return { id, cursor: result.rows[0]!.sequence };
}
