import { z } from "zod";
import { englishTranslator, type MessageKey, type Translate } from "../i18n";

/**
 * Workspace operations for owners and administrators: platform readiness with the recovery
 * targets, integrations, provider-billed figures next to the estimates, the audit export and a
 * course's policy history. Servers report states, counts, versions and codes only.
 */
const count = z.number().int().nonnegative();
const optionalCount = count.nullable();
const version = z.string().max(40).nullable();
export const CHECK_STATUSES = [
  "ok",
  "warning",
  "failing",
  "not_configured",
  "no_data",
] as const;
const status = z.enum(CHECK_STATUSES);
export type CheckStatus = (typeof CHECK_STATUSES)[number];
const backupRun = z
  .object({
    outcome: z.enum(["succeeded", "failed"]),
    code: z.string().max(64).nullable(),
    finishedAt: z.string(),
    durationSeconds: count,
    encrypted: z.boolean(),
    coreVersion: version,
    tables: optionalCount,
    rows: optionalCount,
    bytes: optionalCount,
  })
  .nullable();
export const readinessSchema = z.object({
  generatedAt: z.string(),
  overall: status,
  checks: z.tuple([
    z.object({
      id: z.literal("database"),
      status,
      facts: z.object({
        postgresMajor: count,
        latencyMs: count,
        migrationsApplied: count,
        migrationsExpected: optionalCount,
        latestMigration: z.string().max(200).nullable(),
        migrationsCurrent: z.boolean().nullable(),
      }),
    }),
    z.object({
      id: z.literal("temporal"),
      status,
      facts: z.object({
        lastWorkerContactSeconds: optionalCount,
        pendingEvents: count,
        oldestPendingSeconds: z.number().int().nullable(),
        quarantinedEvents: count,
      }),
    }),
    z.object({
      id: z.literal("sandbox"),
      status,
      facts: z.object({
        ready: z.boolean().nullable(),
        reason: z.string().max(64).nullable(),
      }),
    }),
    z.object({
      id: z.literal("collector"),
      status,
      facts: z.object({
        enabled: z.boolean(),
        tracing: z.boolean(),
        queuedSpans: optionalCount,
        exportedSpans: optionalCount,
        droppedQueueFull: optionalCount,
        droppedExportFailed: optionalCount,
      }),
    }),
    z.object({
      id: z.literal("version"),
      status,
      facts: z.object({
        coreVersion: version,
        sdkVersion: version,
        nodeVersion: z.string().max(40),
        nodeSupported: z.boolean(),
        postgresMajor: count,
        postgresSupported: z.boolean(),
        courseSchemaVersion: count,
        installedExtensions: count,
      }),
    }),
    z.object({
      id: z.literal("backups"),
      status,
      facts: z.object({
        lastSnapshot: backupRun,
        lastBackup: backupRun,
        lastRestoreDrill: backupRun,
        lastFailure: backupRun,
      }),
    }),
  ]),
  targets: z.object({
    rpo: z.object({
      targetMinutes: count,
      currentMinutes: optionalCount,
      status,
    }),
    rto: z.object({
      targetMinutes: count,
      lastDrillMinutes: optionalCount,
      drillAgeDays: optionalCount,
      drillMaxAgeDays: count,
      status,
    }),
  }),
});
export type Readiness = z.infer<typeof readinessSchema>;
export type ReadinessCheck = Readiness["checks"][number];
export type BackupRun = NonNullable<z.infer<typeof backupRun>>;

const label = z.string().max(400);
export const integrationsSchema = z.object({
  runtime: z.object({
    coreVersion: version,
    sdkVersion: version,
    courseSchemaVersion: count,
  }),
  extensions: z
    .array(
      z.object({
        id: label,
        version: z.string().max(100),
        integrity: z.string().max(200),
        capabilities: z.array(z.string().max(200)).max(50),
        platforms: z.array(z.string().max(40)).max(10),
        codeReady: z.boolean().nullable(),
        priorBuilds: count,
      }),
    )
    .max(100),
  courses: z
    .array(
      z.object({
        catalogId: z.string().uuid(),
        courseKey: label,
        title: label,
        liveVersion: z.string().max(100).nullable(),
        liveDigest: z.string().max(128).nullable(),
        extensions: z
          .array(
            z.object({
              id: label,
              version: z.string().max(100),
              execution: z.string().max(40),
              status: z.enum([
                "compatible",
                "version_mismatch",
                "built_in",
                "missing",
              ]),
              servedByPriorBuild: z.boolean(),
            }),
          )
          .max(50),
      }),
    )
    .max(100),
  packageReceipts: z
    .array(
      z.object({
        id: z.string().uuid(),
        at: z.string(),
        courseKey: label.nullable(),
        version: z.string().max(100).nullable(),
        courseDigest: z.string().max(128).nullable(),
        packageSha256: z.string().max(128).nullable(),
        sourceKind: z.string().max(40).nullable(),
        repository: label.nullable(),
        tag: z.string().max(200).nullable(),
        published: z.boolean().nullable(),
      }),
    )
    .max(20),
  updateChecks: z
    .array(
      z.object({
        id: z.string().uuid(),
        at: z.string(),
        courseKey: label.nullable(),
        trigger: z.string().max(40).nullable(),
        result: z.string().max(40).nullable(),
        errorCode: z.string().max(80).nullable(),
        version: z.string().max(100).nullable(),
        sourceKind: z.string().max(40).nullable(),
      }),
    )
    .max(20),
  providers: z
    .array(
      z.object({
        adapterId: z.string().max(128),
        name: z.string().max(80),
        keyStatus: z.string().max(40),
        testedAt: z.string().nullable(),
      }),
    )
    .max(50),
  telemetry: z.object({ export: z.enum(["on", "off"]), tracing: z.boolean() }),
});
export type Integrations = z.infer<typeof integrationsSchema>;

