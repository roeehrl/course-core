import type {
  Course,
  LearnerSnapshot,
  Lesson,
  LocalSession,
  Route,
} from "./types";

export const emptySession = (): LocalSession => ({
  schema: 1,
  route: { screen: "roadmap" },
  drafts: {},
  notes: {},
});
export const draftKey = (lessonId: string, stepId: string) =>
  JSON.stringify([lessonId, stepId]);
export function canOpenStep(
  lesson: Lesson,
  stepId: string,
  snapshot: LearnerSnapshot,
): boolean {
  const progress = snapshot.lessons[lesson.id];
  const index = lesson.steps.findIndex((step) => step.id === stepId);
  if (!progress || progress.status === "locked" || index < 0) return false;
  if (progress.status === "placed") return true;
  return lesson.steps
    .slice(0, index)
    .every(
      (step) =>
        step.requirement === "optional" ||
        progress.completedStepIds.includes(step.id),
    );
}
export function firstOpenStep(
  lesson: Lesson,
  snapshot: LearnerSnapshot,
): string {
  const completed = snapshot.lessons[lesson.id]?.completedStepIds ?? [];
  return (lesson.steps.find(
    (step) => step.requirement === "required" && !completed.includes(step.id),
  ) ?? lesson.steps[0])!.id;
}
export function safeRoute(
  course: Course,
  snapshot: LearnerSnapshot,
  route: Route,
): Route {
  if (route.screen === "roadmap") return route;
  const lesson = course.lessons.find((item) => item.id === route.lessonId);
  if (
    !lesson ||
    !snapshot.lessons[lesson.id] ||
    snapshot.lessons[lesson.id]?.status === "locked"
  )
    return { screen: "roadmap" };
  return {
    screen: "lesson",
    lessonId: lesson.id,
    stepId: canOpenStep(lesson, route.stepId, snapshot)
      ? route.stepId
      : firstOpenStep(lesson, snapshot),
  };
}
export function restoreSession(
  raw: string | null,
  course: Course,
  snapshot: LearnerSnapshot,
): LocalSession {
  const fallback = emptySession();
  try {
    const parsed: unknown = JSON.parse(raw ?? "null");
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !("schema" in parsed) ||
      parsed.schema !== 1
    )
      return fallback;
    const data = parsed as Record<string, unknown>;
    const strings = (value: unknown) =>
      Object.fromEntries(
        Object.entries(value && typeof value === "object" ? value : {}).filter(
          (entry): entry is [string, string] =>
            typeof entry[1] === "string" && entry[1].length <= 4000,
        ),
      );
    const route = data.route as Partial<Route> | undefined;
    const candidate: Route =
      route?.screen === "lesson" &&
      typeof route.lessonId === "string" &&
      typeof route.stepId === "string"
        ? { screen: "lesson", lessonId: route.lessonId, stepId: route.stepId }
        : { screen: "roadmap" };
    return {
      schema: 1,
      route: safeRoute(course, snapshot, candidate),
      drafts: strings(data.drafts),
      notes: strings(data.notes),
    };
  } catch {
    return fallback;
  }
}
export function resumeLesson(
  course: Course,
  snapshot: LearnerSnapshot,
): Lesson | undefined {
  return course.lessons.find(
    (lesson) =>
      lesson.requirement === "required" &&
      snapshot.lessons[lesson.id]?.status === "available",
  );
}
export function effectiveLayout(width: number, height: number, fontScale = 1) {
  const effectiveWidth = width / Math.max(1, fontScale);
  return {
    compact: effectiveWidth < 680,
    companionPane: effectiveWidth >= 1080 && height >= 520,
  };
}
