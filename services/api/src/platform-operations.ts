import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { CourseManifest } from '@course-core/sdk';
import type { authService } from './auth.js';
import { permitCourse, workspaceRole } from './course-access.js';
import { transaction, type Database } from './database.js';
import { requireCondition } from './errors.js';
import { appendEvent } from './events.js';
import { digestJson } from './repository.js';
import { auditCsv, auditExportRows } from './workspace-audit.js';
import { catalogFor } from './admin-routes.js';
import { telemetry } from './telemetry.js';
import type { RuntimeExtension } from './publication.js';

type Sql = Database | PoolClient;
type Auth = ReturnType<typeof authService>;

/**
 * Platform operations for owners and administrators: the readiness page (Q11, T03 monitoring),
 * integrations (Q12), provider-billed figures for cost reconciliation (U04), the audit export and
 * the policy history (Q12). Every view reports states, counts, versions and stable codes; never a
 * host path, endpoint, credential, key ending or learner content.
 */

/** Recovery targets of the self-host pilot (deploy/local/README.md). */
export const RECOVERY_TARGETS = Object.freeze({
  /** Data loss on restore: time since the newest verified snapshot or backup. */
  rpoMinutes: 60,
  /** Restore on the same host, measured by the restore drill. */
  rtoMinutes: 60,
  /** A drill older than this no longer shows the backups restore. */
  drillMaxAgeDays: 7,
});
/** The supervisor worker and dispatcher reach the API every few seconds while they run. */
const BRIDGE_QUIET_WARNING_SECONDS = 120, BRIDGE_QUIET_FAILING_SECONDS = 600;

export type CheckStatus = 'ok' | 'warning' | 'failing' | 'not_configured' | 'no_data';
const SEVERITY: Record<CheckStatus, number> = { ok: 0, not_configured: 0, no_data: 1, warning: 2, failing: 3 };
const worst = (statuses: CheckStatus[]) => statuses.reduce<CheckStatus>((a, b) => (SEVERITY[b] > SEVERITY[a] ? b : a), 'ok');

let bridgeContactAt: number | null = null;
/** The supervisor bridge calls this on every authenticated request from the worker or dispatcher.
 * In-process only: each API instance reports what reached it since it started. */
export function noteBridgeContact(now = Date.now()) { bridgeContactAt = now; }

export interface PlatformOptions {
  installedExtensions: readonly RuntimeExtension[];
  /** The grading sandbox, when this host runs one. */
  sandbox?: { readiness(): Promise<{ ready: boolean; reason: string }> } | undefined;
  /** Whether a supervisor worker is configured to call this API (SUPERVISOR_HOST_TOKEN). */
  supervisorConfigured: boolean;
  migrationsDirectory?: string | undefined;
}

const code = (value: string) => (/^[a-z0-9_]{1,64}$/.test(value) ? value : 'other');
const minutesSince = (at: Date | null, now: Date) => (at ? Math.max(0, Math.round((now.getTime() - at.getTime()) / 60_000)) : null);

let versions: Promise<{ core: string | null; sdk: string | null }> | undefined;
/** Versions read once from the installed package manifests. */
function runtimeVersions() {
  versions ??= (async () => {
    const read = async (url: URL) => {
      try { const value = JSON.parse(await readFile(url, 'utf8')).version; return typeof value === 'string' && /^[0-9A-Za-z.+-]{1,40}$/.test(value) ? value : null; }
      catch { return null; }
    };
    const sdkEntry = new URL(import.meta.resolve('@course-core/sdk'));
    return { core: await read(new URL('../../../package.json', import.meta.url)), sdk: await read(new URL('../package.json', sdkEntry)) };
  })();
  return versions;
}

interface BackupRow { kind: 'snapshot' | 'backup' | 'restore_drill'; outcome: 'succeeded' | 'failed'; code: string | null; started_at: Date; finished_at: Date;
  encrypted: boolean; core_version: string | null; tables: number | null; rows: string | null; bytes: string | null }
