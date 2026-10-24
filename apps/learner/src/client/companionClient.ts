import type { ContextCapsule } from "@course-core/sdk";
import type { CourseApi, ServerSnapshot } from "./apiClient";
import type { VisualInteractionContext } from "../components/VisualBlock";
import { companionFocus, type FocusSelection } from "./companionFocus";
import { englishTranslator, type MessageKey, type Translate } from "../i18n";
export interface CompanionContext extends Pick<
  ContextCapsule,
  "enrollmentId" | "courseDigest"
> {
  episodeId?: string;
  blockId?: string;
  episodeTitle?: string;
  blockTitle?: string;
  snapshotRevision: number;
  courseTitle: string;
  /** Real active server challenges across the enrollment, not only the visible lesson. */
  independentChallengeIds: readonly string[];
}
/** "Context used" on an answer: what the job answering the question was given. */
export interface CompanionContextUsed {
  episodeId: string;
  blockId: string | null;
  answersMessageId: string | null;
  contextRevision: number;
  courseDigest: string;
  recentEventCursor: string | null;
  history: {
    messageId: string;
    role: "learner" | "assistant";
    excerpt: string;
    clipped: boolean;
    excluded: boolean;
  }[];
  summary: {
    count: number;
    omitted: number;
    sourceEventIds: string[];
    items: {
      messageId: string;
      eventId: string | null;
      excerpt: string;
      excluded: boolean;
    }[];
  } | null;
  selection: {
    kind: string;
    excerpt: string;
    lineStart?: number;
    lineEnd?: number;
  } | null;
  media: { mediaId: string; playbackSeconds: number | null } | null;
  simulation: { blockId: string; settings: number } | null;
  evidenceCount: number;
  assessmentMode: string;
  constraints: {
    deadline: string | null;
    expansionAllowed: boolean;
    independentAssessmentActive: boolean;
    policyRevision: number;
    digest: string;
  };
}
export interface CompanionMessage {
  id: string;
  role: "learner" | "assistant";
  content: string;
  context: {
    episodeId?: string;
    blockId?: string | null;
    courseDigest?: string;
    enrollmentRevision?: number;
    contextRevision?: number;
    /** Assistant messages: the reply reached its length limit and was delivered as far as it got. */
    cutShort?: boolean;
  };
  /** Assistant messages: the capsule its answer was built from (null if not recorded). */
  context_used?: CompanionContextUsed | null;
  /** Learner messages: the learner asked the companion not to use it again. */
  excluded?: boolean;
  created_at: string;
  job_id?: string | null;
  job_state?: string | null;
  job_reason?: string | null;
  /** Learner messages: Core refused the reply it received (a code, never provider text). */
  refusal_reason?: string | null;
  /** Learner messages: a provider call for the question was started, so stopping it later may
   * still count what that call used. False or absent: nothing was sent. */
  job_sent?: boolean | null;
  /** Learner messages held by a spending limit: which one (`workspace`, `enrollment`, `daily`,
   * `artifact`). */
  job_ceiling?: string | null;
}
/** A reply the companion is still writing, streamed over the event stream (`companion-draft`).
 * Not yet checked by Core: shown as a draft and replaced by the stored reply once applied. */
export interface CompanionDraft {
  jobId: string;
  messageId: string;
  text: string;
  state: "streaming" | "complete" | "withdrawn" | "cancelled";
  reason?: string;
  /** Some text of this draft was shown (a withdrawal of nothing shown needs no notice). */
  shown: boolean;
}
const DRAFT_STATES = new Set(["streaming", "complete", "withdrawn", "cancelled"]);
/** The most text a draft may hold; matches the longest reply the server stores. */
export const COMPANION_DRAFT_MAX = 16000;
/**
 * Applies one `companion-draft` frame: its text replaces what is held from its offset on (a
 * reconnect sends offset 0 with the whole draft). A frame that does not fit what is held (a gap)
 * or is malformed is ignored; the next whole-draft frame or the stored reply repairs it.
 */
