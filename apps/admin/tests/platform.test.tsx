import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { stripBidiControls } from "@course-core/i18n";
import { createFetchAdminClient } from "../src/client/fetchClient";
import { newTraceparent, withTraceContext } from "../src/client/traceContext";
import {
  parseDollars,
  type Billing,
  type PlatformPort,
  type Readiness,
} from "../src/domain/platform";
import type { AdminClient, CourseWorkspace } from "../src/domain/contracts";
import type { RunInspectorPort } from "../src/domain/runInspector";
import { PlatformView } from "../src/views/PlatformView";
import { IntegrationsView } from "../src/views/IntegrationsView";
import { AuditView } from "../src/views/AuditView";
import { CancelPanel } from "../src/views/RunInspectorPanels";
import { I18nProvider, createAdminTranslator } from "../src/i18n";

const WS = "00000000-0000-4000-8000-000000000001";
const workspace = (role: string, permissions: string[] = []) =>
  ({
    course: { id: "c1", workspaceId: WS },
    role,
    permissions,
  }) as unknown as CourseWorkspace;
const run = (minutesAgo: number, extra = {}) => ({
  outcome: "succeeded" as const,
  code: null,
  finishedAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
  durationSeconds: 4,
  encrypted: true,
  coreVersion: "0.1.50",
  tables: 80,
  rows: 1200,
  bytes: 2_097_152,
  ...extra,
});
const readiness = (
  overrides: Partial<Readiness["targets"]["rpo"]> = {},
): Readiness => ({
  generatedAt: "2026-10-21T10:00:00.000Z",
  overall: "failing",
  checks: [
    {
      id: "database",
      status: "ok",
      facts: {
        postgresMajor: 17,
        latencyMs: 3,
        migrationsApplied: 100,
        migrationsExpected: 100,
        latestMigration: "100_platform_backup_reports.sql",
        migrationsCurrent: true,
      },
    },
    {
      id: "temporal",
      status: "failing",
      facts: {
        lastWorkerContactSeconds: null,
        pendingEvents: 3,
        oldestPendingSeconds: 900,
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
        tracing: true,
        queuedSpans: 0,
        exportedSpans: 12,
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
        installedExtensions: 3,
      },
    },
    {
      id: "backups",
      status: "warning",
      facts: {
        lastSnapshot: run(20),
        lastBackup: null,
        lastRestoreDrill: run(600, { durationSeconds: 90 }),
        lastFailure: { ...run(5), outcome: "failed", code: "pg_dump_failed" },
      },
    },
  ],
  targets: {
    rpo: { targetMinutes: 60, currentMinutes: 20, status: "ok", ...overrides },
    rto: {
      targetMinutes: 60,
      lastDrillMinutes: 2,
      drillAgeDays: 0,
      drillMaxAgeDays: 7,
      status: "ok",
    },
  },
});
const billing: Billing = {
  currency: "USD",
  timeZone: "UTC",
  estimatesAreEstimates: true,
  statements: [
    {
      id: "00000000-0000-4000-8000-0000000000aa",
      providerLabel: "Example AI",
      periodStart: "2026-10-01",
      periodEnd: "2026-10-31",
      billedMicroUsd: 12_500_000,
      sourceNote: "October invoice",
      recordedBy: "Owner Ada",
      recordedAt: "2026-11-01T09:00:00.000Z",
      estimate: {
        chargedMicroUsd: 10_000_000,
        reportedMicroUsd: 9_000_000,
        calls: 40,
        unsettledMicroUsd: 250_000,
      },
      differenceMicroUsd: 2_500_000,
    },
  ],
};
function port(over: Partial<PlatformPort> = {}): PlatformPort {
  return {
    readiness: vi.fn(async () => readiness()),
    integrations: vi.fn(async () => ({
      runtime: {
        coreVersion: "0.1.50",
        sdkVersion: "0.5.0",
        courseSchemaVersion: 1,
      },
      extensions: [
        {
          id: "svg-renderer",
          version: "1.0.0",
          integrity: "sha256-" + "a".repeat(64),
          capabilities: [],
          platforms: ["web"],
          codeReady: null,
          priorBuilds: 0,
        },
      ],
      courses: [
        {
          catalogId: "00000000-0000-4000-8000-000000000003",
          courseKey: "synthetic",
          title: "Synthetic course",
          liveVersion: "2.0.0",
          liveDigest: "b".repeat(64),
          extensions: [
            {
              id: "grader",
              version: "2.0.0",
              execution: "server",
              status: "missing" as const,
              servedByPriorBuild: false,
            },
          ],
        },
      ],
      packageReceipts: [],
      updateChecks: [],
      providers: [
        {
          adapterId: "example",
          name: "Example",
          keyStatus: "working",
          testedAt: null,
        },
      ],
      telemetry: { export: "off" as const, tracing: false },
    })),
    billing: vi.fn(async () => billing),
    recordBilled: vi.fn(async () => ({
      ...billing,
      id: "00000000-0000-4000-8000-0000000000bb",
      replayed: false,
    })),
    exportAudit: vi.fn(async () => ({
      body: new Blob(["a,b\r\n"]),
      fileName: "audit.csv",
      rows: 3,
      truncated: false,
      digest: "e".repeat(64),
    })),
    policyHistory: vi.fn(async () => ({
      courseId: "c1",
      entries: [
        {
          source: "course_settings" as const,
          id: "00000000-0000-4000-8000-0000000000cc",
          at: "2026-10-20T08:00:00.000Z",
          actor: "Owner Ada",
          revision: 2,
          version: null,
          reason: "Pilot cohort needs more time.",
          changes: [{ path: "paceDays", before: "7", after: "10" }],
        },
      ],
    })),
    ...over,
  };
}

