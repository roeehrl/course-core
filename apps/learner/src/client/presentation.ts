import type { ServerSnapshot } from "./apiClient";
import type { Course, LearnerSnapshot } from "../domain/types";

export function presentation(server: ServerSnapshot): {
  course: Course;
  snapshot: LearnerSnapshot;
} {
  const course: Course = {
    id: server.course.id,
    version: server.course.version,
    title: server.course.title,
    subtitle: "One guided path. Understanding at every step.",
    description: server.course.summary,
    sections: server.course.chapters.map((chapter) => ({
      id: chapter.id,
      title: chapter.title,
      description: chapter.summary ?? "",
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
          .filter((block) => block.type === "text")
          .map((block, index) => ({
            id: block.id,
            kind: "reading" as const,
            title: `Read ${index + 1}`,
            requirement: "required" as const,
            eyebrow: chapter.title,
            heading: episode.title,
            body: block.type === "text" ? block.markdown : "",
            companion: {
              idea: "Ask about the current step in the companion.",
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
    server.course.placement?.enabled &&
    next?.objectiveIds.every((id) =>
      server.course.placement!.objectiveIds.includes(id),
    )
  ) {
    course.placement = {
      title: "Already know this material?",
      description:
        "An optional independent placement check can verify eligible objectives.",
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
          { status: lesson.status, completedStepIds: lesson.completedBlockIds },
        ]),
      ),
    },
  };
}
