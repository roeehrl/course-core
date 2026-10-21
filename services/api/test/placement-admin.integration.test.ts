import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import { createDatabase, type Database } from "../src/database.js";
import { createTestDatabase, type TestDatabase } from "./test-database.js";
import { createServer } from "../src/server.js";
import { issueLoginCode } from "../src/auth.js";
import { authorPlacementLimit, effectivePlacement, placementLimitError, retestAvailability } from "../src/placement-settings.js";
import { placementPlan } from "../src/placement.js";
import { fixture } from "./fixture.js";

// Real HTTP and PostgreSQL 17: placement settings (default off, tighten-only), numbered retests,
// the per-exemption view, staff overrides and the false-skip / repetition counters.
const origin = "http://localhost:4395",
  schema = "placement_admin_" + randomUUID().replaceAll("-", "");
let db: Database, app: Awaited<ReturnType<typeof createServer>>;
interface Session { userId: string; cookie: string; csrf: string }
let workspace: string, owner: Session, learner: Session, instructor: Session, catalog: string, release: string, enrollment: string, versions = 0;
const correct: Record<string, string | number> = { "min-a": "two", "min-b": 4, "max-a": 9, "max-b": -3 };
const wrong: Record<string, string | number> = { "min-a": "five", "min-b": 9, "max-a": 4, "max-b": -8 };

async function person(role: string): Promise<Session> {
  const id = randomUUID();
  await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [id, "pa:" + id, role + " person"]);
  await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspace, id, role]);
  const r = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, id) } });
  return { userId: id, cookie: r.cookies.map((c) => c.name + "=" + c.value).join("; "), csrf: r.json().csrfToken };
}
const call = (who: Session, method: "GET" | "POST", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { origin, cookie: who.cookie, "x-csrf-token": who.csrf }, ...(payload === undefined ? {} : { payload: payload as object }) });
const settings = async () => (await call(owner, "GET", `/api/admin/courses/${catalog}/placement`)).json();
const save = async (body: Record<string, unknown>, who = owner) =>
  call(who, "POST", `/api/admin/courses/${catalog}/placement/settings`, { expectedRevision: (await settings()).settings.revision, enabled: true, retestCooldownHours: 0, maxRuns: 1, maxItems: null, minFamiliesPerEpisode: null, ...body });
const revision = async (id = enrollment) => (await call(learner, "GET", `/api/enrollments/${id}`)).json().revision;
const send = async (action: string, body: Record<string, unknown> = {}, id = enrollment) =>
  call(learner, "POST", `/api/enrollments/${id}/${action}`, { expectedRevision: await revision(id), idempotencyKey: randomUUID(), ...body });
const state = async () => (await call(learner, "GET", `/api/enrollments/${enrollment}/placement`)).json();
async function take(answers = correct) {
  const next = (await state()).run.nextItem;
  expect(next, "server proposed no item").toBeTruthy();
  const issued = await send("challenges", { episodeId: next.episodeId, assessmentId: next.assessmentId, mode: "placement" });
  expect(issued.statusCode, issued.body).toBe(200);
  expect((await send("answers", { challengeId: issued.json().challengeId, answer: answers[next.assessmentId] })).statusCode).toBe(200);
  return next.assessmentId as string;
}

let testDatabase: TestDatabase | undefined;
beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false });
}, 30000);
beforeEach(async () => {
  workspace = randomUUID();
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspace, "pa-" + workspace, "Placement admin"]);
  owner = await person("owner");
  learner = await person("learner");
  instructor = await person("instructor");
  const manifest = fixture();
  manifest.version = `2.0.${versions++}`;
  release = (await call(owner, "POST", `/api/workspaces/${workspace}/releases`, manifest)).json().id;
  expect((await call(owner, "POST", `/api/releases/${release}/publish`)).statusCode).toBe(200);
  catalog = (await call(owner, "GET", "/api/admin/session")).json().courses[0].id;
  enrollment = (await call(learner, "POST", "/api/enrollments", { releaseId: release })).json().id;
});
afterAll(async () => {
  await app?.close();
  await db?.end();
  await testDatabase?.drop();
});

