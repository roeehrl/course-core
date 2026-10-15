import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { digestTeachingArtifact, type TeachingArtifact } from "@course-core/sdk";
import { createDatabase, type Database } from "../src/database.js";
import { createTestDatabase, type TestDatabase } from "./test-database.js";
import { createServer } from "../src/server.js";
import { issueLoginCode, type Actor } from "../src/auth.js";
import { applyReviewedSupervisorSupport, authoredTeachingBankAdapter, createAdaptationRuntime, stageVerifiedAdaptation } from "../src/adaptation-store.js";
import { transaction } from "../src/database.js";
import { configureSupervisorBudget, createPostgresSupervisorBridge } from "../src/supervisor-bridge.js";
import { teachingContext } from "../src/provider-context.js";
import { entry, source, remedialCourse, remedialRegistry } from "./remedial-episode-fixture.js";
import { scanWakeups } from "../src/wakeups.js";
import { allowUnpricedPaidWork } from "./cost-fixture.js";

// Real PostgreSQL only: a fresh random schema per run.
const origin = "http://localhost:4391",
  schema = "episode_insert_" + randomUUID().replaceAll("-", ""),
  adapter = authoredTeachingBankAdapter(),
  runtime = createAdaptationRuntime([adapter]),
  workspace = randomUUID(),
  jobPolicy = { allowance: { microUsd: 100000, tokens: 1200000 } };
let db: Database, app: Awaited<ReturnType<typeof createServer>>;
interface Session { actor: Actor; cookie: string; csrf: string }
let staff: Session;

async function session(role: string): Promise<Session> {
  const actor = { id: randomUUID(), displayName: role };
  await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [actor.id, "insert:" + actor.id, role]);
  await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspace, actor.id, role]);
  const r = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, actor.id) } });
  return { actor, cookie: r.cookies.map((c) => c.name + "=" + c.value).join("; "), csrf: r.json().csrfToken };
}
const call = (who: Session, method: "GET" | "POST", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { origin, cookie: who.cookie, "x-csrf-token": who.csrf }, ...(payload === undefined ? {} : { payload: payload as object }) });

