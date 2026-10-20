import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AccommodationEditor } from "../src/components/AccommodationEditor";
import type { AdminClient } from "../src/domain/contracts";
import type { LearningPolicy } from "../src/domain/policy";

const policy = {
  enrollmentId: "00000000-0000-4000-8000-000000000001",
  status: "active",
  scopes: [
    {
      scopeId: "course",
      label: "Ordering",
      window: { resolvedDeadline: "2026-11-01T00:00:00.000Z" },
    },
  ],
} as unknown as LearningPolicy;
const preview = {
  previewId: "p1",
  previewDigest: "d".repeat(64),
  revision: 4,
  expiresAt: "2026-10-14T01:00:00.000Z",
  scopeId: "course",
  kind: "accommodation" as const,
  adjustment: {
    scopeId: "course",
    windowDeadline: "2026-11-04T00:00:00.000Z",
    additionalMinutes: 30,
    additionalEpisodes: 0,
  },
};

describe("individual accommodations", () => {
  it("previews the concrete effect, requires a reason reference and applies with a stable idempotency key", async () => {
    const client = {
      previewAccommodation: vi.fn(async () => preview),
      applyAccommodation: vi.fn(async () => ({
        policy,
        receipt: { id: "r", authority: "server", outcome: "accommodated" },
        message: "ok",
      })),
    } as unknown as AdminClient;
    const onUpdated = vi.fn();
    render(
      <AccommodationEditor
        client={client}
        policy={policy}
        scopeId="course"
        onClose={vi.fn()}
        onUpdated={onUpdated}
      />,
    );
    await userEvent.type(
      screen.getByLabelText("Extra planned minutes (optional)"),
      "30",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Preview the effect" }),
    );
    expect(vi.mocked(client.previewAccommodation!)).toHaveBeenCalledWith(
      policy.enrollmentId,
      {
        scopeId: "course",
        kind: "accommodation",
        change: {
          deadline: { kind: "window", calendarDays: 3 },
          work: { additionalMinutes: 30 },
        },
      },
    );
    expect(await screen.findByText("+30 planned minutes")).toBeVisible();
    const apply = screen.getByRole("button", {
      name: "Apply for this learner",
    });
    expect(apply).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Reason reference"), "ACC-17");
    await userEvent.click(apply);
    await waitFor(() => expect(onUpdated).toHaveBeenCalled());
    expect(
      vi.mocked(client.applyAccommodation!).mock.calls[0]!.slice(1),
    ).toEqual([
      { previewId: "p1", previewDigest: "d".repeat(64), reason: "ACC-17" },
      { expectedRevision: 4, idempotencyKey: expect.any(String) },
    ]);
  });
  it("an approved pause only moves the window and offers no work fields", async () => {
    const client = {
      previewAccommodation: vi.fn(async () => ({
        ...preview,
        kind: "approved_pause",
      })),
      applyAccommodation: vi.fn(),
    } as unknown as AdminClient;
    render(
      <AccommodationEditor
        client={client}
        policy={policy}
        scopeId="course"
        onClose={vi.fn()}
        onUpdated={vi.fn()}
      />,
    );
    await userEvent.click(
      screen.getByRole("radio", { name: /Approved pause/ }),
    );
    expect(
      screen.queryByLabelText("Extra planned minutes (optional)"),
    ).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: "Preview the effect" }),
    );
    expect(vi.mocked(client.previewAccommodation!)).toHaveBeenCalledWith(
      policy.enrollmentId,
      {
        scopeId: "course",
        kind: "approved_pause",
        change: { deadline: { kind: "window", calendarDays: 3 } },
      },
    );
  });
});
