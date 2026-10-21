// i18n-ignore-file: fictional demo records (course titles, operator, statements), like src/data/
import { DEMO_WORKSPACE_ID, type DemoRole } from "../data/fixtures";
import { AdminError } from "../domain/errors";
import { sha256Bytes } from "../domain/webCrypto";
import {
  PlatformError,
  type AuditExportQuery,
  type BilledStatementInput,
  type Billing,
  type Integrations,
  type PlatformPort,
  type PolicyHistory,
  type Readiness,
} from "../domain/platform";

/** The workspace every demo course belongs to. */
export { DEMO_WORKSPACE_ID };
/** Platform records use catalog ids; the demo courses keep their short ids. */
const CATALOG_IDS: Record<string, string> = {
  sorting: "00000000-0000-4000-8000-00000000d001",
  graphs: "00000000-0000-4000-8000-00000000d002",
};
const OPERATOR_ROLES: readonly string[] = ["administrator", "owner", "admin"];

const minutesAgo = (now: number, minutes: number) =>
  new Date(now - minutes * 60_000).toISOString();
function backupRun(now: number, minutes: number, durationSeconds: number) {
  return {
    outcome: "succeeded" as const,
    code: null,
    finishedAt: minutesAgo(now, minutes),
    durationSeconds,
    encrypted: true,
    coreVersion: "0.1.50",
    tables: 84,
    rows: 1_240,
    bytes: 2_097_152,
  };
}
function demoReadiness(now: number): Readiness {
  return {
    generatedAt: new Date(now).toISOString(),
    overall: "warning",
    checks: [
      {
        id: "database",
        status: "ok",
        facts: {
          postgresMajor: 17,
          latencyMs: 2,
          migrationsApplied: 103,
          migrationsExpected: 103,
          latestMigration: "103_demo_example.sql",
          migrationsCurrent: true,
        },
      },
      {
        id: "temporal",
        status: "ok",
        facts: {
          lastWorkerContactSeconds: 4,
          pendingEvents: 0,
          oldestPendingSeconds: null,
          quarantinedEvents: 0,
        },
      },
      {
        id: "sandbox",
        status: "not_configured",
        facts: { ready: null, reason: null },
      },
      {
        id: "collector",
        status: "ok",
        facts: {
          enabled: true,
          tracing: false,
          queuedSpans: 0,
          exportedSpans: 0,
          droppedQueueFull: 0,
          droppedExportFailed: 0,
        },
      },
      {
        id: "version",
        status: "ok",
        facts: {
          coreVersion: "0.1.50",
          sdkVersion: "0.5.0",
          nodeVersion: "26.1.0",
          nodeSupported: true,
          postgresMajor: 17,
          postgresSupported: true,
          courseSchemaVersion: 1,
          installedExtensions: 1,
        },
      },
      {
        id: "backups",
        status: "warning",
        facts: {
          lastSnapshot: backupRun(now, 25, 3),
          lastBackup: backupRun(now, 300, 41),
          lastRestoreDrill: backupRun(now, 60 * 24 * 9, 95),
          lastFailure: null,
        },
      },
    ],
    targets: {
      rpo: { targetMinutes: 60, currentMinutes: 25, status: "ok" },
      rto: {
        targetMinutes: 60,
        lastDrillMinutes: 2,
        drillAgeDays: 9,
        drillMaxAgeDays: 7,
        status: "warning",
      },
      encryption: { latestEncrypted: true, status: "ok" },
    },
  };
}
const digest = (char: string) => char.repeat(64);
function demoIntegrations(now: number): Integrations {
  return {
    runtime: {
      coreVersion: "0.1.50",
      sdkVersion: "0.5.0",
      courseSchemaVersion: 1,
    },
    extensions: [
      {
        id: "sorting-visuals",
        version: "1.0.0",
        integrity: `sha256-${digest("a")}`,
        capabilities: ["visual.render"],
        platforms: ["web"],
        codeReady: true,
        priorBuilds: 1,
      },
    ],
    courses: [
      {
        catalogId: CATALOG_IDS.sorting!,
        courseKey: "sorting",
        title: "Sorting, step by step",
        liveVersion: "1.0.0",
        liveDigest: digest("b"),
        extensions: [
          {
            id: "sorting-visuals",
            version: "1.0.0",
            execution: "browser",
            status: "compatible",
            servedByPriorBuild: false,
          },
        ],
      },
      {
        catalogId: CATALOG_IDS.graphs!,
        courseKey: "graphs",
        title: "A first look at graphs",
        liveVersion: "1.0.0",
        liveDigest: digest("c"),
        extensions: [],
      },
    ],
    packageReceipts: [
      {
        id: "00000000-0000-4000-8000-00000000d101",
        at: minutesAgo(now, 60 * 24 * 11),
        courseKey: "sorting",
        version: "1.0.0",
        courseDigest: digest("b"),
        packageSha256: digest("d"),
        sourceKind: "file",
        repository: null,
        tag: null,
        published: true,
      },
    ],
    updateChecks: [
      {
        id: "00000000-0000-4000-8000-00000000d201",
        at: minutesAgo(now, 60 * 6),
        courseKey: "sorting",
        trigger: "manual",
        result: "up_to_date",
        errorCode: null,
        version: "1.0.0",
        sourceKind: "file",
      },
    ],
    providers: [
      {
        adapterId: "scripted",
        name: "Scripted example",
        keyStatus: "not_needed",
        testedAt: null,
      },
    ],
    telemetry: { export: "off", tracing: false },
  };
}
function demoHistory(courseId: string): PolicyHistory {
  return {
    courseId: CATALOG_IDS[courseId] ?? CATALOG_IDS.sorting!,
    entries: [
      {
        source: "course_settings",
        id: `${courseId}-settings-2`,
        at: "2026-10-14T10:00:00.000Z",
        actor: "Demo operator",
        revision: 2,
        version: null,
        reason: "Give new learners one more week by default.",
        changes: [{ path: "deadline.calendarDays", before: "21", after: "28" }],
      },
      {
        source: "release_policy",
        id: `${courseId}-release-1.0.0`,
        at: "2026-10-10T09:00:00.000Z",
        actor: null,
        revision: null,
        version: "1.0.0",
        reason: null,
        changes: [{ path: "extensions.maxPerGrant", before: null, after: "7" }],
      },
    ],
  };
}
/** Fictional audit rows, hours before now, so the default range always has some. */
const AUDIT_ROWS = [
  [2, "staff", "release.reviewed"],
  [3, "agent", "run.blocked"],
  [26, "learner", "evidence.submitted"],
  [72, "system", "release.published"],
] as const;

