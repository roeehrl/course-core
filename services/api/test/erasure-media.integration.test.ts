import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "../src/database.js";
import { migrate } from "../src/migrations.js";
import { createServer } from "../src/server.js";
import { issueLoginCode } from "../src/auth.js";
import { credentialVault } from "../src/key-vault.js";
import { WorkspaceProviders } from "../src/provider-setup.js";
import type { AdapterFactory } from "../src/provider-composition.js";
import { createMediaJobService, workspaceMediaResolver, type MediaJobService } from "../src/media-jobs.js";
import { fixture } from "./fixture.js";
import { MEDIA_CREDENTIAL, ScriptedVideo, mediaConfiguration, mediaJobPolicy } from "./media-fixture.js";

// Data erasure cancels the enrollment's media jobs. Before that it finishes each job's open
// reservation: released when the provider certainly never ran it, otherwise closed at the full
// reservation. Real PostgreSQL, HTTP routes and the leased worker; only the video adapter is scripted.
const schema = "erasure_media_" + randomUUID().replaceAll("-", ""),
  workspace = randomUUID(),
  origin = "http://localhost:4310",
  ALLOWANCE = 250_000,
  options = { pollIntervalMs: 1000, maxPolls: 6, providerCallTimeoutMs: 20_000, maxActivePerWorkspace: 10 };
interface Session { id: string; cookie: string; csrf: string }
let db: Database, admin: Database, app: Awaited<ReturnType<typeof createServer>>, worker: MediaJobService, owner: Session, releaseId: string;
const video = new ScriptedVideo();
/** When set, a submission waits for it after the provider has received the request. */
let gate: Promise<void> | null = null, submitting = 0;
const gated: AdapterFactory = (factoryOptions) => {
  const adapter = video.factory()(factoryOptions), port = adapter.ports.video!;
  const start = port.startVideo.bind(port);
  port.startVideo = async (request, call) => { submitting += 1; if (gate) await gate; return start(request, call); };
  return adapter;
};
const headers = (s: Session) => ({ cookie: s.cookie, origin, "x-csrf-token": s.csrf });
const key = () => "erasure-media-" + randomUUID();
async function login(role: string) {
  const id = randomUUID();
  await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [id, "test:" + id, `Erasure ${role}`]);
  await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspace, id, role]);
  const r = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, id) } });
  expect(r.statusCode).toBe(200);
  return { id, cookie: r.cookies.map((c) => `${c.name}=${c.value}`).join("; "), csrf: r.json().csrfToken };
}
const post = (s: Session, url: string, payload: unknown = {}) => app.inject({ method: "POST", url, headers: headers(s), payload: payload as object });
const later = (ms: number) => new Date(Date.now() + ms);
const budgetRevisions: Record<string, number> = {};
async function budget(microUsd: number, enrollmentId?: string) {
  const scope = enrollmentId ?? "workspace";
  const r = await post(owner, `/api/admin/workspaces/${workspace}/provider-setup/budgets`, { expectedRevision: budgetRevisions[scope] ?? 0,
    idempotencyKey: key(), ...(enrollmentId ? { enrollmentId } : {}), limits: { microUsd, tokens: 1_000_000 }, paidWorkApproved: true });
  expect(r.statusCode, r.body).toBe(200);
  budgetRevisions[scope] = r.json().revision;
}
/** A new learner enrolls; staff request one media job for them. */
async function learnerWithJob() {
  const learner = await login("learner");
  const enrollment = (await post(learner, "/api/enrollments", { releaseId })).json().id as string;
  await budget(10_000_000, enrollment);
  const r = await post(owner, `/api/admin/enrollments/${enrollment}/media-jobs`, { episodeId: "min", title: "Running minimum in motion",
    objective: "Show the running minimum keeping the smaller value at each comparison.",
    script: "Narrated diagram: a highlighted value moves along a list; at each comparison the smaller value stays highlighted.", idempotencyKey: key() });
  expect(r.statusCode, r.body).toBe(200);
  expect(r.json()).toMatchObject({ state: "admitted", chargedMicroUsd: ALLOWANCE });
  return { learner, enrollment, jobId: r.json().id as string };
}
type Learner = Awaited<ReturnType<typeof learnerWithJob>>;
async function erase(l: Learner) {
  const r = await post(l.learner, `/api/enrollments/${l.enrollment}/erase`, { confirmation: `ERASE ${l.enrollment.slice(0, 8)}`, reason: "Synthetic learner asked for erasure." });
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as { counts: Record<string, number> };
}
const used = async (enrollment: string) => Number((await db.query("SELECT used_micro_usd FROM supervisor_enrollment_budgets WHERE enrollment_id=$1", [enrollment])).rows[0].used_micro_usd);
const ledger = async (jobId: string) => (await db.query(`SELECT state,reserved_micro_usd::int AS reserved,charged_micro_usd::int AS charged,released_micro_usd::int AS released,
  settled_at IS NOT NULL AS settled FROM provider_spend_ledger WHERE source='media' AND source_ref=$1`, [jobId])).rows;
