import { describe, expect, it } from "vitest";
import { createDemoPolicyLevels } from "../src/client/demoPolicyLevels";
import { demoSession, demoWorkspace } from "../src/data/fixtures";
import type { CourseWorkspace, Permission } from "../src/domain/contracts";
import { AdminError } from "../src/domain/errors";
import {
  policySettingsViewSchema,
  type PolicySettings,
} from "../src/domain/policyLedger";
import {
  allowancesSchema,
  batchPreviewSchema,
  batchResultSchema,
  batchesSchema,
  ceilingsViewSchema,
} from "../src/domain/policyLevels";

const workspaceId = "demo-workspace";
function setup(
  extra: Permission[] = ["policy.read", "policy.write"],
  scenario?: Parameters<typeof createDemoPolicyLevels>[0]["scenario"],
) {
  const session = demoSession("administrator");
  const courses: CourseWorkspace[] = session.courses.map((summary) => {
    const workspace = demoWorkspace(summary, "administrator");
    // Policy authority comes only from `extra`, so a test can make a reader.
    workspace.permissions = [
      ...workspace.permissions.filter((p) => !p.startsWith("policy.")),
      ...extra,
    ];
    return workspace;
  });
  const levels = createDemoPolicyLevels({
    courses: () => courses,
    latency: 0,
    scenario,
  });
  return { levels, courses };
}
const code = (promise: Promise<unknown>) =>
  promise.then(
    () => "resolved",
    (error: unknown) => (error instanceof AdminError ? error.code : error),
  );

describe("demo organization limits", () => {
  it("previews every course, then saves with a reason and the current revision", async () => {
    const { levels } = setup();
    const view = ceilingsViewSchema.parse(
      await levels.getPolicyCeilings!(workspaceId),
    );
    expect(view).toMatchObject({ source: "default", revision: 0 });
    const proposed = { ...view.ceilings, hardDeadline: "2026-11-20T17:00:00Z" };
    const preview = ceilingsViewSchema.parse(
      await levels.previewPolicyCeilings!(workspaceId, proposed),
    );
    expect(preview.impact).toHaveLength(2);
    expect(preview.impact[0]!.issues[0]!.code).toBe("LOOSER_CHILD_DEADLINE");
    expect(preview.impact.every((c) => c.feasible)).toBe(true);
    expect(
      await code(
        levels.savePolicyCeilings!(workspaceId, {
          expectedRevision: 0,
          ceilings: proposed,
          reason: " ",
        }),
      ),
    ).toBe("validation");
    const saved = ceilingsViewSchema.parse(
      await levels.savePolicyCeilings!(workspaceId, {
        expectedRevision: 0,
        ceilings: proposed,
        reason: "Term ends",
      }),
    );
    expect(saved).toMatchObject({
      source: "configured",
      revision: 1,
      outcome: "saved",
    });
    expect(
      await code(
        levels.savePolicyCeilings!(workspaceId, {
          expectedRevision: 0,
          ceilings: proposed,
          reason: "Again",
        }),
      ),
    ).toBe("stale_revision");
  });

  it("refuses a past deadline, and refuses staff without policy authority", async () => {
    const { levels } = setup();
    const view = await levels.getPolicyCeilings!(workspaceId);
    const past = { ...view.ceilings, hardDeadline: "2026-01-01T00:00:00Z" };
    const preview = await levels.previewPolicyCeilings!(workspaceId, past);
    expect(preview.impact[0]).toMatchObject({ feasible: false });
    expect(
      await code(
        levels.savePolicyCeilings!(workspaceId, {
          expectedRevision: 0,
          ceilings: past,
          reason: "x",
        }),
      ),
    ).toBe("validation");
    const reader = setup(["policy.read"]).levels;
    await reader.getPolicyCeilings!(workspaceId);
    expect(
      await code(reader.previewPolicyCeilings!(workspaceId, view.ceilings)),
    ).toBe("permission_denied");
    expect(
      await code(
        setup([], "permission_denied").levels.getPolicyCeilings!(workspaceId),
      ),
    ).toBe("permission_denied");
    expect(
      await code(
        setup([], "load_failure").levels.getAllowances!("sorting", "all"),
      ),
    ).toBe("unavailable");
  });
});