async function backupStatus(client: Sql, now: Date) {
  const latest = async (kind: BackupRow['kind'], outcome?: BackupRow['outcome']) => (await client.query<BackupRow>(
    `SELECT kind,outcome,code,started_at,finished_at,encrypted,core_version,tables,rows::text,bytes::text FROM platform_backup_reports
      WHERE kind=$1 AND ($2::text IS NULL OR outcome=$2) ORDER BY finished_at DESC LIMIT 1`, [kind, outcome ?? null])).rows[0] ?? null;
  const view = (row: BackupRow | null) => row && { outcome: row.outcome, code: row.code, finishedAt: row.finished_at.toISOString(),
    durationSeconds: Math.round((row.finished_at.getTime() - row.started_at.getTime()) / 1000), encrypted: row.encrypted,
    coreVersion: row.core_version, tables: row.tables, rows: row.rows === null ? null : Number(row.rows), bytes: row.bytes === null ? null : Number(row.bytes) };
  const snapshot = await latest('snapshot', 'succeeded'), backup = await latest('backup', 'succeeded'), drill = await latest('restore_drill');
  const lastAttempts = [await latest('snapshot'), await latest('backup')].filter((r): r is BackupRow => Boolean(r));
  const newest = [snapshot, backup].filter((r): r is BackupRow => Boolean(r)).sort((a, b) => b.finished_at.getTime() - a.finished_at.getTime())[0] ?? null;
  const rpoMinutes = minutesSince(newest?.finished_at ?? null, now);
  const rpoStatus: CheckStatus = rpoMinutes === null ? 'no_data' : rpoMinutes <= RECOVERY_TARGETS.rpoMinutes ? 'ok' : rpoMinutes <= 2 * RECOVERY_TARGETS.rpoMinutes ? 'warning' : 'failing';
  const drillMinutes = drill?.outcome === 'succeeded' ? Math.ceil((drill.finished_at.getTime() - drill.started_at.getTime()) / 60_000) : null;
  const drillAgeDays = drill ? Math.floor((now.getTime() - drill.finished_at.getTime()) / 86_400_000) : null;
  const rtoStatus: CheckStatus = !drill ? 'no_data' : drill.outcome === 'failed' || drillMinutes! > RECOVERY_TARGETS.rtoMinutes ? 'failing'
    : drillAgeDays! > RECOVERY_TARGETS.drillMaxAgeDays ? 'warning' : 'ok';
  // T03 asks for encrypted backups: the newest copy says whether it was (age, deploy/local/README.md).
  const encryption = { latestEncrypted: newest ? newest.encrypted : null,
    status: (!newest ? 'no_data' : newest.encrypted ? 'ok' : 'warning') as CheckStatus };
  const lastFailure = lastAttempts.find(r => r.outcome === 'failed' && (!newest || r.finished_at > newest.finished_at)) ?? null;
  return {
    lastSnapshot: view(snapshot), lastBackup: view(backup), lastRestoreDrill: view(drill), lastFailure: view(lastFailure),
    rpo: { targetMinutes: RECOVERY_TARGETS.rpoMinutes, currentMinutes: rpoMinutes, status: rpoStatus },
    rto: { targetMinutes: RECOVERY_TARGETS.rtoMinutes, lastDrillMinutes: drillMinutes, drillAgeDays, drillMaxAgeDays: RECOVERY_TARGETS.drillMaxAgeDays, status: rtoStatus },
    encryption,
  };
}

