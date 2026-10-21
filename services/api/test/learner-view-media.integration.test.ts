import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "../src/database.js";
import { createTestDatabase, type TestDatabase } from "./test-database.js";
import { createServer } from "../src/server.js";
import { issueLoginCode } from "../src/auth.js";
import { credentialVault } from "../src/key-vault.js";
import { WorkspaceProviders } from "../src/provider-setup.js";
import { createMediaJobService, workspaceMediaResolver, type MediaJobService } from "../src/media-jobs.js";
import { fixture } from "./fixture.js";
import { MEDIA_CREDENTIAL, ScriptedVideo, SYNTHETIC_CAPTIONS, SYNTHETIC_MP4, mediaConfiguration, mediaJobPolicy } from "./media-fixture.js";

// The read-only "view as learner" shows the course-made media attached for the learner, exactly
// as the learner's own lesson lists it, and plays it only under that recorded view. Real
// PostgreSQL, HTTP routes and the leased media worker; only the video adapter is scripted.
const schema = "learner_view_media_" + randomUUID().replaceAll("-", ""),
  workspace = randomUUID(),
  origin = "http://localhost:4310",
  options = { pollIntervalMs: 1000, maxPolls: 6, providerCallTimeoutMs: 2000, maxActivePerWorkspace: 10 };
interface Session { id: string; cookie: string; csrf: string }
let db: Database, app: Awaited<ReturnType<typeof createServer>>, worker: MediaJobService;
let owner: Session, admin: Session, instructor: Session, reviewer: Session, learner: Session, releaseId: string, enrollment: string;
const video = new ScriptedVideo();
const headers = (s: Session) => ({ cookie: s.cookie, origin, "x-csrf-token": s.csrf });
const key = () => "lv-media-" + randomUUID();
async function login(role: string, workspaceId = workspace) {
  const id = randomUUID();
  await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [id, "test:" + id, `View ${role}`]);
  await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspaceId, id, role]);
  const r = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, id) } });
  expect(r.statusCode).toBe(200);
  return { id, cookie: r.cookies.map((c) => `${c.name}=${c.value}`).join("; "), csrf: r.json().csrfToken };
}
const post = (s: Session, url: string, payload: unknown = {}) => app.inject({ method: "POST", url, headers: headers(s), payload: payload as object });
const get = (s: Session, url: string, extra: Record<string, string> = {}) => app.inject({ url, headers: { ...headers(s), ...extra } });
const later = (ms: number) => new Date(Date.now() + ms);
const viewUrl = () => `/api/admin/enrollments/${enrollment}/learner-view`;
const approval = (sha: string) => ({ decision: "approved", assetSha256: sha, captionsVtt: SYNTHETIC_CAPTIONS,
  transcript: "The running minimum keeps the smaller value after each comparison in the list.",
  visualDescription: "A list of five boxes; a highlight moves left to right and stays on the smallest value so far.",
  findings: { factualAccuracy: true, labelsAndEquations: true, captionsMatchNarration: true, noMisleadingMotion: true },
  rationale: "Matches the reference trace for the minimum episode and the captions follow the narration.", idempotencyKey: key() });
/** Requests one clip for the learner and drives it to review; `attach` publishes it to them. */
async function clip(title: string, attach = true) {
  const r = await post(owner, `/api/admin/enrollments/${enrollment}/media-jobs`, { episodeId: "min", title,
    objective: "Show the running minimum keeping the smaller value at each comparison.",
    script: "Narrated diagram: a highlighted value moves along a list; at each comparison the smaller value stays highlighted.", idempotencyKey: key() });
  expect(r.statusCode, r.body).toBe(200);
  const id = r.json().id as string;
  let job = (await get(owner, `/api/admin/media-jobs/${id}`)).json();
  for (let i = 0, t = 0; i < 12 && job.state !== "under_review"; i++, t += 2500) {
    await worker.run({ now: later(t) });
    job = (await get(owner, `/api/admin/media-jobs/${id}`)).json();
  }
  expect(job.state).toBe("under_review");
  if (!attach) return { jobId: id, attachmentId: null };
  expect((await post(reviewer, `/api/admin/media-jobs/${id}/review`, approval(job.asset.sha256))).statusCode).toBe(200);
  const attached = await post(owner, `/api/admin/media-jobs/${id}/attach`, { expiresAt: later(86_400_000).toISOString(), idempotencyKey: key() });
  expect(attached.statusCode, attached.body).toBe(200);
  return { jobId: id, attachmentId: attached.json().attachmentId as string };
}

