import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "../src/database.js";
import { createServer } from "../src/server.js";
import { issueLoginCode } from "../src/auth.js";
import { migrate } from "../src/migrations.js";
import { digestJson } from "../src/repository.js";
import { ERASED_DIGEST } from "../src/erased-digests.js";
import { createTestDatabase, type TestDatabase } from "./test-database.js";
import { fixture } from "./fixture.js";

// Erasure redacts learner content but used to keep plain SHA-256 digests of the requests that
// carried it. For a small answer domain those digests give the answer back: hash every candidate
// and compare. These tests run that attack before and after erasure.

const origin = "http://localhost:4386",
  schema = "erased_digests_" + randomUUID().replaceAll("-", "");
const migrations = fileURLToPath(new URL("../migrations", import.meta.url));
let db: Database, app: Awaited<ReturnType<typeof createServer>>, testDatabase: TestDatabase | undefined;
let workspace: string, catalog: string, owner: Session, learner: Session, enrollment: string;
interface Session { userId: string; cookie: string; csrf: string }

async function session(role: string): Promise<Session> {
  const id = randomUUID();
  await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [id, "digests:" + id, role + " person"]);
  await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspace, id, role]);
  const r = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, id) } });
  return { userId: id, cookie: r.cookies.map((c) => c.name + "=" + c.value).join("; "), csrf: r.json().csrfToken };
}
function call(who: Session, method: "GET" | "POST" | "PATCH", url: string, payload?: unknown, headers: Record<string, string> = {}) {
  return app.inject({ method, url, headers: { origin, cookie: who.cookie, "x-csrf-token": who.csrf, ...headers }, ...(payload === undefined ? {} : { payload: payload as object }) });
}
const revision = async () => (await call(learner, "GET", "/api/enrollments/" + enrollment)).json().revision as number;
async function command(action: string, body: Record<string, unknown>, idempotencyKey: string = randomUUID()) {
  const r = await call(learner, "POST", `/api/enrollments/${enrollment}/${action}`, { expectedRevision: await revision(), idempotencyKey, ...body });
  expect(r.statusCode, action + " " + r.body).toBe(200);
  return r.json();
}
const erase = () => call(learner, "POST", `/api/enrollments/${enrollment}/erase`, {
  confirmation: `ERASE ${enrollment.slice(0, 8)}`, reason: "Learner asked for their course data to be removed.",
});
/** The receipt digest of an `answer` command, as repository.ts computes it. */
const answerDigest = (challengeId: string, answer: unknown) => digestJson({ actorId: learner.userId, operation: "answer", challengeId, answer });
/** Tables (as `table:rows`) whose rows contain `needle` anywhere, in any column. */
async function tablesContaining(needle: string) {
  const tables = (await db.query("SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() AND table_type='BASE TABLE'")).rows.map((r) => r.table_name as string);
  const hits: string[] = [];
  for (const table of tables) {
    const n = (await db.query(`SELECT count(*)::int AS n FROM "${table}" t WHERE t::text LIKE $1`, ["%" + needle + "%"])).rows[0].n;
    if (n) hits.push(`${table}:${n}`);
  }
  return hits;
}
async function answered(answer: number) {
  await command("read", { episodeId: "min", blockId: "min-text" });
  const challenge = await command("challenges", { episodeId: "min", assessmentId: "min-b", mode: "independent" });
  const key = randomUUID();
  await command("answers", { challengeId: challenge.challengeId, answer }, key);
  return { challengeId: challenge.challengeId as string, key };
}

beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false });
});
beforeEach(async () => {
  workspace = randomUUID();
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspace, "digests-" + workspace, "Digests"]);
  owner = await session("owner");
  learner = await session("learner");
  const release = (await call(owner, "POST", `/api/workspaces/${workspace}/releases`, fixture())).json().id;
  await call(owner, "POST", `/api/releases/${release}/publish`);
  enrollment = (await call(learner, "POST", "/api/enrollments", { releaseId: release })).json().id;
  catalog = (await call(owner, "GET", "/api/admin/session")).json().courses.find((c: { workspaceId?: string }) => !c.workspaceId || c.workspaceId === workspace).id;
});
afterAll(async () => {
  await app?.close();
  await db?.end();
  await testDatabase?.drop();
});

