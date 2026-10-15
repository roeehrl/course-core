import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, transaction, type Database } from "../src/database.js";
import { createTestDatabase, type TestDatabase } from "./test-database.js";
import { createServer } from "../src/server.js";
import { issueLoginCode } from "../src/auth.js";
import { credentialVault } from "../src/key-vault.js";
import { WorkspaceProviders } from "../src/provider-setup.js";
import type { AdapterFactory } from "../src/provider-composition.js";
import { createMediaJobService, workspaceMediaResolver, type MediaJobService } from "../src/media-jobs.js";
import { ERASED_MEDIA_TEXT, eraseEnrollmentMedia } from "../src/media-erasure.js";
import { WITHHELD_FROM_STAFF } from "../src/learner-privacy.js";
import { fixture } from "./fixture.js";
import { MEDIA_CREDENTIAL, ScriptedVideo, mediaConfiguration, mediaJobPolicy } from "./media-fixture.js";

// Generated media is requested by staff for one learner. Erasing that learner redacts every piece
// of text staff wrote for it (job, review, revocation, the provider's opaque operation state) and
// deletes the clip rendered for them, everywhere in the database and in every export, while the
// accounting (IDs, states, digests, charges, ledger rows) stays and another learner's media is
// untouched. Planted marker strings prove absence by scanning every table. Real PostgreSQL, HTTP
// routes and the leased worker; only the video adapter is scripted (it echoes the prompt into its
// opaque operation state, as an adapter may).
const schema = "erasure_media_text_" + randomUUID().replaceAll("-", ""),
  workspace = randomUUID(),
  origin = "http://localhost:4310",
  ALLOWANCE = 250_000,
  options = { pollIntervalMs: 1000, maxPolls: 6, providerCallTimeoutMs: 20_000, maxActivePerWorkspace: 20 };
interface Session { id: string; cookie: string; csrf: string }
let testDatabase: TestDatabase | undefined, db: Database, app: Awaited<ReturnType<typeof createServer>>, worker: MediaJobService, owner: Session, releaseId: string;
const video = new ScriptedVideo();
let gate: Promise<void> | null = null, submitting = 0;
const echoing: AdapterFactory = (factoryOptions) => {
  const adapter = video.factory()(factoryOptions), port = adapter.ports.video!;
  const start = port.startVideo.bind(port);
  port.startVideo = async (request, call) => {
    submitting += 1;
    if (gate) await gate;
    const echo = <T>(job: T) => (job && typeof job === "object" && "providerState" in job
      ? { ...job, providerState: { ...(job.providerState as object), echoedPrompt: request.prompt } } : job);
    try {
      const result = await start(request, call);
      return { ...result, output: { ...result.output, job: echo(result.output.job) } } as typeof result;
    } catch (error) {
      const e = error as { job?: unknown };
      if (e.job) e.job = echo(e.job);
      throw error;
    }
  };
  return adapter;
};
const headers = (s: Session) => ({ cookie: s.cookie, origin, "x-csrf-token": s.csrf });
const key = () => "erasure-text-" + randomUUID();
const later = (ms: number) => new Date(Date.now() + ms);
async function login(role: string) {
  const id = randomUUID();
  await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [id, "test:" + id, `Synthetic ${role}`]);
  await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspace, id, role]);
  const r = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, id) } });
  expect(r.statusCode).toBe(200);
  return { id, cookie: r.cookies.map((c) => `${c.name}=${c.value}`).join("; "), csrf: r.json().csrfToken };
}
const post = (s: Session, url: string, payload: unknown = {}) => app.inject({ method: "POST", url, headers: headers(s), payload: payload as object });
const get = (s: Session, url: string) => app.inject({ method: "GET", url, headers: headers(s) });
const budgetRevisions: Record<string, number> = {};
async function budget(microUsd: number, enrollmentId?: string) {
  const scope = enrollmentId ?? "workspace";
  const r = await post(owner, `/api/admin/workspaces/${workspace}/provider-setup/budgets`, { expectedRevision: budgetRevisions[scope] ?? 0,
    idempotencyKey: key(), ...(enrollmentId ? { enrollmentId } : {}), limits: { microUsd, tokens: 1_000_000 }, paidWorkApproved: true });
  expect(r.statusCode, r.body).toBe(200);
  budgetRevisions[scope] = r.json().revision;
}

