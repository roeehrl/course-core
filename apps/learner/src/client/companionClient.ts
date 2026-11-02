import type { ContextCapsule } from "@course-core/sdk";
import { CourseApiError, type CourseApi, type ServerSnapshot } from "./apiClient";
import type { VisualInteractionContext } from "../components/VisualBlock";
import { companionFocus, type FocusSelection } from "./companionFocus";
import { randomId } from "./webCrypto";
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
    /** Assistant messages: Core's hint stands in for a reply it did not keep, because the reply gave
     * away a graded check's answer or could not be checked (a reason code only). */
    checkAnswerWithheld?: string;
    /** Assistant messages: the reply ends by asking the learner something (Core decides, from the
     * stored text; services/api/src/companion-turn.ts). Absent on older rows. */
    asksLearner?: boolean;
    /** Learner messages: the check the learner attached, with its number in the lesson ("Question 2"). */
    attachedCheck?: { challengeId: string; ordinal: number };
    /** Learner messages: what the learner pointed at in the lesson, as the server resolved it. */
    selectedAnchor?: { kind: string; blockId?: string; excerpt?: string; lineStart?: number; lineEnd?: number; label?: string };
    /** Learner messages: the course video and position the learner sent with the question. */
    mediaRef?: { mediaId: string; blockId?: string; playbackSeconds?: number | null };
    /** Learner messages: the open checks this message turned into practice, with their numbers. */
    downgraded?: { challengeId: string; ordinal: number }[];
    downgradedChallengeIds?: string[];
  };
  /** Assistant messages: the learner's vote on the reply and whether they reported it (null: none). */
  feedback?: CompanionFeedback | null;
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
  /** Learner messages: the call for the question ended with no reply and nothing can still
   * settle it (no answer will come); the learner can ask again. */
  job_stalled?: boolean | null;
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
  /** The reply is about a graded check: Core checks all of it before anything is shown, so the
   * stream brings no text and the question says the reply is being checked. */
  checking?: true;
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
  const frame = raw as Partial<{ jobId: unknown; messageId: unknown; offset: unknown; text: unknown; state: unknown; reason: unknown; checking: unknown }> | null;
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
      ...(frame.checking === true || old?.checking ? { checking: true as const } : {}),
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
/** The learner's feedback on a reply, as the conversation reads it (never the comment). */
export type CompanionFeedback = { vote: "helpful" | "not_helpful" | null; reported: boolean };
/** A change to it: the vote (null takes it back), and a comment or a report when given. */
export type CompanionVote = { vote: "helpful" | "not_helpful" | null; comment?: string; report?: boolean };
/** One page of the conversation, oldest first. */
export interface CompanionPage {
  messages: readonly CompanionMessage[];
  /** Older messages remain. */
  earlier: boolean;
  /** The cursor that reads them, or null. */
  before: string | null;
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
      /** An open check the message is about (the check's own "Ask the companion"). */
      challengeId?: string;
    },
  ): Promise<CompanionReceipt>;
  /** The learner's vote on a reply, an optional comment, or a report of a problem. Only the
   * enrollment and its revision of the snapshot are used. */
  vote?(
    snapshot: Pick<ServerSnapshot, "enrollmentId" | "revision">,
    messageId: string,
    input: CompanionVote,
  ): Promise<{ messageId: string; feedback: CompanionFeedback }>;
  /** Messages older than the ones loaded: the page before `before` (a cursor a read returned),
   * whether more remain and the cursor that reads them. */
  loadEarlier?(
    enrollmentId: string,
    before: string,
    signal?: AbortSignal,
  ): Promise<CompanionPage>;
  /** For messages `load` returned: whether older messages remain and the cursor that reads them
   * (undefined when the client does not page). */
  pageOf?(messages: readonly CompanionMessage[]): { earlier: boolean; before: string | null } | undefined;
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
const feedbackValid = (value: unknown): boolean =>
  value === undefined || value === null ||
  (typeof value === "object" &&
    [null, "helpful", "not_helpful"].includes((value as CompanionFeedback).vote) &&
    typeof (value as CompanionFeedback).reported === "boolean");