describe("demo course policy settings", () => {
  it("previews feasibility and pools before saving, and refuses an infeasible save", async () => {
    const { levels } = setup();
    const view = policySettingsViewSchema.parse(
      await levels.getPolicySettings!("sorting"),
    );
    const settings: PolicySettings = {
      ...view.settings,
      extensionPools: [
        {
          id: "extra-days",
          unit: "calendar_day",
          appliesTo: "every_chapter",
          sharing: "per_scope",
          total: 4,
          maxPerGrant: 2,
          maxGrants: 2,
        },
      ],
    };
    const preview = policySettingsViewSchema.parse(
      await levels.previewPolicySettings!("sorting", settings),
    );
    expect(preview.preview!.feasibility.feasible).toBe(true);
    expect(
      preview.preview!.pools!.find((p) => p.poolId === "extra-days"),
    ).toMatchObject({ unusableScopeIds: ["chapter:explore"] });
    const tight = {
      ...settings,
      pacing: { ...settings.pacing, studyMinutesPerDay: 1 },
    };
    const refused = await levels.previewPolicySettings!("sorting", tight);
    expect(refused.preview!.feasibility.issues[0]).toMatchObject({
      code: "TIME_ENVELOPE_TOO_SMALL",
      neededMinutes: 120,
      availableMinutes: 50,
    });
    expect(
      await code(
        levels.savePolicySettings!("sorting", {
          expectedRevision: 0,
          settings: tight,
          reason: "x",
        }),
      ),
    ).toBe("validation");
    const saved = policySettingsViewSchema.parse(
      await levels.savePolicySettings!("sorting", {
        expectedRevision: 0,
        settings,
        reason: "More room per chapter",
      }),
    );
    expect(saved).toMatchObject({ source: "configured", revision: 1 });
  });
});

describe("demo allowances and batch adjustments", () => {
  it("lists pending and all offers with pool use", async () => {
    const { levels } = setup();
    const pending = allowancesSchema.parse(
      await levels.getAllowances!("sorting", "pending"),
    );
    expect(pending.offers.map((o) => o.state)).toEqual([
      "accepted_pending_admin",
      "proposed",
    ]);
    expect(pending.accommodations).toEqual([]);
    const all = allowancesSchema.parse(
      await levels.getAllowances!("sorting", "all"),
    );
    expect(all.offers).toHaveLength(3);
    expect(all.accommodations).toHaveLength(1);
    expect(
      all.pools.find((p) => p.poolId === "episode:notice:calendar"),
    ).toMatchObject({ used: 1, grants: 1, learners: 2 });
  });

  it("previews one adjustment for everyone, refuses paused learners, applies once and replays", async () => {
    const { levels, courses } = setup();
    const preview = batchPreviewSchema.parse(
      await levels.previewAccommodationBatch!("sorting", {
        scopeId: "course",
        kind: "outage",
        change: { deadline: { kind: "absolute", calendarDays: 2 } },
      }),
    );
    const [active, paused] = courses[0]!.enrollments;
    expect(preview.enrollments).toEqual([
      expect.objectContaining({
        enrollmentId: active!.id,
        effectiveDeadlineBefore: "2026-12-01T17:00:00.000Z",
        effectiveDeadlineAfter: "2026-12-03T17:00:00.000Z",
      }),
    ]);
    expect(preview.refused).toEqual([
      expect.objectContaining({
        enrollmentId: paused!.id,
        code: "ENROLLMENT_INACTIVE",
      }),
    ]);
    expect(
      await code(
        levels.applyAccommodationBatch!("sorting", {
          batchId: preview.batchId,
          previewDigest: "wrong",
          reason: "Outage",
        }),
      ),
    ).toBe("stale_revision");
    const input = {
      batchId: preview.batchId,
      previewDigest: preview.previewDigest,
      reason: "Platform outage on Monday",
    };
    expect(
      batchResultSchema.parse(
        await levels.applyAccommodationBatch!("sorting", input),
      ),
    ).toEqual({
      batchId: preview.batchId,
      applied: 1,
      replayed: false,
      outcome: "applied",
    });
    expect(
      await levels.applyAccommodationBatch!("sorting", input),
    ).toMatchObject({ replayed: true, applied: 1 });
    const history = batchesSchema.parse(
      await levels.getAccommodationBatches!("sorting"),
    );
    expect(history.batches[0]).toMatchObject({
      batchId: preview.batchId,
      reason: "Platform outage on Monday",
      applied: 1,
    });
    const all = await levels.getAllowances!("sorting", "all");
    expect(all.accommodations.at(-1)).toMatchObject({
      batchId: preview.batchId,
      kind: "outage",
      adjustment: { absoluteDeadline: "2026-12-03T17:00:00.000Z" },
    });
  });

  it("refuses an open-ended scope and an unknown learner, and writes need policy.write", async () => {
    const { levels } = setup();
    const open = await levels.previewAccommodationBatch!("sorting", {
      scopeId: "chapter:explore",
      kind: "accommodation",
      change: { deadline: { kind: "absolute", calendarDays: 1 } },
    });
    expect(open.enrollments).toEqual([]);
    expect(open.refused[0]!.code).toBe("INVALID_CHANGE");
    expect(
      await code(
        levels.previewAccommodationBatch!("sorting", {
          scopeId: "course",
          kind: "accommodation",
          change: { deadline: { kind: "absolute", calendarDays: 1 } },
          enrollmentIds: ["nobody"],
        }),
      ),
    ).toBe("validation");
    const reader = setup(["policy.read"]).levels;
    expect(
      await code(
        reader.previewAccommodationBatch!("sorting", {
          scopeId: "course",
          kind: "outage",
          change: { deadline: { kind: "absolute", calendarDays: 1 } },
        }),
      ),
    ).toBe("permission_denied");
    expect(await code(levels.getAllowances!("missing", "all"))).toBe(
      "not_found",
    );
  });
});
