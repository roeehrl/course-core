import { DEMO_WORKSPACE_ID, type DemoRole } from "../data/fixtures";
import {
  NotificationsError,
  type NotificationPage,
  type NotificationsPort,
  type StaffNotification,
} from "../domain/notifications";

/** The demo course the fictional conditions belong to. */
const SORTING = "sorting";
const OPERATOR_ROLES: readonly string[] = ["administrator", "owner", "admin"];

/**
 * In-memory staff notifications for the demo: fictional conditions, read state kept for the
 * session. Operators see every kind; other staff see the approvals and failed runs only.
 */
export function createDemoNotifications({
  role = "administrator",
  scenario = "standard",
  latency = 140,
  now = () => Date.now(),
}: {
  role?: DemoRole;
  scenario?: string;
  latency?: number;
  now?: () => number;
} = {}): NotificationsPort {
  const at = (minutes: number) =>
    new Date(now() - minutes * 60_000).toISOString();
  const item = (
    id: string,
    kind: string,
    params: StaffNotification["params"],
    link: string,
    minutes: number,
  ): StaffNotification => ({
    id: `00000000-0000-4000-8000-00000000e${id}`,
    kind,
    params,
    link,
    enrollmentId: null,
    workspaceId: DEMO_WORKSPACE_ID,
    createdAt: at(minutes),
    updatedAt: at(minutes),
    read: false,
  });
  const operator = OPERATOR_ROLES.includes(role);
  const items: StaffNotification[] = [
    item(
      "001",
      "approvals_waiting",
      {
        courseId: SORTING,
        count: 3,
        writtenAnswers: 2,
        secondOpinions: 0,
        gateReviews: 1,
        generatedMedia: 0,
        releases: 0,
        providerRequests: 0,
      },
      `/courses/${SORTING}/overview`,
      12,
    ),
    item(
      "002",
      "jobs_failed",
      { courseId: SORTING, count: 1 },
      `/courses/${SORTING}/runs`,
      40,
    ),
    ...(operator
      ? [
          item(
            "003",
            "ai_check_needed",
            { role: "companion", failed: false, checkable: true },
            "/providers",
            90,
          ),
          item(
            "004",
            "budget_near_limit",
            { percent: 84, level: 80 },
            "/providers",
            180,
          ),
        ]
      : []),
  ];
  const wait = () => new Promise((resolve) => setTimeout(resolve, latency));
  const page = (): NotificationPage => ({
    unread: items.filter((i) => !i.read).length,
    items: items.map((i) => ({ ...i })),
    nextCursor: null,
  });
  const check = (workspaceId: string) => {
    if (scenario === "permission_denied")
      throw new NotificationsError("FORBIDDEN");
    if (workspaceId !== DEMO_WORKSPACE_ID)
      throw new NotificationsError("FORBIDDEN");
  };
  return {
    async list(workspaceId) {
      await wait();
      check(workspaceId);
      return page();
    },
    async markRead(workspaceId, ids) {
      await wait();
      check(workspaceId);
      let changed = 0;
      for (const i of items)
        if (!i.read && (!ids || ids.includes(i.id))) {
          i.read = true;
          changed += 1;
        }
      return { changed, ...page() };
    },
  };
}
