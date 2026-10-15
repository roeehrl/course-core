import type { Assessment, ConfidenceCapture, GateDecisionStatus, NextAction } from "@course-core/sdk";
import type { LearnerCourse } from "@course-core/sdk/compiler";
import type { Profile } from "../domain/types";
import type { ClosureReport } from "./policyClient";

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
  activeChallenges: Challenge[];
  lessons: {
    id: string;
    status: "available" | "locked" | "completed" | "placed";
    completedBlockIds: string[];
    gate: null | GateView;
  }[];
}
const errorMessages: Record<string, string> = {
  UNAUTHENTICATED:
    "Your session has expired. Sign in again to resume your saved progress.",
  LOGIN_CODE_INVALID:
    "That sign-in link is expired or has already been used. Request a new link from your administrator.",
  LOGIN_CODES_DISABLED:
    "One-time sign-in links are turned off here. Sign in with your username and password.",
  LOGIN_FAILED: "The username or password is incorrect.",
  LOGIN_THROTTLED:
    "Too many unsuccessful attempts. Wait 15 minutes, then try again.",
  AUTH_BUSY: "Sign-in is busy right now. Try again in a moment.",
  PASSWORD_POLICY: "Use a password of 12 to 1024 characters.",
  PASSWORD_UNCHANGED: "Choose a password different from the current one.",
  PASSWORD_CHANGE_REQUIRED: "Choose a new password to continue.",
  CURRENT_PASSWORD_INCORRECT: "Your current password is incorrect.",
  PASSWORD_NOT_SET:
    "This account has no password yet. Ask your course team to set one.",
  PASSKEY_FAILED:
    "That passkey was not accepted. Sign in with your password, or try another passkey.",
  PASSKEY_CHALLENGE_INVALID: "The passkey request expired. Try again.",
  PASSKEY_REGISTRATION_FAILED:
    "The passkey could not be verified. Try again, or use another device.",
  PASSKEY_ALREADY_REGISTERED: "This passkey is already registered.",
  PASSKEY_LIMIT:
    "You have the maximum number of passkeys. Remove one to add another.",
  PASSKEY_NOT_FOUND: "That passkey no longer exists.",
  PASSKEY_NAME_INVALID: "Use a passkey name of 1 to 100 characters.",
  PASSKEYS_UNAVAILABLE: "Passkeys are not available here. Sign in with your password.",
  REAUTHENTICATION_REQUIRED: "Enter your current password to add a passkey.",
  STALE_REVISION:
    "Your progress changed on another request or device. Refresh before trying again.",
  EVIDENCE_REQUIRED:
    "Complete the remaining independent checks below before finishing this lesson.",
  GATE_NOT_READY:
    "This checkpoint is not ready yet. The next steps below say exactly what is still needed.",
  GATE_DECISION_STALE:
    "Your progress changed in another tab or your study plan was updated. The current checkpoint status is shown below; try again from there.",
  GATE_DECISION_UNLINKED:
    "That checkpoint decision does not belong to this lesson. The current status is shown below.",
  GATE_REVIEW_OPEN:
    "You already asked for a review of this checkpoint. A staff member will respond.",
  GATE_REVIEW_WINDOW_CLOSED:
    "The time to ask for a review of this decision has passed. Your saved work and the decision record are kept.",
  GATE_REVIEW_NOT_OFFERED:
    "This checkpoint does not offer a staff review. Ask your course team if you need help.",
  GATE_DECISION_NOT_REVIEWABLE:
    "This checkpoint's current status cannot be reviewed. The current status is shown below.",
  GATE_EXCEPTION_GRANTED:
    "A staff exception already lets you continue past this checkpoint.",
  REVIEW_REASON_REQUIRED:
    "Say in a sentence or two why you would like this decision reviewed.",
  AGENT_AUTHORED_ANSWER:
    "This answer repeats the companion's words. Write it in your own words; nothing was recorded.",
  ABSTAIN_NOT_ALLOWED:
    "This check needs an attempt. Share what you can; a partial answer is fine.",
  INVALID_CONFIDENCE:
    "Choose a confidence level from the scale shown, or leave it blank.",
  ASSESSMENT_HELP_CONSENT_REQUIRED:
    "Choose whether to keep your independent attempt or switch it to practice before sending this message.",
  CHALLENGE_EXPIRED:
    "This check has expired. Refresh to get the current check; your saved progress is unchanged.",
  PENDING_CORRUPT:
    "A saved request could not be safely recovered. Contact your course team before making another change.",
  NETWORK_UNCERTAIN:
    "The connection was interrupted. Retry the saved request to confirm whether it was received.",
  COVERAGE_REQUIRED: "Finish the reading steps before completing this episode.",
  FRESH_EVIDENCE_ITEM_REQUIRED:
    "This checkpoint needs a new independent question. Your supervisor must prepare and verify one; repeating a revealed answer will not grant credit.",
  DEADLINE_REACHED:
    "This learning window has ended. You can review the closure or any available extension offer.",
  PREREQUISITE_NOT_READY:
    "Finish the current required episode before opening this one.",
  EVALUATOR_NOT_CONFIGURED:
    "The grader is not configured for this exercise yet. Your draft is preserved; no result or credit has been recorded.",
  CODE_EVALUATOR_UNAVAILABLE:
    "The code runner is unavailable or busy. Your draft is preserved and no result has been recorded. Retry the saved request when it is available.",
  CODE_LANGUAGE_UNAVAILABLE:
    "This exercise uses a language the current grader cannot run. Your draft is preserved; no result or credit has been recorded.",
  CODE_FIXTURE_NOT_FOUND:
    "The reference checks for this exercise are not configured. Your draft is preserved; contact your course team.",
  INVALID_CODE_SUBMISSION:
    "The grader could not accept this source. Use Python and keep the solution within 64,000 UTF-8 bytes. Your draft is preserved.",
  STALE_POLICY_REVISION:
    "Your study plan changed. Refresh its dates and review the current offer before deciding.",
  STALE_OFFER:
    "This offer is no longer current. Refresh and review updated terms before accepting.",
  TERMS_CHANGED:
    "The offer terms or remaining allowance changed. Review a refreshed offer before accepting.",
  OFFER_EXPIRED:
    "This extension offer has expired. Your current dates have not been extended.",
  INVALID_OFFER_STATE:
    "This offer no longer needs a decision. Refresh to see its current status.",
  CONSENT_REQUIRED:
    "Review the offer and explicitly accept its terms before continuing.",
  ACCESS_CLOSED:
    "This material is no longer available under the course access policy.",
  HELP_BUDGET_EXHAUSTED:
    "You have used every question this closed course allows. Your saved conversation and course material stay available to read.",
  PENDING_UNCERTAIN:
    "A previous request has not been confirmed. Retry that request before sending a different change.",
};
export class CourseApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    /** Learner-safe facts from the server, such as a refused gate's next actions. */
    readonly details?: Record<string, unknown>,
  ) {
    super(
      errorMessages[code] ??
        "The request could not be completed. Your saved progress has been preserved.",
    );
  }
}
/** True for a request the app (or the page being left) cancelled on purpose:
 * nothing failed, so callers show no error for it. */
export function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}
function abortError() {
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
      idempotencyKey: crypto.randomUUID(),
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
