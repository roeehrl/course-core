import { z } from "zod";
import { englishTranslator, type MessageKey, type Translate } from "../i18n";

/** Debug inspector views beyond the run's metadata: the workflow graph, policies and budgets,
 * client and sync state, the audited payload reveal and the sandboxed replay. */
const text = (max = 400) => z.string().max(max);
const amount = z.number().nullable();
const pair = z.object({ microUsd: amount, tokens: amount });
export const workflowSchema = z.object({
  workflowId: text(300),
  generation: z.number().int().nullable(),
  truncated: z.boolean(),
  nodes: z
    .array(
      z.object({
        id: text(300),
        kind: z.enum([
          "input_event",
          "run",
          "checkpoint",
          "operation",
          "tool_call",
          "artifact",
          "verification",
          "application",
        ]),
        label: text(500),
        status: text(60),
        parentId: text(300).nullable(),
      }),
    )
    .max(500),
});
export const policiesSchema = z.object({
  fence: z
    .object({
      enrollmentRevision: z.number(),
      profileRevision: z.number(),
      policyRevision: z.number(),
      ledgerRevision: z.number(),
      courseDigest: text(128),
      enrollmentRevisionNow: z.number().nullable(),
    })
    .nullable(),
  deadline: z.string().nullable(),
  jobBudget: pair.nullable(),
  checkpoints: z
    .array(
      z.object({
        id: text(100),
        allowance: pair,
        timeoutMs: z.number(),
        maxAttempts: z.number(),
      }),
    )
    .max(16),
  operations: z
    .array(
      z.object({
        id: text(200),
        attempt: z.number(),
        status: text(40),
        reservation: pair,
        usage: pair.nullable(),
        usageBasis: z
          .object({ microUsd: text(40), tokens: text(40) })
          .nullable(),
      }),
    )
    .max(16),
  charged: pair.nullable(),
  enrollmentBudget: z
    .object({ limit: pair, used: pair, daily: pair, perArtifact: pair })
    .nullable(),
  workspaceBudget: z.object({ limit: pair, used: pair }).nullable(),
  providerConfiguration: text(200),
  supervision: z.object({ state: text(40), revision: z.number() }),
  reason: text(80).nullable(),
});
export const syncSchema = z.object({
  inputEvent: z
    .object({
      sequence: text(40),
      actorKind: text(40),
      recordedAt: z.string().nullable(),
      platform: text(40).nullable(),
      appVersion: text(64).nullable(),
      clientSequence: text(40).nullable(),
      occurredAt: z.string().nullable(),
      receivedAt: z.string().nullable(),
      courseDigest: text(128).nullable(),
      clockSkewMs: z.number().nullable(),
    })
    .nullable(),
  eventsSince: z.number().int(),
  latestSequence: text(40).nullable(),
  enrollmentRevisionAtRun: z.number(),
  enrollmentRevisionNow: z.number().nullable(),
  delivery: z
    .object({
      attempts: z.number(),
      deliveredAt: z.string().nullable(),
      quarantined: z.boolean(),
      lastErrorCode: text(100).nullable(),
    })
    .nullable(),
  run: z.object({
    state: text(40),
    generation: z.number().nullable(),
    snapshotVersion: z.number().nullable(),
    cancellationRequested: z.boolean(),
    createdAt: z.string().nullable(),
    updatedAt: z.string().nullable(),
  }),
});
export type RunWorkflow = z.infer<typeof workflowSchema>;
export type RunPolicies = z.infer<typeof policiesSchema>;
export type RunSync = z.infer<typeof syncSchema>;

export const PAYLOAD_REASONS = [
  { id: "incident_investigation" },
  { id: "quality_review" },
  { id: "learner_request" },
  { id: "bug_report" },
] as const;
export type PayloadReason = (typeof PAYLOAD_REASONS)[number]["id"];
/** The label of a reveal reason in the active locale. */
export const payloadReasonLabel = (
  id: PayloadReason,
  t: Translate = englishTranslator().t,
) => t(`runInspector.reason.${id}` as MessageKey);
const json: z.ZodType<unknown> = z.unknown();
export const payloadRevealSchema = z.object({
  receipt: z.object({
    id: z.string().uuid(),
    eventId: z.string().uuid(),
    reason: text(60),
    payloadDigest: text(64),
  }),
  payload: z.object({
    inputs: z
      .array(
        z.object({
          id: z.string(),
          checkpointId: text(100),
          context: z.record(z.string(), json),
        }),
      )
      .max(16),
    toolCalls: z
      .array(
        z.object({
          id: z.string(),
          operationId: text(200),
          step: z.number(),
          tool: text(128),
          arguments: json,
          result: json,
          withheld: z.boolean(),
        }),
      )
      .max(64),
    artifacts: z
      .array(
        z.object({
          id: z.string(),
          kind: text(60).nullable(),
          sha256: text(64).nullable(),
          content: json,
          withheld: z.boolean(),
        }),
      )
      .max(64),
  }),
  withheld: z.array(z.object({ ref: text(300), category: text(60) })).max(200),
  rule: z.object({
    id: text(60),
    label: text(200),
    reason: text(1000),
    withheld: z.array(text(60)).max(20),
  }),
});
export type PayloadReveal = z.infer<typeof payloadRevealSchema>;
export const replaySchema = z.object({
  replayRunId: z.string().uuid(),
  sourceRunId: z.string().uuid(),
  outcome: z.enum(["matches", "diverged", "not_replayable"]),
  reason: text(120).nullable(),
  sideEffects: z.literal("stubbed"),
  progressWrites: z.literal("denied"),
  providerCalls: z.literal(0),
  steps: z
    .array(
      z.object({
        step: z.number(),
        tool: text(128),
        recordedReceiptId: z.string(),
        argumentsDigest: text(64).nullable(),
        resultDigest: text(64).nullable(),
      }),
    )
    .max(16),
  recordedPlanDigest: text(64).nullable(),
  replayedPlanDigest: text(64).nullable(),
});
export type RunReplay = z.infer<typeof replaySchema>;
export const enrollmentRunsSchema = z.object({
  courseId: z.string().uuid().nullable(),
  runs: z
    .array(
      z.object({
        id: z.string().uuid(),
        label: text(100),
        status: text(40),
        startedAt: z.string(),
        episodeId: text(200).nullable(),
        blockId: text(200).nullable(),
      }),
    )
    .max(50),
});
export type EnrollmentRuns = z.infer<typeof enrollmentRunsSchema>;

