import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "../src/database.js";
import { createTestDatabase, type TestDatabase } from "./test-database.js";
import { createServer } from "../src/server.js";
import { issueLoginCode } from "../src/auth.js";
import { credentialVault } from "../src/key-vault.js";
import { WorkspaceProviders } from "../src/provider-setup.js";
import { canTransition, createMediaJobService, sniffVideo, validCaptions, workspaceMediaResolver, MEDIA_STATES, type MediaJobService } from "../src/media-jobs.js";
import { fixture } from "./fixture.js";
import { MEDIA_CREDENTIAL, ScriptedVideo, SYNTHETIC_CAPTIONS, SYNTHETIC_MP4, mediaConfiguration, mediaJobPolicy } from "./media-fixture.js";

const schema = "media_jobs_" + randomUUID().replaceAll("-", ""),
  workspace = randomUUID(),
  origin = "http://localhost:4310",
  options = { pollIntervalMs: 1000, maxPolls: 6, providerCallTimeoutMs: 2000, maxActivePerWorkspace: 10 };
interface Session { id: string; cookie: string; csrf: string }
let db: Database, app: Awaited<ReturnType<typeof createServer>>, providers: WorkspaceProviders,
  worker: MediaJobService, owner: Session, reviewer: Session, learner: Session, other: Session,
  releaseId: string, enrollment: string, otherEnrollment: string;
const video = new ScriptedVideo();
const headers = (s: Session) => ({ cookie: s.cookie, origin, "x-csrf-token": s.csrf });
const key = () => "media-" + randomUUID();
async function login(role: string) {
  const id = randomUUID();
  await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [id, "test:" + id, `Media ${role}`]);
  await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspace, id, role]);
  const r = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, id) } });
  expect(r.statusCode).toBe(200);
  return { id, cookie: r.cookies.map((c) => `${c.name}=${c.value}`).join("; "), csrf: r.json().csrfToken };
}
const post = (s: Session, url: string, payload: unknown = {}) => app.inject({ method: "POST", url, headers: headers(s), payload: payload as object });
const get = (s: Session, url: string, extra: Record<string, string> = {}) => app.inject({ url, headers: { ...headers(s), ...extra } });
let providerRevision = 0;
async function configure(configuration: unknown, allowance: number) {
  const r = await post(owner, `/api/admin/workspaces/${workspace}/provider-setup`, { expectedRevision: providerRevision, idempotencyKey: key(),
    configuration, jobPolicy: mediaJobPolicy(allowance), credentials: providerRevision === 0 ? { [MEDIA_CREDENTIAL]: "synthetic-media-credential" } : {} });
  expect(r.statusCode, r.body).toBe(200);
  providerRevision = r.json().revision;
}
const budgetRevisions: Record<string, number> = {};
async function budget(microUsd: number, enrollmentId?: string) {
  const scope = enrollmentId ?? "workspace";
  const r = await post(owner, `/api/admin/workspaces/${workspace}/provider-setup/budgets`, { expectedRevision: budgetRevisions[scope] ?? 0,
    idempotencyKey: key(), ...(enrollmentId ? { enrollmentId } : {}), limits: { microUsd, tokens: 1_000_000 }, paidWorkApproved: true });
  expect(r.statusCode, r.body).toBe(200);
  budgetRevisions[scope] = r.json().revision;
}
const used = async () => Number((await db.query("SELECT used_micro_usd FROM supervisor_workspace_budgets WHERE workspace_id=$1", [workspace])).rows[0]?.used_micro_usd ?? 0);
const requestBody = (extra: Record<string, unknown> = {}) => ({ episodeId: "min", title: "Running minimum in motion",
  objective: "Show the running minimum keeping the smaller value at each comparison.",
  script: "Narrated diagram: a highlighted value moves along a list; at each comparison the smaller value stays highlighted.", idempotencyKey: key(), ...extra });
