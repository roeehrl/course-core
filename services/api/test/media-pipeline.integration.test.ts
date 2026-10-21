import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { classifyHttpError } from "@course-core/providers";
import { createDatabase, type Database } from "../src/database.js";
import { createTestDatabase, type TestDatabase } from "./test-database.js";
import { createServer } from "../src/server.js";
import { issueLoginCode } from "../src/auth.js";
import { credentialVault } from "../src/key-vault.js";
import { WorkspaceProviders } from "../src/provider-setup.js";
import { createMediaJobService, workspaceMediaResolver, type MediaJobService } from "../src/media-jobs.js";
import { startMediaScheduler } from "../src/media-scheduler.js";
import { svgRenderer } from "../src/svg-renderer.js";
import { fixture } from "./fixture.js";
import { largeVisual } from "./large-course-fixture.js";
import { MEDIA_CREDENTIAL, ScriptedAssist, ScriptedImage, ScriptedVideo, SYNTHETIC_CAPTIONS, SYNTHETIC_PNG, mediaJobPolicy, pipelineConfiguration, approveRevisionsForTest } from "./media-fixture.js";

// Real PostgreSQL, HTTP routes, budgets and ledger. Providers are scripted adapters; the clip tools
// are stand-in programs (qualification/clip-export-flow.ts runs the real ones). Nothing here shows
// how a real provider renders, bills or checks facts.
const schema = "media_pipeline_" + randomUUID().replaceAll("-", ""),
  workspace = randomUUID(),
  origin = "http://localhost:4310",
  bin = mkdtempSync(path.join(tmpdir(), "media-pipeline-tools-"));
