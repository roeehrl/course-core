import { z } from "zod";

/**
 * The staff notification center: what needs someone's attention now (approvals waiting, an AI
 * role that needs a check, failed AI runs, the AI budget near its limit, AI help paused by a
 * spending limit, overdue backups). The
 * server sends a kind code with parameters and an app path to act on; this app words them.
 */
export const STAFF_NOTIFICATION_KINDS = [
  "approvals_waiting",
  "ai_check_needed",
  "jobs_failed",
  "budget_near_limit",
  "help_paused",
  "backups_overdue",
] as const;
export type StaffNotificationKind = (typeof STAFF_NOTIFICATION_KINDS)[number];

const param = z.union([z.string().max(300), z.number(), z.boolean(), z.null()]);
export const notificationSchema = z.object({
  id: z.uuid(),
  kind: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  params: z.record(z.string().max(64), param),
  link: z.string().max(300).nullable(),
  enrollmentId: z.uuid().nullable(),
  workspaceId: z.uuid(),
  createdAt: z.string(),
  updatedAt: z.string(),
  read: z.boolean(),
});
export type StaffNotification = z.infer<typeof notificationSchema>;
export const notificationPageSchema = z.object({
  unread: z.number().int().nonnegative(),
  items: z.array(notificationSchema).max(50),
  nextCursor: z.string().max(200).nullable(),
});
export type NotificationPage = z.infer<typeof notificationPageSchema>;
export const notificationReadSchema = notificationPageSchema.extend({
  changed: z.number().int().nonnegative(),
});

export interface NotificationsPort {
  list(
    workspaceId: string,
    options?: { before?: string; signal?: AbortSignal },
  ): Promise<NotificationPage>;
  /** Marks the given notifications read, or every one when `ids` is absent. */
  markRead(
    workspaceId: string,
    ids?: string[],
  ): Promise<NotificationPage & { changed: number }>;
}

export class NotificationsError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "NotificationsError";
  }
}

/** Views a notification can open (the admin app's own view ids). */
const VIEWS = new Set([
  "overview",
  "course",
  "reviews",
  "runs",
  "providers",
  "supervision",
  "platform",
]);
/** Where a notification's link points: a view, on a given course or the current one. */
export function notificationTarget(
  link: string | null,
): { view: string; courseId: string | null } | null {
  if (!link) return null;
  const course = /^\/courses\/([A-Za-z0-9-]{1,64})\/([a-z]+)$/.exec(link);
  if (course && VIEWS.has(course[2]!))
    return { view: course[2]!, courseId: course[1]! };
  const view = /^\/([a-z]+)$/.exec(link);
  if (view && VIEWS.has(view[1]!)) return { view: view[1]!, courseId: null };
  return null;
}