describe("platform readiness (Q11, T03)", () => {
  it("shows every check, the recovery targets and what to do about a failing part", async () => {
    const platform = port();
    render(
      <PlatformView
        data={workspace("owner")}
        client={{ platform } as unknown as AdminClient}
      />,
    );
    expect(await screen.findByText("Is the platform ready?")).toBeVisible();
    expect(platform.readiness).toHaveBeenCalledWith(WS, expect.anything());
    const temporal = screen
      .getByRole("heading", { name: "Workflow engine (Temporal)" })
      .closest("section")!;
    expect(within(temporal).getByText("Not working")).toBeVisible();
    expect(
      within(temporal).getByText(
        /Check that the worker and dispatcher are running/,
      ),
    ).toBeVisible();
    expect(screen.getByText("Data loss at most 60 minutes")).toBeVisible();
    expect(
      screen.getByText("The newest good copy is 20 minutes old."),
    ).toBeVisible();
    expect(
      screen.getByText(/The last restore drill took 2 minutes/),
    ).toBeVisible();
    expect(screen.getByText("pg_dump_failed")).toBeVisible();
    expect(screen.getAllByText("Encrypted").length).toBeGreaterThan(0);
  });

  it("says when the newest backup is not encrypted and what to do (T03)", async () => {
    const base = readiness();
    const platform = port({
      readiness: vi.fn(async () => ({
        ...base,
        targets: {
          ...base.targets,
          encryption: { latestEncrypted: false, status: "warning" as const },
        },
      })),
    });
    render(
      <PlatformView
        data={workspace("owner")}
        client={{ platform } as unknown as AdminClient}
      />,
    );
    expect(
      await screen.findByText("The newest copy is not encrypted."),
    ).toBeVisible();
    expect(
      screen.getByText(/Install age on the server, put an age public key/),
    ).toBeVisible();
  });

  it("explains how to meet a missed RPO, and refuses other roles", async () => {
    const platform = port({
      readiness: vi.fn(async () =>
        readiness({ currentMinutes: 200, status: "failing" }),
      ),
    });
    const { unmount } = render(
      <PlatformView
        data={workspace("admin")}
        client={{ platform } as unknown as AdminClient}
      />,
    );
    expect(await screen.findByText(/Turn on hourly snapshots/)).toBeVisible();
    unmount();
    render(
      <PlatformView
        data={workspace("instructor")}
        client={{ platform: port() } as unknown as AdminClient}
      />,
    );
    expect(screen.getByText(/Only owners and administrators/)).toBeVisible();
  });

  it("renders in Hebrew", async () => {
    render(
      <I18nProvider value={createAdminTranslator("he")}>
        <PlatformView
          data={workspace("owner")}
          client={{ platform: port() } as unknown as AdminClient}
        />
      </I18nProvider>,
    );
    expect(await screen.findByText("האם הפלטפורמה מוכנה?")).toBeVisible();
    expect(screen.getByText("יעדי שחזור")).toBeVisible();
  });
});