const request = (s: Session, extra: Record<string, unknown> = {}, target = enrollment) => post(s, `/api/admin/enrollments/${target}/media-jobs`, requestBody(extra));
const job = async (id: string) => (await get(owner, `/api/admin/media-jobs/${id}`)).json();
const later = (ms: number) => new Date(Date.now() + ms);
async function drive(id: string, until: string[], start = 0) {
  for (let i = 0, t = start; i < 12; i++, t += 2500) {
    await worker.run({ now: later(t) });
    if (until.includes((await job(id)).state)) return job(id);
  }
  return job(id);
}
const approval = (sha: string, extra: Record<string, unknown> = {}) => ({ decision: "approved", assetSha256: sha, captionsVtt: SYNTHETIC_CAPTIONS,
  transcript: "The running minimum keeps the smaller value after each comparison in the list.",
  visualDescription: "A list of five boxes; a highlight moves left to right and stays on the smallest value so far.",
  findings: { factualAccuracy: true, labelsAndEquations: true, captionsMatchNarration: true, noMisleadingMotion: true },
  rationale: "Matches the reference trace for the minimum episode and the captions follow the narration.", idempotencyKey: key(), ...extra });
async function generatedJob() {
  const r = await request(owner);
  expect(r.statusCode, r.body).toBe(200);
  expect(r.json().state, r.json().failureCode).toBe("admitted");
  return drive(r.json().id, ["under_review", "failed"]);
}

let testDatabase: TestDatabase | undefined;
beforeAll(async () => {
  if (!process.env.TEST_DATABASE_URL || process.env.DATABASE_URL) throw Error("Disposable TEST_DATABASE_URL required");
  const url = new URL(process.env.TEST_DATABASE_URL);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !/^\/course_core_(?:ci|test(?:_[a-z0-9_]+)?)$/.test(url.pathname) || url.search || url.hash)
    throw Error("Disposable loopback DB required");
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  providers = new WorkspaceProviders(db, credentialVault(randomBytes(32)), { "scripted-video": video.factory() });
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false, workspaceProviders: providers, media: { options } });
  worker = createMediaJobService(db, workspaceMediaResolver(providers), options);
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspace, "media-" + workspace, "Media qualification"]);
  owner = await login("owner");
  reviewer = await login("reviewer");
  learner = await login("learner");
  other = await login("learner");
  const imported = await post(owner, `/api/workspaces/${workspace}/releases`, fixture());
  expect(imported.statusCode, imported.body).toBe(200);
  releaseId = imported.json().id;
  expect((await post(owner, `/api/releases/${releaseId}/publish`)).statusCode).toBe(200);
  enrollment = (await post(learner, "/api/enrollments", { releaseId })).json().id;
  otherEnrollment = (await post(other, "/api/enrollments", { releaseId })).json().id;
}, 30000);
afterAll(async () => {
  await app?.close();
  await db?.end();
  await testDatabase?.drop();
});

describe("media job state machine (pure)", () => {
  it("allows only the documented transitions and has terminal states", () => {
    expect(canTransition("admitted", "submitted")).toBe(true);
    expect(canTransition("uncertain", "polling")).toBe(true);
    expect(canTransition("uncertain", "submitted")).toBe(false);
    expect(canTransition("uncertain", "admitted")).toBe(false);
    expect(canTransition("under_review", "attached")).toBe(false);
    expect(canTransition("generated", "approved")).toBe(false);
    for (const terminal of ["rejected", "expired", "failed", "cancelled"] as const)
      for (const to of MEDIA_STATES) expect(canTransition(terminal, to)).toBe(false);
    expect(validCaptions(SYNTHETIC_CAPTIONS)).toBe(true);
    for (const bad of ["captions only", "WEBVTT\n\nno cues here", "WEBVTT\n\n00:00.000 --> 00:01.000\n<script>x</script>"]) expect(validCaptions(bad)).toBe(false);
    expect(sniffVideo(SYNTHETIC_MP4)).toBe("video/mp4");
    expect(sniffVideo(new TextEncoder().encode("<html>not a video</html>"))).toBeNull();
  });
});

