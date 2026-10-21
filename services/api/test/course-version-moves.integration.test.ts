import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CourseManifest } from "@course-core/sdk";
import { createDatabase, type Database } from "../src/database.js";
import { createTestDatabase, type TestDatabase } from "./test-database.js";
import { createServer } from "../src/server.js";
import { issueLoginCode } from "../src/auth.js";
import { runWaitingMoves } from "../src/course-version-moves.js";
import { fixture } from "./fixture.js";

// Real HTTP and PostgreSQL 17: staff move enrolled learners to a newer version of their course
// (K13). Preview first; evidence stays with the version it was earned on; unsafe moves are refused
// with a code; learners mid-question wait for a safe boundary; moves are audited and undone only
// while the learner has done nothing on the new version.
const origin = "http://localhost:4397",
  schema = "version_moves_" + randomUUID().replaceAll("-", "");
let db: Database, app: Awaited<ReturnType<typeof createServer>>, testDatabase: TestDatabase | undefined;
let workspace: string, v1: string, v2: string, v3draft: string, catalog: string;
interface Session { userId: string; cookie: string; csrf: string }
let owner: Session, instructor: Session;

async function session(role: string, name = role + " person"): Promise<Session> {
  const id = randomUUID();
  await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [id, "moves:" + id, name]);
  await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspace, id, role]);
  const r = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, id) } });
  expect(r.statusCode, r.body).toBe(200);
  return { userId: id, cookie: r.cookies.map((c) => c.name + "=" + c.value).join("; "), csrf: r.json().csrfToken };
}
const call = (who: Session, method: "GET" | "POST", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { origin, cookie: who.cookie, "x-csrf-token": who.csrf }, ...(payload === undefined ? {} : { payload: payload as object }) });
async function enroll(who: Session, releaseId = v1) {
  const r = await call(who, "POST", "/api/enrollments", { releaseId });
  expect(r.statusCode, r.body).toBe(200);
  return r.json().id as string;
}
async function command(who: Session, id: string, action: string, data: object) {
  const snapshot = await call(who, "GET", `/api/enrollments/${id}`);
  expect(snapshot.statusCode, snapshot.body).toBe(200);
  return call(who, "POST", `/api/enrollments/${id}/${action}`, { expectedRevision: snapshot.json().revision, idempotencyKey: randomUUID(), ...data });
}
async function ask(who: Session, id: string, assessmentId: string) {
  const issued = await command(who, id, "challenges", { episodeId: "min", assessmentId, mode: "independent" });
  expect(issued.statusCode, issued.body).toBe(200);
  return issued.json().challengeId as string;
}
async function answer(who: Session, id: string, assessmentId: string, value: unknown) {
  const r = await command(who, id, "answers", { challengeId: await ask(who, id, assessmentId), answer: value });
  expect(r.statusCode, r.body).toBe(200);
}
/** A learner who passed the first checkpoint (on v1) and completed its lesson. */
async function passedFirstLesson(name: string) {
  const who = await session("learner", name), id = await enroll(who);
  await answer(who, id, "min-a", "two");
  await answer(who, id, "min-b", 4);
  expect((await command(who, id, "read", { episodeId: "min", blockId: "min-text" })).statusCode).toBe(200);
  const done = await command(who, id, "complete", { episodeId: "min" });
  expect(done.statusCode, done.body).toBe(200);
  return { who, id };
}
const base = () => `/api/admin/courses/${catalog}/version-moves`;
const preview = (who: Session, body: object) => call(who, "POST", `${base()}/preview`, body);
const confirm = (who: Session, moveId: string, body: object) => call(who, "POST", `${base()}/${moveId}/confirm`, body);
const releaseOf = async (id: string) => (await db.query("SELECT course_release_id FROM enrollments WHERE id=$1", [id])).rows[0].course_release_id as string;

/** Version 2: the second lesson's text changed and a third lesson (with its own scope) added. */
function second(): CourseManifest {
  const course = { ...fixture(), version: "2.0.0" };
  const [chapter] = course.chapters;
  chapter!.episodes = [chapter!.episodes[0]!,
    { ...chapter!.episodes[1]!, blocks: [{ id: "max-text", type: "text", markdown: "The maximum is no less than any other member, restated." }] },
    { id: "range", title: "Range", objectiveIds: ["maximum"], blocks: [{ id: "range-text", type: "text", markdown: "The range is the maximum minus the minimum." }], requirement: "optional" } as never];
  return course;
}

beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false });
  workspace = randomUUID();
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspace, "moves-" + workspace, "Moves"]);
  owner = await session("owner");
  instructor = await session("instructor");
  const imported = async (course: CourseManifest) => {
    const r = await call(owner, "POST", `/api/workspaces/${workspace}/releases`, course);
    expect(r.statusCode, r.body).toBe(200);
    return r.json().id as string;
  };
  v1 = await imported(fixture());
  expect((await call(owner, "POST", `/api/releases/${v1}/publish`)).statusCode).toBe(200);
  v2 = await imported(second());
  v3draft = await imported({ ...second(), version: "3.0.0" });
  catalog = (await db.query("SELECT id FROM admin_course_catalog WHERE workspace_id=$1 AND course_key='ordering'", [workspace])).rows[0].id;
}, 60000);
afterAll(async () => {
  await app?.close();
  await db?.end();
  await testDatabase?.drop();
});

describe("moving learners to a newer course version", () => {
  it("refuses a target that is not a newer published version, and staff without both permissions", async () => {
    const { id } = await passedFirstLesson("Refused target");
    // v2 is not published yet.
    expect((await preview(owner, { fromReleaseId: v1, toReleaseId: v2, enrollmentId: id })).json().error).toBe("MOVE_TARGET_NOT_PUBLISHED");
    expect((await call(owner, "POST", `/api/releases/${v2}/publish`)).statusCode).toBe(200);
    expect((await preview(owner, { fromReleaseId: v1, toReleaseId: v1, enrollmentId: id })).json().error).toBe("MOVE_SAME_VERSION");
    const back = await preview(owner, { fromReleaseId: v2, toReleaseId: v1 });
    expect(back.statusCode).toBe(409);
    expect(back.json()).toMatchObject({ error: "MOVE_TARGET_NOT_NEWER", details: { from: "2.0.0", to: "1.0.0" } });
    expect((await preview(owner, { fromReleaseId: v1, toReleaseId: v3draft })).json().error).toBe("MOVE_TARGET_NOT_PUBLISHED");
    expect((await preview(owner, { fromReleaseId: v1, toReleaseId: randomUUID() })).statusCode).toBe(404);
    expect((await preview(owner, { fromReleaseId: v1, toReleaseId: v2, extra: true })).statusCode).toBe(400);
    // An instructor reads the versions but may not move anyone.
    expect((await call(instructor, "GET", base())).statusCode).toBe(200);
    expect((await preview(instructor, { fromReleaseId: v1, toReleaseId: v2 })).statusCode).toBe(403);
    const view = (await call(owner, "GET", base())).json();
    expect(view.permissions.move).toBe(true);
    expect(view.versions.find((v: { releaseId: string }) => v.releaseId === v1).newer).toEqual([{ releaseId: v2, version: "2.0.0" }]);
  });

  it("previews one learner: the passed checkpoint must be passed again, evidence stays with v1, the new lesson gets a scope", async () => {
    const { who, id } = await passedFirstLesson("Maya");
    const evidenceBefore = (await db.query("SELECT a.course_digest FROM evidence e JOIN attempts a ON a.id=e.attempt_id WHERE e.enrollment_id=$1", [id])).rows;
    const r = await preview(owner, { fromReleaseId: v1, toReleaseId: v2, enrollmentId: id });
    expect(r.statusCode, r.body).toBe(200);
    const body = r.json();
    expect(body).toMatchObject({ scope: "learner", from: { version: "1.0.0" }, to: { version: "2.0.0" }, totals: { learners: 1, ready: 1, losingCredit: 1 },
      content: { lessons: { added: 1, changed: 1, removed: 0 }, newLessons: [{ id: "range", title: "Range" }] }, rules: { evidenceStaysWithVersion: true } });
    const learner = body.learners[0];
    expect(learner).toMatchObject({ enrollmentId: id, displayName: "Maya", outcome: "ready", refusal: null, wait: null, evidence: { records: 2 },
      progress: { creditedBefore: 1, creditedAfter: 0, kept: 0, checkpointsAgain: { count: 1, items: [{ id: "min", title: "Minimum" }] }, removed: { count: 0 } },
      policy: { addedScopes: ["episode:range"] } });
    // Previewing changes nothing.
    expect(await releaseOf(id)).toBe(v1);
    // Confirming needs the exact preview, a reason and, because credit is lost, an acknowledgement.
    expect((await confirm(owner, body.moveId, { previewDigest: body.previewDigest, reason: "Fixes" })).json().error).toBe("MOVE_LOST_CREDIT_UNACKNOWLEDGED");
    expect((await confirm(owner, body.moveId, { previewDigest: "0".repeat(64), reason: "Fixes", acknowledgeLostCredit: true })).json().error).toBe("STALE_PREVIEW");
    expect((await confirm(owner, body.moveId, { previewDigest: body.previewDigest, acknowledgeLostCredit: true })).statusCode).toBe(400);
    const done = await confirm(owner, body.moveId, { previewDigest: body.previewDigest, reason: "Version 2 fixes the second lesson.", acknowledgeLostCredit: true });
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json()).toMatchObject({ state: "confirmed", totals: { moved: 1, waiting: 0, refused: 0 }, learners: [{ enrollmentId: id, state: "moved", undo: { possible: true } }] });
    // Replaying the same confirmation is answered, not repeated.
    expect((await confirm(owner, body.moveId, { previewDigest: body.previewDigest, reason: "Again", acknowledgeLostCredit: true })).json().replayed).toBe(true);
    expect(await releaseOf(id)).toBe(v2);
    // Evidence and attempts were not rewritten: still bound to v1.
    expect((await db.query("SELECT a.course_digest FROM evidence e JOIN attempts a ON a.id=e.attempt_id WHERE e.enrollment_id=$1", [id])).rows).toEqual(evidenceBefore);
    // The learner now sees v2: the first lesson is open again (its checkpoint counts v2 evidence only).
    const state = (await call(who, "GET", `/api/enrollments/${id}`)).json();
    expect(state.lessons.map((l: { id: string; status: string }) => [l.id, l.status])).toEqual([["min", "available"], ["max", "locked"], ["range", "locked"]]);
    // Existing scopes kept as they were; the new lesson got its own.
    const policy = (await db.query("SELECT snapshot FROM policy_states WHERE enrollment_id=$1", [id])).rows[0].snapshot;
    expect(policy.scopes.map((s: { scopeId: string }) => s.scopeId)).toContain("episode:range");
    expect(policy.migrations.at(-1).migrationId).toBe(`version-move:${body.moveId}:${id}`);
    // Audited: on the learner's record and in the workspace audit log.
    const events = (await db.query("SELECT event_type,payload FROM learning_events WHERE workspace_id=$1 AND event_type LIKE 'course_version.%' AND payload->>'moveId'=$2", [workspace, body.moveId])).rows;
    expect(events.map((e) => e.event_type).sort()).toEqual(["course_version.move_confirmed", "course_version.moved"]);
    const audit = await call(owner, "GET", `/api/admin/workspaces/${workspace}/audit?limit=50`);
    if (audit.statusCode === 200) expect(audit.body).toContain("course_version.move_confirmed");

    // Undo is possible while the learner has done nothing on v2.
    const undone = await call(owner, "POST", `${base()}/${body.moveId}/undo`, { reason: "Wrong learner." });
    expect(undone.statusCode, undone.body).toBe(200);
    expect(undone.json()).toMatchObject({ undone: [id], refused: [], move: { totals: { moved: 0, undone: 1 } } });
    expect(await releaseOf(id)).toBe(v1);
    expect((await call(who, "GET", `/api/enrollments/${id}`)).json().lessons[0].status).toBe("completed");
  });

  it("refuses undo once the learner has continued on the new version", async () => {
    const { who, id } = await passedFirstLesson("Continues");
    const body = (await preview(owner, { fromReleaseId: v1, toReleaseId: v2, enrollmentId: id })).json();
    expect((await confirm(owner, body.moveId, { previewDigest: body.previewDigest, reason: "Move", acknowledgeLostCredit: true })).statusCode).toBe(200);
    expect((await command(who, id, "read", { episodeId: "min", blockId: "min-text" })).statusCode).toBe(200);
    const detail = (await call(owner, "GET", `${base()}/${body.moveId}`)).json();
    expect(detail.learners[0].undo).toEqual({ possible: false, code: "UNDO_LEARNER_CONTINUED" });
    const undo = await call(owner, "POST", `${base()}/${body.moveId}/undo`, { reason: "Try" });
    expect(undo.json()).toMatchObject({ undone: [], refused: [{ enrollmentId: id, code: "UNDO_LEARNER_CONTINUED" }] });
    expect(await releaseOf(id)).toBe(v2);
  });

  it("moves a cohort: refuses unsafe learners with a reason and waits for a learner mid-question", async () => {
    // Earlier tests left learners on v1; this cohort covers everyone still active there.
    const fresh = await session("learner", "Fresh"), freshId = await enroll(fresh);
    const busy = await session("learner", "Busy"), busyId = await enroll(busy);
    const challengeId = await ask(busy, busyId, "min-a");
    const adapted = await session("learner", "Adapted"), adaptedId = await enroll(adapted);
    await db.query("INSERT INTO adaptation_states(enrollment_id,workspace_id,base_digest,ledger_revision,plan_revision,plan_digest,snapshot) VALUES($1,$2,$3,0,0,$4,'{}')",
      [adaptedId, workspace, "a".repeat(64), "b".repeat(64)]);
    const twice = await session("learner", "Twice"), twiceId = await enroll(twice);
    await enroll(twice, v2);
    const closedRow = await session("learner", "Closed"), closedId = await enroll(closedRow);
    await db.query("UPDATE enrollments SET status='closed' WHERE id=$1", [closedId]);
    const r = await preview(owner, { fromReleaseId: v1, toReleaseId: v2 });
    expect(r.statusCode, r.body).toBe(200);
    const body = r.json();
    const byId = (id: string) => body.learners.find((l: { enrollmentId: string }) => l.enrollmentId === id);
    expect(body.scope).toBe("cohort");
    expect(byId(closedId)).toBeUndefined();
    expect(byId(freshId)).toMatchObject({ outcome: "ready", progress: { creditedBefore: 0, checkpointsAgain: { count: 0 } } });
    expect(byId(busyId)).toMatchObject({ outcome: "waits", wait: "ATTEMPT_IN_PROGRESS", openWork: { questions: 1 } });
    expect(byId(adaptedId)).toMatchObject({ outcome: "refused", refusal: "MOVE_PERSONAL_CHANGES", personalChanges: 1 });
    expect(byId(twiceId)).toMatchObject({ outcome: "refused", refusal: "MOVE_ALREADY_ON_TARGET" });
    // A closed enrollment named on its own is refused with its reason.
    expect((await preview(owner, { fromReleaseId: v1, toReleaseId: v2, enrollmentId: closedId })).json().learners[0].refusal).toBe("MOVE_ENROLLMENT_NOT_ACTIVE");

    const done = await confirm(owner, body.moveId, { previewDigest: body.previewDigest, reason: "Everyone to v2", acknowledgeLostCredit: true });
    expect(done.statusCode, done.body).toBe(200);
    const entry = (id: string) => done.json().learners.find((l: { enrollmentId: string }) => l.enrollmentId === id);
    expect(entry(freshId).state).toBe("moved");
    expect(entry(busyId)).toMatchObject({ state: "waiting", code: "ATTEMPT_IN_PROGRESS" });
    expect(entry(adaptedId)).toMatchObject({ state: "refused", code: "MOVE_PERSONAL_CHANGES" });
    expect(await releaseOf(busyId)).toBe(v1);
    expect(await releaseOf(adaptedId)).toBe(v1);

    // Still mid-question: the retry leaves the move waiting.
    expect(await runWaitingMoves(db)).toMatchObject({ ran: true, moved: 0, cancelled: 0 });
    expect(await releaseOf(busyId)).toBe(v1);
    // The answer ends the attempt; the next retry moves the learner (nothing they had is lost:
    // the cost they were previewed with — no credit — is unchanged).
    const answered = await command(busy, busyId, "answers", { challengeId, answer: "two" });
    expect(answered.statusCode, answered.body).toBe(200);
    expect(await runWaitingMoves(db)).toMatchObject({ moved: 1 });
    expect(await releaseOf(busyId)).toBe(v2);
    expect((await call(owner, "GET", `${base()}/${body.moveId}`)).json().totals).toMatchObject({ moved: body.totals.ready + 1, waiting: 0, refused: 2 });
  });

  it("cancels a waiting move when its cost changed, when staff cancel it, or after seven days", async () => {
    const learner = await session("learner", "Changes"), id = await enroll(learner);
    await answer(learner, id, "min-a", "two");
    const challengeId = await ask(learner, id, "min-b");
    const body = (await preview(owner, { fromReleaseId: v1, toReleaseId: v2, enrollmentId: id })).json();
    expect(body.learners[0]).toMatchObject({ outcome: "waits", progress: { checkpointsAgain: { count: 0 } } });
    expect((await confirm(owner, body.moveId, { previewDigest: body.previewDigest, reason: "Move later" })).json().totals.waiting).toBe(1);
    // A second move of the same learner is refused while the first waits.
    expect((await preview(owner, { fromReleaseId: v1, toReleaseId: v2, enrollmentId: id })).json().learners[0].refusal).toBe("MOVE_ALREADY_WAITING");
    // Passing the checkpoint and completing the lesson changes what the move would cost.
    expect((await command(learner, id, "answers", { challengeId, answer: 4 })).statusCode).toBe(200);
    expect((await command(learner, id, "read", { episodeId: "min", blockId: "min-text" })).statusCode).toBe(200);
    expect((await command(learner, id, "complete", { episodeId: "min" })).statusCode).toBe(200);
    await runWaitingMoves(db);
    expect((await call(owner, "GET", `${base()}/${body.moveId}`)).json().learners[0]).toMatchObject({ state: "cancelled", code: "IMPACT_CHANGED" });
    expect(await releaseOf(id)).toBe(v1);

    const other = await session("learner", "Waits long"), otherId = await enroll(other);
    await ask(other, otherId, "min-a");
    const second = (await preview(owner, { fromReleaseId: v1, toReleaseId: v2, enrollmentId: otherId })).json();
    expect((await confirm(owner, second.moveId, { previewDigest: second.previewDigest, reason: "Move later" })).statusCode).toBe(200);
    await runWaitingMoves(db, { now: new Date(Date.now() + 8 * 86_400_000) });
    expect((await call(owner, "GET", `${base()}/${second.moveId}`)).json().learners[0]).toMatchObject({ state: "cancelled", code: "WAIT_EXPIRED" });

    const third = (await preview(owner, { fromReleaseId: v1, toReleaseId: v2, enrollmentId: otherId })).json();
    expect((await confirm(owner, third.moveId, { previewDigest: third.previewDigest, reason: "Move later" })).statusCode).toBe(200);
    expect((await call(instructor, "POST", `${base()}/${third.moveId}/cancel`, {})).statusCode).toBe(403);
    const cancelled = await call(owner, "POST", `${base()}/${third.moveId}/cancel`, {});
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(cancelled.json().move.learners[0]).toMatchObject({ state: "cancelled", code: "CANCELLED_BY_STAFF" });
    expect((await call(owner, "POST", `${base()}/${third.moveId}/cancel`, {})).json().error).toBe("MOVE_NOTHING_WAITING");
    expect(await releaseOf(otherId)).toBe(v1);
  });

  it("keeps moves inside their course and lists learners by version", async () => {
    const learners = (await call(instructor, "GET", `${base()}/learners?releaseId=${v1}`)).json().learners;
    expect(learners.length).toBeGreaterThan(0);
    expect(learners[0]).toEqual({ enrollmentId: expect.any(String), displayName: expect.any(String), status: expect.stringMatching(/active|paused/) });
    expect((await call(owner, "GET", `${base()}/${randomUUID()}`)).statusCode).toBe(404);
    expect((await call(owner, "GET", `${base()}/learners?releaseId=nope`)).statusCode).toBe(400);
  });
});
