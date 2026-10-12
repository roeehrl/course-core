import { describe, expect, it } from "vitest";
import {
  demo,
  enrollmentId,
  request,
  proposal,
  enrollmentContext,
  context,
} from "./helpers";
import { learningPolicySchema } from "../src/domain/policy";

describe("calendar clocks, work caps and exact offers", () => {
  it("exposes course, chapter and episode modes, anchors and inherited work quotas", async () => {
    const policy = await demo().getPolicy(enrollmentId);
    expect(learningPolicySchema.safeParse(policy).success).toBe(true);
    expect(policy.scopes.map((scope) => scope.kind)).toEqual([
      "course",
      "chapter",
      "episode",
      "episode",
      "chapter",
    ]);
    expect(policy.scopes[0]?.work.additionalMinutes).toBe(240);
    expect(policy.scopes[1]?.window).toMatchObject({
      calendarDays: 14,
      anchor: "scope_started",
      timeZone: "UTC",
      pauseRule: "approved_only",
    });
    const open = policy.constraints.find(
      (scope) => scope.scopeId === "chapter:explore",
    )!;
    expect(policy.scopes.at(-1)?.mode).toBe("open_ended");
    expect(open.effectiveDeadline).toBe("2026-12-01T17:00:00Z");
    expect(open.quotas[0]).toMatchObject({
      scopeId: "course",
      limit: 240,
      consumed: 10,
      reserved: 5,
      remaining: 225,
    });
  });
  it("previews exact calendar changes without consuming allowance or adding work", async () => {
    const client = demo();
    const before = await client.getPolicy(enrollmentId);
    const preview = await client.previewExtension(enrollmentId, request);
    expect(preview.currentEffectiveDeadline).toBe("2026-10-26T09:00:00Z");
    expect(preview.proposedEffectiveDeadline).toBe("2026-10-28T09:00:00Z");
    expect(preview.proposedWorkQuotas).toEqual(preview.currentWorkQuotas);
    expect(preview.balanceBefore[0]).toMatchObject({
      remaining: 5,
      grantsRemaining: 2,
    });
    expect(preview.balanceAfter[0]).toMatchObject({
      remaining: 3,
      grantsRemaining: 1,
    });
    expect(await client.getPolicy(enrollmentId)).toEqual(before);
  });
  it("rejects an ancestor cap conflict instead of silently truncating the extension", async () => {
    const client = demo();
    await expect(
      client.previewExtension(enrollmentId, {
        scopeId: "episode:apply",
        days: 1,
      }),
    ).rejects.toMatchObject({ code: "parent_cap" });
    expect((await client.getPolicy(enrollmentId)).balances[0]?.remaining).toBe(
      10,
    );
  });
  it("rejects per-grant overruns, locally unbounded clocks and paused enrollments", async () => {
    const client = demo();
    await expect(
      client.previewExtension(enrollmentId, { ...request, days: 4 }),
    ).rejects.toMatchObject({ code: "per_grant_limit" });
    await expect(
      client.previewExtension(enrollmentId, {
        scopeId: "chapter:explore",
        days: 1,
      }),
    ).rejects.toMatchObject({ code: "scope_not_extendable" });
    await expect(
      client.previewExtension("sorting-learner-02", request),
    ).rejects.toMatchObject({ code: "inactive_enrollment" });
  });
  it("proposes exact hashed terms without fabricating learner consent, a grant or a debit", async () => {
    const client = demo();
    const before = await client.getPolicy(enrollmentId);
    const ctx = enrollmentContext();
    const result = await client.proposeExtension(enrollmentId, proposal, ctx);
    expect(result.policy.offers[0]).toMatchObject({
      state: "proposed",
      terms: {
        scopeId: request.scopeId,
        rationaleEvidenceRefs: ["ev-02"],
        proposedActivities: ["notice"],
        change: { deadline: { calendarDays: 2 } },
        addedWork: { additionalMinutes: 0, additionalEpisodes: 0 },
      },
    });
    expect(result.policy.offers[0]?.termsDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.policy.offers[0]?.acceptance).toBeUndefined();
    expect(result.policy.grants).toHaveLength(0);
    expect(result.policy.balances).toEqual(before.balances);
    expect(result.policy.scopes).toEqual(before.scopes);
    expect("acceptExtension" in client).toBe(false);
    expect("authorizeExtension" in client).toBe(false);
    const replay = await client.proposeExtension(enrollmentId, proposal, ctx);
    expect(replay.policy.offers).toHaveLength(1);
    expect(replay.receipt.id).toBe(result.receipt.id);
    await expect(
      client.proposeExtension(enrollmentId, { ...proposal, days: 1 }, ctx),
    ).rejects.toMatchObject({ code: "validation" });
  });
  it("rejects unscoped rationale, stale revisions and repeated outstanding offers", async () => {
    const client = demo();
    await expect(
      client.proposeExtension(
        enrollmentId,
        { ...proposal, rationaleEventIds: ["another-enrollment-event"] },
        enrollmentContext(),
      ),
    ).rejects.toMatchObject({ code: "validation" });
    await expect(
      client.proposeExtension(
        enrollmentId,
        { ...proposal, episodeIds: ["another-course-episode"] },
        enrollmentContext(),
      ),
    ).rejects.toMatchObject({ code: "validation" });
    await client.proposeExtension(enrollmentId, proposal, enrollmentContext());
    await expect(
      client.proposeExtension(enrollmentId, proposal, enrollmentContext()),
    ).rejects.toMatchObject({ code: "stale_revision" });
    await expect(
      client.proposeExtension(enrollmentId, proposal, enrollmentContext(2)),
    ).rejects.toMatchObject({ code: "offer_limit" });
  });
  it("permits read-only preview but forbids an observer proposal", async () => {
    const client = demo({ role: "observer" });
    expect((await client.previewExtension(enrollmentId, request)).days).toBe(2);
    await expect(
      client.proposeExtension(enrollmentId, proposal, enrollmentContext()),
    ).rejects.toMatchObject({ code: "permission_denied" });
  });
  it("keeps provider configuration unverified independently of calendar policy", async () => {
    const client = demo();
    const result = await client.requestProviderConfig(
      "sorting",
      "text-provider",
      { connectionLabel: "Classroom text", environment: "staging" },
      context(),
    );
    expect(result.workspace.providers[0]).toMatchObject({
      configuration: "pending_review",
      verification: "not_run",
    });
    expect((await client.getRun("sorting", "sorting-run-01")).toolCalls).toBe(
      0,
    );
    expect(
      (await client.getPolicy(enrollmentId)).scopes[0]?.work.additionalMinutes,
    ).toBe(240);
  });
});