describe("generated media jobs over HTTP and PostgreSQL", () => {
  it("refuses without a media provider, pricing or permission, and never creates a job", async () => {
    expect((await request(owner)).json().error).toBe("MEDIA_PROVIDER_UNCONFIGURED");
    await configure(mediaConfiguration(null), 250_000);
    const r = await request(owner);
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe("MEDIA_PRICING_UNAVAILABLE");
    await configure(mediaConfiguration(), 250_000);
    for (const actor of [learner, reviewer]) expect((await request(actor)).statusCode).toBe(403);
    expect((await request(owner, { episodeId: "unknown-episode" })).json().error).toBe("MEDIA_EPISODE_OUT_OF_SCOPE");
    expect((await request(owner, { script: "short" })).statusCode).toBe(400);
    expect(Number((await db.query("SELECT count(*) FROM media_jobs")).rows[0].count)).toBe(0);
    expect(video.submits).toEqual([]);
  });

  it("estimates from provider pricing and refuses over the per-job limit or the paid-work allowance without charging", async () => {
    await configure(mediaConfiguration(), 150_000);
    const preview = await post(owner, `/api/admin/enrollments/${enrollment}/media-jobs/estimate`, { episodeId: "min" });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json()).toMatchObject({ estimateMicroUsd: 200_000, reserveMicroUsd: 150_000, admissible: false, reason: "MEDIA_PER_JOB_LIMIT", grantsCredit: false });
    const perJob = await request(owner);
    expect(perJob.json()).toMatchObject({ state: "failed", failureCode: "MEDIA_PER_JOB_LIMIT", chargedMicroUsd: 0, estimateMicroUsd: 200_000 });
    await configure(mediaConfiguration(), 250_000);
    // Default budgets grant nothing: the job is refused, recorded and not charged.
    const refused = await request(owner);
    expect(refused.json()).toMatchObject({ state: "failed", failureCode: "MEDIA_BUDGET_EXHAUSTED", chargedMicroUsd: 0 });
    expect(await used()).toBe(0);
    expect(video.submits).toEqual([]);
    expect((await worker.run({ now: later(60_000) })).claimed).toBe(0);
    expect(video.submits).toEqual([]);
  });

  it("charges the full per-job allowance once at admission and replays an idempotent request", async () => {
    await budget(600_000);
    await budget(1_000_000, enrollment);
    const body = requestBody();
    const first = await post(owner, `/api/admin/enrollments/${enrollment}/media-jobs`, body);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({ state: "admitted", estimateMicroUsd: 200_000, chargedMicroUsd: 250_000, learnerVisible: false });
    const replay = await post(owner, `/api/admin/enrollments/${enrollment}/media-jobs`, body);
    expect(replay.json().id).toBe(first.json().id);
    expect(await used()).toBe(250_000);
    const conflict = await post(owner, `/api/admin/enrollments/${enrollment}/media-jobs`, { ...body, title: "A different request" });
    expect(conflict.json().error).toBe("IDEMPOTENCY_CONFLICT");
    // The second job uses the rest; a third is refused by the workspace allowance.
    const second = await request(owner);
    expect(second.json().state).toBe("admitted");
    expect(await used()).toBe(500_000);
    const third = await request(owner);
    expect(third.json()).toMatchObject({ state: "failed", failureCode: "MEDIA_BUDGET_EXHAUSTED", chargedMicroUsd: 0 });
    expect(await used()).toBe(500_000);
    for (const id of [first.json().id, second.json().id]) expect((await post(owner, `/api/admin/media-jobs/${id}/cancel`, { idempotencyKey: key() })).json().chargeReleased).toBe(false);
    await budget(20_000_000);
    await budget(20_000_000, enrollment);
  });

  it("submits once, polls to a stored, hashed asset and keeps it hidden from learners until approved and attached", async () => {
    const before = video.submits.length;
    const r = await request(owner);
    const id = r.json().id;
    await worker.run({ now: later(0) });
    expect((await job(id)).state).toBe("polling");
    video.pollOutcomes.push("pending");
    await worker.run({ now: later(1500) });
    expect((await job(id)).state).toBe("polling");
    const generated = await drive(id, ["under_review"], 4000);
    expect(generated.state).toBe("under_review");
    expect(video.submits.length - before).toBe(1);
    const sha = createHash("sha256").update(SYNTHETIC_MP4).digest("hex");
    expect(generated.asset).toMatchObject({ sha256: sha, mimeType: "video/mp4", byteLength: SYNTHETIC_MP4.byteLength });
    expect(generated.events.map((e: { to: string }) => e.to)).toEqual(["requested", "admitted", "submitted", "polling", "generated", "under_review"]);
    expect(generated.providerOperationId).toMatch(/^scripted\/operations\/op-/);
    const ranged = await get(owner, `/api/admin/media-jobs/${id}/asset`, { range: "bytes=4-7" });
    expect(ranged.statusCode).toBe(206);
    expect(ranged.headers["content-range"]).toBe(`bytes 4-7/${SYNTHETIC_MP4.byteLength}`);
    expect(ranged.rawPayload.toString("latin1")).toBe("ftyp");
    expect((await get(learner, `/api/admin/media-jobs/${id}/asset`)).statusCode).toBe(403);
    const listed = async () => (await get(learner, `/api/enrollments/${enrollment}/media?episodeId=min`)).json();
    expect(await listed()).toMatchObject({ media: [], optional: true, grantsCredit: false });
    // Approval needs captions, a transcript, a visual description, the reviewed hash and every finding.
    expect((await post(reviewer, `/api/admin/media-jobs/${id}/review`, approval(sha, { captionsVtt: undefined }))).json().error).toBe("MEDIA_CAPTIONS_REQUIRED");
    expect((await post(reviewer, `/api/admin/media-jobs/${id}/review`, approval(sha, { transcript: undefined }))).json().error).toBe("MEDIA_TEXT_ALTERNATIVE_REQUIRED");
    expect((await post(reviewer, `/api/admin/media-jobs/${id}/review`, approval(sha, { findings: { factualAccuracy: false, labelsAndEquations: true, captionsMatchNarration: true, noMisleadingMotion: true } }))).json().error).toBe("MEDIA_REVIEW_FINDINGS_INCOMPLETE");
    expect((await post(reviewer, `/api/admin/media-jobs/${id}/review`, approval("0".repeat(64)))).json().error).toBe("MEDIA_ASSET_CHANGED");
    expect((await post(learner, `/api/admin/media-jobs/${id}/review`, approval(sha))).statusCode).toBe(403);
    expect((await post(owner, `/api/admin/media-jobs/${id}/attach`, { expiresAt: later(86_400_000).toISOString(), idempotencyKey: key() })).json().error).toBe("MEDIA_NOT_APPROVED");
    const reviewed = await post(reviewer, `/api/admin/media-jobs/${id}/review`, approval(sha));
    expect(reviewed.json()).toMatchObject({ state: "approved", learnerVisible: false });
    expect((await listed()).media).toEqual([]);
    // Reviewers cannot publish; publishers can, once.
    expect((await post(reviewer, `/api/admin/media-jobs/${id}/attach`, { expiresAt: later(86_400_000).toISOString(), idempotencyKey: key() })).statusCode).toBe(403);
    expect((await post(owner, `/api/admin/media-jobs/${id}/attach`, { expiresAt: later(200 * 86_400_000).toISOString(), idempotencyKey: key() })).json().error).toBe("MEDIA_EXPIRY_INVALID");
    const attached = await post(owner, `/api/admin/media-jobs/${id}/attach`, { expiresAt: later(86_400_000).toISOString(), idempotencyKey: key() });
    expect(attached.json()).toMatchObject({ state: "attached", optional: true, grantsCredit: false });
    const media = (await listed()).media;
    expect(media).toHaveLength(1);
    expect(media[0]).toMatchObject({ generated: true, title: "Running minimum in motion", transcript: expect.stringContaining("running minimum") });
    const captions = await get(learner, media[0].captionsUrl);
    expect(captions.headers["content-type"]).toContain("text/vtt");
    expect(captions.body).toBe(SYNTHETIC_CAPTIONS);
    expect((await get(learner, media[0].assetUrl)).rawPayload.equals(Buffer.from(SYNTHETIC_MP4))).toBe(true);
    // Another learner sees neither the listing nor the bytes.
    expect((await get(other, `/api/enrollments/${enrollment}/media?episodeId=min`)).statusCode).toBe(404);
    expect((await get(other, media[0].assetUrl)).statusCode).toBe(404);
    expect((await get(other, `/api/enrollments/${otherEnrollment}/media?episodeId=min`)).json().media).toEqual([]);
    // Revocation removes it at once; the job ends as expired.
    const revoked = await post(reviewer, `/api/admin/media-attachments/${attached.json().attachmentId}/revoke`, { reason: "Superseded by a corrected clip.", idempotencyKey: key() });
    expect(revoked.json().state).toBe("revoked");
    expect((await listed()).media).toEqual([]);
    expect((await get(learner, media[0].assetUrl)).statusCode).toBe(404);
    expect((await job(id)).state).toBe("expired");
  });

  it("expires an attachment by time without a worker and records the expiry", async () => {
    const generated = await generatedJob();
    await post(reviewer, `/api/admin/media-jobs/${generated.id}/review`, approval(generated.asset.sha256));
    const attached = await post(owner, `/api/admin/media-jobs/${generated.id}/attach`, { expiresAt: later(1500).toISOString(), idempotencyKey: key() });
    expect(attached.statusCode, attached.body).toBe(200);
    expect((await get(learner, `/api/enrollments/${enrollment}/media?episodeId=min`)).json().media).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 1700));
    expect((await get(learner, `/api/enrollments/${enrollment}/media?episodeId=min`)).json().media).toEqual([]);
    await worker.run({ now: later(0) });
    expect((await job(generated.id))).toMatchObject({ state: "expired", attachment: { state: "expired" } });
  });

  it("rejected media is never attachable or visible", async () => {
    const generated = await generatedJob();
    const rejected = await post(reviewer, `/api/admin/media-jobs/${generated.id}/review`, approval(generated.asset.sha256, {
      decision: "rejected", captionsVtt: undefined, transcript: undefined, visualDescription: undefined,
      findings: { factualAccuracy: false, labelsAndEquations: false, captionsMatchNarration: true, noMisleadingMotion: true },
      rationale: "The labels contradict the reference computation for the second comparison." }));
    expect(rejected.json().state).toBe("rejected");
    expect((await post(owner, `/api/admin/media-jobs/${generated.id}/attach`, { expiresAt: later(86_400_000).toISOString(), idempotencyKey: key() })).json().error).toBe("MEDIA_NOT_APPROVED");
    expect((await get(learner, `/api/enrollments/${enrollment}/media?episodeId=min`)).json().media).toEqual([]);
  });

  it("reconciles an uncertain submission by polling its operation and never submits twice", async () => {
    video.submitOutcomes.push("unknown_with_operation");
    video.pollOutcomes.push("pending");
    const before = video.submits.length;
    const id = (await request(owner)).json().id;
    await worker.run({ now: later(0) });
    const uncertain = await job(id);
    expect(uncertain).toMatchObject({ state: "uncertain", providerOperationId: expect.stringMatching(/^scripted\/operations\//) });
    const done = await drive(id, ["under_review"], 0);
    expect(done.state).toBe("under_review");
    expect(video.submits.length - before).toBe(1);
    expect(done.events.map((e: { to: string; code: string | null }) => `${e.to}:${e.code ?? ""}`)).toEqual(
      ["requested:", "admitted:", "submitted:", "uncertain:MEDIA_SUBMISSION_UNCERTAIN", "polling:MEDIA_RECONCILED", "generated:", "under_review:"]);
  });

  it("an uncertain submission without an operation id waits, is never resubmitted, and fails at its deadline", async () => {
    video.submitOutcomes.push("unknown_without_operation");
    const before = video.submits.length;
    const id = (await request(owner)).json().id;
    await worker.run({ now: later(0) });
    expect((await job(id)).state).toBe("uncertain");
    for (const t of [5_000, 60_000, 600_000]) await worker.run({ now: later(t) });
    expect((await job(id)).state).toBe("uncertain");
    await worker.run({ now: later(31 * 60_000) });
    expect(await job(id)).toMatchObject({ state: "failed", failureCode: "MEDIA_OUTCOME_UNKNOWN", chargedMicroUsd: 250_000, remoteMayContinue: false });
    expect(video.submits.length - before).toBe(1);
  });

  it("a worker that died after recording intent leaves an uncertain job, never a second submission", async () => {
    const id = (await request(owner)).json().id;
    // Simulates the crash window: intent recorded, lease abandoned, outcome never written.
    await db.query("UPDATE media_jobs SET state='submitted',submit_attempts=1,lease_token=$2,lease_until=clock_timestamp()-interval '1 minute' WHERE id=$1", [id, randomUUID()]);
    const before = video.submits.length;
    await worker.run({ now: later(0) });
    expect(await job(id)).toMatchObject({ state: "uncertain" });
    expect((await job(id)).events.at(-1).code).toBe("MEDIA_SUBMISSION_INTERRUPTED");
    await worker.run({ now: later(5000) });
    expect(video.submits.length).toBe(before);
    await post(owner, `/api/admin/media-jobs/${id}/cancel`, { idempotencyKey: key() });
  });

  it("retries only definite non-acceptance, fails on rejection and on provider failure", async () => {
    video.submitOutcomes.push("throttled");
    let before = video.submits.length;
    const retried = (await request(owner)).json().id;
    await worker.run({ now: later(0) });
    expect(await job(retried)).toMatchObject({ state: "admitted", submitAttempts: 1 });
    await worker.run({ now: later(60_000) });
    expect((await job(retried)).state).toBe("polling");
    expect(video.submits.length - before).toBe(2);
    await post(owner, `/api/admin/media-jobs/${retried}/cancel`, { idempotencyKey: key() });
    video.submitOutcomes.push("rejected");
    const rejected = (await request(owner)).json().id;
    await worker.run({ now: later(0) });
    expect(await job(rejected)).toMatchObject({ state: "failed", failureCode: "MEDIA_PROVIDER_REJECTED" });
    video.pollOutcomes.push("failed");
    const failed = (await request(owner)).json().id;
    await drive(failed, ["failed"]);
    expect(await job(failed)).toMatchObject({ state: "failed", failureCode: "MEDIA_PROVIDER_FAILED" });
    before = video.downloads.length;
    video.asset = new TextEncoder().encode("<html>this is not a video container at all</html>");
    const invalid = (await request(owner)).json().id;
    await drive(invalid, ["failed"]);
    video.asset = SYNTHETIC_MP4;
    expect(await job(invalid)).toMatchObject({ state: "failed", failureCode: "MEDIA_ASSET_INVALID", asset: null });
    expect(video.downloads.length - before).toBe(1);
  });

  it("cancellation stops polling; a late completion is never stored or shown", async () => {
    video.pollOutcomes.push("pending");
    const id = (await request(owner)).json().id;
    await worker.run({ now: later(0) });
    await worker.run({ now: later(1500) });
    expect((await job(id)).state).toBe("polling");
    const cancelled = await post(owner, `/api/admin/media-jobs/${id}/cancel`, { idempotencyKey: key() });
    expect(cancelled.json()).toMatchObject({ state: "cancelled", remoteMayContinue: true, chargeReleased: false });
    const polls = video.polls.length;
    for (const t of [5000, 20000]) await worker.run({ now: later(t) });
    expect(video.polls.length).toBe(polls);
    expect(await job(id)).toMatchObject({ state: "cancelled", asset: null });
    expect((await post(owner, `/api/admin/media-jobs/${id}/cancel`, { idempotencyKey: key() })).json().error).toBe("MEDIA_NOT_CANCELLABLE");
  });

  it("publication is re-checked against the current enrollment: a removed learner gets nothing (F13)", async () => {
    await budget(1_000_000, otherEnrollment);
    const r = await request(owner, {}, otherEnrollment);
    const generated = await drive(r.json().id, ["under_review"]);
    await post(reviewer, `/api/admin/media-jobs/${generated.id}/review`, approval(generated.asset.sha256));
    await db.query("DELETE FROM memberships WHERE workspace_id=$1 AND user_id=$2", [workspace, other.id]);
    const denied = await post(owner, `/api/admin/media-jobs/${generated.id}/attach`, { expiresAt: later(86_400_000).toISOString(), idempotencyKey: key() });
    expect(denied.json().error).toBe("MEDIA_PUBLICATION_DENIED");
    expect((await job(generated.id)).state).toBe("approved");
    expect(Number((await db.query("SELECT count(*) FROM media_attachments WHERE job_id=$1", [generated.id])).rows[0].count)).toBe(0);
  });

  it("lists jobs for staff with estimate, charge and provider operation; learners are refused", async () => {
    const listed = await get(owner, `/api/admin/releases/${releaseId}/media-jobs`);
    expect(listed.statusCode, listed.body).toBe(200);
    const body = listed.json();
    expect(body.provider).toMatchObject({ estimateMicroUsd: 200_000, perJobAllowanceMicroUsd: 250_000 });
    expect(body.liveGenerationVerified).toBe(false);
    expect(body.jobs.length).toBeGreaterThan(5);
    expect(body.jobs.every((j: { estimateMicroUsd: number | null; chargedMicroUsd: number }) => typeof j.chargedMicroUsd === "number")).toBe(true);
    expect(JSON.stringify(body)).not.toContain("synthetic-media-credential");
    expect((await get(learner, `/api/admin/releases/${releaseId}/media-jobs`)).statusCode).toBe(403);
  });
});

describe("operator price versions for generated media", () => {
  it("prices a completed clip from the version in force and releases the rest of its reservation exactly once", async () => {
    // Synthetic operator price: 30,000 micro-USD per second plus 10,000 per request; 4 s -> 130,000.
    await db.query(`INSERT INTO provider_model_prices(id,workspace_id,model_id,version,status,currency,micro_usd_per_request,micro_usd_per_output_second,
      effective_from,source_note,created_by) VALUES($1,$2,'clip',1,'active','USD',10000,30000,clock_timestamp()-interval '1 minute','Synthetic media price',$3)`,
      [randomUUID(), workspace, owner.id]);
    const preview = await post(owner, `/api/admin/enrollments/${enrollment}/media-jobs/estimate`, { episodeId: "min" });
    expect(preview.json()).toMatchObject({ estimateMicroUsd: 130_000, admissible: true });
    expect(preview.json().pricing.source).toBe("Price version 1: Synthetic media price");
    const before = await used();
    const generated = await generatedJob();
    expect(generated.state).toBe("under_review");
    expect(generated).toMatchObject({ estimateMicroUsd: 130_000, chargedMicroUsd: 130_000 });
    expect(await used()).toBe(before + 130_000);
    const ledger = (await db.query("SELECT state,reserved_micro_usd::int AS reserved,actual_micro_usd::int AS actual,released_micro_usd::int AS released,pricing_version_id IS NOT NULL AS versioned FROM provider_spend_ledger WHERE source='media' AND source_ref=$1", [generated.id])).rows;
    expect(ledger).toEqual([{ state: "reconciled", reserved: 250_000, actual: 130_000, released: 120_000, versioned: true }]);
    // Later passes, review and cancellation never release it again.
    await worker.run({ now: later(30_000) });
    await post(owner, `/api/admin/media-jobs/${generated.id}/cancel`, { idempotencyKey: key() });
    expect(await used()).toBe(before + 130_000);
    // A cancelled job that had been admitted keeps the full allowance and is not reconciled.
    const held = await request(owner);
    await post(owner, `/api/admin/media-jobs/${held.json().id}/cancel`, { idempotencyKey: key() });
    expect(await used()).toBe(before + 130_000 + 250_000);
    expect((await db.query("SELECT state FROM provider_spend_ledger WHERE source='media' AND source_ref=$1", [held.json().id])).rows[0].state).toBe("reserved");
  });
});
