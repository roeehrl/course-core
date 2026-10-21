import { describe, expect, it } from "vitest";
import { demo, enrollmentId } from "./helpers";
import type { AdminClient } from "../src/domain/contracts";
import {
  accommodationPreviewSchema,
  accommodationResultSchema,
  learningPolicySchema,
  policyMigrationPreviewSchema,
  policyMigrationResultSchema,
} from "../src/domain/policy";
import {
  cohortPreviewSchema,
  cohortResultSchema,
  ledgerPreviewSchema,
  ledgerResultSchema,
} from "../src/domain/policyLedger";
import { allowancesSchema } from "../src/domain/policyLevels";

const offerId = `${enrollmentId}-offer-1`;
const grantId = `${enrollmentId}-offer-2-grant`;
let sequence = 0;
const ctx = (expectedRevision: number) => ({
  expectedRevision,
  idempotencyKey: `ledger-${++sequence}`,
});
const code = (promise: Promise<unknown>) =>
  promise.then(
    () => "resolved",
    (error: { code?: string }) => error.code ?? error,
  );
const deadline = (
  policy: Awaited<ReturnType<AdminClient["getPolicy"]>>,
  scopeId: string,
) => policy.constraints.find((c) => c.scopeId === scopeId)!.effectiveDeadline;

describe("demo ledger: approving learner-accepted terms", () => {
  it("seeds an accepted offer awaiting an administrator, shown in the allowances view", async () => {
    const client = demo();
    const policy = learningPolicySchema.parse(
      await client.getPolicy(enrollmentId),
    );
    expect(
      policy.offers.find((o) => o.terms.offerId === offerId),
    ).toMatchObject({
      state: "accepted_pending_admin",
      acceptance: { explicit: true },
    });
    const pending = allowancesSchema.parse(
      await client.getAllowances!("sorting", "pending"),
    );
    expect(pending.offers.map((o) => [o.offerId, o.state])).toContainEqual([
      offerId,
      "accepted_pending_admin",
    ]);
  });

  it("approves once: moves the deadline, debits the pool, replays and fences stale revisions", async () => {
    const client = demo();
    const before = await client.getPolicy(enrollmentId);
    const context = ctx(before.revision);
    const result = ledgerResultSchema.parse(
      await client.approveExtension!(enrollmentId, offerId, context),
    );
    expect(result.receipt).toMatchObject({
      authority: "demo",
      outcome: "granted",
    });
    expect(Date.parse(deadline(result.policy, "course")!)).toBe(
      Date.parse(deadline(before, "course")!) + 2 * 86_400_000,
    );
    expect(
      result.policy.balances.find((b) => b.poolId === "course:calendar"),
    ).toEqual({ poolId: "course:calendar", remaining: 8, grantsRemaining: 1 });
    expect(result.policy.revision).toBe(before.revision + 1);
    // The same key replays without a second debit; the old revision is refused.
    const replay = await client.approveExtension!(
      enrollmentId,
      offerId,
      context,
    );
    expect(replay.receipt.id).toBe(result.receipt.id);
    expect(replay.policy.balances).toEqual(result.policy.balances);
    expect(
      await code(
        client.approveExtension!(enrollmentId, offerId, ctx(before.revision)),
      ),
    ).toBe("stale_revision");
    // Already granted: nothing left to approve.
    expect(
      await code(
        client.approveExtension!(
          enrollmentId,
          offerId,
          ctx(result.policy.revision),
        ),
      ),
    ).toBe("ledger_refused");
    const all = await client.getAllowances!("sorting", "all");
    expect(all.offers.find((o) => o.offerId === offerId)?.state).toBe(
      "granted",
    );
  });

  it("rejects only with a reason and never debits; observers cannot decide", async () => {
    const client = demo();
    const before = await client.getPolicy(enrollmentId);
    expect(
      await code(
        client.rejectExtension!(
          enrollmentId,
          offerId,
          "  ",
          ctx(before.revision),
        ),
      ),
    ).toBe("validation");
    const result = await client.rejectExtension!(
      enrollmentId,
      offerId,
      "The course deadline is fixed for this cohort.",
      ctx(before.revision),
    );
    expect(
      result.policy.offers.find((o) => o.terms.offerId === offerId)?.state,
    ).toBe("rejected");
    expect(result.policy.balances).toEqual(before.balances);
    expect(result.policy.scopes).toEqual(before.scopes);
    const observer = demo({ role: "observer" });
    expect(
      await code(observer.approveExtension!(enrollmentId, offerId, ctx(1))),
    ).toBe("permission_denied");
  });
});