/** Every readiness check, worst first in `overall`. */
export async function platformReadiness(db: Database, options: PlatformOptions, now = new Date()) {
  const started = performance.now();
  const database = (await db.query<{ version: number; migrations: number; latest: string | null }>(
    `SELECT current_setting('server_version_num')::int AS version,(SELECT count(*)::int FROM schema_migrations) AS migrations,
       (SELECT max(name) FROM schema_migrations) AS latest`)).rows[0]!;
  const latencyMs = Math.round(performance.now() - started);
  let expected: number | null = null, expectedLatest: string | null = null;
  if (options.migrationsDirectory) {
    try {
      const files = (await readdir(options.migrationsDirectory)).filter(name => /^\d{3}_[a-z0-9_]+\.sql$/.test(name)).sort();
      expected = files.length; expectedLatest = files.at(-1) ?? null;
    } catch { /* Reported as unknown. */ }
  }
  const migrationsCurrent = expected === null ? null : database.migrations === expected && database.latest === expectedLatest;
  const postgresMajor = Math.floor(database.version / 10_000);
  const databaseCheck = { id: 'database' as const, status: (postgresMajor < 17 || migrationsCurrent === false ? 'failing' : latencyMs > 500 ? 'warning' : 'ok') as CheckStatus,
    facts: { postgresMajor, latencyMs, migrationsApplied: database.migrations, migrationsExpected: expected, latestMigration: database.latest, migrationsCurrent } };

  const outbox = (await db.query<{ pending: number; oldest: number | null; quarantined: number }>(
    `SELECT count(*) FILTER (WHERE delivered_at IS NULL AND quarantined_at IS NULL)::int AS pending,
       extract(epoch FROM clock_timestamp()-min(available_at) FILTER (WHERE delivered_at IS NULL AND quarantined_at IS NULL))::int AS oldest,
       count(*) FILTER (WHERE quarantined_at IS NOT NULL AND delivered_at IS NULL)::int AS quarantined
     FROM outbox WHERE kind='supervisor.event'`)).rows[0]!;
  const quiet = bridgeContactAt === null ? null : Math.round((now.getTime() - bridgeContactAt) / 1000);
  const temporalStatus: CheckStatus = !options.supervisorConfigured ? 'not_configured'
    : quiet === null || quiet > BRIDGE_QUIET_FAILING_SECONDS ? 'failing' : quiet > BRIDGE_QUIET_WARNING_SECONDS || outbox.quarantined > 0 ? 'warning' : 'ok';
  const temporalCheck = { id: 'temporal' as const, status: temporalStatus,
    facts: { lastWorkerContactSeconds: quiet, pendingEvents: outbox.pending, oldestPendingSeconds: outbox.oldest, quarantinedEvents: outbox.quarantined } };

  let sandboxCheck: { id: 'sandbox'; status: CheckStatus; facts: { ready: boolean | null; reason: string | null } };
  if (!options.sandbox) sandboxCheck = { id: 'sandbox', status: 'not_configured', facts: { ready: null, reason: null } };
  else {
    const result = await options.sandbox.readiness().catch(() => ({ ready: false, reason: 'readiness_failed' }));
    sandboxCheck = { id: 'sandbox', status: result.ready ? 'ok' : 'failing', facts: { ready: result.ready, reason: result.ready ? null : code(result.reason) } };
  }

  const runtime = telemetry(), buffer = runtime.spanBuffer();
  const collectorCheck = { id: 'collector' as const,
    status: (!runtime.enabled ? 'not_configured' : buffer && (buffer.dropped.exportFailed > 0 || buffer.dropped.queueFull > 0) ? 'warning' : 'ok') as CheckStatus,
    facts: { enabled: runtime.enabled, tracing: runtime.tracing, queuedSpans: buffer?.queued ?? null, exportedSpans: buffer?.exported ?? null,
      droppedQueueFull: buffer?.dropped.queueFull ?? null, droppedExportFailed: buffer?.dropped.exportFailed ?? null } };

  const { core, sdk } = await runtimeVersions(), nodeMajor = Number(process.versions.node.split('.')[0]);
  const versionCheck = { id: 'version' as const, status: (nodeMajor !== 26 || postgresMajor < 17 ? 'warning' : 'ok') as CheckStatus,
    facts: { coreVersion: core, sdkVersion: sdk, nodeVersion: process.versions.node, nodeSupported: nodeMajor === 26, postgresMajor, postgresSupported: postgresMajor >= 17,
      courseSchemaVersion: 1, installedExtensions: options.installedExtensions.length } };

  const backups = await backupStatus(db, now);
  const backupCheck = { id: 'backups' as const, status: worst([backups.rpo.status, backups.rto.status, backups.encryption.status, backups.lastFailure ? 'warning' : 'ok']),
    facts: { lastSnapshot: backups.lastSnapshot, lastBackup: backups.lastBackup, lastRestoreDrill: backups.lastRestoreDrill, lastFailure: backups.lastFailure } };

  const checks = [databaseCheck, temporalCheck, sandboxCheck, collectorCheck, versionCheck, backupCheck];
  return { generatedAt: now.toISOString(), overall: worst(checks.map(c => c.status)), checks, targets: { rpo: backups.rpo, rto: backups.rto, encryption: backups.encryption } };
}

