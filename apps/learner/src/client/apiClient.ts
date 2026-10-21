import type { Assessment, ConfidenceCapture, GateDecisionStatus, NextAction } from "@course-core/sdk";
import type { LearnerCourse } from "@course-core/sdk/compiler";
import type { Profile } from "../domain/types";
import type { ClosureReport } from "./policyClient";
import { useEffect } from "react";
import { englishTranslator, useT, type MessageKey, type Translate } from "../i18n";
import { randomId } from "./webCrypto";

/** What every learner-visible question may carry: "I don't know" is offered unless the author
 * turned it off, and confidence is captured only when the item declares a scale. */
interface QuestionCommon { id: string; prompt: string; allowAbstain?: boolean; confidence?: ConfidenceCapture }
export type Criterion = { id: string; description: string; required: boolean };
export type Question = QuestionCommon & (
  | { type: "choice"; options: { id: string; text: string }[] }
  | { type: "numeric" | "prediction"; unit?: string }
  | { type: "trace"; steps: { id: string; prompt: string }[] }
  | Pick<Extract<Assessment, { type: "code" }>, "type" | "language" | "starterCode">
  | Pick<Extract<Assessment, { type: "code_repair" }>, "type" | "language" | "starterCode">
  | { type: "rubric" | "counterexample" | "experiment_design" | "teach_back"; criteria: Criterion[] });
/** A sentence of a gate decision as a message code with parameters (see the API's gates.ts). */
export interface GateMessage { code: string; params?: Record<string, string | number | string[]>; detail?: GateMessage }
export interface GateMessages { reason: GateMessage; criteria: Record<string, GateMessage>; actions: (GateMessage | null)[] }
/** A server gate decision as the lesson shows it. The server recomputes it at every advance. */
export interface GateView {
  passed: boolean;
  objectives: { id: string; families: string[]; required: number; passed: boolean }[];
  status?: GateDecisionStatus;
  gateId?: string;
  gateVersion?: string;
  learnerVisibleReason?: string;
  criterionResults?: { criterionId: string; kind?: string; met: boolean | "pending"; reason: string }[];
  nextActions?: NextAction[];
  /** The same reason, criteria and next steps as message codes, shown in the learner's language. */
  messages?: GateMessages | null;
  decisionId?: string | null;
  /** The learner's latest request for a staff review of this gate. */
  review?: { requestId: string; state: "open" | "upheld" | "exception_granted"; reviewerNote: string | null; requestedAt: string; decidedAt: string | null } | null;
  /** A standing staff exception: the learner may advance although the decision is not ready. */
  exception?: { requestId: string; grantedAt: string | null } | null;
}
export interface Challenge {
  challengeId: string;
  episodeId: string;
  question: Question;
  independentEligible: boolean;
  mode: string;
  expiresAt?: string;
}
export interface ClosedRecordNotice {
  evidenceId: string;
  assessmentId: string;
  objectiveId: string;
  reason: string | null;
  withdrawnAt: string;
}
export interface ServerSnapshot {
  enrollmentId: string;
  revision: number;
  profile: Profile;
  courseDigest: string;
  planRevision?:number;
  adaptationRequirements?: { episodeId: string; blockId: string; classification: "required" | "optional"; insertedEpisode?: boolean }[];
  recovery?:{episodeId:string;required:true;freshCheck:{objectiveId:string;familyId:string;plannedMinutes:number;additionalEpisodes:number}|null}[];
  status: string;
  complete: boolean;
  closureReport?: ClosureReport | null;
  /** Evidence withdrawn after the course closed (for example a defective item). The course is
   * not reopened; the closure report stays as it was recorded. */
  closedRecordNotices?: ClosedRecordNotice[];
  nextEpisodeId: string | null;
  course: LearnerCourse;
  inaccessibleEpisodeIds: string[];
  /** The research-study version in force, when the learner joined one; null or absent otherwise. */
  studyArm?: { label: string; behaviour: "fixed" | "chat_only" | "supervisor"; companion: boolean; supervision: boolean } | null;
  activeChallenges: Challenge[];
  lessons: {
    id: string;
    status: "available" | "locked" | "completed" | "placed";
    completedBlockIds: string[];
    gate: null | GateView;
  }[];
}
/** API error codes this client explains, each with an `apiClient.error.<CODE>` message. */
const EXPLAINED_CODES = new Set([
  "UNAUTHENTICATED",
  "LOGIN_CODE_INVALID",
  "LOGIN_CODES_DISABLED",
  "LOGIN_FAILED",
  "LOGIN_THROTTLED",
  "AUTH_BUSY",
  "PASSWORD_POLICY",
  "PASSWORD_UNCHANGED",
  "PASSWORD_CHANGE_REQUIRED",
  "CURRENT_PASSWORD_INCORRECT",
  "PASSWORD_NOT_SET",
  "PASSKEY_FAILED",
  "PASSKEY_CHALLENGE_INVALID",
  "PASSKEY_REGISTRATION_FAILED",
  "PASSKEY_ALREADY_REGISTERED",
  "PASSKEY_LIMIT",
  "PASSKEY_NOT_FOUND",
  "PASSKEY_NAME_INVALID",
  "PASSKEYS_UNAVAILABLE",
  "REAUTHENTICATION_REQUIRED",
  "STALE_REVISION",
  "EVIDENCE_REQUIRED",
  "GATE_NOT_READY",
  "GATE_DECISION_STALE",
  "GATE_DECISION_UNLINKED",
  "GATE_REVIEW_OPEN",
  "GATE_REVIEW_WINDOW_CLOSED",
  "GATE_REVIEW_NOT_OFFERED",
  "GATE_DECISION_NOT_REVIEWABLE",
  "GATE_EXCEPTION_GRANTED",
  "REVIEW_REASON_REQUIRED",
  "AGENT_AUTHORED_ANSWER",
  "ABSTAIN_NOT_ALLOWED",
  "INVALID_CONFIDENCE",
  "ASSESSMENT_HELP_CONSENT_REQUIRED",
  "CHALLENGE_EXPIRED",
  "PENDING_CORRUPT",
  "NETWORK_UNCERTAIN",
  "COVERAGE_REQUIRED",
  "FRESH_EVIDENCE_ITEM_REQUIRED",
  "DEADLINE_REACHED",
  "PREREQUISITE_NOT_READY",
  "EVALUATOR_NOT_CONFIGURED",
  "CODE_EVALUATOR_UNAVAILABLE",
  "CODE_LANGUAGE_UNAVAILABLE",
  "CODE_FIXTURE_NOT_FOUND",
  "INVALID_CODE_SUBMISSION",
  "STALE_POLICY_REVISION",
  "STALE_OFFER",
  "TERMS_CHANGED",
  "OFFER_EXPIRED",
  "INVALID_OFFER_STATE",
  "CONSENT_REQUIRED",
  "ACCESS_CLOSED",
  "HELP_BUDGET_EXHAUSTED",
  "PENDING_UNCERTAIN",
]);
/** The translator `CourseApiError.message` reads at the moment it is read. The host sets it
 * to the UI locale (`useApiErrorLocale`); otherwise messages are English. */
