import type { AdminClient, Enrollment } from "../domain/contracts";
import {
  extensionRequestSchema,
  proposalInputSchema,
  type ExtensionPreview,
  type ExtensionProposalResult,
  type LearningPolicy,
} from "../domain/policy";
import {
  demoLearningPolicy,
  resolveDemoConstraints,
} from "../data/policyFixtures";
import { AdminError } from "../domain/errors";
import { sha256Hex } from "../domain/webCrypto";
import { englishTranslator, type Translate } from "../i18n";

export function createDemoPolicyClient(
  getEnrollment: (id: string) => Enrollment,
  canPropose: (id: string) => void,
  /** The translator for simulated server messages, read at the time of each call. */
  translate: () => Translate = () => englishTranslator().t,
): Pick<AdminClient, "getPolicy" | "previewExtension" | "proposeExtension"> {
  const policies = new Map<string, LearningPolicy>();
  const receipts = new Map<
    string,
    { fingerprint: string; result: ExtensionProposalResult }
  >();
  let busy = false;
  let counter = 0;
  function get(id: string) {
    const enrollment = getEnrollment(id);
    if (!policies.has(id)) policies.set(id, demoLearningPolicy(enrollment));
    return policies.get(id)!;
  }
  async function preview(
    enrollmentId: string,
    input: Parameters<AdminClient["previewExtension"]>[1],
  ): Promise<ExtensionPreview> {
    if (!extensionRequestSchema.safeParse(input).success)
      throw new AdminError("validation");
    const policy = get(enrollmentId);
    if (policy.status !== "active") throw new AdminError("inactive_enrollment");
    const scope = policy.scopes.find((item) => item.scopeId === input.scopeId);
    if (!scope?.extensions?.enabled || (!scope.window && !scope.hardDeadline))
      throw new AdminError("scope_not_extendable");
    const current = resolveDemoConstraints(policy, input.scopeId);
    const pool = policy.pools.find(
      (item) =>
        scope.extensions!.poolIds.includes(item.poolId) &&
        ["calendar_day", "scope_calendar_day"].includes(item.unit),
    );
    const balance = policy.balances.find(
      (item) => item.poolId === pool?.poolId,
    );
    if (!pool || !balance) throw new AdminError("scope_not_extendable");
    if (input.days > pool.maxPerGrant) throw new AdminError("per_grant_limit");
    if (input.days > balance.remaining || balance.grantsRemaining === 0)
      throw new AdminError("allowance_exhausted");
    const source = scope.window?.resolvedDeadline ?? scope.hardDeadline!.at;
    const zone = scope.window?.timeZone ?? scope.hardDeadline!.timeZone;
    const { Temporal } = await import("@js-temporal/polyfill");
    const proposed = Temporal.Instant.from(source)
      .toZonedDateTimeISO(zone)
      .add({ days: input.days })
      .toInstant()
      .toString();
    const after = structuredClone(policy);
    const adjusted = after.scopes.find(
      (item) => item.scopeId === input.scopeId,
    )!;
    if (adjusted.window) adjusted.window.resolvedDeadline = proposed;
    else adjusted.hardDeadline!.at = proposed;
    const next = resolveDemoConstraints(after, input.scopeId);
    if (
      Date.parse(next.effectiveDeadline!) !== Date.parse(proposed) ||
      Date.parse(next.effectiveDeadline!) <=
        Date.parse(current.effectiveDeadline!)
    )
      throw new AdminError("parent_cap");
    return {
      enrollmentId,
      scopeId: input.scopeId,
      days: input.days,
      revision: policy.revision,
      policyRevision: policy.policyRevision,
      ledgerRevision: policy.ledgerRevision,
      adjustment: {
        scopeId: input.scopeId,
        ...(scope.window
          ? { windowDeadline: proposed }
          : { absoluteDeadline: proposed }),
        additionalMinutes: 0,
        additionalEpisodes: 0,
      },
      currentEffectiveDeadline: current.effectiveDeadline,
      proposedEffectiveDeadline: next.effectiveDeadline,
      currentWorkQuotas: current.quotas,
      proposedWorkQuotas: next.quotas,
      poolDebits: [{ poolId: pool.poolId, amount: input.days }],
      balanceBefore: [structuredClone(balance)],
      balanceAfter: [
        {
          poolId: pool.poolId,
          remaining: balance.remaining - input.days,
          grantsRemaining: balance.grantsRemaining - 1,
        },
      ],
      bindingAncestorCaps: next.deadlines.filter(
        (item) => item.scopeId !== scope.scopeId || item.kind === "ultimate",
      ),
      requiredApprovals: current.ancestorScopeIds.flatMap(
        (id) =>
          policy.scopes.find((s) => s.scopeId === id)?.extensions
            ?.requiredAuthorityIds ?? [],
      ),
    };
  }
  return {
    async getPolicy(id, signal) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      return structuredClone(get(id));
    },
    async previewExtension(id, input, signal) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      return preview(id, input);
    },
    async proposeExtension(id, input, context) {
      if (busy) throw new AdminError("unavailable");
      busy = true;
      try {
        canPropose(id);
        const current = get(id);
        const fingerprint = JSON.stringify(input);
        const key = JSON.stringify([id, context.idempotencyKey]);
        const replay = receipts.get(key);
        if (replay) {
          if (replay.fingerprint !== fingerprint)
            throw new AdminError("validation");
          return {
            ...structuredClone(replay.result),
            policy: structuredClone(current),
          };
        }
        if (context.expectedRevision !== current.revision)
          throw new AdminError("stale_revision");
        if (
          !proposalInputSchema.safeParse(input).success ||
          input.rationaleEventIds.some(
            (ref) => !current.rationaleEvents.some((event) => event.id === ref),
          ) ||
          input.episodeIds.some(
            (ref) =>
              !current.activities.some((activity) => activity.id === ref),
          )
        )
          throw new AdminError("validation");
        const result = await preview(id, {
          scopeId: input.scopeId,
          days: input.days,
        });
        const scope = current.scopes.find(
          (scope) => scope.scopeId === input.scopeId,
        )!;
        const prior = current.offers.filter(
          (offer) => offer.terms.scopeId === input.scopeId,
        );
        if (
          prior.length >= scope.extensions!.maxOffersPerScope ||
          prior.some(
            (offer) =>
              ["proposed", "accepted_pending_admin"].includes(offer.state) &&
              Date.parse(offer.terms.expiresAt) > Date.now(),
          ) ||
          prior.some(
            (offer) =>
              Date.now() - Date.parse(offer.lastTransitionAt) <
              scope.extensions!.offerCooldownHours * 3600_000,
          )
        )
          throw new AdminError("offer_limit");
        const offerId = `demo-offer-${++counter}`;
        const now = new Date().toISOString();
        const terms: LearningPolicy["offers"][number]["terms"] = {
          offerId,
          scopeId: input.scopeId,
          enrollmentId: id,
          expectedPolicyRevision: current.policyRevision,
          rationaleEvidenceRefs: [...input.rationaleEventIds],
          proposedActivities: [...input.episodeIds],
          currentEffectiveDeadline: result.currentEffectiveDeadline,
          proposedEffectiveDeadline: result.proposedEffectiveDeadline,
          currentWorkQuotas: result.currentWorkQuotas,
          proposedWorkQuotas: result.proposedWorkQuotas,
          change: {
            deadline: {
              kind: scope.window ? "window" : "absolute",
              calendarDays: input.days,
            },
          },
          addedWork: {
            additionalMinutes: 0,
            additionalEpisodes: 0,
            remediation: [],
          },
          poolDebits: result.poolDebits,
          balanceBefore: result.balanceBefore,
          balanceAfter: result.balanceAfter,
          bindingAncestorCaps: result.bindingAncestorCaps,
          requiredApprovals: result.requiredApprovals,
          planImpact: input.planImpact,
          alternatives: [...input.alternatives],
          createdAt: now,
          expiresAt: new Date(Date.now() + 48 * 3600_000).toISOString(),
        };
        const termsDigest = await sha256Hex(JSON.stringify(terms));
        const next = structuredClone(current);
        next.revision++;
        next.ledgerRevision++;
        next.offers.push({
          terms,
          termsDigest,
          state: "proposed",
          lastTransitionAt: now,
        });
        // A proposal is neither consent nor a grant. No deadline, quota or balance changes.
        next.constraints = next.scopes.map((scope) =>
          resolveDemoConstraints(next, scope.scopeId),
        );
        const response: ExtensionProposalResult = {
          policy: next,
          receipt: {
            id: `demo-proposal-${counter}`,
            authority: "demo",
            outcome: "proposed",
          },
          message: translate()("demoPolicyClient.offerProposed"),
        };
        policies.set(id, next);
        receipts.set(key, { fingerprint, result: structuredClone(response) });
        return structuredClone(response);
      } finally {
        busy = false;
      }
    },
  };
}