/** A learner with a unique marker planted in everything staff write for their media. */
async function learner(label: string) {
  const session = await login("learner");
  const enrollment = (await post(session, "/api/enrollments", { releaseId })).json().id as string;
  await budget(10_000_000, enrollment);
  return { session, enrollment, marker: `PLANTED${label}${randomBytes(6).toString("hex").toUpperCase()}` };
}
type Learner = Awaited<ReturnType<typeof learner>>;
async function requestJob(l: Learner, tag: string) {
  const r = await post(owner, `/api/admin/enrollments/${l.enrollment}/media-jobs`, { episodeId: "min", title: `${l.marker} title ${tag}`,
    objective: `Show ${l.marker} why the running minimum keeps the smaller value (${tag}).`,
    script: `Narrated for ${l.marker}: a highlighted value moves along a list and the smaller value stays highlighted (${tag}).`, idempotencyKey: key() });
  expect(r.statusCode, r.body).toBe(200);
  expect(r.json()).toMatchObject({ state: "admitted", chargedMicroUsd: ALLOWANCE });
  return r.json().id as string;
}
const job = async (id: string) => (await get(owner, `/api/admin/media-jobs/${id}`)).json();
async function drive(id: string, until: string[]) {
  for (let i = 0, t = 0; i < 12; i++, t += 2500) {
    await worker.run({ now: later(t) });
    if (until.includes((await job(id)).state)) break;
  }
  return job(id);
}
const captions = (marker: string) => `WEBVTT\n\n00:00.000 --> 00:04.000\n${marker} the running minimum keeps the smaller value.\n`;
const review = (l: Learner, sha: string, decision: "approved" | "rejected") => ({ decision, assetSha256: sha, captionsVtt: captions(l.marker),
  transcript: `Transcript for ${l.marker}: the running minimum keeps the smaller value after each comparison.`,
  visualDescription: `Visual for ${l.marker}: a highlight moves left to right and stays on the smallest value so far.`,
  findings: { factualAccuracy: true, labelsAndEquations: true, captionsMatchNarration: true, noMisleadingMotion: true },
  rationale: `Reviewed for ${l.marker}; matches the reference trace and the captions follow the narration.`, idempotencyKey: key() });