export function applyDraftFrame(
  drafts: Readonly<Record<string, CompanionDraft>>,
  raw: unknown,
): Readonly<Record<string, CompanionDraft>> {
  const frame = raw as Partial<{ jobId: unknown; messageId: unknown; offset: unknown; text: unknown; state: unknown; reason: unknown }> | null;
  if (
    !frame || typeof frame.jobId !== "string" || typeof frame.messageId !== "string" ||
    !Number.isSafeInteger(frame.offset) || (frame.offset as number) < 0 || typeof frame.text !== "string" ||
    typeof frame.state !== "string" || !DRAFT_STATES.has(frame.state)
  )
    return drafts;
  const old = drafts[frame.jobId], offset = frame.offset as number;
  const held = old?.text ?? "";
  if (offset > held.length) return drafts;
  const text = frame.state === "withdrawn" || frame.state === "cancelled" ? "" : held.slice(0, offset) + frame.text;
  if (text.length > COMPANION_DRAFT_MAX) return drafts;
  return {
    ...drafts,
    [frame.jobId]: {
      jobId: frame.jobId,
      messageId: frame.messageId,
      text,
      state: frame.state as CompanionDraft["state"],
      ...(typeof frame.reason === "string" ? { reason: frame.reason } : {}),
      shown: Boolean(old?.shown || text),
    },
  };
}
export interface CompanionReceipt {
  messageId: string;
  eventId: string;
  revision: number;
  contextRevision?: number;
  state: "queued";
  downgradedChallengeIds: string[];
}
export interface ContextualCompanionClient {
  load(
    enrollmentId: string,
    signal?: AbortSignal,
  ): Promise<readonly CompanionMessage[]>;
  send(
    snapshot: ServerSnapshot,
    input: {
      episodeId: string;
      blockId?: string;
      content: string;
      allowAssessmentAssistance?: true;
      interactiveContext?: VisualInteractionContext;
    },
  ): Promise<CompanionReceipt>;
  /** Delete one of the learner's questions, its answer and what was derived from it. */
  deleteMessage?(
    snapshot: ServerSnapshot,
    messageId: string,
  ): Promise<{ messageId: string; deleted: true; revision: number }>;
  /** Stop waiting for the answer to one of the learner's questions; the question stays. */
  cancelQuestion?(
    snapshot: ServerSnapshot,
    messageId: string,
  ): Promise<{ messageId: string; cancelled: true; revision: number }>;
  /** Stop (or resume) using one of the learner's earlier messages as context. */
  excludeContext?(
    snapshot: ServerSnapshot,
    messageId: string,
    excluded: boolean,
  ): Promise<{ messageId: string; excluded: boolean; revision: number }>;
}
const contextUsedValid = (value: unknown): boolean => {
  if (value === null || value === undefined) return true;
  if (!value || typeof value !== "object") return false;
  const used = value as Partial<CompanionContextUsed>;
  return (
    typeof used.episodeId === "string" &&
    Number.isSafeInteger(used.contextRevision) &&
    Array.isArray(used.history) &&
    used.history.length <= 20 &&
    used.history.every(
      (row) =>
        row &&
        typeof row.messageId === "string" &&
        typeof row.excerpt === "string" &&
        row.excerpt.length <= 200 &&
        typeof row.excluded === "boolean",
    ) &&
    (used.summary === null ||
      (!!used.summary &&
        Array.isArray(used.summary.items) &&
        used.summary.items.length <= 10)) &&
    !!used.constraints &&
    typeof used.constraints.independentAssessmentActive === "boolean"
  );
};
export function createCompanionClient(
  api: CourseApi,
): ContextualCompanionClient {
  return {
    async load(id, signal) {
      const result = await api.request<{ messages: CompanionMessage[] }>(
        `/api/enrollments/${encodeURIComponent(id)}/companion`,
        "GET",
        undefined,
        { signal },
      );
      if (
        !Array.isArray(result.messages) ||
        result.messages.some(
          (m) =>
            !m ||
            typeof m.id !== "string" ||
            !["learner", "assistant"].includes(m.role) ||
            typeof m.content !== "string" ||
            m.content.length > 32000 ||
            !m.context ||
            typeof m.context !== "object" ||
            !contextUsedValid(m.context_used) ||
            (m.excluded !== undefined && typeof m.excluded !== "boolean"),
        )
      )
        // i18n-ignore: malformed-response diagnostic; callers show their own message
        throw new Error("Invalid companion message response");
      return result.messages;
    },
    async send(snapshot, input) {
      // The learner's chosen focus goes with this message only, against this course version.
      const focus = companionFocus.get();
      const result = await api.command<CompanionReceipt>(snapshot, "companion", {
        ...input,
        uiRevision: snapshot.revision,
        ...(focus.selection
          ? {
              selection: {
                ...focusPayload(focus.selection),
                courseDigest: snapshot.courseDigest,
              },
            }
          : {}),
        ...(focus.media
          ? {
              media: {
                mediaId: focus.media.mediaId,
                courseDigest: snapshot.courseDigest,
                ...(focus.media.playbackSeconds !== undefined
                  ? { playbackSeconds: focus.media.playbackSeconds }
                  : {}),
              },
            }
          : {}),
      });
      if (
        !result ||
        result.state !== "queued" ||
        typeof result.messageId !== "string" ||
        typeof result.eventId !== "string" ||
        !Number.isSafeInteger(result.revision) ||
        !Array.isArray(result.downgradedChallengeIds) ||
        result.downgradedChallengeIds.some((id) => typeof id !== "string")
      )
        // i18n-ignore: malformed-response diagnostic; callers show their own message
        throw new Error("Invalid companion receipt");
      companionFocus.clear();
      return result;
    },
    async deleteMessage(snapshot, messageId) {
      const result = await api.command<{ messageId: string; deleted: true; revision: number }>(
        snapshot,
        `companion/messages/${messageId}/delete`,
        {},
      );
      if (!result || result.messageId !== messageId || result.deleted !== true || !Number.isSafeInteger(result.revision))
        // i18n-ignore: malformed-response diagnostic; callers show their own message
        throw new Error("Invalid companion delete receipt");
      return result;
    },
    async cancelQuestion(snapshot, messageId) {
      const result = await api.command<{ messageId: string; cancelled: true; revision: number }>(
        snapshot,
        `companion/messages/${messageId}/cancel`,
        {},
      );
      if (!result || result.messageId !== messageId || result.cancelled !== true || !Number.isSafeInteger(result.revision))
        // i18n-ignore: malformed-response diagnostic; callers show their own message
        throw new Error("Invalid companion cancel receipt");
      return result;
    },
    async excludeContext(snapshot, messageId, excluded) {
      const result = await api.command<{
        messageId: string;
        excluded: boolean;
        revision: number;
      }>(snapshot, "companion/context-exclusions", { messageId, excluded });
      if (
        !result ||
        result.messageId !== messageId ||
        result.excluded !== excluded ||
        !Number.isSafeInteger(result.revision)
      )
        // i18n-ignore: malformed-response diagnostic; callers show their own message
        throw new Error("Invalid companion context receipt");
      return result;
    },
  };
}
function focusPayload(selection: FocusSelection) {
  if (selection.kind === "visual_node")
    return {
      kind: selection.kind,
      blockId: selection.blockId,
      nodeId: selection.nodeId,
    };
  return { ...selection };
}
/** The companion's overall state, from saved messages and the browser:
 * offline, waiting for the learner, building or checking a reply, still
 * working on a question that is waiting for the service, queued, service
 * unavailable (not configured), or available. A question that is waiting
 * never makes the whole companion unavailable: past messages stay readable and
 * the learner can cancel, retry or ask something else. Never derived from
 * provider text. */