describe("placement settings", () => {
  it("are off by default even when the manifest offers placement, and only staff with policy rights change them", async () => {
    expect(await settings()).toMatchObject({ author: { enabled: true, maxItems: 4 }, settings: { enabled: false, revision: 0 }, effective: { enabled: false, authorEnabled: true, staffEnabled: false } });
    expect(await state()).toMatchObject({ available: false, state: "unavailable" });
    expect((await send("placement/start")).json().error).toBe("PLACEMENT_UNAVAILABLE");
    expect((await send("challenges", { episodeId: "min", assessmentId: "min-a", mode: "placement" })).json().error).toBe("PLACEMENT_UNAVAILABLE");
    expect((await save({}, instructor)).statusCode).toBe(403);
    expect((await call(learner, "GET", `/api/admin/courses/${catalog}/placement`)).statusCode).toBe(403);
    const saved = await save({});
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().settings).toMatchObject({ enabled: true, revision: 1 });
    expect(await state()).toMatchObject({ available: true, state: "offered", maxRuns: 1 });
    // Stale revisions are refused.
    expect((await call(owner, "POST", `/api/admin/courses/${catalog}/placement/settings`, { expectedRevision: 0, enabled: false, retestCooldownHours: 0, maxRuns: 1, maxItems: null, minFamiliesPerEpisode: null })).json().error).toBe("STALE_REVISION");
    // A settings change is audited as a staff event.
    expect((await db.query("SELECT count(*)::int AS n FROM learning_events WHERE workspace_id=$1 AND event_type='placement.settings_changed'", [workspace])).rows[0].n).toBe(1);
  });

  it("only tighten the author's limits", async () => {
    expect((await save({ maxItems: 5 })).json().error).toBe("PLACEMENT_LIMIT_LOOSENS_AUTHOR");
    expect((await save({ maxItems: 2 })).statusCode).toBe(200);
    expect((await settings()).effective).toMatchObject({ enabled: true, maxItems: 2, authorMaxItems: 4 });
    expect((await state()).maxItems).toBe(2);
    expect((await send("placement/start")).statusCode).toBe(200);
    await take();
    await take();
    // The allowance is the staff's lower number.
    const view = await state();
    expect(view.run).toMatchObject({ itemsUsed: 2, nextItem: null, stopReason: "item_limit" });
  });

  it("an extra family threshold keeps an episode on the path that the gate alone would exempt", () => {
    const course = fixture();
    const attempts = ["min-a", "min-b"].map((id) => ({ episodeId: "min", assessmentId: id, familyId: course.assessments.find((a) => a.id === id)!.familyId,
      objectiveIds: ["minimum"], passed: true, independent: true, evidence: [{ id: randomUUID(), objectiveId: "minimum", passed: true }] }));
    expect(placementPlan(course, "d", attempts, ["min-a", "min-b"], { allowNextItem: false }).exemptEpisodeIds).toEqual(["min"]);
    expect(placementPlan(course, "d", attempts, ["min-a", "min-b"], { allowNextItem: false, minFamiliesPerEpisode: 3 }).exemptEpisodeIds).toEqual([]);
    const off = effectivePlacement(course, null);
    expect(off).toMatchObject({ enabled: false, maxItems: 4 });
    const noAuthor = { ...course, placement: { ...course.placement!, enabled: false } };
    expect(effectivePlacement(noAuthor, { enabled: true } as never).enabled).toBe(false);
  });
});

