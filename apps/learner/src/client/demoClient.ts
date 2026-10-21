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
import { englishTranslator, type Translate } from "../i18n";
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
  /** Messages this simulation produces are in this translator's locale. */
  t: Translate = englishTranslator().t,
): LearnerClient {
  const initial = (): LearnerSnapshot => ({
    revision: "0",
    mode: "demo",
    profile: { displayName: t("demoClient.defaultName"), goal: "", pace: "steady" },
    lessons: Object.fromEntries(
      course.lessons.map((lesson, index) => [
        lesson.id,
        {
          status: index === 0 ? "available" : "locked",
          reason: index ? t("demoClient.locked") : undefined,
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
        progress.status === "locked" ? t("demoClient.locked") : undefined;
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
          !validateProfile(saved.snapshot.profile, t) &&
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
      throw new Error(t("demoClient.error.busy"));
    busy = true;
    try {
      await load();
      if (
        request.courseId !== course.id ||
        request.courseVersion !== course.version
      )
        throw new Error(t("demoClient.error.courseChanged"));
      if (receipts[request.idempotencyKey]) {
        if (receipts[request.idempotencyKey]!.fingerprint !== fingerprint)
          throw new Error(t("demoClient.error.retryMismatch"));
        return {
          ...copy(receipts[request.idempotencyKey]!.result),
          snapshot: copy(state),
        };
      }
      if (request.expectedRevision !== state.revision)
        throw new Error(t("demoClient.error.progressChanged"));
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
            throw new Error(t("demoClient.error.stepLocked"));
          if (
            step.kind === "choice" &&
            (!rules.answers[`${lesson.id}/${step.id}`] ||
              !step.options.some((option) => option.id === request.answer) ||
              request.answer !== rules.answers[`${lesson.id}/${step.id}`])
          )
            return {
              outcome: "retry",
              message: t("demoClient.feedback.retryChoice"),
            };
          if (
            step.kind === "reflection" &&
            (request.answer?.trim().length ?? 0) < 8
          )
            return {
              outcome: "retry",
              message: t("demoClient.feedback.reflectionTooShort", { min: 8 }),
            };
          next.lessons[lesson.id]!.completedStepIds = [
            ...new Set([...next.lessons[lesson.id]!.completedStepIds, step.id]),
          ];
          return {
            outcome: "accepted",
            message:
              step.kind === "reflection"
                ? t("demoClient.feedback.reflectionSaved")
                : t("demoClient.feedback.stepComplete"),
          };
        },
      ),
    requestPlacement: (request) =>
      mutate(request, JSON.stringify(["placement", request.answer]), (next) => {
        if (!course.placement || !rules.placement)
          throw new Error(t("demoClient.error.noPlacement"));
        if (request.answer !== rules.placement.answer)
          return {
            outcome: "retry",
            message: t("demoClient.feedback.placementRetry"),
          };
        const progress = next.lessons[rules.placement.lessonId]!;
        if (progress.status !== "completed") progress.status = "placed";
        return {
          outcome: "accepted",
          message: t("demoClient.feedback.placementRecorded"),
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
          const error = validateProfile(request.profile, t);
          if (error) throw new Error(error);
          next.profile = {
            ...request.profile,
            displayName: request.profile.displayName.trim(),
            goal: request.profile.goal.trim(),
          };
          return { outcome: "accepted", message: t("demoClient.feedback.profileSaved") };
        },
      ),
  };
}
