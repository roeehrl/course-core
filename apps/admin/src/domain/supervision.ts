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
  canControl: z.boolean(),
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
export const supervisionReasons = ["learner_request", "staff_review", "safety_review", "budget_review", "course_change"] as const;

export interface SupervisionPort {
  overview(enrollmentId: string, signal?: AbortSignal): Promise<SupervisionOverview>;
  control(
    enrollmentId: string,
    action: SupervisionAction,
    input: { idempotencyKey: string; expectedRevision: number; reasonCode?: string },
  ): Promise<SupervisionResult>;
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
};
export const supervisionErrorMessage = (error: unknown) =>
  messages[error instanceof SupervisionError ? error.code : ""] ?? "AI supervision is unavailable right now. Nothing changed.";