describe("the author's question limit across releases", () => {
  // A fresh course whose releases are published in order; the helpers above then act on it.
  async function course(...placements: (Record<string, unknown> | null)[]) {
    workspace = randomUUID();
    await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspace, "pl-" + workspace, "Placement limits"]);
    owner = await person("owner");
    for (const placement of placements) {
      const manifest = fixture() as unknown as Record<string, unknown>;
      manifest.version = `3.0.${versions++}`;
      if (placement === null) delete manifest.placement;
      else manifest.placement = { ...(manifest.placement as object), ...placement };
      const created = await call(owner, "POST", `/api/workspaces/${workspace}/releases`, manifest);
      expect(created.statusCode, created.body).toBe(200);
      expect((await call(owner, "POST", `/api/releases/${created.json().id}/publish`)).statusCode).toBe(200);
    }
    catalog = (await call(owner, "GET", "/api/admin/session")).json().courses[0].id;
  }

  it("ignores an older published release without placement", async () => {
    await course(null, { maxItems: 3 });
    expect((await settings()).authorLimit).toBe(3);
    expect((await save({ maxItems: 4 })).json().error).toBe("PLACEMENT_LIMIT_LOOSENS_AUTHOR");
    const saved = await save({ maxItems: 3 });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().settings.maxItems).toBe(3);
    expect((await save({ maxItems: 1 })).statusCode).toBe(200);
    expect((await save({ maxItems: null })).statusCode).toBe(200);
  });

  it("ignores a release whose placement is switched off, and takes the lowest of those that offer it", async () => {
    await course({ enabled: false, maxItems: 1 }, { maxItems: 2 }, { maxItems: 4 });
    expect((await settings()).authorLimit).toBe(2);
    expect((await save({ maxItems: 3 })).json().error).toBe("PLACEMENT_LIMIT_LOOSENS_AUTHOR");
    expect((await save({ maxItems: 2 })).statusCode).toBe(200);
  });

  it("refuses any limit when no live release offers placement, but still saves the other settings", async () => {
    await course(null, { enabled: false });
    expect((await settings()).authorLimit).toBeNull();
    const refused = await save({ maxItems: 1 });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe("PLACEMENT_NOT_OFFERED");
    expect((await save({ maxItems: null, maxRuns: 2 })).statusCode).toBe(200);
    expect((await settings()).settings).toMatchObject({ maxItems: null, maxRuns: 2, revision: 1 });
  });

  it("does not let a placement policy without maxItems into a release", async () => {
    workspace = randomUUID();
    await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspace, "pl-" + workspace, "Placement limits"]);
    owner = await person("owner");
    const manifest = fixture() as unknown as { version: string; placement: Record<string, unknown> };
    manifest.version = `3.0.${versions++}`;
    delete manifest.placement.maxItems;
    expect((await call(owner, "POST", `/api/workspaces/${workspace}/releases`, manifest)).statusCode).toBe(400);
  });

  it("reads a stored policy without maxItems as the runtime does: no questions", () => {
    const course = fixture();
    const loose = { placement: { ...course.placement!, maxItems: undefined as unknown as number } };
    expect(placementPlan({ ...course, ...loose }, "d", [], [], { allowNextItem: true }).maxItems).toBe(0);
    expect(authorPlacementLimit([loose, course])).toBe(0);
    expect(placementLimitError(1, authorPlacementLimit([loose]))).toBe("PLACEMENT_LIMIT_LOOSENS_AUTHOR");
    expect(authorPlacementLimit([])).toBeNull();
    expect(placementLimitError(null, null)).toBeNull();
    expect(placementLimitError(4, 4)).toBeNull();
  });
});

