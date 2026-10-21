import type {
  AdminClient,
  CourseWorkspace,
  Enrollment,
} from "../domain/contracts";
import { AdminError } from "../domain/errors";
import {
  scopeSchema,
  type AccommodationPreview,
  type AccommodationRequest,
  type EnrollmentMutationContext,
  type LearningPolicy,
  type PolicyMigrationPreview,
  type ScopePolicy,
} from "../domain/policy";
import type {
  CohortChange,
  CohortPreview,
  LedgerAction,
  LedgerPreview,
} from "../domain/policyLedger";
import {
  demoLearningPolicy,
  resolveDemoConstraints,
} from "../data/policyFixtures";
import { sha256Hex } from "../domain/webCrypto";
import type { Translate } from "../i18n";

const DAY = 86_400_000;
/** How long a demo preview can be applied, like the server's preview window. */
const PREVIEW_MS = 15 * 60_000;
const addDays = (at: string, days: number) =>
  new Date(Date.parse(at) + days * DAY).toISOString();
const clone = <T>(value: T): T => structuredClone(value);

type Offer = LearningPolicy["offers"][number];
type Grant = LearningPolicy["grants"][number];

/** Each learner's fictional policy and ledger, shared by every demo port that reads or
 * changes it, so an approval in the allowances view shows on the learner's policy page. */
export interface DemoPolicyStore {
  get(enrollmentId: string): LearningPolicy;
  set(policy: LearningPolicy): void;
}

/** A fictional, non-cryptographic 64-hex fingerprint for seeded demo records only. */
function demoDigest(text: string) {
  let out = "";
  for (let seed = 0; seed < 8; seed++) {
    let hash = 0x811c9dc5 ^ seed;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    out += (hash >>> 0).toString(16).padStart(8, "0");
  }
  return out;
}

/** A scope's own deadline: its window, else its hard deadline. */
function ownDeadline(scope: ScopePolicy | undefined) {
  return scope?.window?.resolvedDeadline ?? scope?.hardDeadline?.at ?? null;
}

/** Moves a scope's own deadline (its window, else its hard deadline) by whole days. */
function shiftScope(policy: LearningPolicy, scopeId: string, days: number) {
  const scope = policy.scopes.find((s) => s.scopeId === scopeId);
  if (!scope) throw new AdminError("validation");
  if (scope.window)
    scope.window.resolvedDeadline = addDays(
      scope.window.resolvedDeadline,
      days,
    );
  else if (scope.hardDeadline)
    scope.hardDeadline.at = addDays(scope.hardDeadline.at, days);
  else throw new AdminError("scope_not_extendable");
}

function refresh(policy: LearningPolicy) {
  policy.constraints = policy.scopes.map((scope) =>
    resolveDemoConstraints(policy, scope.scopeId),
  );
}

/** A moved deadline must still bind: no ancestor deadline (including the ultimate one)
 * may come earlier, so an extension never silently does less than it says. */
function assertBinds(policy: LearningPolicy, scopeId: string) {
  const resolved = resolveDemoConstraints(policy, scopeId);
  const own = ownDeadline(policy.scopes.find((s) => s.scopeId === scopeId));
  if (own && Date.parse(resolved.effectiveDeadline!) !== Date.parse(own))
    throw new AdminError("parent_cap");
}

function offerTerms(
  policy: LearningPolicy,
  scopeId: string,
  days: number,
  offerId: string,
  createdAt: string,
  requiredApprovals: string[],
  translate: Translate,
): Offer["terms"] {
  const scope = policy.scopes.find((s) => s.scopeId === scopeId)!;
  const before = resolveDemoConstraints(policy, scopeId);
  const after = clone(policy);
  shiftScope(after, scopeId, days);
  const next = resolveDemoConstraints(after, scopeId);
  const pool = policy.pools.find((p) =>
    scope.extensions!.poolIds.includes(p.poolId),
  )!;
  const balance = policy.balances.find((b) => b.poolId === pool.poolId)!;
  return {
    offerId,
    scopeId,
    enrollmentId: policy.enrollmentId,
    expectedPolicyRevision: policy.policyRevision,
    rationaleEvidenceRefs: policy.rationaleEvents.slice(0, 1).map((e) => e.id),
    proposedActivities: policy.activities.slice(0, 1).map((a) => a.id),
    currentEffectiveDeadline: before.effectiveDeadline,
    proposedEffectiveDeadline: next.effectiveDeadline,
    currentWorkQuotas: before.quotas,
    proposedWorkQuotas: next.quotas,
    change: {
      deadline: {
        kind: scope.window ? "window" : "absolute",
        calendarDays: days,
      },
    },
    addedWork: { additionalMinutes: 0, additionalEpisodes: 0, remediation: [] },
    poolDebits: [{ poolId: pool.poolId, amount: days }],
    balanceBefore: [clone(balance)],
    balanceAfter: [
      {
        poolId: pool.poolId,
        remaining: balance.remaining - days,
        grantsRemaining: balance.grantsRemaining - 1,
      },
    ],
    bindingAncestorCaps: next.deadlines.filter(
      (d) => d.scopeId !== scopeId || d.kind === "ultimate",
    ),
    requiredApprovals,
    planImpact: translate("demoPolicyClient.seed.planImpact", { days }),
    alternatives: [translate("demoPolicyClient.seed.alternative")],
    createdAt,
    expiresAt: addDays(createdAt, 7),
  };
}