export type CompanionState =
  | "offline"
  | "waiting_for_you"
  | "replying"
  | "building"
  | "checking"
  | "paused"
  | "still_working"
  | "queued"
  | "unavailable"
  | "available";
/** Job states of a question whose reply is held up (service busy, budget, uncertain call). */
const WAITING_STATES = ["waiting", "budget_wait", "blocked", "deferred"];
/** Job states while the reply is being built: the provider call is out. */
const RUNNING_STATES = ["running", "leased", "processing", "analyzing", "building", "evaluating"];
/** Job states while a written reply is checked before it is stored. */
const CHECKING_STATES = ["verifying", "ready"];
/** Spending limits a held question can name (supervisor-bridge.ts BudgetCeiling). */
const CEILINGS = ["workspace", "enrollment", "daily", "artifact"];
/** Help is paused for this question: a spending limit holds it back. */
export const companionHeldByLimit = (message: CompanionMessage) =>
  message.role === "learner" && message.job_state === "budget_wait" && CEILINGS.includes(message.job_ceiling ?? "");
/** The reply being written for one question, if the event stream brought one (and it is not yet
 * replaced by the stored reply). */
export function companionDraftFor(
  message: CompanionMessage,
  messages: readonly CompanionMessage[],
  drafts: readonly CompanionDraft[] = [],
): CompanionDraft | undefined {
  if (message.role !== "learner") return;
  return drafts.find((draft) => draft.messageId === message.id &&
    !messages.some((m) => m.role === "assistant" && m.job_id === draft.jobId));
}
/**
 * Whether the reply to a question is under way: its call was sent. That is known from the stream
 * the moment the gateway sends the call (a draft opens, before any text), or from the saved job
 * (running, or a call recorded as started). Then the learner is offered Stop, not "Stop waiting".
 */