const jobRow = async (jobId: string) => (await db.query("SELECT state,failure_code,charged_micro_usd::int AS charged,provider_operation_id,remote_may_continue FROM media_jobs WHERE id=$1", [jobId])).rows[0];
const assetCount = async (jobId: string) => (await db.query("SELECT count(*)::int AS n FROM media_assets WHERE job_id=$1", [jobId])).rows[0].n;

beforeAll(async () => {
  if (!process.env.TEST_DATABASE_URL || process.env.DATABASE_URL) throw Error("Disposable TEST_DATABASE_URL required");
  const url = new URL(process.env.TEST_DATABASE_URL);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !/^\/course_core_(?:ci|test(?:_[a-z0-9_]+)?)$/.test(url.pathname) || url.search || url.hash)
    throw Error("Disposable loopback DB required");
  admin = createDatabase(url.href);
  await admin.query(`CREATE SCHEMA ${schema}`);
  url.searchParams.set("options", "-csearch_path=" + schema);
  db = createDatabase(url.href);
  await migrate(db, fileURLToPath(new URL("../migrations", import.meta.url)));
  const providers = new WorkspaceProviders(db, credentialVault(randomBytes(32)), { "scripted-video": gated });
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false, workspaceProviders: providers, media: { options } });
  worker = createMediaJobService(db, workspaceMediaResolver(providers), options);
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspace, "erasure-media-" + workspace, "Erasure media"]);
  owner = await login("owner");
  const imported = await post(owner, `/api/workspaces/${workspace}/releases`, fixture());
  expect(imported.statusCode, imported.body).toBe(200);
  releaseId = imported.json().id;
  expect((await post(owner, `/api/releases/${releaseId}/publish`)).statusCode).toBe(200);
  const configured = await post(owner, `/api/admin/workspaces/${workspace}/provider-setup`, { expectedRevision: 0, idempotencyKey: key(),
    configuration: mediaConfiguration(), jobPolicy: mediaJobPolicy(ALLOWANCE), credentials: { [MEDIA_CREDENTIAL]: "synthetic-media-credential" } });
  expect(configured.statusCode, configured.body).toBe(200);
  await budget(100_000_000);
}, 30000);
afterAll(async () => {
  await app?.close();
  await db?.end();
  if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
});