describe("retests", () => {
  it("number runs, respect the cooldown and the run limit, and allow one run in progress", async () => {
    await save({ maxRuns: 2, retestCooldownHours: 1 });
    expect((await send("placement/start")).json()).toMatchObject({ state: "in_progress", runNumber: 1 });
    expect((await send("placement/start")).json().error).toBe("PLACEMENT_ALREADY_TAKEN");
    await take(wrong);
    expect((await send("placement/finish")).statusCode).toBe(200);
    const cooling = await send("placement/start");
    expect(cooling.statusCode).toBe(409);
    expect(cooling.json()).toMatchObject({ error: "PLACEMENT_RETEST_COOLDOWN", details: { availableAt: expect.any(String) } });
    expect((await state()).retest).toMatchObject({ allowed: false, availableAt: expect.any(String) });
    await save({ maxRuns: 2, retestCooldownHours: 0 });
    expect((await state()).retest.allowed).toBe(true);
    expect((await send("placement/start")).json()).toMatchObject({ state: "in_progress", runNumber: 2 });
    // A retest never reuses an item the learner already saw.
    const second = await state();
    expect(second.run.nextItem?.assessmentId).not.toBe("min-a");
    expect((await send("placement/finish")).statusCode).toBe(200);
    expect((await send("placement/start")).json().error).toBe("PLACEMENT_RUN_LIMIT");
    expect((await db.query("SELECT run_number,state FROM placement_runs WHERE enrollment_id=$1 ORDER BY run_number", [enrollment])).rows)
      .toEqual([{ run_number: 1, state: "finished" }, { run_number: 2, state: "finished" }]);
    // The database also refuses two runs in progress for one enrollment.
    await db.query("UPDATE placement_runs SET state='in_progress' WHERE enrollment_id=$1 AND run_number=1", [enrollment]);
    await expect(db.query("UPDATE placement_runs SET state='in_progress' WHERE enrollment_id=$1 AND run_number=2", [enrollment])).rejects.toThrow(/placement_runs_one_in_progress/);
  });

  it("retest availability is computed from the latest run", () => {
    const eff = effectivePlacement(fixture(), { enabled: true, retest_cooldown_hours: 2, max_runs: 2 } as never);
    const now = Date.parse("2026-10-15T12:00:00Z");
    expect(retestAvailability(eff, [], now).allowed).toBe(false);
    expect(retestAvailability(eff, [{ state: "accepted", finished_at: new Date(now - 10 * 3_600_000) }], now).allowed).toBe(false);
    expect(retestAvailability(eff, [{ state: "finished", finished_at: new Date(now - 3_600_000) }], now)).toMatchObject({ allowed: false, availableAt: "2026-10-15T13:00:00.000Z" });
    expect(retestAvailability(eff, [{ state: "finished", finished_at: new Date(now - 3 * 3_600_000) }], now).allowed).toBe(true);
    expect(retestAvailability(eff, [{ state: "finished", finished_at: null }, { state: "finished", finished_at: new Date(now - 9e7) }], now).allowed).toBe(false);
  });
});