// ---------------------------------------------------------------- integrations

/** Installed runtime pieces and what each course's live release needs from them. */
export async function integrationsView(client: Sql, workspaceId: string, options: PlatformOptions) {
  const installed = options.installedExtensions.flatMap(e => [{ id: e.id, version: e.version, integrity: e.integrity, prior: false },
    ...(e.acceptedPriorBuilds ?? []).map(p => ({ id: e.id, version: p.version, integrity: p.integrity, prior: true }))]);
  const courses = (await client.query<{ id: string; course_key: string; title: string; version: string | null; digest: string | null; manifest: CourseManifest | null }>(
    `SELECT c.id,c.course_key,c.title,r.version,r.digest,r.server_bundle AS manifest FROM admin_course_catalog c
       LEFT JOIN course_releases r ON r.id=c.active_release_id WHERE c.workspace_id=$1 ORDER BY c.title,c.id LIMIT 100`, [workspaceId])).rows
    .map(row => ({ catalogId: row.id, courseKey: row.course_key, title: row.title, liveVersion: row.version, liveDigest: row.digest,
      extensions: (row.manifest?.extensions ?? []).slice(0, 50).map(ext => {
        const exact = installed.find(i => i.id === ext.id && i.version === ext.version && i.integrity === ext.integrity);
        const status = exact ? 'compatible' : installed.some(i => i.id === ext.id) ? 'version_mismatch' : ext.execution === 'declarative' ? 'built_in' : 'missing';
        return { id: ext.id, version: ext.version, execution: ext.execution, status, servedByPriorBuild: exact?.prior ?? false };
      }) }));
  const events = async (type: string, limit: number) => (await client.query<{ id: string; created_at: Date; payload: Record<string, unknown> }>(
    'SELECT id,created_at,payload FROM learning_events WHERE workspace_id=$1 AND event_type=$2 ORDER BY sequence DESC LIMIT $3', [workspaceId, type, limit])).rows;
  const pick = (payload: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.map(k => [k, typeof payload[k] === 'string' || typeof payload[k] === 'boolean' ? payload[k] : null]));
  const receipts = (await events('course_package.installed', 20)).map(row => ({ id: row.id, at: row.created_at.toISOString(),
    ...pick(row.payload, ['courseKey', 'version', 'courseDigest', 'packageSha256', 'sourceKind', 'repository', 'tag', 'published']) }));
  const updateChecks = (await events('course_update.checked', 20)).map(row => ({ id: row.id, at: row.created_at.toISOString(),
    ...pick(row.payload, ['courseKey', 'trigger', 'result', 'errorCode', 'version', 'sourceKind']) }));
  const providers = (await client.query<{ adapter_id: string; name: string; key_status: string; tested_at: Date | null }>(
    'SELECT adapter_id,name,key_status,tested_at FROM workspace_provider_connections WHERE workspace_id=$1 ORDER BY adapter_id LIMIT 50', [workspaceId])).rows
    .map(row => ({ adapterId: row.adapter_id, name: row.name, keyStatus: row.key_status, testedAt: row.tested_at?.toISOString() ?? null }));
  const { core, sdk } = await runtimeVersions(), runtime = telemetry();
  return {
    runtime: { coreVersion: core, sdkVersion: sdk, courseSchemaVersion: 1 },
    extensions: options.installedExtensions.map(e => ({ id: e.id, version: e.version, integrity: e.integrity, capabilities: e.capabilities.slice(0, 50),
      platforms: e.platforms, codeReady: e.codeReady ?? null, priorBuilds: (e.acceptedPriorBuilds ?? []).length })),
    courses, packageReceipts: receipts, updateChecks, providers,
    telemetry: { export: runtime.enabled ? 'on' as const : 'off' as const, tracing: runtime.tracing },
  };
}