let testDatabase: TestDatabase | undefined;
let shown: { jobId: string; attachmentId: string | null }, revoked: { jobId: string; attachmentId: string | null };
beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  const providers = new WorkspaceProviders(db, credentialVault(randomBytes(32)), { "scripted-video": video.factory() });
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false, workspaceProviders: providers, media: { options } });
  worker = createMediaJobService(db, workspaceMediaResolver(providers), options);
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspace, "lv-media-" + workspace, "Learner view media"]);
  owner = await login("owner");
  admin = await login("admin");
  instructor = await login("instructor");
  reviewer = await login("reviewer");
  learner = await login("learner");
  const imported = await post(owner, `/api/workspaces/${workspace}/releases`, fixture());
  expect(imported.statusCode, imported.body).toBe(200);
  releaseId = imported.json().id;
  expect((await post(owner, `/api/releases/${releaseId}/publish`)).statusCode).toBe(200);
  enrollment = (await post(learner, "/api/enrollments", { releaseId })).json().id;
  const configured = await post(owner, `/api/admin/workspaces/${workspace}/provider-setup`, { expectedRevision: 0, idempotencyKey: key(),
    configuration: mediaConfiguration(), jobPolicy: mediaJobPolicy(250_000), credentials: { [MEDIA_CREDENTIAL]: "synthetic-media-credential" } });
  expect(configured.statusCode, configured.body).toBe(200);
  for (const target of [undefined, enrollment]) {
    const r = await post(owner, `/api/admin/workspaces/${workspace}/provider-setup/budgets`, { expectedRevision: 0, idempotencyKey: key(),
      ...(target ? { enrollmentId: target } : {}), limits: { microUsd: 50_000_000, tokens: 1_000_000 }, paidWorkApproved: true });
    expect(r.statusCode, r.body).toBe(200);
  }
  shown = await clip("Running minimum in motion");
  revoked = await clip("Superseded minimum clip");
  expect((await post(reviewer, `/api/admin/media-attachments/${revoked.attachmentId}/revoke`, { reason: "Superseded by a corrected clip.", idempotencyKey: key() })).statusCode).toBe(200);
  await clip("Clip still under review", false);
}, 60000);
afterAll(async () => {
  await app?.close();
  await db?.end();
  await testDatabase?.drop();
});

