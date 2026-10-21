import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, transaction, type Database } from "../src/database.js";
import { createTestDatabase, type TestDatabase } from "./test-database.js";
import { createServer } from "../src/server.js";
import { issueLoginCode } from "../src/auth.js";
import { credentialVault } from "../src/key-vault.js";
import { WorkspaceProviders } from "../src/provider-setup.js";
import { appendEvent } from "../src/events.js";
import { createPostgresSupervisorBridge, type PostgresSupervisorBridge } from "../src/supervisor-bridge.js";
import { fixture } from "./fixture.js";
import { MEDIA_CREDENTIAL, ScriptedVideo, approveRevisionsForTest, mediaConfiguration, mediaJobPolicy } from "./media-fixture.js";
import { allowUnpricedPaidWork } from "./cost-fixture.js";

/**
 * A learner's per-day and per-lesson AI limits count media and supervisor work together
 * (requirement B09), in the course's time zone when its policy names one. Scripted providers only.
 */
const schema = "paid_limits_media_" + randomUUID().replaceAll("-", ""), workspace = randomUUID(), origin = "http://localhost:4310";
interface Session { id: string; cookie: string; csrf: string }
let db: Database, testDatabase: TestDatabase | undefined, app: Awaited<ReturnType<typeof createServer>>, bridge: PostgresSupervisorBridge;
let owner: Session, learner: Session, releaseId: string, enrollment: string;
const video = new ScriptedVideo();
const headers = (s: Session) => ({ cookie: s.cookie, origin, "x-csrf-token": s.csrf });
const post = (s: Session, url: string, payload: unknown = {}) => app.inject({ method: "POST", url, headers: headers(s), payload: payload as object });
const key = () => "limits-" + randomUUID();
async function login(role: string): Promise<Session> {
  const id = randomUUID();
  await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [id, "test:" + id, `Limits ${role}`]);
  await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspace, id, role]);
  const r = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, id) } });
  expect(r.statusCode).toBe(200);
  return { id, cookie: r.cookies.map((c) => `${c.name}=${c.value}`).join("; "), csrf: r.json().csrfToken };
}
const budgetUrl = () => `/api/admin/workspaces/${workspace}/supervision/enrollments/${enrollment}/budget`;
async function limits(daily: number | null, lesson: number | null) {
  const pair = (microUsd: number | null) => microUsd === null ? null : { microUsd, tokens: 10_000_000 };
  const r = await app.inject({ method: "PUT", url: budgetUrl(), headers: headers(owner), payload: { daily: pair(daily), artifact: pair(lesson) } });
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
}
const mediaJob = () => post(owner, `/api/admin/enrollments/${enrollment}/media-jobs`, { episodeId: "min", title: "Running minimum in motion",
  objective: "Show the running minimum keeping the smaller value at each comparison.",
  script: "Narrated diagram: a highlighted value moves along a list; at each comparison the smaller value stays highlighted.", idempotencyKey: key() });
/** A supervisor job for the lesson, claimed as the workflow does: it reserves its allowance. */
async function supervisorClaim() {
  const event = await transaction(db, (client) => appendEvent(client, { workspaceId: workspace, enrollmentId: enrollment, actorId: learner.id, actorKind: "learner",
    type: "learning.review_requested", payload: { episodeId: "min" }, idempotencyKey: randomUUID(), supervise: true }));
  const outbox = (await bridge.claimOutboxEvent(event.id, randomUUID(), 30000))!;
  const [ref] = await bridge.prepareOutbox(outbox);
  await bridge.ackOutbox(outbox);
  const claim = await bridge.transition({ type: "claim", ref: ref!, checkpointId: "generate", ownerId: randomUUID(), availability: { status: "ready" } });
  return { claim, jobId: ref!.jobId };
}