describe("demo ledger: revocation, refund and exceptional grant", () => {
  it("revokes a grant from its reviewed preview only, then refunds it separately", async () => {
    const client = demo();
    const before = await client.getPolicy(enrollmentId);
    const action = { kind: "revocation" as const, grantId };
    const preview = ledgerPreviewSchema.parse(
      await client.previewLedgerAction!(enrollmentId, action),
    );
    expect(preview).toMatchObject({
      previewKind: "revocation",
      kind: "extension",
      scopeId: "episode:notice",
      shortensDeadline: true,
    });
    const input = {
      previewId: preview.previewId,
      previewDigest: preview.previewDigest,
      reason: "Granted in error.",
    };
    expect(
      await code(
        client.applyLedgerAction!(
          enrollmentId,
          action,
          { ...input, previewDigest: "0".repeat(64) },
          ctx(before.revision),
        ),
      ),
    ).toBe("impact_changed");
    const revoked = await client.applyLedgerAction!(
      enrollmentId,
      action,
      input,
      ctx(before.revision),
    );
    expect(revoked.receipt.outcome).toBe("revoked");
    expect(
      revoked.policy.grants.find((g) => g.grantId === grantId)?.revocation,
    ).toBeDefined();
    expect(
      Date.parse(deadline(revoked.policy, "episode:notice")!),
    ).toBeLessThan(Date.parse(deadline(before, "episode:notice")!));
    // Revoking keeps the pool use; a refund of more than was debited is refused.
    expect(revoked.policy.balances).toEqual(before.balances);
    const tooMuch = {
      kind: "refund" as const,
      grantId,
      poolId: "episode:notice:calendar",
      amount: 2,
    };
    expect(await code(client.previewLedgerAction!(enrollmentId, tooMuch))).toBe(
      "ledger_refused",
    );
    const refund = { ...tooMuch, amount: 1 };
    const refundPreview = ledgerPreviewSchema.parse(
      await client.previewLedgerAction!(enrollmentId, refund),
    );
    const refunded = await client.applyLedgerAction!(
      enrollmentId,
      refund,
      {
        previewId: refundPreview.previewId,
        previewDigest: refundPreview.previewDigest,
        reason: "Return the day.",
      },
      ctx(revoked.policy.revision),
    );
    expect(
      refunded.policy.balances.find(
        (b) => b.poolId === "episode:notice:calendar",
      )?.remaining,
    ).toBe(5);
    expect(refunded.policy.refunds).toHaveLength(1);
  });

  it("grants an exception without a pool debit, but never past an ancestor deadline", async () => {
    const client = demo();
    const before = await client.getPolicy(enrollmentId);
    const past = {
      kind: "exception" as const,
      scopeId: "course",
      days: 30,
      deadlineKind: "absolute" as const,
    };
    expect(await code(client.previewLedgerAction!(enrollmentId, past))).toBe(
      "parent_cap",
    );
    const action = { ...past, days: 3 };
    const preview = ledgerPreviewSchema.parse(
      await client.previewLedgerAction!(enrollmentId, action),
    );
    expect(preview).toMatchObject({ previewKind: "exception", poolDebits: [] });
    const result = await client.applyLedgerAction!(
      enrollmentId,
      action,
      {
        previewId: preview.previewId,
        previewDigest: preview.previewDigest,
        reason: "Documented absence.",
      },
      ctx(before.revision),
    );
    expect(result.policy.exceptionalGrants).toHaveLength(1);
    expect(result.policy.balances).toEqual(before.balances);
    // A preview is for one action: applying it to another is refused.
    expect(
      await code(
        client.applyLedgerAction!(
          enrollmentId,
          { ...action, days: 4 },
          {
            previewId: preview.previewId,
            previewDigest: preview.previewDigest,
            reason: "Again.",
          },
          ctx(result.policy.revision),
        ),
      ),
    ).toBe("impact_changed");
  });
});

