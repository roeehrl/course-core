import { z } from "zod";
import { englishTranslator, type Translate } from "../i18n";

const count = z.number().int().nonnegative();
export const overviewSchema = z.object({
  catalogId: z.string().uuid(),
  generatedAt: z.string(),
  release: z.object({
    active: z
      .object({
        id: z.string().uuid(),
        version: z.string().max(100),
        status: z.string().max(40),
        digest: z.string().max(128),
        createdAt: z.string(),
      })
      .nullable(),
    counts: z.object({ draft: count, published: count, archived: count }),
    pinnedLearners: z
      .array(
        z.object({
          releaseId: z.string().uuid(),
          version: z.string().max(100).nullable(),
          learners: count,
        }),
      )
      .max(500),
    /** The course updater's latest finding; null when the course has no update source. */
    update: z
      .object({
        availableVersion: z.string().max(128).nullable(),
        lastResult: z.string().max(40).nullable(),
        lastCheckedAt: z.string().nullable(),
        level: z.string().max(20),
      })
      .nullable()
      .optional(),
  }),
  /** Null when the role cannot read enrollments. */
  lifecycle: z.record(z.string(), count).nullable(),
  deadlineRisks: z
    .array(
      z.object({
        enrollmentId: z.string().uuid(),
        learner: z.string().max(200),
        deadline: z.string(),
        daysLeft: z.number().int(),
        remainingEpisodes: count,
      }),
    )
    .max(50)
    .nullable(),
  contentDefects: z
    .object({
      activeReleaseChecksFailing: z
        .array(
          z.object({
            label: z.string().max(200),
            detail: z.string().max(2000),
          }),
        )
        .max(50),
      evidenceInvalidatedLast30Days: count,
    })
    .passthrough(),
  supervisorHealth: z
    .object({
      jobsByState: z.record(z.string(), count),
      failedLast24h: count,
      oldestOpenJobAgeSeconds: count.nullable(),
    })
    .nullable(),
  approvalQueue: z.object({
    writtenAnswers: count,
    secondOpinions: count,
    gateReviews: count,
    generatedMedia: count,
    releases: count,
    providerRequests: count,
  }),
});
export type CourseOverview = z.infer<typeof overviewSchema>;

export const auditSchema = z.object({
  events: z
    .array(
      z.object({
        sequence: z.string().regex(/^[0-9]{1,19}$/),
        id: z.string().uuid(),
        at: z.string(),
        actorKind: z.enum(["learner", "staff", "agent", "system"]),
        actor: z.string().max(200).nullable(),
        type: z.string().max(100),
        enrollmentId: z.string().uuid().nullable(),
        payload: z.record(z.string(), z.unknown()).nullable(),
        payloadWithheld: z.boolean(),
      }),
    )
    .max(200),
  nextBefore: z.string().nullable(),
});
export type AuditPage = z.infer<typeof auditSchema>;
export interface AuditQuery {
  before?: string;
  actorKind?: "learner" | "staff" | "agent" | "system";
  limit?: number;
}

export interface OverviewPort {
  load(catalogId: string, signal?: AbortSignal): Promise<CourseOverview>;
}
export interface AuditPort {
  list(
    workspaceId: string,
    query: AuditQuery,
    signal?: AbortSignal,
  ): Promise<AuditPage>;
}
export class OverviewError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "OverviewError";
  }
}
export const overviewErrorMessage = (
  error: unknown,
  t: Translate = englishTranslator().t,
) =>
  error instanceof OverviewError && error.code === "FORBIDDEN"
    ? t("overview.error.FORBIDDEN")
    : t("overview.error.unavailable");
