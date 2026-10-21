/**
 * Portable learning-event export (requirement K14): one enrollment's learning events in the SDK
 * 0.6.0 `learningEventExport` record format (exportFormat 1). SDK 0.6.0 is not released, so the
 * schema is vendored in src/vendor/sdk-event-export and the tests validate every export against it.
 *
 * - Identity is stable: event IDs are the event's own UUID, sequences are Core's durable event
 *   sequence as decimal strings, the course is its ID, semantic version and compiled digest, and
 *   the enrollment reference is the enrollment's opaque ID.
 * - Paged by cursor: `after` is exclusive, `through` is the last sequence in this page (or `after`
 *   when the page is empty). A page holds at most MAX_PAGE events; the next page starts at `through`.
 * - Privacy follows the shared rule (learner-privacy.ts eventPayloadFor): the learner receives every
 *   payload of their own record; an owner/admin copy receives only allowlisted staff/system
 *   payloads, and a withheld payload is exported as `{"withheld":"event-payloads"}`.
 */
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { requireCondition } from './errors.js';
import { eventPayloadFor, STAFF_EVENT_PAYLOAD_RULE, type LearnerDataAudience } from './learner-privacy.js';

export const EVENT_EXPORT_FORMAT = 1;
export const DEFAULT_PAGE = 1000;
export const MAX_PAGE = 5000;
const SEQUENCE = /^(0|[1-9][0-9]{0,18})$/;
const EVENT_TYPE = /^[a-z][a-z0-9_.:-]{0,127}$/;
const WITHHELD = { withheld: STAFF_EVENT_PAYLOAD_RULE.id };

export const eventExportQuery = z.strictObject({
  after: z.string().regex(SEQUENCE).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE).optional(),
});

export interface ExportedEvent {
  eventId: string; sequence: string; type: string; actorKind: 'learner' | 'staff' | 'agent' | 'system';
  occurredAt: string; payload: Record<string, unknown>; traceId: string | null;
}
export interface LearningEventExport {
  exportFormat: 1;
  course: { id: string; version: string; digest: string };
  enrollmentRef: string;
  exportedAt: string;
  cursor: { after: string; through: string };
  events: ExportedEvent[];
}

/** One page of the enrollment's events after `after`, for `audience`. Read-only. */
export async function exportLearningEvents(client: PoolClient, enrollmentId: string, audience: LearnerDataAudience,
  page: { after?: string | undefined; limit?: number | undefined } = {}, now = new Date()): Promise<{ document: LearningEventExport; hasMore: boolean }> {
  const after = page.after ?? '0', limit = Math.min(page.limit ?? DEFAULT_PAGE, MAX_PAGE);
  const course = (await client.query<{ course_key: string; version: string; digest: string }>(
    'SELECT r.course_key,r.version,r.digest FROM enrollments e JOIN course_releases r ON r.id=e.course_release_id WHERE e.id=$1', [enrollmentId])).rows[0];
  requireCondition(course, 'ENROLLMENT_NOT_FOUND', 404);
  const rows = (await client.query<{ id: string; sequence: string; event_type: string; actor_kind: ExportedEvent['actorKind']; payload: unknown;
    occurred_at: Date; trace_id: string | null }>(
    `SELECT id,sequence::text AS sequence,event_type,actor_kind,payload,COALESCE(occurred_at,received_at,created_at) AS occurred_at,trace_id
       FROM learning_events WHERE enrollment_id=$1 AND sequence > $2::bigint ORDER BY sequence LIMIT $3`, [enrollmentId, after, limit + 1])).rows;
  const hasMore = rows.length > limit;
  const events = rows.slice(0, limit).map((row): ExportedEvent => {
    const { payload } = eventPayloadFor(audience, row.actor_kind, row.event_type, row.payload);
    return {
      eventId: row.id, sequence: row.sequence,
      // Core's event types already follow the SDK pattern; anything else is normalized, never dropped.
      type: EVENT_TYPE.test(row.event_type) ? row.event_type : `core.${row.event_type.toLowerCase().replace(/[^a-z0-9_.:-]/g, '_')}`.slice(0, 128),
      actorKind: row.actor_kind, occurredAt: row.occurred_at.toISOString(),
      payload: payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : WITHHELD,
      traceId: row.trace_id,
    };
  });
  const document: LearningEventExport = {
    exportFormat: EVENT_EXPORT_FORMAT,
    course: { id: course.course_key, version: course.version, digest: course.digest },
    enrollmentRef: enrollmentId,
    exportedAt: now.toISOString(),
    cursor: { after, through: events.at(-1)?.sequence ?? after },
    events,
  };
  // Plain JSON only, so the file and its recorded digest match.
  return { document: JSON.parse(JSON.stringify(document)) as LearningEventExport, hasMore };
}