// ---------------------------------------------------------------- billed vs estimated cost

const billedInput = z.strictObject({
  idempotencyKey: z.string().regex(/^[A-Za-z0-9:_-]{8,200}$/),
  providerLabel: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/),
  periodStart: z.iso.date(), periodEnd: z.iso.date(),
  billedMicroUsd: z.number().int().min(0).max(1_000_000_000_000),
  sourceNote: z.string().trim().min(3).max(300),
});
/** Each billed figure next to the application's estimate for the same days (UTC). */
export async function billingStatements(client: Sql, workspaceId: string) {
  const rows = (await client.query<{ id: string; provider_label: string; period_start: string; period_end: string; billed: string; source_note: string;
    recorded_by: string; created_at: Date; charged: string; actual: string; calls: number; held: string }>(
    `SELECT s.id,s.provider_label,s.period_start::text,s.period_end::text,s.billed_micro_usd::text AS billed,s.source_note,u.display_name AS recorded_by,s.created_at,
        COALESCE(sum(l.charged_micro_usd),0)::text AS charged,COALESCE(sum(l.actual_micro_usd),0)::text AS actual,count(l.*)::int AS calls,
        COALESCE(sum(l.charged_micro_usd) FILTER (WHERE l.state IN ('reserved','uncertain') AND l.settled_at IS NULL),0)::text AS held
       FROM provider_billed_statements s JOIN app_users u ON u.id=s.recorded_by
       LEFT JOIN provider_spend_ledger l ON l.workspace_id=s.workspace_id AND l.reserved_at>=s.period_start::timestamp AT TIME ZONE 'UTC'
         AND l.reserved_at<(s.period_end+1)::timestamp AT TIME ZONE 'UTC'
      WHERE s.workspace_id=$1 GROUP BY s.id,u.display_name ORDER BY s.period_start DESC,s.created_at DESC LIMIT 50`, [workspaceId])).rows;
  return {
    currency: 'USD' as const, timeZone: 'UTC' as const,
    statements: rows.map(row => {
      const billed = Number(row.billed), estimated = Number(row.charged);
      return { id: row.id, providerLabel: row.provider_label, periodStart: row.period_start, periodEnd: row.period_end, billedMicroUsd: billed,
        sourceNote: row.source_note, recordedBy: row.recorded_by, recordedAt: row.created_at.toISOString(),
        estimate: { chargedMicroUsd: estimated, reportedMicroUsd: Number(row.actual), calls: row.calls, unsettledMicroUsd: Number(row.held) },
        differenceMicroUsd: billed - estimated };
    }),
    /** Estimates are the operator rate card applied to reported usage; only a statement is a provider figure. */
    estimatesAreEstimates: true as const,
  };
}

// ---------------------------------------------------------------- policy history

