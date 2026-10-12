import { canOpenStep } from "../domain/session";
import { validateProfile } from "../domain/profile";
import type {
  Course,
  KeyValueStorage,
  LearnerClient,
  LearnerSnapshot,
  MutationResult,
  RequestContext,
} from "../domain/types";
type Rules = {
  answers: Record<string, string>;
  placement?: { answer: string; lessonId: string };
};
/** Local simulation only. Production authority is never inferred from this store. */
export function createDemoClient(
  course: Course,
  rules: Rules,
  storage: KeyValueStorage,
  key: string,
): LearnerClient {
  const initial = (): LearnerSnapshot => ({
    revision: "0",
    mode: "demo",
    profile: { displayName: "Curious learner", goal: "", pace: "steady" },
    lessons: Object.fromEntries(
      course.lessons.map((lesson, index) => [
        lesson.id,
        {
          status: index === 0 ? "available" : "locked",
          reason: index
            ? "Complete the earlier required lessons to unlock this one."
            : undefined,
          completedStepIds: [],
        },
      ]),
    ),
  });
  let state = initial();
  let receipts: Record<
    string,
    { fingerprint: string; result: MutationResult }
  > = {};
  let loaded = false;
  let busy = false;
  const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
  function derive(snapshot: LearnerSnapshot) {
    let open = true;
    for (const lesson of course.lessons) {
      const progress = snapshot.lessons[lesson.id]!;
      const complete = lesson.steps
        .filter((step) => step.requirement === "required")
        .every((step) => progress.completedStepIds.includes(step.id));
      progress.status =
        progress.status === "placed"
          ? "placed"
          : complete
            ? "completed"
            : open
              ? "available"
              : "locked";
      progress.reason =
        progress.status === "locked"
          ? "Complete the earlier required lessons to unlock this one."
          : undefined;
      if (
        lesson.requirement === "required" &&
        !["completed", "placed"].includes(progress.status)
      )
        open = false;
    }
  }
  const load = async () => {
    if (!loaded) {
      const raw = await storage.getItem(key);
      try {
        const saved = JSON.parse(raw ?? "null");
        if (
          saved?.schema === 1 &&
          saved?.version === course.version &&
          saved.snapshot?.mode === "demo" &&
          !validateProfile(saved.snapshot.profile) &&
          /^\d+$/.test(saved.snapshot.revision)
        ) {
          const next = initial();
          next.revision = saved.snapshot.revision;
          next.profile = saved.snapshot.profile;
          for (const lesson of course.lessons) {
            const progress = saved.snapshot.lessons?.[lesson.id];
            next.lessons[lesson.id]!.completedStepIds = lesson.steps
              .filter((step) => progress?.completedStepIds?.includes(step.id))
              .map((step) => step.id);
            if (
              progress?.status === "placed" &&
              lesson.id === rules.placement?.lessonId
            )
              next.lessons[lesson.id]!.status = "placed";
          }
          derive(next);
          state = next;
          // Local receipts survive reload to keep simulated retries idempotent.
          receipts = Object.fromEntries(
            Object.entries(saved.receipts ?? {}).filter(
              (
                entry,
              ): entry is [
                string,
                { fingerprint: string; result: MutationResult },
              ] => {
                const receipt = entry[1] as {
                  fingerprint?: unknown;
                  result?: MutationResult;
                } | null;
                return (
                  typeof receipt?.fingerprint === "string" &&
                  receipt?.result?.receipt?.authority === "demo"
                );
              },
            ),
          );
        }
      } catch {
        /* Corrupt or obsolete local demo state starts a fresh demo. */
      }
      loaded = true;
    }
    return copy(state);
  };
  async function mutate(
    request: RequestContext,
    fingerprint: string,
    change: (next: LearnerSnapshot) => MutationResult["feedback"],
  ): Promise<MutationResult> {
    if (busy)
      throw new Error("Another update is in progress. Please try again.");
    busy = true;
    try {
      await load();
      if (
        request.courseId !== course.id ||
        request.courseVersion !== course.version
      )
        throw new Error("This course has changed. Reload before continuing.");
      if (receipts[request.idempotencyKey]) {
        if (receipts[request.idempotencyKey]!.fingerprint !== fingerprint)
          throw new Error("This retry does not match the original update.");
        return {
          ...copy(receipts[request.idempotencyKey]!.result),
          snapshot: copy(state),
        };
      }
      if (request.expectedRevision !== state.revision)
        throw new Error("Your progress has changed. Reload before continuing.");
      const next = copy(state);
      const feedback = change(next);
      derive(next);
      next.revision = String(Number(state.revision) + 1);
      const result: MutationResult = {
        snapshot: next,
        feedback,
        receipt: { id: `demo-${next.revision}`, authority: "demo" },
      };
      const nextReceipts = {
        ...Object.fromEntries(Object.entries(receipts).slice(-49)),
        [request.idempotencyKey]: { fingerprint, result },
      };
      await storage.setItem(
        key,
        JSON.stringify({
          schema: 1,
          version: course.version,
          snapshot: next,
          receipts: nextReceipts,
        }),
      );
      state = next;
      receipts = nextReceipts;
      return copy(result);
    } finally {
      busy = false;
    }
  }
  return {
    load,
    submitStep: (request) =>
      mutate(
        request,
        JSON.stringify([
          "step",
          request.lessonId,
          request.stepId,
          request.answer ?? null,
        ]),
        (next) => {
          const lesson = course.lessons.find(
            (item) => item.id === request.lessonId,
          );
          const step = lesson?.steps.find((item) => item.id === request.stepId);
          if (!lesson || !step || !canOpenStep(lesson, request.stepId, next))
            throw new Error(
              "Finish the earlier required steps before opening this step.",
            );
          if (
            step.kind === "choice" &&
            (!rules.answers[`${lesson.id}/${step.id}`] ||
              !step.options.some((option) => option.id === request.answer) ||
              request.answer !== rules.answers[`${lesson.id}/${step.id}`])
          )
            return {
              outcome: "retry",
              message:
                "Not quite. Review the idea and try again. Your place is saved.",
            };
          if (
            step.kind === "reflection" &&
            (request.answer?.trim().length ?? 0) < 8
          )
            return {
              outcome: "retry",
              message:
                "Add a few words to your reflection (at least 8 characters).",
            };
          next.lessons[lesson.id]!.completedStepIds = [
            ...new Set([...next.lessons[lesson.id]!.completedStepIds, step.id]),
          ];
          return {
            outcome: "accepted",
            message:
              step.kind === "reflection"
                ? "Reflection saved in this demo. Its meaning has not been graded."
                : "Demo step complete. Ready for the next small step.",
          };
        },
      ),
    requestPlacement: (request) =>
      mutate(request, JSON.stringify(["placement", request.answer]), (next) => {
        if (!course.placement || !rules.placement)
          throw new Error("Placement is not available for this course.");
        if (request.answer !== rules.placement.answer)
          return {
            outcome: "retry",
            message:
              "Start with the first lesson, or try this optional check again. Nothing has been skipped.",
          };
        const progress = next.lessons[rules.placement.lessonId]!;
        if (progress.status !== "completed") progress.status = "placed";
        return {
          outcome: "accepted",
          message:
            "Demo placement recorded. The first lesson is available to review; your next lesson is ready.",
        };
      }),
    saveProfile: (request) =>
      mutate(
        request,
        JSON.stringify([
          "profile",
          request.profile.displayName,
          request.profile.goal,
          request.profile.pace,
        ]),
        (next) => {
          const error = validateProfile(request.profile);
          if (error) throw new Error(error);
          next.profile = {
            ...request.profile,
            displayName: request.profile.displayName.trim(),
            goal: request.profile.goal.trim(),
          };
          return { outcome: "accepted", message: "Profile saved." };
        },
      ),
  };
}