describe("erasure leaves no digest that gives an answer back", () => {
  it("before erasure a 0-10 answer is recovered from its receipt digest; after erasure no candidate matches anywhere", async () => {
    const { challengeId } = await answered(4);
    const candidates = Array.from({ length: 11 }, (_, n) => ({ n, digest: answerDigest(challengeId, n) }));
    const stored = (await db.query("SELECT request_digest FROM command_receipts WHERE enrollment_id=$1", [enrollment])).rows.map((r) => r.request_digest as string);
    // The attack, against the record as it stood: exactly the submitted answer matches.
    expect(candidates.filter((c) => stored.includes(c.digest)).map((c) => c.n)).toEqual([4]);

    const erased = await erase();
    expect(erased.statusCode, erased.body).toBe(200);
    expect(erased.json().counts.commandReceiptDigests).toBe(stored.length);
    const after = (await db.query("SELECT request_digest FROM command_receipts WHERE enrollment_id=$1", [enrollment])).rows;
    expect(after).toHaveLength(stored.length);
    expect(after.every((r) => r.request_digest === ERASED_DIGEST)).toBe(true);
    // Not in the receipts, and not anywhere else in the database either.
    for (const { digest } of candidates) expect(await tablesContaining(digest)).toEqual([]);
    // Every digest the enrollment's commands produced is gone, not only the answer's.
    for (const digest of stored) expect(await tablesContaining(digest)).toEqual([]);
  });

  it("a staff edit of the learner's profile: its course-level receipt names the enrollment and is tombstoned too", async () => {
    const snapshot = (await call(owner, "GET", `/api/admin/courses/${catalog}`)).json();
    const enrollmentRevision = snapshot.enrollments.find((e: { id: string }) => e.id === enrollment).revision;
    const paces = ["gentle", "steady", "focused"] as const, profile = { displayName: "Digest learner", goal: "", pace: "focused" as const };
    const patched = await call(owner, "PATCH", `/api/admin/courses/${catalog}/enrollments/${enrollment}/profile`, { profile, enrollmentRevision },
      { "if-match": String(snapshot.revision), "idempotency-key": randomUUID() });
    expect(patched.statusCode, patched.body).toBe(200);
    const receipt = async () => (await db.query("SELECT request_digest,enrollment_id FROM admin_command_receipts WHERE catalog_id=$1 AND enrollment_id IS NOT NULL", [catalog])).rows;
    const guess = (pace: string) => digestJson({ actorId: owner.userId, operation: "admin.profile.updated", semantic: { enrollmentId: enrollment, profile: { ...profile, pace }, enrollmentRevision } });
    const [stored] = await receipt();
    expect(stored).toEqual({ request_digest: guess("focused"), enrollment_id: enrollment });
    // Three paces: hashing each gives the stored one back.
    expect(paces.filter((pace) => guess(pace) === stored.request_digest)).toEqual(["focused"]);

    expect((await erase()).json().counts.adminReceiptDigests).toBe(1);
    expect(await receipt()).toEqual([{ request_digest: ERASED_DIGEST, enrollment_id: enrollment }]);
    for (const pace of paces) expect(await tablesContaining(guess(pace))).toEqual([]);
  });

  it("a staff-created enrollment records itself on the creating receipt, whose digest covers the profile", async () => {
    const other = await session("learner");
    const snapshot = (await call(owner, "GET", `/api/admin/courses/${catalog}`)).json();
    const created = await call(owner, "POST", `/api/admin/courses/${catalog}/enrollments`,
      { learnerRef: other.userId, profile: { displayName: "Staff enrolled", goal: "", pace: "gentle" } },
      { "if-match": String(snapshot.revision), "idempotency-key": randomUUID() });
    expect(created.statusCode, created.body).toBe(200);
    const id = (await db.query("SELECT id FROM enrollments WHERE user_id=$1", [other.userId])).rows[0].id;
    expect((await db.query("SELECT count(*)::int AS n FROM admin_command_receipts WHERE enrollment_id=$1", [id])).rows[0].n).toBe(1);
  });
});