/** Grants an accepted offer: moves the deadline, debits the pool and records the grant.
 * Throws when the pool cannot pay or an ancestor deadline would bind first. */
function grantOffer(policy: LearningPolicy, offer: Offer, at: string) {
  for (const debit of offer.terms.poolDebits) {
    const balance = policy.balances.find((b) => b.poolId === debit.poolId);
    if (
      !balance ||
      balance.remaining < debit.amount ||
      balance.grantsRemaining < 1
    )
      throw new AdminError("allowance_exhausted");
    balance.remaining -= debit.amount;
    balance.grantsRemaining -= 1;
  }
  shiftScope(
    policy,
    offer.terms.scopeId,
    offer.terms.change.deadline?.calendarDays ?? 0,
  );
  assertBinds(policy, offer.terms.scopeId);
  offer.state = "granted";
  offer.lastTransitionAt = at;
  const grant: Grant = {
    grantId: `${offer.terms.offerId}-grant`,
    offerId: offer.terms.offerId,
    acceptedTermsDigest: offer.termsDigest,
    learnerAcceptanceReceipt: offer.acceptance!,
    atomicLedgerTransactionId: `${offer.terms.offerId}-ledger`,
    newPolicyRevision: policy.policyRevision,
    grantedAt: at,
    poolDebits: clone(offer.terms.poolDebits),
  };
  policy.grants.push(grant);
}

/** The demo's starting ledger: the first learner of a course has a granted extension and
 * an accepted offer waiting for an administrator; the second has an open proposal. */
function seedLedger(
  policy: LearningPolicy,
  seat: number,
  translate: Translate,
  now: number,
) {
  const at = (hours: number) => new Date(now + hours * 3600_000).toISOString();
  const offer = (
    n: number,
    scopeId: string,
    days: number,
    approvals: string[],
    accepted: boolean,
  ): Offer => {
    const offerId = `${policy.enrollmentId}-offer-${n}`;
    const terms = offerTerms(
      policy,
      scopeId,
      days,
      offerId,
      at(-48 + n),
      approvals,
      translate,
    );
    const termsDigest = demoDigest(JSON.stringify(terms));
    return {
      terms,
      termsDigest,
      state: accepted ? "accepted_pending_admin" : "proposed",
      lastTransitionAt: at(accepted ? -24 : -48 + n),
      ...(accepted && {
        acceptance: {
          receiptId: `${offerId}-consent`,
          learnerId: policy.learnerId,
          enrollmentId: policy.enrollmentId,
          offerId,
          termsDigest,
          explicit: true as const,
          acceptedAt: at(-24),
        },
      }),
    };
  };
  if (seat === 0) {
    const granted = offer(2, "episode:notice", 1, [], true);
    grantOffer(policy, granted, at(-20));
    policy.offers.push(offer(1, "course", 2, ["admin"], true), granted);
    policy.pendingApprovals = ["admin"];
  } else if (seat === 1)
    policy.offers.push(offer(1, "episode:apply", 2, [], false));
  refresh(policy);
}

export function createDemoPolicyStore(
  getEnrollment: (enrollmentId: string) => Enrollment,
  /** The learner's position in their course (0 = first), which picks the seeded ledger. */
  seat: (enrollmentId: string) => number,
  translate: () => Translate,
): DemoPolicyStore {
  const policies = new Map<string, LearningPolicy>();
  return {
    get(enrollmentId) {
      let policy = policies.get(enrollmentId);
      if (!policy) {
        policy = demoLearningPolicy(getEnrollment(enrollmentId));
        seedLedger(policy, seat(enrollmentId), translate(), Date.now());
        policies.set(enrollmentId, policy);
      }
      return policy;
    },
    set(policy) {
      policies.set(policy.enrollmentId, policy);
    },
  };
}

