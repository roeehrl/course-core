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
const QUESTION = "00000000-0000-4000-8000-0000000000a1",
  REPLY = "00000000-0000-4000-8000-0000000000a2";
const replyParams = { episodeId: "min", blockId: "min-text", questionMessageId: QUESTION, replyMessageId: REPLY };
const sample = () => [
  item({
    kind: "reply_ready",
    link: `/enrollments/${ENROLLMENT}/companion`,
    params: replyParams,
    lessonTitle: "Minimum",
    questionExcerpt: "Why is 2 the minimum?",
  }),
  item({ kind: "move_offer", params: { fromVersion: "1.0.0", toVersion: "2.0.0" } }),
  item({ kind: "course_updated", params: { fromVersion: "0.9.0", toVersion: "1.0.0" }, read: true }),
];

describe("learner notifications", () => {
  it("shows how many are new, words each one, and opens the reply in its lesson after marking it read", async () => {
    const request = server(sample()),
      onOpen = vi.fn();
    render(<LearnerNotifications request={request} onOpen={onOpen} />);
    await userEvent.click(await screen.findByRole("button", { name: "Notifications, 2 new" }));
    // A reply's row is one button, "Open reply", described by what happened, the question and the time.
    const reply = screen.getByRole("button", { name: "Open reply" });
    expect(reply).toHaveAccessibleDescription(/^New\. Your companion replied about “Minimum”\. Why is 2 the minimum\? · \S/);
    expect(reply.querySelector('[data-icon="sparkle"]')).not.toBeNull();
    expect(screen.getByText(/Your course has a new version \(.*2\.0\.0.*\)/)).toBeVisible();
    expect(screen.getByText(/updated from version .*0\.9\.0.* to version .*1\.0\.0/)).toBeVisible();
    // The other rows open with "Open"; a read one is not "New".
    const others = screen.getAllByRole("button", { name: "Open" });
    expect(others).toHaveLength(2);
    expect(others[0]).toHaveAccessibleDescription(/^New\. Your course has a new version/);
    expect(others[1]).toHaveAccessibleDescription(/^Your course was updated/);
    await userEvent.click(reply);
    expect(onOpen).toHaveBeenCalledWith({ enrollmentId: ENROLLMENT, companion: true, episodeId: "min", blockId: "min-text", replyMessageId: REPLY });
    await waitFor(() => expect(request).toHaveBeenCalledWith("/api/me/notifications/read", "POST", { ids: [expect.any(String)] }));
    expect(await screen.findByRole("button", { name: "Notifications, 1 new" })).toBeVisible();
  });

  it("says when a reply's lesson left the course, and an older reply without its ids still opens", async () => {
    const onOpen = vi.fn();
    const items = [
      item({ kind: "reply_ready", link: `/enrollments/${ENROLLMENT}/companion`, params: replyParams, lessonTitle: null, questionExcerpt: null }),
      item({ kind: "reply_ready", link: `/enrollments/${ENROLLMENT}/companion`, read: true }),
    ];
    render(<LearnerNotifications request={server(items)} onOpen={onOpen} />);
    await userEvent.click(await screen.findByRole("button", { name: "Notifications, 1 new" }));
    const [gone, old] = screen.getAllByRole("button", { name: "Open reply" });
    expect(gone).toHaveAccessibleDescription(/^New\. Your companion answered your question\. .+ The lesson this was about is no longer in the course\.$/);
    expect(old).toHaveAccessibleDescription(/^Your companion answered your question\. \S/);
    await userEvent.click(gone!);
    expect(onOpen).toHaveBeenLastCalledWith({ enrollmentId: ENROLLMENT, companion: true, replyMessageId: REPLY, lessonGone: true });
    await userEvent.click(await screen.findByRole("button", { name: "Notifications" }));
    await userEvent.click(screen.getAllByRole("button", { name: "Open reply" })[1]!);
    expect(onOpen).toHaveBeenLastCalledWith({ enrollmentId: ENROLLMENT, companion: true });
  });

  it("marks all read, closes with Escape, and says what to do when the list cannot load", async () => {
    const request = server(sample());
    render(<LearnerNotifications request={request} onOpen={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: "Notifications, 2 new" }));
    await userEvent.click(screen.getByRole("button", { name: "Mark all as read" }));
    expect(await screen.findByRole("button", { name: "Notifications" })).toBeVisible();
    await userEvent.keyboard("{Escape}");
    expect(screen.getByText(/Your companion replied about/)).not.toBeVisible();

    const failing = vi.fn(async () => {
      throw new Error("NETWORK");
    });
    render(<LearnerNotifications request={failing} onOpen={() => {}} />);
    await userEvent.click(screen.getAllByRole("button", { name: "Notifications" }).at(-1)!);
    expect(await screen.findByRole("alert")).toHaveTextContent("Notifications could not be loaded. Try again in a moment.");
  });

  it("shows a reply from today with its time alone, and an older one with its date", async () => {
    const now = new Date();
    now.setHours(9, 5, 0, 0);
    const items = [
      item({ kind: "reply_ready", link: `/enrollments/${ENROLLMENT}/companion`, params: replyParams, lessonTitle: "Minimum", questionExcerpt: "Today?", updatedAt: now.toISOString() }),
    ];
    render(<LearnerNotifications request={server(items)} onOpen={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: "Notifications, 1 new" }));
    expect(screen.getByRole("button", { name: "Open reply" })).toHaveAccessibleDescription(/Today\? · 9:05\sAM$/);
  });

  it("in Hebrew", async () => {
    render(
      <I18nProvider value={createLearnerTranslator("he")}>
        <LearnerNotifications request={server(sample())} onOpen={() => {}} />
      </I18nProvider>,
    );
    await userEvent.click(await screen.findByRole("button", { name: "התראות, 2 חדשות" }));
    expect(screen.getByRole("button", { name: "פתיחת התשובה" })).toHaveAccessibleDescription(/^חדש\. התקבלה תשובה מהמנחה על .*Minimum.*\. .*Why is 2 the minimum\?/);
    expect(screen.getAllByRole("button", { name: "פתיחה" })).toHaveLength(2);
  });

  it("opens only links to the learner's own course pages, and takes a reply's ids only when well formed", () => {
    expect(learnerNotificationTarget(`/enrollments/${ENROLLMENT}`)).toEqual({ enrollmentId: ENROLLMENT, companion: false });
    expect(learnerNotificationTarget("https://example.com")).toBeNull();
    expect(learnerNotificationTarget("/courses/x/overview")).toBeNull();
    expect(learnerNotificationTarget(null)).toBeNull();
    const companion = `/enrollments/${ENROLLMENT}/companion`;
    expect(learnerNotificationTarget(companion, { kind: "reply_ready", params: replyParams, lessonTitle: "Minimum" })).toEqual({
      enrollmentId: ENROLLMENT, companion: true, episodeId: "min", blockId: "min-text", replyMessageId: REPLY,
    });
    // The lesson left the course: the reply opens on the course page.
    expect(learnerNotificationTarget(companion, { kind: "reply_ready", params: replyParams, lessonTitle: null })).toEqual({
      enrollmentId: ENROLLMENT, companion: true, replyMessageId: REPLY, lessonGone: true,
    });
    // Ids of the wrong shape are ignored, and only a reply's are read.
    expect(learnerNotificationTarget(companion, { kind: "reply_ready", params: { episodeId: "../x", blockId: 3, replyMessageId: "not-an-id" }, lessonTitle: "Minimum" }))
      .toEqual({ enrollmentId: ENROLLMENT, companion: true });
    expect(learnerNotificationTarget(`/enrollments/${ENROLLMENT}`, { kind: "course_updated", params: replyParams })).toEqual({ enrollmentId: ENROLLMENT, companion: false });
  });
});