/**
 * Workspace operations for the demo: readiness, integrations, billed costs, a synthetic audit
 * export and a course's policy history, all fictional and in memory.
 */
export function createDemoPlatform({
  role = "administrator",
  scenario = "standard",
  latency = 140,
  now = () => Date.now(),
}: {
  role?: DemoRole;
  scenario?: string;
  latency?: number;
  now?: () => number;
} = {}): PlatformPort {
  const statements: Billing["statements"] = [
    {
      id: "00000000-0000-4000-8000-00000000d301",
      providerLabel: "Scripted example",
      periodStart: "2026-09-01",
      periodEnd: "2026-09-30",
      billedMicroUsd: 1_250_000,
      sourceNote: "Fictional September statement",
      recordedBy: "Demo operator",
      recordedAt: "2026-10-02T09:00:00.000Z",
      estimate: {
        chargedMicroUsd: 1_100_000,
        reportedMicroUsd: 1_050_000,
        calls: 42,
        unsettledMicroUsd: 0,
      },
      differenceMicroUsd: 150_000,
    },
  ];
  const receipts = new Map<string, { fingerprint: string; id: string }>();
  let sequence = 0;
  const clone = <T>(value: T): T => structuredClone(value);
  async function delay(signal?: AbortSignal) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (!latency) return;
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", abort);
        resolve();
      }, latency);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }
  async function guard(workspaceId: string | null, signal?: AbortSignal) {
    await delay(signal);
    if (scenario === "load_failure") throw new AdminError("unavailable");
    // PlatformError codes are what the platform views explain.
    if (scenario === "permission_denied" || !OPERATOR_ROLES.includes(role))
      throw new PlatformError("FORBIDDEN");
    if (workspaceId !== null && workspaceId !== DEMO_WORKSPACE_ID)
      throw new AdminError("not_found");
  }
  const billing = (): Billing => ({
    currency: "USD",
    timeZone: "UTC",
    statements: clone(statements),
    estimatesAreEstimates: true,
  });
  return {
    async readiness(workspaceId, signal) {
      await guard(workspaceId, signal);
      return demoReadiness(now());
    },
    async integrations(workspaceId, signal) {
      await guard(workspaceId, signal);
      return demoIntegrations(now());
    },
    async billing(workspaceId, signal) {
      await guard(workspaceId, signal);
      return billing();
    },
    async recordBilled(workspaceId, input: BilledStatementInput) {
      await guard(workspaceId);
      const { idempotencyKey, ...statement } = input;
      const fingerprint = JSON.stringify(statement);
      const replay = receipts.get(idempotencyKey);
      if (replay) {
        if (replay.fingerprint !== fingerprint)
          throw new PlatformError("IDEMPOTENCY_CONFLICT");
        return { ...billing(), id: replay.id, replayed: true };
      }
      const day = /^\d{4}-\d{2}-\d{2}$/;
      if (
        !day.test(input.periodStart) ||
        !day.test(input.periodEnd) ||
        input.periodEnd < input.periodStart
      )
        throw new PlatformError("BILLING_PERIOD_INVALID");
      if (
        !Number.isSafeInteger(input.billedMicroUsd) ||
        input.billedMicroUsd < 0 ||
        !input.providerLabel.trim() ||
        input.providerLabel.length > 64 ||
        input.sourceNote.length > 300
      )
        throw new PlatformError("INVALID_REQUEST");
      const n = ++sequence;
      const id = `00000000-0000-4000-8000-${String(0xd400 + n).padStart(12, "0")}`;
      // The demo has no provider calls in the period, so the estimate is zero.
      statements.unshift({
        id,
        providerLabel: input.providerLabel.trim(),
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        billedMicroUsd: input.billedMicroUsd,
        sourceNote: input.sourceNote.trim(),
        recordedBy: "Demo operator",
        recordedAt: new Date(now()).toISOString(),
        estimate: {
          chargedMicroUsd: 0,
          reportedMicroUsd: 0,
          calls: 0,
          unsettledMicroUsd: 0,
        },
        differenceMicroUsd: input.billedMicroUsd,
      });
      statements.splice(50);
      receipts.set(idempotencyKey, { fingerprint, id });
      return { ...billing(), id, replayed: false };
    },
    async exportAudit(workspaceId, query: AuditExportQuery) {
      await guard(workspaceId);
      const from = Date.parse(query.from);
      // A plain day includes the whole of that day (UTC).
      const to =
        Date.parse(query.to) +
        (/^\d{4}-\d{2}-\d{2}$/.test(query.to) ? 86_400_000 - 1 : 0);
      if (!Number.isFinite(from) || !Number.isFinite(to) || to < from)
        throw new PlatformError("AUDIT_EXPORT_RANGE_INVALID");
      const rows = AUDIT_ROWS.map(([hours, actorKind, action]) => ({
        at: minutesAgo(now(), hours * 60),
        actorKind,
        action,
      })).filter(
        (row) =>
          Date.parse(row.at) >= from &&
          Date.parse(row.at) <= to &&
          (!query.actorKind || query.actorKind === row.actorKind),
      );
      const text =
        query.format === "json"
          ? JSON.stringify({ demo: true, rows }, null, 2)
          : [
              "at,actor_kind,action",
              ...rows.map((r) => `${r.at},${r.actorKind},${r.action}`),
            ].join("\n") + "\n";
      const bytes = new TextEncoder().encode(text);
      const hash = sha256Bytes(bytes);
      return {
        body: new Blob([bytes], {
          type: query.format === "json" ? "application/json" : "text/csv",
        }),
        fileName: `demo-audit.${query.format}`,
        rows: rows.length,
        truncated: false,
        digest: [...new Uint8Array(hash)]
          .map((b) => b.toString(16).padStart(2, "0"))
          .join(""),
      };
    },
    async hostInventory(workspaceId) {
      await guard(workspaceId);
      // A demo host: the shape the SDK's `course compat --host` reads, with made-up builds.
      const text =
        JSON.stringify(
          {
            hostInventoryFormat: 1,
            coreVersion: "0.0.0-demo",
            sdk: {
              version: "0.5.0",
              supported: { min: "0.5.0", maxExclusive: "0.6.0" },
            },
            renderers: [
              {
                rendererId: "course-core-svg-v1",
                version: "0.5.2",
                features: ["clip", "gradient", "image", "mask", "path_draw"],
                targets: ["web_desktop", "web_mobile"],
              },
            ],
            platformAdapters: [],
            extensions: [
              {
                id: "course-core-svg-v1",
                version: "0.5.2",
                integrity: `sha256-${"0".repeat(64)}`,
              },
            ],
            capabilities: ["observation.emit", "visual.render"],
            servedPriorBuilds: [],
          },
          null,
          2,
        ) + "\n";
      const bytes = new TextEncoder().encode(text);
      const hash = sha256Bytes(bytes);
      return {
        body: new Blob([bytes], { type: "application/json" }),
        fileName: "demo-host-inventory.json",
        digest: [...new Uint8Array(hash)]
          .map((b) => b.toString(16).padStart(2, "0"))
          .join(""),
      };
    },
    async policyHistory(courseId, signal) {
      await guard(null, signal);
      if (!(courseId in CATALOG_IDS)) throw new AdminError("not_found");
      return demoHistory(courseId);
    },
  };
}
