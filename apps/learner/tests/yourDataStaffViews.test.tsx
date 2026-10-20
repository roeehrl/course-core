import React from "react";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { YourDataPanel } from "../src/components/YourDataPanel.web";

const enrollmentId = "00000000-0000-4000-8000-000000000001";
describe("staff access to the learner's record", () => {
  it("lists each read-only staff view and staff download with who and when, oldest first", async () => {
    const api = {
      request: vi.fn(async () => ({
        views: [{ id: "v1", viewedAt: "2026-10-14T10:00:00.000Z", viewerName: "Course owner", viewerRole: "owner" }],
        exports: [
          { id: "x2", exportedAt: "2026-10-14T12:00:00.000Z", exporterName: "Course admin", exporterRole: "admin" },
          { id: "x1", exportedAt: "2026-10-14T09:00:00.000Z", exporterName: "Course owner", exporterRole: "owner" },
        ],
      })),
    };
    render(<YourDataPanel api={api as never} enrollmentId={enrollmentId} courseTitle="Ordering" onErased={vi.fn()} />);
    const list = await screen.findByRole("list");
    const items = within(list).getAllByRole("listitem").map((item) => item.textContent);
    expect(items).toHaveLength(3);
    expect(items[0]).toMatch(/^Course owner \(owner\) downloaded a copy of your data/);
    expect(items[1]).toMatch(/^Course owner \(owner\) viewed your record/);
    expect(items[2]).toMatch(/^Course admin \(admin\) downloaded a copy of your data/);
    expect(api.request).toHaveBeenCalledWith(`/api/enrollments/${enrollmentId}/staff-views`);
    expect(screen.getByRole("heading", { name: "Staff access to your record" })).toBeVisible();
    // Honest about what each kind of access includes.
    expect(screen.getByText(/neither the view nor their copy includes your companion conversation or your own notes; only your own download does/)).toBeVisible();
    expect(screen.getByText(/Both include your profile: your display name, learning goal and pace/)).toBeVisible();
  });
  it("still lists views from a server that reports no downloads", async () => {
    const api = { request: vi.fn(async () => ({ views: [{ id: "v1", viewedAt: "2026-10-14T10:00:00.000Z", viewerName: "Course owner", viewerRole: "owner" }] })) };
    render(<YourDataPanel api={api as never} enrollmentId={enrollmentId} courseTitle="Ordering" onErased={vi.fn()} />);
    expect(await screen.findByText(/Course owner \(owner\) viewed your record/)).toBeVisible();
  });
  it("says when no one has viewed or downloaded it, and when the list is unavailable", async () => {
    const empty = { request: vi.fn(async () => ({ views: [], exports: [] })) };
    const { unmount } = render(<YourDataPanel api={empty as never} enrollmentId={enrollmentId} courseTitle="Ordering" onErased={vi.fn()} />);
    // While loading, "Checking…" sits over an invisible, aria-hidden copy of the
    // empty message that holds its space.
    expect(screen.getByText("Checking…")).toBeVisible();
    expect(screen.getByText("No one on the course staff has viewed or downloaded your record.")).toHaveAttribute("aria-hidden", "true");
    expect(await screen.findByText("No one on the course staff has viewed or downloaded your record.", { selector: "p" })).toBeVisible();
    expect(screen.queryByText("Checking…")).toBeNull();
    unmount();
    const failing = {
      request: vi.fn(async () => {
        throw new Error("offline");
      }),
    };
    render(<YourDataPanel api={failing as never} enrollmentId={enrollmentId} courseTitle="Ordering" onErased={vi.fn()} />);
    expect(await screen.findByText("This list could not be loaded right now.")).toBeVisible();
  });
});
