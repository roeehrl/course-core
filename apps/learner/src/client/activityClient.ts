import type { CourseApi } from "./apiClient";

export type ActivityTarget = "web_desktop" | "web_mobile";
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export interface ActivityBudget { timeoutMs: number; maxMemoryMb: number; maxStateBytes: number; maxEventBytes: number; maxEventsPerMinute: number }
/** A running activity instance as the server describes it. Server-only wiring (the evaluator)
 * is never part of it; state is present only when the activity was granted state.read. */
export interface ActivityRun {
  mode: "run";
  instanceId: string;
  activityId: string;
  title: string;
  execution: "declarative" | "sandboxed_web";
  target: ActivityTarget;
  grantedCapabilities: string[];
  state: JsonObject | null;
  stateRevision: number;
  configuration: JsonObject;
  budget: ActivityBudget;
  accessibility: { keyboard: boolean; screenReader: boolean; reducedMotion: boolean; nonPointerPath: boolean; textAlternative: string };
  evaluated: boolean;
  satisfied: boolean;
  frameUrl?: string;
}
export interface ActivityFallback { mode: "fallback"; activityId: string; fallback: { kind: "activity" | "assessment" | "text_block"; ref: string } }
export interface ObservationResult {
  observationId: string;
  evaluation: { status: "not_evaluated" | "passed" | "not_passed" | "unavailable"; explanation?: string };
  satisfied: boolean;
}

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Only Core's own same-origin frame route may be framed. */
export const FRAME_PATH = /^\/api\/activity-frames\/[a-z][a-z0-9._:-]{0,127}\/[0-9A-Za-z.+-]{1,64}$/;

/** Strictly re-validates a launch response; anything unexpected is refused, not rendered. */
export function parseLaunch(data: unknown): ActivityRun | ActivityFallback {
  if (!isObject(data)) throw new Error("INVALID_ACTIVITY");
  if (data.mode === "fallback") {
    const fallback = data.fallback;
    if (!isObject(fallback) || typeof fallback.ref !== "string" || !["activity", "assessment", "text_block"].includes(fallback.kind as string) || typeof data.activityId !== "string")
      throw new Error("INVALID_ACTIVITY");
    return { mode: "fallback", activityId: data.activityId, fallback: { kind: fallback.kind as ActivityFallback["fallback"]["kind"], ref: fallback.ref } };
  }
  const budget = data.budget, accessibility = data.accessibility;
  if (data.mode !== "run" || typeof data.instanceId !== "string" || !UUID.test(data.instanceId) || typeof data.activityId !== "string" || typeof data.title !== "string"
    || (data.execution !== "declarative" && data.execution !== "sandboxed_web") || (data.target !== "web_desktop" && data.target !== "web_mobile")
    || !Array.isArray(data.grantedCapabilities) || !data.grantedCapabilities.every((c) => typeof c === "string")
    || !(data.state === null || isObject(data.state)) || !Number.isSafeInteger(data.stateRevision) || !isObject(data.configuration)
    || !isObject(budget) || !["timeoutMs", "maxStateBytes", "maxEventBytes", "maxEventsPerMinute"].every((k) => Number.isSafeInteger(budget[k]))
    || !isObject(accessibility) || typeof accessibility.textAlternative !== "string"
    || typeof data.evaluated !== "boolean" || typeof data.satisfied !== "boolean")
    throw new Error("INVALID_ACTIVITY");
  if (data.execution === "sandboxed_web" && (typeof data.frameUrl !== "string" || !FRAME_PATH.test(data.frameUrl))) throw new Error("INVALID_ACTIVITY");
  return data as unknown as ActivityRun;
}

export function createActivityClient(api: Pick<CourseApi, "request">) {
  const base = (enrollmentId: string) => `/api/enrollments/${encodeURIComponent(enrollmentId)}`;
  return {
    launch: async (enrollmentId: string, episodeId: string, blockId: string, target: ActivityTarget) =>
      parseLaunch(await api.request(`${base(enrollmentId)}/activities`, "POST", { episodeId, blockId, target })),
    /** One broker call. The server re-checks the grant; a denial is an error with code ACTIVITY_CAPABILITY_DENIED. */
    call: <T>(enrollmentId: string, instanceId: string, capability: string, payload: JsonValue, extra: { expectedStateRevision?: number; idempotencyKey?: string } = {}) =>
      api.request<T>(`${base(enrollmentId)}/activity-instances/${encodeURIComponent(instanceId)}/calls`, "POST", {
        capability, payload, idempotencyKey: extra.idempotencyKey ?? crypto.randomUUID(),
        ...(extra.expectedStateRevision === undefined ? {} : { expectedStateRevision: extra.expectedStateRevision }),
      }),
  };
}
export type ActivityClient = ReturnType<typeof createActivityClient>;
