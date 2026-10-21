import type { LearningPolicy } from "@course-core/sdk";
import {
  CourseApiError,
  type CourseApi,
  type ServerSnapshot,
} from "./apiClient";
export interface CatalogCourse {
  id: string;
  title: string;
  version: string;
  status: string;
  summary?: string;
  policy?: LearningPolicy;
}
export interface Enrollment {
  id: string;
  releaseId: string;
  title: string;
  version: string;
  status: string;
}
export interface PolicyQuota {
  scopeId: string;
  metric:
    "additionalMinutes" | "additionalEpisodes" | "remediationCyclesPerConcept";
  conceptId: string | null;
  limit: number;
  consumed: number;
  reserved: number;
  remaining: number;
}
export interface PolicyDeadline {
  scopeId: string;
  kind: "absolute" | "window" | "ultimate";
  at: string;
}
/** The policy level a constraint comes from: organization → course → enrollment → chapter → episode. */
export type PolicyLevel = "organization" | "course" | "enrollment" | "chapter" | "episode" | "activity";
/** Which level sets the effective date and each work limit, as resolved by the server. */
export interface PolicyBinding {
  deadline: { scopeId: string; level: PolicyLevel; kind: PolicyDeadline["kind"]; at: string } | null;
  quotas: { metric: PolicyQuota["metric"]; conceptId: string | null; scopeId: string; level: PolicyLevel; limit: number; remaining: number }[];
}
export interface PolicyConstraint {
  enrollmentId: string;
  scopeId: string;
  effectiveDeadline: string | null;
  deadlines: PolicyDeadline[];
  quotas: PolicyQuota[];
  existingMaterialAccess: "read_only" | "closed";
  /** Optional (newer servers): absent or malformed values are dropped, never guessed. */
  binding?: PolicyBinding;
}
export interface PolicyBalance {
  poolId: string;
  remaining: number;
  grantsRemaining: number;
}
export interface ExtensionOffer {
  termsDigest: string;
  state:
    | "proposed"
    | "accepted_pending_admin"
    | "granted"
    | "declined"
    | "expired"
    | "rejected"
    | "superseded";
  terms: {
    offerId: string;
    enrollmentId: string;
    scopeId: string;
    expectedPolicyRevision: number;
    currentEffectiveDeadline: string | null;
    proposedEffectiveDeadline: string | null;
    balanceBefore: PolicyBalance[];
    balanceAfter: PolicyBalance[];
    currentWorkQuotas: PolicyQuota[];
    proposedWorkQuotas: PolicyQuota[];
    /** What the extension changes: calendar days on a deadline, and/or planned minutes and
     * lessons on a work limit. Older offers may omit it; days are then the only change. */
    change?: {
      deadline?: { kind: "absolute" | "window"; calendarDays: number };
      work?: { additionalMinutes?: number; additionalEpisodes?: number };
    };
    /** The exact allowance each unit of this offer uses, per pool. */
    poolDebits?: { poolId: string; amount: number }[];
    addedWork: {
      additionalMinutes: number;
      additionalEpisodes: number;
      remediation: { conceptId: string; cycles: number }[];
    };
    planImpact: string;
    alternatives: string[];
    proposedActivities: string[];
    bindingAncestorCaps: PolicyDeadline[];
    createdAt: string;
    expiresAt: string;
    requiredApprovals: string[];
  };
}
/** Coverage with a stable denominator fixed at enrollment. Personal extras are
 * counted on their own and never change what completion means. */