describe("every tombstoned digest", () => {
  it("is overwritten for the erased enrollment only, in every table erase_enrollment_digests covers", async () => {
    // Rows as the features write them, inserted directly with foreign keys off for this
    // transaction only, so one test reaches every table without running every feature. The
    // HTTP tests above show eraseWithin calls the same function.
    const target = randomUUID(), other = randomUUID(), job = randomUUID(), mediaJob = randomUUID(), attempt = randomUUID(), proposal = randomUUID();
    const leak = (label: string) => digestJson({ label, answer: 4 });
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      const rows: [string, unknown[]][] = [
        ["INSERT INTO command_receipts(enrollment_id,idempotency_key,request_digest,response) VALUES($1,'k-0001',$2,'{}')", [target, leak("command")]],
        ["INSERT INTO admin_command_receipts(catalog_id,idempotency_key,request_digest,actor_id,response,enrollment_id) VALUES($1,'k-0001',$2,$3,'{}',$4)", [catalog, leak("admin"), owner.userId, target]],
        ["INSERT INTO gate_review_requests(id,enrollment_id,workspace_id,gate_id,decision_id,reason,state,reviewer_id,reviewer_note,decided_at,request_digest) VALUES($1,$2,$3,'g',$4,'A reason for review.','upheld',$5,'ok',now(),$6)",
          [randomUUID(), target, workspace, randomUUID(), owner.userId, leak("gate")]],
        ["INSERT INTO rubric_reviews(id,attempt_id,enrollment_id,reviewer_id,decision,criteria,rubric_digest) VALUES($1,$2,$3,$4,'met',$5,$6)",
          [randomUUID(), attempt, target, owner.userId, JSON.stringify({ findings: [], requestDigest: leak("review") }), "b".repeat(64)]],
        ["INSERT INTO rubric_appeals(id,attempt_id,enrollment_id,reason,state,reviewer_id,decision,decided_at,findings) VALUES($1,$2,$3,'A reason for appeal.','upheld',$4,'met',now(),$5)",
          [randomUUID(), attempt, target, owner.userId, JSON.stringify({ findings: [], requestDigest: leak("appeal") })]],
        ["INSERT INTO rubric_assist_requests(id,attempt_id,enrollment_id,workspace_id,requested_by,consent_revision,rubric_digest,response_digest) VALUES($1,$2,$3,$4,$5,1,$6,$7)",
          [randomUUID(), attempt, target, workspace, owner.userId, "b".repeat(64), leak("assist")]],
        ["INSERT INTO learner_model_sources(proposal_id,enrollment_id,workspace_id,event_id,event_sequence,event_type,event_digest) VALUES($1,$2,$3,$4,1,'assessment.submitted',$5)",
          [proposal, target, workspace, randomUUID(), leak("source")]],
        ["INSERT INTO supervisor_model_effects(job_id,enrollment_id,workspace_id,proposal_id,permission_revision,selection_digest) VALUES($1,$2,$3,$4,1,$5)",
          [job, target, workspace, proposal, leak("selection")]],
        ["INSERT INTO supervisor_tool_calls(id,job_id,enrollment_id,workspace_id,operation_id,step,tool,request_digest,arguments,outcome) VALUES($1,$2,$3,$4,$5,0,'suggest_model',$6,'{}','{}')",
          [randomUUID(), job, target, workspace, "op-" + job, leak("tool")]],
        // Another learner's tool call and media receipt: erasure must not touch them.
        ["INSERT INTO supervisor_tool_calls(id,job_id,enrollment_id,workspace_id,operation_id,step,tool,request_digest,arguments,outcome) VALUES($1,$2,$3,$4,$5,0,'suggest_model',$6,'{}','{}')",
          [randomUUID(), randomUUID(), other, workspace, "op-" + other, leak("other-tool")]],
        ["INSERT INTO media_command_receipts(workspace_id,idempotency_key,request_digest,actor_id,response) VALUES($1,$2,$3,$4,$5)",
          [workspace, "media-cmd-" + other, leak("other-media"), owner.userId, JSON.stringify({ jobId: randomUUID() })]],
        ["INSERT INTO media_jobs(id,workspace_id,enrollment_id,course_release_id,episode_id,kind,title,objective,script,provider_revision,model_id,settings,state,idempotency_key,request_digest,deadline_at,requested_by) VALUES($1,$2,$3,$4,'min','generated_short_video','A title','An objective here','A script that is long enough.',1,'m','{}','cancelled',$5,$6,now(),$7)",
          [mediaJob, workspace, target, randomUUID(), "media-" + mediaJob, leak("media"), owner.userId]],
        ["INSERT INTO media_command_receipts(workspace_id,idempotency_key,request_digest,actor_id,response) VALUES($1,$2,$3,$4,$5)",
          [workspace, "media-cmd-" + mediaJob, leak("media-command"), owner.userId, JSON.stringify({ jobId: mediaJob, state: "cancelled" })]],
      ];
      for (const [sql, values] of rows) await client.query(sql, values);

      const counts = (await client.query("SELECT erase_enrollment_digests($1) AS c", [target])).rows[0].c;
      expect(counts).toEqual({
        commandReceiptDigests: 1, adminReceiptDigests: 1, mediaReceiptDigests: 1, mediaRequestDigests: 1, writtenAnswerReviewDigests: 1,
        writtenAnswerAppealDigests: 1, reviewAssistAnswerDigests: 1, gateReviewDigests: 1, learnerModelSourceDigests: 1,
        supervisorModelSelectionDigests: 1, supervisorToolCallDigests: 1,
      });
      const value = async (sql: string) => (await client.query(sql, [target])).rows.map((r) => r.v);
      for (const sql of [
        "SELECT request_digest AS v FROM command_receipts WHERE enrollment_id=$1",
        "SELECT request_digest AS v FROM admin_command_receipts WHERE enrollment_id=$1",
        "SELECT request_digest AS v FROM gate_review_requests WHERE enrollment_id=$1",
        "SELECT criteria->>'requestDigest' AS v FROM rubric_reviews WHERE enrollment_id=$1",
        "SELECT findings->>'requestDigest' AS v FROM rubric_appeals WHERE enrollment_id=$1",
        "SELECT response_digest AS v FROM rubric_assist_requests WHERE enrollment_id=$1",
        "SELECT event_digest AS v FROM learner_model_sources WHERE enrollment_id=$1",
        "SELECT selection_digest AS v FROM supervisor_model_effects WHERE enrollment_id=$1",
        "SELECT request_digest AS v FROM supervisor_tool_calls WHERE enrollment_id=$1",
        "SELECT request_digest AS v FROM media_jobs WHERE enrollment_id=$1",
        "SELECT r.request_digest AS v FROM media_command_receipts r JOIN media_jobs j ON r.response->>'jobId'=j.id::text WHERE j.enrollment_id=$1",
      ]) expect(await value(sql), sql).toEqual([ERASED_DIGEST]);
      // The rest of each row is kept, and so are other learners' digests.
      expect((await client.query("SELECT criteria->'findings' AS f FROM rubric_reviews WHERE enrollment_id=$1", [target])).rows).toEqual([{ f: [] }]);
      expect((await client.query("SELECT request_digest FROM supervisor_tool_calls WHERE enrollment_id=$1", [other])).rows).toEqual([{ request_digest: leak("other-tool") }]);
      expect((await client.query("SELECT request_digest FROM media_command_receipts WHERE idempotency_key=$1", ["media-cmd-" + other])).rows).toEqual([{ request_digest: leak("other-media") }]);
      // Running it again changes nothing.
      expect(Object.values((await client.query("SELECT erase_enrollment_digests($1) AS c", [target])).rows[0].c).every((n) => n === 0)).toBe(true);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});

describe("idempotent replay after erasure", () => {
  it("the same command again, or the same key with another answer, is refused 410 and changes nothing", async () => {
    const { challengeId, key } = await answered(7);
    const expectedRevision = await revision();
    expect((await erase()).statusCode).toBe(200);
    const before = (await db.query("SELECT (SELECT count(*)::int FROM attempts WHERE enrollment_id=$1) AS attempts,(SELECT count(*)::int FROM command_receipts WHERE enrollment_id=$1) AS receipts,(SELECT count(*)::int FROM learning_events WHERE enrollment_id=$1) AS events", [enrollment])).rows[0];
    for (const answer of [7, 3]) {
      const replay = await call(learner, "POST", `/api/enrollments/${enrollment}/answers`, { expectedRevision, idempotencyKey: key, challengeId, answer });
      expect(replay.statusCode, replay.body).toBe(410);
      // The same refusal either way: a replay cannot tell which answer was stored.
      expect(replay.json().error).toBe("ENROLLMENT_ERASED");
    }
    const after = (await db.query("SELECT (SELECT count(*)::int FROM attempts WHERE enrollment_id=$1) AS attempts,(SELECT count(*)::int FROM command_receipts WHERE enrollment_id=$1) AS receipts,(SELECT count(*)::int FROM learning_events WHERE enrollment_id=$1) AS events", [enrollment])).rows[0];
    expect(after).toEqual(before);
    expect((await db.query("SELECT request_digest FROM command_receipts WHERE enrollment_id=$1 AND idempotency_key=$2", [enrollment, key])).rows).toEqual([{ request_digest: ERASED_DIGEST }]);
  });

  it("a tombstoned receipt is never re-applied, even where the erased-enrollment guard is not in the way", async () => {
    // Defence in depth: the receipt check itself refuses a tombstone instead of treating it as a
    // mismatch (409) or as missing (which would run the command again under the old key).
    const { challengeId, key } = await answered(2);
    await db.query("UPDATE command_receipts SET request_digest=$3 WHERE enrollment_id=$1 AND idempotency_key=$2", [enrollment, key, ERASED_DIGEST]);
    const attempts = async () => (await db.query("SELECT count(*)::int AS n FROM attempts WHERE enrollment_id=$1", [enrollment])).rows[0].n;
    const count = await attempts();
    const replay = await call(learner, "POST", `/api/enrollments/${enrollment}/answers`, { expectedRevision: await revision(), idempotencyKey: key, challengeId, answer: 2 });
    expect(replay.statusCode, replay.body).toBe(410);
    expect(replay.json().error).toBe("ENROLLMENT_ERASED");
    expect(await attempts()).toBe(count);
    // An ordinary mismatch on a live receipt is still a conflict.
    const other = await answered(5);
    const conflict = await call(learner, "POST", `/api/enrollments/${enrollment}/answers`, { expectedRevision: await revision(), idempotencyKey: other.key, challengeId: other.challengeId, answer: 6 });
    expect(conflict.json().error).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("an erasure replay does not tombstone again or change its counts", async () => {
    await answered(1);
    const first = (await erase()).json();
    const again = (await erase()).json();
    expect(again).toMatchObject({ replayed: true, counts: first.counts });
  });
});

describe("digest coverage", () => {
  // Every column that holds a digest or hash on a table about one enrollment, or on a receipt
  // table erasure reaches. A new one fails this test until it is classified: tombstoned by
  // erase_enrollment_digests (migration 065), or kept with the reason it holds no learner content.
  const tombstoned = new Set([
    "admin_command_receipts.request_digest", "command_receipts.request_digest", "companion_context_capsules.digest",
    "gate_review_requests.request_digest", "learner_model_sources.event_digest", "media_command_receipts.request_digest",
    "media_jobs.request_digest", "rubric_assist_requests.response_digest", "supervisor_model_effects.selection_digest",
    "supervisor_tool_calls.request_digest",
    // Nulled with the request itself by data-lifecycle.ts (061).
    "research_requests.request_digest",
  ]);
  const kept: Record<string, string> = {
    "assessment_challenges.course_digest": "course version", "attempts.course_digest": "course version",
    "diagnostic_probe_runs.course_digest": "course version", "episode_progress.exception_course_digest": "course version",
    "gate_decisions.course_digest": "course version", "gate_review_requests.exception_course_digest": "course version",
    "learner_model_proposals.course_digest": "course version", "learning_events.course_digest": "course version",
    "teaching_hypotheses.course_digest": "course version", "rubric_assist_requests.rubric_digest": "course rubric",
    "rubric_reviews.rubric_digest": "course rubric", "extension_grants.terms_digest": "published offer terms",
    "research_requests.query_digest": "approved public topic from the course bundle",
    "research_resource_choices.candidate_digest": "staff-reviewed public resource; the choice row itself is kept in clear",
    "agent_tool_grants.token_hash": "SHA-256 of a random 256-bit bearer token, not learner content; erasure revokes the grant",
    "provider_dispatches.request_digest": "ids, revisions, allowance and course digest; context is fetched by reference",
    "gate_decisions.inputs_digest": "host policy result over evidence; the decision row itself is kept in clear",
    "data_exports.digest": "whole export file (ids, timestamps, every record); append-only audit",
    "admin_policy_previews.preview_digest": "policy computation previewed by staff",
    "adaptation_applications.plan_digest": "generated personal teaching provenance chain",
    "adaptation_artifacts.artifact_digest": "generated personal teaching provenance chain",
    "adaptation_proofs.adapter_digest": "verifier build identity",
    "adaptation_proposals.base_digest": "generated personal teaching provenance chain",
    "adaptation_proposals.proposal_digest": "generated personal teaching provenance chain",
    "adaptation_reverts.plan_digest": "generated personal teaching provenance chain",
    "adaptation_reverts.rollback_target_digest": "generated personal teaching provenance chain",
    "adaptation_states.base_digest": "generated personal teaching provenance chain",
    "adaptation_states.plan_digest": "generated personal teaching provenance chain",
    "assessment_challenges.adaptation_artifact_digest": "generated personal teaching provenance chain",
    "research_candidates.digest": "generated artifact", "rubric_suggestions.digest": "generated artifact",
    "supervisor_artifacts.digest": "generated artifact",
  };
  it("every digest column over enrollment data is either tombstoned on erasure or kept for a stated reason", async () => {
    const columns = (await db.query(`SELECT c.table_name||'.'||c.column_name AS name FROM information_schema.columns c
      WHERE c.table_schema=current_schema() AND c.column_name ~ '(digest|hash)'
        AND (c.table_name IN ('admin_command_receipts','media_command_receipts')
          OR EXISTS (SELECT 1 FROM information_schema.columns e WHERE e.table_schema=c.table_schema AND e.table_name=c.table_name AND e.column_name='enrollment_id'))
      ORDER BY 1`)).rows.map((r) => r.name as string);
    expect(columns.filter((name) => !tombstoned.has(name) && !(name in kept))).toEqual([]);
    for (const name of tombstoned) expect(columns).toContain(name);
    expect(Object.keys(kept).filter((name) => tombstoned.has(name))).toEqual([]);
  });
});

describe("migration 065 for enrollments erased before it", () => {
  it("tombstones their stored digests, links earlier admin receipts only when unambiguous, and leaves live enrollments alone", async () => {
    const before = await mkdtemp(join(tmpdir(), "course-core-064-"));
    const old = await createTestDatabase(schema + "_m", { migrated: false });
    const pool = createDatabase(old.url);
    try {
      for (const name of (await readdir(migrations)).filter((name) => name.endsWith(".sql") && name < "065")) await copyFile(join(migrations, name), join(before, name));
      await migrate(pool, before);
      const ws = randomUUID(), learnerId = randomUUID(), otherId = randomUUID(), staffId = randomUUID(), release = randomUUID(), cat = randomUUID();
      const [gone, live] = [randomUUID(), randomUUID()];
      await pool.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,'Old')", [ws, "old-" + ws]);
      await pool.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,'old:l','L'),($2,'old:o','O'),($3,'old:s','S')", [learnerId, otherId, staffId]);
      await pool.query("INSERT INTO course_releases(id,workspace_id,course_key,version,digest,server_bundle,learner_bundle,status,created_by) VALUES($1,$2,'k','1',$3,'{}','{}','published',$4)",
        [release, ws, "a".repeat(64), staffId]);
      await pool.query("INSERT INTO admin_course_catalog(id,workspace_id,course_key,title) VALUES($1,$2,'k','Old course')", [cat, ws]);
      for (const [id, user, status] of [[gone, learnerId, "erased"], [live, otherId, "active"]])
        await pool.query("INSERT INTO enrollments(id,workspace_id,course_release_id,user_id,status,policy) VALUES($1,$2,$3,$4,$5,'{}')", [id, ws, release, user, status]);
      const plain = (answer: number) => digestJson({ actorId: learnerId, operation: "answer", challengeId: "c", answer });
      for (const id of [gone, live])
        await pool.query("INSERT INTO command_receipts(enrollment_id,idempotency_key,request_digest,response) VALUES($1,'k-1',$2,'{}')", [id, plain(4)]);
      // Two earlier staff commands: one whose transaction touched only the erased enrollment, one
      // whose transaction (same actor, same timestamp) touched both, which stays unlinked.
      const staffCommand = async (key: string, enrollments: string[]) => {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const event = (type: string, idempotency: string, enrollmentId: string | null) => client.query(
            "INSERT INTO learning_events(id,workspace_id,enrollment_id,actor_id,actor_kind,event_type,payload,correlation_id,idempotency_key) VALUES($1,$2,$3,$4,'staff',$5,'{}',$6,$7)",
            [randomUUID(), ws, enrollmentId, staffId, type, randomUUID(), idempotency]);
          await event("admin.profile.updated", `admin:${cat}:${key}`, null);
          for (const id of enrollments) await event("profile.updated", "admin-profile:" + randomUUID(), id);
          await client.query("INSERT INTO admin_command_receipts(catalog_id,idempotency_key,request_digest,actor_id,response) VALUES($1,$2,$3,$4,'{}')", [cat, key, plain(9), staffId]);
          await client.query("COMMIT");
        } finally { client.release(); }
      };
      await staffCommand("only-gone", [gone]);
      await staffCommand("both", [gone, live]);

      expect(await migrate(pool, migrations)).toContain("065_erased_request_digests.sql");
      const receipts = (await pool.query("SELECT enrollment_id,request_digest FROM command_receipts ORDER BY enrollment_id=$1 DESC", [gone])).rows;
      expect(receipts).toEqual([{ enrollment_id: gone, request_digest: ERASED_DIGEST }, { enrollment_id: live, request_digest: plain(4) }]);
      const admin = Object.fromEntries((await pool.query("SELECT idempotency_key,enrollment_id,request_digest FROM admin_command_receipts")).rows.map((r) => [r.idempotency_key, r]));
      expect(admin["only-gone"]).toMatchObject({ enrollment_id: gone, request_digest: ERASED_DIGEST });
      expect(admin["both"]).toMatchObject({ enrollment_id: null, request_digest: plain(9) });
    } finally {
      await pool.end();
      await old.drop();
      await rm(before, { recursive: true, force: true });
    }
  });
});
