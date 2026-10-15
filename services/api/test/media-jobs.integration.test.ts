import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDatabase, type Database } from "../src/database.js";
import { createTestDatabase, type TestDatabase } from "./test-database.js";
import { createServer } from "../src/server.js";
import { issueLoginCode } from "../src/auth.js";
import { credentialVault } from "../src/key-vault.js";
import { WorkspaceProviders } from "../src/provider-setup.js";
import { canTransition, createMediaJobService, sniffVideo, validCaptions, workspaceMediaResolver, LEASE_MARGIN_MS, MEDIA_STATES, type MediaJobService } from "../src/media-jobs.js";
import type { SpendEvent } from "../src/provider-costs.js";
import { afterCommitTransaction, onCommit } from "../src/after-commit.js";
import { fixture } from "./fixture.js";
import { MEDIA_CREDENTIAL, ScriptedVideo, SYNTHETIC_CAPTIONS, SYNTHETIC_MP4, mediaConfiguration, mediaJobPolicy, type SubmitOutcome } from "./media-fixture.js";

// Every spend-telemetry emission, observed at the real recorder (which it still calls).
const spendEmitted = vi.hoisted(() => [] as SpendEvent[]);
vi.mock("../src/provider-costs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/provider-costs.js")>();
  return { ...actual, recordSpendEvents: (events: readonly SpendEvent[]) => { spendEmitted.push(...events); actual.recordSpendEvents(events); } };
});
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
    // Neither was submitted, so cancelling gives each reservation back.
    for (const id of [first.json().id, second.json().id]) expect((await post(owner, `/api/admin/media-jobs/${id}/cancel`, { idempotencyKey: key() })).json().chargeReleased).toBe(true);
    expect(await used()).toBe(0);
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
    // The submission may have reached the provider, which can still render and bill it although no
    // operation handle came back: staff must see that the remote job may continue.
    expect(await job(id)).toMatchObject({ state: "failed", failureCode: "MEDIA_OUTCOME_UNKNOWN", chargedMicroUsd: 250_000, remoteMayContinue: true });
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
    // A job cancelled after submission keeps the full allowance and is not reconciled.
    video.pollOutcomes.push("pending");
    const held = (await request(owner)).json().id;
    await worker.run({ now: later(0) });
    expect((await job(held)).state).toBe("polling");
    expect((await post(owner, `/api/admin/media-jobs/${held}/cancel`, { idempotencyKey: key() })).json()).toMatchObject({ chargeReleased: false, remoteMayContinue: true });
    expect(await used()).toBe(before + 130_000 + 250_000);
    // The provider may still run and bill it: held, and no longer shown as in flight.
    expect((await db.query("SELECT state FROM provider_spend_ledger WHERE source='media' AND source_ref=$1", [held])).rows[0].state).toBe("uncertain");
  });
});

