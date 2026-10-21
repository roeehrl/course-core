import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CrossCoursePanel, describe as describeSuggestion, type CrossCourseView } from "../src/components/CrossCoursePanel.web";
import { stripBidiControls } from "@course-core/i18n";
import { createLearnerTranslator } from "../src/i18n";

const other = "00000000-0000-4000-8000-0000000000a2";
const view = (granted: boolean, suggestions: CrossCourseView["suggestions"] = []): CrossCourseView => ({
  pairs: [{ otherEnrollmentId: other, otherCourse: { title: "Ordering values", version: "1.0.0", status: "active" }, mapping: { links: 2 },
    consent: { granted, revision: granted ? 1 : 0, changedAt: null }, canGrant: true }],
  suggestions,
});
const shown = {
  id: "00000000-0000-4000-8000-0000000000c1", kind: "shown_elsewhere" as const, state: "pending" as const,
  objective: { id: "minimum", description: "Find a minimum." }, otherCourseTitle: "Ordering values",
  otherObjectives: [{ id: "minimum", description: "Find the smallest value." }],
};
const pacing = { ...shown, id: "00000000-0000-4000-8000-0000000000c2", kind: "pacing" as const, objective: null,
  otherObjectives: [{ id: "maximum", description: "Find a maximum." }] };

describe("sharing between a learner's courses", () => {
  it("is off by default, says what is and is not shared, and saves the learner's choice for that pair", async () => {
    const request = vi.fn(async (url: string, method?: string) => (method === "POST" ? { granted: true } : view(request.mock.calls.length > 1)));
    render(<CrossCoursePanel api={{ request } as never} enrollmentId="00000000-0000-4000-8000-0000000000b1" courseTitle="Ordering practice" />);
    const box = await screen.findByRole("checkbox", { name: "Share with Ordering values" });
    expect(box).not.toBeChecked();
    expect(screen.getByText(/never your answers, questions, notes or goal/)).toBeVisible();
    expect(screen.getByText(/Course staff do not see these choices/)).toBeVisible();
    await userEvent.click(box);
    await waitFor(() => expect(request).toHaveBeenCalledWith("/api/enrollments/00000000-0000-4000-8000-0000000000b1/cross-course/consent", "POST",
      expect.objectContaining({ otherEnrollmentId: other, granted: true, idempotencyKey: expect.stringMatching(/^cross-course-/) })));
    expect(await screen.findByText("Sharing with Ordering values is on.")).toBeVisible();
    expect(screen.getByRole("checkbox", { name: "Share with Ordering values" })).toBeChecked();
  });

  it("shows each suggestion as a card the learner confirms or dismisses; none claims credit", async () => {
    let current = view(true, [shown, pacing]);
    const request = vi.fn(async (url: string, method?: string, body?: { action?: string }) => {
      if (method === "POST") {
        current = { ...current, suggestions: current.suggestions.map((s) => (url.includes(s.id) ? { ...s, state: body?.action === "confirm" ? "confirmed" as const : "dismissed" as const } : s)) };
        return {};
      }
      return current;
    });
    render(<CrossCoursePanel api={{ request } as never} enrollmentId="00000000-0000-4000-8000-0000000000b1" courseTitle="Ordering practice" />);
    const card = (await screen.findByRole("heading", { name: "You already showed “Find the smallest value.” in Ordering values" })).closest("article")!;
    expect(within(card as HTMLElement).getByText(/It does not count as passing here/)).toBeVisible();
    await userEvent.click(within(card as HTMLElement).getByRole("button", { name: /^Confirm/ }));
    await waitFor(() => expect(request).toHaveBeenCalledWith(expect.stringContaining(`/cross-course/suggestions/${shown.id}/decision`), "POST", expect.objectContaining({ action: "confirm" })));
    expect(await screen.findByText("Confirmed")).toBeVisible();
    const pace = screen.getByRole("heading", { name: "Pacing across your courses" }).closest("article")!;
    expect(within(pace as HTMLElement).getByText(/builds on an objective in Ordering values/)).toBeVisible();
    await userEvent.click(within(pace as HTMLElement).getByRole("button", { name: "Dismiss: Pacing across your courses" }));
    expect(await screen.findByText("Dismissed")).toBeVisible();
    expect(screen.getByText("No open suggestions.")).toBeVisible();
  });

  it("stays out of the way when nothing is linked, and reports a failed save without changing anything", async () => {
    const empty = vi.fn(async () => ({ pairs: [], suggestions: [] }));
    const { container, unmount } = render(<CrossCoursePanel api={{ request: empty } as never} enrollmentId="00000000-0000-4000-8000-0000000000b1" courseTitle="X" />);
    await waitFor(() => expect(empty).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
    unmount();
    const failing = vi.fn(async (_url: string, method?: string) => { if (method === "POST") throw new Error("offline"); return view(false); });
    render(<CrossCoursePanel api={{ request: failing } as never} enrollmentId="00000000-0000-4000-8000-0000000000b1" courseTitle="X" />);
    await userEvent.click(await screen.findByRole("checkbox", { name: "Share with Ordering values" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Your choice could not be saved. Nothing changed.");
    expect(screen.getByRole("checkbox", { name: "Share with Ordering values" })).not.toBeChecked();
  });
});

describe("cross-course suggestions in Hebrew", () => {
  it("uses Hebrew plurals and keeps the course's own text", () => {
    const he = createLearnerTranslator("he");
    const pacing = describeSuggestion(
      { ...shown, kind: "pacing", otherObjectives: [{ id: "a", description: "Order values." }, { id: "b", description: "Compare." }] },
      he,
    );
    expect(pacing.title).toBe("הקצב בין הקורסים שלך");
    expect(stripBidiControls(pacing.body)).toContain("שתי מטרות למידה בקורס Ordering values");
    expect(stripBidiControls(pacing.body)).toContain('"Order values."');
    const english = describeSuggestion({ ...shown, kind: "pacing", otherObjectives: [{ id: "a", description: "Order values." }] });
    expect(english.body).toBe(
      "This lesson builds on an objective in Ordering values you have not shown yet: “Order values.”. Consider spending your next session there.",
    );
  });
});