export interface PolicyCoverage {
  denominator: number;
  coveredCoreObjectives: number;
  personalExtras: {
    committed: { count: number; additionalMinutes: number; additionalEpisodes: number };
    reserved: { count: number; additionalMinutes: number; additionalEpisodes: number };
  };
}
/** The read-only question allowance of a closed (completed or capped) course. */
export interface ClosedQuestionAllowance {
  budget: number;
  used: number;
  remaining: number;
}
export interface EnrollmentPolicy {
  coverage?: PolicyCoverage;
  closedQuestions?: ClosedQuestionAllowance;
  revision: number;
  policyRevision: number;
  ledgerRevision: number;
  constraints: PolicyConstraint[];
  balances: PolicyBalance[];
  offers: ExtensionOffer[];
  grants: {
    grantId: string;
    offerId: string;
    grantedAt: string;
    adjustment: { scopeId: string };
  }[];
}
export interface ClosureReport {
  closedAt: string;
  reason: "cap" | "completed" | "withdrawn";
  coverage: "complete" | "partial";
  mastery: "demonstrated" | "gaps";
  uncoveredObjectiveIds: string[];
  unprovenConceptIds: string[];
  requiredExpansion: "stopped";
  continuation: "explicit_opt_in_separate_track";
}

const object = (v: unknown): v is Record<string, unknown> =>
  Boolean(v) && typeof v === "object" && !Array.isArray(v);
const count = (v: unknown) =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const instant = (v: unknown) =>
  typeof v === "string" &&
  /(?:Z|[+-]\d{2}:\d{2})$/.test(v) &&
  Number.isFinite(Date.parse(v));
const deadline = (v: unknown) => v === null || instant(v);
const list = (v: unknown, check: (item: unknown) => boolean) =>
  Array.isArray(v) && v.length <= 2000 && v.every(check);
const strings = (v: unknown) => list(v, (item) => typeof item === "string");
const balance = (v: unknown) =>
  object(v) &&
  typeof v.poolId === "string" &&
  count(v.remaining) &&
  count(v.grantsRemaining);
const quota = (v: unknown) =>
  object(v) &&
  typeof v.scopeId === "string" &&
  [
    "additionalMinutes",
    "additionalEpisodes",
    "remediationCyclesPerConcept",
  ].includes(String(v.metric)) &&
  (v.conceptId === null || typeof v.conceptId === "string") &&
  [v.limit, v.consumed, v.reserved, v.remaining].every(count);
const dated = (v: unknown) =>
  object(v) &&
  typeof v.scopeId === "string" &&
  ["absolute", "window", "ultimate"].includes(String(v.kind)) &&
  instant(v.at);
