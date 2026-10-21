// i18n-ignore-file: fictional demo records; issue messages are the server fallback, the view shows them by code
import type {
  AdminClient,
  CourseWorkspace,
  Enrollment,
  Permission,
} from "../domain/contracts";
import { AdminError } from "../domain/errors";
import type {
  PolicySettings,
  PolicySettingsView,
} from "../domain/policyLedger";
import type {
  Allowances,
  BatchPreview,
  BatchRequest,
  Batches,
  CeilingsView,
  OrganizationCeilings,
} from "../domain/policyLevels";
import type { ScopePolicy } from "../domain/policy";
import { demoLearningPolicy } from "../data/policyFixtures";
import { sha256Hex } from "../domain/webCrypto";
import { DEMO_ASSESSMENT_POLICY } from "./demoAssessmentAttempts";

export type DemoPolicyLevelMethods = Pick<
  AdminClient,
  | "getPolicyCeilings"
  | "previewPolicyCeilings"
  | "savePolicyCeilings"
  | "getPolicySettings"
  | "previewPolicySettings"
  | "savePolicySettings"
  | "getAllowances"
  | "previewAccommodationBatch"
  | "applyAccommodationBatch"
  | "getAccommodationBatches"
>;

const DAY = 86_400_000;
/** The demo's fixed "now", so fictional offers and previews stay deterministic. */
const NOW = "2026-10-15T09:00:00.000Z";
const iso = (at: string) => new Date(at).toISOString();
const addDays = (at: string, days: number) =>
  new Date(Date.parse(at) + days * DAY).toISOString();

const defaultCeilings: OrganizationCeilings = {
  timeZone: "UTC",
  hardDeadline: null,
  maxEnrollmentDays: null,
  work: {
    additionalMinutes: null,
    additionalEpisodes: null,
    remediationCyclesPerConcept: null,
  },
  extensionsAllowed: true,
  existingMaterialAccess: "read_only",
};
const defaultSettings: PolicySettings = {
  timeZone: "UTC",
  disambiguation: "compatible",
  hardDeadlineDisambiguation: "reject",
  extensions: {
    approval: "learner",
    offerCooldownHours: 24,
    maxOutstandingOffersPerScope: 1,
    maxOffersPerScope: 6,
    ultimateDeadline: null,
  },
  extensionPools: [],
  headroom: {
    core: { additionalMinutes: 240, additionalEpisodes: 8 },
    finalAssessment: { additionalMinutes: 60, additionalEpisodes: 1 },
  },
  closedQuestionBudget: 3,
  pacing: {
    minutesPerRequiredEpisode: 25,
    finalAssessmentMinutes: 45,
    studyMinutesPerDay: 30,
  },
  assessment: { ...DEMO_ASSESSMENT_POLICY },
};

/** The deadline a scope currently binds for one learner: its window, else its hard deadline. */
const deadlineOf = (scope: ScopePolicy | undefined) =>
  scope?.window?.resolvedDeadline ?? scope?.hardDeadline?.at ?? null;
const nameOf = (enrollment: Enrollment) => enrollment.profile.displayName;

/**
 * In-memory organization limits, course policy settings, cross-learner allowances and batch
 * adjustments for the demo. Previews are checked against the fictional demo policy; nothing
 * here changes a learner's own policy, which the demo policy client owns.
 */