// Real PostgreSQL ledger and budgets; the scripted adapter answers like the real HTTP transport
// (classified status plus per-attempt records). Scripted answers do not show how a real provider bills.
describe("media reservations when the provider certainly did not run", () => {
  const ledger = async (id: string) => (await db.query(`SELECT state,reserved_micro_usd::int AS reserved,charged_micro_usd::int AS charged,
      released_micro_usd::int AS released,actual_micro_usd AS actual,settled_at IS NOT NULL AS settled FROM provider_spend_ledger WHERE source='media' AND source_ref=$1`, [id])).rows;
  const enrollmentUsed = async () => Number((await db.query("SELECT used_micro_usd FROM supervisor_enrollment_budgets WHERE enrollment_id=$1", [enrollment])).rows[0].used_micro_usd);
  const spent = async () => ({ workspace: await used(), enrollment: await enrollmentUsed() });
  const released = [{ state: "not_started", reserved: 250_000, charged: 0, released: 250_000, actual: null, settled: true }];
  const held = (state: "reserved" | "uncertain", settled = false) => [{ state, reserved: 250_000, charged: 250_000, released: 0, actual: null, settled }];
  // The job ended without knowing the outcome: `uncertain`, charged in full and settled (closed).
  const closed = held("uncertain", true);
  const pass = (ms: number) => worker.run({ now: later(ms), limit: 50 });
  // Leaves every job of this block terminal so later cases are not refused for capacity.
  const settle = async (id: string) => {
    if (["admitted", "submitted", "polling", "uncertain", "generated", "under_review", "approved"].includes((await job(id)).state))
      await post(owner, `/api/admin/media-jobs/${id}/cancel`, { idempotencyKey: key() });
  };
  async function admitted() {
    const r = await request(owner);
    expect(r.json().state, r.body).toBe("admitted");
    return r.json().id as string;
  }

  it("a definite rejection fails the job, releases the reservation once and restores both allowances", async () => {
    for (const status of [400, 401, 402, 403, 404, 413]) {
      const before = await spent(), submits = video.submits.length;
      video.submitOutcomes.push({ status });
      const id = await admitted();
      expect(await spent()).toEqual({ workspace: before.workspace + 250_000, enrollment: before.enrollment + 250_000 });
      await pass(0);
      expect(await job(id), String(status)).toMatchObject({ state: "failed", failureCode: "MEDIA_PROVIDER_REJECTED", chargedMicroUsd: 0, remoteMayContinue: false });
      expect(await ledger(id)).toEqual(released);
      expect(await spent()).toEqual(before);
      // Later passes neither resubmit nor release again.
      for (const t of [5_000, 60_000, 31 * 60_000]) await pass(t);
      expect(video.submits.length - submits).toBe(1);
      expect(await spent()).toEqual(before);
      expect(await ledger(id)).toEqual(released);
      // A failed job cannot be cancelled into a second release.
      expect((await post(owner, `/api/admin/media-jobs/${id}/cancel`, { idempotencyKey: key() })).json().error).toBe("MEDIA_NOT_CANCELLABLE");
      expect(await spent()).toEqual(before);
    }
  });

  it("a rate limit retries the same job after its Retry-After hint and releases once when the retries run out", async () => {
    const before = await spent(), submits = video.submits.length;
    video.submitOutcomes.push({ status: 429, retryAfterMs: 120_000 }, { status: 429 }, { status: 429 });
    const id = await admitted();
    const t0 = Date.now();
    await pass(0);
    const waiting = (await db.query("SELECT state,next_attempt_at FROM media_jobs WHERE id=$1", [id])).rows[0];
    expect(waiting.state).toBe("admitted");
    expect(waiting.next_attempt_at.getTime()).toBeGreaterThanOrEqual(t0 + 120_000);
    expect(await ledger(id)).toEqual(held("reserved"));
    await pass(60_000);
    expect(video.submits.length - submits).toBe(1);
    await pass(130_000);
    expect(await job(id)).toMatchObject({ state: "admitted", submitAttempts: 2 });
    await pass(300_000);
    expect(await job(id)).toMatchObject({ state: "failed", failureCode: "MEDIA_PROVIDER_REJECTED", submitAttempts: 3, chargedMicroUsd: 0 });
    expect(video.submits.length - submits).toBe(3);
    expect(await ledger(id)).toEqual(released);
    expect(await spent()).toEqual(before);
  });

  it("a rate limit that later succeeds is charged once and settles normally", async () => {
    const before = await spent();
    video.submitOutcomes.push("throttled");
    const id = await admitted();
    await pass(0);
    expect(await job(id)).toMatchObject({ state: "admitted", chargedMicroUsd: 250_000 });
    const done = await drive(id, ["under_review"], 60_000);
    expect(done.state).toBe("under_review");
    // No price version for this case's model: the full allowance stays charged as unpriced.
    expect((await ledger(id))[0].state).toMatch(/^(unpriced|reconciled)$/);
    expect((await spent()).workspace - before.workspace).toBe(done.chargedMicroUsd);
    await settle(id);
  });

  it("a request refused before it left the host releases the reservation", async () => {
    const before = await spent();
    video.submitOutcomes.push("not_sent");
    const id = await admitted();
    await pass(0);
    expect(await job(id)).toMatchObject({ state: "failed", failureCode: "MEDIA_PROVIDER_REJECTED", chargedMicroUsd: 0 });
    expect(await ledger(id)).toEqual(released);
    expect(await spent()).toEqual(before);
  });

  it("an outcome that may have run stays held, is never resubmitted and is not released at its deadline or on cancel", async () => {
    const cases: SubmitOutcome[] = [{ status: 500 }, { status: 503 }, { status: 529 }, { status: 408 }, { status: 409 },
      "throttled_then_unavailable", "rejected_unrecorded", "unknown_without_operation"];
    const ids: string[] = [];
    const before = await spent(), submits = video.submits.length;
    for (const outcome of cases) {
      video.submitOutcomes.push(outcome);
      const id = await admitted();
      await pass(0);
      expect(await job(id), JSON.stringify(outcome)).toMatchObject({ state: "uncertain", chargedMicroUsd: 250_000 });
      expect(await ledger(id), JSON.stringify(outcome)).toEqual(held("uncertain"));
      ids.push(id);
    }
    expect(await spent()).toEqual({ workspace: before.workspace + 250_000 * cases.length, enrollment: before.enrollment + 250_000 * cases.length });
    // One of them is cancelled; the rest reach their deadline. Both keep the hold.
    // Every one of these may have run remotely, so cancel and deadline both say the provider may continue.
    expect((await post(owner, `/api/admin/media-jobs/${ids[0]}/cancel`, { idempotencyKey: key() })).json()).toMatchObject({ chargeReleased: false, remoteMayContinue: true });
    for (const t of [5_000, 60_000, 31 * 60_000]) await pass(t);
    for (const id of ids.slice(1)) expect(await job(id)).toMatchObject({ state: "failed", failureCode: "MEDIA_OUTCOME_UNKNOWN", chargedMicroUsd: 250_000, remoteMayContinue: true });
    for (const id of ids) expect(await ledger(id)).toEqual(closed);
    expect(video.submits.length - submits).toBe(cases.length);
    expect(await spent()).toEqual({ workspace: before.workspace + 250_000 * cases.length, enrollment: before.enrollment + 250_000 * cases.length });
  });

  it("cancelling an admitted job releases it once; a replayed or repeated cancel does not release again", async () => {
    const before = await spent();
    const id = await admitted();
    const body = { idempotencyKey: key() };
    const first = await post(owner, `/api/admin/media-jobs/${id}/cancel`, body);
    expect(first.json()).toMatchObject({ state: "cancelled", chargeReleased: true, remoteMayContinue: false });
    expect(await ledger(id)).toEqual(released);
    expect(await spent()).toEqual(before);
    const replay = await post(owner, `/api/admin/media-jobs/${id}/cancel`, body);
    expect(replay.json()).toEqual(first.json());
    expect((await post(owner, `/api/admin/media-jobs/${id}/cancel`, { idempotencyKey: key() })).json().error).toBe("MEDIA_NOT_CANCELLABLE");
    expect(await spent()).toEqual(before);
    expect(await ledger(id)).toEqual(released);
    expect(await job(id)).toMatchObject({ chargedMicroUsd: 0 });
  });

  it("an admitted job that reaches its deadline before submission releases the reservation", async () => {
    const before = await spent(), submits = video.submits.length;
    const id = await admitted();
    await pass(31 * 60_000);
    expect(await job(id)).toMatchObject({ state: "failed", failureCode: "MEDIA_DEADLINE_REACHED", chargedMicroUsd: 0, remoteMayContinue: false });
    expect(video.submits.length).toBe(submits);
    expect(await ledger(id)).toEqual(released);
    expect(await spent()).toEqual(before);
  });

  it("a cancel while the submission is in flight releases only if the provider then definitely refused it", async () => {
    for (const [outcome, expectRelease] of [[{ status: 403 }, true], ["unknown_without_operation", false], [{ status: 503 }, false]] as const) {
      const before = await spent();
      let open!: () => void;
      video.submitGate = new Promise((resolve) => { open = resolve; });
      video.submitOutcomes.push(outcome);
      const id = await admitted();
      const submits = video.submits.length;
      const running = pass(0);
      while (video.submits.length === submits) await new Promise((resolve) => setTimeout(resolve, 10));
      expect((await job(id)).state).toBe("submitted");
      const cancelled = await post(owner, `/api/admin/media-jobs/${id}/cancel`, { idempotencyKey: key() });
      expect(cancelled.json()).toMatchObject({ state: "cancelled", remoteMayContinue: true, chargeReleased: false });
      video.submitGate = null;
      open();
      await running;
      if (expectRelease) {
        expect(await job(id)).toMatchObject({ state: "cancelled", remoteMayContinue: false, chargedMicroUsd: 0 });
        expect(await ledger(id)).toEqual(released);
        expect(await spent()).toEqual(before);
      } else {
        expect(await job(id)).toMatchObject({ state: "cancelled", remoteMayContinue: true, chargedMicroUsd: 250_000 });
        expect(await ledger(id)).toEqual(closed);
        expect(await spent()).toEqual({ workspace: before.workspace + 250_000, enrollment: before.enrollment + 250_000 });
      }
    }
  });

  it("a worker crash after recording intent keeps the hold through recovery, deadline and cancel", async () => {
    const before = await spent();
    const id = await admitted();
    await db.query("UPDATE media_jobs SET state='submitted',submit_attempts=1,lease_token=$2,lease_until=clock_timestamp()-interval '1 minute' WHERE id=$1", [id, randomUUID()]);
    await pass(0);
    expect(await job(id)).toMatchObject({ state: "uncertain" });
    expect(await ledger(id)).toEqual(held("uncertain"));
    expect((await post(owner, `/api/admin/media-jobs/${id}/cancel`, { idempotencyKey: key() })).json().chargeReleased).toBe(false);
    expect(await ledger(id)).toEqual(closed);
    expect(await spent()).toEqual({ workspace: before.workspace + 250_000, enrollment: before.enrollment + 250_000 });
  });

  it("generated, reviewed, rejected, attached, revoked or expired media never releases after settlement", async () => {
    const before = await spent();
    const generated = await generatedJob();
    expect(generated.state).toBe("under_review");
    const settledRow = await ledger(generated.id);
    expect(settledRow[0].state).toMatch(/^(unpriced|reconciled)$/);
    const charged = (await spent()).workspace - before.workspace;
    await post(reviewer, `/api/admin/media-jobs/${generated.id}/review`, approval(generated.asset.sha256, {
      decision: "rejected", captionsVtt: undefined, transcript: undefined, visualDescription: undefined,
      findings: { factualAccuracy: false, labelsAndEquations: true, captionsMatchNarration: true, noMisleadingMotion: true },
      rationale: "The second comparison is drawn against the wrong value in the list." }));
    expect((await job(generated.id)).state).toBe("rejected");
    const attachedJob = await generatedJob();
    await post(reviewer, `/api/admin/media-jobs/${attachedJob.id}/review`, approval(attachedJob.asset.sha256));
    const attached = await post(owner, `/api/admin/media-jobs/${attachedJob.id}/attach`, { expiresAt: later(86_400_000).toISOString(), idempotencyKey: key() });
    await post(reviewer, `/api/admin/media-attachments/${attached.json().attachmentId}/revoke`, { reason: "Superseded by a corrected clip.", idempotencyKey: key() });
    await pass(0);
    expect((await job(attachedJob.id)).state).toBe("expired");
    expect(await ledger(generated.id)).toEqual(settledRow);
    expect((await spent()).workspace - before.workspace).toBe(charged * 2);
  });
});

