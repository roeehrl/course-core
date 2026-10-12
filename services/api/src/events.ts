import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

export async function appendEvent(client: PoolClient, input: {
  workspaceId: string; enrollmentId?: string; actorId?: string;
  actorKind: 'learner' | 'staff' | 'agent' | 'system'; type: string;
  payload: unknown; idempotencyKey: string; correlationId?: string; supervise?: boolean;
}) {
  const id = randomUUID();
  const result = await client.query<{ sequence: string }>(
    `INSERT INTO learning_events (id,workspace_id,enrollment_id,actor_id,actor_kind,event_type,payload,correlation_id,idempotency_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING sequence`,
    [id, input.workspaceId, input.enrollmentId ?? null, input.actorId ?? null, input.actorKind, input.type,
      JSON.stringify(input.payload), input.correlationId ?? randomUUID(), input.idempotencyKey]);
  if (input.supervise && input.enrollmentId) {
    await client.query('INSERT INTO outbox (event_id,kind,payload) VALUES ($1,$2,$3)',
      [id, 'supervisor.event', JSON.stringify({ eventId: id, enrollmentId: input.enrollmentId })]);
  }
  return { id, cursor: result.rows[0]!.sequence };
}