let activeTranslate: Translate | undefined;
export function setApiErrorTranslator(t: Translate | undefined) {
  activeTranslate = t;
}
/** Keeps `CourseApiError.message` in the current UI locale while the calling component is mounted. */
export function useApiErrorLocale() {
  const t = useT();
  activeTranslate = t;
  useEffect(() => {
    activeTranslate = t;
    return () => {
      if (activeTranslate === t) activeTranslate = undefined;
    };
  }, [t]);
}
/** The UI translator set by the host, or English: for messages built outside React. */
export function activeTranslator(): Translate {
  return activeTranslate ?? englishTranslator().t;
}
/** The learner-facing explanation of an API error code, in the translator's locale. */
export function apiErrorMessage(code: string, t: Translate = activeTranslator()) {
  return EXPLAINED_CODES.has(code)
    ? t(`apiClient.error.${code}` as MessageKey)
    : t("apiClient.error.generic");
}
export class CourseApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    /** Learner-safe facts from the server, such as a refused gate's next actions. */
    readonly details?: Record<string, unknown>,
  ) {
    super();
    // Read on access, so a message shown after a language change is in the new language.
    Object.defineProperty(this, "message", {
      get: () => apiErrorMessage(code),
      configurable: true,
      enumerable: false,
    });
  }
}
/** True for a request the app (or the page being left) cancelled on purpose:
 * nothing failed, so callers show no error for it. */
export function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}
function abortError() {
  // i18n-ignore: AbortError marker, callers show nothing for it
  const error = new Error("Request cancelled");
  error.name = "AbortError";
  return error;
}
/** Leaving the page (reload or navigation) cancels the app's reads cleanly.
 * Panels refresh in the background; a read the browser itself has to cancel, or
 * one started after navigation begins, is reported by WebKit as "Fetch API cannot
 * load … due to access control checks" although the app handles the failure.
 * From `beforeunload` on, reads are aborted as an ordinary AbortError instead and
 * new ones are not sent. Writes are untouched: the pending-command record already
 * resolves an interrupted write after the reload. If the page stays (a cancelled
 * navigation, or a restore from the back/forward cache), the next interaction or
 * `pageshow` re-enables reads. */