async function setup(classification: "required" | "optional", change: (course: ReturnType<typeof remedialCourse>) => void = () => {}) {
  const course = remedialCourse(adapter);
  change(course);
  const created = await call(staff, "POST", `/api/workspaces/${workspace}/releases`, course);
  expect(created.statusCode, created.body).toBe(200);
  const release = created.json().id;
  const published = await call(staff, "POST", `/api/releases/${release}/publish`);
  expect(published.statusCode, published.body).toBe(200);
  const approved = await call(staff, "POST", `/api/admin/releases/${release}/adaptation-registry`, { expectedRegistryRevision: 0, configuration: remedialRegistry(adapter, classification) });
  expect(approved.statusCode, approved.body).toBe(200);
  const learner = await session("learner");
  const enrollment = (await call(learner, "POST", "/api/enrollments", { releaseId: release })).json().id as string;
  return { course, release, learner, enrollment };
}
type Setup = Awaited<ReturnType<typeof setup>>;
async function view(s: Setup) {
  const r = await call(s.learner, "GET", "/api/enrollments/" + s.enrollment);
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
}
const summary = async (s: Setup) => (await call(s.learner, "GET", `/api/enrollments/${s.enrollment}/adaptation`)).json();
async function send(s: Setup, action: string, body: Record<string, unknown>) {
  return call(s.learner, "POST", `/api/enrollments/${s.enrollment}/${action}`, { expectedRevision: (await view(s)).revision, idempotencyKey: randomUUID(), ...body });
}
async function artifact(s: Setup, change: (a: any) => void = () => {}) {
  const artifactId = "artifact-" + randomUUID();
  const draft: any = { id: artifactId, kind: "episode", title: entry.title, blocks: entry.blocks.map((b) => ({ id: `${artifactId}--${b.id}`, markdown: b.markdown })),
    objectiveIds: ["minimum"], sourceRefs: [source], generator: { id: "remedial-generator", version: "1.0.0" } };
  change(draft);
  return { ...draft, digest: await digestTeachingArtifact(draft as TeachingArtifact) } as TeachingArtifact;
}
async function stage(s: Setup, made: TeachingArtifact, operation: Record<string, unknown> = {}) {
  const plan = await summary(s), operationId = "operation-" + randomUUID();
  return stageVerifiedAdaptation(db, staff.actor, {
    enrollmentId: s.enrollment, expectedRevision: (await view(s)).revision, expectedPlanRevision: plan.planRevision, idempotencyKey: randomUUID(),
    proposal: { schemaVersion: 1, id: "proposal-" + randomUUID(), baseCourseDigest: plan.baseCourseDigest ?? (await view(s)).digest, expectedPlanRevision: plan.planRevision,
      expectedPlanDigest: plan.planDigest, rationale: "Learner missed the minimum check twice; a reviewed step-by-step episode follows.",
      artifacts: [made], operations: [{ id: operationId, type: "insert_episode", afterEpisodeId: "min", artifactId: made.id, ...operation }] },
    profiles: [{ operationId, profileId: "remedial-profile" }],
  } as any, runtime);
}
async function insert(s: Setup) {
  const made = await artifact(s), staged = await stage(s, made);
  const applied = await call(staff, "POST", `/api/enrollments/${s.enrollment}/adaptation/${staged.proposalId}/apply`,
    { expectedRevision: (await view(s)).revision, expectedPlanRevision: (await summary(s)).planRevision, idempotencyKey: randomUUID() });
  expect(applied.statusCode, applied.body).toBe(200);
  return made;
}
async function passMinimum(s: Setup) {
  for (const [assessmentId, answer] of [["min-a", "two"], ["min-b", 4]] as const) {
    const issued = await send(s, "challenges", { episodeId: "min", assessmentId, mode: "independent" });
    expect(issued.statusCode, issued.body).toBe(200);
    expect((await send(s, "answers", { challengeId: issued.json().challengeId, answer })).json().result.passed).toBe(true);
  }
  expect((await send(s, "read", { episodeId: "min", blockId: "min-text" })).statusCode).toBe(200);
  const done = await send(s, "complete", { episodeId: "min" });
  expect(done.statusCode, done.body).toBe(200);
}

let testDatabase: TestDatabase | undefined;
beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false, adaptation: runtime, supervisor: { serviceToken: "s".repeat(40), workspaceIds: [workspace], jobPolicy } });
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspace, "insert-" + workspace, "Insertion"]);
  await allowUnpricedPaidWork(db, workspace);
  staff = await session("owner");
}, 30000);
afterAll(async () => {
  await app?.close();
  await db?.end();
  await testDatabase?.drop();
});

