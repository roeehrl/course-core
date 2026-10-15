import type { ContextCapsule } from "@course-core/sdk";
import type { CourseApi, ServerSnapshot } from "./apiClient";
import type { VisualInteractionContext } from "../components/VisualBlock";
import { companionFocus, type FocusSelection } from "./companionFocus";
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
  };
  /** Assistant messages: the capsule its answer was built from (null if not recorded). */
  context_used?: CompanionContextUsed | null;
  /** Learner messages: the learner asked the companion not to use it again. */
  excluded?: boolean;
  created_at: string;
  job_id?: string | null;
  job_state?: string | null;
  job_reason?: string | null;
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
        throw new Error("Invalid companion delete receipt");
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
 * offline, waiting for the learner, building or checking a reply, queued,
 * service unavailable, or available. Never derived from provider text. */
export type CompanionState =
  | "offline"
  | "waiting_for_you"
  | "building"
  | "checking"
  | "queued"
  | "unavailable"
  | "available";
export function companionState(
  messages: readonly CompanionMessage[],
  input: { online: boolean; awaitingChoice: boolean },
): CompanionState {
  if (!input.online) return "offline";
  if (input.awaitingChoice) return "waiting_for_you";
  const open = messages.filter(
    (message) => message.role === "learner" && companionHasPending([message]),
  );
  if (open.some((m) => ["running", "leased", "processing"].includes(m.job_state ?? "")))
    return "building";
  if (open.some((m) => ["verifying", "ready"].includes(m.job_state ?? "")))
    return "checking";
  if (
    open.some(
      (m) =>
        m.job_reason === "configuration_missing" ||
        ["waiting", "budget_wait", "blocked", "deferred", "configuration_pending"].includes(m.job_state ?? ""),
    )
  )
    return "unavailable";
  if (open.length) return "queued";
  return "available";
}
export const companionStateLabel: Record<CompanionState, string> = {
  offline: "Offline · your draft stays here and is sent when you are back online",
  waiting_for_you: "Waiting for your choice",
  building: "Building a reply",
  checking: "Checking the reply before it is shown",
  queued: "Your question is queued",
  unavailable: "Companion service unavailable · your question is saved",
  available: "Available",
};
/** Only known public state labels are shown; provider error/reason text is never surfaced. */
export function companionJobLabel(
  message: CompanionMessage,
): string | undefined {
  if (message.role !== "learner") return;
  if (message.job_reason === "configuration_missing")
    return "Waiting for service configuration · your message is saved";
  switch (message.job_state) {
    case "running":
    case "leased":
    case "processing":
      return "Preparing a reply · building it now";
    case "verifying":
    case "ready":
      return "Preparing a reply · checking it before it is shown";
    case "applied":
    case "completed":
    case "succeeded":
    case "done":
      return "Request processed";
    case "refused":
    case "cancelled":
    case "failed":
    case "dead":
    case "dead_letter":
      return "Reply unavailable · your message is saved";
    case "waiting":
    case "budget_wait":
    case "blocked":
    case "deferred":
    case "configuration_pending":
      return "Waiting for service availability · your message is saved";
    default:
      return "Queued · waiting for a reply";
  }
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