// Real PostgreSQL; scripted provider answers. These show the application's accounting, not how a
// real provider bills a failed or unusable render.
describe("media ledger rows reach a final state when a started job ends", () => {
  const ledger = async (id: string) => (await db.query(`SELECT state,reserved_micro_usd::int AS reserved,charged_micro_usd::int AS charged,
      released_micro_usd::int AS released,actual_micro_usd AS actual,settled_at IS NOT NULL AS settled FROM provider_spend_ledger WHERE source='media' AND source_ref=$1`, [id])).rows;
  // Final: charged in full and settled, so nothing can settle or release it again.
  const held = (state: "uncertain" | "unpriced") => [{ state, reserved: 250_000, charged: 250_000, released: 0, actual: null, settled: true }];
  const pass = (ms: number, w = worker) => w.run({ now: later(ms), limit: 50 });
  async function admitted() {
    const r = await request(owner);
    expect(r.json().state, r.body).toBe("admitted");
    return r.json().id as string;
  }
  async function terminal(id: string, expected: Record<string, unknown>, row: ReturnType<typeof held>, w = worker) {
    for (let i = 0, t = 0; i < 12 && (await job(id)).state !== "failed"; i++, t += 2500) await pass(t, w);
    expect(await job(id)).toMatchObject({ state: "failed", chargedMicroUsd: 250_000, ...expected });
    expect(await ledger(id), String(expected.failureCode)).toEqual(row);
    // Later passes and a cancel attempt change nothing: the row is final, the charge held.
    const usedNow = await used();
    for (const t of [60_000, 31 * 60_000]) await pass(t, w);
    expect((await post(owner, `/api/admin/media-jobs/${id}/cancel`, { idempotencyKey: key() })).json().error).toBe("MEDIA_NOT_CANCELLABLE");
    expect(await ledger(id)).toEqual(row);
    expect(await used()).toBe(usedNow);
  }

  it("a provider-reported failure while polling holds the charge as uncertain", async () => {
    video.pollOutcomes.push("failed");
    const before = await used();
    await terminal(await admitted(), { failureCode: "MEDIA_PROVIDER_FAILED", remoteMayContinue: false }, held("uncertain"));
    expect(await used()).toBe(before + 250_000);
  });

  it("an unreadable poll response fails the job but says the provider may still run it", async () => {
    // Nothing in the response shows the remote render ended: staff are told it may still finish or bill.
    video.pollOutcomes.push("invalid");
    await terminal(await admitted(), { failureCode: "MEDIA_PROVIDER_INVALID_RESPONSE", remoteMayContinue: true, pollAttempts: 1 }, held("uncertain"));
    // A render the provider reported complete, but without a clip, has ended remotely.
    video.pollOutcomes.push("completed_without_video");
    await terminal(await admitted(), { failureCode: "MEDIA_PROVIDER_INVALID_RESPONSE", remoteMayContinue: false }, held("unpriced"));
    expect(video.pollOutcomes).toEqual([]);
  });

  it("a poll limit while the render is still pending holds the charge as uncertain", async () => {
    video.pollOutcomes.push(...Array(options.maxPolls).fill("pending"));
    await terminal(await admitted(), { failureCode: "MEDIA_POLL_LIMIT", remoteMayContinue: true, pollAttempts: options.maxPolls }, held("uncertain"));
    expect(video.pollOutcomes).toEqual([]);
  });

  it("a completed render whose clip is unusable is settled unpriced with the charge held", async () => {
    video.asset = new TextEncoder().encode("<html>this is not a video container at all</html>");
    try {
      await terminal(await admitted(), { failureCode: "MEDIA_ASSET_INVALID", asset: null }, held("unpriced"));
    } finally { video.asset = SYNTHETIC_MP4; }
    // Oversized: the provider finished it; the download was refused.
    const small = createMediaJobService(db, workspaceMediaResolver(providers), { ...options, maxAssetBytes: 1024 });
    video.asset = Uint8Array.from([...SYNTHETIC_MP4, ...new Uint8Array(2048)]);
    try {
      await terminal(await admitted(), { failureCode: "MEDIA_ASSET_TOO_LARGE", asset: null }, held("unpriced"), small);
    } finally { video.asset = SYNTHETIC_MP4; }
  });

  it("a deadline reached while polling, and a cancel while polling, hold the charge as uncertain", async () => {
    video.pollOutcomes.push("pending", "pending");
    const late = await admitted();
    await pass(0);
    await pass(2500);
    expect(await job(late)).toMatchObject({ state: "polling" });
    expect((await ledger(late))[0].state).toBe("reserved");
    await pass(31 * 60_000);
    expect(await job(late)).toMatchObject({ state: "failed", failureCode: "MEDIA_DEADLINE_REACHED", remoteMayContinue: true, chargedMicroUsd: 250_000 });
    expect(await ledger(late)).toEqual(held("uncertain"));
    video.pollOutcomes.length = 0;
  });

  it("the spend view reports these as held and uncertain or unpriced, never as in flight", async () => {
    const r = await get(owner, `/api/admin/workspaces/${workspace}/provider-spend`);
    expect(r.statusCode, r.body).toBe(200);
    const open = (await db.query(`SELECT count(*)::int AS n FROM provider_spend_ledger l JOIN media_jobs j ON j.id::text=l.source_ref
      WHERE l.source='media' AND l.state IN('reserved','uncertain') AND l.settled_at IS NULL
        AND j.state IN('failed','cancelled','rejected','expired','attached','approved','under_review')`)).rows[0].n;
    expect(open).toBe(0);
    const uncertain = (await db.query("SELECT count(*)::int AS n FROM provider_spend_ledger WHERE workspace_id=$1 AND state='uncertain'", [workspace])).rows[0].n;
    expect(r.json().totals.uncertain).toBe(uncertain);
    // `held` counts only open rows: the closed rows of ended jobs are not shown as still held.
    const openHeld = (await db.query(`SELECT COALESCE(sum(charged_micro_usd),0)::text AS n FROM provider_spend_ledger
      WHERE workspace_id=$1 AND state IN('reserved','uncertain') AND settled_at IS NULL`, [workspace])).rows[0].n;
    expect(r.json().totals.held).toBe(openHeld);
    expect(Number(r.json().totals.unpriced)).toBeGreaterThanOrEqual(500_000);
  });
});

