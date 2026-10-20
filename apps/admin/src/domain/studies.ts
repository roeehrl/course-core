import { z } from "zod";

const count = z.number().int().nonnegative();
export const armBehaviours = ["fixed", "chat_only", "supervisor"] as const;
export type ArmBehaviour = (typeof armBehaviours)[number];
export const instrumentSets = ["pre", "post", "transfer", "delayed"] as const;
export type InstrumentSet = (typeof instrumentSets)[number];
export const setLabels: Record<InstrumentSet, string> = {
  pre: "Pre-test",
  post: "Post-test",
  transfer: "Transfer",
  delayed: "Delayed check",
};
export const behaviourLabels: Record<ArmBehaviour, string> = {
  fixed: "Fixed path",
  chat_only: "Chat-only companion",
  supervisor: "Full supervisor",
};

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
  warnings: z.array(z.string().max(400)).max(200).default([]),
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
  warnings: z.array(z.string().max(400)).max(200).optional(),
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
const messages: Record<string, string> = {
  FORBIDDEN:
    "Your role cannot do this. Owners and admins manage studies and download exports.",
  STALE_REVISION:
    "This study changed since you opened it. Refresh and try again.",
  STUDY_ALREADY_OPEN:
    "This release already has a study in draft or recruiting. Close it before starting another.",
  STUDY_DEFINITION_LOCKED:
    "Recruiting has started, so the arms, instruments and consent text can no longer change.",
  STUDY_NOT_DRAFT: "Only a draft study can be opened.",
  STUDY_CLOSED: "This study is already closed.",
  STUDY_NOT_STARTED: "There is nothing to export until the study opens.",
  INVALID_REQUEST:
    "Check the fields: a title of 3+ characters, a purpose of 20+ characters, 2 to 6 arms with distinct ids and a minimum cell size of 3 to 100.",
};
const problems: Record<string, string> = {
  STUDY_ITEM_UNKNOWN: "An item is not in this release.",
  STUDY_ITEM_IN_TWO_SETS:
    "An item is in two sets; each set needs its own items.",
  STUDY_ITEM_REPEATED: "An item is listed twice in one set.",
  STUDY_TRANSFER_ROLE:
    "A transfer item has a different SDK role (only items marked transfer, or unmarked, qualify).",
  STUDY_DELAYED_NOT_RETENTION:
    "Delayed items must be the course's held-out retention items, so the retention schedule delivers them.",
  STUDY_ARM_DUPLICATE: "Two arms share an id.",
  STUDY_PRE_REQUIRED: "Opening needs at least one pre-test item.",
  STUDY_POST_REQUIRED: "Opening needs at least one post-test item.",
};
export const studyErrorMessage = (error: unknown) => {
  if (error instanceof StudyError && error.problems.length)
    return error.problems.map((p) => problems[p] ?? p).join(" ");
  return (
    messages[error instanceof StudyError ? error.code : ""] ??
    "Studies are unavailable right now. Nothing changed."
  );
};
/** The three arms the evaluation plan compares (design: fixed vs chat-only vs supervisor). */
export const defaultArms = (): StudyArm[] => [
  { id: "fixed", label: "Fixed path", behaviour: "fixed" },
  { id: "chat_only", label: "Chat-only companion", behaviour: "chat_only" },
  { id: "supervisor", label: "Full supervisor", behaviour: "supervisor" },
];
