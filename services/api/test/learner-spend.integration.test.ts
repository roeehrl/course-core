import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compileCourse } from "@course-core/sdk/compiler";
import { createDatabase, transaction, type Database } from "../src/database.js";
import { createTestDatabase, type TestDatabase } from "./test-database.js";
import { createServer } from "../src/server.js";
import { issueLoginCode } from "../src/auth.js";
import { credentialVault } from "../src/key-vault.js";
import { WorkspaceProviders } from "../src/provider-setup.js";
import { appendEvent } from "../src/events.js";
import { initialPolicy } from "../src/policy-adapter.js";
import { recommendLearnerLimit } from "../src/learner-spend.js";
import { runPolicies, type RunRow } from "../src/run-inspector.js";
import { createPostgresSupervisorBridge, lockPaidWorkBudgets, type PostgresSupervisorBridge } from "../src/supervisor-bridge.js";
import { fixture } from "./fixture.js";
import { MEDIA_CREDENTIAL, ScriptedVideo, approveRevisionsForTest, mediaConfiguration, mediaJobPolicy } from "./media-fixture.js";
import { allowUnpricedPaidWork } from "./cost-fixture.js";

/**
 * "No limit per learner" (an explicit owner choice, never a missing amount) and the learner
 * spending data the owner sets a limit from. Admission runs real supervisor and media paths over
 * PostgreSQL with scripted providers only; the spending data reads ledger rows seeded here.
 */
const schema = "learner_spend_" + randomUUID().replaceAll("-", ""), origin = "http://localhost:4310";
const workspace = randomUUID(), data = randomUUID();
interface Session { id: string; cookie: string; csrf: string }
let db: Database, testDatabase: TestDatabase | undefined, app: Awaited<ReturnType<typeof createServer>>, bridge: PostgresSupervisorBridge;
let owner: Session, learner: Session, releaseId: string, enrollment: string;
const video = new ScriptedVideo();
const headers = (s: Session) => ({ cookie: s.cookie, origin, "x-csrf-token": s.csrf });
const post = (s: Session, url: string, payload: unknown = {}) => app.inject({ method: "POST", url, headers: headers(s), payload: payload as object });
const get = (s: Session, url: string) => app.inject({ method: "GET", url, headers: headers(s) });
const key = () => "learner-spend-" + randomUUID();
const budgets = `/api/admin/workspaces/${workspace}/provider-setup/budgets`;
async function login(role: string, inWorkspace = workspace): Promise<Session> {
  const id = randomUUID();
  await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [id, "test:" + id, `Spend person ${role}`]);
  await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [inWorkspace, id, role]);
  const r = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, id) } });
  expect(r.statusCode).toBe(200);
  return { id, cookie: r.cookies.map((c) => `${c.name}=${c.value}`).join("; "), csrf: r.json().csrfToken };
}
const mediaJob = (id = enrollment) => post(owner, `/api/admin/enrollments/${id}/media-jobs`, { episodeId: "min", title: "Running minimum in motion",
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
const ceiling = async (jobId: string) => (await db.query("SELECT result FROM supervisor_jobs WHERE id=$1", [jobId])).rows[0].result.ceiling;
const available = (enrollmentId: string) => transaction(db, (client) => lockPaidWorkBudgets(client, { workspaceId: workspace, enrollmentId }));
async function enroll() {
  const person = await login("learner");
  return (await post(person, "/api/enrollments", { releaseId })).json().id as string;
}

beforeAll(async () => {
  if (!process.env.TEST_DATABASE_URL || process.env.DATABASE_URL) throw Error("Disposable TEST_DATABASE_URL required");
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  const providers = new WorkspaceProviders(db, credentialVault(randomBytes(32)), { "scripted-video": video.factory() });
  const jobPolicy = { allowance: { microUsd: 100_000, tokens: 100_000 } };
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false, workspaceProviders: providers, supervisor: { workspaceIds: [workspace], jobPolicy } });
  bridge = createPostgresSupervisorBridge(db, { workspaceIds: [workspace], jobPolicy });
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3),($4,$5,$6)", [workspace, "spend-" + workspace, "Learner spend", data, "data-" + data, "Spend data"]);
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
  // Only the workspace total is set: $0.50. No learner has an own limit.
  const total = await post(owner, budgets, { expectedRevision: 0, idempotencyKey: key(), limits: { microUsd: 500_000, tokens: 50_000_000 }, paidWorkApproved: true });
  expect(total.statusCode, total.body).toBe(200);
}, 30000);
afterAll(async () => {
  await app?.close();
  await db?.end();
  await testDatabase?.drop();
});