describe("media lease and provider call timeout", () => {
  it("refuses a lease that a provider step could outlast, with a clear error, at service and server creation", async () => {
    const make = (o: Record<string, number>) => () => createMediaJobService(db, undefined, o);
    expect(make({})).not.toThrow();
    expect(createMediaJobService(db, undefined).config).toMatchObject({ leaseMs: 300_000, providerCallTimeoutMs: 120_000 });
    // The old defaults: a poll plus a download (2 x 120 s) outlasted a 180 s lease.
    expect(make({ leaseMs: 180_000 })).toThrow(/leaseMs \(180000\) must be at least twice providerCallTimeoutMs \(120000\) plus a 30000 ms margin, i\.e\. at least 270000/);
    expect(make({ leaseMs: 60_000, providerCallTimeoutMs: 60_000 })).toThrow(/at least 150000/);
    expect(make({ leaseMs: 10_000, providerCallTimeoutMs: 30_000 })).toThrow(/Invalid media job options/);
    expect(make({ providerCallTimeoutMs: 300_000 })).toThrow(/at least 630000/);
    expect(make({ leaseMs: 2 * 1000 + LEASE_MARGIN_MS - 1, providerCallTimeoutMs: 1000 })).toThrow(/Invalid media job options/);
    expect(make({ leaseMs: 2 * 1000 + LEASE_MARGIN_MS, providerCallTimeoutMs: 1000 })).not.toThrow();
    await expect(createServer(db, { loginCodes: true, origin, secureCookies: false, media: { options: { leaseMs: 100_000 } } })).rejects.toThrow(/Invalid media job options/);
  });

  it("a job submitted late in a pass gets a full lease, so another worker cannot take it mid-call", async () => {
    const real = performance.now.bind(performance);
    let offset = 0, open1!: () => void, open2!: () => void;
    const spy = vi.spyOn(performance, "now").mockImplementation(() => real() + offset);
    const ids = [(await request(owner)).json().id as string, (await request(owner)).json().id as string];
    const start = later(0), submits = video.submits.length;
    try {
      video.submitGate = new Promise((resolve) => { open1 = resolve; });
      const running = worker.run({ now: start, limit: 50 });
      while (video.submits.length === submits) await new Promise((resolve) => setTimeout(resolve, 10));
      // The first submission takes 250 s of the pass's time; the second starts after it.
      video.submitGate = new Promise((resolve) => { open2 = resolve; });
      offset = 250_000;
      open1();
      while (video.submits.length === submits + 1) await new Promise((resolve) => setTimeout(resolve, 10));
      const second = video.submits.at(-1)!.accounting.accountingKey.replace("media:", "");
      expect(ids).toContain(second);
      const row = (await db.query("SELECT state,lease_until FROM media_jobs WHERE id=$1", [second])).rows[0];
      expect(row.state).toBe("submitted");
      expect(row.lease_until.getTime()).toBeGreaterThanOrEqual(start.getTime() + 250_000 + 300_000);
      // Past the lease taken at claim time, another worker's pass leaves the in-flight job alone.
      const rival = createMediaJobService(db, workspaceMediaResolver(providers), options);
      await rival.run({ now: new Date(start.getTime() + 300_000 + 5_000), limit: 50 });
      expect((await job(second)).state).toBe("submitted");
      video.submitGate = null;
      open2();
      await running;
      expect((await job(second)).state).toBe("polling");
      expect(video.submits.filter((r) => ids.includes(r.accounting.accountingKey.replace("media:", ""))).length).toBe(2);
    } finally {
      video.submitGate = null; open1?.(); open2?.(); spy.mockRestore();
      for (const id of ids) await post(owner, `/api/admin/media-jobs/${id}/cancel`, { idempotencyKey: key() });
    }
  });
});