describe("reviewed remedial episode insertion", () => {
  it("inserts a required personal episode after its anchor that must be covered before the next episode, without grading or evidence", async () => {
    const s = await setup("required");
    const made = await insert(s);
    let v = await view(s);
    const order = v.course.chapters[0].episodes.map((e: any) => e.id);
    expect(order).toEqual(["min", made.id, "max"]);
    const inserted = v.course.chapters[0].episodes[1];
    expect(inserted).toMatchObject({ title: entry.title, objectiveIds: ["minimum"] });
    expect(inserted.gateId).toBeUndefined();
    expect(inserted.blocks.map((b: any) => b.markdown)).toEqual(entry.blocks.map((b) => b.markdown));
    expect(v.lessons.find((l: any) => l.id === made.id)).toMatchObject({ requirement: "required", status: "locked", gate: null });
    // A refused completion says which objective still needs independent evidence.
    expect((await send(s, "complete", { episodeId: "min" })).json()).toMatchObject({ error: "EVIDENCE_REQUIRED",
      details: { missing: [{ objectiveId: "minimum", independentFamilies: 0, requiredFamilies: 2 }] } });
    await passMinimum(s);
    v = await view(s);
    expect(v.lessons.map((l: any) => [l.id, l.status])).toEqual([["min", "completed"], [made.id, "available"], ["max", "locked"]]);
    expect(v.nextEpisodeId).toBe(made.id);
    // Coverage of every inserted block is required before completion.
    const uncovered = (await send(s, "complete", { episodeId: made.id })).json();
    expect(uncovered).toEqual({ error: "COVERAGE_REQUIRED", details: { unreadBlockIds: inserted.blocks.map((b: any) => b.id) } });
    for (const block of inserted.blocks) expect((await send(s, "read", { episodeId: made.id, blockId: block.id })).statusCode).toBe(200);
    expect((await send(s, "complete", { episodeId: made.id })).statusCode).toBe(200);
    v = await view(s);
    expect(v.lessons.map((l: any) => [l.id, l.status])).toEqual([["min", "completed"], [made.id, "completed"], ["max", "available"]]);
    // No evidence or demonstrated objective is minted by reading a personal episode.
    expect(Number((await db.query("SELECT count(*) FROM evidence WHERE enrollment_id=$1", [s.enrollment])).rows[0].count)).toBe(2);
    const changes = (await call(s.learner, "GET", `/api/enrollments/${s.enrollment}/personal-changes`)).json().changes;
    expect(changes).toEqual([expect.objectContaining({ kind: "insert_episode", episodeId: made.id, episodeTitle: entry.title, classification: "required", hideable: false })]);
    expect((await send(s, "personal-changes/visibility", { episodeId: made.id, blockId: changes[0].blockId, hidden: true })).json().error).toBe("CHANGE_NOT_HIDEABLE");
  }, 30000);

  it("an optional inserted episode never blocks progress and the learner can hide and restore it whole", async () => {
    const s = await setup("optional");
    const made = await insert(s);
    await passMinimum(s);
    let v = await view(s);
    expect(v.lessons.map((l: any) => [l.id, l.requirement, l.status])).toEqual([["min", "required", "completed"], [made.id, "optional", "available"], ["max", "required", "available"]]);
    expect(v.nextEpisodeId).toBe("max");
    const change = (await call(s.learner, "GET", `/api/enrollments/${s.enrollment}/personal-changes`)).json().changes[0];
    expect(change).toMatchObject({ episodeId: made.id, hideable: true, hidden: false });
    expect((await send(s, "personal-changes/visibility", { episodeId: made.id, blockId: change.blockId, hidden: true })).statusCode).toBe(200);
    v = await view(s);
    expect(v.course.chapters[0].episodes.find((e: any) => e.id === made.id).blocks).toEqual([]);
    // An owner's read-only view as the learner shows the same hidden state and the applied change.
    const staffView = (await call(staff, "GET", `/api/admin/enrollments/${s.enrollment}/learner-view`)).json();
    expect(staffView.snapshot).toEqual(v);
    expect(staffView.personalChanges).toEqual([expect.objectContaining({ episodeId: made.id, kind: "insert_episode", hideable: true, hidden: true })]);
    expect((await send(s, "personal-changes/visibility", { episodeId: made.id, blockId: change.blockId, hidden: false })).statusCode).toBe(200);
    expect((await view(s)).course.chapters[0].episodes.find((e: any) => e.id === made.id).blocks).toHaveLength(2);
  }, 30000);

  it("a companion question on an inserted episode is admitted under its anchor's policy scope and taught from the inserted episode", async () => {
    const s = await setup("optional");
    const made = await insert(s);
    await passMinimum(s);
    const asked = await send(s, "companion", { episodeId: made.id, content: "Can you explain step two again?" });
    expect(asked.statusCode, asked.body).toBe(200);
    const event = (await db.query("SELECT id FROM learning_events WHERE enrollment_id=$1 AND event_type='companion.requested'", [s.enrollment])).rows[0].id;
    const bridge = createPostgresSupervisorBridge(db, { workspaceIds: [workspace], jobPolicy });
    const outbox = (await bridge.claimOutboxEvent(event, randomUUID(), 30000))!;
    const jobs = await bridge.prepareOutbox(outbox);
    expect(jobs).toHaveLength(1);
    await bridge.ackOutbox(outbox);
    const input = (await db.query("SELECT context FROM supervisor_inputs WHERE job_id=$1", [jobs[0]!.jobId])).rows[0].context;
    expect(input.episodeId).toBe(made.id);
    const context = await teachingContext(db, jobs[0]!, input);
    expect(context.episode.id).toBe(made.id);
    expect(context.constraints.resolvedPolicy).toBeDefined();
    // Later transitions re-check policy for the same scope.
    await configureSupervisorBudget(db, { workspaceId: workspace }, { microUsd: 10000000, tokens: 100000000 });
    await configureSupervisorBudget(db, { workspaceId: workspace, enrollmentId: s.enrollment }, { microUsd: 1000000, tokens: 2000000 });
    const claim = await bridge.transition({ type: "claim", ref: jobs[0]!, checkpointId: "generate", ownerId: randomUUID(), availability: { status: "ready" } });
    expect(claim.effect).toBe("invoke");
  }, 30000);

  it("staff policy views and extension proposals treat an inserted episode as part of its anchor's scope", async () => {
    const s = await setup("optional");
    const made = await insert(s);
    const id = s.enrollment;
    const policy = await call(staff, "GET", `/api/admin/enrollments/${id}/policy`);
    expect(policy.statusCode, policy.body).toBe(200);
    const scopes = new Set(policy.json().scopes.map((x: { scopeId: string }) => x.scopeId));
    // Every listed activity names a scope that exists; an inserted episode, if listed, uses its anchor's.
    for (const activity of policy.json().activities) expect(scopes.has(activity.scopeId), activity.scopeId).toBe(true);
    const listed = policy.json().activities.find((a: { id: string }) => a.id === made.id);
    if (listed) expect(listed.scopeId).toBe("episode:min");
    const event = (await db.query("SELECT id FROM learning_events WHERE enrollment_id=$1 LIMIT 1", [id])).rows[0].id;
    const proposed = await call(staff, "POST", `/api/admin/enrollments/${id}/extensions/propose`, { expectedRevision: (await view(s)).revision, idempotencyKey: randomUUID(),
      scopeId: "episode:min", days: 1, rationaleEventIds: [event], episodeIds: [made.id], planImpact: "One more day for the remedial episode.", alternatives: ["Skip it."] });
    // Staff extension proposals cover base-course activities; an inserted episode is refused cleanly, never as an unknown policy scope.
    expect(proposed.statusCode, proposed.body).toBeLessThan(500);
    expect(["ACTIVITY_OUT_OF_SCOPE", "EXTENSIONS_DISABLED"]).toContain(proposed.json().error);
    const outside = await call(staff, "POST", `/api/admin/enrollments/${id}/extensions/propose`, { expectedRevision: (await view(s)).revision, idempotencyKey: randomUUID(),
      scopeId: "episode:max", days: 1, rationaleEventIds: [event], episodeIds: [made.id], planImpact: "One more day.", alternatives: ["Skip it."] });
    expect(outside.json().error, outside.body).toBe("ACTIVITY_OUT_OF_SCOPE");
  }, 30000);

  it("reviewed supervisor support compares the anchor, not a required inserted episode, as the learner's next target", async () => {
    // An optional anchor stays available while the required inserted episode after it is the next required one.
    const s = await setup("required", (course) => {
      (course.chapters[0]!.episodes[0] as { requirement?: string }).requirement = "optional";
      for (const objective of course.objectives) Object.assign(objective, { prerequisites: [], critical: false });
    });
    const made = await insert(s);
    const v = await view(s);
    expect(v.nextEpisodeId).toBe(made.id);
    expect(v.lessons.find((l: any) => l.id === "min").status).toBe("available");
    expect((await db.query("SELECT current_episode_id FROM enrollments WHERE id=$1", [s.enrollment])).rows[0].current_episode_id).toBeNull();
    await db.query("INSERT INTO supervisor_permissions(enrollment_id,workspace_id,revision,adaptive_teaching,changed_by) VALUES($1,$2,1,true,$3)", [s.enrollment, workspace, s.learner.actor.id]);
    const ref = { jobId: randomUUID(), workspaceId: workspace, enrollmentId: s.enrollment, generation: 1 };
    const error = await transaction(db, async (client) => {
      await client.query("SAVEPOINT attempt");
      try { await applyReviewedSupervisorSupport(client, ref, { profileId: "remedial-profile", entryId: entry.id, permissionRevision: 1 }, runtime); return undefined; }
      catch (e) { return e as { code?: string }; }
      finally { await client.query("ROLLBACK TO SAVEPOINT attempt"); }
    });
    // Later checks may still refuse this synthetic job; the target itself must not be reported as changed.
    expect(error?.code).not.toBe("SUPERVISION_TARGET_CHANGED");
  }, 30000);

  it("rejects changed reviewed text, a wrong anchor, colliding block IDs and an unmetered profile with no plan change", async () => {
    const s = await setup("required");
    const before = await summary(s);
    await expect(stage(s, await artifact(s, (a) => { a.blocks[1].markdown += " Also, the minimum is always the first value."; }))).rejects.toMatchObject({ code: "ADAPTATION_VERIFICATION_FAILED" });
    await expect(stage(s, await artifact(s), { afterEpisodeId: "max" })).rejects.toMatchObject({ code: "PROFILE_BINDING" });
    await expect(stage(s, await artifact(s, (a) => { a.blocks[0].id = "min-text"; }))).rejects.toMatchObject({ code: "DUPLICATE_ID" });
    expect((await summary(s)).planRevision).toBe(before.planRevision);
    expect((await view(s)).course.chapters[0].episodes.map((e: any) => e.id)).toEqual(["min", "max"]);
    const course = remedialCourse(adapter);
    const release = (await call(staff, "POST", `/api/workspaces/${workspace}/releases`, course)).json().id;
    expect((await call(staff, "POST", `/api/releases/${release}/publish`)).statusCode).toBe(200);
    const unmetered = await call(staff, "POST", `/api/admin/releases/${release}/adaptation-registry`, { expectedRegistryRevision: 0, configuration: remedialRegistry(adapter, "required", 0) });
    expect(unmetered.json().error, unmetered.body).toBe("TEACHING_PROFILE_INVALID");
  }, 30000);
});