describe("exemptions", () => {
  async function placeOutOfMin() {
    await save({});
    expect((await send("placement/start")).statusCode).toBe(200);
    await take();
    await take();
    await take(wrong);
    expect((await send("placement/finish")).json()).toMatchObject({ exemptEpisodeIds: ["min"], startEpisodeId: "max" });
    expect((await send("placement/accept", { startEpisodeId: "max" })).statusCode).toBe(200);
  }

  it("show each exemption's evidence and version, and staff can revoke one with a reason", async () => {
    await placeOutOfMin();
    const view = await call(instructor, "GET", `/api/admin/enrollments/${enrollment}/placement`);
    expect(view.statusCode, view.body).toBe(200);
    expect(view.json()).toMatchObject({ runs: [{ runNumber: 1, state: "accepted", itemsUsed: 3 }], overrides: [],
      exemptions: [{ episodeId: "min", runNumber: 1, evidence: expect.arrayContaining([expect.objectContaining({ assessmentId: "min-a", independent: true, passed: true, invalidated: false, sameCourseVersion: true, placement: true })]) }] });
    expect(view.json().exemptions[0].evidence).toHaveLength(2);
    expect((await call(learner, "GET", `/api/admin/enrollments/${enrollment}/placement`)).statusCode).toBe(403);
    const url = `/api/admin/enrollments/${enrollment}/placement/exemptions/min/revoke`;
    const body = async () => ({ expectedRevision: (await call(owner, "GET", `/api/admin/courses/${catalog}`)).json().enrollments.find((e: { id: string }) => e.id === enrollment).revision,
      idempotencyKey: "revoke-" + randomUUID(), reason: "Diagnostic answers suggest a gap in the invariant." });
    const first = await body();
    expect((await call(owner, "POST", url, { ...first, reason: "short" })).statusCode).toBe(400);
    const revoked = await call(instructor, "POST", url, first);
    expect(revoked.statusCode, revoked.body).toBe(200);
    expect((await call(instructor, "POST", url, first)).json()).toEqual(revoked.json());
    expect((await call(instructor, "POST", url, await body())).json().error).toBe("PLACEMENT_EXEMPTION_NOT_FOUND");
    const after = (await call(instructor, "GET", `/api/admin/enrollments/${enrollment}/placement`)).json();
    expect(after.exemptions).toEqual([]);
    expect(after.overrides).toEqual([expect.objectContaining({ episodeId: "min", reason: first.reason, revokedBy: "instructor person", evidenceRefs: expect.any(Array) })]);
    // The episode is back on the learner's path; the evidence is kept.
    const lesson = (await call(learner, "GET", `/api/enrollments/${enrollment}`)).json().lessons.find((l: { id: string }) => l.id === "min");
    expect(lesson.status).not.toBe("placed");
    expect((await settings()).counters.falseSkips).toMatchObject({ revokedByStaff: 1 });
    await expect(db.query("DELETE FROM placement_exemption_overrides")).rejects.toThrow(/PLACEMENT_OVERRIDE_IMMUTABLE/);
  });

  it("count false skips (a later independent failure) and unnecessary repetitions", async () => {
    await placeOutOfMin();
    expect((await settings()).counters).toMatchObject({ exemptions: 1, runs: { accepted: 1 }, falseSkips: { total: 0 }, unnecessaryRepetitions: 0 });
    // A later independent wrong answer on the exempted objective counts as a false skip.
    const issued = await send("challenges", { episodeId: "min", assessmentId: "min-b", mode: "independent" });
    expect(issued.statusCode, issued.body).toBe(200);
    expect((await send("answers", { challengeId: issued.json().challengeId, answer: 9 })).statusCode).toBe(200);
    expect((await settings()).counters.falseSkips).toMatchObject({ laterFailed: 1, total: 1 });
    // Another learner whose run demonstrated "minimum" but who studied the episode anyway.
    const other = await person("learner");
    const id = (await call(other, "POST", "/api/enrollments", { releaseId: release })).json().id;
    await db.query(`INSERT INTO placement_runs(id,enrollment_id,state,started_at,finished_at,proposal,run_number) VALUES($1,$2,'finished',clock_timestamp(),clock_timestamp(),$3,1)`,
      [randomUUID(), id, JSON.stringify({ exemptEpisodeIds: ["min"], demonstrated: [{ objectiveId: "minimum", evidenceIds: [], families: [] }], itemsUsed: 2 })]);
    await db.query("INSERT INTO episode_progress(enrollment_id,episode_id,state,completed_at) VALUES($1,'min','completed',now())", [id]);
    expect((await settings()).counters.unnecessaryRepetitions).toBe(1);
  });

  it("erasure blanks a staff override reason and keeps the record", async () => {
    await placeOutOfMin();
    const rev = (await call(owner, "GET", `/api/admin/courses/${catalog}`)).json().enrollments.find((e: { id: string }) => e.id === enrollment).revision;
    expect((await call(owner, "POST", `/api/admin/enrollments/${enrollment}/placement/exemptions/min/revoke`, { expectedRevision: rev, idempotencyKey: "rv-" + randomUUID(), reason: "Learner asked to study it after all." })).statusCode).toBe(200);
    const erased = await call(owner, "POST", `/api/enrollments/${enrollment}/erase`, { confirmation: `ERASE ${enrollment.slice(0, 8)}`, reason: "Learner asked for their course data to be removed." });
    expect(erased.statusCode, erased.body).toBe(200);
    expect((await db.query("SELECT reason FROM placement_exemption_overrides WHERE enrollment_id=$1", [enrollment])).rows).toEqual([{ reason: "[erased]" }]);
  });
});