describe("view as learner: course-made media", () => {
  it("lists exactly the media the learner is shown, with title, state, captions and transcript, under the recorded view", async () => {
    const own = (await get(learner, `/api/enrollments/${enrollment}/media?episodeId=min`)).json().media;
    expect(own.map((m: { id: string }) => m.id)).toEqual([shown.attachmentId]);
    for (const viewer of [owner, admin]) {
      const views = (await db.query("SELECT count(*)::int AS n FROM staff_learner_views WHERE enrollment_id=$1", [enrollment])).rows[0].n;
      const r = await get(viewer, viewUrl());
      expect(r.statusCode, r.body).toBe(200);
      const body = r.json();
      // Revoked and unapproved clips are absent, as they are for the learner.
      expect(body.generatedMedia).toHaveLength(1);
      const [item] = body.generatedMedia, base = `/api/admin/enrollments/${enrollment}/learner-view/${body.view.id}/media/${shown.attachmentId}`;
      expect(item).toEqual({
        id: shown.attachmentId, episodeId: "min", title: own[0].title, objective: own[0].objective, transcript: own[0].transcript,
        visualDescription: own[0].visualDescription, captions: true, captionsLanguage: null, mimeType: own[0].mimeType, byteLength: own[0].byteLength,
        reviewedAt: own[0].reviewedAt, expiresAt: own[0].expiresAt, state: "available", assetUrl: `${base}/asset`, captionsUrl: `${base}/captions.vtt`,
      });
      expect(r.body).not.toContain("Superseded minimum clip");
      expect(r.body).not.toContain("Clip still under review");
      // Showing media is part of the one recorded view.
      expect((await db.query("SELECT count(*)::int AS n FROM staff_learner_views WHERE enrollment_id=$1", [enrollment])).rows[0].n).toBe(views + 1);
      expect((await db.query("SELECT viewer_id FROM staff_learner_views WHERE id=$1", [body.view.id])).rows[0].viewer_id).toBe(viewer.id);
      // The clip and its captions play under that view, with range support.
      const asset = await get(viewer, item.assetUrl);
      expect(asset.statusCode).toBe(200);
      expect(asset.headers["cache-control"]).toBe("no-store");
      expect(asset.rawPayload.equals(Buffer.from(SYNTHETIC_MP4))).toBe(true);
      const part = await get(viewer, item.assetUrl, { range: "bytes=0-7" });
      expect(part.statusCode).toBe(206);
      expect(part.rawPayload.equals(Buffer.from(SYNTHETIC_MP4.subarray(0, 8)))).toBe(true);
      const captions = await get(viewer, item.captionsUrl);
      expect(captions.headers["content-type"]).toContain("text/vtt");
      expect(captions.body).toBe(SYNTHETIC_CAPTIONS);
    }
  });

  it("plays media only under the viewer's own recent view of this enrollment, for clips the learner can see", async () => {
    const body = (await get(owner, viewUrl())).json();
    const base = (viewId: string, attachmentId = shown.attachmentId) => `/api/admin/enrollments/${enrollment}/learner-view/${viewId}/media/${attachmentId}`;
    // Another admin cannot ride on the owner's view; a made-up view is refused too.
    for (const url of [`${base(body.view.id)}/asset`, `${base(body.view.id)}/captions.vtt`])
      expect((await get(admin, url)).json().error).toBe("LEARNER_VIEW_REQUIRED");
    expect((await get(owner, `${base(randomUUID())}/asset`)).json().error).toBe("LEARNER_VIEW_REQUIRED");
    // A view older than the window no longer plays; reopening the view gives fresh links.
    const old = randomUUID();
    await db.query(`INSERT INTO staff_learner_views(id,enrollment_id,workspace_id,viewer_id,viewer_role,enrollment_revision,created_at)
      VALUES($1,$2,$3,$4,'owner',1,clock_timestamp()-interval '2 hours')`, [old, enrollment, workspace, owner.id]);
    expect((await get(owner, `${base(old)}/asset`)).statusCode).toBe(403);
    // Roles without the learner view, the learner and other workspaces are refused.
    for (const who of [instructor, reviewer, learner]) expect((await get(who, `${base(body.view.id)}/asset`)).statusCode).toBe(403);
    const elsewhere = randomUUID();
    await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [elsewhere, "lv-other-" + elsewhere, "Other"]);
    expect((await get(await login("owner", elsewhere), `${base(body.view.id)}/asset`)).statusCode).toBe(404);
    expect((await app.inject({ url: `${base(body.view.id)}/asset`, headers: { origin } })).statusCode).toBe(401);
    // Revoked or never-attached media is not served, even under a valid view.
    expect((await get(owner, `${base(body.view.id, revoked.attachmentId!)}/asset`)).statusCode).toBe(404);
    expect((await get(owner, `${base(body.view.id, randomUUID())}/captions.vtt`)).statusCode).toBe(404);
    // Media attached to another enrollment is not reachable through this one's view.
    const otherLearner = await login("learner");
    const other = (await post(otherLearner, "/api/enrollments", { releaseId })).json().id;
    const foreign = (await get(owner, `/api/admin/enrollments/${other}/learner-view`)).json();
    expect(foreign.generatedMedia).toEqual([]);
    expect((await get(owner, `/api/admin/enrollments/${other}/learner-view/${foreign.view.id}/media/${shown.attachmentId}/asset`)).statusCode).toBe(404);
  });

  it("reads media without changing the learner's state or any media record", async () => {
    const before = (await get(learner, `/api/enrollments/${enrollment}`)).json();
    const media = async () => (await db.query("SELECT j.id,j.state,j.updated_at,a.revoked_at FROM media_jobs j LEFT JOIN media_attachments a ON a.job_id=j.id ORDER BY j.id")).rows;
    const jobs = await media();
    const body = (await get(admin, viewUrl())).json();
    await get(admin, body.generatedMedia[0].assetUrl);
    await get(admin, body.generatedMedia[0].captionsUrl);
    expect(await media()).toEqual(jobs);
    expect((await get(learner, `/api/enrollments/${enrollment}`)).json()).toEqual(before);
  });
});
