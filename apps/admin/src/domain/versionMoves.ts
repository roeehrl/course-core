import { z } from "zod";
import { englishTranslator, type MessageKey, type Translate } from "../i18n";
import en from "../i18n/messages/en/versionMoves.json";

/** Moving enrolled learners to a newer version of their course (Core K13). The server returns
 * codes and identifiers; every sentence staff read is built here from the catalogs. */
const text = z.string().max(4000);
const code = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/);
const lesson = z.object({ id: text, title: text });
const lessons = z.object({
  count: z.number().int().nonnegative(),
  items: z.array(lesson).max(200),
});
const versionRef = z.object({ releaseId: text, version: text });

export const learnerImpactSchema = z.object({
  enrollmentId: text,
  displayName: text.nullable(),
  status: text,
  outcome: z.enum(["ready", "waits", "refused"]),
  refusal: code.nullable(),
  policyCode: code.nullable(),
  wait: code.nullable(),
  progress: z.object({
    completeBefore: z.boolean(),
    completeAfter: z.boolean(),
    creditedBefore: z.number().int().nonnegative(),
    creditedAfter: z.number().int().nonnegative(),
    kept: z.number().int().nonnegative(),
    changedKept: lessons,
    checkpointsAgain: lessons,
    onHold: lessons,
    removed: lessons,
    nextBefore: lesson.nullable(),
    nextAfter: lesson.nullable(),
  }),
  evidence: z.object({ records: z.number().int().nonnegative() }),
  openWork: z.object({
    questions: z.number().int().nonnegative(),
    activities: z.number().int().nonnegative(),
  }),
  personalChanges: z.number().int().nonnegative(),
  policy: z.object({
    addedScopes: z.array(text).max(400),
    keptScopes: z.number().int().nonnegative(),
  }),
  costDigest: text,
});
export type LearnerImpact = z.infer<typeof learnerImpactSchema>;

export const movePreviewSchema = z.object({
  moveId: text,
  previewDigest: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: text,
  scope: z.enum(["learner", "cohort"]),
  enrollmentId: text.nullable(),
  from: versionRef,
  to: versionRef,
  content: z.object({
    changes: z.number().int().nonnegative(),
    lessons: z.object({
      added: z.number().int().nonnegative(),
      removed: z.number().int().nonnegative(),
      changed: z.number().int().nonnegative(),
      unchanged: z.number().int().nonnegative(),
    }),
    questions: z.object({
      added: z.number().int().nonnegative(),
      removed: z.number().int().nonnegative(),
      changed: z.number().int().nonnegative(),
    }),
    newLessons: z.array(lesson).max(200),
  }),
  totals: z.object({
    learners: z.number().int().nonnegative(),
    ready: z.number().int().nonnegative(),
    waits: z.number().int().nonnegative(),
    refused: z.number().int().nonnegative(),
    losingCredit: z.number().int().nonnegative(),
  }),
  learners: z.array(learnerImpactSchema).max(500),
  rules: z.object({ waitsAtMostDays: z.number().int().positive() }),
});
export type MovePreview = z.infer<typeof movePreviewSchema>;

const totals = z.object({
  moved: z.number().int().nonnegative(),
  waiting: z.number().int().nonnegative(),
  refused: z.number().int().nonnegative(),
  undone: z.number().int().nonnegative(),
  cancelled: z.number().int().nonnegative(),
});
const moveSummarySchema = z.object({
  moveId: text,
  scope: z.enum(["learner", "cohort"]),
  state: text,
  reason: text.nullable(),
  from: versionRef,
  to: versionRef,
  createdAt: text,
  confirmedAt: text.nullable(),
  totals,
  undoable: z.number().int().nonnegative(),
});
export type MoveSummary = z.infer<typeof moveSummarySchema>;
export const versionMovesViewSchema = z.object({
  versions: z
    .array(
      z.object({
        releaseId: text,
        version: text,
        status: text,
        learners: z.number().int().nonnegative(),
        newer: z.array(versionRef).max(100),
      }),
    )
    .max(100),
  moves: z.array(moveSummarySchema).max(50),
  permissions: z.object({ move: z.boolean() }),
});
export type VersionMovesView = z.infer<typeof versionMovesViewSchema>;

export const moveDetailSchema = moveSummarySchema
  .omit({ undoable: true })
  .extend({
    learners: z
      .array(
        z.object({
          enrollmentId: text,
          displayName: text.nullable(),
          state: z.enum(["waiting", "moved", "refused", "undone", "cancelled"]),
          code: code.nullable(),
          movedAt: text.nullable(),
          undoneAt: text.nullable(),
          undo: z
            .object({ possible: z.boolean(), code: code.nullable() })
            .nullable(),
        }),
      )
      .max(500),
  });
export type MoveDetail = z.infer<typeof moveDetailSchema>;
export const undoResultSchema = z.object({
  undone: z.array(text).max(500),
  refused: z.array(z.object({ enrollmentId: text, code })).max(500),
  move: moveDetailSchema,
});
export const moveCancelResultSchema = z.object({
  cancelled: z.number().int().nonnegative(),
  move: moveDetailSchema,
});
export const versionLearnersSchema = z.object({
  learners: z
    .array(
      z.object({
        enrollmentId: text,
        displayName: text.nullable(),
        status: text,
      }),
    )
    .max(500),
});

export interface VersionMovesPort {
  get(courseId: string, signal?: AbortSignal): Promise<VersionMovesView>;
  learners(
    courseId: string,
    releaseId: string,
    signal?: AbortSignal,
  ): Promise<z.infer<typeof versionLearnersSchema>>;
  preview(
    courseId: string,
    input: {
      fromReleaseId: string;
      toReleaseId: string;
      enrollmentId?: string;
    },
  ): Promise<MovePreview>;
  confirm(
    courseId: string,
    moveId: string,
    input: {
      previewDigest: string;
      reason: string;
      acknowledgeLostCredit: boolean;
    },
  ): Promise<MoveDetail>;
  detail(
    courseId: string,
    moveId: string,
    signal?: AbortSignal,
  ): Promise<MoveDetail>;
  undo(
    courseId: string,
    moveId: string,
    input: { reason: string; enrollmentIds?: string[] },
  ): Promise<z.infer<typeof undoResultSchema>>;
  cancel(
    courseId: string,
    moveId: string,
  ): Promise<z.infer<typeof moveCancelResultSchema>>;
}

/** A refusal or failure, by the server's code. */
export class VersionMoveError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "VersionMoveError";
  }
}
/** What a code means and what to do, in the reader's language. */
export function moveCodeMessage(
  value: string | null | undefined,
  t: Translate = englishTranslator().t,
): string {
  return value && Object.hasOwn(en, `code.${value}`)
    ? t(`versionMoves.code.${value}` as MessageKey)
    : t("versionMoves.code.unknown", { code: value ?? "UNAVAILABLE" });
}
export function moveErrorMessage(error: unknown, t: Translate): string {
  return moveCodeMessage(
    error instanceof VersionMoveError ? error.code : "UNAVAILABLE",
    t,
  );
}
export const losesCredit = (impact: LearnerImpact) =>
  impact.outcome !== "refused" &&
  impact.progress.checkpointsAgain.count +
    impact.progress.onHold.count +
    impact.progress.removed.count >
    0;
