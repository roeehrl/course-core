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
  // AI supervision settings: autonomy level and permitted tool families, before and after.
  'supervision.settings_changed': keep,
  // A learner's daily and per-lesson AI spending limits (amounts only).
  'supervision.budget_changed': keep,
  // A staff decision on a change the supervisor may not make itself (codes and identifiers).
  'supervisor.authority_decided': keep,
  'course.published': keep,
  // Package digest, course key/version, source kind (and public GitHub repository/tag), problem codes.
  'course_package.inspected': keep,
  'course_package.installed': keep,
  // Update source (GitHub URL or directory id + relative subpath), settings and check outcomes.
  'course_update.source_changed': keep,
  'course_update.settings_changed': keep,
  'course_update.checked': keep,
  // Moves of learners to a newer course version: ids, versions, codes, counts and the staff reason.
  'course_version.move_confirmed': keep,
  'course_version.moved': keep,
  'course_version.move_undone': keep,
  'course_version.move_cancelled': keep,
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
  'adaptation.transfer_check_amended': keep,
  'supervision.permission_changed': keep,
  // Ids, the refused event's type and the conflict code only.
  'supervisor.event_refused': keep,
  // Ids, the released event's type and the quarantine it replaced; the staff reason stays in
  // supervisor_event_requeues.
  'supervisor.event_requeued': keep,
  // Ids, codes and outcomes only; the staff reasons stay in supervisor_job_retries and attempt_regrades.
  'supervisor.run_retry_requested': keep,
  'assessment.regraded': keep,
  'people.invited': keep,
  'people.role_changed': keep,
  'people.sign_in_issued': keep,
  'people.password_reset': keep,
  'people.revoked': keep,
  'people.course_grant_created': keep,
  'people.course_grant_revoked': keep,
  'admin_section.settings_changed': keep,
  // The new and previous workspace default locale codes only.
  'workspace.locale_changed': keep,
  'run.payload_revealed': keep,
  'run.replayed': keep,
  'run.payload_reveal_audited': keep,
  // Study definitions (arm ids/behaviours, item ids, seed digest), state changes and exports
  // (format, row count, digest). Learner consent events are learner events and stay withheld.
  'study.created': keep,
  'study.updated': keep,
  'study.opened': keep,
  'study.closed': keep,
  'study.exported': keep,
  // A typed provider key was tested before saving: the installed kind, the outcome code and
  // the model count. The key itself is never recorded.
  'provider.key_tested': keep,
  // AI services changes: connection ids, kinds, outcomes and decisions. Never a key or key ending.
  'provider.connection.added': keep,
  'provider.connection.key_replaced': keep,
  'provider.connection.removed': keep,
  'provider.service_key.changed': keep,
  'provider.setup.activated': keep,
  // A quality check run from the AI services page: check id, jobs, counts, money and outcome codes.
  'provider.quality_check.started': keep,
  'provider.quality_check.finished': keep,
  // Staff cancelled one run: ids, role and previous state; the staff reason stays in supervisor_run_cancellations.
  'supervisor.run_cancel_requested': keep,
  // Course policy and placement settings: the settings and the staff reason for the change.
  'policy.settings_changed': keep,
  'placement.settings_changed': keep,
  'release.archived': keep,
  'release.rolled_back': keep,
  // A provider-billed figure typed in for cost reconciliation: label, period and amount.
  'provider.billed_statement_recorded': keep,
  // An audit export: format, range, row count and file digest.
  'audit.exported': keep,
  // A host inventory download: Core and SDK versions, extension count and file digest.
  'host_inventory.exported': keep,
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

/** Audit rows in a time range, oldest first, with the same projection as the page. */
export async function auditExportRows(client: Sql, workspaceId: string, query: { from: Date; to: Date; actorKind?: string | undefined; limit: number }) {
  const rows = (await client.query<{ sequence: string; id: string; created_at: Date; actor_kind: AuditRow['actorKind']; actor_name: string | null; event_type: string; enrollment_id: string | null; payload: unknown }>(
    `SELECT l.sequence::text,l.id,l.created_at,l.actor_kind,CASE WHEN l.actor_kind='staff' THEN u.display_name END AS actor_name,l.event_type,l.enrollment_id,
        CASE WHEN l.actor_kind IN ('staff','system') AND l.event_type = ANY($4::text[]) THEN l.payload END AS payload
       FROM learning_events l LEFT JOIN app_users u ON u.id=l.actor_id
      WHERE l.workspace_id=$1 AND l.created_at>=$2 AND l.created_at<$3 AND ($5::text IS NULL OR l.actor_kind=$5)
      ORDER BY l.sequence LIMIT $6`,
    [workspaceId, query.from, query.to, Object.keys(AUDIT_PAYLOAD_PROJECTIONS), query.actorKind ?? null, query.limit])).rows;
  return rows.map((row): AuditRow => {
    const payload = auditPayload(row.actor_kind, row.event_type, row.payload);
    return { sequence: row.sequence, id: row.id, at: row.created_at.toISOString(), actorKind: row.actor_kind, actor: row.actor_name, type: row.event_type,
      enrollmentId: row.enrollment_id, payload, payloadWithheld: payload === null };
  });
}
/** One CSV cell. Text that a spreadsheet would run as a formula is prefixed with a quote mark. */
function cell(value: unknown) {
  let text = value === null || value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
export const AUDIT_CSV_COLUMNS = ['sequence', 'id', 'at', 'actorKind', 'actor', 'type', 'enrollmentId', 'payloadWithheld', 'payload'] as const;
export function auditCsv(rows: readonly AuditRow[]) {
  return [AUDIT_CSV_COLUMNS.join(','), ...rows.map(row => AUDIT_CSV_COLUMNS.map(column => cell(row[column])).join(','))].join('\r\n') + '\r\n';
}
