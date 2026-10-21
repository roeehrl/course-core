import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "../src/database.js";
import { createTestDatabase, type TestDatabase } from "./test-database.js";
import { createServer } from "../src/server.js";
import { issueLoginCode } from "../src/auth.js";
import { DEFAULT_COURSE_POLICY_SETTINGS } from "../src/policy-adapter.js";
import { fixture } from "./fixture.js";

const origin = "http://localhost:4392",
  schema = "assessmentpolicy_" + randomUUID().replaceAll("-", "");
let db: Database, app: Awaited<ReturnType<typeof createServer>>, testDatabase: TestDatabase | undefined;
let workspace: string, owner: Session, instructor: Session, release: string, course: string;
interface Session { userId: string; cookie: string; csrf: string }
async function session(role: string): Promise<Session> {
  const id = randomUUID();
  await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [id, "attempts:" + id, role + " person"]);
  await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspace, id, role]);
  const r = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, id) } });
  return { userId: id, cookie: r.cookies.map((c) => c.name + "=" + c.value).join("; "), csrf: r.json().csrfToken };
}
const call = (who: Session, method: "GET" | "POST" | "PUT", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { origin, cookie: who.cookie, "x-csrf-token": who.csrf }, ...(payload === undefined ? {} : { payload: payload as object }) });
async function saveAssessment(assessment: { maxGradedAttemptsPerCheck: number | null; retryCooldownMinutes: number }) {
  const current = (await call(owner, "GET", `/api/admin/courses/${course}/policy-settings`)).json();
  const saved = await call(owner, "PUT", `/api/admin/courses/${course}/policy-settings`,
    { expectedRevision: current.revision, settings: { ...structuredClone(DEFAULT_COURSE_POLICY_SETTINGS), assessment }, reason: "Assessment policy review" });
  expect(saved.statusCode, saved.body).toBe(200);
  return saved.json();
}
async function enroll() {
  const who = await session("learner");
  const r = await call(who, "POST", "/api/enrollments", { releaseId: release });
  expect(r.statusCode, r.body).toBe(200);
  return { who, id: r.json().id as string };
}
type Learner = Awaited<ReturnType<typeof enroll>>;
const revision = async (l: Learner) => (await call(l.who, "GET", `/api/enrollments/${l.id}`)).json().revision as number;
const send = async (l: Learner, action: string, body: Record<string, unknown>) =>
  call(l.who, "POST", `/api/enrollments/${l.id}/${action}`, { expectedRevision: await revision(l), idempotencyKey: randomUUID(), ...body });
const challenge = (l: Learner, mode = "independent", assessmentId = "min-a") => send(l, "challenges", { episodeId: "min", assessmentId, mode });
async function attempt(l: Learner, option: "two" | "five", mode = "independent") {
  const issued = await challenge(l, mode);
  expect(issued.statusCode, issued.body).toBe(200);
  const answered = await send(l, "answers", { challengeId: issued.json().challengeId, answer: option });
  expect(answered.statusCode, answered.body).toBe(200);
  return answered.json();
}
const evidenceCount = async (l: Learner) => (await db.query("SELECT count(*)::int AS n FROM evidence WHERE enrollment_id=$1", [l.id])).rows[0].n as number;
const adminRevision = async (l: Learner) => (await call(owner, "GET", `/api/admin/enrollments/${l.id}/policy`)).json().revision as number;
const grant = async (l: Learner, body: Record<string, unknown>, who = owner) =>
  call(who, "POST", `/api/admin/enrollments/${l.id}/assessment-attempts/grant`, { expectedRevision: await adminRevision(l), idempotencyKey: randomUUID(), ...body });

beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false });
});
beforeEach(async () => {
  workspace = randomUUID();
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspace, "attempts-" + workspace, "Attempts"]);
  owner = await session("owner");
  instructor = await session("instructor");
  const manifest = fixture();
  const id = (await call(owner, "POST", `/api/workspaces/${workspace}/releases`, manifest)).json().id;
  expect((await call(owner, "POST", `/api/releases/${id}/publish`)).statusCode).toBe(200);
  release = id;
  course = (await db.query("SELECT id FROM admin_course_catalog WHERE workspace_id=$1", [workspace])).rows[0].id;
});
afterAll(async () => {
  await app?.close();
  await db?.end();
  await testDatabase?.drop();
});

describe("assessment policy: graded attempts per check (G02)", () => {
  it("keeps today's behaviour by default: unlimited graded attempts and no wait", async () => {
    const view = (await call(owner, "GET", `/api/admin/courses/${course}/policy-settings`)).json();
    expect(view.settings.assessment).toEqual({ maxGradedAttemptsPerCheck: null, retryCooldownMinutes: 0 });
    const l = await enroll();
    for (let i = 0; i < 4; i++) expect((await attempt(l, "five")).result.passed).toBe(false);
  });

  it("refuses a graded attempt past the limit with the count, never limits practice and keeps recorded evidence", async () => {
    const before = await enroll();
    await saveAssessment({ maxGradedAttemptsPerCheck: 2, retryCooldownMinutes: 0 });
    const l = await enroll();
    await attempt(l, "five");
    await attempt(l, "five");
    const evidence = await evidenceCount(l);
    const refused = await challenge(l);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: "ATTEMPT_LIMIT_REACHED", details: { checkId: "gate:min-gate", used: 2, limit: 2 } });
    // The other item of the same gate is the same check.
    expect((await challenge(l, "independent", "min-b")).json().error).toBe("ATTEMPT_LIMIT_REACHED");
    // Practice is never limited, and nothing already recorded is removed.
    expect((await attempt(l, "two", "practice")).result.passed).toBe(true);
    expect(await evidenceCount(l)).toBe(evidence + 1);
    // A learner who enrolled before the change keeps the terms in force when they started.
    for (let i = 0; i < 3; i++) await attempt(before, "five");
  });

  it("also refuses at submission when several graded challenges were opened before the limit", async () => {
    await saveAssessment({ maxGradedAttemptsPerCheck: 1, retryCooldownMinutes: 0 });
    const l = await enroll();
    const first = (await challenge(l)).json().challengeId, second = (await challenge(l)).json().challengeId;
    expect((await send(l, "answers", { challengeId: first, answer: "five" })).statusCode).toBe(200);
    const late = await send(l, "answers", { challengeId: second, answer: "two" });
    expect(late.statusCode).toBe(409);
    expect(late.json().error).toBe("ATTEMPT_LIMIT_REACHED");
    expect((await db.query("SELECT count(*)::int AS n FROM attempts WHERE enrollment_id=$1", [l.id])).rows[0].n).toBe(1);
  });

  it("makes the learner wait after an unsuccessful graded attempt, says until when, and not after a pass", async () => {
    await saveAssessment({ maxGradedAttemptsPerCheck: null, retryCooldownMinutes: 30 });
    const passing = await enroll();
    await attempt(passing, "two");
    expect((await challenge(passing)).statusCode).toBe(200);
    const l = await enroll();
    await attempt(l, "five");
    const submitted = (await db.query("SELECT submitted_at FROM attempts WHERE enrollment_id=$1", [l.id])).rows[0].submitted_at as Date;
    const waiting = await challenge(l);
    expect(waiting.statusCode).toBe(409);
    expect(waiting.json()).toMatchObject({ error: "RETRY_COOLDOWN", details: { checkId: "gate:min-gate" } });
    expect(Date.parse(waiting.json().details.retryAt)).toBe(submitted.getTime() + 30 * 60_000);
    expect((await challenge(l, "practice")).statusCode).toBe(200);
    await db.query("UPDATE attempts SET submitted_at=submitted_at-interval '31 minutes' WHERE enrollment_id=$1", [l.id]);
    expect((await challenge(l)).statusCode).toBe(200);
  });

  it("lets an owner or administrator allow one more attempt, with a reason, after showing the use per check", async () => {
    await saveAssessment({ maxGradedAttemptsPerCheck: 1, retryCooldownMinutes: 60 });
    const l = await enroll();
    await attempt(l, "five");
    const view = await call(instructor, "GET", `/api/admin/enrollments/${l.id}/assessment-attempts`);
    expect(view.statusCode, view.body).toBe(200);
    expect(view.json().policy).toEqual({ maxGradedAttemptsPerCheck: 1, retryCooldownMinutes: 60 });
    expect(view.json().checks[0]).toMatchObject({ checkId: "gate:min-gate", title: "Minimum", used: 1, limit: 1, granted: 0 });
    expect(view.json().checks[0].retryAt).not.toBeNull();
    // Learners cannot see or change another learner's allowance; instructors cannot grant.
    expect((await call(l.who, "GET", `/api/admin/enrollments/${l.id}/assessment-attempts`)).statusCode).toBe(403);
    expect((await grant(l, { checkId: "gate:min-gate", reason: "Connection dropped" }, instructor)).statusCode).toBe(403);
    expect((await grant(l, { checkId: "gate:min-gate" })).json().error).toBe("INVALID_REQUEST");
    expect((await grant(l, { checkId: "gate:no-such-gate", reason: "x" })).json().error).toBe("UNKNOWN_CHECK");
    const stale = await call(owner, "POST", `/api/admin/enrollments/${l.id}/assessment-attempts/grant`,
      { expectedRevision: 1, idempotencyKey: randomUUID(), checkId: "gate:min-gate", reason: "x" });
    expect(stale.json().error).toBe("STALE_REVISION");
    const granted = await grant(l, { checkId: "gate:min-gate", reason: "Connection dropped during the check" });
    expect(granted.statusCode, granted.body).toBe(200);
    // One more attempt, and the retry wait at that check ends.
    expect(granted.json().checks[0]).toMatchObject({ used: 1, limit: 2, granted: 1, retryAt: null });
    expect(granted.json().receipt).toMatchObject({ authority: "server", outcome: "granted" });
    const event = (await db.query("SELECT actor_id,actor_kind,payload FROM learning_events WHERE enrollment_id=$1 AND event_type='assessment.attempt_granted'", [l.id])).rows[0];
    expect(event).toMatchObject({ actor_id: owner.userId, actor_kind: "staff", payload: { checkId: "gate:min-gate", count: 1, reason: "Connection dropped during the check" } });
    await attempt(l, "five");
    expect((await challenge(l)).json().error).toBe("ATTEMPT_LIMIT_REACHED");
  });

  it("refuses settings outside the allowed range before saving", async () => {
    const current = (await call(owner, "GET", `/api/admin/courses/${course}/policy-settings`)).json();
    for (const assessment of [{ maxGradedAttemptsPerCheck: 0, retryCooldownMinutes: 0 }, { maxGradedAttemptsPerCheck: 3, retryCooldownMinutes: -1 },
      { maxGradedAttemptsPerCheck: 3, retryCooldownMinutes: 20_000 }, { maxGradedAttemptsPerCheck: 3 }]) {
      const r = await call(owner, "POST", `/api/admin/courses/${course}/policy-settings/preview`, { settings: { ...current.settings, assessment } });
      expect(r.statusCode, JSON.stringify(assessment)).toBe(400);
    }
    const preview = await call(owner, "POST", `/api/admin/courses/${course}/policy-settings/preview`,
      { settings: { ...current.settings, assessment: { maxGradedAttemptsPerCheck: 3, retryCooldownMinutes: 60 } } });
    expect(preview.json().preview.settings.assessment).toEqual({ maxGradedAttemptsPerCheck: 3, retryCooldownMinutes: 60 });
  });
});