describe("the author's placement policy (H02)", () => {
  /** A fresh course whose manifest declares the SDK 0.5 placement policy fields, with one learner. */
  async function authored(extra: Record<string, unknown>) {
    workspace = randomUUID();
    await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspace, "ph-" + workspace, "Placement policy"]);
    owner = await person("owner");
    learner = await person("learner");
    const manifest = fixture() as unknown as Record<string, unknown>;
    manifest.version = `4.0.${versions++}`;
    manifest.placement = { ...(manifest.placement as object), ...extra };
    const created = await call(owner, "POST", `/api/workspaces/${workspace}/releases`, manifest);
    expect(created.statusCode, created.body).toBe(200);
    release = created.json().id;
    expect((await call(owner, "POST", `/api/releases/${release}/publish`)).statusCode).toBe(200);
    catalog = (await call(owner, "GET", "/api/admin/session")).json().courses[0].id;
    enrollment = (await call(learner, "POST", "/api/enrollments", { releaseId: release })).json().id;
  }
  const policy = { retestPolicy: { maxAttempts: 2, cooldownDays: 1 }, assistancePolicy: "unassisted_only",
    evidenceThresholds: { minimumIndependentFamilies: 2, skipRequiresCriticalPrerequisites: true } };

  it("bounds staff retests, cooldown and evidence by the author's, and refuses settings that loosen them", async () => {
    await authored(policy);
    const view = await settings();
    expect(view.authorBounds).toEqual({ maxRuns: 2, minCooldownHours: 24, minFamiliesPerEpisode: 2 });
    expect(view.author).toMatchObject({ retestPolicy: policy.retestPolicy, assistancePolicy: "unassisted_only", evidenceThresholds: policy.evidenceThresholds });
    // Before any staff setting, the author's own policy applies.
    expect(view.effective).toMatchObject({ maxRuns: 2, retestCooldownHours: 24, minFamiliesPerEpisode: 2, unassistedOnly: true });
    expect((await save({ maxRuns: 3, retestCooldownHours: 24 })).json().error).toBe("PLACEMENT_RETESTS_LOOSEN_AUTHOR");
    expect((await save({ maxRuns: 2, retestCooldownHours: 0 })).json().error).toBe("PLACEMENT_COOLDOWN_LOOSENS_AUTHOR");
    expect((await save({ maxRuns: 2, retestCooldownHours: 24, minFamiliesPerEpisode: 1 })).json().error).toBe("PLACEMENT_EVIDENCE_LOOSENS_AUTHOR");
    expect((await settings()).settings.revision).toBe(0);
    expect((await save({ maxRuns: 1, retestCooldownHours: 48, minFamiliesPerEpisode: 2 })).statusCode).toBe(200);
    expect((await settings()).effective).toMatchObject({ maxRuns: 1, retestCooldownHours: 48, minFamiliesPerEpisode: 2 });
    // Stored bundles are trusted as-is: even a row saved before the author tightened is clamped.
    await db.query("UPDATE placement_settings SET max_runs=5,retest_cooldown_hours=0,min_families_per_episode=1 WHERE workspace_id=$1", [workspace]);
    expect((await settings()).effective).toMatchObject({ maxRuns: 2, retestCooldownHours: 24, minFamiliesPerEpisode: 2 });
  });

  it("refuses a revealed answer or companion help on a placement item when the author says unassisted only", async () => {
    await authored(policy);
    expect((await save({ maxRuns: 2, retestCooldownHours: 24 })).statusCode).toBe(200);
    expect((await send("placement/start")).statusCode).toBe(200);
    const next = (await state()).run.nextItem;
    const issued = (await send("challenges", { episodeId: next.episodeId, assessmentId: next.assessmentId, mode: "placement" })).json();
    expect((await send("solution", { challengeId: issued.challengeId })).json().error).toBe("PLACEMENT_UNASSISTED_ONLY");
    expect((await send("companion", { episodeId: "min", content: "What is the answer?", allowAssessmentAssistance: true })).json().error).toBe("PLACEMENT_UNASSISTED_ONLY");
    // The item stays independent: nothing was downgraded.
    expect((await db.query("SELECT assistance,independent_eligible FROM assessment_challenges WHERE id=$1", [issued.challengeId])).rows[0]).toEqual({ assistance: "none", independent_eligible: true });
  });

  it("without the policy, a revealed placement answer is allowed and only marks it assisted", async () => {
    await authored({});
    expect((await save({})).statusCode).toBe(200);
    expect((await send("placement/start")).statusCode).toBe(200);
    const next = (await state()).run.nextItem;
    const issued = (await send("challenges", { episodeId: next.episodeId, assessmentId: next.assessmentId, mode: "placement" })).json();
    expect((await send("solution", { challengeId: issued.challengeId })).statusCode).toBe(200);
  });

  it("never places out past an episode whose prerequisites this run did not show (skipRequiresCriticalPrerequisites)", () => {
    const course = fixture();
    course.objectives.find((o) => o.id === "maximum")!.prerequisites = ["minimum"];
    course.placement = { ...course.placement!, ...policy } as NonNullable<typeof course.placement>;
    const attempt = (id: string) => ({ episodeId: "max", assessmentId: id, familyId: course.assessments.find((a) => a.id === id)!.familyId,
      objectiveIds: ["maximum"], passed: true, independent: true, evidence: [{ id: randomUUID(), objectiveId: "maximum", passed: true }] });
    // Shown "maximum" alone, without its prerequisite: the walk stops at the first episode.
    const plan = placementPlan(course, "d", [attempt("max-a"), attempt("max-b")], [], { allowNextItem: false, minFamiliesPerEpisode: 2 });
    expect(plan).toMatchObject({ exemptEpisodeIds: [], stoppedAtEpisodeId: "min" });
  });
});

