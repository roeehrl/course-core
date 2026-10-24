import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NotificationBell } from "../src/components/NotificationBell";
import { createDemoNotifications } from "../src/client/demoNotifications";
import {
  notificationTarget,
  type NotificationPage,
  type NotificationsPort,
  type StaffNotification,
} from "../src/domain/notifications";
import { DEMO_WORKSPACE_ID } from "../src/data/fixtures";
import { createAdminTranslator, I18nProvider } from "../src/i18n";

const WORKSPACE = "00000000-0000-4000-8000-0000000000aa";
const COURSE = "00000000-0000-4000-8000-0000000000c1";
const item = (
  over: Partial<StaffNotification> & Pick<StaffNotification, "kind" | "params">,
): StaffNotification => ({
  id: crypto.randomUUID(),
  link: null,
  enrollmentId: null,
  workspaceId: WORKSPACE,
  createdAt: "2026-10-24T09:00:00.000Z",
  updatedAt: "2026-10-24T09:00:00.000Z",
  read: false,
  ...over,
});
function fakePort(items: StaffNotification[]) {
  const page = (): NotificationPage => ({
    unread: items.filter((i) => !i.read).length,
    items: items.map((i) => ({ ...i })),
    nextCursor: null,
  });
  const port: NotificationsPort = {
    list: vi.fn(async () => page()),
    markRead: vi.fn(async (_workspace: string, ids?: string[]) => {
      let changed = 0;
      for (const i of items)
        if (!i.read && (!ids || ids.includes(i.id))) {
          i.read = true;
          changed += 1;
        }
      return { changed, ...page() };
    }),
  };
  return port;
}
const sample = () => [
  item({
    kind: "approvals_waiting",
    params: { courseId: COURSE, count: 3, writtenAnswers: 3 },
    link: `/courses/${COURSE}/overview`,
  }),
  item({
    kind: "ai_check_needed",
    params: { role: "companion", failed: false, checkable: true },
    link: "/providers",
  }),
  item({
    kind: "backups_overdue",
    params: { minutes: 95, targetMinutes: 60, severe: false },
    link: "/platform",
    read: true,
  }),
];

describe("staff notification bell", () => {
  it("shows the unread count, words each kind, and opens the place to act after marking it read", async () => {
    const port = fakePort(sample()),
      onOpen = vi.fn();
    render(
      <NotificationBell
        port={port}
        workspaceId={WORKSPACE}
        courseTitles={new Map([[COURSE, "Sorting basics"]])}
        onOpen={onOpen}
      />,
    );
    const bell = await screen.findByRole("button", {
      name: "Notifications, 2 unread",
    });
    fireEvent.click(bell);
    const panel = screen.getByRole("dialog", { name: "Needs attention" });
    expect(
      within(panel).getByText("3 items wait for a decision"),
    ).toBeVisible();
    expect(
      within(panel).getByText(/In Sorting basics: answers to grade/),
    ).toBeVisible();
    expect(
      within(panel).getByText("Learner tutor needs a quality check"),
    ).toBeVisible();
    expect(within(panel).getByText(/It keeps working meanwhile/)).toBeVisible();
    expect(
      within(panel).getByText(/The newest backup is 95 minutes old/),
    ).toBeVisible();
    fireEvent.click(
      within(panel).getAllByRole("button", { name: "Go there" })[0]!,
    );
    await waitFor(() =>
      expect(port.markRead).toHaveBeenCalledWith(WORKSPACE, [
        expect.any(String),
      ]),
    );
    expect(onOpen).toHaveBeenCalledWith({ view: "overview", courseId: COURSE });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      await screen.findByRole("button", { name: "Notifications, 1 unread" }),
    ).toBeVisible();
  });

  it("marks all read, closes with Escape, and says so when nothing waits", async () => {
    const port = fakePort(sample());
    render(
      <NotificationBell
        port={port}
        workspaceId={WORKSPACE}
        courseTitles={new Map()}
        onOpen={() => {}}
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Notifications, 2 unread" }),
    );
    // A course the session does not know is named generically.
    expect(screen.getByText(/In this course: answers to grade/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Mark all as read" }));
    await waitFor(() =>
      expect(port.markRead).toHaveBeenCalledWith(WORKSPACE, undefined),
    );
    expect(
      await screen.findByRole("button", { name: "Notifications" }),
    ).toBeVisible();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();

    const empty = fakePort([]);
    render(
      <NotificationBell
        port={empty}
        workspaceId={WORKSPACE}
        courseTitles={new Map()}
        onOpen={() => {}}
      />,
    );
    await waitFor(() => expect(empty.list).toHaveBeenCalled());
    fireEvent.click(
      screen.getAllByRole("button", { name: "Notifications" }).at(-1)!,
    );
    expect(
      await screen.findByText("Nothing needs your attention right now."),
    ).toBeVisible();
  });

  it("says what to do when the list cannot be loaded", async () => {
    const port: NotificationsPort = {
      list: vi.fn(async () => {
        throw new Error("UNAVAILABLE");
      }),
      markRead: vi.fn(),
    };
    render(
      <NotificationBell
        port={port}
        workspaceId={WORKSPACE}
        courseTitles={new Map()}
        onOpen={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Notifications" }));
    expect(
      await screen.findByText(/Check your connection and try again/),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Try again" })).toBeVisible();
  });

  it("speaks Hebrew with the glossary terms", async () => {
    const he = createAdminTranslator("he");
    render(
      <I18nProvider value={he}>
        <NotificationBell
          port={fakePort(sample())}
          workspaceId={WORKSPACE}
          courseTitles={new Map([[COURSE, "מיון"]])}
          onOpen={() => {}}
        />
      </I18nProvider>,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "התראות, 2 חדשות" }),
    );
    expect(screen.getByText("3 פריטים מחכים להחלטה")).toBeVisible();
    expect(screen.getByText(/מלווה הלמידה.*: נדרשת בדיקת איכות/)).toBeVisible();
    expect(screen.getAllByRole("button", { name: "מעבר לטיפול" }).length).toBe(
      3,
    );
  });
});

describe("notification links and the demo port", () => {
  it("opens only the admin views it knows", () => {
    expect(notificationTarget(`/courses/${COURSE}/runs`)).toEqual({
      view: "runs",
      courseId: COURSE,
    });
    expect(notificationTarget("/platform")).toEqual({
      view: "platform",
      courseId: null,
    });
    expect(notificationTarget("/elsewhere")).toBeNull();
    expect(notificationTarget("https://example.com/providers")).toBeNull();
    expect(notificationTarget(null)).toBeNull();
  });

  it("the demo keeps read state and shows operators more kinds than other staff", async () => {
    const demo = createDemoNotifications({ latency: 0 });
    const first = await demo.list(DEMO_WORKSPACE_ID);
    expect(first.items.map((i) => i.kind)).toEqual([
      "approvals_waiting",
      "jobs_failed",
      "ai_check_needed",
      "budget_near_limit",
    ]);
    expect(
      (await demo.markRead(DEMO_WORKSPACE_ID, [first.items[0]!.id])).unread,
    ).toBe(3);
    const instructor = await createDemoNotifications({
      role: "instructor",
      latency: 0,
    }).list(DEMO_WORKSPACE_ID);
    expect(instructor.items.map((i) => i.kind)).toEqual([
      "approvals_waiting",
      "jobs_failed",
    ]);
    await expect(
      createDemoNotifications({ latency: 0 }).list(crypto.randomUUID()),
    ).rejects.toThrow("FORBIDDEN");
  });
});