describe("demo ledger: accommodations, scope edits and cohort deadlines", () => {
  it("previews and applies one learner's accommodation; outages move deadlines only", async () => {
    const client = demo();
    const before = await client.getPolicy(enrollmentId);
    expect(
      await code(
        client.previewAccommodation!(enrollmentId, {
          scopeId: "course",
          kind: "outage",
          change: { work: { additionalMinutes: 30 } },
        }),
      ),
    ).toBe("outage_deadline_only");
    expect(
      await code(
        client.previewAccommodation!(enrollmentId, {
          scopeId: "course",
          kind: "approved_pause",
          change: { deadline: { kind: "absolute", calendarDays: 2 } },
        }),
      ),
    ).toBe("pause_not_allowed");
    const preview = accommodationPreviewSchema.parse(
      await client.previewAccommodation!(enrollmentId, {
        scopeId: "chapter:foundations",
        kind: "accommodation",
        change: {
          deadline: { kind: "window", calendarDays: 2 },
          work: { additionalMinutes: 45 },
        },
      }),
    );
    const result = accommodationResultSchema.parse(
      await client.applyAccommodation!(
        enrollmentId,
        {
          previewId: preview.previewId,
          previewDigest: preview.previewDigest,
          reason: "Extra time for a documented need.",
        },
        ctx(before.revision),
      ),
    );
    const chapter = result.policy.scopes.find(
      (s) => s.scopeId === "chapter:foundations",
    )!;
    expect(chapter.work.additionalMinutes).toBe(135);
    expect(chapter.window!.resolvedDeadline).toBe(
      preview.adjustment.windowDeadline,
    );
    expect(result.policy.accommodations).toHaveLength(1);
  });

  it("edits scopes from a preview: a looser child is refused, open offers on changed scopes are withdrawn", async () => {
    const client = demo();
    const before = await client.getPolicy(enrollmentId);
    const looser = before.scopes.map((scope) =>
      scope.scopeId === "chapter:foundations"
        ? {
            ...scope,
            hardDeadline: {
              ...scope.hardDeadline!,
              at: "2027-01-01T00:00:00Z",
            },
          }
        : scope,
    );
    expect(await code(client.previewPolicyChange!(enrollmentId, looser))).toBe(
      "looser_than_parent",
    );
    expect(
      await code(client.previewPolicyChange!(enrollmentId, [{ scopeId: "x" }])),
    ).toBe("validation");
    const tighter = before.scopes.map((scope) =>
      scope.scopeId === "course"
        ? { ...scope, targetDate: "2026-11-20T17:00:00Z" }
        : scope,
    );
    const preview = policyMigrationPreviewSchema.parse(
      await client.previewPolicyChange!(enrollmentId, tighter),
    );
    expect(preview.supersededOfferIds).toEqual([offerId]);
    const result = policyMigrationResultSchema.parse(
      await client.migratePolicy!(
        enrollmentId,
        {
          previewId: preview.previewId,
          previewDigest: preview.previewDigest,
          reason: "Earlier target for this cohort.",
        },
        ctx(before.revision),
      ),
    );
    expect(
      result.policy.offers.find((o) => o.terms.offerId === offerId)?.state,
    ).toBe("superseded");
    expect(result.policy.policyRevision).toBe(before.policyRevision + 1);
  });

  it("changes a course-wide deadline: paused learners are refused, shortened grants need acknowledgement", async () => {
    const client = demo();
    const change = {
      scopeId: "chapter:foundations",
      hardDeadline: "2026-10-16T09:00:00Z",
    };
    const preview = cohortPreviewSchema.parse(
      await client.previewCohortMigration!("sorting", change),
    );
    expect(preview.refused).toEqual([
      { enrollmentId: "sorting-learner-02", code: "ENROLLMENT_NOT_ACTIVE" },
    ]);
    expect(preview.shortenedGrantIds).toEqual([grantId]);
    const input = {
      migrationId: preview.migrationId,
      previewDigest: preview.previewDigest,
      reason: "Room booking ends earlier.",
      acknowledgedShortenedGrantIds: [] as string[],
    };
    expect(await code(client.applyCohortMigration!("sorting", input))).toBe(
      "shortened_grant",
    );
    const applied = cohortResultSchema.parse(
      await client.applyCohortMigration!("sorting", {
        ...input,
        acknowledgedShortenedGrantIds: [grantId],
      }),
    );
    expect(applied).toMatchObject({ applied: 1, replayed: false });
    const replay = await client.applyCohortMigration!("sorting", {
      ...input,
      acknowledgedShortenedGrantIds: [grantId],
    });
    expect(replay).toMatchObject({ applied: 1, replayed: true });
    const policy = await client.getPolicy(enrollmentId);
    expect(
      policy.scopes.find((s) => s.scopeId === "chapter:foundations")
        ?.hardDeadline?.at,
    ).toBe("2026-10-16T09:00:00.000Z");
  });
});
