import type { ContextCapsule } from "@course-core/sdk";
import type { CourseApi, ServerSnapshot } from "./apiClient";
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
export interface CompanionMessage {
  id: string;
  role: "learner" | "assistant";
  content: string;
  context: {
    episodeId?: string;
    blockId?: string | null;
    courseDigest?: string;
    enrollmentRevision?: number;
  };
  created_at: string;
  job_id?: string | null;
  job_state?: string | null;
  job_reason?: string | null;
}
export interface CompanionReceipt {
  messageId: string;
  eventId: string;
  revision: number;
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
    },
  ): Promise<CompanionReceipt>;
}
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
            typeof m.context !== "object",
        )
      )
        throw new Error("Invalid companion message response");
      return result.messages;
    },
    async send(snapshot, input) {
      const result = await api.command<CompanionReceipt>(
        snapshot,
        "companion",
        input,
      );
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
      return result;
    },
  };
}
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
    case "verifying":
    case "ready":
      return "Preparing a reply";
    case "applied":
    case "completed":
    case "succeeded":
    case "done":
      return "Request processed";
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