export function parseEnrollmentPolicy(
  value: unknown,
  enrollmentId: string,
): EnrollmentPolicy {
  const valid =
    object(value) &&
    [value.revision, value.policyRevision, value.ledgerRevision].every(count) &&
    list(value.balances, balance) &&
    list(
      value.constraints,
      (v) =>
        object(v) &&
        v.enrollmentId === enrollmentId &&
        typeof v.scopeId === "string" &&
        deadline(v.effectiveDeadline) &&
        list(v.deadlines, dated) &&
        list(v.quotas, quota) &&
        ["read_only", "closed"].includes(String(v.existingMaterialAccess)),
    ) &&
    list(value.offers, (v) => {
      if (
        !object(v) ||
        typeof v.termsDigest !== "string" ||
        !/^[a-f0-9]{64}$/.test(v.termsDigest) ||
        ![
          "proposed",
          "accepted_pending_admin",
          "granted",
          "declined",
          "expired",
          "rejected",
          "superseded",
        ].includes(String(v.state)) ||
        !object(v.terms)
      )
        return false;
      const t = v.terms;
      return (
        t.enrollmentId === enrollmentId &&
        typeof t.offerId === "string" &&
        typeof t.scopeId === "string" &&
        count(t.expectedPolicyRevision) &&
        deadline(t.currentEffectiveDeadline) &&
        deadline(t.proposedEffectiveDeadline) &&
        list(t.balanceBefore, balance) &&
        list(t.balanceAfter, balance) &&
        list(t.currentWorkQuotas, quota) &&
        list(t.proposedWorkQuotas, quota) &&
        object(t.addedWork) &&
        count(t.addedWork.additionalMinutes) &&
        count(t.addedWork.additionalEpisodes) &&
        list(
          t.addedWork.remediation,
          (r) =>
            object(r) && typeof r.conceptId === "string" && count(r.cycles),
        ) &&
        typeof t.planImpact === "string" &&
        strings(t.alternatives) &&
        strings(t.proposedActivities) &&
        list(t.bindingAncestorCaps, dated) &&
        instant(t.createdAt) &&
        instant(t.expiresAt) &&
        strings(t.requiredApprovals)
      );
    }) &&
    list(
      value.grants,
      (v) =>
        object(v) &&
        typeof v.grantId === "string" &&
        typeof v.offerId === "string" &&
        instant(v.grantedAt) &&
        object(v.adjustment) &&
        typeof v.adjustment.scopeId === "string",
    );
  if (!valid) throw new CourseApiError("INVALID_RESPONSE", 502);
  const result = { ...(value as unknown as EnrollmentPolicy) };
  // Optional, newer fields: shown only when well formed, never trusted otherwise.
  const extra = (v: unknown) =>
    object(v) && count(v.count) && count(v.additionalMinutes) && count(v.additionalEpisodes);
  const coverage = value.coverage;
  if (
    !(
      object(coverage) &&
      count(coverage.denominator) &&
      count(coverage.coveredCoreObjectives) &&
      (coverage.coveredCoreObjectives as number) <= (coverage.denominator as number) &&
      object(coverage.personalExtras) &&
      extra(coverage.personalExtras.committed) &&
      extra(coverage.personalExtras.reserved)
    )
  )
    delete result.coverage;
  const levels = ["organization", "course", "enrollment", "chapter", "episode", "activity"];
  const bindingValid = (b: unknown) =>
    object(b) &&
    (b.deadline === null ||
      (object(b.deadline) &&
        typeof b.deadline.scopeId === "string" &&
        levels.includes(String(b.deadline.level)) &&
        ["absolute", "window", "ultimate"].includes(String(b.deadline.kind)) &&
        instant(b.deadline.at))) &&
    list(
      b.quotas,
      (q) =>
        object(q) &&
        typeof q.scopeId === "string" &&
        levels.includes(String(q.level)) &&
        ["additionalMinutes", "additionalEpisodes", "remediationCyclesPerConcept"].includes(String(q.metric)) &&
        count(q.limit) &&
        count(q.remaining),
    );
  result.constraints = result.constraints.map((c) => {
    if (c.binding === undefined || bindingValid(c.binding)) return c;
    const { binding: _dropped, ...rest } = c;
    return rest;
  });
  const positive = (v: unknown) => count(v) && (v as number) > 0;
  result.offers = result.offers.map((offer) => {
    const terms = { ...offer.terms } as Record<string, unknown>;
    const change = terms.change;
    const changeValid =
      object(change) &&
      (change.deadline === undefined ||
        (object(change.deadline) &&
          ["absolute", "window"].includes(String(change.deadline.kind)) &&
          positive(change.deadline.calendarDays))) &&
      (change.work === undefined ||
        (object(change.work) &&
          (change.work.additionalMinutes === undefined || positive(change.work.additionalMinutes)) &&
          (change.work.additionalEpisodes === undefined || positive(change.work.additionalEpisodes))));
    if (!changeValid) delete terms.change;
    if (!list(terms.poolDebits, (d) => object(d) && typeof d.poolId === "string" && positive(d.amount))) delete terms.poolDebits;
    return { ...offer, terms: terms as unknown as ExtensionOffer["terms"] };
  });
  const questions = value.closedQuestions;
  if (!(object(questions) && count(questions.budget) && count(questions.used) && count(questions.remaining)))
    delete result.closedQuestions;
  return result;
}
/** The optional continuation track after a course closes: spaced review the learner opts into
 * explicitly. It adds no required work, grants no credit and never reopens the course. */