describe("placement blueprint and protected units (Q06)", () => {
  it("leaves author items out of the blueprint: never offered, never issued", async () => {
    expect((await save({ excludedAssessmentIds: ["min-a"] })).statusCode).toBe(200);
    const view = await settings();
    expect(view.settings.excludedAssessmentIds).toEqual(["min-a"]);
    expect(view.effective.assessmentIds).toEqual(["min-b", "max-a", "max-b"]);
    expect(view.blueprint.find((e: { episodeId: string }) => e.episodeId === "min")).toMatchObject({ status: "placeable", questions: 1, families: 1 });
    expect(view.author.items.map((i: { assessmentId: string }) => i.assessmentId)).toEqual(["min-a", "min-b", "max-a", "max-b"]);
    expect((await send("placement/start")).statusCode).toBe(200);
    expect((await state()).run.nextItem).toEqual({ episodeId: "min", assessmentId: "min-b" });
    expect((await send("challenges", { episodeId: "min", assessmentId: "min-a", mode: "placement" })).json().error).toBe("PLACEMENT_UNAVAILABLE");
    // With one family left, the first episode cannot be placed out of: it stays on the path.
    await take();
    expect((await state()).run).toMatchObject({ stopReason: "no_fresh_items", nextItem: null });
  });

  it("protects more episodes and narrows placeable objectives, but never un-protects or adds", async () => {
    expect((await save({ protectedEpisodeIds: ["max"] })).statusCode).toBe(200);
    let view = await settings();
    expect(view.blueprint.map((e: { episodeId: string; status: string }) => [e.episodeId, e.status])).toEqual([["min", "placeable"], ["max", "protected_by_staff"]]);
    expect((await send("placement/start")).statusCode).toBe(200);
    await take();
    await take();
    const run = (await state()).run;
    expect(run).toMatchObject({ stopReason: "protected_episode", nextItem: null });
    expect(run.proposal.exempt.map((e: { episodeId: string }) => e.episodeId)).toEqual(["min"]);
    expect((await save({ protectedEpisodeIds: [], excludedObjectiveIds: ["maximum"] })).statusCode).toBe(200);
    view = await settings();
    expect(view.blueprint.find((e: { episodeId: string }) => e.episodeId === "max")).toMatchObject({ status: "not_placeable", objectives: [{ objectiveId: "maximum", placeable: false }] });
    // Only narrowing: an unknown item, a non-placeable objective, an unknown episode are refused.
    expect((await save({ excludedAssessmentIds: ["not-in-blueprint"] })).json().error).toBe("PLACEMENT_ITEM_NOT_IN_BLUEPRINT");
    expect((await save({ excludedObjectiveIds: ["no-such-objective"] })).json().error).toBe("PLACEMENT_OBJECTIVE_NOT_PLACEABLE");
    expect((await save({ protectedEpisodeIds: ["no-such-episode"] })).json().error).toBe("PLACEMENT_EPISODE_UNKNOWN");
    expect((await save({ excludedAssessmentIds: "min-a" })).statusCode).toBe(400);
    expect((await save({ protectedEpisodeIds: ["min"] }, instructor)).statusCode).toBe(403);
  });

  it("previews what new settings would do without saving them", async () => {
    const body = { expectedRevision: 0, enabled: true, retestCooldownHours: 0, maxRuns: 1, maxItems: null, minFamiliesPerEpisode: null, protectedEpisodeIds: ["min"], excludedAssessmentIds: ["max-a"] };
    const preview = await call(owner, "POST", `/api/admin/courses/${catalog}/placement/settings/preview`, body);
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json().blueprint.map((e: { episodeId: string; status: string; questions: number }) => [e.episodeId, e.status, e.questions]))
      .toEqual([["min", "protected_by_staff", 2], ["max", "placeable", 1]]);
    expect(preview.json().current.map((e: { status: string }) => e.status)).toEqual(["placeable", "placeable"]);
    expect((await settings()).settings).toMatchObject({ revision: 0, protectedEpisodeIds: [], excludedAssessmentIds: [] });
    expect((await call(instructor, "POST", `/api/admin/courses/${catalog}/placement/settings/preview`, body)).statusCode).toBe(403);
    expect((await call(owner, "POST", `/api/admin/courses/${catalog}/placement/settings/preview`, { ...body, maxItems: 9 })).json().error).toBe("PLACEMENT_LIMIT_LOOSENS_AUTHOR");
  });
});

