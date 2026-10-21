import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  createDemoPlatform,
  DEMO_WORKSPACE_ID,
} from "../src/client/demoPlatform";
import {
  billingReceiptSchema,
  billingSchema,
  integrationsSchema,
  PlatformError,
  policyHistorySchema,
  readinessSchema,
} from "../src/domain/platform";
import { AdminError } from "../src/domain/errors";
import type { AdminClient, CourseWorkspace } from "../src/domain/contracts";
import { PlatformView } from "../src/views/PlatformView";
import { IntegrationsView } from "../src/views/IntegrationsView";

const port = (options: Parameters<typeof createDemoPlatform>[0] = {}) =>
  createDemoPlatform({ latency: 0, ...options });
const input = {
  idempotencyKey: "demo-key-1",
  providerLabel: "Scripted example",
  periodStart: "2026-10-01",
  periodEnd: "2026-10-31",
  billedMicroUsd: 2_000_000,
  sourceNote: "Fictional October statement",
};

describe("demo platform port", () => {
  it("returns readiness, integrations, billing and history that parse with the domain schemas", async () => {
    const platform = port();
    readinessSchema.parse(await platform.readiness(DEMO_WORKSPACE_ID));
    integrationsSchema.parse(await platform.integrations(DEMO_WORKSPACE_ID));
    billingSchema.parse(await platform.billing(DEMO_WORKSPACE_ID));
    for (const course of ["sorting", "graphs"])
      expect(
        policyHistorySchema.parse(await platform.policyHistory(course)).entries
          .length,
      ).toBeGreaterThan(0);
  });

  it("records a billed statement once and replays the same key", async () => {
    const platform = port();
    const first = billingReceiptSchema.parse(
      await platform.recordBilled(DEMO_WORKSPACE_ID, input),
    );
    expect(first.replayed).toBe(false);
    expect(first.statements).toHaveLength(2);
    const again = await platform.recordBilled(DEMO_WORKSPACE_ID, input);
    expect(again).toMatchObject({ id: first.id, replayed: true });
    expect(again.statements).toHaveLength(2);
    await expect(
      platform.recordBilled(DEMO_WORKSPACE_ID, {
        ...input,
        billedMicroUsd: 1,
      }),
    ).rejects.toEqual(new PlatformError("IDEMPOTENCY_CONFLICT"));
  });

  it("refuses an invalid period, amount or export range", async () => {
    const platform = port();
    await expect(
      platform.recordBilled(DEMO_WORKSPACE_ID, {
        ...input,
        idempotencyKey: "k2",
        periodEnd: "2026-09-01",
      }),
    ).rejects.toMatchObject({ code: "BILLING_PERIOD_INVALID" });
    await expect(
      platform.recordBilled(DEMO_WORKSPACE_ID, {
        ...input,
        idempotencyKey: "k3",
        billedMicroUsd: -1,
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(
      platform.exportAudit(DEMO_WORKSPACE_ID, {
        format: "csv",
        from: "2026-10-10",
        to: "2026-10-01",
      }),
    ).rejects.toMatchObject({ code: "AUDIT_EXPORT_RANGE_INVALID" });
  });

  it("exports a small synthetic audit file with its digest, filtered by actor", async () => {
    const now = Date.parse("2026-10-21T12:00:00.000Z");
    const platform = port({ now: () => now });
    const csv = await platform.exportAudit(DEMO_WORKSPACE_ID, {
      format: "csv",
      from: "2026-10-01",
      to: "2026-10-21",
    });
    expect(csv).toMatchObject({ fileName: "demo-audit.csv", truncated: false });
    expect(csv.rows).toBe(4);
    const text = await csv.body.text();
    expect(text.split("\n")[0]).toBe("at,actor_kind,action");
    expect(csv.digest).toMatch(/^[a-f0-9]{64}$/);
    const json = await platform.exportAudit(DEMO_WORKSPACE_ID, {
      format: "json",
      from: "2026-10-01",
      to: "2026-10-21",
      actorKind: "agent",
    });
    expect(JSON.parse(await json.body.text()).rows).toHaveLength(1);
  });

  it("refuses non-operators, a denied scenario, a load failure and another workspace", async () => {
    await expect(
      port({ role: "reviewer" }).readiness(DEMO_WORKSPACE_ID),
    ).rejects.toEqual(new PlatformError("FORBIDDEN"));
    await expect(
      port({ scenario: "permission_denied" }).billing(DEMO_WORKSPACE_ID),
    ).rejects.toEqual(new PlatformError("FORBIDDEN"));
    await expect(
      port({ scenario: "load_failure" }).integrations(DEMO_WORKSPACE_ID),
    ).rejects.toEqual(new AdminError("unavailable"));
    await expect(
      port().readiness("00000000-0000-4000-8000-000000000999"),
    ).rejects.toEqual(new AdminError("not_found"));
    await expect(port().policyHistory("unknown")).rejects.toEqual(
      new AdminError("not_found"),
    );
  });

  it("honours an aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      port({ latency: 50 }).readiness(DEMO_WORKSPACE_ID, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("fills the Platform and Integrations views", async () => {
    const client = { platform: port() } as unknown as AdminClient;
    const data = {
      course: { id: "sorting", workspaceId: DEMO_WORKSPACE_ID },
      role: "admin",
      permissions: [],
    } as unknown as CourseWorkspace;
    const { unmount } = render(<PlatformView data={data} client={client} />);
    await waitFor(() => expect(screen.queryAllByRole("alert")).toHaveLength(0));
    await waitFor(() =>
      expect(screen.getAllByText(/0\.1\.50/).length).toBeGreaterThan(0),
    );
    unmount();
    render(<IntegrationsView data={data} client={client} />);
    await waitFor(() =>
      expect(screen.getAllByText("sorting-visuals").length).toBeGreaterThan(0),
    );
    expect(screen.getByText("Fictional September statement")).toBeTruthy();
  });
});
