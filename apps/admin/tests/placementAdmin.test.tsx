import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { createFetchAdminClient } from "../src/client/fetchClient";
import { PlacementView } from "../src/views/PlacementView";
import { PlacementAdminError, placementErrorMessage, type CoursePlacement, type PlacementAdminPort } from "../src/domain/placementAdmin";
import type { AdminClient, CourseWorkspace } from "../src/domain/contracts";

const placement: CoursePlacement = {
  author: { enabled: true, maxItems: 4, learnerMayDecline: true },
  settings: { enabled: false, retestCooldownHours: 168, maxRuns: 1, maxItems: null, minFamiliesPerEpisode: null, revision: 0, updatedAt: null },
  effective: { enabled: false, authorEnabled: true, staffEnabled: false, maxItems: 4, authorMaxItems: 4 },
  counters: { runs: {}, exemptions: 0, falseSkips: { total: 0, revokedByStaff: 0, laterFailed: 0 }, unnecessaryRepetitions: 0 },
};
const workspace = (permissions: string[]) => ({ course: { id: "c1" }, permissions, enrollments: [] }) as unknown as CourseWorkspace;

describe("placement administration", () => {
  it("saves settings that only lower the author's question limit", async () => {
    const port: PlacementAdminPort = { course: vi.fn(async () => placement), save: vi.fn(async () => ({ settings: { ...placement.settings, enabled: true, revision: 1 } })), enrollment: vi.fn(), revoke: vi.fn() };
    render(<PlacementView data={workspace(["policy.write", "enrollment.write"])} client={{ placement: port } as unknown as AdminClient} />);
    await userEvent.click(await screen.findByRole("checkbox", { name: /Offer placement to learners/ }));
    const save = screen.getByRole("button", { name: "Save placement settings" });
    await userEvent.type(screen.getByLabelText("Question limit"), "5");
    expect(save).toBeDisabled();
    await userEvent.clear(screen.getByLabelText("Question limit"));
    await userEvent.type(screen.getByLabelText("Question limit"), "3");
    await userEvent.click(save);
    await waitFor(() => expect(port.save).toHaveBeenCalledWith("c1", { expectedRevision: 0, enabled: true, retestCooldownHours: 168, maxRuns: 1, maxItems: 3, minFamiliesPerEpisode: null }));
    expect(await screen.findByText("Placement settings saved.")).toBeVisible();
  });

  it("shows settings read-only without policy rights", async () => {
    const port: PlacementAdminPort = { course: vi.fn(async () => placement), save: vi.fn(), enrollment: vi.fn(), revoke: vi.fn() };
    render(<PlacementView data={workspace(["course.read"])} client={{ placement: port } as unknown as AdminClient} />);
    expect(await screen.findByText(/Off · up to 4 questions/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Save placement settings" })).toBeNull();
  });

  it("calls the settings and override routes and maps refusals", async () => {
    const calls: { url: string; body?: unknown }[] = [];
    const client = createFetchAdminClient({
      baseUrl: "/api/admin",
      fetch: async (url, init) => {
        calls.push({ url: String(url), ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
        return calls.length === 1
          ? new Response(JSON.stringify({ error: "PLACEMENT_LIMIT_LOOSENS_AUTHOR" }), { status: 409 })
          : new Response(JSON.stringify({ episodeId: "min", state: "revoked", revision: 3 }), { status: 200 });
      },
    });
    const refused = await client.placement!.save("c1", { expectedRevision: 0, enabled: true, retestCooldownHours: 0, maxRuns: 1, maxItems: 9, minFamiliesPerEpisode: null }).catch((e) => e);
    expect(refused).toBeInstanceOf(PlacementAdminError);
    expect(placementErrorMessage(refused)).toMatch(/only be lowered/);
    expect(calls[0]!.url).toBe("/api/admin/courses/c1/placement/settings");
    await client.placement!.revoke("e1", "min", { reason: "A gap in the invariant.", expectedRevision: 2 }, "key-12345678");
    expect(calls[1]).toEqual({ url: "/api/admin/enrollments/e1/placement/exemptions/min/revoke", body: { reason: "A gap in the invariant.", expectedRevision: 2, idempotencyKey: "key-12345678" } });
  });
});
