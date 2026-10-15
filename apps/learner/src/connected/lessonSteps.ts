import type { ContentBlock, Episode, StepStatus } from "@course-core/sdk";
import type { ServerSnapshot } from "../client/apiClient";

/** One step of a connected lesson as the learner sees it. The status words are
 * the SDK's seven step statuses; they describe the server snapshot and never
 * decide progress themselves. */
export interface LessonStepView {
  id: string;
  /** "Part 2 · Video", "Independent check", "Finish". */
  title: string;
  status: StepStatus;
}

export const stepStatusLabels: Record<StepStatus, string> = {
  required: "Required",
  optional_help: "Optional help",
  completed: "Completed",
  current: "Current",
  locked: "Locked",
  under_review: "Under review",
  closed_with_gaps: "Closed with gaps",
};
/** Shape cues that go with the words, so status is never colour alone. */
export const stepStatusMarks: Record<StepStatus, string> = {
  required: "○",
  optional_help: "◇",
  completed: "✓",
  current: "●",
  locked: "⊘",
  under_review: "…",
  closed_with_gaps: "◐",
};

type Readable = Extract<ContentBlock, { type: "text" | "visual" | "media" }>;
const kindNames: Record<Readable["type"], string> = {
  text: "Reading",
  visual: "Illustration",
  media: "Video",
};

export function isReadable(block: ContentBlock): block is Readable {
  return (
    block.type === "text" || block.type === "visual" || block.type === "media"
  );
}

/** True when the block is optional for this learner: an optional media block, or
 * one the learner's applied study plan classifies as optional. */
function optionalBlock(
  server: ServerSnapshot,
  episode: Episode,
  block: Readable,
) {
  if (block.type === "media" && !block.required) return true;
  return Boolean(
    server.adaptationRequirements?.some(
      (row) =>
        row.episodeId === episode.id &&
        row.blockId === block.id &&
        row.classification === "optional",
    ),
  );
}

export function lessonSteps(
  server: ServerSnapshot,
  episode: Episode,
): LessonStepView[] {
  const progress = server.lessons.find((row) => row.id === episode.id);
  const done = new Set(progress?.completedBlockIds ?? []);
  const reading = episode.blocks.filter(isReadable);
  const next = reading.find((block) => !done.has(block.id));
  const finished =
    progress?.status === "completed" || progress?.status === "placed";
  const closed =
    server.inaccessibleEpisodeIds.includes(episode.id) && !finished;
  const gate = progress?.gate;
  const steps: LessonStepView[] = reading.map((block, index) => ({
    id: block.id,
    title: `Part ${index + 1} · ${kindNames[block.type]}`,
    status: done.has(block.id)
      ? "completed"
      : closed
        ? "closed_with_gaps"
        : block.id === next?.id
          ? "current"
          : optionalBlock(server, episode, block)
            ? "optional_help"
            : "required",
  }));
  if (episode.gateId) {
    const passed = Boolean(gate?.passed || gate?.exception);
    steps.push({
      id: "check",
      title: "Independent check",
      status:
        passed || (finished && !gate)
          ? "completed"
          : gate?.status === "under_review"
            ? "under_review"
            : gate?.status === "closed_with_gaps" || closed
              ? "closed_with_gaps"
              : next
                ? "locked"
                : "current",
    });
  }
  const ready = steps.every(
    (step) => step.status === "completed" || step.status === "optional_help",
  );
  steps.push({
    id: "finish",
    title: "Finish this lesson",
    status: finished
      ? "completed"
      : closed
        ? "closed_with_gaps"
        : ready
          ? "current"
          : "locked",
  });
  return steps;
}

/** The learner's place: what to do now, and the next step that needs them. */
export function nowAndNext(steps: LessonStepView[]) {
  const nowIndex = steps.findIndex(
    (step) => step.status === "current" || step.status === "under_review",
  );
  const now = nowIndex >= 0 ? steps[nowIndex] : undefined;
  const next = now
    ? steps
        .slice(nowIndex + 1)
        .find(
          (step) =>
            step.status !== "completed" && step.status !== "optional_help",
        )
    : undefined;
  return { now, next };
}