export type DemoPolicyLedgerMethods = Required<
  Pick<
    AdminClient,
    | "approveExtension"
    | "rejectExtension"
    | "previewLedgerAction"
    | "applyLedgerAction"
    | "previewCohortMigration"
    | "applyCohortMigration"
    | "previewPolicyChange"
    | "migratePolicy"
    | "previewAccommodation"
    | "applyAccommodation"
  >
>;

/**
 * In-memory administrator ledger commands for the demo: approving or rejecting
 * learner-accepted terms, revocations, refunds and exceptional grants, accommodations,
 * scope edits and course-wide deadline changes. Like the server, every change is
 * previewed first, applied only from that exact preview with a reason, checked against
 * the learner's current revision and replayed for a repeated idempotency key.
 */
export function createDemoPolicyLedger({
  store,
  courseOf,
  course,
  permitWrite,
  translate,
}: {
  store: DemoPolicyStore;
  /** The course workspace an enrollment belongs to (throws not_found). */
  courseOf: (enrollmentId: string) => CourseWorkspace;
  course: (courseId: string) => CourseWorkspace;
  /** Throws permission_denied unless the actor may change policy in this course. */
  permitWrite: (workspace: CourseWorkspace) => void;
  translate: () => Translate;
}): DemoPolicyLedgerMethods {
  const receipts = new Map<string, { fingerprint: string; result: unknown }>();
  const previews = new Map<
    string,
    {
      enrollmentId: string;
      request: unknown;
      digest: string;
      revision: number;
      expiresAt: number;
    }
  >();
  const cohorts = new Map<
    string,
    {
      courseId: string;
      change: CohortChange;
      preview: CohortPreview;
      revisions: Map<string, number>;
      applied?: number;
    }
  >();
  let busy = false;
  let counter = 0;
  const now = () => new Date().toISOString();
  const enrollmentPolicy = (enrollmentId: string, write = true) => {
    const workspace = courseOf(enrollmentId);
    if (write) permitWrite(workspace);
    return store.get(enrollmentId);
  };

  async function remember(
    enrollmentId: string,
    request: unknown,
    preview: Record<string, unknown>,
    revision: number,
  ) {
    const previewId = `demo-preview-${++counter}`;
    const expiresAt = Date.now() + PREVIEW_MS;
    const body = {
      ...preview,
      previewId,
      revision,
      expiresAt: new Date(expiresAt).toISOString(),
    };
    const digest = await sha256Hex(JSON.stringify(body));
    previews.set(previewId, {
      enrollmentId,
      request: clone(request),
      digest,
      revision,
      expiresAt,
    });
    return { ...body, previewDigest: digest };
  }
  /** The reviewed preview this apply names; anything else means the impact changed.
   * Without `request`, the apply takes the request the preview was computed from. */
  function reviewed(
    enrollmentId: string,
    request: unknown,
    input: { previewId: string; previewDigest: string; reason: string },
  ) {
    if (!input.reason.trim() || input.reason.length > 1000)
      throw new AdminError("validation");
    const found = previews.get(input.previewId);
    if (
      !found ||
      found.enrollmentId !== enrollmentId ||
      (request !== undefined &&
        JSON.stringify(found.request) !== JSON.stringify(request)) ||
      found.digest !== input.previewDigest ||
      found.expiresAt < Date.now()
    )
      throw new AdminError("impact_changed");
    return found;
  }

  /** One learner's policy change: authorized, idempotent and fenced on the revision. */
  async function change<T extends object>(
    enrollmentId: string,
    context: EnrollmentMutationContext,
    payload: unknown,
    apply: (next: LearningPolicy) => T,
  ): Promise<T & { policy: LearningPolicy }> {
    if (busy) throw new AdminError("unavailable");
    busy = true;
    try {
      const current = enrollmentPolicy(enrollmentId);
      const key = JSON.stringify([enrollmentId, context.idempotencyKey]);
      const fingerprint = JSON.stringify(payload);
      const replay = receipts.get(key);
      if (replay) {
        if (replay.fingerprint !== fingerprint)
          throw new AdminError("validation");
        return {
          ...(clone(replay.result) as T),
          policy: clone(store.get(enrollmentId)),
        };
      }
      if (context.expectedRevision !== current.revision)
        throw new AdminError("stale_revision");
      const next = clone(current);
      const result = apply(next);
      next.revision++;
      refresh(next);
      store.set(next);
      receipts.set(key, { fingerprint, result: clone(result) });
      return { ...clone(result), policy: clone(next) };
    } finally {
      busy = false;
    }
  }
  const receipt = (outcome: string) => ({
    id: `demo-ledger-${++counter}`,
    authority: "demo" as const,
    outcome,
  });

  function grantDays(policy: LearningPolicy, grantId: string) {
    const grant = policy.grants.find((g) => g.grantId === grantId);
    if (grant) {
      const offer = policy.offers.find(
        (o) => o.terms.offerId === grant.offerId,
      )!;
      return {
        kind: "extension" as const,
        scopeId: offer.terms.scopeId,
        days: offer.terms.change.deadline?.calendarDays ?? 0,
        revoked: Boolean(grant.revocation),
      };
    }
    const exception = policy.exceptionalGrants?.find(
      (e) => e.exceptionId === grantId,
    );
    if (!exception) throw new AdminError("not_found");
    return {
      kind: "exceptional" as const,
      scopeId: exception.adjustment.scopeId,
      days: Number(exception.adjustment.days ?? 0),
      revoked: Boolean(exception.revocation),
    };
  }
  /** Every scope whose effective deadline differs between two versions of a policy. */
  function deadlineImpacts(before: LearningPolicy, after: LearningPolicy) {
    return before.scopes.flatMap((scope) => {
      const was = resolveDemoConstraints(
        before,
        scope.scopeId,
      ).effectiveDeadline;
      const will = resolveDemoConstraints(
        after,
        scope.scopeId,
      ).effectiveDeadline;
      return was === will
        ? []
        : [
            {
              scopeId: scope.scopeId,
              effectiveDeadlineBefore: was,
              effectiveDeadlineAfter: will,
              shortened: Boolean(
                was && will && Date.parse(will) < Date.parse(was),
              ),
            },
          ];
    });
  }
  function exceptionDays(action: Extract<LedgerAction, { kind: "exception" }>) {
    if (!Number.isInteger(action.days) || action.days < 1 || action.days > 366)
      throw new AdminError("validation");
    return action.days;
  }
  function refundable(
    policy: LearningPolicy,
    action: Extract<LedgerAction, { kind: "refund" }>,
  ) {
    const grant = policy.grants.find((g) => g.grantId === action.grantId);
    if (!grant) throw new AdminError("not_found");
    const debit = grant.poolDebits.find((d) => d.poolId === action.poolId);
    const refunded = (policy.refunds ?? [])
      .filter((r) => r.grantId === grant.grantId && r.poolId === action.poolId)
      .reduce((sum, r) => sum + r.amount, 0);
    if (
      !debit ||
      !Number.isInteger(action.amount) ||
      action.amount < 1 ||
      action.amount > debit.amount - refunded
    )
      throw new AdminError("ledger_refused");
    return policy.balances.find((b) => b.poolId === action.poolId)!;
  }

  function accommodationAdjustment(
    policy: LearningPolicy,
    input: AccommodationRequest,
  ): AccommodationPreview["adjustment"] {
    if (policy.status !== "active") throw new AdminError("inactive_enrollment");
    const scope = policy.scopes.find((s) => s.scopeId === input.scopeId);
    if (!scope) throw new AdminError("validation");
    const days = input.change.deadline?.calendarDays ?? 0;
    const minutes = input.change.work?.additionalMinutes ?? 0;
    const episodes = input.change.work?.additionalEpisodes ?? 0;
    if (
      [days, minutes, episodes].some((n) => !Number.isInteger(n) || n < 0) ||
      days > 366 ||
      !(days || minutes || episodes)
    )
      throw new AdminError("validation");
    if (input.kind === "outage" && (minutes || episodes))
      throw new AdminError("outage_deadline_only");
    if (
      input.kind === "approved_pause" &&
      scope.window?.pauseRule !== "approved_only"
    )
      throw new AdminError("pause_not_allowed");
    const after = clone(policy);
    if (days) {
      const wanted = input.change.deadline!.kind;
      if ((wanted === "window") !== Boolean(scope.window))
        throw new AdminError("validation");
      shiftScope(after, scope.scopeId, days);
      assertBinds(after, scope.scopeId);
    }
    const moved = after.scopes.find((s) => s.scopeId === scope.scopeId)!;
    return {
      scopeId: scope.scopeId,
      ...(days &&
        (scope.window
          ? { windowDeadline: moved.window!.resolvedDeadline }
          : { absoluteDeadline: moved.hardDeadline!.at })),
      additionalMinutes: minutes,
      additionalEpisodes: episodes,
    };
  }

  /** Validates a full replacement scope list: same scopes and tree, children only tighten. */
  function replacementScopes(policy: LearningPolicy, scopes: unknown[]) {
    const parsed = scopes.map((scope) => scopeSchema.safeParse(scope));
    if (parsed.some((p) => !p.success)) throw new AdminError("validation");
    const next = parsed.map((p) => p.data!) as ScopePolicy[];
    const ids = (list: ScopePolicy[]) =>
      list
        .map((s) => `${s.scopeId}|${s.parentScopeId}|${s.kind}`)
        .sort()
        .join();
    if (ids(next) !== ids(policy.scopes)) throw new AdminError("validation");
    for (const scope of next) {
      const parent = next.find((s) => s.scopeId === scope.parentScopeId);
      if (
        parent?.hardDeadline &&
        scope.hardDeadline &&
        Date.parse(scope.hardDeadline.at) > Date.parse(parent.hardDeadline.at)
      )
        throw new AdminError("looser_than_parent");
    }
    return next;
  }

  function cohortScope(policy: LearningPolicy, change: CohortChange) {
    const after = clone(policy);
    const scope = after.scopes.find((s) => s.scopeId === change.scopeId)!;
    if (change.hardDeadline)
      scope.hardDeadline = {
        at: new Date(change.hardDeadline).toISOString(),
        timeZone: scope.hardDeadline?.timeZone ?? "UTC",
        disambiguation: scope.hardDeadline?.disambiguation ?? "reject",
      };
    if (change.targetDate)
      scope.targetDate = new Date(change.targetDate).toISOString();
    refresh(after);
    return after;
  }
  /** The scope and every scope below it. */
  function subtree(policy: LearningPolicy, scopeId: string): string[] {
    return [
      scopeId,
      ...policy.scopes
        .filter((s) => s.parentScopeId === scopeId)
        .flatMap((s) => subtree(policy, s.scopeId)),
    ];
  }

  return {
    approveExtension: (enrollmentId, offerId, context) =>
      change(enrollmentId, context, ["approve", offerId], (next) => {
        if (next.status !== "active")
          throw new AdminError("inactive_enrollment");
        const offer = next.offers.find((o) => o.terms.offerId === offerId);
        if (!offer) throw new AdminError("not_found");
        if (
          offer.state !== "accepted_pending_admin" ||
          Date.parse(offer.terms.expiresAt) < Date.now()
        )
          throw new AdminError("ledger_refused");
        next.policyRevision++;
        next.ledgerRevision++;
        grantOffer(next, offer, now());
        next.grants.at(-1)!.newPolicyRevision = next.policyRevision;
        next.pendingApprovals = next.offers.some(
          (o) => o.state === "accepted_pending_admin",
        )
          ? ["admin"]
          : [];
        return {
          receipt: receipt("granted"),
          message: translate()("demoPolicyClient.approved"),
        };
      }),
    rejectExtension: (enrollmentId, offerId, reason, context) =>
      change(enrollmentId, context, ["reject", offerId, reason], (next) => {
        if (!reason.trim() || reason.length > 1000)
          throw new AdminError("validation");
        const offer = next.offers.find((o) => o.terms.offerId === offerId);
        if (!offer) throw new AdminError("not_found");
        if (!["proposed", "accepted_pending_admin"].includes(offer.state))
          throw new AdminError("ledger_refused");
        offer.state = "rejected";
        offer.lastTransitionAt = now();
        next.ledgerRevision++;
        next.pendingApprovals = next.offers.some(
          (o) => o.state === "accepted_pending_admin",
        )
          ? ["admin"]
          : [];
        // A rejection debits nothing and moves no deadline.
        return {
          receipt: receipt("rejected"),
          message: translate()("demoPolicyClient.rejected"),
        };
      }),

    async previewLedgerAction(enrollmentId, action) {
      const policy = enrollmentPolicy(enrollmentId);
      let preview: Record<string, unknown>;
      if (action.kind === "revocation") {
        const grant = grantDays(policy, action.grantId);
        if (grant.revoked || policy.status !== "active")
          throw new AdminError("ledger_refused");
        const after = clone(policy);
        shiftScope(after, grant.scopeId, -grant.days);
        const impacts = deadlineImpacts(policy, after);
        preview = {
          previewKind: "revocation",
          grantId: action.grantId,
          kind: grant.kind,
          scopeId: grant.scopeId,
          shortensDeadline: impacts.some((i) => i.shortened),
          impacts,
        };
      } else if (action.kind === "refund") {
        const balance = refundable(policy, action);
        const pool = policy.pools.find((p) => p.poolId === action.poolId)!;
        preview = {
          previewKind: "refund",
          grantId: action.grantId,
          poolId: action.poolId,
          amount: action.amount,
          balanceBefore: clone(balance),
          balanceAfter: {
            ...balance,
            remaining: Math.min(pool.total, balance.remaining + action.amount),
          },
        };
      } else {
        const days = exceptionDays(action);
        if (policy.status !== "active")
          throw new AdminError("inactive_enrollment");
        const scope = policy.scopes.find((s) => s.scopeId === action.scopeId);
        if (!scope || !(scope.window || scope.hardDeadline))
          throw new AdminError("scope_not_extendable");
        if ((action.deadlineKind === "window") !== Boolean(scope.window))
          throw new AdminError("validation");
        const after = clone(policy);
        shiftScope(after, scope.scopeId, days);
        assertBinds(after, scope.scopeId);
        preview = {
          previewKind: "exception",
          exceptionId: `demo-exception-${counter + 1}`,
          scopeId: scope.scopeId,
          effectiveDeadlineBefore: resolveDemoConstraints(policy, scope.scopeId)
            .effectiveDeadline,
          effectiveDeadlineAfter: resolveDemoConstraints(after, scope.scopeId)
            .effectiveDeadline,
          poolDebits: [],
        };
      }
      return (await remember(
        enrollmentId,
        action,
        preview,
        policy.revision,
      )) as LedgerPreview;
    },
    async applyLedgerAction(enrollmentId, action, input, context) {
      const found = reviewed(enrollmentId, action, input);
      return change(enrollmentId, context, [action, input], (next) => {
        if (found.revision !== next.revision)
          throw new AdminError("impact_changed");
        const at = now();
        if (action.kind === "revocation") {
          const grant = grantDays(next, action.grantId);
          if (grant.revoked) throw new AdminError("ledger_refused");
          const revocation = {
            revokedAt: at,
            reasonRef: `demo-reason-${counter + 1}`,
          };
          if (grant.kind === "extension")
            next.grants.find((g) => g.grantId === action.grantId)!.revocation =
              revocation;
          else
            next.exceptionalGrants!.find(
              (e) => e.exceptionId === action.grantId,
            )!.revocation = revocation;
          // The pool use stays recorded; giving it back is a separate refund.
          shiftScope(next, grant.scopeId, -grant.days);
          next.policyRevision++;
          next.ledgerRevision++;
          return {
            receipt: receipt("revoked"),
            message: translate()("demoPolicyClient.revoked"),
          };
        }
        if (action.kind === "refund") {
          const balance = refundable(next, action);
          const pool = next.pools.find((p) => p.poolId === action.poolId)!;
          balance.remaining = Math.min(
            pool.total,
            balance.remaining + action.amount,
          );
          (next.refunds ??= []).push({
            refundId: `demo-refund-${counter + 1}`,
            grantId: action.grantId,
            poolId: action.poolId,
            amount: action.amount,
            refundedAt: at,
          });
          next.ledgerRevision++;
          return {
            receipt: receipt("refunded"),
            message: translate()("demoPolicyClient.refunded", {
              count: action.amount,
            }),
          };
        }
        const days = exceptionDays(action);
        shiftScope(next, action.scopeId, days);
        assertBinds(next, action.scopeId);
        next.policyRevision++;
        next.ledgerRevision++;
        (next.exceptionalGrants ??= []).push({
          exceptionId: `demo-exception-${counter + 1}`,
          grantedAt: at,
          adjustment: { scopeId: action.scopeId, days },
        });
        return {
          receipt: receipt("exception_granted"),
          message: translate()("demoPolicyClient.exceptionGranted", {
            count: days,
          }),
        };
      });
    },

    async previewCohortMigration(courseId, change) {
      const workspace = course(courseId);
      permitWrite(workspace);
      const instant = change.hardDeadline ?? change.targetDate;
      if (
        !instant ||
        [change.hardDeadline, change.targetDate].some(
          (at) => at !== undefined && Number.isNaN(Date.parse(at)),
        )
      )
        throw new AdminError("validation");
      const enrollments: CohortPreview["enrollments"] = [];
      const refused: CohortPreview["refused"] = [];
      const revisions = new Map<string, number>();
      for (const enrollment of workspace.enrollments) {
        const policy = store.get(enrollment.id);
        if (!policy.scopes.some((s) => s.scopeId === change.scopeId))
          throw new AdminError("validation");
        if (policy.status !== "active") {
          refused.push({
            enrollmentId: enrollment.id,
            code: "ENROLLMENT_NOT_ACTIVE",
          });
          continue;
        }
        const after = cohortScope(policy, change);
        const below = new Set(subtree(policy, change.scopeId));
        const before = (scopeId: string) =>
          resolveDemoConstraints(policy, scopeId).effectiveDeadline;
        const later = (scopeId: string) =>
          resolveDemoConstraints(after, scopeId).effectiveDeadline;
        const shortenedGrants = policy.grants.flatMap((grant) => {
          const offer = policy.offers.find(
            (o) => o.terms.offerId === grant.offerId,
          );
          const scopeId = offer?.terms.scopeId;
          if (!scopeId || grant.revocation || !below.has(scopeId)) return [];
          const was = before(scopeId);
          const will = later(scopeId);
          return was && will && Date.parse(will) < Date.parse(was)
            ? [
                {
                  entryId: grant.grantId,
                  kind: "extension",
                  scopeId,
                  effectiveDeadlineBefore: was,
                  effectiveDeadlineAfter: will,
                },
              ]
            : [];
        });
        revisions.set(enrollment.id, policy.revision);
        enrollments.push({
          enrollmentId: enrollment.id,
          displayName: enrollment.profile.displayName,
          shortenedGrants,
          impacts: deadlineImpacts(policy, after).map(
            ({ shortened: _shortened, ...impact }) => impact,
          ),
        });
      }
      if (!enrollments.length) throw new AdminError("no_active_learners");
      const body = {
        courseId,
        change: clone(change),
        enrollments,
        refused,
      };
      const preview: CohortPreview = {
        migrationId: `demo-cohort-${++counter}`,
        previewDigest: await sha256Hex(JSON.stringify(body)),
        expiresAt: new Date(Date.now() + PREVIEW_MS).toISOString(),
        shortenedGrantIds: enrollments
          .flatMap((e) => e.shortenedGrants.map((g) => g.entryId))
          .sort(),
        enrollments,
        refused,
      };
      cohorts.set(preview.migrationId, {
        courseId,
        change: clone(change),
        preview: clone(preview),
        revisions,
      });
      return clone(preview);
    },
    async applyCohortMigration(courseId, input) {
      permitWrite(course(courseId));
      const found = cohorts.get(input.migrationId);
      if (
        !found ||
        found.courseId !== courseId ||
        found.preview.previewDigest !== input.previewDigest
      )
        throw new AdminError("impact_changed");
      if (found.applied !== undefined)
        return {
          migrationId: input.migrationId,
          applied: found.applied,
          replayed: true,
        };
      if (!input.reason.trim() || input.reason.length > 1000)
        throw new AdminError("validation");
      if (Date.parse(found.preview.expiresAt) < Date.now())
        throw new AdminError("impact_changed");
      if (
        !found.preview.shortenedGrantIds.every((id) =>
          input.acknowledgedShortenedGrantIds.includes(id),
        )
      )
        throw new AdminError("shortened_grant");
      // All or nothing: a learner whose policy changed since the preview stops the batch.
      for (const [enrollmentId, revision] of found.revisions)
        if (store.get(enrollmentId).revision !== revision)
          throw new AdminError("impact_changed");
      for (const enrollmentId of found.revisions.keys()) {
        const next = cohortScope(store.get(enrollmentId), found.change);
        next.revision++;
        next.policyRevision++;
        store.set(next);
      }
      found.applied = found.revisions.size;
      return {
        migrationId: input.migrationId,
        applied: found.applied,
        replayed: false,
        message: translate()("demoPolicyClient.cohortApplied", {
          count: found.applied,
        }),
      };
    },

    async previewPolicyChange(enrollmentId, scopes, signal) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const policy = enrollmentPolicy(enrollmentId);
      const replacement = replacementScopes(policy, scopes);
      const after = clone(policy);
      after.scopes = replacement;
      refresh(after);
      const changed = new Set(
        replacement
          .filter(
            (scope) =>
              JSON.stringify(scope) !==
              JSON.stringify(
                policy.scopes.find((s) => s.scopeId === scope.scopeId),
              ),
          )
          .map((scope) => scope.scopeId),
      );
      const preview = await remember(
        enrollmentId,
        scopes,
        {
          enrollmentId,
          policyRevision: policy.policyRevision,
          ledgerRevision: policy.ledgerRevision,
          scopes: clone(scopes),
          impacts: policy.scopes
            .map((scope) => ({
              scopeId: scope.scopeId,
              before: resolveDemoConstraints(policy, scope.scopeId),
              after: resolveDemoConstraints(after, scope.scopeId),
            }))
            .filter(
              (impact) =>
                JSON.stringify(impact.before) !== JSON.stringify(impact.after),
            ),
          affectedReservationIds: [],
          supersededOfferIds: policy.offers
            .filter(
              (o) =>
                ["proposed", "accepted_pending_admin"].includes(o.state) &&
                changed.has(o.terms.scopeId),
            )
            .map((o) => o.terms.offerId),
        },
        policy.revision,
      );
      return preview as unknown as PolicyMigrationPreview;
    },
    async migratePolicy(enrollmentId, input, context) {
      const found = reviewed(enrollmentId, undefined, input);
      return change(enrollmentId, context, ["migrate", input], (next) => {
        if (found.revision !== next.revision)
          throw new AdminError("impact_changed");
        const replacement = replacementScopes(next, found.request as unknown[]);
        const changed = new Set(
          replacement
            .filter(
              (scope) =>
                JSON.stringify(scope) !==
                JSON.stringify(
                  next.scopes.find((s) => s.scopeId === scope.scopeId),
                ),
            )
            .map((scope) => scope.scopeId),
        );
        next.scopes = replacement;
        for (const offer of next.offers)
          if (
            ["proposed", "accepted_pending_admin"].includes(offer.state) &&
            changed.has(offer.terms.scopeId)
          ) {
            offer.state = "superseded";
            offer.lastTransitionAt = now();
          }
        next.policyRevision++;
        return {
          receipt: { ...receipt("migrated"), outcome: "migrated" as const },
          message: translate()("demoPolicyClient.migrated"),
        };
      });
    },

    async previewAccommodation(enrollmentId, input, signal) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const policy = enrollmentPolicy(enrollmentId);
      const adjustment = accommodationAdjustment(policy, input);
      return (await remember(
        enrollmentId,
        input,
        { scopeId: input.scopeId, kind: input.kind, adjustment },
        policy.revision,
      )) as unknown as AccommodationPreview;
    },
    async applyAccommodation(enrollmentId, input, context) {
      const found = reviewed(enrollmentId, undefined, input);
      const request = found.request as AccommodationRequest;
      return change(enrollmentId, context, ["accommodate", input], (next) => {
        if (found.revision !== next.revision)
          throw new AdminError("impact_changed");
        const adjustment = accommodationAdjustment(next, request);
        const scope = next.scopes.find((s) => s.scopeId === request.scopeId)!;
        if (adjustment.windowDeadline)
          scope.window!.resolvedDeadline = adjustment.windowDeadline;
        if (adjustment.absoluteDeadline)
          scope.hardDeadline!.at = adjustment.absoluteDeadline;
        if (adjustment.additionalMinutes)
          scope.work.additionalMinutes =
            (scope.work.additionalMinutes ?? 0) + adjustment.additionalMinutes;
        if (adjustment.additionalEpisodes)
          scope.work.additionalEpisodes =
            (scope.work.additionalEpisodes ?? 0) +
            adjustment.additionalEpisodes;
        next.policyRevision++;
        next.ledgerRevision++;
        (next.accommodations ??= []).push({
          accommodationId: `demo-accommodation-${counter + 1}`,
          kind: request.kind,
          scopeId: request.scopeId,
          newPolicyRevision: next.policyRevision,
        });
        return {
          receipt: {
            ...receipt("accommodated"),
            outcome: "accommodated" as const,
          },
          message: translate()("demoPolicyClient.accommodated"),
        };
      });
    },
  };
}
