import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { YourDataPanel } from "../src/components/YourDataPanel.web";

const enrollmentId = "00000000-0000-4000-8000-000000000001";
describe("staff views of the learner's record", () => {
  it("lists each read-only staff view with who and when", async () => {
    const api = {
      request: vi.fn(async () => ({
        views: [{ id: "v1", viewedAt: "2026-10-14T10:00:00.000Z", viewerName: "Course owner", viewerRole: "owner" }],
      })),
    };
    render(<YourDataPanel api={api as never} enrollmentId={enrollmentId} courseTitle="Ordering" onErased={vi.fn()} />);
    expect(await screen.findByText(/Course owner \(owner\)/)).toBeVisible();
    expect(api.request).toHaveBeenCalledWith(`/api/enrollments/${enrollmentId}/staff-views`);
    expect(screen.getByText(/never see your companion conversation/)).toBeVisible();
  });
  it("says when no one has viewed it, and when the list is unavailable", async () => {
    const empty = { request: vi.fn(async () => ({ views: [] })) };
    const { unmount } = render(<YourDataPanel api={empty as never} enrollmentId={enrollmentId} courseTitle="Ordering" onErased={vi.fn()} />);
    expect(await screen.findByText("No one on the course staff has viewed your record.")).toBeVisible();
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