function tool(name: string, body: string) {
  const file = path.join(bin, name);
  writeFileSync(file, `#!/usr/bin/env node\nconst fs = require('node:fs');\nconst args = process.argv.slice(2);\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}
const clipToolchain = {
  rasterizerPath: tool("raster", "fs.readFileSync(0); process.stdout.write(Buffer.from([137,80,78,71,13,10,26,10,1]));"),
  // Writes an MP4 `ftyp` header followed by the digest of what it was given, so different inputs give different clips.
  ffmpegPath: tool("ffmpeg", `const target = args.at(-1); const inputs = args.includes('-filter_complex') ? args.filter((a, i) => args[i - 1] === '-i').map(f => fs.readFileSync(f)) : [fs.readFileSync(0)];
const digest = require('node:crypto').createHash('sha256'); for (const input of inputs) digest.update(input);
fs.writeFileSync(target, Buffer.concat([Buffer.from([0,0,0,24,0x66,0x74,0x79,0x70]), digest.digest()]));`),
};
// The call timeout also bounds a local clip render (one stand-in process per frame), so it allows a loaded CI runner.
const options = { pollIntervalMs: 1000, maxPolls: 6, providerCallTimeoutMs: 30_000, maxActivePerWorkspace: 20, jobDurationMs: 3 * 3_600_000, clipToolchain };
interface Session { id: string; cookie: string; csrf: string }
let db: Database, app: Awaited<ReturnType<typeof createServer>>, bare: Awaited<ReturnType<typeof createServer>>, providers: WorkspaceProviders,
  worker: MediaJobService, owner: Session, reviewer: Session, learner: Session, releaseId: string, enrollment: string;
const video = new ScriptedVideo(), image = new ScriptedImage(), assist = new ScriptedAssist();
const headers = (s: Session) => ({ cookie: s.cookie, origin, "x-csrf-token": s.csrf });
const key = () => "pipeline-" + randomUUID();
async function login(role: string) {
  const id = randomUUID();
  await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [id, "test:" + id, `Pipeline ${role}`]);
  await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspace, id, role]);
  const r = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, id) } });
  expect(r.statusCode).toBe(200);
  return { id, cookie: r.cookies.map((c) => `${c.name}=${c.value}`).join("; "), csrf: r.json().csrfToken };
}
const post = (s: Session, url: string, payload: unknown = {}, server = app) => server.inject({ method: "POST", url, headers: headers(s), payload: payload as object });
const get = (s: Session, url: string) => app.inject({ url, headers: headers(s) });
let providerRevision = 0;
async function configure(media: "video" | "image" | "both") {
  // Every agent role is gated (N07): the owner approves the scripted media and reviewer revisions.
  await approveRevisionsForTest(db, workspace, pipelineConfiguration(media));
  const r = await post(owner, `/api/admin/workspaces/${workspace}/provider-setup`, { expectedRevision: providerRevision, idempotencyKey: key(),
    configuration: pipelineConfiguration(media), jobPolicy: { ...mediaJobPolicy(250_000), allowance: { microUsd: 250_000, tokens: 1_000_000 } }, credentials: providerRevision === 0 ? { [MEDIA_CREDENTIAL]: "synthetic-media-credential" } : {} });
  expect(r.statusCode, r.body).toBe(200);
  providerRevision = r.json().revision;
}
const job = async (id: string) => (await get(owner, `/api/admin/media-jobs/${id}`)).json();
const later = (ms: number) => new Date(Date.now() + ms);
async function drive(id: string, until = ["under_review", "failed"]) {
  for (let i = 0, t = 0; i < 12; i++, t += 2500) {
    await worker.run({ now: later(t) });
    if (until.includes((await job(id)).state)) break;
  }
  return job(id);
}
/** A 400 refusal recorded as the real transport records it, so it certifies that nothing ran. */
function refusal() {
  const error = classifyHttpError(400);
  error.usage = { accounting: { accountingKey: "x" }, providerId: "scripted-assist", modelId: "assist", operation: "assess", inputCharacters: 0, requestedMaxOutputTokens: null,
    requestedVideoSeconds: null, observedImageCount: null, observedVideoCount: null, cost: null,
    attempts: [{ attempt: 1, status: 400, outcome: "rejected", tokens: { input: null, output: null, total: null, cachedInput: null, thoughts: null, toolInput: null } }] };
  return error;
}
const SCRIPT = "Narrated diagram: the list holds 5, 3 and 8. After two comparisons the running minimum is 3, the smallest value.";
const base = (extra: Record<string, unknown> = {}) => ({ episodeId: "min", title: "Running minimum in motion",
  objective: "Show the running minimum keeping the smaller value at each comparison.", idempotencyKey: key(), ...extra });
const videoReview = (sha: string, extra: Record<string, unknown> = {}) => ({ decision: "approved", assetSha256: sha, captionsVtt: SYNTHETIC_CAPTIONS,
  transcript: "We compare the values in order; the running minimum is 3 at the end.",
  visualDescription: "Three boxes holding 5, 3 and 8; a highlight stays on the box holding 3.",
  findings: { factualAccuracy: true, labelsAndEquations: true, captionsMatchNarration: true, noMisleadingMotion: true },
  rationale: "Matches the approved script and the captions follow the narration.", idempotencyKey: key(), ...extra });
const ledger = async (ref: string) => (await db.query("SELECT state,role,reserved_micro_usd::int AS reserved,actual_micro_usd::int AS actual,released_micro_usd::int AS released FROM provider_spend_ledger WHERE source_ref=$1", [ref])).rows;
const used = async () => Number((await db.query("SELECT used_micro_usd FROM supervisor_workspace_budgets WHERE workspace_id=$1", [workspace])).rows[0]?.used_micro_usd ?? 0);
async function generatedVideo(extra: Record<string, unknown> = {}) {
  const r = await post(owner, `/api/admin/enrollments/${enrollment}/media-jobs`, base({ script: SCRIPT, ...extra }));
  expect(r.json().state, r.body).toBe("admitted");
  return drive(r.json().id);
}

let testDatabase: TestDatabase | undefined;
beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  providers = new WorkspaceProviders(db, credentialVault(randomBytes(32)), { "scripted-video": video.factory(), "scripted-image": image.factory(), "scripted-assist": assist.factory() });
  const renderer = await svgRenderer();
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false, workspaceProviders: providers, installedExtensions: [renderer], media: { options } });
  bare = await createServer(db, { loginCodes: true, origin, secureCookies: false, workspaceProviders: providers, installedExtensions: [renderer], media: { options: { ...options, clipToolchain: null } } });
  worker = createMediaJobService(db, workspaceMediaResolver(providers), options);
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspace, "pipeline-" + workspace, "Media pipeline qualification"]);
  owner = await login("owner");
  reviewer = await login("reviewer");
  learner = await login("learner");
  // One verified scene ("study-0": 2 s, an Amount control starting at 2) shown in the minimum episode.
  const course = fixture(), visual = largeVisual(0);
  course.visuals.push(visual);
  course.chapters[0]!.episodes[0]!.blocks.push({ id: "diagram-0", type: "visual", visualId: visual.id });
  course.extensions.push({ id: "course-core-svg-v1", version: renderer.version, integrity: renderer.integrity, execution: "declarative", entrypoint: "renderers/svg-v1.js", platforms: ["web"],
    capabilities: ["visual.render"], accessibility: { keyboard: true, reducedMotion: true, textAlternative: "Interactive bar charts with text alternatives." } });
  const imported = await post(owner, `/api/workspaces/${workspace}/releases`, course);
  expect(imported.statusCode, imported.body).toBe(200);
  releaseId = imported.json().id;
  const published = await post(owner, `/api/releases/${releaseId}/publish`);
  expect(published.statusCode, published.body).toBe(200);
  enrollment = (await post(learner, "/api/enrollments", { releaseId })).json().id;
  // Synthetic operator prices: video 30,000/s + 10,000/request; image 40,000/request; assistant 1 and 4 micro-USD per token.
  for (const [model, perRequest, perSecond, input, output] of [["clip", 10_000, 30_000, null, null], ["picture", 40_000, null, null, null], ["assist", null, null, 1_000_000, 4_000_000]] as const)
    await db.query(`INSERT INTO provider_model_prices(id,workspace_id,model_id,version,status,currency,micro_usd_per_request,micro_usd_per_output_second,input_micro_usd_per_million,
      output_micro_usd_per_million,effective_from,source_note,created_by) VALUES($1,$2,$3,1,'active','USD',$4,$5,$6,$7,clock_timestamp()-interval '1 minute','Synthetic price',$8)`,
    [randomUUID(), workspace, model, perRequest, perSecond, input, output, owner.id]);
  for (const scope of [undefined, enrollment]) {
    const r = await post(owner, `/api/admin/workspaces/${workspace}/provider-setup/budgets`, { expectedRevision: 0, idempotencyKey: key(),
      ...(scope ? { enrollmentId: scope } : {}), limits: { microUsd: 50_000_000, tokens: 10_000_000 }, paidWorkApproved: true });
    expect(r.statusCode, r.body).toBe(200);
  }
  await configure("video");
}, 60000);
afterAll(async () => {
  await app?.close();
  await bare?.close();
  await db?.end();
  await testDatabase?.drop();
  rmSync(bin, { recursive: true, force: true });
});

describe("provider contract: declared capabilities and adapter estimates (O08)", () => {
  it("estimates from the adapter's billable units and shows the declared retention", async () => {
    const preview = (await post(owner, `/api/admin/enrollments/${enrollment}/media-jobs/estimate`, { episodeId: "min" })).json();
    expect(preview).toMatchObject({ kind: "video", estimateMicroUsd: 130_000, units: { outputSeconds: 4, images: 0, requests: 1 }, admissible: true,
      capabilities: { billing: "per_output_second", cancellation: "local_abort_only", retention: { outputHours: 48 } } });
    const listed = (await get(owner, `/api/admin/releases/${releaseId}/media-jobs`)).json();
    expect(listed.provider).toMatchObject({ kind: "video", estimateMicroUsd: 130_000, capabilities: { retention: { outputHours: 48 } } });
    expect(listed.visuals).toEqual([{ id: "study-0", title: "Measured change 0", durationMs: 2000 }]);
    expect(listed.clipRendering).toBe("ready");
  });
  it("a provider that deletes its output soon bounds the job's deadline", async () => {
    video.retentionHours = 2;
    try {
      const r = (await post(owner, `/api/admin/enrollments/${enrollment}/media-jobs`, base({ script: SCRIPT }))).json();
      expect(r.state).toBe("admitted");
      // Two hours of retention less an hour's margin, although the job may otherwise run three hours.
      expect(Date.parse(r.deadlineAt) - Date.parse(r.createdAt)).toBeLessThanOrEqual(3_600_000 + 5_000);
      await post(owner, `/api/admin/media-jobs/${r.id}/cancel`, { idempotencyKey: key() });
    } finally { video.retentionHours = 48; }
  });
});

describe("generated video checked against its script and a reference (O09, F12)", { timeout: 60_000 }, () => {
  it("refuses approval when what the clip says contradicts the approved script, with the findings", async () => {
    const generated = await generatedVideo();
    expect(generated.state).toBe("under_review");
    const wrong = await post(reviewer, `/api/admin/media-jobs/${generated.id}/review`, videoReview(generated.asset.sha256, {
      transcript: "We compare the values in order; the running minimum is 8 at the end." }));
    expect(wrong.statusCode).toBe(409);
    expect(wrong.json()).toEqual({ error: "MEDIA_FACTUAL_CHECK_FAILED", details: { findings: [
      { code: "QUANTITY_CONTRADICTED", source: "script", subject: "running minimum", expected: "3", found: "8" }] } });
    expect((await job(generated.id)).state).toBe("under_review");
    // The contradicting clip is rejected; a consistent description is approved.
    const right = await post(reviewer, `/api/admin/media-jobs/${generated.id}/review`, videoReview(generated.asset.sha256));
    expect(right.json()).toMatchObject({ state: "approved" });
  });

  it("checks against a verified reference scene", async () => {
    const generated = await generatedVideo({ referenceVisualId: "study-0" });
    expect(generated.referenceVisualId).toBe("study-0");
    const contradicted = await post(reviewer, `/api/admin/media-jobs/${generated.id}/review`, videoReview(generated.asset.sha256, {
      visualDescription: "Bars grow with the amount; the amount is 7 when the clip starts and the minimum is 3." }));
    expect(contradicted.json()).toMatchObject({ error: "MEDIA_FACTUAL_CHECK_FAILED", details: { findings: [{ source: "reference", subject: "amount", expected: "2", found: "7" }] } });
    expect((await post(owner, `/api/admin/enrollments/${enrollment}/media-jobs`, base({ script: SCRIPT, referenceVisualId: "missing" }))).json().error).toBe("MEDIA_REFERENCE_NOT_FOUND");
  });

  it("runs a test check before review: rules always, the reviewer's model when asked, paid and settled", async () => {
    const generated = await generatedVideo();
    const text = { transcript: "We compare the values in order; the smallest value stays highlighted.", visualDescription: "Three boxes; a highlight moves and stays on the box holding 3.",
      captionsVtt: SYNTHETIC_CAPTIONS };
    assist.answers.push({ claims: [{ claim: "The highlight ends on 3", status: "contradicted", sourceQuote: "After two comparisons the running minimum is 3, the smallest value." }] });
    const idempotencyKey = key(), before = await used();
    const checked = await post(reviewer, `/api/admin/media-jobs/${generated.id}/check`, { ...text, useModel: true, idempotencyKey });
    expect(checked.statusCode, checked.body).toBe(200);
    expect(checked.json()).toMatchObject({ jobId: generated.id, assetSha256: generated.asset.sha256, rules: { verifier: "rules", verdict: "consistent" },
      model: { verifier: "model", verdict: "contradicted", findings: [{ code: "CLAIM_CONTRADICTED", source: "model" }] } });
    expect(assist.prompts.at(-1)).toContain("running minimum is 3");
    // Charged at the per-job allowance, then settled at the priced usage: 1,000 + 800 micro-USD.
    expect(await ledger(`assist:check:${checked.json().rules.id}`)).toEqual([{ state: "reconciled", role: "reviewer", reserved: 250_000, actual: 1800, released: 248_200 }]);
    expect(await used()).toBe(before + 1800);
    // A replay returns the stored answer without another call.
    const calls = assist.prompts.length;
    expect((await post(reviewer, `/api/admin/media-jobs/${generated.id}/check`, { ...text, useModel: true, idempotencyKey })).json()).toEqual(checked.json());
    expect(assist.prompts.length).toBe(calls);
    // The model's contradiction of this exact text blocks its approval.
    const blocked = await post(reviewer, `/api/admin/media-jobs/${generated.id}/review`, videoReview(generated.asset.sha256, text));
    expect(blocked.json()).toMatchObject({ error: "MEDIA_FACTUAL_CHECK_FAILED", details: { findings: [{ code: "CLAIM_CONTRADICTED" }] } });
    const detail = await job(generated.id);
    expect(detail.checks.map((c: { verifier: string; verdict: string }) => [c.verifier, c.verdict]).sort()).toEqual([["model", "contradicted"], ["rules", "consistent"]]);
    // A claimed contradiction quoting nothing in the sources does not block.
    assist.answers.push({ claims: [{ claim: "The box colours are wrong", status: "contradicted", sourceQuote: "The boxes must be blue." }] });
    const other = { ...text, visualDescription: "Three boxes holding 5, 3 and 8; the highlight ends on the box holding 3." };
    const invented = await post(reviewer, `/api/admin/media-jobs/${generated.id}/check`, { ...other, useModel: true, idempotencyKey: key() });
    expect(invented.json().model).toMatchObject({ verdict: "consistent", findings: [{ code: "MODEL_QUOTE_NOT_FOUND" }] });
    expect((await post(reviewer, `/api/admin/media-jobs/${generated.id}/review`, videoReview(generated.asset.sha256, other))).json().state).toBe("approved");
    // Learners and other roles cannot run checks; an invalid caption track is refused.
    expect((await post(learner, `/api/admin/media-jobs/${generated.id}/check`, { ...text, idempotencyKey: key() })).statusCode).toBe(403);
    expect((await post(reviewer, `/api/admin/media-jobs/${generated.id}/check`, { ...text, idempotencyKey: key() })).json().error).toBe("MEDIA_NOT_UNDER_REVIEW");
  });

  it("a refused model call is released, not charged", async () => {
    const generated = await generatedVideo();
    assist.failNext = refusal();
    const before = await used();
    const checked = (await post(reviewer, `/api/admin/media-jobs/${generated.id}/check`, { transcript: "We compare the values in order; the running minimum is 3.",
      visualDescription: "Three boxes; the highlight ends on the box holding 3.", captionsVtt: SYNTHETIC_CAPTIONS, useModel: true, idempotencyKey: key() })).json();
    expect(checked.model).toMatchObject({ verdict: "unverified", failure: "UPSTREAM_REJECTED" });
    expect(await ledger(`assist:check:${checked.rules.id}`)).toEqual([{ state: "not_started", role: "reviewer", reserved: 250_000, actual: null, released: 250_000 }]);
    expect(await used()).toBe(before);
  });
});

describe("generated images (O10, O12 image half)", { timeout: 60_000 }, () => {
  it("generates, stores, reviews with alt text, attaches and expires an image", async () => {
    await configure("image");
    try {
      const preview = (await post(owner, `/api/admin/enrollments/${enrollment}/media-jobs/estimate`, { episodeId: "min" })).json();
      expect(preview).toMatchObject({ kind: "image", estimateMicroUsd: 40_000, units: { images: 1, requests: 1 }, capabilities: { billing: "per_image" } });
      const prompt = "A labelled diagram: three boxes holding 5, 3 and 8. The minimum is 3, so that box is highlighted.";
      const r = await post(owner, `/api/admin/enrollments/${enrollment}/media-images`, base({ prompt }));
      expect(r.json(), r.body).toMatchObject({ kind: "generated_image", state: "admitted", chargedMicroUsd: 250_000, paid: true });
      const done = await drive(r.json().id);
      expect(done).toMatchObject({ state: "under_review", chargedMicroUsd: 40_000,
        asset: { mimeType: "image/png", byteLength: SYNTHETIC_PNG.byteLength, sha256: createHash("sha256").update(SYNTHETIC_PNG).digest("hex") } });
      expect(image.calls.at(-1)).toMatchObject({ prompt, aspectRatio: "16:9" });
      expect(await ledger(done.id)).toEqual([{ state: "reconciled", role: "media", reserved: 250_000, actual: 40_000, released: 210_000 }]);
      const review = { decision: "approved", assetSha256: done.asset.sha256, findings: { factualAccuracy: true, labelsAndEquations: true, captionsMatchNarration: true, noMisleadingMotion: true },
        rationale: "The labels match the script and the highlighted value is the minimum.", idempotencyKey: key() };
      expect((await post(reviewer, `/api/admin/media-jobs/${done.id}/review`, review)).json().error).toBe("MEDIA_TEXT_ALTERNATIVE_REQUIRED");
      expect((await post(reviewer, `/api/admin/media-jobs/${done.id}/review`, { ...review, idempotencyKey: key(), visualDescription: "Three boxes holding 5, 3 and 8; the box holding 3 is highlighted.",
        captionsVtt: SYNTHETIC_CAPTIONS })).json().error).toBe("INVALID_INPUT");
      expect((await post(reviewer, `/api/admin/media-jobs/${done.id}/review`, { ...review, idempotencyKey: key(), visualDescription: "Three boxes holding 5, 8 and 9; the minimum is 9." })).json().error)
        .toBe("MEDIA_FACTUAL_CHECK_FAILED");
      const approved = await post(reviewer, `/api/admin/media-jobs/${done.id}/review`, { ...review, idempotencyKey: key(), visualDescription: "Three boxes holding 5, 3 and 8; the box holding 3 is highlighted." });
      expect(approved.json()).toMatchObject({ state: "approved" });
      const attached = await post(owner, `/api/admin/media-jobs/${done.id}/attach`, { expiresAt: later(86_400_000).toISOString(), idempotencyKey: key() });
      expect(attached.json()).toMatchObject({ state: "attached", grantsCredit: false });
      const listed = (await get(learner, `/api/enrollments/${enrollment}/media?episodeId=min`)).json().media;
      const shown = listed.find((m: { mimeType: string }) => m.mimeType === "image/png");
      expect(shown).toMatchObject({ visualDescription: "Three boxes holding 5, 3 and 8; the box holding 3 is highlighted.", captionsUrl: null });
      expect((await app.inject({ url: shown.assetUrl, headers: headers(learner) })).rawPayload.equals(Buffer.from(SYNTHETIC_PNG))).toBe(true);
      const revoked = await post(reviewer, `/api/admin/media-attachments/${attached.json().attachmentId}/revoke`, { reason: "Replaced by a clearer image.", idempotencyKey: key() });
      expect(revoked.json().state).toBe("revoked");
      expect((await app.inject({ url: shown.assetUrl, headers: headers(learner) })).statusCode).toBe(404);
    } finally { await configure("video"); }
  });

  it("an image that may have been made stays held and is never requested again; a refusal is released", async () => {
    await configure("image");
    try {
      image.outcomes.push("unknown");
      const calls = image.calls.length;
      const held = (await post(owner, `/api/admin/enrollments/${enrollment}/media-images`, base({ prompt: "A diagram of a running minimum over a short list." }))).json().id;
      await worker.run({ now: later(0) });
      expect((await job(held)).state).toBe("uncertain");
      await worker.run({ now: later(60_000) });
      await worker.run({ now: later(4 * 3_600_000) });
      expect(await job(held)).toMatchObject({ state: "failed", failureCode: "MEDIA_OUTCOME_UNKNOWN", chargedMicroUsd: 250_000, remoteMayContinue: true });
      expect(image.calls.length - calls).toBe(1);
      expect((await ledger(held))[0]).toMatchObject({ state: "uncertain", reserved: 250_000, released: 0 });
      image.outcomes.push("rejected");
      const refused = (await post(owner, `/api/admin/enrollments/${enrollment}/media-images`, base({ prompt: "A diagram of a running minimum over a short list." }))).json().id;
      expect(await drive(refused)).toMatchObject({ state: "failed", failureCode: "MEDIA_PROVIDER_REJECTED", chargedMicroUsd: 0 });
      expect((await ledger(refused))[0]).toMatchObject({ state: "not_started", released: 250_000 });
      image.outcomes.push("not_an_image");
      const invalid = (await post(owner, `/api/admin/enrollments/${enrollment}/media-images`, base({ prompt: "A diagram of a running minimum over a short list." }))).json().id;
      expect(await drive(invalid)).toMatchObject({ state: "failed", failureCode: "MEDIA_ASSET_INVALID", asset: null });
      // The image route needs an image model; the clip route refuses it with a video model.
      await configure("video");
      expect((await post(owner, `/api/admin/enrollments/${enrollment}/media-images`, base({ prompt: "A diagram of a running minimum over a short list." }))).json().error).toBe("MEDIA_CAPABILITY_MISSING");
    } finally { await configure("video"); }
  });
});

describe("an image model and a video model bound together (O10, O12)", { timeout: 60_000 }, () => {
  it("pictures use the image model and clips the video model, each estimated and listed on its own", async () => {
    await configure("both");
    try {
      const library = (await get(owner, `/api/admin/releases/${releaseId}/media-jobs`)).json();
      expect(library.provider).toMatchObject({ kind: "video", modelId: "clip" });
      expect(library.imageProvider).toMatchObject({ kind: "image", modelId: "picture", settings: { aspectRatio: "1:1" }, availability: "ready", estimateMicroUsd: 40_000 });
      // The media role's own model is the default; `kind` picks the image model.
      expect((await post(owner, `/api/admin/enrollments/${enrollment}/media-jobs/estimate`, { episodeId: "min" })).json()).toMatchObject({ kind: "video", modelId: "clip" });
      expect((await post(owner, `/api/admin/enrollments/${enrollment}/media-jobs/estimate`, { episodeId: "min", kind: "image" })).json())
        .toMatchObject({ kind: "image", modelId: "picture", estimateMicroUsd: 40_000, capabilities: { billing: "per_image" } });
      const picture = await post(owner, `/api/admin/enrollments/${enrollment}/media-images`, base({ prompt: "A labelled diagram of three boxes holding 5, 3 and 8, with 3 highlighted." }));
      expect(picture.json(), picture.body).toMatchObject({ kind: "generated_image", state: "admitted" });
      expect(await drive(picture.json().id)).toMatchObject({ state: "under_review", chargedMicroUsd: 40_000 });
      expect(image.calls.at(-1)).toMatchObject({ modelId: "picture", aspectRatio: "1:1" });
      const submitted = video.submits.length;
      const clip = await generatedVideo();
      expect(clip).toMatchObject({ kind: "generated_short_video", state: "under_review" });
      expect(video.submits.length).toBe(submitted + 1);
      expect(video.submits.at(-1)).toMatchObject({ modelId: "clip" });
    } finally { await configure("video"); }
  });
  it("refuses an image model beside an image model, or one the registry does not have", async () => {
    const both = pipelineConfiguration("both");
    for (const media of [{ ...both.roles.media, mediaKind: "image", video: undefined, maxOutputTokens: 10 },
      { ...both.roles.media, imageModel: { ...both.roles.media.imageModel!, modelId: "missing" } },
      { ...both.roles.media, imageModel: { ...both.roles.media.imageModel!, modelId: "clip" } }]) {
      const r = await post(owner, `/api/admin/workspaces/${workspace}/provider-setup`, { expectedRevision: providerRevision, idempotencyKey: key(),
        configuration: { ...both, roles: { ...both.roles, media } }, jobPolicy: { ...mediaJobPolicy(250_000), allowance: { microUsd: 250_000, tokens: 1_000_000 } }, credentials: {} });
      expect(r.statusCode, r.body).toBe(400);
    }
  });
});

describe("exact clips from verified scenes (O10)", { timeout: 60_000 }, () => {
  it("renders a free, content-addressed exact clip that waits for review", async () => {
    const before = await used();
    const r = await post(owner, `/api/admin/enrollments/${enrollment}/media-clips`, base({ script: "The verified bar chart for the amount control, first second, at 12 frames a second.",
      visualId: "study-0", fromMs: 0, toMs: 1000, fps: 12, width: 480 }));
    expect(r.json(), r.body).toMatchObject({ kind: "scene_clip", state: "requested", paid: false, chargedMicroUsd: 0, referenceVisualId: "study-0" });
    const done = await drive(r.json().id);
    expect(done).toMatchObject({ state: "under_review", modelId: "core:scene-renderer", asset: { mimeType: "video/mp4", provenance: { kind: "scene_clip", visualId: "study-0", frames: 12, width: 480 } } });
    expect(done.asset.provenance.frameDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(await ledger(done.id)).toEqual([]);
    expect(await used()).toBe(before);
    expect(done.events.map((e: { to: string }) => e.to)).toEqual(["requested", "generated", "under_review"]);
  });
  it("refuses unknown scenes, ranges outside the scene, and a host without the clip tools", async () => {
    const clip = (extra: Record<string, unknown>, server = app) => post(owner, `/api/admin/enrollments/${enrollment}/media-clips`,
      base({ script: "The verified bar chart for the amount control, first second.", visualId: "study-0", fromMs: 0, toMs: 1000, ...extra }), server);
    expect((await clip({ visualId: "missing" })).json().error).toBe("MEDIA_REFERENCE_NOT_FOUND");
    expect((await clip({ toMs: 5000 })).json().error).toBe("MEDIA_CLIP_RANGE_INVALID");
    expect((await clip({ fps: 120 })).json().error).toBe("INVALID_INPUT");
    expect((await clip({}, bare)).json().error).toBe("MEDIA_CLIP_TOOLCHAIN_MISSING");
    expect((await get(owner, `/api/admin/releases/${releaseId}/media-jobs`)).json().clipRendering).toBe("ready");
    expect((await post(learner, `/api/admin/enrollments/${enrollment}/media-clips`, base({ script: "The verified bar chart, first second only.", visualId: "study-0", fromMs: 0, toMs: 1000 }))).statusCode).toBe(403);
  });
});

describe("storyboards and composition (O09)", { timeout: 60_000 }, () => {
  it("a model drafts, staff edit and approve, every shot is made and reviewed, then composed", async () => {
    assist.answers.push({ shots: [
      { kind: "generated", description: "Three boxes holding 5, 3 and 8 appear in a row.", narration: "We look for the smallest value.", durationSeconds: 5, visualId: "", fromMs: 0, toMs: 0 },
      { kind: "scene", description: "The verified bar chart animates its first second.", narration: "", durationSeconds: 0, visualId: "study-0", fromMs: 0, toMs: 1000 },
      { kind: "scene", description: "A scene the release does not have, shown anyway.", narration: "", durationSeconds: 0, visualId: "invented", fromMs: 0, toMs: 500 },
    ] });
    const created = await post(owner, `/api/admin/enrollments/${enrollment}/media-storyboards`, { episodeId: "min", title: "Running minimum, step by step",
      objective: "Show the running minimum keeping the smaller value.", script: SCRIPT, draftWith: "model", idempotencyKey: key() });
    expect(created.statusCode, created.body).toBe(200);
    const board = created.json();
    expect(board).toMatchObject({ state: "draft", draftStatus: "ready", draftedBy: "model", draftModelId: "assist", revision: 1 });
    // Durations snap to what the video model declares; a scene the release lacks becomes a generated shot.
    expect(board.shots).toEqual([
      { id: "shot-1", kind: "generated", description: "Three boxes holding 5, 3 and 8 appear in a row.", narration: "We look for the smallest value.", durationSeconds: 4 },
      { id: "shot-2", kind: "scene", description: "The verified bar chart animates its first second.", narration: "", visualId: "study-0", fromMs: 0, toMs: 1000 },
      { id: "shot-3", kind: "generated", description: "A scene the release does not have, shown anyway.", narration: "", durationSeconds: 4 },
    ]);
    expect(assist.prompts.at(-1)).toContain("study-0");
    expect(await ledger(`assist:storyboard:${board.id}`)).toEqual([{ state: "reconciled", role: "reviewer", reserved: 250_000, actual: 1800, released: 248_200 }]);
    // Nothing is made from a draft.
    expect((await post(owner, `/api/admin/enrollments/${enrollment}/media-jobs`, base({ script: SCRIPT, storyboardId: board.id, shotId: "shot-1" }))).json().error).toBe("MEDIA_STORYBOARD_NOT_APPROVED");
    const shots = board.shots.slice(0, 2).concat([{ id: "shot-3", kind: "generated", description: "The highlight rests on the box holding 3, the minimum.", narration: "The minimum is 3.", durationSeconds: 6 }]);
    expect((await post(reviewer, `/api/admin/media-storyboards/${board.id}/edit`, { expectedRevision: 1, shots, idempotencyKey: key() })).statusCode).toBe(403);
    const edited = await post(owner, `/api/admin/media-storyboards/${board.id}/edit`, { expectedRevision: 1, shots, referenceVisualId: "study-0", idempotencyKey: key() });
    expect(edited.json()).toMatchObject({ revision: 2, referenceVisualId: "study-0" });
    expect((await post(owner, `/api/admin/media-storyboards/${board.id}/edit`, { expectedRevision: 1, shots, idempotencyKey: key() })).json().error).toBe("MEDIA_STORYBOARD_REVISION_CONFLICT");
    expect((await post(learner, `/api/admin/media-storyboards/${board.id}/review`, { expectedRevision: 2, decision: "approved", idempotencyKey: key() })).statusCode).toBe(403);
    const approved = await post(reviewer, `/api/admin/media-storyboards/${board.id}/review`, { expectedRevision: 2, decision: "approved", note: "Shots follow the script.", idempotencyKey: key() });
    expect(approved.json()).toMatchObject({ state: "approved", reviewNote: "Shots follow the script." });
    expect((await post(owner, `/api/admin/media-storyboards/${board.id}/compose`, { idempotencyKey: key() })).json().error).toBe("MEDIA_COMPOSITION_INCOMPLETE");
    // A shot is made by the kind it names.
    expect((await post(owner, `/api/admin/enrollments/${enrollment}/media-clips`, base({ script: SCRIPT, visualId: "study-0", fromMs: 0, toMs: 1000, storyboardId: board.id, shotId: "shot-1" }))).json().error)
      .toBe("MEDIA_STORYBOARD_SHOT_MISMATCH");
    const parts: string[] = [];
    for (const shotId of ["shot-1", "shot-3"]) {
      const made = await generatedVideo({ storyboardId: board.id, shotId });
      expect(made).toMatchObject({ state: "under_review", storyboardId: board.id, shotId, referenceVisualId: "study-0" });
      expect((await post(reviewer, `/api/admin/media-jobs/${made.id}/review`, videoReview(made.asset.sha256))).json().state).toBe("approved");
      parts.push(made.id);
    }
    const scene = (await post(owner, `/api/admin/enrollments/${enrollment}/media-clips`, base({ script: "The verified bar chart animates its first second.", visualId: "study-0", fromMs: 0, toMs: 1000,
      storyboardId: board.id, shotId: "shot-2" }))).json();
    const rendered = await drive(scene.id);
    expect((await post(reviewer, `/api/admin/media-jobs/${rendered.id}/review`, videoReview(rendered.asset.sha256, {
      transcript: "The bar chart grows with the amount during its first second.", visualDescription: "Bars rise and fall as the amount control moves; the starting amount is 2." }))).json().state).toBe("approved");
    // Composition joins the approved clips in shot order, for free, and is reviewed as a whole.
    const composed = await post(owner, `/api/admin/media-storyboards/${board.id}/compose`, { width: 640, height: 360, fps: 12, idempotencyKey: key() });
    expect(composed.json(), composed.body).toMatchObject({ kind: "composed_video", state: "requested", paid: false, storyboardId: board.id });
    expect(composed.json().source.parts.map((p: { jobId: string }) => p.jobId)).toEqual([parts[0], rendered.id, parts[1]]);
    const whole = await drive(composed.json().id);
    expect(whole).toMatchObject({ state: "under_review", asset: { mimeType: "video/mp4", provenance: { kind: "composed_video" } } });
    expect(whole.asset.provenance.parts).toHaveLength(3);
    // Its check covers every shot of the storyboard.
    expect((await post(reviewer, `/api/admin/media-jobs/${whole.id}/review`, videoReview(whole.asset.sha256, { transcript: "We compare the values; the minimum is 9 at the end." }))).json().error)
      .toBe("MEDIA_FACTUAL_CHECK_FAILED");
    expect((await post(reviewer, `/api/admin/media-jobs/${whole.id}/review`, videoReview(whole.asset.sha256))).json().state).toBe("approved");
    const listed = (await get(owner, `/api/admin/releases/${releaseId}/media-storyboards`)).json().storyboards.find((b: { id: string }) => b.id === board.id);
    expect(listed.jobs).toHaveLength(4);
  });

  it("a staff storyboard needs valid shots to be approved; a failed model draft is released and left for staff", async () => {
    const staff = await post(owner, `/api/admin/enrollments/${enrollment}/media-storyboards`, { episodeId: "min", title: "Hand-written storyboard",
      objective: "Show the running minimum keeping the smaller value.", script: SCRIPT, draftWith: "staff", idempotencyKey: key(),
      shots: [{ id: "shot-1", kind: "generated", description: "Three boxes holding 5, 3 and 8.", narration: "", durationSeconds: 7 }] });
    expect(staff.json()).toMatchObject({ draftedBy: "staff", draftModelId: null, draftStatus: "ready" });
    expect((await post(reviewer, `/api/admin/media-storyboards/${staff.json().id}/review`, { expectedRevision: 1, decision: "approved", idempotencyKey: key() })).json().error)
      .toBe("MEDIA_SHOT_DURATION_UNSUPPORTED");
    expect((await post(owner, `/api/admin/enrollments/${enrollment}/media-storyboards`, { episodeId: "min", title: "Bad", objective: "Show the running minimum.", script: SCRIPT,
      draftWith: "staff", idempotencyKey: key() })).json().error).toBe("INVALID_INPUT");
    assist.failNext = refusal();
    const failed = await post(owner, `/api/admin/enrollments/${enrollment}/media-storyboards`, { episodeId: "min", title: "Model draft that fails",
      objective: "Show the running minimum keeping the smaller value.", script: SCRIPT, draftWith: "model", idempotencyKey: key() });
    expect(failed.json()).toMatchObject({ draftStatus: "failed", draftFailure: "UPSTREAM_REJECTED", state: "draft" });
    expect((await ledger(`assist:storyboard:${failed.json().id}`))[0]).toMatchObject({ state: "not_started", released: 250_000 });
    expect((await post(reviewer, `/api/admin/media-storyboards/${failed.json().id}/review`, { expectedRevision: 1, decision: "approved", idempotencyKey: key() })).json().error)
      .toBe("MEDIA_STORYBOARD_DRAFT_PENDING");
  });
});

describe("durable wake-ups instead of an interval worker (O08)", () => {
  it("a committed admission wakes the scheduler, which runs the job to review on its stored due times; a new scheduler resumes stored work", async () => {
    const service = createMediaJobService(db, workspaceMediaResolver(providers), { ...options, pollIntervalMs: 200 });
    const until = async (id: string, state: string) => {
      for (let i = 0; i < 100; i++) { if ((await job(id)).state === state) return true; await new Promise((r) => setTimeout(r, 100)); }
      return false;
    };
    const scheduler = startMediaScheduler(db, service, { maxSleepMs: 60_000, minSleepMs: 50 });
    try {
      await new Promise((r) => setTimeout(r, 300));
      const id = (await post(owner, `/api/admin/enrollments/${enrollment}/media-jobs`, base({ script: SCRIPT }))).json().id;
      // No pass is run by the test and the longest sleep is a minute: only the notification and the job's own due time move it.
      expect(await until(id, "under_review")).toBe(true);
      expect(scheduler.passes()).toBeGreaterThanOrEqual(2);
    } finally { await scheduler.stop(); }
    // Work admitted while no scheduler runs is found from the database by the next one.
    const waiting = (await post(owner, `/api/admin/enrollments/${enrollment}/media-jobs`, base({ script: SCRIPT }))).json().id;
    expect((await job(waiting)).state).toBe("admitted");
    expect(await service.nextDueAt()).toBeInstanceOf(Date);
    const restarted = startMediaScheduler(db, service, { maxSleepMs: 60_000, minSleepMs: 50 });
    try { expect(await until(waiting, "under_review")).toBe(true); }
    finally { await restarted.stop(); }
  }, 30000);
});