export function companionReplyStarted(message: CompanionMessage, draft?: CompanionDraft): boolean {
  if (message.role !== "learner" || message.content === "[deleted]" || !companionHasPending([message])) return false;
  if (draft) return draft.state === "streaming" || draft.state === "complete";
  return RUNNING_STATES.includes(message.job_state ?? "") || CHECKING_STATES.includes(message.job_state ?? "");
}
export function companionState(
  messages: readonly CompanionMessage[],
  input: { online: boolean; awaitingChoice: boolean; drafts?: readonly CompanionDraft[] },
): CompanionState {
  if (!input.online) return "offline";
  if (input.awaitingChoice) return "waiting_for_you";
  // A reply is being written where the learner can see it (its call was sent; the first text may
  // not have arrived yet): one status, not one per word.
  if (input.drafts?.some((draft) => draft.state === "streaming" &&
    !messages.some((m) => m.role === "assistant" && m.job_id === draft.jobId) &&
    messages.some((m) => m.id === draft.messageId && companionHasPending([m]))))
    return "replying";
  const open = messages.filter(
    (message) => message.role === "learner" && companionHasPending([message]),
  );
  if (open.some((m) => RUNNING_STATES.includes(m.job_state ?? "")))
    return "building";
  if (open.some((m) => CHECKING_STATES.includes(m.job_state ?? "")))
    return "checking";
  // A spending limit holds a question: help is paused, said plainly.
  if (open.some(companionHeldByLimit)) return "paused";
  // Only a missing service configuration makes the companion unavailable.
  if (
    open.some(
      (m) =>
        m.job_reason === "configuration_missing" ||
        m.job_state === "configuration_pending",
    )
  )
    return "unavailable";
  if (open.some((m) => WAITING_STATES.includes(m.job_state ?? "")))
    return "still_working";
  if (open.length) return "queued";
  return "available";
}
/** The companion's overall state, in the translator's locale. */
export function companionStateText(state: CompanionState, t: Translate = englishTranslator().t): string {
  return t(`companionClient.state.${state}` as MessageKey);
}
/** Only known public state labels are shown; provider error/reason text is never surfaced.
 * `draft` is the reply being written for this question (companionDraftFor), which is newer than
 * the saved job: a draft that opened means the call was sent. */
export function companionJobLabel(
  message: CompanionMessage,
  t: Translate = englishTranslator().t,
  draft?: CompanionDraft,
): string | undefined {
  if (message.role !== "learner") return;
  if (message.job_reason === "configuration_missing")
    return t("companionClient.job.configurationMissing");
  if (companionCouldNotAnswer(message))
    return t("companionClient.job.couldNotAnswer");
  if (draft && companionHasPending([message])) {
    if (draft.state === "streaming") return t("companionClient.job.writing");
    if (draft.state === "complete") return t("companionClient.job.checking");
    // Stopped by the learner: the call had been sent, so what it used is counted.
    if (draft.state === "cancelled") return t("companionClient.job.cancelledSent");
    // Withdrawn: the draft says why; the saved outcome follows.
    return;
  }
  if (companionHeldByLimit(message))
    return t(message.job_ceiling === "workspace" ? "companionClient.job.pausedWorkspace"
      : message.job_ceiling === "enrollment" ? "companionClient.job.pausedLearner"
        : message.job_ceiling === "artifact" ? "companionClient.job.pausedLessonToday" : "companionClient.job.pausedToday");
  switch (message.job_state) {
    case "running":
    case "leased":
    case "processing":
    case "analyzing":
    case "building":
    case "evaluating":
      return t("companionClient.job.writing");
    case "verifying":
    case "ready":
      return t("companionClient.job.checking");
    case "applied":
    case "completed":
    case "succeeded":
    case "done":
      return t("companionClient.job.processed");
    case "cancelled":
      // Honest about cost: a question stopped after its call was sent may still be charged for
      // what that call used; one cancelled before anything was sent costs nothing.
      return t(message.job_sent ? "companionClient.job.cancelledSent" : "companionClient.job.cancelled");
    case "refused":
    case "failed":
    case "dead":
    case "dead_letter":
      return t("companionClient.job.unavailable");
    case "configuration_pending":
      return t("companionClient.job.configurationMissing");
    case "waiting":
    case "budget_wait":
    case "blocked":
    case "deferred":
      return t("companionClient.job.stillWorking");
    default:
      return t("companionClient.job.queued");
  }
}
/** The reply was produced but refused by Core's checks before it could be shown (a definite end,
 * not a delay): the learner can ask again. */
export function companionCouldNotAnswer(message: CompanionMessage): boolean {
  return message.role === "learner" && message.job_state === "failed" &&
    (message.job_reason === "verification_rejected" || Boolean(message.refusal_reason));
}
/** A pending question the learner may cancel or ask again: queued or held up, not once its reply
 * is under way (a draft opened, or the job is running or checking): that one offers Stop. */
export function companionCanCancel(message: CompanionMessage, draft?: CompanionDraft): boolean {
  return message.role === "learner" && message.content !== "[deleted]" && companionHasPending([message]) && !draft &&
    !companionReplyStarted(message);
}
export function companionHasPending(
  messages: readonly CompanionMessage[],
): boolean {
  return messages.some(
    (message) =>
      message.role === "learner" &&
      ![
        "applied",
        "refused",
        "cancelled",
        "completed",
        "succeeded",
        "done",
        "failed",
        "dead",
        "dead_letter",
      ].includes(message.job_state ?? ""),
  );
}
