import { z } from "zod";

/** Course-declared admin sections (SDK defineAdminSection), rendered by Core from their
 * settings schema. The server decides who sees a section and who may change each setting. */
export const sectionScopeSchema = z.enum(["course", "chapter", "enrollment"]);
export type SectionScope = z.infer<typeof sectionScopeSchema>;
const text = (max: number) => z.string().max(max);
const common = {
  id: text(200),
  label: text(400),
  description: text(4000).nullable(),
  scope: sectionScopeSchema,
  mutationPermission: text(100),
  source: z.enum(["saved", "default"]),
  discardedSavedValue: z.boolean(),
  canEdit: z.boolean(),
};
export const sectionSettingSchema = z.discriminatedUnion("type", [
  z.object({
    ...common,
    type: z.literal("boolean"),
    default: z.boolean(),
    value: z.boolean(),
  }),
  z.object({
    ...common,
    type: z.enum(["integer", "number"]),
    default: z.number(),
    minimum: z.number(),
    maximum: z.number(),
    value: z.number(),
  }),
  z.object({
    ...common,
    type: z.literal("string"),
    default: z.string(),
    maxLength: z.number().int().nonnegative(),
    value: z.string(),
  }),
  z.object({
    ...common,
    type: z.literal("enum"),
    default: z.string(),
    options: z.array(text(400)).max(500),
    value: z.string(),
  }),
]);
export type SectionSetting = z.infer<typeof sectionSettingSchema>;
export const adminSectionSchema = z.object({
  id: text(200),
  version: text(100),
  title: text(400),
  description: text(4000).nullable(),
  learnerDataAccess: z.enum(["none", "aggregate", "scoped_with_consent"]),
  learnerDataShared: z.literal(false),
  renderer: z.object({
    kind: z.literal("core_schema_form"),
    declaredRendererRef: text(200).nullable(),
    declaredRendererLoaded: z.literal(false),
  }),
  scopes: z.array(sectionScopeSchema).max(3),
  scope: sectionScopeSchema,
  scopeRef: text(200),
  revision: z.number().int().nonnegative(),
  savedForVersion: text(100).nullable(),
  updatedAt: z.string().nullable(),
  settings: z.array(sectionSettingSchema).max(200),
});
export type AdminSectionView = z.infer<typeof adminSectionSchema>;
export const sectionListSchema = z.object({
  release: z.object({ id: z.string(), version: text(100) }).nullable(),
  sections: z
    .array(z.object({ id: text(200), version: text(100), title: text(400) }))
    .max(100),
  chapters: z.array(z.object({ id: text(200), title: text(400) })).max(1000),
});
export type AdminSectionList = z.infer<typeof sectionListSchema>;
export const sectionReadSchema = z.object({
  release: z.object({ id: z.string(), version: text(100) }),
  section: adminSectionSchema,
});
export const sectionWriteSchema = z.object({ section: adminSectionSchema });

export interface SectionTarget {
  scope: SectionScope;
  scopeRef: string;
}
export interface AdminSectionsPort {
  list(catalogId: string, signal?: AbortSignal): Promise<AdminSectionList>;
  read(
    catalogId: string,
    sectionId: string,
    target: SectionTarget,
    signal?: AbortSignal,
  ): Promise<z.infer<typeof sectionReadSchema>>;
  save(
    catalogId: string,
    sectionId: string,
    input: SectionTarget & {
      expectedRevision: number;
      values: Record<string, boolean | number | string>;
    },
  ): Promise<z.infer<typeof sectionWriteSchema>>;
}

export class AdminSectionError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "AdminSectionError";
  }
}
const messages: Record<string, string> = {
  FORBIDDEN: "Your role cannot open this section or change this setting.",
  STALE_REVISION:
    "Someone changed these settings since you opened them. Reload and try again.",
  ADMIN_SETTING_INVALID:
    "A value is outside what the course allows. Nothing was saved.",
  ADMIN_SETTING_UNKNOWN:
    "The course no longer declares one of these settings. Reload.",
  ADMIN_SETTING_SCOPE_MISMATCH:
    "A setting belongs to a different level. Reload.",
  ADMIN_SECTION_SCOPE_INVALID:
    "That chapter or learner is not part of this course.",
  ADMIN_SECTION_NOT_FOUND: "The live release no longer declares this section.",
};
export const adminSectionErrorMessage = (error: unknown) =>
  messages[error instanceof AdminSectionError ? error.code : ""] ??
  "Course settings are unavailable. Nothing changed.";

/** Client-side mirror of the server check, to explain a value before it is sent. */
export function settingProblem(
  setting: SectionSetting,
  raw: string | boolean,
): string | null {
  if (setting.type === "boolean") return null;
  if (setting.type === "enum")
    return setting.options.includes(String(raw))
      ? null
      : "Choose one of the options.";
  if (setting.type === "string")
    return String(raw).length > setting.maxLength
      ? `At most ${setting.maxLength} characters.`
      : null;
  const text = String(raw).trim(),
    n = Number(text);
  if (text === "" || !Number.isFinite(n)) return "Enter a number.";
  if (setting.type === "integer" && !Number.isInteger(n))
    return "Enter a whole number.";
  return n < setting.minimum || n > setting.maximum
    ? `Between ${setting.minimum} and ${setting.maximum}.`
    : null;
}
export function settingValue(
  setting: SectionSetting,
  raw: string | boolean,
): boolean | number | string {
  if (setting.type === "boolean") return Boolean(raw);
  if (setting.type === "integer" || setting.type === "number")
    return Number(String(raw).trim());
  return String(raw);
}
