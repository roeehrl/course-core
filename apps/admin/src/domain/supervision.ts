import { z } from "zod";

export const supervisionStateSchema = z.enum(["active", "paused", "stopped"]);
export type SupervisionState = z.infer<typeof supervisionStateSchema>;
export const supervisionOverviewSchema = z.object({
  control: z.object({
    state: supervisionStateSchema,
    revision: z.number().int().nonnegative(),
    reasonCode: z.string().max(64).nullable(),
    changedBy: z.string().uuid().nullable(),
    changedAt: z.string().nullable(),
  }),
  jobs: z
    .array(
      z.object({
        id: z.string().uuid(),
        role: z.string().max(40),
        state: z.string().max(40),
        reason: z.string().max(80).nullable(),
        held: z.boolean(),
        cancellationRequested: z.boolean(),
        createdAt: z.string(),
      }),
    )
    .max(100),
  pendingSignals: z.number().int().nonnegative(),
  /** Requests that never reached a job: refused on a permanent conflict, or quarantined after bounded retries. */
  undeliveredEvents: z
    .array(
      z.object({
        eventId: z.string().uuid(),
        eventType: z.string().max(100),
        outcome: z.enum(["refused", "quarantined"]),
        reason: z.string().max(80),
        at: z.string(),
        /** An operator already re-queued it once; it is never re-queued again. */
        requeued: z.boolean().default(false),
        /** Quarantined after an outage (not refused) and not yet re-queued. */
        requeueable: z.boolean().default(false),
      }),
    )
    .max(20)
    .default([]),
  canControl: z.boolean(),
  /** Owners and admins may re-queue a quarantined request once, with a reason. */
  canRequeue: z.boolean().default(false),
});
export type SupervisionOverview = z.infer<typeof supervisionOverviewSchema>;
export const supervisionResultSchema = z.object({
  state: supervisionStateSchema,
  previousState: supervisionStateSchema,
  revision: z.number().int().nonnegative(),
  changed: z.boolean(),
  replayed: z.boolean(),
  cancelledJobs: z.number().int().nonnegative(),
  signalledJobs: z.number().int().nonnegative(),
});
export type SupervisionResult = z.infer<typeof supervisionResultSchema>;
export type SupervisionAction = "pause" | "stop" | "resume";
export const requeueResultSchema = z.object({
  eventId: z.string().uuid(),
  eventType: z.string().max(100),
  previousCode: z.string().max(80),
  previousAttempts: z.number().int().nonnegative(),
  replayed: z.boolean(),
});
export type RequeueResult = z.infer<typeof requeueResultSchema>;
export const supervisionReasons = ["learner_request", "staff_review", "safety_review", "budget_review", "course_change"] as const;

export interface SupervisionPort {
  overview(enrollmentId: string, signal?: AbortSignal): Promise<SupervisionOverview>;
  control(
    enrollmentId: string,
    action: SupervisionAction,
    input: { idempotencyKey: string; expectedRevision: number; reasonCode?: string },
  ): Promise<SupervisionResult>;
  /** Re-queues one quarantined request, once, with a reason (owner/admin). */
  requeue?(enrollmentId: string, eventId: string, input: { idempotencyKey: string; reason: string }): Promise<RequeueResult>;
}
export class SupervisionError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "SupervisionError";
  }
}
const messages: Record<string, string> = {
  FORBIDDEN: "Your role cannot change AI supervision. Owners, admins and instructors can.",
  SUPERVISION_CONTROL_STALE: "Someone changed this learner's supervision since you opened it. Refresh and try again.",
  SUPERVISION_CONTROL_INVALID: "Stopped supervision must be resumed before it can be paused.",
  IDEMPOTENCY_CONFLICT: "A different change was already sent with this request. Refresh and try again.",
  ENROLLMENT_ERASED: "This learner's data was erased.",
  SUPERVISOR_EVENT_ALREADY_REQUEUED: "This request was already re-queued once. It will not be re-queued again.",
  SUPERVISOR_EVENT_NOT_QUARANTINED: "This request is no longer quarantined. Refresh to see where it is.",
  SUPERVISOR_EVENT_NOT_REQUEUEABLE: "This request was refused for good and cannot be re-queued.",
  SUPERVISOR_EVENT_NOT_FOUND: "This request is not one of this learner's. Refresh and try again.",
  SUPERVISION_CONSENT_WITHDRAWN: "The learner withdrew consent for AI supervision since this request. It was not re-queued.",
  RUBRIC_ASSIST_CONSENT_WITHDRAWN: "The learner withdrew consent for review drafts since this request. It was not re-queued.",
  INVALID_REQUEST: "Give a reason of at least 10 characters.",
};
export const supervisionErrorMessage = (error: unknown) =>
  messages[error instanceof SupervisionError ? error.code : ""] ?? "AI supervision is unavailable right now. Nothing changed.";
