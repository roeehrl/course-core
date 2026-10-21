import { z } from "zod";
import { englishTranslator, type MessageKey, type Translate } from "../i18n";

const id = z.string().min(1).max(200);
const text = z.string().max(64000);
const block = z.discriminatedUnion("type", [
  z.object({
    id,
    type: z.literal("text"),
    markdown: text,
    sourceRefs: z.array(id).max(50).optional(),
  }),
  z.object({ id, type: z.literal("assessment"), assessmentId: id }),
  z.object({ id, type: z.literal("visual"), visualId: id }),
  z.object({
    id,
    type: z.literal("media"),
    mediaId: id,
    required: z.boolean(),
  }),
  z.object({ id, type: z.literal("activity"), extensionId: id }).passthrough(),
]);
export type LearnerBlock = z.infer<typeof block>;
const episode = z.object({
  id,
  title: z.string().max(500),
  objectiveIds: z.array(id).max(200),
  blocks: z.array(block).max(500),
  requirement: z.enum(["required", "optional"]).optional(),
  gateId: id.optional(),
});
export type LearnerEpisode = z.infer<typeof episode>;
const gateObjective = z.object({
  id,
  families: z.array(id).max(100),
  required: z.number().int().nonnegative(),
  passed: z.boolean(),
});
const lesson = z.object({
  id,
  requirement: z.enum(["required", "optional"]),
  status: z.enum(["completed", "placed", "available", "locked"]),
  completedBlockIds: z.array(id).max(500),
  /** Set when a staff exception authorized this completion. */
  exception: z.boolean().optional(),
  gate: z
    .object({
      passed: z.boolean(),
      objectives: z.array(gateObjective).max(200),
      // The server's persisted decision as the learner sees it (SDK 0.5 gates and later).
      status: z
        .enum([
          "ready",
          "needs_evidence",
          "needs_help",
          "under_review",
          "closed_with_gaps",
        ])
        .optional(),
      learnerVisibleReason: z.string().max(8000).optional(),
      criterionResults: z
        .array(
          z.object({
            criterionId: id,
            met: z.union([z.boolean(), z.literal("pending")]),
            reason: z.string().max(4000),
          }),
        )
        .max(50)
        .optional(),
      nextActions: z
        .array(
          z.object({ kind: z.string().max(40), label: z.string().max(2000) }),
        )
        .max(20)
        .optional(),
      review: z
        .object({
          state: z.enum(["open", "upheld", "exception_granted"]),
          reviewerNote: z.string().max(2000).nullable(),
          requestedAt: z.string(),
        })
        .nullable()
        .optional(),
      exception: z.object({ requestId: z.string() }).nullable().optional(),
    })
    .nullable(),
});
export type LearnerLesson = z.infer<typeof lesson>;
const question = z
  .object({
    id,
    type: z.string().max(40),
    prompt: text,
    options: z
      .array(z.object({ id, text: z.string().max(4000) }))
      .max(50)
      .optional(),
    criteria: z
      .array(
        z.object({
          id,
          description: z.string().max(2000),
          required: z.boolean(),
        }),
      )
      .max(50)
      .optional(),
  })
  .passthrough();
const reviewCriterion = z.object({
  id,
  description: z.string().max(2000),
  required: z.boolean(),
  met: z.boolean().nullable(),
  quote: z.string().max(8000).nullable(),
  note: z.string().max(2000).nullable(),
});
const uuidPattern =
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/** Only same-origin learner-view media links are accepted as player sources. */
const viewMediaUrl = (file: string) =>
  new RegExp(
    `^/api/admin/enrollments/${uuidPattern}/learner-view/${uuidPattern}/media/${uuidPattern}/${file}$`,
  );
