import { z } from "zod";
import { englishTranslator, type MessageKey, type Translate } from "../i18n";

const count = z.number().int().nonnegative();
export const armBehaviours = ["fixed", "chat_only", "supervisor"] as const;
export type ArmBehaviour = (typeof armBehaviours)[number];
export const instrumentSets = ["pre", "post", "transfer", "delayed"] as const;
export type InstrumentSet = (typeof instrumentSets)[number];
/** The label of an instrument set in the UI locale. */
export const setLabel = (
  set: InstrumentSet,
  t: Translate = englishTranslator().t,
) => t(`studies.set.${set}` as MessageKey);
/** The label of an arm behaviour in the UI locale. */
export const behaviourLabel = (
  behaviour: ArmBehaviour,
  t: Translate = englishTranslator().t,
) => t(`studies.behaviour.${behaviour}` as MessageKey);

const itemList = z.array(z.string().min(1).max(200)).max(50);
export const instrumentsSchema = z.object({
  pre: itemList,
  post: itemList,
  transfer: itemList,
  delayed: itemList,
});
export type Instruments = z.infer<typeof instrumentsSchema>;
export const armSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
  label: z.string().min(1).max(60),
  behaviour: z.enum(armBehaviours),
});
export type StudyArm = z.infer<typeof armSchema>;
/** A study warning: a code with values (services/api/src/study.ts), or older servers' English. */
export const studyWarningSchema = z.union([
  z.string().max(400),
  z.object({
    code: z.string().regex(/^[A-Z][A-Z0-9_]{0,59}$/),
    params: z.record(z.string(), z.string().max(200)).optional(),
  }),
]);
export type StudyWarning = z.infer<typeof studyWarningSchema>;
/** A study warning in the UI locale; an unknown code reads as a generic warning with its code. */
export function studyWarningText(
  warning: StudyWarning,
  t: Translate = englishTranslator().t,
  has: (key: MessageKey) => boolean = englishTranslator().has,
) {
  if (typeof warning === "string") return warning;
  const key = `studies.warning.${warning.code}` as MessageKey;
  if (!has(key)) return t("studies.warning.unknown", { code: warning.code });
  const set = warning.params?.set;
  return t(key, {
    ...warning.params,
    ...(set ? { set: setLabel(set as InstrumentSet, t) } : {}),
  });
}
export const studySchema = z.object({
  id: z.string().uuid(),
  releaseId: z.string().uuid(),
  title: z.string().max(120),
  purpose: z.string().max(2000),
  state: z.enum(["draft", "recruiting", "closed"]),
  revision: z.number().int().min(1),
  arms: z
    .array(
      armSchema.extend({
        explanation: z.string().max(400),
        consented: count,
        withdrawn: count,
      }),
    )
    .min(2)
    .max(6),
  instruments: instrumentsSchema,
  minCellSize: z.number().int().min(1),
  seedDigest: z.string().regex(/^[a-f0-9]{64}$/),
  consent: z.object({
    eligible: count,
    consented: count,
    withdrawn: count,
    undecided: count,
  }),
  createdAt: z.string(),
  openedAt: z.string().nullable(),
  closedAt: z.string().nullable(),
  warnings: z.array(studyWarningSchema).max(200).default([]),
});
export type Study = z.infer<typeof studySchema>;
export const studiesSchema = z.object({
  canManage: z.boolean(),
  canExport: z.boolean(),
  releases: z
    .array(
      z.object({
        id: z.string().uuid(),
        version: z.string().max(100),
        status: z.string().max(20),
        placementEnabled: z.boolean(),
        items: z
          .array(
            z.object({
              id: z.string().max(200),
              type: z.string().max(40),
              role: z.string().max(40).nullable(),
              objectiveIds: z.array(z.string().max(200)).max(100),
              retention: z.boolean(),
            }),
          )
          .max(2000),
      }),
    )
    .max(200),
  studies: z.array(studySchema).max(200),
});
export type Studies = z.infer<typeof studiesSchema>;
export const studyResultSchema = z.object({
  study: studySchema.omit({ warnings: true }),
  warnings: z.array(studyWarningSchema).max(200).optional(),
});
export const allocationCheckSchema = z.object({
  checked: count,
  mismatches: count,
  allocated: count,
  seedDigest: z.string(),
});
export type AllocationCheck = z.infer<typeof allocationCheckSchema>;
export interface StudyDefinitionInput {
  title: string;
  purpose: string;
  arms: StudyArm[];
  instruments: Instruments;
  minCellSize: number;
}
export interface StudyDownload {
  body: string;
  filename: string;
  digest: string;
  contentType: string;
}

export interface StudiesPort {
  list(catalogId: string, signal?: AbortSignal): Promise<Studies>;
  create(
    catalogId: string,
    input: StudyDefinitionInput & { releaseId: string },
  ): Promise<z.infer<typeof studyResultSchema>>;
  update(
    studyId: string,
    input: StudyDefinitionInput & { expectedRevision: number },
  ): Promise<z.infer<typeof studyResultSchema>>;
  transition(
    studyId: string,
    action: "open" | "close",
    expectedRevision: number,
  ): Promise<z.infer<typeof studyResultSchema>>;
  allocationCheck(studyId: string): Promise<AllocationCheck>;
  download(studyId: string, format: "csv" | "json"): Promise<StudyDownload>;
}
export class StudyError extends Error {
  constructor(
    readonly code: string,
    readonly problems: string[] = [],
  ) {
    super(code);
    this.name = "StudyError";
  }
}
const STUDY_CODES = new Set([
  "FORBIDDEN",
  "STALE_REVISION",
  "STUDY_ALREADY_OPEN",
  "STUDY_DEFINITION_LOCKED",
  "STUDY_NOT_DRAFT",
  "STUDY_CLOSED",
  "STUDY_NOT_STARTED",
  "INVALID_REQUEST",
]);
const PROBLEM_CODES = new Set([
  "STUDY_ITEM_UNKNOWN",
  "STUDY_ITEM_IN_TWO_SETS",
  "STUDY_ITEM_REPEATED",
  "STUDY_TRANSFER_ROLE",
  "STUDY_DELAYED_NOT_RETENTION",
  "STUDY_ARM_DUPLICATE",
  "STUDY_PRE_REQUIRED",
  "STUDY_POST_REQUIRED",
]);
export const studyErrorMessage = (
  error: unknown,
  t: Translate = englishTranslator().t,
) => {
  if (error instanceof StudyError && error.problems.length)
    return error.problems
      .map((p) =>
        PROBLEM_CODES.has(p) ? t(`studies.problem.${p}` as MessageKey) : p,
      )
      .join(" ");
  const code = error instanceof StudyError ? error.code : "";
  return STUDY_CODES.has(code)
    ? t(`studies.error.${code}` as MessageKey)
    : t("studies.error.unavailable");
};
/** The three arms the evaluation plan compares (design: fixed vs chat-only vs supervisor).
 * Their default names are in the UI locale of the person who creates the study. */
export const defaultArms = (t: Translate = englishTranslator().t): StudyArm[] =>
  armBehaviours.map((behaviour) => ({
    id: behaviour,
    label: behaviourLabel(behaviour, t),
    behaviour,
  }));