type Change = { path: string; before: string | null; after: string | null };
const MAX_VALUE = 200;
function leaves(value: unknown, prefix = '', out = new Map<string, string>()) {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) leaves(child, prefix ? `${prefix}.${key}` : key, out);
  } else if (prefix) out.set(prefix, JSON.stringify(value).slice(0, MAX_VALUE));
  return out;
}
/** Field-by-field differences between two policy objects (leaf paths, values as JSON text). */
export function policyChanges(before: unknown, after: unknown): Change[] {
  const a = leaves(before ?? {}), b = leaves(after ?? {});
  return [...new Set([...a.keys(), ...b.keys()])].sort().filter(path => a.get(path) !== b.get(path)).slice(0, 100)
    .map(path => ({ path, before: a.get(path) ?? null, after: b.get(path) ?? null }));
}
/**
 * Policy changes of one course, newest first. `entries` is the field-by-field timeline: course
 * policy settings, placement settings, the organization ceilings above the course (migration
 * 094) and the learning policy each published release carried, each as a diff from the one
 * before. `revisions` is the stored revision list of the course settings and organization
 * ceilings (level, revision, saved settings, reason and who saved it).
 */
export async function policyHistory(client: Sql, catalog: { id: string; workspace_id: string; course_key: string }) {
  const settings = (await client.query<{ id: string; event_type: string; created_at: Date; actor: string | null; payload: Record<string, unknown> }>(
    `SELECT l.id,l.event_type,l.created_at,u.display_name AS actor,l.payload FROM learning_events l LEFT JOIN app_users u ON u.id=l.actor_id
      WHERE l.workspace_id=$1 AND l.event_type IN ('policy.settings_changed','placement.settings_changed')
        AND (l.payload->>'courseId'=$2 OR l.payload->>'catalogId'=$2) ORDER BY l.sequence LIMIT 200`, [catalog.workspace_id, catalog.id])).rows;
  const entries: { source: 'course_settings' | 'placement_settings' | 'organization_ceilings' | 'release_policy'; id: string; at: string; actor: string | null;
    revision: number | null; version: string | null; reason: string | null; changes: Change[] }[] = [];
  const previous: Record<string, unknown> = {};
  for (const row of settings) {
    const source = row.event_type === 'policy.settings_changed' ? 'course_settings' as const : 'placement_settings' as const;
    const value = source === 'course_settings' ? row.payload.settings : Object.fromEntries(Object.entries(row.payload).filter(([k]) => !['catalogId', 'revision', 'updatedAt', 'updatedBy'].includes(k)));
    entries.push({ source, id: row.id, at: row.created_at.toISOString(), actor: row.actor, revision: typeof row.payload.revision === 'number' ? row.payload.revision : null,
      version: null, reason: typeof row.payload.reason === 'string' ? row.payload.reason.slice(0, 500) : null, changes: policyChanges(previous[source], value) });
    previous[source] = value;
  }
  const stored = (await client.query<{ id: string; level: string; revision: number; settings: unknown; reason: string | null; changed_by: string | null; display_name: string | null; changed_at: Date }>(
    `SELECT h.id,h.level,h.revision,h.settings,h.reason,h.changed_by,u.display_name,h.changed_at FROM policy_setting_revisions h LEFT JOIN app_users u ON u.id=h.changed_by
     WHERE h.workspace_id=$1 AND (h.catalog_id=$2 OR h.level='organization') ORDER BY h.changed_at DESC,h.id DESC LIMIT 100`, [catalog.workspace_id, catalog.id])).rows;
  // Course settings already appear above from their events; the ceilings above the course only live here.
  const ceilings = stored.filter(r => r.level === 'organization').reverse();
  ceilings.forEach((row, i) => entries.push({ source: 'organization_ceilings', id: `organization-${row.id}`, at: row.changed_at.toISOString(), actor: row.display_name,
    revision: row.revision, version: null, reason: row.reason?.slice(0, 500) ?? null, changes: policyChanges(ceilings[i - 1]?.settings, row.settings) }));
  const releases = (await client.query<{ id: string; version: string; created_at: Date; author: string | null; policy: unknown; placement: unknown }>(
    `SELECT r.id,r.version,r.created_at,u.display_name AS author,r.server_bundle->'policy' AS policy,r.server_bundle->'placement' AS placement
       FROM course_releases r LEFT JOIN app_users u ON u.id=r.created_by
      WHERE r.workspace_id=$1 AND r.course_key=$2 AND r.status IN ('published','archived') ORDER BY r.created_at LIMIT 100`, [catalog.workspace_id, catalog.course_key])).rows;
  let last: unknown;
  for (const release of releases) {
    const value = { policy: release.policy, placement: release.placement ?? null };
    const changes = policyChanges(last, value);
    if (last === undefined || changes.length)
      entries.push({ source: 'release_policy', id: release.id, at: release.created_at.toISOString(), actor: release.author, revision: null, version: release.version, reason: null, changes });
    last = value;
  }
  return { courseId: catalog.id, entries: entries.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 100),
    revisions: stored.map(r => ({ level: r.level, revision: r.revision, settings: r.settings, reason: r.reason,
      changedBy: r.changed_by ? { id: r.changed_by, displayName: r.display_name } : null, changedAt: r.changed_at.toISOString() })) };
}

