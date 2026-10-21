import type { ServerSnapshot } from "./apiClient";
import type { Course, LearnerSnapshot } from "../domain/types";
import { englishTranslator, type Translate } from "../i18n";

/** Id of the on-screen placement panel, which the roadmap's placement card points to. */
export const PLACEMENT_PANEL_ID = "placement-run";

export function presentation(
  server: ServerSnapshot,
  /** Whether the placement panel is actually on screen (offered before study, in
   * progress, or finished awaiting a choice). The roadmap's placement card points
   * to that panel, so it is shown only while the panel exists. */
  options: { placementOpen?: boolean; t?: Translate } = {},
): {
  course: Course;
  snapshot: LearnerSnapshot;
} {
  const t = options.t ?? englishTranslator().t;
  const course: Course = {
    id: server.course.id,
    version: server.course.version,
    title: server.course.title,
    description: server.course.summary,
    ...(server.course.stages?.length
      ? { stages: server.course.stages.map(({ id, title, summary }) => ({ id, title, ...(summary ? { summary } : {}) })) }
      : {}),
    sections: server.course.chapters.map((chapter) => ({
      id: chapter.id,
      title: chapter.title,
      description: chapter.summary ?? "",
      ...(chapter.stageId ? { stageId: chapter.stageId } : {}),
      ...(chapter.subtitle ? { subtitle: chapter.subtitle } : {}),
      ...(chapter.iconAsset ? { iconAsset: chapter.iconAsset } : {}),
      lessonIds: chapter.episodes.map((episode) => episode.id),
    })),
    lessons: server.course.chapters.flatMap((chapter) =>
      chapter.episodes.map((episode) => ({
        id: episode.id,
        title: episode.title,
        description: episode.objectiveIds
          .map(
            (id) =>
              server.course.objectives.find((row) => row.id === id)
                ?.description ?? "",
          )
          .join(" "),
        minutes: Math.max(
          1,
          Math.ceil(
            episode.blocks
              .filter((block) => block.type === "text")
              .reduce(
                (sum, block) =>
                  sum +
                  (block.type === "text"
                    ? block.markdown.split(/\s+/).length
                    : 0),
                0,
              ) / 150,
          ),
        ),
        requirement: episode.requirement === 'optional' ? 'optional' as const : 'required' as const,
        ...(server.adaptationRequirements?.some((r) => r.insertedEpisode && r.episodeId === episode.id) ? { personal: true } : {}),
        steps: episode.blocks
          .filter((block) => block.type === "text" || block.type === "visual" || block.type === "media")
          .map((block, index) => ({
            id: block.id,
            kind: "reading" as const,
            title: t("presentation.part", { number: index + 1 }),
            requirement:
              (block.type === "media" && !block.required) ||
              server.adaptationRequirements?.some(
                (r) => r.episodeId === episode.id && r.blockId === block.id && r.classification === "optional",
              )
                ? ("optional" as const)
                : ("required" as const),
            eyebrow: chapter.title,
            heading: episode.title,
            body: block.type === "text" ? block.markdown : "",
            companion: {
              idea: t("presentation.companionIdea"),
              hint: "",
            },
          })),
      })),
    ),
  };
  const next = server.course.chapters
    .flatMap((chapter) => chapter.episodes)
    .find((episode) => episode.id === server.nextEpisodeId);
  if (
    options.placementOpen &&
    server.course.placement?.enabled &&
    next?.objectiveIds.every((id) =>
      server.course.placement!.objectiveIds.includes(id),
    )
  ) {
    course.placement = {
      title: t("presentation.placement.title"),
      description: t("presentation.placement.description"),
      question: "",
      options: [],
    };
  }
  return {
    course,
    snapshot: {
      mode: "connected",
      revision: String(server.revision),
      profile: server.profile,
      lessons: Object.fromEntries(
        server.lessons.map((lesson) => [
          lesson.id,
          {
            status: lesson.status,
            completedStepIds: lesson.completedBlockIds,
            ...(lesson.gate?.status === "under_review" ? { underReview: true } : {}),
          },
        ]),
      ),
    },
  };
}
