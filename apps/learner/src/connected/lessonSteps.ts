import type { ContentBlock, Episode, StepStatus } from "@course-core/sdk";
import type { ServerSnapshot } from "../client/apiClient";
import { englishTranslator, type MessageKey, type Translate } from "../i18n";

/** One step of a connected lesson as the learner sees it. The status words are
 * the SDK's seven step statuses; they describe the server snapshot and never
 * decide progress themselves. */
export interface LessonStepView {
  id: string;
  /** "Part 2 · Video", "Check your understanding", "Finish this lesson". */
  title: string;
  /** What the step is, for counting parts and activities apart. */
  kind: "part" | "activity" | "check" | "finish";
  status: StepStatus;
}

/** The catalog key of each status word; show it with `t(stepStatusLabels[status])`. */
export const stepStatusLabels: Record<StepStatus, MessageKey> = {
  required: "lessonSteps.status.required",
  optional_help: "lessonSteps.status.optional_help",
  completed: "lessonSteps.status.completed",
  current: "lessonSteps.status.current",
  locked: "lessonSteps.status.locked",
  under_review: "lessonSteps.status.under_review",
  closed_with_gaps: "lessonSteps.status.closed_with_gaps",
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
  t: Translate = englishTranslator().t,
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
    kind: "part" as const,
    title: t(`lessonSteps.part.${block.type}`, { number: index + 1 }),
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
  // Interactive activities: done only when the server recorded their completion requirement.
  const activities = episode.blocks.filter((block) => block.type === "activity");
  const firstOpen = activities.find((block) => !done.has(block.id));
  activities.forEach((block, index) =>
    steps.push({
      id: block.id,
      kind: "activity",
      title: t("lessonSteps.activity", { number: index + 1 }),
      status: done.has(block.id)
        ? "completed"
        : closed
          ? "closed_with_gaps"
          : !next && block.id === firstOpen?.id
            ? "current"
            : "required",
    }),
  );
  if (episode.gateId) {
    const passed = Boolean(gate?.passed || gate?.exception);
    steps.push({
      id: "check",
      kind: "check",
      title: t("lessonSteps.check"),
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
    kind: "finish",
    title: t("lessonSteps.finish"),
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