const departure = (() => {
  let controller = new AbortController();
  const target = typeof window === "undefined" ? undefined : window;
  if (typeof target?.addEventListener === "function") {
    const rearm = () => {
      if (controller.signal.aborted) controller = new AbortController();
    };
    target.addEventListener("beforeunload", () => controller.abort());
    // Mobile Safari often skips beforeunload; pagehide is its reliable signal.
    target.addEventListener("pagehide", () => controller.abort());
    target.addEventListener("pageshow", rearm);
    target.addEventListener("pointerdown", rearm, true);
    target.addEventListener("keydown", rearm, true);
  }
  return { signal: () => controller.signal };
})();
/** Aborts when the page starts to leave (see `departure`); for long-lived reads
 * such as the event stream that do not go through `request`. */
export const pageDepartureSignal = () => departure.signal();
/** One signal that aborts when either input does; `release` detaches it from
 * the long-lived page signal once the request settles. */
function eitherSignal(a: AbortSignal | undefined, b: AbortSignal) {
  const both = new AbortController(), stop = () => both.abort();
  a?.addEventListener("abort", stop, { once: true });
  b.addEventListener("abort", stop, { once: true });
  if (a?.aborted) both.abort();
  return {
    signal: both.signal,
    release: () => {
      a?.removeEventListener("abort", stop);
      b.removeEventListener("abort", stop);
    },
  };
}
/** Reported in the event envelope; keep equal to app.json's expo.version. */
export const LEARNER_APP_VERSION = "0.1.0";
export function createCourseApi(
  options: {
    fetch?: typeof fetch;
    csrf?: () => string;
    pending?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
    accountId?: string;
    onStorageUnavailable?: () => void;
  } = {},
) {
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  const csrf =
    options.csrf ??
    (() =>
      typeof document === "undefined"
        ? ""
        : (document.cookie
            .split("; ")
            .find((value) => value.startsWith("course_csrf="))
            ?.slice("course_csrf=".length) ?? ""));
  type Pending = {
    semantic: string;
    idempotencyKey: string;
    expectedRevision: number;
  };
  const memory = new Map<string, Pending | null>();
  const recovered = new Map<
    string,
    { action: string; data: Record<string, unknown>; result: unknown }
  >();
  let warned = false;
  function warnStorage() {
    if (!warned) {
      warned = true;
      options.onStorageUnavailable?.();
    }
  }
  const pendingKey = (id: string) =>
    // i18n-ignore: storage key
    `course:pending:${options.accountId ?? "current"}:${id}`;
  /** Keys whose latest record could not be written to storage: this page's
   * memory is then the only, and authoritative, copy. */
  const unsaved = new Set<string>();
  function readPending(key: string): Pending | null {
    // Storage is shared with this account's other tabs (and survives a closed
    // tab), so it is read every time; memory is only the fallback.
    if (!options.pending || unsaved.has(key)) return memory.get(key) ?? null;
    let raw: string | null = null;
    try {
      raw = options.pending.getItem(key);
    } catch {
      warnStorage();
      return memory.get(key) ?? null;
    }
    if (!raw) {
      memory.delete(key);
      return null;
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new CourseApiError("PENDING_CORRUPT", 0);
    }
    const p = value as Pending | null;
    if (
      !p ||
      typeof p.semantic !== "string" ||
      typeof p.idempotencyKey !== "string" ||
      p.idempotencyKey.length < 8 ||
      !Number.isSafeInteger(p.expectedRevision) ||
      p.expectedRevision < 0
    )
      throw new CourseApiError("PENDING_CORRUPT", 0);
    memory.set(key, p);
    return p;
  }
  let clientSequence = 0;
  function writePending(key: string, value: Pending | null) {
    memory.set(key, value);
    try {
      if (value) options.pending?.setItem(key, JSON.stringify(value));
      else options.pending?.removeItem(key);
      unsaved.delete(key);
    } catch {
      unsaved.add(key);
      warnStorage();
    }
    if (!options.pending) warnStorage();
  }
  async function request<T>(
    url: string,
    method = "GET",
    payload?: unknown,
    transport: { signal?: AbortSignal } = {},
  ): Promise<T> {
    const leaving = method === "GET" ? departure.signal() : undefined;
    if (leaving?.aborted) throw abortError();
    const combined = leaving ? eitherSignal(transport.signal, leaving) : undefined;
    const signal = combined?.signal ?? transport.signal;
    try {
      return await send<T>(url, method, payload, signal);
    } finally {
      combined?.release();
    }
  }
  async function send<T>(url: string, method: string, payload: unknown, signal: AbortSignal | undefined): Promise<T> {
    let response: Response;
    // Event envelope facts for the learning events this request may record (advisory; see event-envelope.ts).
    const envelope: Record<string, string> =
      method === "GET"
        ? {}
        : {
            "X-Course-Platform": "web",
            "X-Course-App-Version": LEARNER_APP_VERSION,
            "X-Course-Client-Sequence": String(++clientSequence),
            "X-Course-Occurred-At": new Date().toISOString(),
          };
    try {
      response = await fetcher(url, {
        method,
        signal,
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        headers: {
          Accept: "application/json",
          ...(payload === undefined
            ? {}
            : { "Content-Type": "application/json" }),
          ...(method === "GET" ? {} : { "X-CSRF-Token": csrf() }),
          ...envelope,
        },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      });
    } catch {
      if (signal?.aborted) throw abortError();
      throw new CourseApiError("NETWORK_UNCERTAIN", 0);
    }
    const data = await response.json().catch(() => null);
    if (signal?.aborted && data === null) throw abortError();
    if (!response.ok)
      throw new CourseApiError(
        typeof data?.error === "string" ? data.error : "UNAVAILABLE",
        response.status,
        data?.details && typeof data.details === "object" ? data.details : undefined,
      );
    if (!data || typeof data !== "object")
      throw new CourseApiError("INVALID_RESPONSE", 502);
    return data as T;
  }
  async function command<T>(
    snapshot: ServerSnapshot,
    action: string,
    data: Record<string, unknown>,
  ): Promise<T> {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/.test(action))
      throw new CourseApiError("INVALID_ACTION", 400);
    const semantic = JSON.stringify({ action, data }),
      // i18n-ignore: storage key
      storageKey = `course:pending:${options.accountId ?? "current"}:${snapshot.enrollmentId}`;
    let pending: Pending | undefined;
    const previous = readPending(storageKey);
    if (
      previous &&
      typeof previous.semantic === "string" &&
      typeof previous.idempotencyKey === "string" &&
      Number.isSafeInteger(previous.expectedRevision)
    ) {
      if (previous.semantic !== semantic)
        throw new CourseApiError("PENDING_UNCERTAIN", 0);
      pending = previous;
    }
    pending ??= {
      semantic,
      idempotencyKey: randomId(),
      expectedRevision: snapshot.revision,
    };
    writePending(storageKey, pending);
    try {
      const result = await request<T>(
        `/api/enrollments/${encodeURIComponent(snapshot.enrollmentId)}/${action}`,
        "POST",
        {
          ...data,
          expectedRevision: pending.expectedRevision,
          idempotencyKey: pending.idempotencyKey,
        },
      );
      writePending(storageKey, null);
      return result;
    } catch (error) {
      if (
        error instanceof CourseApiError &&
        error.status >= 400 &&
        error.status < 500
      ) {
        writePending(storageKey, null);
      }
      throw error;
    }
  }
  async function resumePending(enrollmentId: string) {
    const previous = readPending(pendingKey(enrollmentId));
    if (!previous) return;
    let operation: { action: string; data: Record<string, unknown> };
    try {
      operation = JSON.parse(previous.semantic);
    } catch {
      throw new CourseApiError("PENDING_CORRUPT", 0);
    }
    if (
      !operation ||
      typeof operation.action !== "string" ||
      !operation.data ||
      typeof operation.data !== "object" ||
      Array.isArray(operation.data)
    )
      throw new CourseApiError("PENDING_CORRUPT", 0);
    try {
      const result = await command(
        { enrollmentId, revision: previous.expectedRevision } as ServerSnapshot,
        operation.action,
        operation.data,
      );
      recovered.set(enrollmentId, { ...operation, result });
    } catch (error) {
      if (!(
        error instanceof CourseApiError &&
        error.status >= 400 &&
        error.status < 500
      ))
        throw error;
    }
  }
  return {
    request,
    command,
    resumePending,
    hasPending: (enrollmentId: string) =>
      Boolean(readPending(pendingKey(enrollmentId))),
    /** The action of the saved, unconfirmed request (for wording only), or null. */
    pendingAction: (enrollmentId: string): string | null => {
      const pending = readPending(pendingKey(enrollmentId));
      if (!pending) return null;
      try {
        const action = (JSON.parse(pending.semantic) as { action?: unknown }).action;
        return typeof action === "string" ? action : "";
      } catch {
        return "";
      }
    },
    takeRecovered: (enrollmentId: string) => {
      const result = recovered.get(enrollmentId);
      recovered.delete(enrollmentId);
      return result;
    },
    load: async (enrollmentId: string) => {
      await resumePending(enrollmentId);
      return request<ServerSnapshot>(
        `/api/enrollments/${encodeURIComponent(enrollmentId)}`,
      );
    },
  };
}
export type CourseApi = ReturnType<typeof createCourseApi>;
