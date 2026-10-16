import type { PoolClient } from 'pg';
import type { Database } from './database.js';

type Sql = Database | PoolClient;

/**
 * Workspace audit log over learning_events. Every event is listed with who acted (by kind),
 * when, its type and the enrollment it concerns, so support can follow what happened. Payloads
 * follow the learner-privacy rule (learner-privacy.ts): only events written by staff or the
 * system whose type is in this allowlist show a payload, through the projection below. Learner
 * and agent events, and any type not listed, report `payload: null` with `payloadWithheld:true`.
 * Learner-written text never reaches this view: listed payloads hold identifiers, states,
 * digests, policy changes and staff decisions, and fields that may describe a learner's
 * circumstances (an accommodation's free-text reason) are dropped.
 */
const keep = (payload: Record<string, unknown>) => payload;
const without = (...keys: string[]) => (payload: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(payload).filter(([key]) => !keys.includes(key)));
export const AUDIT_PAYLOAD_PROJECTIONS: Readonly<Record<string, (payload: Record<string, unknown>) => Record<string, unknown>>> = {
  'course.imported': keep,
  'course.published': keep,
  'adaptation.registry_approved': keep,
  'extension.proposed': keep,
  'policy.migration_authorized': keep,
  'policy.accommodation_authorized': without('reason'),
  'gate.review_decided': keep,
  'assessment.reviewed': keep,
  'assessment.appeal_decided': keep,
  'learner.viewed_by_staff': keep,
  'data.exported': keep,
  'data.erased': keep,
  'enrollment.closed': keep,
  'enrollment.closed_record_amended': keep,
  'supervision.permission_changed': keep,
  // Ids, the refused event's type and the conflict code only.
  'supervisor.event_refused': keep,
  'people.invited': keep,
  'people.role_changed': keep,
  'people.sign_in_issued': keep,
  'people.password_reset': keep,
  'people.revoked': keep,
  'people.course_grant_created': keep,
  'people.course_grant_revoked': keep,
  'admin_section.settings_changed': keep,
  'run.payload_revealed': keep,
  'run.replayed': keep,
};
const STAFF_KINDS = new Set(['staff', 'system']);

export interface AuditRow {
  sequence: string; id: string; at: string; actorKind: 'learner' | 'staff' | 'agent' | 'system';
  /** Display name of the staff member who acted; null for learners, agents and the system. */
  actor: string | null; type: string; enrollmentId: string | null;
  payload: Record<string, unknown> | null; payloadWithheld: boolean;
}
export function auditPayload(actorKind: string, type: string, payload: unknown) {
  const project = AUDIT_PAYLOAD_PROJECTIONS[type];
  if (!STAFF_KINDS.has(actorKind) || !project || !payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  return project(payload as Record<string, unknown>);
}

export async function workspaceAudit(client: Sql, workspaceId: string, query: { before?: string | undefined; limit: number; actorKind?: string | undefined; type?: string | undefined }) {
  const rows = (await client.query<{ sequence: string; id: string; created_at: Date; actor_kind: AuditRow['actorKind']; actor_name: string | null; event_type: string; enrollment_id: string | null; payload: unknown }>(
    `SELECT l.sequence::text,l.id,l.created_at,l.actor_kind,CASE WHEN l.actor_kind='staff' THEN u.display_name END AS actor_name,l.event_type,l.enrollment_id,
        CASE WHEN l.actor_kind IN ('staff','system') AND l.event_type = ANY($5::text[]) THEN l.payload END AS payload
       FROM learning_events l LEFT JOIN app_users u ON u.id=l.actor_id
      WHERE l.workspace_id=$1 AND ($2::bigint IS NULL OR l.sequence < $2::bigint) AND ($3::text IS NULL OR l.actor_kind=$3) AND ($4::text IS NULL OR l.event_type=$4)
      ORDER BY l.sequence DESC LIMIT $6`,
    [workspaceId, query.before ?? null, query.actorKind ?? null, query.type ?? null, Object.keys(AUDIT_PAYLOAD_PROJECTIONS), query.limit])).rows;
  const events: AuditRow[] = rows.map(row => {
    const payload = auditPayload(row.actor_kind, row.event_type, row.payload);
    return { sequence: row.sequence, id: row.id, at: row.created_at.toISOString(), actorKind: row.actor_kind, actor: row.actor_name, type: row.event_type,
      enrollmentId: row.enrollment_id, payload, payloadWithheld: payload === null };
  });
  return { events, nextBefore: events.length === query.limit ? events.at(-1)!.sequence : null };
}
