import { z } from "zod";
import { packagePreviewSchema } from "./coursePackages";

const text = z.string().max(4000);
const ids = z.array(z.string().max(200)).max(2000);
export const updateLevelSchema = z.enum(["off", "check", "install", "publish"]);
export type UpdateLevel = z.infer<typeof updateLevelSchema>;
export const updatesViewSchema = z.object({
  revision: z.number().int().nonnegative(),
  source: z
    .union([
      z.object({ kind: z.literal("github"), url: text }),
      z.object({ kind: z.literal("path"), directoryId: z.string(), directory: text.nullable(), subpath: text }),
    ])
    .nullable(),
  settings: z.object({
    level: updateLevelSchema,
    intervalHours: z.number().int().positive(),
    autoApproveRegistry: z.boolean(),
    acknowledgedBy: text.nullable(),
    acknowledgedAt: text.nullable(),
  }),
  status: z
    .object({
      lastCheckedAt: text.nullable(),
      lastTrigger: text.nullable(),
      lastResult: text.nullable(),
      lastErrorCode: text.nullable(),
      availableVersion: text.nullable(),
      consecutiveFailures: z.number().int().nonnegative(),
      nextCheckAt: text.nullable(),
    })
    .nullable(),
  newestInstalled: text.nullable(),
  directories: z.array(z.object({ id: z.string(), name: text })).max(16),
  remoteFetch: z.enum(["github", "off"]),
  permissions: z.object({ configure: z.boolean(), install: z.boolean(), publish: z.boolean() }),
});
export type UpdatesView = z.infer<typeof updatesViewSchema>;
export const releaseDiffSummarySchema = z.object({
  from: z.object({ version: text }),
  to: z.object({ version: text }),
  identical: z.boolean(),
  changes: z.number().int().nonnegative(),
  kinds: z.record(z.string(), z.object({ added: ids, removed: ids, changed: ids, unchanged: z.number().int().nonnegative() })),
});
export const checkResultSchema = z.object({
  outcome: z.union([
    z.object({ result: z.literal("up_to_date"), version: text, newestInstalled: text.nullable() }),
    z.object({
      result: z.literal("update_available"),
      version: text,
      sha256: z.string(),
      newestInstalled: text.nullable(),
      preview: packagePreviewSchema,
      diff: releaseDiffSummarySchema.nullable(),
    }),
    z.object({ result: z.literal("failed"), code: text }),
  ]),
  updates: updatesViewSchema,
});
export type CheckResult = z.infer<typeof checkResultSchema>;
export type UpdateSourceInput = { kind: "github"; url: string } | { kind: "path"; directoryId: string; subpath: string } | { kind: "none" };
export interface CourseUpdatesPort {
  get(courseId: string, signal?: AbortSignal): Promise<UpdatesView>;
  saveSource(courseId: string, expectedRevision: number, source: UpdateSourceInput): Promise<UpdatesView>;
  saveSettings(
    courseId: string,
    input: { expectedRevision: number; level: UpdateLevel; intervalHours: number; acknowledgePublish?: boolean; autoApproveRegistry?: boolean },
  ): Promise<UpdatesView>;
  check(courseId: string): Promise<CheckResult>;
}
