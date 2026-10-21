import { createDemoPolicyClient } from "./demoPolicyClient";
import {
  demoRun,
  demoSession,
  demoWorkspace,
  type DemoRole,
} from "../data/fixtures";
import {
  profileSchema,
  type AdminClient,
  type CourseWorkspace,
  type MutationContext,
  type MutationResult,
  type Permission,
} from "../domain/contracts";
import { AdminError } from "../domain/errors";
import { isAppLocale } from "@course-core/i18n";
import {
  createAdminTranslator,
  englishTranslator,
  type AdminTranslator,
  type Translate,
} from "../i18n";

const documentTranslators = new Map<string, AdminTranslator>();
/** The demo has no server, so it phrases its simulated server messages in the page's
 * current locale (LocaleProvider keeps `<html lang>` in step with the switcher). */
function documentTranslate(): Translate {
  const lang =
    typeof document === "undefined" ? "" : document.documentElement.lang;
  if (!isAppLocale(lang)) return englishTranslator().t;
  let translator = documentTranslators.get(lang);
  if (!translator)
    documentTranslators.set(lang, (translator = createAdminTranslator(lang)));
  return translator.t;
}

export type DemoScenario =
  "standard" | "permission_denied" | "stale_revision" | "load_failure";
export function createDemoAdminClient({
  role = "administrator",
  scenario = "standard",
  latency = 140,
  translate = documentTranslate,
}: {
  role?: DemoRole;
  scenario?: DemoScenario;
  latency?: number;
  /** The translator for simulated server messages; defaults to the page's locale. */
  translate?: () => Translate;
} = {}): AdminClient {
  const session = demoSession(role);
  const courses = new Map(
    session.courses.map((course) => [course.id, demoWorkspace(course, role)]),
  );
  const receipts = new Map<
    string,
    { fingerprint: string; result: MutationResult }
  >();
  let sequence = 0;
  let staleOnce = scenario === "stale_revision";
  let mutating = false;
  const clone = <T>(value: T): T => structuredClone(value);
  async function delay(signal?: AbortSignal) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (!latency) return;
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", abort);
        resolve();
      }, latency);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }
  function get(id: string): CourseWorkspace {
    const workspace = courses.get(id);
    if (!workspace) throw new AdminError("not_found");
    return workspace;
  }
  function permit(workspace: CourseWorkspace, permission: Permission) {
    if (
      scenario === "permission_denied" ||
      !workspace.permissions.includes(permission)
    )
      throw new AdminError("permission_denied");
  }
  async function mutate(
    courseId: string,
    permission: Permission,
    context: MutationContext,
    payload: unknown,
    change: (workspace: CourseWorkspace) => {
      outcome: MutationResult["receipt"]["outcome"];
      message: string;
    },
  ): Promise<MutationResult> {
    if (mutating) throw new AdminError("unavailable");
    mutating = true;
    try {
      await delay();
      const current = get(courseId);
      permit(current, permission);
      const key = JSON.stringify([courseId, context.idempotencyKey]);
      const fingerprint = JSON.stringify(payload);
      const replay = receipts.get(key);
      if (replay) {
        if (replay.fingerprint !== fingerprint)
          throw new AdminError("validation");
        return { ...clone(replay.result), workspace: clone(current) };
      }
      if (staleOnce) {
        staleOnce = false;
        current.revision = String(Number(current.revision) + 1);
        throw new AdminError("stale_revision");
      }
      if (current.revision !== context.expectedRevision)
        throw new AdminError("stale_revision");
      const next = clone(current);
      const result = change(next);
      next.revision = String(Number(next.revision) + 1);
      const response: MutationResult = {
        workspace: next,
        receipt: {
          id: `demo-receipt-${++sequence}`,
          authority: "demo",
          outcome: result.outcome,
        },
        message: result.message,
      };
      courses.set(courseId, next);
      receipts.set(key, { fingerprint, result: clone(response) });
      return clone(response);
    } finally {
      mutating = false;
    }
  }
  return {
    mode: "demo",
    async getSession(signal) {
      await delay(signal);
      return clone(session);
    },
    async getCourse(id, signal) {
      await delay(signal);
      if (scenario === "permission_denied")
        throw new AdminError("permission_denied");
      if (scenario === "load_failure") throw new AdminError("unavailable");
      return clone(get(id));
    },
    async getRun(id, runId, signal) {
      await delay(signal);
      const workspace = get(id);
      permit(workspace, "run.inspect");
      const run = demoRun(workspace, runId);
      if (!run) throw new AdminError("not_found");
      return clone(run);
    },
    updateCourse: (id, input, context) =>
      mutate(id, "course.write", context, ["course", input], (next) => {
        if (
          !input.title.trim() ||
          input.title.length > 100 ||
          input.description.length > 600
        )
          throw new AdminError("validation");
        next.course = {
          ...next.course,
          title: input.title.trim(),
          description: input.description.trim(),
        };
        return {
          outcome: "saved",
          message: translate()("demoClient.courseSaved"),
        };
      }),
    createRelease: (id, input, context) =>
      mutate(id, "course.write", context, ["release", input], (next) => {
        if (
          !/^\d+\.\d+\.\d+$/.test(input.version) ||
          !input.notes.trim() ||
          input.notes.length > 1200 ||
          next.releases.some((item) => item.version === input.version)
        )
          throw new AdminError("validation");
        next.releases.unshift({
          id: `draft-${++sequence}`,
          ...input,
          state: "draft",
          createdAt: new Date().toISOString(),
          checks: [
            {
              label: translate()("demoClient.check.contentValidation"),
              passed: false,
              detail: translate()("demoClient.check.contentValidation.detail"),
            },
          ],
        });
        return {
          outcome: "saved",
          message: translate()("demoClient.draftCreated"),
        };
      }),
    transitionRelease: (id, releaseId, action, context) =>
      mutate(
        id,
        action === "approve"
          ? "release.review"
          : action === "publish" ||
              action === "activate" ||
              action === "archive"
            ? "release.publish"
            : "course.write",
        context,
        ["transition", releaseId, action],
        (next) => {
          const release = next.releases.find((item) => item.id === releaseId);
          if (!release) throw new AdminError("not_found");
          const expected = {
            "submit-review": "draft",
            approve: "pending_review",
            publish: "approved",
            activate: "published",
            archive: "published",
          }[action];
          if (release.state !== expected)
            throw new AdminError("pending_review");
          if (release.checks.some((check) => !check.passed))
            throw new AdminError("validation");
          if (action === "archive") {
            if (release.availableForNewLearners)
              throw new AdminError("active_release");
            release.state = "archived";
            return {
              outcome: "saved",
              message: translate()("demoClient.releaseArchived"),
            };
          }
          if (action === "publish" || action === "activate")
            for (const item of next.releases)
              item.availableForNewLearners = item.id === releaseId;
          if (action === "activate")
            return {
              outcome: "saved",
              message: translate()("demoClient.releaseActivated"),
            };
          release.state =
            action === "submit-review"
              ? "pending_review"
              : action === "approve"
                ? "approved"
                : "published";
          return {
            outcome:
              action === "publish"
                ? "published"
                : action === "submit-review"
                  ? "pending_review"
                  : "saved",
            message:
              action === "publish"
                ? translate()("demoClient.releasePublished")
                : translate()("demoClient.releaseTransitioned", {
                    state: release.state,
                  }),
          };
        },
      ),
    enroll: (id, input, context) =>
      mutate(id, "enrollment.write", context, ["enroll", input], (next) => {
        if (
          !/^[a-zA-Z0-9_-]{3,80}$/.test(input.learnerRef) ||
          !profileSchema.safeParse(input.profile).success ||
          next.enrollments.some((item) => item.learnerRef === input.learnerRef)
        )
          throw new AdminError("validation");
        const release = next.releases.find(
          (item) =>
            item.state === "published" &&
            (!input.releaseId || item.id === input.releaseId),
        );
        if (!release) throw new AdminError("pending_review");
        next.enrollments.push({
          id: `enrollment-${++sequence}`,
          learnerRef: input.learnerRef,
          profile: input.profile,
          releaseVersion: release.version,
          status: "active",
          completed: 0,
          required: next.course.objectives.length,
          evidence: [],
        });
        return {
          outcome: "saved",
          message: translate()("demoClient.enrollmentCreated"),
        };
      }),
    updateProfile: (id, enrollmentId, profile, context) =>
      mutate(
        id,
        "enrollment.write",
        context,
        ["profile", enrollmentId, profile],
        (next) => {
          const enrollment = next.enrollments.find(
            (item) => item.id === enrollmentId,
          );
          if (!enrollment) throw new AdminError("not_found");
          const parsed = profileSchema.safeParse(profile);
          if (!parsed.success) throw new AdminError("validation");
          enrollment.profile = parsed.data;
          return {
            outcome: "saved",
            message: translate()("demoClient.profileSaved"),
          };
        },
      ),
    reviewEvidence: (id, enrollmentId, evidenceId, input, context) =>
      mutate(
        id,
        "evidence.review",
        context,
        ["evidence", enrollmentId, evidenceId, input],
        (next) => {
          const enrollment = next.enrollments.find(
            (item) => item.id === enrollmentId,
          );
          const evidence = enrollment?.evidence.find(
            (item) => item.id === evidenceId,
          );
          if (!enrollment || !evidence) throw new AdminError("not_found");
          if (evidence.status !== "pending_review")
            throw new AdminError("stale_revision");
          if (!input.note.trim() || input.note.length > 600)
            throw new AdminError("validation");
          evidence.status =
            input.decision === "accept" ? "accepted" : "rejected";
          evidence.receiptId = `demo-evidence-${++sequence}`;
          evidence.summary = translate()("demoClient.evidenceSummary", {
            note: input.note.trim(),
          });
          // Review records a decision; it does not manufacture progression or mastery.
          return {
            outcome: "saved",
            message: translate()("demoClient.evidenceReviewed"),
          };
        },
      ),
    ...createDemoPolicyClient(
      (enrollmentId) => {
        const enrollment = [...courses.values()]
          .flatMap((course) => course.enrollments)
          .find((item) => item.id === enrollmentId);
        if (!enrollment) throw new AdminError("not_found");
        return enrollment;
      },
      (enrollmentId) => {
        const course = [...courses.values()].find((course) =>
          course.enrollments.some((item) => item.id === enrollmentId),
        );
        if (!course) throw new AdminError("not_found");
        permit(course, "extension.propose");
      },
      translate,
    ),
    requestProviderConfig: (id, providerId, input, context) =>
      mutate(
        id,
        "provider.configure",
        context,
        ["provider", providerId, input],
        (next) => {
          const provider = next.providers.find(
            (item) => item.id === providerId,
          );
          if (!provider) throw new AdminError("not_found");
          if (
            !/^[a-zA-Z0-9 _-]{1,60}$/.test(input.connectionLabel) ||
            !/^[a-zA-Z0-9_-]{1,30}$/.test(input.environment)
          )
            throw new AdminError("validation");
          provider.connectionLabel = input.connectionLabel;
          provider.environment = input.environment;
          provider.configuration = "pending_review";
          provider.verification = "not_run";
          provider.detail = translate()("demoClient.provider.detail");
          return {
            outcome: "pending_review",
            message: translate()("demoClient.providerRequested"),
          };
        },
      ),
  };
}
