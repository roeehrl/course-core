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

/** Workspace AI supervision settings (owner/admin): autonomy ceiling and permitted tool families. */
export const autonomyLevels = [
  "recommend_only",
  "propose_only",
  "apply_verified_personal",
] as const;
export type AutonomyLevel = (typeof autonomyLevels)[number];
const code = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
export const supervisionSettingsSchema = z.object({
  autonomyLevel: z.enum(autonomyLevels),
  permittedToolFamilies: z.array(code).max(32),
  revision: z.number().int().nonnegative(),
  levels: z.array(z.enum(autonomyLevels)).max(8).optional(),
  families: z
    .array(
      z.object({
        id: code,
        tools: z
          .array(z.object({ id: code, sideEffects: z.string().max(40) }))
          .max(64),
      }),
    )
    .max(32)
    .optional(),
});
export type SupervisionSettings = z.infer<typeof supervisionSettingsSchema>;
export const settingsPreviewSchema = z.object({
  autonomyLevel: z.enum(autonomyLevels),
  effects: z.array(code).max(10),
  toolsAdded: z.array(code).max(64),
  toolsRemoved: z.array(code).max(64),
  warnings: z.array(code).max(10),
  optedInLearners: z.number().int().nonnegative(),
  openTeachingActions: z.number().int().nonnegative(),
});
export type SettingsPreview = z.infer<typeof settingsPreviewSchema>;
const amount = z.object({
  microUsd: z.number().int().nonnegative(),
  tokens: z.number().int().nonnegative(),
});
export const learnerBudgetSchema = z.object({
  enrollmentId: z.string().uuid(),
  overall: amount.nullable(),
  daily: amount.nullable(),
  artifact: amount.nullable(),
  usedToday: amount,
  usedInCurrentLessonToday: amount.nullable(),
  currentEpisodeId: z.string().max(200).nullable(),
  dayBoundary: z.literal("utc"),
});
export type LearnerBudget = z.infer<typeof learnerBudgetSchema>;
/** A change the supervisor asked a person with authority to decide. */
export const authorityRequestSchema = z.object({
  requestId: z.string().uuid(),
  jobId: z.string().uuid(),
  kind: z.enum([
    "goal_change",
    "required_objectives",
    "grading_standard",
    "paid_ceiling",
  ]),
  approver: z.enum(["learner", "staff"]),
  proposal: z.object({
    goal: z.string().max(300).optional(),
    objectiveIds: z.array(z.string().max(128)).max(10).optional(),
    limitMicroUsd: z.number().int().nonnegative().optional(),
  }),
  reason: z.string().max(500).nullable(),
  state: z.enum(["pending", "approved", "rejected", "expired", "undone"]),
  decidedAt: z.string().nullable(),
  createdAt: z.string(),
  enrollmentId: z.string().uuid().optional(),
  learnerName: z.string().max(100).optional(),
});
export type AuthorityRequest = z.infer<typeof authorityRequestSchema>;
export const authorityQueueSchema = z.object({
  requests: z.array(authorityRequestSchema).max(100),
});

export interface SupervisionSettingsPort {
  load(workspaceId: string, signal?: AbortSignal): Promise<SupervisionSettings>;
  preview(
    workspaceId: string,
    input: { autonomyLevel: AutonomyLevel; permittedToolFamilies: string[] },
  ): Promise<SettingsPreview>;
  save(
    workspaceId: string,
    input: {
      expectedRevision: number;
      autonomyLevel: AutonomyLevel;
      permittedToolFamilies: string[];
    },
  ): Promise<SupervisionSettings>;
  requests(
    workspaceId: string,
    signal?: AbortSignal,
  ): Promise<{ requests: AuthorityRequest[] }>;
  decide(
    workspaceId: string,
    requestId: string,
    input: { idempotencyKey: string; decision: "approve" | "reject" },
  ): Promise<AuthorityRequest>;
  budget(
    workspaceId: string,
    enrollmentId: string,
    signal?: AbortSignal,
  ): Promise<LearnerBudget>;
  saveBudget(
    workspaceId: string,
    enrollmentId: string,
    input: {
      daily: { microUsd: number; tokens: number } | null;
      artifact: { microUsd: number; tokens: number } | null;
    },
  ): Promise<LearnerBudget>;
}

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
  /** Owner/admin settings, spending limits and authority decisions (absent in the demo). */
  settings?: SupervisionSettingsPort;
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
  "SUPERVISION_SETTINGS_CHANGED",
  "SUPERVISION_LESSON_LIMIT_ABOVE_DAILY",
  "AUTHORITY_REQUEST_CLOSED",
  "AUTHORITY_DECIDED_BY_LEARNER",
  "AUTHORITY_REQUEST_NOT_FOUND",
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