describe("staff insertion of a reviewed remedial episode over HTTP (no model)", () => {
  const route = (s: Setup) => `/api/admin/enrollments/${s.enrollment}/adaptation/reviewed-episode`;
  async function body(s: Setup, extra: Record<string, unknown> = {}) {
    return { expectedRevision: (await view(s)).revision, expectedPlanRevision: (await summary(s)).planRevision, idempotencyKey: "staff-" + randomUUID(),
      profileId: "remedial-profile", entryId: entry.id, ...extra };
  }
  const insertedIds = async (s: Setup) => (await view(s)).course.chapters[0].episodes.map((e: any) => e.id);

  it("inserts the exact reviewed episode through the validated path, visible to the learner with undo, audited and idempotent", async () => {
    const s = await setup("optional");
    const request = await body(s);
    const inserted = await call(staff, "POST", route(s), request);
    expect(inserted.statusCode, inserted.body).toBe(200);
    expect(inserted.json()).toMatchObject({ status: "applied", anchorEpisodeId: "min", classification: "optional" });
    const episodeId = inserted.json().episodeId as string;
    expect(await insertedIds(s)).toEqual(["min", episodeId, "max"]);
    const episode = (await view(s)).course.chapters[0].episodes[1];
    expect(episode.blocks.map((b: any) => b.markdown)).toEqual(entry.blocks.map((b) => b.markdown));
    // A retry with the same key replays the stored result; nothing is inserted or charged twice.
    const replay = await call(staff, "POST", route(s), request);
    expect(replay.json()).toEqual(inserted.json());
    expect(await insertedIds(s)).toEqual(["min", episodeId, "max"]);
    expect((await call(staff, "POST", route(s), { ...request, entryId: "other-entry" })).json().error).toBe("IDEMPOTENCY_CONFLICT");
    const committed = (await db.query("SELECT snapshot FROM policy_states WHERE enrollment_id=$1", [s.enrollment])).rows[0].snapshot.reservations
      .filter((r: any) => r.state === "committed");
    expect(committed).toHaveLength(1);
    expect(committed[0].work).toMatchObject({ additionalEpisodes: 1, additionalMinutes: 6 });
    // Audited as a staff change, and listed to the learner, who can hide and restore an optional insertion.
    const audit = (await db.query("SELECT actor_id,actor_kind,payload FROM learning_events WHERE enrollment_id=$1 AND event_type='adaptation.applied'", [s.enrollment])).rows;
    expect(audit).toEqual([expect.objectContaining({ actor_id: staff.actor.id, actor_kind: "staff", payload: expect.objectContaining({ proposalId: inserted.json().proposalId }) })]);
    const change = (await call(s.learner, "GET", `/api/enrollments/${s.enrollment}/personal-changes`)).json().changes[0];
    expect(change).toMatchObject({ kind: "insert_episode", episodeId, classification: "optional", hideable: true, why: "Course staff inserted an exact author-reviewed remedial episode." });
    expect((await send(s, "personal-changes/visibility", { episodeId, blockId: change.blockId, hidden: true })).statusCode).toBe(200);
    expect((await view(s)).course.chapters[0].episodes[1].blocks).toEqual([]);
    expect((await send(s, "personal-changes/visibility", { episodeId, blockId: change.blockId, hidden: false })).statusCode).toBe(200);
    expect((await view(s)).course.chapters[0].episodes[1].blocks).toHaveLength(2);
  }, 30000);

  it("refuses learners and staff without enrollment write access, unreviewed entries, unapproved courses and inserts past the work cap", async () => {
    const s = await setup("required", (course) => { course.policy.work = { additionalMinutes: 20, additionalEpisodes: 1, remediationCyclesPerConcept: 4 }; });
    expect((await call(s.learner, "POST", route(s), await body(s))).statusCode).toBe(403);
    // Roles without enrollment write access are denied (staff who cannot see the enrollment get 404, never a hint it exists).
    for (const role of ["reviewer", "author", "observer"]) expect([403, 404], role).toContain((await call(await session(role), "POST", route(s), await body(s))).statusCode);
    expect((await call(staff, "POST", route(s), await body(s, { entryId: "not-in-the-reviewed-bank" }))).json().error).toBe("REVIEWED_EPISODE_UNAVAILABLE");
    expect((await call(staff, "POST", route(s), await body(s, { profileId: "no-such-profile" }))).json().error).toBe("REVIEWED_EPISODE_UNAVAILABLE");
    // Request fields cannot supply text, cost, classification or proof.
    expect((await call(staff, "POST", route(s), { ...(await body(s)), markdown: "Unreviewed text." })).statusCode).toBe(400);
    expect((await call(staff, "POST", route(s), await body(s, { expectedPlanRevision: 7 }))).json().error).toBe("STALE_PLAN");
    expect(await insertedIds(s)).toEqual(["min", "max"]);
    // A course whose adaptation registry was never approved cannot take an insertion.
    const unapproved = remedialCourse(adapter);
    const release = (await call(staff, "POST", `/api/workspaces/${workspace}/releases`, unapproved)).json().id;
    expect((await call(staff, "POST", `/api/releases/${release}/publish`)).statusCode).toBe(200);
    const other = await session("learner");
    const otherEnrollment = (await call(other, "POST", "/api/enrollments", { releaseId: release })).json().id;
    const refused = await call(staff, "POST", `/api/admin/enrollments/${otherEnrollment}/adaptation/reviewed-episode`, {
      expectedRevision: (await call(other, "GET", "/api/enrollments/" + otherEnrollment)).json().revision, expectedPlanRevision: 0, idempotencyKey: "staff-" + randomUUID(), profileId: "remedial-profile", entryId: entry.id });
    expect(refused.json().error).toBe("ADAPTATION_NOT_APPROVED");
    // The first insertion uses the whole one-episode allowance; a second is refused by policy with no change.
    expect((await call(staff, "POST", route(s), await body(s))).statusCode).toBe(200);
    const before = await summary(s);
    const capped = await call(staff, "POST", route(s), await body(s));
    expect(capped.statusCode).toBe(409);
    expect(capped.json().error).toBe("QUOTA_EXCEEDED");
    expect((await summary(s)).planRevision).toBe(before.planRevision);
    expect(await insertedIds(s)).toHaveLength(3);
  }, 30000);

  it("can stage only, leaving the learner's course unchanged until a staff member applies the verified proposal", async () => {
    const s = await setup("required");
    const staged = await call(staff, "POST", route(s), await body(s, { stageOnly: true }));
    expect(staged.statusCode, staged.body).toBe(200);
    expect(staged.json()).toMatchObject({ status: "verified", anchorEpisodeId: "min" });
    expect(await insertedIds(s)).toEqual(["min", "max"]);
    const applied = await call(staff, "POST", `/api/enrollments/${s.enrollment}/adaptation/${staged.json().proposalId}/apply`,
      { expectedRevision: (await view(s)).revision, expectedPlanRevision: (await summary(s)).planRevision, idempotencyKey: randomUUID() });
    expect(applied.statusCode, applied.body).toBe(200);
    expect(await insertedIds(s)).toEqual(["min", staged.json().episodeId, "max"]);
  }, 30000);

  it("closes a learner left with no way forward once the course work allowance is used up, and not before", async () => {
    const s = await setup("required", (course) => { course.policy.work = { additionalMinutes: 20, additionalEpisodes: 1, remediationCyclesPerConcept: 4 }; });
    expect((await call(staff, "POST", route(s), await body(s))).statusCode).toBe(200);
    const status = async () => (await db.query("SELECT status FROM enrollments WHERE id=$1", [s.enrollment])).rows[0].status;
    // The allowance is used, but the learner still has unseen checks: not stuck, not closed.
    const scan = async () => { for (let i = 0; i < 10; i++) if ((await scanWakeups(db)).wrapped) return; };
    await scan();
    expect(await status()).toBe("active");
    for (const [assessmentId, answer] of [["min-a", "five"], ["min-b", 9]] as const) {
      const issued = await send(s, "challenges", { episodeId: "min", assessmentId, mode: "independent" });
      expect(issued.statusCode, issued.body).toBe(200);
      expect((await send(s, "answers", { challengeId: issued.json().challengeId, answer })).json().result.passed).toBe(false);
    }
    // Every check is used, the gate is unmet and no more added work fits: closure with a gaps report.
    await scan();
    expect(await status()).toBe("closed");
    const closed = (await db.query("SELECT payload FROM learning_events WHERE enrollment_id=$1 AND event_type='enrollment.closed'", [s.enrollment])).rows;
    expect(closed).toEqual([{ payload: { reason: "cap", cap: "work_quota", coverage: "partial" } }]);
    expect((await view(s)).closureReport).toMatchObject({ reason: "cap", coverage: "partial", mastery: "gaps" });
  }, 30000);
});
