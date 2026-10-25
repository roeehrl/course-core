import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { LearnerNotifications, learnerNotificationTarget, type LearnerNotification } from "../src/connected/Notifications.web";
import { I18nProvider, createLearnerTranslator } from "../src/i18n";

const ENROLLMENT = "00000000-0000-4000-8000-0000000000e1";
const item = (over: Partial<LearnerNotification> & Pick<LearnerNotification, "kind">): LearnerNotification => ({
  id: crypto.randomUUID(),
  params: {},
  link: `/enrollments/${ENROLLMENT}`,
  enrollmentId: ENROLLMENT,
  createdAt: "2026-10-24T10:00:00.000Z",
  updatedAt: "2026-10-24T10:00:00.000Z",
  read: false,
  ...over,
});
function server(items: LearnerNotification[]) {
  const page = () => ({ unread: items.filter((i) => !i.read).length, items: items.map((i) => ({ ...i })), nextCursor: null });
  return vi.fn(async (path: string, _method?: string, body?: unknown) => {
    if (path === "/api/me/notifications/read") {
      const ids = (body as { ids?: string[] }).ids;
      for (const i of items) if (!ids || ids.includes(i.id)) i.read = true;
    }
    return page() as never;
  });
}
const sample = () => [
  item({ kind: "reply_ready", link: `/enrollments/${ENROLLMENT}/companion` }),
  item({ kind: "move_offer", params: { fromVersion: "1.0.0", toVersion: "2.0.0" } }),
  item({ kind: "course_updated", params: { fromVersion: "0.9.0", toVersion: "1.0.0" }, read: true }),
];

describe("learner notifications", () => {
  it("shows how many are new, words each one, and opens the course (and companion) after marking it read", async () => {
    const request = server(sample()),
      onOpen = vi.fn();
    render(<LearnerNotifications request={request} onOpen={onOpen} />);
    await userEvent.click(await screen.findByRole("button", { name: "Notifications, 2 new" }));
    expect(screen.getByText(/Your companion answered your question/)).toBeVisible();
    expect(screen.getByText(/Your course has a new version \(.*2\.0\.0.*\)/)).toBeVisible();
    expect(screen.getByText(/updated from version .*0\.9\.0.* to version .*1\.0\.0/)).toBeVisible();
    await userEvent.click(screen.getAllByRole("button", { name: "Open" })[0]!);
    expect(onOpen).toHaveBeenCalledWith({ enrollmentId: ENROLLMENT, companion: true });
    await waitFor(() => expect(request).toHaveBeenCalledWith("/api/me/notifications/read", "POST", { ids: [expect.any(String)] }));
    expect(await screen.findByRole("button", { name: "Notifications, 1 new" })).toBeVisible();
  });

  it("marks all read, closes with Escape, and says what to do when the list cannot load", async () => {
    const request = server(sample());
    render(<LearnerNotifications request={request} onOpen={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: "Notifications, 2 new" }));
    await userEvent.click(screen.getByRole("button", { name: "Mark all as read" }));
    expect(await screen.findByRole("button", { name: "Notifications" })).toBeVisible();
    await userEvent.keyboard("{Escape}");
    expect(screen.getByText(/Your companion answered/)).not.toBeVisible();

    const failing = vi.fn(async () => {
      throw new Error("NETWORK");
    });
    render(<LearnerNotifications request={failing} onOpen={() => {}} />);
    await userEvent.click(screen.getAllByRole("button", { name: "Notifications" }).at(-1)!);
    expect(await screen.findByRole("alert")).toHaveTextContent("Notifications could not be loaded. Try again in a moment.");
  });

  it("in Hebrew", async () => {
    render(
      <I18nProvider value={createLearnerTranslator("he")}>
        <LearnerNotifications request={server(sample())} onOpen={() => {}} />
      </I18nProvider>,
    );
    await userEvent.click(await screen.findByRole("button", { name: "התראות, 2 חדשות" }));
    expect(screen.getByText(/המנחה השיב על השאלה שלך/)).toBeVisible();
    expect(screen.getAllByRole("button", { name: "פתיחה" })).toHaveLength(3);
  });

  it("opens only links to the learner's own course pages", () => {
    expect(learnerNotificationTarget(`/enrollments/${ENROLLMENT}`)).toEqual({ enrollmentId: ENROLLMENT, companion: false });
    expect(learnerNotificationTarget("https://example.com")).toBeNull();
    expect(learnerNotificationTarget("/courses/x/overview")).toBeNull();
    expect(learnerNotificationTarget(null)).toBeNull();
  });
});