describe("no limit per learner: an explicit choice; the workspace total still stops spending", () => {
  let admittedJob = "";
  it("with nothing chosen a learner without an own limit gets no paid work", async () => {
    expect((await get(owner, budgets)).json().defaultEnrollment).toEqual({ revision: 0, mode: "unset", limit_micro_usd: null, limit_tokens: null });
    const first = await supervisorClaim();
    expect([first.claim.snapshot.state, await ceiling(first.jobId)]).toEqual(["budget_wait", "enrollment"]);
  });

  it("refuses the choice without consent, with amounts, or for another scope", async () => {
    const refused = await post(owner, budgets, { expectedRevision: 0, idempotencyKey: key(), scope: "default_enrollment", mode: "unlimited", paidWorkApproved: false });
    expect([refused.statusCode, refused.json().error]).toEqual([409, "PAID_WORK_CONSENT_REQUIRED"]);
    for (const body of [
      { scope: "default_enrollment", mode: "unlimited", limits: { microUsd: 0 } },
      { scope: "workspace", mode: "unlimited" },
      { enrollmentId: enrollment, mode: "unlimited" },
      { scope: "default_enrollment", mode: "limit" },
      { scope: "default_enrollment", mode: "none", limits: { microUsd: 1 } },
    ]) {
      const r = await post(owner, budgets, { expectedRevision: 0, idempotencyKey: key(), paidWorkApproved: true, ...body });
      expect([r.statusCode, r.json().error], JSON.stringify(body)).toEqual([400, "PROVIDER_BUDGET_INVALID"]);
    }
    expect((await get(owner, budgets)).json().defaultEnrollment.mode).toBe("unset");
  });

  it("stores the choice as its own mode, with a receipt and an audit entry", async () => {
    const idempotencyKey = key(), body = { expectedRevision: 0, idempotencyKey, scope: "default_enrollment", mode: "unlimited", paidWorkApproved: true };
    const saved = await post(owner, budgets, body);
    expect(saved.json()).toMatchObject({ scope: "default_enrollment", revision: 1, mode: "unlimited", limits: null, consentRecorded: true });
    // The same request again returns the same receipt; it does not change anything twice.
    expect((await post(owner, budgets, body)).json()).toEqual(saved.json());
    const view = (await get(owner, budgets)).json();
    expect(view.defaultEnrollment).toEqual({ revision: 1, mode: "unlimited", limit_micro_usd: null, limit_tokens: null });
    expect(view.enrollments.find((e: { enrollmentId: string }) => e.enrollmentId === enrollment))
      .toMatchObject({ limitSource: "unlimited", limit_micro_usd: null, limit_tokens: null });
    const stored = (await db.query("SELECT default_enrollment_limit_mode,default_enrollment_limit_micro_usd FROM supervisor_workspace_budgets WHERE workspace_id=$1", [workspace])).rows[0];
    expect(stored).toEqual({ default_enrollment_limit_mode: "unlimited", default_enrollment_limit_micro_usd: null });
    const audit = (await get(owner, `/api/admin/workspaces/${workspace}/audit?type=provider.budget_changed`)).json();
    expect(audit.events.map((e: { payload: unknown }) => e.payload)).toContainEqual(
      { scope: "default_enrollment", mode: "unlimited", previousMode: "unset", limits: null, consentRecorded: true });
    // A NULL amount without the mode is not "no limit": the database refuses the mix.
    await expect(db.query("UPDATE supervisor_workspace_budgets SET default_enrollment_limit_mode='limit' WHERE workspace_id=$1", [workspace])).rejects.toThrow();
  });

  it("admits supervisor and media work up to the workspace total, then stops it there", async () => {
    const supervisor = await supervisorClaim();
    expect(supervisor.claim.snapshot.state).not.toBe("budget_wait");
    admittedJob = supervisor.jobId;
    expect((await mediaJob()).json()).toMatchObject({ state: "admitted", chargedMicroUsd: 250_000 });
    // 350k of 500k used: another 250k media job would pass the workspace total.
    expect((await mediaJob()).json()).toMatchObject({ state: "failed", failureCode: "MEDIA_BUDGET_EXHAUSTED", chargedMicroUsd: 0 });
    expect((await supervisorClaim()).claim.snapshot.state).not.toBe("budget_wait");
    // 450k used: 50k left is less than a job's 100k allowance, and the ceiling named is the workspace's.
    const stopped = await supervisorClaim();
    expect([stopped.claim.snapshot.state, await ceiling(stopped.jobId)]).toEqual(["budget_wait", "workspace"]);
    const used = (await db.query("SELECT used_micro_usd::int FROM supervisor_workspace_budgets WHERE workspace_id=$1", [workspace])).rows[0].used_micro_usd;
    expect(used).toBe(450_000);
  });

  it("shows the run inspector that no per-learner limit applied", async () => {
    const row = (await db.query<RunRow>("SELECT * FROM supervisor_jobs WHERE id=$1", [admittedJob])).rows[0]!;
    const policies = await runPolicies(db, row);
    expect(policies.enrollmentBudget).toMatchObject({ limitSource: "unlimited", limit: { microUsd: null, tokens: null } });
  });

  it("keeps own, daily and later per-learner limits", async () => {
    const own = await enroll(), other = await enroll();
    expect((await post(owner, budgets, { expectedRevision: 0, idempotencyKey: key(), enrollmentId: own, limits: { microUsd: 0, tokens: 0 }, paidWorkApproved: false })).statusCode).toBe(200);
    expect((await available(own)).microUsd).toBe(0);
    // Without an own limit a learner has exactly what is left of the workspace total.
    expect((await available(other)).microUsd).toBe(50_000);
    const daily = await app.inject({ method: "PUT", url: `/api/admin/workspaces/${workspace}/supervision/enrollments/${other}/budget`, headers: headers(owner),
      payload: { daily: { microUsd: 20_000, tokens: 10_000_000 }, artifact: null } });
    expect(daily.statusCode, daily.body).toBe(200);
    expect((await available(other)).microUsd).toBe(20_000);
    // Choosing an amount again replaces the mode.
    const limit = await post(owner, budgets, { expectedRevision: 1, idempotencyKey: key(), scope: "default_enrollment", limits: { microUsd: 10_000 }, paidWorkApproved: true });
    expect(limit.json()).toMatchObject({ revision: 2, mode: "limit", limits: { microUsd: 10_000 } });
    expect((await get(owner, budgets)).json().defaultEnrollment).toEqual({ revision: 2, mode: "limit", limit_micro_usd: "10000", limit_tokens: "1000000000" });
    expect((await available(other)).microUsd).toBe(10_000);
  });
});