async function generated(l: Learner, tag: string) {
  const id = await requestJob(l, tag);
  video.submitOutcomes.push("accept_completed");
  const done = await drive(id, ["under_review"]);
  expect(done.state).toBe("under_review");
  return { id, sha: done.asset.sha256 as string };
}
async function attached(l: Learner, tag: string) {
  const g = await generated(l, tag);
  expect((await post(owner, `/api/admin/media-jobs/${g.id}/review`, review(l, g.sha, "approved"))).statusCode).toBe(200);
  const r = await post(owner, `/api/admin/media-jobs/${g.id}/attach`, { expiresAt: later(86_400_000).toISOString(), idempotencyKey: key() });
  expect(r.statusCode, r.body).toBe(200);
  return { ...g, attachmentId: r.json().attachmentId as string };
}
/** Five jobs in different end states, each carrying the learner's marker. */
async function plant(l: Learner) {
  const shown = await attached(l, "attached");
  const rejected = await generated(l, "rejected");
  expect((await post(owner, `/api/admin/media-jobs/${rejected.id}/review`, review(l, rejected.sha, "rejected"))).statusCode).toBe(200);
  const revoked = await attached(l, "revoked");
  const r = await post(owner, `/api/admin/media-attachments/${revoked.attachmentId}/revoke`, { reason: `Not right for ${l.marker} any more.`, idempotencyKey: key() });
  expect(r.statusCode, r.body).toBe(200);
  const polling = await requestJob(l, "polling");
  video.submitOutcomes.push("accept");
  await worker.run({ now: later(0) });
  expect((await job(polling)).state).toBe("polling");
  const unsent = await requestJob(l, "unsent");
  return { shown, rejected, revoked, polling, unsent, ids: [shown.id, rejected.id, revoked.id, polling, unsent] };
}
async function erase(l: Learner) {
  const r = await post(l.session, `/api/enrollments/${l.enrollment}/erase`, { confirmation: `ERASE ${l.enrollment.slice(0, 8)}`, reason: "Synthetic learner asked for erasure." });
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as { counts: Record<string, number>; replayed: boolean };
}
/** Every base table whose rows mention `marker` anywhere (text, JSON or the bytes' hex). */
async function tablesMentioning(marker: string) {
  const tables = (await db.query<{ name: string }>("SELECT table_name AS name FROM information_schema.tables WHERE table_schema=$1 AND table_type='BASE TABLE' ORDER BY 1", [schema])).rows;
  const hits: string[] = [];
  for (const { name } of tables)
    if ((await db.query(`SELECT 1 FROM "${schema}"."${name}" t WHERE t::text LIKE $1 LIMIT 1`, ["%" + marker + "%"])).rowCount) hits.push(name);
  return hits;
}
const exported = async (s: Session, enrollment: string) => {
  const r = await get(s, `/api/enrollments/${enrollment}/export`);
  expect(r.statusCode, r.body).toBe(200);
  return { doc: r.json(), text: r.body };
};
/** The accounting of an enrollment's media: kept by erasure. */
async function accounting(enrollment: string) {
  const q = async (sql: string) => (await db.query(sql, [enrollment])).rows;
  return {
    jobs: await q(`SELECT id,workspace_id,course_release_id,episode_id,kind,provider_revision,model_id,settings,pricing,estimate_micro_usd,idempotency_key,request_digest,
      provider_operation_id,provider_operation->'providerId' AS provider_id,provider_operation->'accounting' AS operation_accounting,submit_attempts,poll_attempts,requested_by,created_at
      FROM media_jobs WHERE enrollment_id=$1 ORDER BY id`),
    reviews: await q("SELECT id,job_id,decision,asset_sha256,findings,reviewed_by,created_at FROM media_reviews WHERE job_id IN (SELECT id FROM media_jobs WHERE enrollment_id=$1) ORDER BY id"),
    attachments: await q("SELECT id,job_id,review_id,episode_id,expires_at,attached_by,created_at FROM media_attachments WHERE enrollment_id=$1 ORDER BY id"),
    events: await q("SELECT e.id,e.job_id,e.from_state,e.to_state,e.code,e.actor_id FROM media_job_events e JOIN media_jobs j ON j.id=e.job_id WHERE j.enrollment_id=$1 ORDER BY e.id"),
    ledger: await q("SELECT * FROM provider_spend_ledger WHERE enrollment_id=$1 ORDER BY id"),
  };
}
/** Everything stored for an enrollment's media, for an exact before/after comparison. */
async function everything(enrollment: string) {
  const q = async (sql: string) => (await db.query(sql, [enrollment])).rows.map((r) => r.row);
  return {
    jobs: await q("SELECT to_jsonb(j) AS row FROM media_jobs j WHERE enrollment_id=$1 ORDER BY id"),
    assets: await q("SELECT jsonb_build_object('job',job_id,'sha',sha256,'md5',md5(content),'size',byte_length) AS row FROM media_assets WHERE job_id IN (SELECT id FROM media_jobs WHERE enrollment_id=$1) ORDER BY job_id"),
    reviews: await q("SELECT to_jsonb(r) AS row FROM media_reviews r WHERE job_id IN (SELECT id FROM media_jobs WHERE enrollment_id=$1) ORDER BY id"),
    attachments: await q("SELECT to_jsonb(a) AS row FROM media_attachments a WHERE enrollment_id=$1 ORDER BY id"),
    events: await q("SELECT to_jsonb(e) AS row FROM media_job_events e WHERE job_id IN (SELECT id FROM media_jobs WHERE enrollment_id=$1) ORDER BY id"),
    ledger: await q("SELECT to_jsonb(l) AS row FROM provider_spend_ledger l WHERE enrollment_id=$1 ORDER BY id"),
    budget: await q("SELECT to_jsonb(b) AS row FROM supervisor_enrollment_budgets b WHERE enrollment_id=$1"),
  };
}