describe("media spend telemetry is emitted only after commit", () => {
  const media = () => spendEmitted.filter((e) => e.role === "media");
  const arm = (point: string) => db.query("INSERT INTO test_fail_points(point) VALUES($1)", [point]);
  const disarm = () => db.query("DELETE FROM test_fail_points");
  beforeAll(async () => {
    // A real failure inside the same transaction, after the ledger and budget writes.
    await db.query(`CREATE TABLE test_fail_points(point text PRIMARY KEY);
      CREATE FUNCTION test_fail_point() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF EXISTS (SELECT 1 FROM test_fail_points WHERE point = TG_TABLE_NAME || ':' || COALESCE(to_jsonb(NEW)->>'to_state', '')) THEN
          RAISE EXCEPTION 'injected test failure'; END IF;
        RETURN NEW; END $$;
      CREATE TRIGGER test_fail_events BEFORE INSERT ON media_job_events FOR EACH ROW EXECUTE FUNCTION test_fail_point();
      CREATE TRIGGER test_fail_receipts BEFORE INSERT ON media_command_receipts FOR EACH ROW EXECUTE FUNCTION test_fail_point();`);
    if (!(await db.query("SELECT 1 FROM provider_model_prices WHERE workspace_id=$1 AND model_id='clip'", [workspace])).rowCount)
      await db.query(`INSERT INTO provider_model_prices(id,workspace_id,model_id,version,status,currency,micro_usd_per_request,micro_usd_per_output_second,
        effective_from,source_note,created_by) VALUES($1,$2,'clip',1,'active','USD',10000,30000,clock_timestamp()-interval '1 minute','Synthetic media price',$3)`,
        [randomUUID(), workspace, owner.id]);
  });
  afterAll(async () => { await db.query("DROP TABLE IF EXISTS test_fail_points CASCADE; DROP FUNCTION IF EXISTS test_fail_point() CASCADE"); });

  it("after-commit effects run once, in order, after COMMIT; never on rollback or outside a transaction", async () => {
    const ran: string[] = [];
    expect(await afterCommitTransaction(db, async (client) => { onCommit(client, () => ran.push("a")); onCommit(client, () => ran.push("b")); expect(ran).toEqual([]); return 7; })).toBe(7);
    expect(ran).toEqual(["a", "b"]);
    await expect(afterCommitTransaction(db, async (client) => { onCommit(client, () => ran.push("rolled back")); throw new Error("boom"); })).rejects.toThrow("boom");
    expect(await afterCommitTransaction(db, async (client) => { onCommit(client, () => { throw new Error("effect"); }); onCommit(client, () => ran.push("c")); return "ok"; })).toBe("ok");
    expect(ran).toEqual(["a", "b", "c"]);
    const client = await db.connect();
    try { expect(() => onCommit(client, () => ran.push("x"))).toThrow(/inside afterCommitTransaction/); } finally { client.release(); }
  });

  it("a rolled-back admission emits no reservation; a committed one emits it once", async () => {
    const before = media().length, budget0 = await used(), jobs = Number((await db.query("SELECT count(*) FROM media_jobs")).rows[0].count);
    await arm("media_job_events:admitted");
    try {
      const refused = await request(owner);
      expect(refused.statusCode).toBe(500);
    } finally { await disarm(); }
    expect(media().length).toBe(before);
    expect(await used()).toBe(budget0);
    expect(Number((await db.query("SELECT count(*) FROM media_jobs")).rows[0].count)).toBe(jobs);
    const id = (await request(owner)).json().id;
    expect(media().slice(before)).toEqual([{ kind: "reserved", role: "media", microUsd: 250_000, modelId: "clip", basis: "reserved_ceiling" }]);
    await post(owner, `/api/admin/media-jobs/${id}/cancel`, { idempotencyKey: key() });
  });

  it("a rolled-back release emits nothing and releases nothing; the committed retry emits once", async () => {
    const id = (await request(owner)).json().id, before = media().length, budget0 = await used();
    await arm("media_command_receipts:");
    try {
      expect((await post(owner, `/api/admin/media-jobs/${id}/cancel`, { idempotencyKey: key() })).statusCode).toBe(500);
    } finally { await disarm(); }
    expect(media().length).toBe(before);
    expect(await used()).toBe(budget0);
    expect(await job(id)).toMatchObject({ state: "admitted", chargedMicroUsd: 250_000 });
    expect((await db.query("SELECT state FROM provider_spend_ledger WHERE source='media' AND source_ref=$1", [id])).rows[0].state).toBe("reserved");
    expect((await post(owner, `/api/admin/media-jobs/${id}/cancel`, { idempotencyKey: key() })).json()).toMatchObject({ chargeReleased: true });
    expect(media().slice(before)).toEqual([{ kind: "released", role: "media", microUsd: 250_000, modelId: "clip", basis: "reported" }]);
    expect(await used()).toBe(budget0 - 250_000);
  });

  it("a rolled-back settlement emits no actual or released cost; the committed retry emits each once", async () => {
    const id = (await request(owner)).json().id, budget0 = await used();
    await worker.run({ now: later(0), limit: 50 });
    expect((await job(id)).state).toBe("polling");
    const before = media().length;
    await arm("media_job_events:under_review");
    try {
      await worker.run({ now: later(2500), limit: 50 });
    } finally { await disarm(); }
    expect(media().length).toBe(before);
    expect(await job(id)).toMatchObject({ state: "polling", chargedMicroUsd: 250_000, asset: null });
    expect((await db.query("SELECT state FROM provider_spend_ledger WHERE source='media' AND source_ref=$1", [id])).rows[0].state).toBe("reserved");
    expect(await used()).toBe(budget0);
    // The rolled-back pass's lease runs out; the next pass settles and emits once.
    await worker.run({ now: later(400_000), limit: 50 });
    expect(await job(id)).toMatchObject({ state: "under_review", chargedMicroUsd: 130_000 });
    expect(media().slice(before)).toEqual([
      { kind: "actual", role: "media", microUsd: 130_000, modelId: "clip", basis: "reported" },
      { kind: "released", role: "media", microUsd: 120_000, modelId: "clip", basis: "reported" }]);
    await worker.run({ now: later(410_000), limit: 50 });
    expect(media().length).toBe(before + 2);
    expect(await used()).toBe(budget0 - 120_000);
    await post(owner, `/api/admin/media-jobs/${id}/cancel`, { idempotencyKey: key() });
  });
});