export const learnerViewSchema = z.object({
  readOnly: z.literal(true),
  view: z.object({
    id: z.string().uuid(),
    viewedAt: z.string(),
    viewer: z.object({
      id,
      name: z.string().max(200),
      role: z.enum(["owner", "admin"]),
    }),
    visibleToLearner: z.literal(true),
  }),
  // The enrollment profile, as the shared privacy rule shows it to staff.
  learner: z.object({
    displayName: z.string().max(200),
    goal: z.string().max(2000).optional(),
    pace: z.string().max(40).optional(),
  }),
  snapshot: z.object({
    enrollmentId: z.string().uuid(),
    revision: z.number().int(),
    status: z.string().max(40),
    profile: z
      .object({
        displayName: z.string().max(200).optional(),
        goal: z.string().max(2000).optional(),
        pace: z.string().max(40).optional(),
      })
      .passthrough(),
    planRevision: z.number().int().nonnegative(),
    adaptationRequirements: z
      .array(
        z
          .object({
            blockId: id,
            episodeId: id,
            classification: z.enum(["required", "optional"]),
            replacesBaseBlock: z.boolean(),
            insertedEpisode: z.boolean().optional(),
          })
          .passthrough(),
      )
      .max(500),
    lessons: z.array(lesson).max(2000),
    complete: z.boolean(),
    nextEpisodeId: id.nullable(),
    course: z
      .object({
        title: z.string().max(500),
        summary: z.string().max(4000),
        objectives: z
          .array(
            z.object({ id, description: z.string().max(2000) }).passthrough(),
          )
          .max(500),
        chapters: z
          .array(
            z.object({
              id,
              title: z.string().max(500),
              summary: z.string().max(4000).optional(),
              episodes: z.array(episode).max(500),
            }),
          )
          .max(200),
        visuals: z
          .array(
            z
              .object({
                id,
                accessibility: z
                  .object({ description: z.string().max(4000) })
                  .passthrough()
                  .optional(),
              })
              .passthrough(),
          )
          .max(200),
        media: z
          .array(
            z
              .object({
                id,
                type: z.string().max(40),
                alternativeMarkdown: text,
                review: z.string().max(40),
              })
              .passthrough(),
          )
          .max(200),
        sources: z
          .array(
            z
              .object({
                id,
                title: z.string().max(500),
                url: z.string().max(2000),
              })
              .passthrough(),
          )
          .max(500),
      })
      .passthrough(),
    recovery: z
      .array(z.object({ episodeId: id }).passthrough())
      .max(500)
      .optional(),
    inaccessibleEpisodeIds: z.array(id).max(2000),
    closureReport: z.unknown().nullable(),
    activeChallenges: z
      .array(
        z.object({
          challengeId: z.string().uuid(),
          episodeId: id,
          question,
          mode: z.string().max(40),
          independentEligible: z.boolean(),
          expiresAt: z.string(),
        }),
      )
      .max(200),
  }),
  personalChanges: z
    .array(
      z.object({
        proposalId: id,
        planRevision: z.number().int(),
        appliedAt: z.string(),
        episodeId: id,
        episodeTitle: z.string().max(500),
        blockId: id,
        kind: z.string().max(80),
        why: z.string().max(4000),
        classification: z.enum(["required", "optional", "unknown"]),
        hideable: z.boolean(),
        hidden: z.boolean(),
      }),
    )
    .max(500),
  reviews: z
    .array(
      z.object({
        attemptId: z.string().uuid(),
        episodeId: id,
        assessmentId: id,
        submittedAt: z.string(),
        status: z.string().max(40),
        reviewedAt: z.string().nullable(),
        learnerNote: z.string().max(2000).nullable(),
        continuesAttemptId: z.string().uuid().nullable(),
        canReply: z.boolean(),
        canAppeal: z.boolean(),
        appeal: z
          .object({
            state: z.string().max(40),
            note: z.string().max(2000).nullable(),
            // Withheld from staff copies under the shared privacy rule: always null here.
            reason: z.string().max(2000).nullable().optional(),
          })
          .nullable(),
        criteria: z.array(reviewCriterion).max(50),
      }),
    )
    .max(50),
  /** Course-made media attached for this learner, as the learner is shown it. The
   * links play only under this recorded view. */
  generatedMedia: z
    .array(
      z.object({
        id: z.string().uuid(),
        episodeId: id,
        title: z.string().max(200),
        objective: z.string().max(2000),
        transcript: z.string().max(20000).nullable(),
        visualDescription: z.string().max(5000).nullable(),
        captions: z.boolean(),
        /** The caption track's language as the reviewer recorded it (BCP 47); null when unknown. */
        captionsLanguage: z
          .string()
          .regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/)
          .nullable()
          .optional(),
        mimeType: z.enum(["video/mp4", "video/webm"]),
        byteLength: z.number().int().nonnegative(),
        reviewedAt: z.string(),
        expiresAt: z.string(),
        state: z.literal("available"),
        assetUrl: z.string().regex(viewMediaUrl("asset")),
        captionsUrl: z
          .string()
          .regex(viewMediaUrl("captions\\.vtt"))
          .nullable(),
      }),
    )
    .max(1000)
    .default([]),
  withheld: z
    .array(
      z.object({ id, label: z.string().max(200), reason: z.string().max(500) }),
    )
    .max(20),
});
export type LearnerView = z.infer<typeof learnerViewSchema>;
export type LearnerViewMedia = LearnerView["generatedMedia"][number];

/** Owner/admin read-only view of one learner's space. Opening it is audited and
 * visible to the learner; the port offers no command of any kind. */
export interface LearnerViewPort {
  open(enrollmentId: string, signal?: AbortSignal): Promise<LearnerView>;
}
export class LearnerViewError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "LearnerViewError";
  }
}
const codes = new Set([
  "FORBIDDEN",
  "ENROLLMENT_NOT_FOUND",
  "ENROLLMENT_ERASED",
  "UNAUTHENTICATED",
]);
export const learnerViewErrorMessage = (
  error: unknown,
  t: Translate = englishTranslator().t,
) =>
  t(
    error instanceof LearnerViewError && codes.has(error.code)
      ? (`learnerView.error.${error.code}` as MessageKey)
      : "learnerView.error.unavailable",
  );