export interface ContinuationView {
  revision: number;
  available: boolean;
  track: { state: "active" | "stopped"; optedInAt: string; stoppedAt: string | null } | null;
  reviewFocus: { unprovenConceptIds: string[]; uncoveredObjectiveIds: string[] } | null;
  terms: { requiredWork: false; credit: false; reopensCourse: false; canStopAnytime: true };
}
export function parseContinuation(value: unknown): ContinuationView {
  const track = object(value) ? value.track : undefined,
    focus = object(value) ? value.reviewFocus : undefined,
    terms = object(value) ? value.terms : undefined;
  const valid =
    object(value) &&
    count(value.revision) &&
    typeof value.available === "boolean" &&
    (track === null ||
      (object(track) &&
        ["active", "stopped"].includes(String(track.state)) &&
        instant(track.optedInAt) &&
        (track.stoppedAt === null || instant(track.stoppedAt)))) &&
    (focus === null || (object(focus) && strings(focus.unprovenConceptIds) && strings(focus.uncoveredObjectiveIds))) &&
    // The track's terms are fixed; a server that says otherwise is not trusted.
    object(terms) &&
    terms.requiredWork === false &&
    terms.credit === false &&
    terms.reopensCourse === false &&
    terms.canStopAnytime === true;
  if (!valid) throw new CourseApiError("INVALID_RESPONSE", 502);
  return value as unknown as ContinuationView;
}
export function createContinuationClient(api: Pick<CourseApi, "request" | "command">) {
  const path = (id: string) => `/api/enrollments/${encodeURIComponent(id)}/continuation`;
  return {
    async load(id: string, signal?: AbortSignal) {
      return parseContinuation(await api.request(path(id), "GET", undefined, { signal }));
    },
    async optIn(snapshot: ServerSnapshot, view: ContinuationView, explicitConsent: true) {
      if (explicitConsent !== true) throw new CourseApiError("CONSENT_REQUIRED", 400);
      return parseContinuation(await api.command({ ...snapshot, revision: view.revision }, "continuation", { explicitConsent: true }));
    },
    async stop(snapshot: ServerSnapshot, view: ContinuationView) {
      return parseContinuation(await api.command({ ...snapshot, revision: view.revision }, "continuation/stop", {}));
    },
  };
}
export type ContinuationClient = ReturnType<typeof createContinuationClient>;
export function createPolicyClient(api: CourseApi) {
  return {
    async load(id: string, signal?: AbortSignal) {
      return parseEnrollmentPolicy(
        await api.request(
          `/api/enrollments/${encodeURIComponent(id)}/policy`,
          "GET",
          undefined,
          { signal },
        ),
        id,
      );
    },
    accept(
      snapshot: ServerSnapshot,
      policy: EnrollmentPolicy,
      offer: ExtensionOffer,
      explicitConsent: true,
    ) {
      if (
        explicitConsent !== true ||
        offer.terms.enrollmentId !== snapshot.enrollmentId
      )
        throw new CourseApiError("CONSENT_REQUIRED", 400);
      return api.command<{ revision: number; offer: ExtensionOffer }>(
        { ...snapshot, revision: policy.revision },
        "extensions/accept",
        {
          offerId: offer.terms.offerId,
          termsDigest: offer.termsDigest,
          explicitConsent: true,
        },
      );
    },
    decline(
      snapshot: ServerSnapshot,
      policy: EnrollmentPolicy,
      offer: ExtensionOffer,
    ) {
      if (offer.terms.enrollmentId !== snapshot.enrollmentId)
        throw new CourseApiError("INVALID_RESPONSE", 502);
      return api.command(
        { ...snapshot, revision: policy.revision },
        "extensions/decline",
        { offerId: offer.terms.offerId },
      );
    },
  };
}
export type PolicyClient = ReturnType<typeof createPolicyClient>;