// ---- Spending data ----
const DAY = 86_400_000, JAN = Date.UTC(2026, 0, 5, 10);
let dataOwner: Session, catalogA = "", priceId = "";
const learners: string[] = [];
async function seedLearner(courseKey: string) {
  const userId = randomUUID(), enrollmentId = randomUUID(), release = randomUUID(), course = compileCourse(fixture());
  await db.query("INSERT INTO app_users (id,subject,display_name) VALUES ($1,$2,'Private Learner Name')", [userId, `synthetic:${userId}`]);
  await db.query(`INSERT INTO course_releases (id,workspace_id,course_key,version,digest,server_bundle,learner_bundle,status,created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'published',$8)`,
    [release, data, courseKey, "1.0." + learners.length, course.digest, JSON.stringify(course.server), JSON.stringify(course.learner), userId]);
  await db.query("INSERT INTO memberships (workspace_id,user_id,role) VALUES ($1,$2,'learner')", [data, userId]);
  await db.query("INSERT INTO enrollments (id,workspace_id,course_release_id,user_id,policy,current_episode_id) VALUES ($1,$2,$3,$4,$5,'min')",
    [enrollmentId, data, release, userId, JSON.stringify(course.server.policy)]);
  await db.query("INSERT INTO policy_states (enrollment_id,policy_revision,ledger_revision,snapshot) VALUES ($1,1,0,$2)",
    [enrollmentId, JSON.stringify(initialPolicy(course.server, enrollmentId, userId, new Date().toISOString()))]);
  return { enrollmentId, userId };
}
/** One AI call: `charged` micro-USD on day `day` of the window, for a lesson and job. */
async function spend(enrollmentId: string, day: number, charged: number, options: { role?: string; episode?: string | null; reconciled?: boolean; notStarted?: boolean } = {}) {
  const at = new Date(JAN + day * DAY), state = options.notStarted ? "not_started" : options.reconciled ? "reconciled" : "unpriced";
  await db.query(`INSERT INTO provider_spend_ledger(id,source,source_ref,attempt,workspace_id,enrollment_id,role,state,reserved_micro_usd,reserved_tokens,
      charged_micro_usd,actual_micro_usd,pricing_version_id,released_micro_usd,reserved_at,settled_at,episode_id)
    VALUES($1,'supervisor',$2,1,$3,$4,$5,$6,$7,1000,$8,$9,$10,$11,$12,$12,$13)`,
    [randomUUID(), randomUUID(), data, enrollmentId, options.role ?? "companion", state, charged * 2, options.notStarted ? 0 : charged,
      options.reconciled ? charged : null, options.reconciled ? priceId : null, options.notStarted ? charged * 2 : 0, at, options.episode === undefined ? "min" : options.episode]);
}
const view = async (s: Session, query = "") => {
  const r = await get(s, `/api/admin/workspaces/${data}/provider-spend/learners?from=2026-01-01&to=2026-01-31${query}`);
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
};