export function createDemoPolicyLevels({
  courses,
  scenario = "standard",
  latency = 140,
}: {
  /** The demo's current course workspaces (read at each call, so edits show up). */
  courses: () => CourseWorkspace[];
  scenario?:
    "standard" | "permission_denied" | "stale_revision" | "load_failure";
  latency?: number;
}): DemoPolicyLevelMethods {
  const clone = <T>(value: T): T => structuredClone(value);
  let staleOnce = scenario === "stale_revision";
  let sequence = 0;
  async function delay(signal?: AbortSignal) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (scenario === "load_failure") throw new AdminError("unavailable");
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
  function course(courseId: string) {
    const found = courses().find((item) => item.course.id === courseId);
    if (!found) throw new AdminError("not_found");
    return found;
  }
  /** Reading needs any policy authority; changing needs policy.write. */
  function permit(workspace: CourseWorkspace, write: boolean) {
    const needed: Permission[] = write
      ? ["policy.write"]
      : ["policy.read", "policy.write", "extension.propose"];
    if (
      scenario === "permission_denied" ||
      !needed.some((p) => workspace.permissions.includes(p))
    )
      throw new AdminError("permission_denied");
  }
  function permitWorkspace(write: boolean) {
    const all = courses();
    if (!all.length) throw new AdminError("not_found");
    // Organization limits span every course: the operator needs the authority on each.
    for (const workspace of all) permit(workspace, write);
  }
  function stale(expected: number, current: number) {
    if (staleOnce) {
      staleOnce = false;
      throw new AdminError("stale_revision");
    }
    if (expected !== current) throw new AdminError("stale_revision");
  }

  // Organization limits.
  const ceilingsState = {
    source: "default" as CeilingsView["source"],
    revision: 0,
    changedAt: null as string | null,
    ceilings: clone(defaultCeilings),
  };
  const ceilingsView = (
    workspaceId: string,
    extra: Partial<CeilingsView> = {},
  ): CeilingsView => ({
    workspaceId,
    source: ceilingsState.source,
    revision: ceilingsState.revision,
    changedAt: ceilingsState.changedAt,
    ceilings: clone(ceilingsState.ceilings),
    defaults: clone(defaultCeilings),
    preview: null,
    impact: [],
    moreCourses: false,
    appliesTo: "new_enrollments",
    ...extra,
  });
  function validCeilings(ceilings: OrganizationCeilings) {
    const counts = [
      ceilings.maxEnrollmentDays,
      ceilings.work.additionalMinutes,
      ceilings.work.additionalEpisodes,
      ceilings.work.remediationCyclesPerConcept,
    ];
    if (
      !ceilings.timeZone ||
      counts.some((n) => n !== null && (!Number.isInteger(n) || n < 0)) ||
      (ceilings.hardDeadline !== null &&
        Number.isNaN(Date.parse(ceilings.hardDeadline)))
    )
      throw new AdminError("validation");
  }
  /** Each course checked against the proposed limits, using the demo policy's dates. */
  function ceilingsImpact(
    ceilings: OrganizationCeilings,
  ): CeilingsView["impact"] {
    return courses().map((workspace) => {
      const issues: CeilingsView["impact"][number]["issues"] = [];
      const enrollment = workspace.enrollments[0];
      const scopes = enrollment ? demoLearningPolicy(enrollment).scopes : [];
      const hard = scopes.find((s) => s.kind === "course")?.hardDeadline?.at;
      if (ceilings.hardDeadline) {
        if (Date.parse(ceilings.hardDeadline) <= Date.parse(NOW))
          issues.push({
            severity: "error",
            code: "DEADLINE_ALREADY_REACHED",
            scopeId: "course",
            deadline: iso(ceilings.hardDeadline),
          });
        else if (hard && Date.parse(hard) > Date.parse(ceilings.hardDeadline))
          issues.push({
            severity: "warning",
            code: "LOOSER_CHILD_DEADLINE",
            scopeId: "course",
            deadline: iso(ceilings.hardDeadline),
          });
      }
      if (
        ceilings.maxEnrollmentDays !== null &&
        ceilings.maxEnrollmentDays < 14
      )
        issues.push({
          severity: "error",
          code: "TIME_ENVELOPE_TOO_SMALL",
          scopeId: "course",
          deadline: null,
        });
      return {
        courseId: workspace.course.id,
        title: workspace.course.title,
        feasible: !issues.some((i) => i.severity === "error"),
        issues,
      };
    });
  }

  // Course policy settings, per course.
  const settingsState = new Map<
    string,
    {
      source: PolicySettingsView["source"];
      revision: number;
      changedAt: string | null;
      settings: PolicySettings;
    }
  >();
  const settingsOf = (courseId: string) => {
    let state = settingsState.get(courseId);
    if (!state)
      settingsState.set(
        courseId,
        (state = {
          source: "default",
          revision: 0,
          changedAt: null,
          settings: clone(defaultSettings),
        }),
      );
    return state;
  };
  const releaseOf = (workspace: CourseWorkspace) =>
    workspace.releases.find((r) => r.state === "published")?.id ?? null;
  const settingsView = (
    workspace: CourseWorkspace,
    preview: PolicySettingsView["preview"] = null,
  ): PolicySettingsView => {
    const state = settingsOf(workspace.course.id);
    return {
      courseId: workspace.course.id,
      source: state.source,
      revision: state.revision,
      changedAt: state.changedAt,
      settings: clone(state.settings),
      defaults: clone(defaultSettings),
      releaseId: releaseOf(workspace),
      appliesTo: "new_enrollments",
      preview,
    };
  };
  /** Required work (three demo episodes at the declared pace) against the course window. */
  function settingsPreview(
    workspace: CourseWorkspace,
    settings: PolicySettings,
  ): NonNullable<PolicySettingsView["preview"]> {
    const issues: NonNullable<
      PolicySettingsView["preview"]
    >["feasibility"]["issues"] = [];
    const {
      minutesPerRequiredEpisode,
      finalAssessmentMinutes,
      studyMinutesPerDay,
    } = settings.pacing;
    if (minutesPerRequiredEpisode === null || studyMinutesPerDay === null)
      issues.push({
        severity: "warning",
        code: "TIME_FIT_UNCHECKED",
        scopeId: "course",
        message: "No study pace or work estimate is declared.",
      });
    else {
      const needed =
        3 * minutesPerRequiredEpisode + (finalAssessmentMinutes ?? 0);
      // 2026-10-12 to the course hard deadline (2026-12-01): 50 days.
      const available = 50 * studyMinutesPerDay;
      if (needed > available)
        issues.push({
          severity: "error",
          code: "TIME_ENVELOPE_TOO_SMALL",
          scopeId: "course",
          message: "The required work does not fit before this deadline.",
          deadline: "2026-12-01T17:00:00.000Z",
          neededMinutes: needed,
          availableMinutes: available,
        });
    }
    const ultimate = settings.extensions.ultimateDeadline;
    if (ultimate && Date.parse(ultimate) <= Date.parse(NOW))
      issues.push({
        severity: "error",
        code: "DEADLINE_ALREADY_REACHED",
        scopeId: "course",
        message: "A deadline that binds required work has already passed.",
        deadline: iso(ultimate),
      });
    const enrollment = workspace.enrollments[0];
    const scopes = enrollment ? demoLearningPolicy(enrollment).scopes : [];
    const course = scopes.find((s) => s.kind === "course");
    const pools = [
      ...(course
        ? [
            {
              poolId: "course:calendar",
              unit: "calendar_day",
              total: 10,
              maxPerGrant: 5,
              maxGrants: 2,
              scopeIds: ["course"],
              unusableScopeIds: [],
              source: "course" as const,
            },
          ]
        : []),
      ...settings.extensionPools.map((pool) => ({
        poolId: pool.id,
        unit: pool.unit,
        total: pool.total,
        maxPerGrant: pool.maxPerGrant,
        maxGrants: pool.maxGrants,
        scopeIds: scopes
          .filter((s) =>
            pool.appliesTo === "course"
              ? s.kind === "course"
              : pool.appliesTo === "every_chapter"
                ? s.kind === "chapter"
                : s.kind === "episode",
          )
          .map((s) => s.scopeId),
        // Open-ended scopes have no deadline a calendar-day allowance could move.
        unusableScopeIds:
          pool.unit === "calendar_day"
            ? scopes
                .filter(
                  (s) =>
                    s.mode === "open_ended" &&
                    (pool.appliesTo === "every_chapter"
                      ? s.kind === "chapter"
                      : false),
                )
                .map((s) => s.scopeId)
            : [],
        source: "admin" as const,
      })),
    ];
    return {
      settings: clone(settings),
      feasibility: {
        feasible: !issues.some((i) => i.severity === "error"),
        issues,
        alternatives: issues.some((i) => i.code === "TIME_ENVELOPE_TOO_SMALL")
          ? ["authorized_policy_change", "choose_a_smaller_goal"]
          : [],
        masteryCriteria: "unchanged",
      },
      calendar: scopes
        .filter((s) => s.window || s.hardDeadline)
        .map((s) => ({
          scopeId: s.scopeId,
          rule: s.window ? ("window" as const) : ("absolute" as const),
          timeZone: settings.timeZone,
          disambiguation: s.window
            ? settings.disambiguation
            : settings.hardDeadlineDisambiguation,
          calendarDays: s.window?.calendarDays ?? 0,
          rejectsSomeStarts: false,
          rejectedExtensionDays: [],
          // The demo's fixed UTC calendar has no daylight-saving changes.
          transitions: [],
        })),
      pools,
    };
  }

  // Cross-learner allowances: fictional offers and accommodations per course.
  const accommodations = new Map<string, Allowances["accommodations"]>();
  const batches = new Map<string, Batches["batches"]>();
  const previews = new Map<
    string,
    {
      courseId: string;
      digest: string;
      request: BatchRequest;
      preview: BatchPreview;
    }
  >();
  const appliedBatches = new Map<string, number>();
  function offersOf(workspace: CourseWorkspace): Allowances["offers"] {
    return workspace.enrollments.flatMap((enrollment, index) => {
      const offer = (
        n: number,
        scopeId: string,
        state: Allowances["offers"][number]["state"],
        days: number,
        createdAt: string,
      ) => ({
        enrollmentId: enrollment.id,
        displayName: nameOf(enrollment),
        enrollmentRevision: 1,
        enrollmentStatus: enrollment.status,
        offerId: `${enrollment.id}-offer-${n}`,
        scopeId,
        state,
        change: {
          deadline: { kind: "window" as const, calendarDays: days },
        },
        poolDebits: [{ poolId: `${scopeId}:calendar`, amount: days }],
        requiredApprovals: state === "accepted_pending_admin" ? ["admin"] : [],
        createdAt,
        expiresAt: addDays(createdAt, 7),
        lastTransitionAt: addDays(createdAt, state === "proposed" ? 0 : 1),
        acceptedAt:
          state === "accepted_pending_admin" || state === "granted"
            ? addDays(createdAt, 1)
            : null,
      });
      return index === 0
        ? [
            offer(
              1,
              "chapter:foundations",
              "accepted_pending_admin",
              2,
              "2026-10-13T10:00:00.000Z",
            ),
            offer(
              2,
              "episode:notice",
              "granted",
              1,
              "2026-10-10T10:00:00.000Z",
            ),
          ]
        : index === 1
          ? [
              offer(
                1,
                "episode:apply",
                "proposed",
                2,
                "2026-10-14T08:00:00.000Z",
              ),
            ]
          : [];
    });
  }
  function accommodationsOf(courseId: string) {
    let list = accommodations.get(courseId);
    if (!list) {
      const enrollment = course(courseId).enrollments[0];
      list = enrollment
        ? [
            {
              enrollmentId: enrollment.id,
              displayName: nameOf(enrollment),
              accommodationId: `${enrollment.id}-accommodation-1`,
              kind: "accommodation",
              scopeId: "chapter:foundations",
              adjustment: { additionalMinutes: 30 },
              batchId: null,
              authorizedAt: "2026-10-12T12:00:00.000Z",
            },
          ]
        : [];
      accommodations.set(courseId, list);
    }
    return list;
  }

  return {
    async getPolicyCeilings(workspaceId, signal) {
      await delay(signal);
      permitWorkspace(false);
      return ceilingsView(workspaceId);
    },
    async previewPolicyCeilings(workspaceId, ceilings) {
      await delay();
      permitWorkspace(true);
      validCeilings(ceilings);
      return ceilingsView(workspaceId, {
        preview: { ceilings: clone(ceilings) },
        impact: ceilingsImpact(ceilings),
      });
    },
    async savePolicyCeilings(workspaceId, input) {
      await delay();
      permitWorkspace(true);
      validCeilings(input.ceilings);
      if (!input.reason.trim()) throw new AdminError("validation");
      stale(input.expectedRevision, ceilingsState.revision);
      if (ceilingsImpact(input.ceilings).some((c) => !c.feasible))
        throw new AdminError("validation");
      ceilingsState.ceilings = clone(input.ceilings);
      ceilingsState.revision += 1;
      ceilingsState.source = "configured";
      ceilingsState.changedAt = new Date().toISOString();
      return ceilingsView(workspaceId, { outcome: "saved" });
    },
    async getPolicySettings(courseId, signal) {
      await delay(signal);
      const workspace = course(courseId);
      permit(workspace, false);
      return settingsView(workspace);
    },
    async previewPolicySettings(courseId, settings) {
      await delay();
      const workspace = course(courseId);
      permit(workspace, true);
      return settingsView(workspace, settingsPreview(workspace, settings));
    },
    async savePolicySettings(courseId, input) {
      await delay();
      const workspace = course(courseId);
      permit(workspace, true);
      if (!input.reason.trim()) throw new AdminError("validation");
      const state = settingsOf(courseId);
      stale(input.expectedRevision, state.revision);
      if (!settingsPreview(workspace, input.settings).feasibility.feasible)
        throw new AdminError("validation");
      state.settings = clone(input.settings);
      state.revision += 1;
      state.source = "configured";
      state.changedAt = new Date().toISOString();
      return settingsView(workspace);
    },
    async getAllowances(courseId, view, signal) {
      await delay(signal);
      const workspace = course(courseId);
      permit(workspace, false);
      const all = offersOf(workspace);
      const offers =
        view === "pending"
          ? all.filter(
              (o) =>
                o.state === "proposed" || o.state === "accepted_pending_admin",
            )
          : all;
      const granted = all.filter((o) => o.state === "granted");
      const learners = workspace.enrollments.length;
      const first = workspace.enrollments[0];
      const pools = (first ? demoLearningPolicy(first).pools : []).map(
        (pool) => {
          const used = granted.flatMap((o) =>
            o.poolDebits.filter((d) => d.poolId === pool.poolId),
          );
          return {
            poolId: pool.poolId,
            unit: pool.unit,
            learners,
            total: pool.total * learners,
            used: used.reduce((sum, d) => sum + d.amount, 0),
            grants: used.length,
          };
        },
      );
      return clone({
        courseId,
        view,
        offers,
        accommodations: view === "pending" ? [] : accommodationsOf(courseId),
        pools,
      });
    },
    async previewAccommodationBatch(courseId, input) {
      await delay();
      const workspace = course(courseId);
      permit(workspace, true);
      const days = input.change.deadline?.calendarDays ?? 0;
      const minutes = input.change.work?.additionalMinutes ?? 0;
      if (!days && !minutes) throw new AdminError("validation");
      const chosen = input.enrollmentIds
        ? input.enrollmentIds.map((id) => {
            const found = workspace.enrollments.find((e) => e.id === id);
            if (!found) throw new AdminError("validation");
            return found;
          })
        : workspace.enrollments;
      const preview: BatchPreview = {
        batchId: `demo-batch-${++sequence}`,
        previewDigest: "",
        expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
        courseId,
        kind: input.kind,
        scopeId: input.scopeId,
        change: clone(input.change),
        enrollments: [],
        refused: [],
      };
      for (const enrollment of chosen) {
        const refuse = (code: string) =>
          preview.refused.push({
            enrollmentId: enrollment.id,
            displayName: nameOf(enrollment),
            code,
          });
        if (enrollment.status !== "active") {
          refuse("ENROLLMENT_INACTIVE");
          continue;
        }
        if (input.kind === "outage" && minutes) {
          refuse("OUTAGE_DEADLINE_ONLY");
          continue;
        }
        const scope = demoLearningPolicy(enrollment).scopes.find(
          (s) => s.scopeId === input.scopeId,
        );
        if (!scope) {
          refuse("UNKNOWN_SCOPE");
          continue;
        }
        const before = deadlineOf(scope);
        if (days && !before) {
          refuse("INVALID_CHANGE");
          continue;
        }
        preview.enrollments.push({
          enrollmentId: enrollment.id,
          displayName: nameOf(enrollment),
          effectiveDeadlineBefore: before ? iso(before) : null,
          effectiveDeadlineAfter: before ? addDays(before, days) : null,
          bindingAfter: { scopeId: scope.scopeId, level: scope.kind },
        });
      }
      preview.previewDigest = await sha256Hex(
        JSON.stringify([preview.batchId, input, preview.enrollments]),
      );
      previews.set(preview.batchId, {
        courseId,
        digest: preview.previewDigest,
        request: clone(input),
        preview: clone(preview),
      });
      return clone(preview);
    },
    async applyAccommodationBatch(courseId, input) {
      await delay();
      const workspace = course(courseId);
      permit(workspace, true);
      const replay = appliedBatches.get(input.batchId);
      if (replay !== undefined)
        return {
          batchId: input.batchId,
          applied: replay,
          replayed: true,
          outcome: "applied",
        };
      const pending = previews.get(input.batchId);
      if (
        !pending ||
        pending.courseId !== courseId ||
        pending.digest !== input.previewDigest
      )
        throw new AdminError("stale_revision");
      if (!input.reason.trim()) throw new AdminError("validation");
      const { request, preview } = pending;
      const list = accommodationsOf(courseId);
      for (const row of preview.enrollments)
        list.push({
          enrollmentId: row.enrollmentId,
          displayName: row.displayName,
          accommodationId: `${input.batchId}-${row.enrollmentId}`,
          kind: request.kind,
          scopeId: request.scopeId,
          adjustment: {
            ...(row.effectiveDeadlineAfter
              ? request.change.deadline?.kind === "absolute"
                ? { absoluteDeadline: row.effectiveDeadlineAfter }
                : { windowDeadline: row.effectiveDeadlineAfter }
              : {}),
            ...(request.change.work?.additionalMinutes
              ? { additionalMinutes: request.change.work.additionalMinutes }
              : {}),
          },
          batchId: input.batchId,
          authorizedAt: new Date().toISOString(),
        });
      const applied = preview.enrollments.length;
      const done = batches.get(courseId) ?? [];
      done.unshift({
        batchId: input.batchId,
        kind: request.kind,
        scopeId: request.scopeId,
        change: clone(request.change),
        reason: input.reason.trim(),
        applied,
        appliedAt: new Date().toISOString(),
        appliedBy: "Demo operator",
      });
      batches.set(courseId, done);
      previews.delete(input.batchId);
      appliedBatches.set(input.batchId, applied);
      return {
        batchId: input.batchId,
        applied,
        replayed: false,
        outcome: "applied",
      };
    },
    async getAccommodationBatches(courseId, signal) {
      await delay(signal);
      const workspace = course(courseId);
      permit(workspace, false);
      return clone({ courseId, batches: batches.get(courseId) ?? [] });
    },
  };
}
