import { describe, expect, it } from "vitest";
import { createDemoSupervision } from "../src/client/demoSupervision";
import {
  SupervisionError,
  authorityQueueSchema,
  learnerBudgetSchema,
  requeueResultSchema,
  settingsPreviewSchema,
  supervisionOverviewSchema,
  supervisionResultSchema,
  supervisionSettingsSchema,
} from "../src/domain/supervision";

const learners = [
  { id: "sorting-learner-01", name: "Alex Example" },
  { id: "sorting-learner-02", name: "Morgan Example" },
];
const ws = "demo-workspace";
const make = (
  options: Partial<Parameters<typeof createDemoSupervision>[0]> = {},
) => createDemoSupervision({ latency: 0, learners, ...options });
const code = (promise: Promise<unknown>) =>
  promise.then(
    () => "resolved",
    (error: unknown) =>
      error instanceof SupervisionError ? error.code : String(error),
  );

describe("demo supervision", () => {
  it("returns values the domain schemas accept", async () => {
    const port = make();
    const overview = await port.overview(learners[0]!.id);
    expect(supervisionOverviewSchema.parse(overview)).toEqual(overview);
    expect(overview.jobs.length).toBeGreaterThan(0);
    expect(overview.undeliveredEvents[0]).toMatchObject({ requeueable: true });
    supervisionSettingsSchema.parse(await port.settings.load(ws));
    authorityQueueSchema.parse(await port.settings.requests(ws));
    learnerBudgetSchema.parse(await port.settings.budget(ws, learners[1]!.id));
    settingsPreviewSchema.parse(
      await port.settings.preview(ws, {
        autonomyLevel: "recommend_only",
        permittedToolFamilies: [],
      }),
    );
  });

  it("pauses, stops and resumes with revisions, and replays a repeated key", async () => {
    const port = make();
    const id = learners[0]!.id;
    const paused = await port.control(id, "pause", {
      idempotencyKey: "k1",
      expectedRevision: 0,
      reasonCode: "staff_review",
    });
    expect(supervisionResultSchema.parse(paused)).toMatchObject({
      state: "paused",
      revision: 1,
      changed: true,
    });
    expect((await port.overview(id)).jobs.every((j) => j.held)).toBe(true);
    expect(
      await port.control(id, "pause", {
        idempotencyKey: "k1",
        expectedRevision: 0,
      }),
    ).toMatchObject({ replayed: true, revision: 1 });
    expect(
      await code(
        port.control(id, "resume", {
          idempotencyKey: "k1",
          expectedRevision: 1,
        }),
      ),
    ).toBe("IDEMPOTENCY_CONFLICT");
    expect(
      await code(
        port.control(id, "stop", { idempotencyKey: "k2", expectedRevision: 0 }),
      ),
    ).toBe("SUPERVISION_CONTROL_STALE");
    const stopped = await port.control(id, "stop", {
      idempotencyKey: "k3",
      expectedRevision: 1,
    });
    expect(stopped.cancelledJobs).toBe(2);
    expect(
      await code(
        port.control(id, "pause", {
          idempotencyKey: "k4",
          expectedRevision: 2,
        }),
      ),
    ).toBe("SUPERVISION_CONTROL_INVALID");
    await port.control(id, "resume", {
      idempotencyKey: "k5",
      expectedRevision: 2,
    });
    const after = await port.overview(id);
    expect(after.control.state).toBe("active");
    expect(after.jobs).toEqual([]);
    // The other learner is untouched.
    expect((await port.overview(learners[1]!.id)).control.revision).toBe(0);
  });

  it("re-queues a quarantined request once", async () => {
    const port = make();
    const id = learners[0]!.id;
    const eventId = (await port.overview(id)).undeliveredEvents[0]!.eventId;
    expect(
      await code(
        port.requeue(id, eventId, { idempotencyKey: "r0", reason: "short" }),
      ),
    ).toBe("INVALID_REQUEST");
    const result = await port.requeue(id, eventId, {
      idempotencyKey: "r1",
      reason: "The outage is over now.",
    });
    expect(requeueResultSchema.parse(result).replayed).toBe(false);
    expect(
      await code(
        port.requeue(id, eventId, {
          idempotencyKey: "r2",
          reason: "Once more, please.",
        }),
      ),
    ).toBe("SUPERVISOR_EVENT_ALREADY_REQUEUED");
    expect((await port.overview(id)).undeliveredEvents[0]).toMatchObject({
      requeued: true,
      requeueable: false,
    });
  });

  it("saves settings against the revision and previews tool changes", async () => {
    const port = make();
    const current = await port.settings.load(ws);
    const preview = await port.settings.preview(ws, {
      autonomyLevel: "propose_only",
      permittedToolFamilies: ["teaching"],
    });
    expect(preview.warnings).toEqual(["no_learner_read"]);
    expect(preview.toolsRemoved).toContain("get_profile");
    const saved = await port.settings.save(ws, {
      expectedRevision: current.revision,
      autonomyLevel: "recommend_only",
      permittedToolFamilies: ["teaching", "learner_read"],
    });
    expect(saved.revision).toBe(current.revision + 1);
    expect(saved.permittedToolFamilies).toEqual(["learner_read", "teaching"]);
    expect(
      await code(
        port.settings.save(ws, {
          expectedRevision: current.revision,
          autonomyLevel: "recommend_only",
          permittedToolFamilies: [],
        }),
      ),
    ).toBe("SUPERVISION_SETTINGS_CHANGED");
  });

  it("decides staff requests only, and checks spending limits", async () => {
    const port = make();
    const { requests } = await port.settings.requests(ws);
    const [staff, learner] = requests;
    const decided = await port.settings.decide(ws, staff!.requestId, {
      idempotencyKey: "d1",
      decision: "approve",
    });
    expect(decided.state).toBe("approved");
    expect(
      await code(
        port.settings.decide(ws, staff!.requestId, {
          idempotencyKey: "d2",
          decision: "reject",
        }),
      ),
    ).toBe("AUTHORITY_REQUEST_CLOSED");
    expect(
      await code(
        port.settings.decide(ws, learner!.requestId, {
          idempotencyKey: "d3",
          decision: "approve",
        }),
      ),
    ).toBe("AUTHORITY_DECIDED_BY_LEARNER");
    const id = learners[0]!.id;
    expect(
      await code(
        port.settings.saveBudget(ws, id, {
          daily: { microUsd: 100, tokens: 100 },
          artifact: { microUsd: 200, tokens: 50 },
        }),
      ),
    ).toBe("SUPERVISION_LESSON_LIMIT_ABOVE_DAILY");
    const budget = await port.settings.saveBudget(ws, id, {
      daily: null,
      artifact: { microUsd: 200, tokens: 50 },
    });
    expect(learnerBudgetSchema.parse(budget)).toMatchObject({
      daily: null,
      artifact: { microUsd: 200, tokens: 50 },
    });
  });

  it("refuses by role and scenario", async () => {
    const reviewer = make({ role: "reviewer" });
    const overview = await reviewer.overview(learners[0]!.id);
    expect(overview).toMatchObject({ canControl: false, canRequeue: false });
    expect(
      await code(
        reviewer.control(learners[0]!.id, "pause", {
          idempotencyKey: "x",
          expectedRevision: 0,
        }),
      ),
    ).toBe("FORBIDDEN");
    expect(await code(reviewer.settings.load(ws))).toBe("FORBIDDEN");
    expect(
      await code(make({ role: "observer" }).overview(learners[0]!.id)),
    ).toBe("FORBIDDEN");
    expect(
      await code(
        make({ scenario: "permission_denied" }).overview(learners[0]!.id),
      ),
    ).toBe("FORBIDDEN");
    expect(
      await code(make({ scenario: "load_failure" }).overview(learners[0]!.id)),
    ).toBe("unavailable");
    expect(await code(make().overview("missing"))).toBe("SUPERVISOR_NOT_FOUND");
    const stale = make({ scenario: "stale_revision" });
    expect(
      await code(
        stale.control(learners[0]!.id, "pause", {
          idempotencyKey: "s1",
          expectedRevision: 0,
        }),
      ),
    ).toBe("SUPERVISION_CONTROL_STALE");
  });

  it("stops at an abort", async () => {
    const port = createDemoSupervision({ latency: 50, learners });
    const controller = new AbortController();
    const pending = port.overview(learners[0]!.id, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});