export const retryLinksSchema = z.object({
  retryOf: z.string().uuid().nullable(),
  retriedBy: z
    .object({
      eventId: z.string().uuid(),
      runId: z.string().uuid().nullable(),
      outcome: z.enum(["failed", "uncertain", "cancelled"]),
      at: z.string(),
    })
    .nullable(),
});
export type RetryLinks = z.infer<typeof retryLinksSchema>;
export const retryResultSchema = z.object({
  runId: z.string().uuid(),
  retryEventId: z.string().uuid(),
  outcome: z.enum(["failed", "uncertain", "cancelled"]),
  previousState: text(40),
  previousReason: text(80).nullable(),
  state: z.literal("queued"),
  replayed: z.boolean(),
});
export type RetryResult = z.infer<typeof retryResultSchema>;

export const cancelResultSchema = z.object({
  runId: z.string().uuid(),
  previousState: text(40),
  state: z.literal("cancel_requested"),
  signalled: z.boolean(),
  eventId: z.string().uuid(),
  replayed: z.boolean(),
});
export type CancelResult = z.infer<typeof cancelResultSchema>;
export const replayBatchSchema = z.object({
  runs: z
    .array(
      z.object({
        runId: z.string().uuid(),
        replayRunId: z.string().uuid(),
        outcome: z.enum(["matches", "diverged", "not_replayable"]),
        reason: text(200).nullable(),
      }),
    )
    .max(20),
  summary: z.object({
    matches: z.number().int().nonnegative(),
    diverged: z.number().int().nonnegative(),
    notReplayable: z.number().int().nonnegative(),
  }),
  providerCalls: z.literal(0),
  progressWrites: z.literal("denied"),
});
export type ReplayBatch = z.infer<typeof replayBatchSchema>;
export interface RunInspectorPort {
  /** Stops one live run before it applies anything (supervision.control), idempotent under `idempotencyKey`. */
  cancel?(
    courseId: string,
    runId: string,
    input: { idempotencyKey: string; reason: string },
  ): Promise<CancelResult>;
  /** Replays up to 20 of the course's latest finished runs, read-only, each under a new id. */
  replayRecent?(courseId: string, limit: number): Promise<ReplayBatch>;
  revealPayload(
    courseId: string,
    runId: string,
    reason: PayloadReason,
  ): Promise<PayloadReveal>;
  replay(courseId: string, runId: string): Promise<RunReplay>;
  /** Runs one ended supervisor run again as a new run (run.retry), idempotent under `idempotencyKey`. */
  retry?(
    courseId: string,
    runId: string,
    input: { idempotencyKey: string; reason: string },
  ): Promise<RetryResult>;
  enrollmentRuns(
    enrollmentId: string,
    episodeId: string | null,
    signal?: AbortSignal,
  ): Promise<EnrollmentRuns>;
}
export class RunInspectorError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "RunInspectorError";
  }
}
const ERROR_CODES = new Set([
  "FORBIDDEN",
  "RUN_NOT_FOUND",
  "INVALID_REQUEST",
  "INVALID_INPUT",
  "RUN_ALREADY_RETRIED",
  "RUN_NOT_ENDED",
  "RUN_NOT_RETRYABLE",
  "RUN_RETRY_UNSUPPORTED",
  "SUPERVISION_STOPPED",
  "SUPERVISION_CONSENT_WITHDRAWN",
  "ENROLLMENT_CLOSED",
  "ENROLLMENT_ERASED",
  "IDEMPOTENCY_CONFLICT",
  "RUN_ALREADY_ENDED",
  "RUN_CANCEL_ALREADY_REQUESTED",
]);
export const runInspectorErrorMessage = (
  error: unknown,
  t: Translate = englishTranslator().t,
) => {
  const code = error instanceof RunInspectorError ? error.code : "";
  return ERROR_CODES.has(code)
    ? t(`runInspector.error.${code}` as MessageKey)
    : t("runInspector.error.unknown");
};