// ---------------------------------------------------------------- routes

const params = (request: FastifyRequest) => request.params as Record<string, string>;
const workspaceParams = z.strictObject({ workspaceId: z.uuid() });
function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value);
  requireCondition(parsed.success, 'INVALID_REQUEST');
  return parsed.data;
}
const OWNERS = ['owner', 'admin'] as const;
/** Audit exports cover at most a year and this many events per file. */
export const AUDIT_EXPORT_MAX_ROWS = 10_000;
const exportQuery = z.strictObject({
  format: z.enum(['csv', 'json']),
  from: z.iso.date(), to: z.iso.date(),
  actorKind: z.enum(['learner', 'staff', 'agent', 'system']).optional(),
});

export function registerPlatformOperationRoutes(app: FastifyInstance, db: Database, auth: Auth, options: PlatformOptions) {
  const base = '/api/admin/workspaces/:workspaceId';
  app.get(`${base}/platform-readiness`, async (request, reply) => {
    const actor = await auth.authenticate(request), { workspaceId } = parse(workspaceParams, request.params);
    await workspaceRole(db, actor, workspaceId, OWNERS);
    reply.header('Cache-Control', 'no-store');
    return platformReadiness(db, options);
  });
  app.get(`${base}/integrations`, async (request) => {
    const actor = await auth.authenticate(request), { workspaceId } = parse(workspaceParams, request.params);
    return transaction(db, async (client) => {
      await workspaceRole(client, actor, workspaceId, OWNERS);
      return integrationsView(client, workspaceId, options);
    });
  });
  app.get(`${base}/billing-statements`, async (request) => {
    const actor = await auth.authenticate(request), { workspaceId } = parse(workspaceParams, request.params);
    return transaction(db, async (client) => {
      await workspaceRole(client, actor, workspaceId, OWNERS);
      return billingStatements(client, workspaceId);
    });
  });
  app.post(`${base}/billing-statements`, { bodyLimit: 4096 }, async (request) => {
    const actor = await auth.authenticate(request), { workspaceId } = parse(workspaceParams, request.params), input = parse(billedInput, request.body);
    requireCondition(input.periodEnd >= input.periodStart && Date.parse(input.periodEnd) - Date.parse(input.periodStart) <= 92 * 86_400_000, 'BILLING_PERIOD_INVALID');
    return transaction(db, async (client) => {
      await workspaceRole(client, actor, workspaceId, OWNERS);
      const { idempotencyKey, ...semantic } = input;
      const old = (await client.query<{ id: string; provider_label: string; period_start: string; period_end: string; billed_micro_usd: string; source_note: string }>(
        `SELECT id,provider_label,period_start::text,period_end::text,billed_micro_usd::text,source_note FROM provider_billed_statements WHERE workspace_id=$1 AND idempotency_key=$2`,
        [workspaceId, idempotencyKey])).rows[0];
      if (old) {
        requireCondition(digestJson({ providerLabel: old.provider_label, periodStart: old.period_start, periodEnd: old.period_end, billedMicroUsd: Number(old.billed_micro_usd),
          sourceNote: old.source_note }) === digestJson(semantic), 'IDEMPOTENCY_CONFLICT', 409);
        return { id: old.id, replayed: true, ...(await billingStatements(client, workspaceId)) };
      }
      const id = randomUUID();
      await client.query(`INSERT INTO provider_billed_statements(id,workspace_id,provider_label,period_start,period_end,billed_micro_usd,source_note,recorded_by,idempotency_key)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id, workspaceId, input.providerLabel, input.periodStart, input.periodEnd, input.billedMicroUsd, input.sourceNote, actor.id, idempotencyKey]);
      await appendEvent(client, { workspaceId, actorId: actor.id, actorKind: 'staff', type: 'provider.billed_statement_recorded',
        payload: { statementId: id, providerLabel: input.providerLabel, periodStart: input.periodStart, periodEnd: input.periodEnd, billedMicroUsd: input.billedMicroUsd },
        idempotencyKey: `billed-statement:${id}` });
      return { id, replayed: false, ...(await billingStatements(client, workspaceId)) };
    });
  });
  /** The audit log as a file, with the same privacy projection as the page. The download itself is
   * recorded in the log (format, range, row count and file digest). */
  app.get(`${base}/audit/export`, async (request, reply) => {
    const actor = await auth.authenticate(request), { workspaceId } = parse(workspaceParams, request.params), query = parse(exportQuery, request.query ?? {});
    const from = new Date(`${query.from}T00:00:00Z`), to = new Date(Date.parse(`${query.to}T00:00:00Z`) + 86_400_000);
    requireCondition(from < to && to.getTime() - from.getTime() <= 367 * 86_400_000, 'AUDIT_EXPORT_RANGE_INVALID');
    const file = await transaction(db, async (client) => {
      await permitCourse(client, actor, workspaceId, null, 'audit.export');
      const rows = await auditExportRows(client, workspaceId, { from, to, actorKind: query.actorKind, limit: AUDIT_EXPORT_MAX_ROWS + 1 });
      const truncated = rows.length > AUDIT_EXPORT_MAX_ROWS, events = rows.slice(0, AUDIT_EXPORT_MAX_ROWS);
      const body = query.format === 'csv' ? auditCsv(events)
        : JSON.stringify({ kind: 'course-core-audit-export', workspaceId, from: query.from, to: query.to, actorKind: query.actorKind ?? null, truncated, events }, null, 2) + '\n';
      const digest = digestJson(body);
      await appendEvent(client, { workspaceId, actorId: actor.id, actorKind: 'staff', type: 'audit.exported',
        payload: { format: query.format, from: query.from, to: query.to, actorKind: query.actorKind ?? null, rows: events.length, truncated, digest },
        idempotencyKey: `audit-export:${randomUUID()}` });
      return { body, digest, truncated, rows: events.length };
    });
    reply.header('Cache-Control', 'no-store');
    reply.header('Content-Type', query.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="audit-${query.from}-to-${query.to}.${query.format}"`);
    reply.header('X-Export-Digest', file.digest);
    reply.header('X-Export-Rows', String(file.rows));
    reply.header('X-Export-Truncated', String(file.truncated));
    return reply.send(file.body);
  });
  app.get('/api/admin/courses/:courseId/policy-history', async (request) => {
    const actor = await auth.authenticate(request);
    return transaction(db, async (client) => {
      const { catalog } = await catalogFor(client, actor, params(request).courseId!, 'policy.read');
      return policyHistory(client, catalog);
    });
  });
}