describe("placement result (H04)", () => {
  it("names the questions behind each objective shown and the specific areas left uncertain, without English prose", async () => {
    await save({});
    expect((await send("placement/start")).statusCode).toBe(200);
    await take();
    await take();
    await take(wrong); // the first "maximum" question, answered wrongly
    expect((await send("placement/finish")).statusCode).toBe(200);
    const proposal = (await state()).run.proposal;
    expect(proposal.demonstrated).toEqual([{ objectiveId: "minimum", description: expect.any(String), families: 2, supportingItems: [
      { assessmentId: "min-a", familyId: "compare", prompt: "Which is smaller?" }, { assessmentId: "min-b", familyId: "select", prompt: "Minimum of 4 and 9?" }] }]);
    expect(proposal.notShown).toEqual([{ objectiveId: "maximum", description: expect.any(String), questions: 1, reason: "answer_not_correct" }]);
    expect(proposal.untested).toEqual([]);
    expect(proposal.untestedNoteCode).toBe("not_a_judgement");
    expect(proposal).not.toHaveProperty("untestedNote");
  });
  it("lists placeable objectives that were never asked", async () => {
    await save({});
    expect((await send("placement/start")).statusCode).toBe(200);
    await take();
    expect((await send("placement/finish")).statusCode).toBe(200);
    const proposal = (await state()).run.proposal;
    expect(proposal.demonstrated).toEqual([]);
    expect(proposal.notShown).toEqual([{ objectiveId: "minimum", description: expect.any(String), questions: 1, reason: "more_evidence_needed" }]);
    expect(proposal.untested).toEqual([{ objectiveId: "maximum", description: expect.any(String) }]);
    expect(proposal.untestedCount).toBe(1);
  });
});