describe("learner spending data and the recommended per-learner limit", () => {
  beforeAll(async () => {
    dataOwner = await login("owner", data);
    catalogA = randomUUID();
    await db.query("INSERT INTO admin_course_catalog(id,workspace_id,course_key,title) VALUES($1,$3,'spend-a','Course A'),($2,$3,'spend-b','Course B')", [catalogA, randomUUID(), data]);
    priceId = randomUUID();
    await db.query(`INSERT INTO provider_model_prices(id,workspace_id,model_id,version,status,currency,input_micro_usd_per_million,output_micro_usd_per_million,effective_from,source_note,created_by)
      VALUES($1,$2,'model-a',1,'active','USD',1,1,'2025-01-01','synthetic price',$3)`, [priceId, data, dataOwner.id]);
    // Learner n (1..4) spends n x $0.10 on each of 4 days.
    for (let n = 1; n <= 4; n++) {
      const { enrollmentId } = await seedLearner("spend-a");
      learners.push(enrollmentId);
      for (let day = 0; day < 4; day++) await spend(enrollmentId, day, n * 100_000, { reconciled: n === 2, role: day % 2 ? "supervisor" : "companion" });
    }
    // Learner 1 also worked two more hours on day 0 without AI cost; a call that never started costs nothing.
    const first = learners[0]!, user = (await db.query("SELECT user_id FROM enrollments WHERE id=$1", [first])).rows[0].user_id;
    for (const hour of [1, 2])
      await db.query(`INSERT INTO learning_events(id,workspace_id,enrollment_id,actor_id,actor_kind,event_type,payload,correlation_id,idempotency_key,created_at)
        VALUES($1,$2,$3,$4,'learner','learning.viewed','{}',$5,$6,$7)`, [randomUUID(), data, first, user, randomUUID(), randomUUID(), new Date(JAN + hour * 3_600_000)]);
    await spend(first, 0, 300_000, { notStarted: true });
  });

  it("is not enough data with 4 learners, or with 5 learners and 19 learner-days", async () => {
    let result = await view(dataOwner);
    expect([result.learners, result.learnerDays]).toEqual([4, 16]);
    expect(result.recommendation).toEqual({ status: "not_enough_data", learners: 4, learnerDays: 16, minimumLearners: 5, minimumLearnerDays: 20 });
    const { enrollmentId } = await seedLearner("spend-a");
    learners.push(enrollmentId);
    for (let day = 0; day < 3; day++) await spend(enrollmentId, day, 500_000, { role: "media", episode: "max" });
    result = await view(dataOwner);
    expect(result.recommendation).toMatchObject({ status: "not_enough_data", learners: 5, learnerDays: 19 });
  });

  it("aggregates per learner, day, active hour, lesson and job, and recommends from the 90th percentile", async () => {
    await spend(learners[4]!, 3, 500_000, { role: "media", episode: "max" });
    const result = await view(dataOwner);
    expect([result.learners, result.learnerDays, result.totalLearners]).toEqual([5, 20, 5]);
    // Learner days: 100k..500k, four of each.
    expect(result.distributions.learnerDay).toEqual({ p50: 300_000, p90: 500_000, max: 500_000 });
    // Learner 1's first day had three active hours: 100k / 3 per hour.
    expect(result.distributions.activeHour).toEqual({ p50: 300_000, p90: 500_000, max: 500_000 });
    // Learner totals 0.4, 0.8, 1.2, 1.6, 2.0 dollars: the 90th percentile is 1.84.
    expect(result.distributions.learnerTotal).toEqual({ p50: 1_200_000, p90: 1_840_000, max: 2_000_000 });
    expect(result.totals).toMatchObject({ calls: 20, charged: "6000000", actual: "800000", reconciledCalls: 4, reconciledCharged: "800000" });
    expect(result.byRole.map((r: { role: string; charged: string; learners: number }) => [r.role, r.charged, r.learners]))
      .toEqual([["companion", "2000000", 4], ["media", "2000000", 1], ["supervisor", "2000000", 4]]);
    expect(result.byLesson.map((r: { episodeId: string; charged: string }) => [r.episodeId, r.charged])).toEqual([["min", "4000000"], ["max", "2000000"]]);
    // 1.84 x 1.5 = 2.76, rounded up to the next $0.50; a heavy day is 500k x 1.5 = 750k, rounded up to $0.10.
    expect(result.recommendation).toEqual({ status: "ready", microUsd: 3_000_000, dailyMicroUsd: 800_000,
      basis: { learners: 5, learnerDays: 20, windowDays: 31, margin: 1.5, p90LearnerTotalMicroUsd: 1_840_000, p90LearnerDayMicroUsd: 500_000, cappedAtWorkspaceTotal: false } });
    const top = result.rows[0];
    expect(top).toMatchObject({ enrollmentId: learners[4], courseKey: "spend-a", charged: "2000000", activeDays: 4, activeHours: 4, calls: 4,
      perDay: { p50: 500_000, p90: 500_000, max: 500_000 } });
    expect(top.byLesson).toEqual([expect.objectContaining({ episodeId: "max", charged: "2000000", calls: 4 })]);
    expect(top.byDay.map((d: { day: string }) => d.day)).toEqual(["2026-01-08", "2026-01-07", "2026-01-06", "2026-01-05"]);
    // Nothing that identifies a person beyond the enrollment.
    expect(JSON.stringify(result)).not.toMatch(/Private Learner Name|synthetic:/);
  });

  it("pages learners, highest spend first, with learner 1's extra active hours", async () => {
    const page = await view(dataOwner, "&pageSize=2&page=3");
    expect([page.page, page.pageSize, page.rows.length, page.totalLearners]).toEqual([3, 2, 1, 5]);
    expect(page.rows[0]).toMatchObject({ enrollmentId: learners[0], charged: "400000", activeDays: 4, activeHours: 6, calls: 4 });
    expect(page.rows[0].byRole.map((r: { role: string }) => r.role)).toEqual(["companion", "supervisor"]);
    const second = await view(dataOwner, "&pageSize=2&page=1");
    expect(second.rows.map((r: { enrollmentId: string }) => r.enrollmentId)).toEqual([learners[4], learners[3]]);
    expect(second.rows[1]).toMatchObject({ reconciledCalls: 0 });
    expect((await view(dataOwner, "&pageSize=5")).rows.find((r: { enrollmentId: string }) => r.enrollmentId === learners[1]))
      .toMatchObject({ actual: "800000", reconciledCalls: 4 });
  });

  it("never recommends more than the workspace total", async () => {
    await db.query("INSERT INTO supervisor_workspace_budgets(workspace_id,limit_micro_usd,limit_tokens) VALUES($1,2500000,1000000000)", [data]);
    expect((await view(dataOwner)).recommendation).toMatchObject({ status: "ready", microUsd: 2_500_000, basis: { cappedAtWorkspaceTotal: true } });
    expect(recommendLearnerLimit({ learners: 9, learnerDays: 40, learnerTotal: { p50: 1, p90: 1, max: 1 }, learnerDay: { p50: 1, p90: 1, max: 1 }, windowDays: 30, workspaceLimitMicroUsd: 0 }))
      .toMatchObject({ microUsd: 500_000, dailyMicroUsd: 100_000 });
  });

  it("is for workspace roles that may view enrollments; a course grant does not open it", async () => {
    const other = await seedLearner("spend-b");
    await spend(other.enrollmentId, 1, 9_000_000);
    expect((await view(dataOwner)).learners).toBe(6);
    const instructor = await view(await login("instructor", data));
    expect(instructor.learners).toBe(6);
    const scoped = await login("course_scoped", data);
    const granted = await post(dataOwner, `/api/admin/workspaces/${data}/course-grants`, { userId: scoped.id, catalogId: catalogA, role: "instructor",
      expiresAt: new Date(Date.now() + DAY).toISOString(), reasonCode: "support_case", idempotencyKey: key() });
    expect(granted.statusCode, granted.body).toBe(200);
    // Neither a course grant, an author or observer, a learner, nor another workspace's owner.
    for (const person of [scoped, await login("author", data), await login("observer", data), await login("learner", data), owner])
      expect((await get(person, `/api/admin/workspaces/${data}/provider-spend/learners`)).statusCode).toBe(403);
    for (const query of ["?from=2026-01-01&to=2026-06-30", "?from=2026-02-01&to=2026-01-01", "?pageSize=26", "?page=0", "?extra=1"])
      expect((await get(dataOwner, `/api/admin/workspaces/${data}/provider-spend/learners${query}`)).json().error).toBe("PROVIDER_SPEND_RANGE_INVALID");
  });
});