describe("integrations and billed costs (Q12, U04)", () => {
  it("lists what each course needs, and records a billed amount next to the estimate", async () => {
    const user = userEvent.setup();
    const platform = port();
    render(
      <IntegrationsView
        data={workspace("owner")}
        client={{ platform } as unknown as AdminClient}
      />,
    );
    expect(await screen.findByText("Not installed")).toBeVisible();
    expect(
      screen.getByText(/Install the extension version this course declares/),
    ).toBeVisible();
    expect(screen.getByText("Key works")).toBeVisible();
    const table = await screen.findByRole("table", {
      name: "Billed amounts and estimates (days in UTC)",
    });
    expect(stripBidiControls(table.textContent ?? "")).toContain(
      "Billed $2.50 more than estimated",
    );
    expect(stripBidiControls(table.textContent ?? "")).toContain(
      "$0.25 not yet settled",
    );
    await user.type(screen.getByLabelText("Provider"), "Example AI");
    await user.type(screen.getByLabelText("Amount billed (USD)"), "12.5x");
    expect(
      screen.getByText("Type an amount in US dollars, for example 12.50."),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Record billed amount" }),
    ).toBeDisabled();
    await user.clear(screen.getByLabelText("Amount billed (USD)"));
    await user.type(screen.getByLabelText("Amount billed (USD)"), "12.50");
    await user.type(
      screen.getByLabelText("Where the figure comes from"),
      "October invoice",
    );
    await user.click(
      screen.getByRole("button", { name: "Record billed amount" }),
    );
    await waitFor(() => expect(platform.recordBilled).toHaveBeenCalledTimes(1));
    expect(platform.recordBilled).toHaveBeenCalledWith(
      WS,
      expect.objectContaining({
        providerLabel: "Example AI",
        billedMicroUsd: 12_500_000,
        sourceNote: "October invoice",
      }),
    );
    expect(
      await screen.findByText(/Recorded. It is listed below/),
    ).toBeVisible();
  });

  it("parses typed dollar amounts exactly", () => {
    expect(parseDollars("12.50")).toBe(12_500_000);
    expect(parseDollars("1,234.000001")).toBe(1_234_000_001);
    expect(parseDollars("0")).toBe(0);
    for (const bad of ["", "-1", "1.1234567", "1e3", "abc", "12.5x"])
      expect(parseDollars(bad), bad).toBeNull();
  });
});

