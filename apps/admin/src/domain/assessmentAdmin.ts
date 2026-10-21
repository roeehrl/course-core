import { z } from "zod";
import { englishTranslator, type MessageKey, type Translate } from "../i18n";

/** Answer keys, rubrics and test answers of a course's questions (Q09). Keys reveal answers, so
 * the server sends them to course writers only. */
const text = (max: number) => z.string().max(max);
const criterion = z.object({
  id: text(128),
  description: text(2000),
  required: z.boolean(),
});
export const assessmentItemSchema = z.object({
  assessmentId: text(200),
  type: text(40),
  prompt: text(8000),
  objectiveIds: z.array(text(200)).max(50),
  familyId: text(200),
  fixtures: z.number().int().nonnegative(),
  kind: z.enum(["key", "item_rubric", "course_rubric", "not_editable"]),
  editable: z.boolean(),
  options: z
    .array(z.object({ id: text(200), text: text(2000) }))
    .max(50)
    .optional(),
  steps: z
    .array(z.object({ id: text(200), prompt: text(2000) }))
    .max(100)
    .optional(),
  key: z.record(z.string(), z.unknown()).optional(),
  criteria: z.array(criterion).max(12).optional(),
  rubricId: text(200).optional(),
});
export type AssessmentItem = z.infer<typeof assessmentItemSchema>;
export const assessmentListSchema = z.object({
  release: z.object({
    id: z.string().uuid(),
    version: text(100),
    status: text(40),
    digest: text(64),
    editable: z.boolean(),
  }),
  items: z.array(assessmentItemSchema).max(2000),
  rubrics: z
    .array(
      z.object({
        id: text(200),
        version: text(40),
        title: text(400),
        criteria: z.array(criterion).max(12),
        usedBy: z.array(text(200)).max(2000),
      }),
    )
    .max(500),
});
export type AssessmentList = z.infer<typeof assessmentListSchema>;
const outcome = z.enum([
  "correct",
  "incorrect",
  "invalid_answer",
  "not_runnable",
  "item_missing",
]);
export const fixtureResultSchema = z.object({
  fixtureId: z.string().uuid(),
  assessmentId: text(200),
  label: text(200),
  expected: z.enum(["correct", "incorrect"]),
  outcome,
  status: z.enum(["passed", "failed", "not_runnable"]),
  before: outcome.optional(),
  changed: z.boolean().optional(),
});
export type FixtureResult = z.infer<typeof fixtureResultSchema>;
export const keyImpactSchema = z.object({
  results: z.array(fixtureResultSchema).max(2000),
  failing: z.number().int(),
  changed: z.number().int(),
});
export type KeyImpact = z.infer<typeof keyImpactSchema>;
export const fixtureListSchema = z.object({
  fixtures: z
    .array(
      z.object({
        fixtureId: z.string().uuid(),
        assessmentId: text(200),
        label: text(200),
        answer: z.unknown(),
        expected: z.enum(["correct", "incorrect"]),
        createdAt: z.string(),
        createdBy: text(200).optional(),
      }),
    )
    .max(2000),
  limits: z.object({ perItem: z.number().int(), perCourse: z.number().int() }),
});
export type Fixture = z.infer<typeof fixtureListSchema>["fixtures"][number];
export const fixtureRunSchema = z.object({
  runId: z.string().uuid(),
  passed: z.number().int(),
  failed: z.number().int(),
  notRunnable: z.number().int(),
  results: z.array(fixtureResultSchema).max(2000),
});
export type FixtureRun = z.infer<typeof fixtureRunSchema>;
export const fixtureRunsSchema = z.object({
  runs: z
    .array(
      z.object({
        runId: z.string().uuid(),
        releaseId: z.string().uuid(),
        releaseVersion: text(100),
        passed: z.number().int(),
        failed: z.number().int(),
        notRunnable: z.number().int(),
        stale: z.boolean(),
        at: z.string(),
        by: text(200),
        results: z.array(fixtureResultSchema).max(2000).optional(),
      }),
    )
    .max(20),
});
export type FixtureRuns = z.infer<typeof fixtureRunsSchema>;

export interface AssessmentAdminPort {
  list(
    catalogId: string,
    releaseId: string,
    signal?: AbortSignal,
  ): Promise<AssessmentList>;
  previewKey(
    catalogId: string,
    releaseId: string,
    assessmentId: string,
    grading: unknown,
  ): Promise<KeyImpact>;
  saveKey(
    catalogId: string,
    releaseId: string,
    assessmentId: string,
    input: {
      grading: unknown;
      expectedDigest: string;
      acceptFailingFixtures: boolean;
    },
  ): Promise<KeyImpact & { digest: string }>;
  saveRubric(
    catalogId: string,
    releaseId: string,
    rubricId: string,
    input: {
      criteria: { id: string; description: string; required: boolean }[];
      version?: string;
      expectedDigest: string;
    },
  ): Promise<{ digest: string }>;
  fixtures(
    catalogId: string,
    signal?: AbortSignal,
  ): Promise<z.infer<typeof fixtureListSchema>>;
  addFixture(
    catalogId: string,
    input: {
      releaseId: string;
      assessmentId: string;
      answer: unknown;
      expected: "correct" | "incorrect";
      label: string;
    },
  ): Promise<FixtureResult>;
  removeFixture(catalogId: string, fixtureId: string): Promise<unknown>;
  run(catalogId: string, releaseId: string): Promise<FixtureRun>;
  runs(catalogId: string, signal?: AbortSignal): Promise<FixtureRuns>;
}
export class AssessmentAdminError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "AssessmentAdminError";
  }
}
/** The refusal in the caller's language, saying what to do; unknown codes get the generic message. */
export const assessmentErrorMessage = (
  error: unknown,
  t: Translate = englishTranslator().t,
) => {
  const code = error instanceof AssessmentAdminError ? error.code : "";
  const key = `assessmentAdmin.error.${code}` as MessageKey;
  return code && englishTranslator().has(key)
    ? t(key)
    : t("assessmentAdmin.error.unavailable");
};
