import {
  CourseApiError,
  type CourseApi,
  type ServerSnapshot,
} from "./apiClient";

export interface SupervisionPermission {
  revision: number;
  permissionRevision: number;
  adaptiveTeaching: boolean;
  authority: "learner_opt_in";
}
export interface SupervisorToolCall {
  id: string;
  jobId: string;
  step: number;
  tool: string;
  createdAt: string;
  jobState: string;
  appliedPlanRevision: number | null;
  outcome: {
    available: boolean | null;
    reason: string | null;
    selected: boolean;
    profileId: string | null;
    entryId: string | null;
    delivery: string | null;
    modelSuggestion?: boolean;
    researchState?: "staged" | "dispatched" | "collected" | "cancelled";
    verification?: "passed" | "rejected" | "unavailable";
    failedCheckIds?: string[];
  };
  contextRefs: {
    messageIds: string[];
    sourceIds: string[];
    modelSourceEventIds?: string[];
  };
}
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const number = (v: unknown, min = 0): v is number =>
  Number.isSafeInteger(v) && (v as number) >= min;
const string = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= 200;
const nullableString = (v: unknown): v is string | null =>
  v === null || string(v);
const ids = (v: unknown, max: number): v is string[] =>
  Array.isArray(v) && v.length <= max && v.every(string);
const invalid = () => new CourseApiError("INVALID_RESPONSE", 502);
export function parsePermission(value: unknown): SupervisionPermission {
  if (
    !object(value) ||
    !number(value.revision, 1) ||
    !number(value.permissionRevision) ||
    typeof value.adaptiveTeaching !== "boolean" ||
    value.authority !== "learner_opt_in"
  )
    throw invalid();
  return {
    revision: value.revision,
    permissionRevision: value.permissionRevision,
    adaptiveTeaching: value.adaptiveTeaching,
    authority: value.authority,
  };
}
export function parseToolCalls(value: unknown): SupervisorToolCall[] {
  if (!object(value) || !Array.isArray(value.calls) || value.calls.length > 50)
    throw invalid();
  return value.calls.map((v) => {
    if (
      !object(v) ||
      !string(v.id) ||
      !string(v.jobId) ||
      !number(v.step) ||
      v.step > 7 ||
      !string(v.tool) ||
      !string(v.jobState) ||
      !string(v.createdAt) ||
      !Number.isFinite(Date.parse(v.createdAt)) ||
      !(v.appliedPlanRevision === null || number(v.appliedPlanRevision, 1))
    )
      throw invalid();
    const o = v.outcome,
      c = v.contextRefs;
    if (
      !object(o) ||
      !(o.available === null || typeof o.available === "boolean") ||
      !nullableString(o.reason) ||
      typeof o.selected !== "boolean" ||
      !nullableString(o.profileId) ||
      !nullableString(o.entryId) ||
      !nullableString(o.delivery) ||
      !(
        o.modelSuggestion === undefined ||
        typeof o.modelSuggestion === "boolean"
      ) ||
      !(
        o.verification === undefined ||
        o.verification === null ||
        ["passed", "rejected", "unavailable"].includes(o.verification as string)
      ) ||
      !(o.failedCheckIds === undefined || ids(o.failedCheckIds, 64)) ||
      !(
        o.researchState === undefined ||
        o.researchState === null ||
        ["staged", "dispatched", "collected", "cancelled"].includes(
          o.researchState as string,
        )
      ) ||
      !object(c) ||
      !ids(c.messageIds, 5) ||
      !ids(c.sourceIds, 500) ||
      !(c.modelSourceEventIds === undefined || ids(c.modelSourceEventIds, 8))
    )
      throw invalid();
    // Pick safe projections explicitly. Provider text and unknown server fields
    // must never sneak into the ordinary learner timeline.
    return {
      id: v.id,
      jobId: v.jobId,
      step: v.step,
      tool: v.tool,
      createdAt: v.createdAt,
      jobState: v.jobState,
      appliedPlanRevision: v.appliedPlanRevision,
      outcome: {
        available: o.available,
        reason: o.reason,
        selected: o.selected,
        profileId: o.profileId,
        entryId: o.entryId,
        delivery: o.delivery,
        modelSuggestion: o.modelSuggestion === true,
        ...(o.researchState
          ? {
              researchState: o.researchState as
                "staged" | "dispatched" | "collected" | "cancelled",
            }
          : {}),
        ...(o.verification
          ? {
              verification: o.verification as
                "passed" | "rejected" | "unavailable",
            }
          : {}),
        ...(o.failedCheckIds
          ? { failedCheckIds: [...(o.failedCheckIds as string[])] }
          : {}),
      },
      contextRefs: {
        messageIds: [...c.messageIds],
        sourceIds: [...c.sourceIds],
        modelSourceEventIds:
          c.modelSourceEventIds === undefined ? [] : [...c.modelSourceEventIds],
      },
    };
  });
}
export function createSupervisionClient(api: CourseApi) {
  const base = (id: string) =>
    `/api/enrollments/${encodeURIComponent(id)}/supervision`;
  return {
    async permission(id: string, signal?: AbortSignal) {
      return parsePermission(
        await api.request(base(id), "GET", undefined, { signal }),
      );
    },
    async tools(id: string, signal?: AbortSignal) {
      return parseToolCalls(
        await api.request(base(id) + "/tools", "GET", undefined, { signal }),
      );
    },
    async setPermission(snapshot: ServerSnapshot, adaptiveTeaching: boolean) {
      return parsePermission(
        await api.command(snapshot, "supervision", { adaptiveTeaching }),
      );
    },
  };
}
export type SupervisionClient = ReturnType<typeof createSupervisionClient>;