beforeAll(async () => {
  if (!process.env.TEST_DATABASE_URL || process.env.DATABASE_URL) throw Error("Disposable TEST_DATABASE_URL required");
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  const providers = new WorkspaceProviders(db, credentialVault(randomBytes(32)), { "scripted-video": video.factory() });
  const jobPolicy = { allowance: { microUsd: 100_000, tokens: 100_000 } };
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false, workspaceProviders: providers, supervisor: { workspaceIds: [workspace], jobPolicy } });
  bridge = createPostgresSupervisorBridge(db, { workspaceIds: [workspace], jobPolicy });
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspace, "limits-" + workspace, "Paid limits qualification"]);
  await allowUnpricedPaidWork(db, workspace);
  owner = await login("owner");
  learner = await login("learner");
  const imported = await post(owner, `/api/workspaces/${workspace}/releases`, fixture());
  expect(imported.statusCode, imported.body).toBe(200);
  releaseId = imported.json().id;
  expect((await post(owner, `/api/releases/${releaseId}/publish`)).statusCode).toBe(200);
  enrollment = (await post(learner, "/api/enrollments", { releaseId })).json().id;
  const revision = (await db.query("SELECT revision FROM enrollments WHERE id=$1", [enrollment])).rows[0].revision;
  expect((await post(learner, `/api/enrollments/${enrollment}/supervision`, { adaptiveTeaching: true, expectedRevision: revision, idempotencyKey: key() })).statusCode).toBe(200);
  const configuration = mediaConfiguration();
  await approveRevisionsForTest(db, workspace, configuration);
  const setup = await post(owner, `/api/admin/workspaces/${workspace}/provider-setup`, { expectedRevision: 0, idempotencyKey: key(), configuration,
    jobPolicy: mediaJobPolicy(250_000), credentials: { [MEDIA_CREDENTIAL]: "synthetic-media-credential" } });
  expect(setup.statusCode, setup.body).toBe(200);
  for (const [scope, microUsd] of [["workspace", 50_000_000], [enrollment, 50_000_000]] as const) {
    const r = await post(owner, `/api/admin/workspaces/${workspace}/provider-setup/budgets`, { expectedRevision: 0, idempotencyKey: key(),
      ...(scope === "workspace" ? {} : { enrollmentId: scope }), limits: { microUsd, tokens: 50_000_000 }, paidWorkApproved: true });
    expect(r.statusCode, r.body).toBe(200);
  }
}, 30000);
afterAll(async () => {
  await app?.close();
  await db?.end();
  await testDatabase?.drop();
});

describe("per-day and per-lesson limits count media and supervisor work together (B09)", () => {
  it("supervisor spend leaves too little for a media job today; media spend then stops supervisor work with the daily reason", async () => {
    await limits(300_000, null);
    const first = await supervisorClaim();
    expect(first.claim.snapshot.state).not.toBe("budget_wait");
    // 100k reserved by the supervisor job: a 250k media job would pass 300k today.
    const refused = await mediaJob();
    expect(refused.json()).toMatchObject({ state: "failed", failureCode: "MEDIA_BUDGET_EXHAUSTED", chargedMicroUsd: 0 });
    const preview = await post(owner, `/api/admin/enrollments/${enrollment}/media-jobs/estimate`, { episodeId: "min" });
    expect(preview.json()).toMatchObject({ admissible: false, reason: "MEDIA_BUDGET_EXHAUSTED" });

    await limits(400_000, null);
    const admitted = await mediaJob();
    expect(admitted.json()).toMatchObject({ state: "admitted", chargedMicroUsd: 250_000 });
    // The learner's limits view counts both: 100k supervisor + 250k media.
    const view = (await app.inject({ url: budgetUrl(), headers: headers(owner) })).json();
    expect(view.usedToday.microUsd).toBe(350_000);
    expect(view.usedInCurrentLessonToday === null || view.usedInCurrentLessonToday.microUsd === 350_000).toBe(true);
    expect([view.dayBoundary, view.dayTimeZone]).toEqual(["utc", "UTC"]);
    // 50k left today: the next supervisor job waits, naming the daily limit.
    const second = await supervisorClaim();
    expect([second.claim.snapshot.state, second.claim.snapshot.reason]).toEqual(["budget_wait", "budget_exhausted"]);
    expect((await db.query("SELECT result FROM supervisor_jobs WHERE id=$1", [second.jobId])).rows[0].result.ceiling).toBe("daily");
  });

  it("the per-lesson limit counts the lesson's media, and days start in the course's time zone", async () => {
    // Daily limit out of the way; this lesson already holds 350k today.
    await limits(10_000_000, 400_000);
    const lesson = await mediaJob();
    expect(lesson.json()).toMatchObject({ state: "failed", failureCode: "MEDIA_BUDGET_EXHAUSTED" });
    await limits(null, null);
    // A course time zone moves the day boundary; the view reports the zone it counts in.
    const catalog = (await db.query("SELECT c.id FROM admin_course_catalog c JOIN course_releases r ON r.course_key=c.course_key AND r.workspace_id=c.workspace_id WHERE r.id=$1", [releaseId])).rows[0];
    expect(catalog).toBeTruthy();
    await db.query(`INSERT INTO course_policy_settings(catalog_id,workspace_id,revision,settings,changed_by) VALUES($1,$2,1,$3,$4)
      ON CONFLICT (catalog_id) DO UPDATE SET settings=EXCLUDED.settings`, [catalog.id, workspace, JSON.stringify({ timeZone: "Pacific/Kiritimati" }), owner.id]);
    const zoned = (await app.inject({ url: budgetUrl(), headers: headers(owner) })).json();
    expect([zoned.dayBoundary, zoned.dayTimeZone]).toEqual(["course_time_zone", "Pacific/Kiritimati"]);
    // An unknown zone falls back to UTC rather than failing.
    await db.query("UPDATE course_policy_settings SET settings=$2 WHERE catalog_id=$1", [catalog.id, JSON.stringify({ timeZone: "Not/AZone" })]);
    expect((await app.inject({ url: budgetUrl(), headers: headers(owner) })).json().dayTimeZone).toBe("UTC");
  });
});
