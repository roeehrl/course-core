import { z } from "zod";
import { englishTranslator, type MessageKey, type Translate } from "../i18n";

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
export const supervisionReasons = [
  "learner_request",
  "staff_review",
  "safety_review",
  "budget_review",
  "course_change",
] as const;

export interface SupervisionPort {
  overview(
    enrollmentId: string,
    signal?: AbortSignal,
  ): Promise<SupervisionOverview>;
  control(
    enrollmentId: string,
    action: SupervisionAction,
    input: {
      idempotencyKey: string;
      expectedRevision: number;
      reasonCode?: string;
    },
  ): Promise<SupervisionResult>;
  /** Re-queues one quarantined request, once, with a reason (owner/admin). */
  requeue?(
    enrollmentId: string,
    eventId: string,
    input: { idempotencyKey: string; reason: string },
  ): Promise<RequeueResult>;
}
export class SupervisionError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "SupervisionError";
  }
}
const ERROR_CODES = new Set([
  "FORBIDDEN",
  "SUPERVISION_CONTROL_STALE",
  "SUPERVISION_CONTROL_INVALID",
  "IDEMPOTENCY_CONFLICT",
  "ENROLLMENT_ERASED",
  "SUPERVISOR_EVENT_ALREADY_REQUEUED",
  "SUPERVISOR_EVENT_NOT_QUARANTINED",
  "SUPERVISOR_EVENT_NOT_REQUEUEABLE",
  "SUPERVISOR_EVENT_NOT_FOUND",
  "SUPERVISION_CONSENT_WITHDRAWN",
  "RUBRIC_ASSIST_CONSENT_WITHDRAWN",
  "INVALID_REQUEST",
]);
export function supervisionErrorMessage(
  error: unknown,
  t: Translate = englishTranslator().t,
) {
  const code = error instanceof SupervisionError ? error.code : "";
  return ERROR_CODES.has(code)
    ? t(`supervision.error.${code}` as MessageKey)
    : t("supervision.error.unavailable");
}