export function createCompanionClient(
  api: CourseApi,
): ContextualCompanionClient {
  // What each read said about older messages, kept with the messages it returned.
  const pages = new WeakMap<readonly CompanionMessage[], { earlier: boolean; before: string | null }>();
  async function page(id: string, query: string, signal?: AbortSignal): Promise<CompanionPage> {
    const result = await api.request<{ messages: CompanionMessage[]; earlier?: unknown; before?: unknown }>(
      `/api/enrollments/${encodeURIComponent(id)}/companion${query}`,
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
          (m.excluded !== undefined && typeof m.excluded !== "boolean") ||
          !feedbackValid(m.feedback),
      )
    )
      // i18n-ignore: malformed-response diagnostic; callers show their own message
      throw new Error("Invalid companion message response");
    // An API from before paging sends neither: nothing older can be read.
    const before = typeof result.before === "string" && result.before.length <= 200 ? result.before : null;
    return { messages: result.messages, earlier: result.earlier === true && before !== null, before };
  }
  return {
    async load(id, signal) {
      const read = await page(id, "", signal);
      pages.set(read.messages, { earlier: read.earlier, before: read.before });
      return read.messages;
    },
    pageOf: (messages) => pages.get(messages),
    async loadEarlier(id, before, signal) {
      return page(id, `?before=${encodeURIComponent(before)}`, signal);
    },
    async vote(snapshot, messageId, input) {
      // A vote is a small upsert that fences nothing: sent straight, not through the command queue
      // (api.command), so it never holds back a question being sent. A revision that moved on
      // meanwhile is read again once.
      const send = (revision: number) =>
        api.request<{ messageId: string; feedback: CompanionFeedback }>(
          `/api/enrollments/${encodeURIComponent(snapshot.enrollmentId)}/companion/messages/${encodeURIComponent(messageId)}/feedback`,
          "POST",
          { ...input, expectedRevision: revision, idempotencyKey: randomId() },
        );
      let result;
      try {
        result = await send(snapshot.revision);
      } catch (error) {
        if (!(error instanceof CourseApiError) || error.code !== "STALE_REVISION") throw error;
        const current = await api.request<{ revision: number }>(`/api/enrollments/${encodeURIComponent(snapshot.enrollmentId)}`);
        result = await send(current.revision);
      }
      if (!result || result.messageId !== messageId || !feedbackValid(result.feedback) || !result.feedback)
        // i18n-ignore: malformed-response diagnostic; callers show their own message
        throw new Error("Invalid companion feedback receipt");
      return result;
    },
    async send(snapshot, input) {
      // The learner's chosen focus goes with this message only, against this course version.
      const focus = companionFocus.get();
      const result = await api.command<CompanionReceipt>(snapshot, "companion", {
        ...input,
        // A check attached in the companion goes with this message, unless the caller named one.
        ...(focus.check && !input.challengeId ? { challengeId: focus.check.challengeId } : {}),
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
// The companion's states and job labels live in companionStates.ts; re-exported here so callers
// and the app's public index keep importing them from the client.
export {
  companionCanAskAgain,
  companionCanCancel,
  companionCouldNotAnswer,
  companionDraftFor,
  companionHasPending,
  companionHeldByLimit,
  companionJobLabel,
  companionReplyStalled,
  companionReplyStarted,
  companionReplyUnavailable,
  companionState,
  companionStateText,
  companionWithheldNote,
  type CompanionState,
} from "./companionStates";

/** TeX commands read as their symbol in a plain excerpt. */
const TEX_SYMBOLS: Readonly<Record<string, string>> = {
  cdot: "·", times: "×", div: "÷", le: "≤", leq: "≤", ge: "≥", geq: "≥", neq: "≠", ne: "≠", approx: "≈",
  to: "→", rightarrow: "→", leftarrow: "←", pm: "±", infty: "∞", partial: "∂", sum: "Σ", alpha: "α", beta: "β",
  theta: "θ", lambda: "λ", mu: "μ", sigma: "σ", eta: "η", nabla: "∇", ldots: "…", dots: "…",
};
/**
 * A short excerpt as plain text: the Markdown and TeX marks a reply or lesson text may carry are
 * dropped (emphasis, code, headings, lists, links, tables, `$…$`), so "Context used" reads as
 * words, not syntax. Plain text that happens to use `*` or `_` (`2*3*4`, `w_new`) is kept.
 * Not a renderer: formatting is the stored reply's job.
 */
export function plainExcerpt(text: string): string {
  return text
    .replace(/```[^\n]*\n?/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "")
    .replace(/^[ \t]{0,3}>[ \t]?/gm, "")
    .replace(/^[ \t]*(?:[-*+]|\d{1,3}[.)])[ \t]+/gm, "")
    .replace(/^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(?:\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*$/gm, "")
    .replace(/^[ \t]*\|[ \t]*|[ \t]*\|[ \t]*$/gm, "")
    .replace(/\s*\|\s*/g, " · ")
    .replace(/(\*\*|__|~~)(?=\S)([^\n]+?)(?<=\S)\1/g, "$2")
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]+?)(?<=\S)\*(?![\w*])/g, "$1$2")
    .replace(/(^|[^\w])_(?=\S)([^_\n]+?)(?<=\S)_(?!\w)/g, "$1$2")
    .replace(/\$\$([^$]+)\$\$|\$(?=\S)([^$\n]+?)(?<=\S)\$(?!\d)/g, "$1$2")
    .replace(/\\[()[\]]/g, "")
    .replace(/\\(?:text|mathrm|mathbf|mathit|operatorname)\{([^{}]*)\}/g, "$1")
    .replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, "$1/$2")
    .replace(/\\(?:left|right|big|Big|bigg|Bigg)(?=[^a-zA-Z])/g, "")
    .replace(/\\([a-zA-Z]+)/g, (_, name: string) => TEX_SYMBOLS[name] ?? name)
    .replace(/\\([_{}%&#$])/g, "$1")
    .replace(/[{}]/g, "")
    .replace(/^(?:\s*·\s*)+|(?:\s*·\s*)+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