const statement = z.object({
  id: z.string().uuid(),
  providerLabel: z.string().max(64),
  periodStart: z.string().max(10),
  periodEnd: z.string().max(10),
  billedMicroUsd: count,
  sourceNote: z.string().max(300),
  recordedBy: z.string().max(200),
  recordedAt: z.string(),
  estimate: z.object({
    chargedMicroUsd: count,
    reportedMicroUsd: count,
    calls: count,
    unsettledMicroUsd: count,
  }),
  differenceMicroUsd: z.number().int(),
});
export const billingSchema = z.object({
  currency: z.literal("USD"),
  timeZone: z.literal("UTC"),
  statements: z.array(statement).max(50),
  estimatesAreEstimates: z.literal(true),
});
export type Billing = z.infer<typeof billingSchema>;
export const billingReceiptSchema = billingSchema.extend({
  id: z.string().uuid(),
  replayed: z.boolean(),
});
export interface BilledStatementInput {
  idempotencyKey: string;
  providerLabel: string;
  periodStart: string;
  periodEnd: string;
  billedMicroUsd: number;
  sourceNote: string;
}

const change = z.object({
  path: z.string().max(400),
  before: z.string().max(200).nullable(),
  after: z.string().max(200).nullable(),
});
export const policyHistorySchema = z.object({
  courseId: z.string().uuid(),
  entries: z
    .array(
      z.object({
        source: z.enum([
          "course_settings",
          "placement_settings",
          "organization_ceilings",
          "release_policy",
        ]),
        id: z.string().min(1).max(100),
        at: z.string(),
        actor: z.string().max(200).nullable(),
        revision: count.nullable(),
        version: z.string().max(100).nullable(),
        reason: z.string().max(500).nullable(),
        changes: z.array(change).max(100),
      }),
    )
    .max(100),
  /** The stored revisions of the course settings and organization ceilings (not shown here). */
  revisions: z.array(z.unknown()).max(100).optional(),
});
export type PolicyHistory = z.infer<typeof policyHistorySchema>;

export interface AuditExportQuery {
  format: "csv" | "json";
  from: string;
  to: string;
  actorKind?: "learner" | "staff" | "agent" | "system";
}
export interface AuditExportFile {
  body: Blob;
  fileName: string;
  rows: number;
  truncated: boolean;
  digest: string;
}

/** What this Core has installed, as a file for the SDK's `course compat --host`. */
export interface HostInventoryFile {
  body: Blob;
  fileName: string;
  digest: string;
}

export interface PlatformPort {
  readiness(workspaceId: string, signal?: AbortSignal): Promise<Readiness>;
  integrations(
    workspaceId: string,
    signal?: AbortSignal,
  ): Promise<Integrations>;
  billing(workspaceId: string, signal?: AbortSignal): Promise<Billing>;
  recordBilled(
    workspaceId: string,
    input: BilledStatementInput,
  ): Promise<z.infer<typeof billingReceiptSchema>>;
  /** The audit log as a file; the server records the download in the log. */
  exportAudit(
    workspaceId: string,
    query: AuditExportQuery,
  ): Promise<AuditExportFile>;
  policyHistory(courseId: string, signal?: AbortSignal): Promise<PolicyHistory>;
  /** The host inventory file; the server records the download in the audit log. */
  hostInventory(workspaceId: string): Promise<HostInventoryFile>;
}
export class PlatformError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "PlatformError";
  }
}
const ERROR_CODES = new Set([
  "FORBIDDEN",
  "INVALID_REQUEST",
  "IDEMPOTENCY_CONFLICT",
  "BILLING_PERIOD_INVALID",
  "AUDIT_EXPORT_RANGE_INVALID",
]);
export const platformErrorMessage = (
  error: unknown,
  t: Translate = englishTranslator().t,
) => {
  const code = error instanceof PlatformError ? error.code : "";
  return ERROR_CODES.has(code)
    ? t(`platform.error.${code}` as MessageKey)
    : t("platform.error.unknown");
};
/** Micro-USD typed in a form ("12.34" dollars) as an integer, or null when it is not a valid amount. */
export function parseDollars(value: string): number | null {
  const trimmed = value.trim().replace(/,/g, "");
  if (!/^\d{1,9}(\.\d{1,6})?$/.test(trimmed)) return null;
  const [whole, fraction = ""] = trimmed.split(".");
  return Number(whole) * 1_000_000 + Number(fraction.padEnd(6, "0"));
}