beforeAll(async () => {
  if (!process.env.TEST_DATABASE_URL || process.env.DATABASE_URL) throw Error("Disposable TEST_DATABASE_URL required");
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  const providers = new WorkspaceProviders(db, credentialVault(randomBytes(32)), { "scripted-video": echoing });
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false, workspaceProviders: providers, media: { options } });
  worker = createMediaJobService(db, workspaceMediaResolver(providers), options);
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspace, "erasure-text-" + workspace, "Erasure media text"]);
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
  await testDatabase?.drop();
});

describe("erasure redacts the media staff made for the learner", () => {
  it("removes every planted marker from every table and export, keeps the accounting, and leaves another learner's media untouched", async () => {
    const erased = await learner("A"), bystander = await learner("B");
    // The bystander's job first: driving the worker for it later would also move the planted jobs.
    const b = await attached(bystander, "bystander");
    const a = await plant(erased);

    // Before erasure the learner's own download carries all of it; so does a staff copy, which the
    // shared privacy rule (learner-privacy.ts) still limits to its usual categories.
    const own = await exported(erased.session, erased.enrollment);
    expect(own.doc.media.items).toHaveLength(5);
    expect(own.doc.media.truncated).toBe(false);
    const shownRow = own.doc.media.items.find((m: { id: string }) => m.id === a.shown.id);
    expect(shownRow).toMatchObject({ state: "attached", title: `${erased.marker} title attached`, asset_sha256: a.shown.sha, review_decision: "approved",
      review_captions_vtt: captions(erased.marker), attachment_id: a.shown.attachmentId, attachment_revoked_at: null });
    expect(shownRow.script).toContain(erased.marker);
    expect(own.doc.media.items.find((m: { id: string }) => m.id === a.revoked.id).attachment_revoke_reason).toContain(erased.marker);
    expect(own.text).not.toContain(bystander.marker);
    const staffCopy = await exported(owner, erased.enrollment);
    expect(staffCopy.doc).toMatchObject({ audience: "staff", withheld: WITHHELD_FROM_STAFF, companion: null, learnerModel: null });
    expect(staffCopy.doc.media.items.map((m: { id: string }) => m.id).sort()).toEqual([...a.ids].sort());
    expect(staffCopy.text).toContain(erased.marker);
    // The planted text really is stored, including in the provider's opaque operation state.
    expect(await tablesMentioning(erased.marker)).toEqual(expect.arrayContaining(["media_jobs", "media_reviews", "media_attachments"]));
    expect((await db.query("SELECT provider_operation::text AS op FROM media_jobs WHERE id=$1", [a.polling])).rows[0].op).toContain(erased.marker);

    const accountingBefore = await accounting(erased.enrollment), bystanderBefore = await everything(bystander.enrollment);
    const chargedBefore = new Map((await db.query("SELECT id,charged_micro_usd::int AS c FROM media_jobs WHERE enrollment_id=$1", [erased.enrollment])).rows.map((r) => [r.id, r.c]));
    const settledBefore = accountingBefore.ledger.filter((r) => r.settled_at !== null);

    const result = await erase(erased);
    expect(result.counts).toMatchObject({ mediaJobText: 5, mediaReviews: 3, mediaRevokeReasons: 1, mediaAssets: 3, mediaAttachments: 1 });

    // Gone from every table, the events and outbox included.
    expect(await tablesMentioning(erased.marker)).toEqual([]);
    // The clips rendered for this learner are deleted; their digests stay on the reviews.
    expect(Number((await db.query("SELECT count(*) FROM media_assets WHERE job_id=ANY($1::uuid[])", [a.ids])).rows[0].count)).toBe(0);

    // Accounting kept: IDs, digests, model and pricing, provider identity, review decisions and
    // findings, attachment records and every earlier event; settled ledger rows unchanged.
    const accountingAfter = await accounting(erased.enrollment);
    expect(accountingAfter.jobs).toEqual(accountingBefore.jobs);
    expect(accountingAfter.reviews).toEqual(accountingBefore.reviews);
    expect(accountingAfter.attachments).toEqual(accountingBefore.attachments);
    expect(accountingAfter.events.slice(0, accountingBefore.events.length)).toEqual(accountingBefore.events);
    expect(accountingAfter.ledger.map((r) => r.id)).toEqual(accountingBefore.ledger.map((r) => r.id));
    for (const row of settledBefore) expect(accountingAfter.ledger.find((r) => r.id === row.id)).toEqual(row);
    const chargedAfter = new Map((await db.query("SELECT id,charged_micro_usd::int AS c FROM media_jobs WHERE enrollment_id=$1", [erased.enrollment])).rows.map((r) => [r.id, r.c]));
    for (const id of [a.shown.id, a.rejected.id, a.revoked.id, a.polling]) expect(chargedAfter.get(id)).toBe(chargedBefore.get(id));
    expect(chargedAfter.get(a.unsent)).toBe(0); // never ran: released by #74
    const states = Object.fromEntries((await db.query("SELECT id,state FROM media_jobs WHERE enrollment_id=$1", [erased.enrollment])).rows.map((r) => [r.id, r.state]));
    expect(states).toEqual({ [a.shown.id]: "expired", [a.rejected.id]: "rejected", [a.revoked.id]: "expired", [a.polling]: "cancelled", [a.unsent]: "cancelled" });
    const op = (await db.query("SELECT provider_operation AS op FROM media_jobs WHERE id=$1", [a.polling])).rows[0].op;
    expect(op).toMatchObject({ kind: "video", providerId: "scripted", modelId: "clip", providerState: { erased: true } });

    // The other learner's media is exactly as it was, and still plays for them.
    expect(await everything(bystander.enrollment)).toEqual(bystanderBefore);
    expect(await tablesMentioning(bystander.marker)).toEqual(expect.arrayContaining(["media_jobs", "media_reviews"]));
    const theirs = await get(bystander.session, `/api/enrollments/${bystander.enrollment}/media?episodeId=min`);
    expect(theirs.json().media).toEqual([expect.objectContaining({ id: b.attachmentId, title: `${bystander.marker} title bystander` })]);
    const clip = await get(bystander.session, `/api/enrollments/${bystander.enrollment}/media/${b.attachmentId}/asset`);
    expect(clip.statusCode).toBe(200);
    expect(createHash("sha256").update(clip.rawPayload).digest("hex")).toBe(b.sha);
    expect((await get(bystander.session, `/api/enrollments/${bystander.enrollment}/media/${b.attachmentId}/captions.vtt`)).body).toBe(captions(bystander.marker));

    // Staff screens and every later export show placeholders and the kept accounting only.
    const detail = await job(a.shown.id);
    expect(detail).toMatchObject({ state: "expired", title: ERASED_MEDIA_TEXT, objective: ERASED_MEDIA_TEXT, script: ERASED_MEDIA_TEXT, asset: null,
      review: { decision: "approved", assetSha256: a.shown.sha }, learnerVisible: false });
    expect((await get(owner, `/api/admin/media-jobs/${a.shown.id}/asset`)).statusCode).toBe(404);
    const listed = await get(owner, `/api/admin/releases/${releaseId}/media-jobs`);
    expect(listed.body).not.toContain(erased.marker);
    expect(listed.body).toContain(bystander.marker);
    for (const s of [erased.session, owner]) {
      const after = await exported(s, erased.enrollment);
      expect(after.text).not.toContain(erased.marker);
      expect(after.doc.media.items).toHaveLength(5);
      expect(after.doc.media.items.find((m: { id: string }) => m.id === a.shown.id)).toMatchObject({ title: ERASED_MEDIA_TEXT, asset_sha256: null,
        review_decision: "approved", review_rationale: ERASED_MEDIA_TEXT, attachment_revoke_reason: "Learner data erased" });
    }
    expect(await tablesMentioning(erased.marker)).toEqual([]);
    expect((await get(erased.session, `/api/enrollments/${erased.enrollment}/media?episodeId=min`)).statusCode).toBe(404);

    // Idempotent: a repeated request replays, and running the redaction again changes nothing.
    const settled = await everything(erased.enrollment);
    expect(await erase(erased)).toMatchObject({ replayed: true, counts: result.counts });
    const again = await transaction(db, (client) => eraseEnrollmentMedia(client, erased.enrollment));
    expect(again).toEqual({ mediaJobText: 0, mediaReviews: 0, mediaRevokeReasons: 0, mediaAssets: 0 });
    expect(await everything(erased.enrollment)).toEqual(settled);
    for (const t of [2_000, 20_000]) await worker.run({ now: later(t) });
    expect(await everything(erased.enrollment)).toEqual(settled);
    expect(await everything(bystander.enrollment)).toEqual(bystanderBefore);
  }, 60_000);

  it("refuses new media for an erased learner before writing anything", async () => {
    const l = await learner("C");
    await erase(l);
    const r = await post(owner, `/api/admin/enrollments/${l.enrollment}/media-jobs`, { episodeId: "min", title: `${l.marker} late`,
      objective: `A late request naming ${l.marker} after erasure.`, script: `A late script naming ${l.marker} after the learner's erasure.`, idempotencyKey: key() });
    expect(r.statusCode).toBe(410);
    expect(r.json().error).toBe("ENROLLMENT_ERASED");
    expect(Number((await db.query("SELECT count(*) FROM media_jobs WHERE enrollment_id=$1", [l.enrollment])).rows[0].count)).toBe(0);
    expect(await tablesMentioning(l.marker)).toEqual([]);
  });

  it("a submission in flight at erasure stores its late provider handle without the adapter state", async () => {
    const l = await learner("D");
    const id = await requestJob(l, "in-flight");
    let open: () => void = () => undefined;
    gate = new Promise((resolve) => { open = resolve; });
    const before = submitting;
    video.submitOutcomes.push("accept");
    const running = worker.run({ now: later(0) });
    try {
      for (let i = 0; i < 500 && submitting === before; i++) await new Promise((resolve) => setTimeout(resolve, 10));
      expect((await job(id)).state).toBe("submitted");
      await erase(l);
      expect(await tablesMentioning(l.marker)).toEqual([]);
    } finally { gate = null; open(); }
    await running;
    // The provider's answer arrived after erasure: the handle is kept for audit and reconciliation,
    // its echoed prompt is not.
    const row = (await db.query("SELECT state,provider_operation AS op,provider_operation_id AS handle,remote_may_continue FROM media_jobs WHERE id=$1", [id])).rows[0];
    expect(row).toMatchObject({ state: "cancelled", remote_may_continue: true, handle: expect.stringMatching(/^scripted\/operations\//),
      op: { providerId: "scripted", providerState: { erased: true } } });
    expect(await tablesMentioning(l.marker)).toEqual([]);
  });
});