describe("erasure finishes open media reservations", () => {
  it("a job never submitted is released in full and ends charging nothing; the worker never submits it", async () => {
    const l = await learnerWithJob(), submits = video.submits.length;
    expect(await used(l.enrollment)).toBe(ALLOWANCE);
    expect((await erase(l)).counts).toMatchObject({ paidWorkReleased: 1, paidWorkReleasedMicroUsd: ALLOWANCE, paidWorkClosedUncertain: 0 });
    expect(await used(l.enrollment)).toBe(0);
    expect(await ledger(l.jobId)).toEqual([{ state: "not_started", reserved: ALLOWANCE, charged: 0, released: ALLOWANCE, settled: true }]);
    expect(await jobRow(l.jobId)).toMatchObject({ state: "cancelled", failure_code: "MEDIA_ENROLLMENT_ERASED", charged: 0 });
    await worker.run({ now: later(0) });
    expect(video.submits.length).toBe(submits);
  });

  it("a job the provider accepted stays charged at its reservation, settled, and is never polled again", async () => {
    const l = await learnerWithJob();
    video.submitOutcomes.push("accept");
    await worker.run({ now: later(0) });
    expect((await jobRow(l.jobId)).state).toBe("polling");
    expect((await erase(l)).counts).toMatchObject({ paidWorkClosedUncertain: 1, paidWorkClosedMicroUsd: ALLOWANCE, paidWorkReleased: 0 });
    const closed = [{ state: "uncertain", reserved: ALLOWANCE, charged: ALLOWANCE, released: 0, settled: true }];
    expect(await ledger(l.jobId)).toEqual(closed);
    expect(await used(l.enrollment)).toBe(ALLOWANCE);
    expect(await jobRow(l.jobId)).toMatchObject({ state: "cancelled", charged: ALLOWANCE });
    const polls = video.polls.length;
    for (const t of [2_000, 20_000]) await worker.run({ now: later(t) });
    expect(video.polls.length).toBe(polls);
    expect(await ledger(l.jobId)).toEqual(closed);
    expect(await assetCount(l.jobId)).toBe(0);
  });

  it("a submission in flight at erasure is closed at its reservation; its late acceptance neither charges, releases nor resumes the job", async () => {
    const l = await learnerWithJob();
    let open: () => void = () => undefined;
    gate = new Promise((resolve) => { open = resolve; });
    const before = submitting;
    video.submitOutcomes.push("accept_completed");
    const running = worker.run({ now: later(0) });
    try {
      for (let i = 0; i < 500 && submitting === before; i++) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(submitting).toBe(before + 1);
      expect((await jobRow(l.jobId)).state).toBe("submitted");
      expect((await erase(l)).counts).toMatchObject({ paidWorkClosedUncertain: 1, paidWorkReleased: 0 });
    } finally { gate = null; open(); }
    await running;
    const closed = [{ state: "uncertain", reserved: ALLOWANCE, charged: ALLOWANCE, released: 0, settled: true }];
    expect(await ledger(l.jobId)).toEqual(closed);
    expect(await used(l.enrollment)).toBe(ALLOWANCE);
    // The remote handle is kept for audit; the job stays cancelled and is never polled or stored.
    expect(await jobRow(l.jobId)).toMatchObject({ state: "cancelled", charged: ALLOWANCE, remote_may_continue: true, provider_operation_id: expect.stringMatching(/^scripted\/operations\//) });
    const polls = video.polls.length;
    for (const t of [2_000, 20_000]) await worker.run({ now: later(t) });
    expect(video.polls.length).toBe(polls);
    expect(await assetCount(l.jobId)).toBe(0);
    expect(await ledger(l.jobId)).toEqual(closed);
    expect(await used(l.enrollment)).toBe(ALLOWANCE);
  });

  it("a definite rejection arriving after erasure does not release the reservation erasure already closed", async () => {
    const l = await learnerWithJob();
    let open: () => void = () => undefined;
    gate = new Promise((resolve) => { open = resolve; });
    const before = submitting;
    video.submitOutcomes.push("rejected");
    const running = worker.run({ now: later(0) });
    try {
      for (let i = 0; i < 500 && submitting === before; i++) await new Promise((resolve) => setTimeout(resolve, 10));
      expect((await jobRow(l.jobId)).state).toBe("submitted");
      expect((await erase(l)).counts).toMatchObject({ paidWorkClosedUncertain: 1, paidWorkReleased: 0 });
    } finally { gate = null; open(); }
    await running;
    // The release path for a cancelled submission the provider definitely refused finds no open row.
    const closed = [{ state: "uncertain", reserved: ALLOWANCE, charged: ALLOWANCE, released: 0, settled: true }];
    expect(await ledger(l.jobId)).toEqual(closed);
    expect(await used(l.enrollment)).toBe(ALLOWANCE);
    expect(await jobRow(l.jobId)).toMatchObject({ state: "cancelled", charged: ALLOWANCE });
    for (const t of [2_000, 20_000]) await worker.run({ now: later(t) });
    expect(await ledger(l.jobId)).toEqual(closed);
    expect(await used(l.enrollment)).toBe(ALLOWANCE);
  });

  it("staff cancel during a submission in flight, then erasure, then a definite 403: the closed row is never released", async () => {
    const l = await learnerWithJob();
    let open: () => void = () => undefined;
    gate = new Promise((resolve) => { open = resolve; });
    const before = submitting;
    video.submitOutcomes.push({ status: 403 });
    const running = worker.run({ now: later(0) });
    const open1 = [{ state: "uncertain", reserved: ALLOWANCE, charged: ALLOWANCE, released: 0, settled: false }];
    const closed = [{ state: "uncertain", reserved: ALLOWANCE, charged: ALLOWANCE, released: 0, settled: true }];
    try {
      for (let i = 0; i < 500 && submitting === before; i++) await new Promise((resolve) => setTimeout(resolve, 10));
      expect((await jobRow(l.jobId)).state).toBe("submitted");
      const cancelled = await post(owner, `/api/admin/media-jobs/${l.jobId}/cancel`, { idempotencyKey: key() });
      expect(cancelled.json()).toMatchObject({ state: "cancelled", chargeReleased: false, remoteMayContinue: true });
      // Held open: the submission in flight may still come back definitely refused.
      expect(await ledger(l.jobId)).toEqual(open1);
      expect((await erase(l)).counts).toMatchObject({ paidWorkClosedUncertain: 1, paidWorkReleased: 0 });
      expect(await ledger(l.jobId)).toEqual(closed);
    } finally { gate = null; open(); }
    await running;
    // The definite refusal would release an open row; erasure already closed this one.
    expect(await ledger(l.jobId)).toEqual(closed);
    expect(await used(l.enrollment)).toBe(ALLOWANCE);
    expect(await jobRow(l.jobId)).toMatchObject({ state: "cancelled", charged: ALLOWANCE });
    for (const t of [2_000, 20_000]) await worker.run({ now: later(t) });
    expect(await ledger(l.jobId)).toEqual(closed);
    expect(await used(l.enrollment)).toBe(ALLOWANCE);
  });

  it("a job cancelled before it was submitted has no hold left after erasure", async () => {
    const l = await learnerWithJob();
    const cancelled = await post(owner, `/api/admin/media-jobs/${l.jobId}/cancel`, { idempotencyKey: key() });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    await erase(l);
    expect(await used(l.enrollment)).toBe(0);
    expect(await ledger(l.jobId)).toMatchObject([{ state: "not_started", charged: 0, released: ALLOWANCE, settled: true }]);
    expect(await jobRow(l.jobId)).toMatchObject({ state: "cancelled", charged: 0 });
  });

  it("a finished, settled job is left as it was", async () => {
    const l = await learnerWithJob();
    video.submitOutcomes.push("accept_completed");
    for (let i = 0, t = 0; i < 6 && (await jobRow(l.jobId)).state !== "under_review"; i++, t += 2500) await worker.run({ now: later(t) });
    expect((await jobRow(l.jobId)).state).toBe("under_review");
    const settled = await ledger(l.jobId), charged = await used(l.enrollment);
    expect(settled[0].settled).toBe(true);
    expect((await erase(l)).counts).toMatchObject({ paidWorkReleased: 0, paidWorkSettled: 0, paidWorkClosedUncertain: 0 });
    expect(await ledger(l.jobId)).toEqual(settled);
    expect(await used(l.enrollment)).toBe(charged);
  });
});