describe("audit export and policy history (Q12)", () => {
  it("downloads the log as a file and shows policy changes as before and after", async () => {
    const user = userEvent.setup();
    const platform = port();
    const audit = {
      list: vi.fn(async () => ({ events: [], nextBefore: null })),
    };
    const created: string[] = [];
    URL.createObjectURL = vi.fn(() => {
      created.push("blob:1");
      return "blob:1";
    });
    URL.revokeObjectURL = vi.fn();
    render(
      <AuditView
        data={workspace("owner", ["audit.read", "audit.export", "policy.read"])}
        client={{ platform, audit } as unknown as AdminClient}
      />,
    );
    expect(await screen.findByText("paceDays")).toBeVisible();
    expect(screen.getByText("Pilot cohort needs more time.")).toBeVisible();
    await user.selectOptions(screen.getByLabelText("File type"), "json");
    await user.click(screen.getByRole("button", { name: "Download" }));
    await waitFor(() => expect(platform.exportAudit).toHaveBeenCalledTimes(1));
    expect(platform.exportAudit).toHaveBeenCalledWith(
      WS,
      expect.objectContaining({ format: "json" }),
    );
    expect(created).toHaveLength(1);
    expect(await screen.findByText(/Downloaded 3 events/)).toBeVisible();
  });

  it("offers no download to roles that may only read the log", async () => {
    const platform = port();
    render(
      <AuditView
        data={workspace("support_observer", ["audit.read", "policy.read"])}
        client={
          {
            platform,
            audit: {
              list: vi.fn(async () => ({ events: [], nextBefore: null })),
            },
          } as unknown as AdminClient
        }
      />,
    );
    expect(await screen.findByText("Policy changes")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Download" })).toBeNull();
  });

  it("reads the export file with its digest and maps a refused range", async () => {
    const urls: string[] = [];
    let status = 200;
    const client = createFetchAdminClient({
      baseUrl: "/api/admin",
      fetch: async (url) => {
        urls.push(String(url));
        return status === 200
          ? new Response("sequence,id\r\n", {
              status,
              headers: {
                "X-Export-Rows": "0",
                "X-Export-Digest": "f".repeat(64),
                "X-Export-Truncated": "false",
              },
            })
          : new Response(
              JSON.stringify({ error: "AUDIT_EXPORT_RANGE_INVALID" }),
              { status },
            );
      },
    });
    const file = await client.platform!.exportAudit(WS, {
      format: "csv",
      from: "2026-10-01",
      to: "2026-10-21",
      actorKind: "staff",
    });
    expect(urls[0]).toBe(
      `/api/admin/workspaces/${WS}/audit/export?format=csv&from=2026-10-01&to=2026-10-21&actorKind=staff`,
    );
    expect(file).toMatchObject({
      fileName: "audit-2026-10-01-to-2026-10-21.csv",
      rows: 0,
      truncated: false,
    });
    status = 400;
    const refused = await client
      .platform!.exportAudit(WS, {
        format: "csv",
        from: "2020-01-01",
        to: "2026-10-21",
      })
      .catch((e) => e);
    expect(refused.code).toBe("AUDIT_EXPORT_RANGE_INVALID");
  });
});

describe("run controls and trace context (U07, U03)", () => {
  it("stops a live run with a reason, and offers nothing for an ended one", async () => {
    const user = userEvent.setup();
    const cancel = vi.fn(async () => ({
      runId: "00000000-0000-4000-8000-000000000010",
      previousState: "running",
      state: "cancel_requested" as const,
      signalled: true,
      eventId: "00000000-0000-4000-8000-000000000011",
      replayed: false,
    }));
    const port = { cancel } as unknown as RunInspectorPort;
    const { unmount } = render(
      <CancelPanel
        port={port}
        courseId="c1"
        runId="r1"
        status="running"
        cancelRequested={false}
        allowed
      />,
    );
    await user.type(
      screen.getByLabelText("Why stop it"),
      "Wrong context for this learner.",
    );
    await user.click(screen.getByRole("button", { name: "Stop this run" }));
    expect(cancel).toHaveBeenCalledWith(
      "c1",
      "r1",
      expect.objectContaining({ reason: "Wrong context for this learner." }),
    );
    expect(await screen.findByText("Stop requested")).toBeVisible();
    unmount();
    render(
      <CancelPanel
        port={port}
        courseId="c1"
        runId="r1"
        status="applied"
        cancelRequested={false}
        allowed
      />,
    );
    expect(screen.getByText(/already ended/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Stop this run" })).toBeNull();
  });

  it("sends a fresh, valid traceparent on every request without overriding one", async () => {
    const seen: (string | null)[] = [];
    const fetcher = withTraceContext(async (_url, init) => {
      seen.push(new Headers(init?.headers).get("traceparent"));
      return new Response("{}");
    });
    await fetcher("/a");
    await fetcher("/b");
    await fetcher("/c", {
      headers: {
        traceparent: "00-" + "1".repeat(32) + "-" + "2".repeat(16) + "-00",
      },
    });
    expect(seen[0]).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-00$/);
    expect(seen[1]).not.toBe(seen[0]);
    expect(seen[2]).toBe("00-" + "1".repeat(32) + "-" + "2".repeat(16) + "-00");
    expect(newTraceparent((bytes) => bytes)).toBe(
      `00-${"0".repeat(31)}1-${"0".repeat(15)}1-00`,
    );
  });
});
