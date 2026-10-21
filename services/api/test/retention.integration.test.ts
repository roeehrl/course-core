import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import { createDatabase, type Database } from "../src/database.js";
import { createTestDatabase, type TestDatabase } from "./test-database.js";
import { createServer } from "../src/server.js";
import { issueLoginCode } from "../src/auth.js";
import { retentionCourse } from "./retention-fixture.js";
import { offsetClock, serverClock, systemClock } from "../src/clock.js";
import { reviewedRubricEvaluator } from "../src/rubric-evaluator.js";

const origin = "http://localhost:4388",
  schema = "retention_" + randomUUID().replaceAll("-", "");
let db: Database, app: Awaited<ReturnType<typeof createServer>>, reviewing: Awaited<ReturnType<typeof createServer>>;
let workspace: string, owner: Session, learner: Session, enrollment: string;
// The server decides due-ness with this clock; tests move time forward instead of rewriting stored timestamps.
const clock = offsetClock();
interface Session { cookie: string; csrf: string }
const DAY = 86_400_000;
async function session(role: string): Promise<Session> {
  const id = randomUUID();
  await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [id, "retention:" + id, role]);
  await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspace, id, role]);
  const r = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, id) } });
  return { cookie: r.cookies.map((c) => c.name + "=" + c.value).join("; "), csrf: r.json().csrfToken };
}
const call = (who: Session, method: "GET" | "POST", url: string, payload?: unknown, server = app) =>
  server.inject({ method, url, headers: { origin, cookie: who.cookie, "x-csrf-token": who.csrf }, ...(payload === undefined ? {} : { payload: payload as object }) });
async function send(action: string, body: Record<string, unknown>) {
  const revision = (await call(learner, "GET", "/api/enrollments/" + enrollment)).json().revision;
  return call(learner, "POST", `/api/enrollments/${enrollment}/${action}`, { expectedRevision: revision, idempotencyKey: randomUUID(), ...body });
}
async function answer(assessmentId: string, value: unknown) {
  const issued = await send("challenges", { episodeId: "min", assessmentId, mode: "independent" });
  expect(issued.statusCode, issued.body).toBe(200);
  return send("answers", { challengeId: issued.json().challengeId, answer: value });
}
const status = async () => (await call(learner, "GET", `/api/enrollments/${enrollment}/retention`)).json();
/** Let time pass on the server clock. Stored schedules are never rewritten. */
async function age(days: number) {
  await status(); // schedules are derived from evidence timestamps on first read
  clock.advance(days * DAY);
}
async function check(value: unknown) {
  const issued = await send("retention/check", { objectiveId: "minimum" });
  expect(issued.statusCode, issued.body).toBe(200);
  expect(issued.json().question).not.toHaveProperty("grading");
  return send("answers", { challengeId: issued.json().challengeId, answer: value });
}
let testDatabase: TestDatabase | undefined;
beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false, clock });
  reviewing = await createServer(db, { loginCodes: true, origin, secureCookies: false, clock, installedExtensions: [reviewedRubricEvaluator()] });
});
let versions = 0;
async function enroll(course = retentionCourse()) {
  course.version = `9.0.${versions++}`;
  const created = await call(owner, "POST", `/api/workspaces/${workspace}/releases`, course);
  expect(created.statusCode, created.body).toBe(200);
  const release = created.json().id;
  expect((await call(owner, "POST", `/api/releases/${release}/publish`)).statusCode).toBe(200);
  enrollment = (await call(learner, "POST", "/api/enrollments", { releaseId: release })).json().id;
}
beforeEach(async () => {
  clock.set(0);
  workspace = randomUUID();
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspace, "ret-" + workspace, "Retention"]);
  owner = await session("owner");
  learner = await session("learner");
  await enroll();
});
afterAll(async () => {
  await app?.close();
  await reviewing?.close();
  await db?.end();
  await testDatabase?.drop();
});

describe("delayed retention checks", () => {
  it("schedules after demonstration, checks only when due, and records retained without touching gates", async () => {
    expect(await status()).toMatchObject({ available: true, items: [] });
    expect((await send("retention/check", { objectiveId: "minimum" })).json().error).toBe("OBJECTIVE_NOT_DEMONSTRATED");
    await answer("min-a", "two");
    await answer("min-b", 4);
    let s = await status();
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toMatchObject({ objectiveId: "minimum", state: "demonstrated", due: false, freshItemsLeft: 2 });
    expect(Date.parse(s.items[0].dueAt) - Date.parse(s.items[0].demonstratedAt)).toBe(DAY);
    expect((await send("retention/check", { objectiveId: "minimum" })).json().error).toBe("RETENTION_NOT_DUE");
    const lessonsBefore = (await call(learner, "GET", "/api/enrollments/" + enrollment)).json().lessons;
    await age(1);
    expect((await status()).items[0].due).toBe(true);
    const passed = await check(7);
    expect(passed.statusCode, passed.body).toBe(200);
    expect(passed.json().result).toMatchObject({ passed: true, independent: true });
    s = await status();
    expect(s.items[0]).toMatchObject({ state: "retained", due: false, freshItemsLeft: 1 });
    expect(Date.parse(s.items[0].dueAt) - Date.parse(s.items[0].demonstratedAt)).toBe(3 * DAY);
    // Retention never changes the gate, completion or lesson states.
    expect((await call(learner, "GET", "/api/enrollments/" + enrollment)).json().lessons).toEqual(lessonsBefore);
  });

  it("marks a failed delayed check for review, refuses duplicates and is honest when items run out", async () => {
    await answer("min-a", "two");
    await answer("min-b", 4);
    await age(1);
    const issued = await send("retention/check", { objectiveId: "minimum" });
    expect(issued.statusCode, issued.body).toBe(200);
    expect((await send("retention/check", { objectiveId: "minimum" })).json().error).toBe("RETENTION_CHECK_PENDING");
    await send("answers", { challengeId: issued.json().challengeId, answer: 12 });
    let s = await status();
    expect(s.items[0]).toMatchObject({ state: "needs_review", due: false });
    expect(Date.parse(s.items[0].dueAt) - clock.now().getTime()).toBeGreaterThan(DAY - 60_000);
    // Demonstrated understanding is not revoked by one delayed miss.
    expect((await call(learner, "GET", "/api/enrollments/" + enrollment)).json().lessons[0].gate.passed).toBe(true);
    // The rescheduled check is not due yet, and becomes due a day later.
    expect((await send("retention/check", { objectiveId: "minimum" })).json().error).toBe("RETENTION_NOT_DUE");
    clock.advance(DAY);
    expect((await check(-2)).json().result.passed).toBe(true);
    s = await status();
    expect(s.items[0]).toMatchObject({ state: "retained", freshItemsLeft: 0 });
    clock.advance(3 * DAY);
    expect((await send("retention/check", { objectiveId: "minimum" })).json().error).toBe("RETENTION_ITEMS_EXHAUSTED");
  });

  it("treats \"I don't know yet\" on a delayed check as a review to schedule, never as failed evidence", async () => {
    await answer("min-a", "two");
    await answer("min-b", 4);
    await age(1);
    const issued = await send("retention/check", { objectiveId: "minimum" });
    expect(issued.json().question.allowAbstain).toBe(true);
    const abstained = await send("answers", { challengeId: issued.json().challengeId, abstain: true });
    expect(abstained.json().result, abstained.body).toMatchObject({ abstained: true, passed: false });
    const attempt = (await db.query("SELECT id,mode,response,result FROM attempts WHERE enrollment_id=$1 AND mode='retention'", [enrollment])).rows[0];
    expect(attempt).toMatchObject({ response: null, result: { abstained: true, status: "abstained" } });
    // No evidence row at all, so nothing failed is on record.
    expect((await db.query("SELECT count(*)::int AS n FROM evidence WHERE attempt_id=$1", [attempt.id])).rows[0].n).toBe(0);
    let s = await status();
    expect(s.items[0]).toMatchObject({ state: "needs_review", due: false, retainedAt: null, freshItemsLeft: 1 });
    expect((await call(learner, "GET", "/api/enrollments/" + enrollment)).json().lessons[0].gate.passed).toBe(true);
    // A review is offered after the first interval, and a later success records retention.
    clock.advance(DAY);
    expect((await check(-2)).json().result.passed).toBe(true);
    s = await status();
    expect(s.items[0]).toMatchObject({ state: "retained" });
  });

  it("uses one server clock for due-ness and the retained time, and refuses a test clock outside NODE_ENV=test", async () => {
    await answer("min-a", "two");
    await answer("min-b", 4);
    // Just short of the interval: not due on the server, whatever the browser thinks.
    await age(1 - 1 / 24);
    expect((await status()).items[0].due).toBe(false);
    expect((await send("retention/check", { objectiveId: "minimum" })).json().error).toBe("RETENTION_NOT_DUE");
    clock.advance(2 * 3_600_000);
    expect((await check(7)).json().result.passed).toBe(true);
    const stored = (await db.query("SELECT retained_at FROM retention_schedules WHERE enrollment_id=$1", [enrollment])).rows[0];
    expect(Math.abs(stored.retained_at.getTime() - clock.now().getTime())).toBeLessThan(60_000);
    expect(() => serverClock(clock, "production")).toThrow(/NODE_ENV=test/);
    expect(() => serverClock(clock, "development")).toThrow(/NODE_ENV=test/);
    expect(serverClock(undefined, "production")).toBe(systemClock);
    const environment = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try { await expect(createServer(db, { loginCodes: true, origin, secureCookies: false, clock })).rejects.toThrow(/NODE_ENV=test/); }
    finally { process.env.NODE_ENV = environment; }
  });
});

describe("graded review schedule and the learner's study days (F06)", () => {
  const item = async () => (await status()).items[0];
  /** Moves the server clock to `days` after the objective was demonstrated. */
  async function at(days: number) {
    const demonstrated = Date.parse((await item()).demonstratedAt);
    clock.advance(demonstrated + days * DAY + 60_000 - clock.now().getTime());
  }
  it("steps back one interval on a miss instead of restarting, and restarts after two misses in a row", async () => {
    await enroll(retentionCourse({ extra: 4 }));
    await answer("min-a", "two");
    await answer("min-b", 4);
    await at(1);
    expect((await check(7)).json().result.passed).toBe(true);
    expect(await item()).toMatchObject({ step: 1, lastOutcome: "retained", state: "retained" });
    await at(3);
    expect((await check(-2)).json().result.passed).toBe(true);
    let s = await item();
    expect(s).toMatchObject({ step: 2, lastOutcome: "retained" });
    expect(Date.parse(s.dueAt) - Date.parse(s.demonstratedAt)).toBe(7 * DAY);
    // A miss at the 7-day check goes back one interval (3 days), not to the start.
    await at(7);
    expect((await check(99)).json().result.passed).toBe(false);
    s = await item();
    expect(s).toMatchObject({ step: 1, lastOutcome: "missed", state: "needs_review" });
    expect(Date.parse(s.dueAt) - clock.now().getTime()).toBeGreaterThan(3 * DAY - 60_000);
    expect(Date.parse(s.dueAt) - clock.now().getTime()).toBeLessThanOrEqual(3 * DAY);
    // A second miss in a row restarts at the first interval.
    clock.advance(3 * DAY);
    expect((await check(99)).json().result.passed).toBe(false);
    s = await item();
    expect(s).toMatchObject({ step: 0, lastOutcome: "missed", state: "needs_review" });
    expect(Date.parse(s.dueAt) - clock.now().getTime()).toBeGreaterThan(DAY - 60_000);
    expect(Date.parse(s.dueAt) - clock.now().getTime()).toBeLessThanOrEqual(DAY);
    // Retained again after the review: the miss count resets and the schedule moves on.
    clock.advance(DAY);
    expect((await check(5)).json().result.passed).toBe(true);
    expect(await item()).toMatchObject({ step: 1, lastOutcome: "retained", state: "retained" });
    const stored = (await db.query("SELECT lapses FROM retention_schedules WHERE enrollment_id=$1", [enrollment])).rows[0];
    expect(stored.lapses).toBe(0);
  });
  it("falls due only on the days the learner can study, in their time zone, and only the learner sets them", async () => {
    await enroll();
    await answer("min-a", "two");
    await answer("min-b", 4);
    const before = await item(), dueDay = new Date(before.dueAt).getUTCDay();
    const put = (body: Record<string, unknown>, who = learner) => (async () => {
      const revision = (await call(learner, "GET", "/api/enrollments/" + enrollment)).json().revision;
      return call(who, "POST", `/api/enrollments/${enrollment}/retention/availability`, { expectedRevision: revision, idempotencyKey: randomUUID(), ...body });
    })();
    // Every day but the one the check falls on: it moves to the start of the next day, never earlier.
    const days = [0, 1, 2, 3, 4, 5, 6].filter((d) => d !== dueDay);
    const saved = await put({ weekdays: days, timeZone: "UTC" });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().availability).toEqual({ weekdays: days, timeZone: "UTC" });
    const moved = await item(), next = new Date(before.dueAt);
    next.setUTCHours(24, 0, 0, 0);
    expect(moved).toMatchObject({ dueAt: next.toISOString(), movedForAvailability: true });
    // Clearing the setting restores the schedule's own time.
    expect((await put({ weekdays: null, timeZone: "UTC" })).statusCode).toBe(200);
    expect(await item()).toMatchObject({ dueAt: before.dueAt, movedForAvailability: false });
    // Invalid settings are refused; staff cannot set a learner's days.
    for (const body of [{ weekdays: [], timeZone: "UTC" }, { weekdays: [1, 1], timeZone: "UTC" }, { weekdays: [7], timeZone: "UTC" }, { weekdays: [1], timeZone: "Mars/Base" }]) {
      const refused = await put(body);
      expect(refused.statusCode, JSON.stringify(body)).toBe(400);
      expect(refused.json().error).toBe("INVALID_AVAILABILITY");
    }
    expect((await put({ weekdays: [1], timeZone: "UTC" }, owner)).statusCode).not.toBe(200);
    expect((await db.query("SELECT count(*)::int AS n FROM retention_availability WHERE enrollment_id=$1", [enrollment])).rows[0].n).toBe(0);
  });
  it("issues a written retention check when a reviewer is installed; its review moves the schedule", async () => {
    await enroll(retentionCourse({ written: true }));
    await answer("min-a", "two");
    await answer("min-b", 4);
    await at(1);
    // Without the reviewer this host cannot evaluate the written check.
    const unevaluated = await send("retention/check", { objectiveId: "minimum" });
    expect(unevaluated.json().error, unevaluated.body).toBe("EVALUATOR_NOT_CONFIGURED");
    const revision = async () => (await call(learner, "GET", "/api/enrollments/" + enrollment)).json().revision;
    const issued = await call(learner, "POST", `/api/enrollments/${enrollment}/retention/check`, { expectedRevision: await revision(), idempotencyKey: randomUUID(), objectiveId: "minimum" }, reviewing);
    expect(issued.statusCode, issued.body).toBe(200);
    expect(issued.json().question).toMatchObject({ id: "min-later-written", type: "rubric" });
    const text = "I keep the smallest value seen so far, so the kept value is never greater than any element I have read.";
    const submitted = await call(learner, "POST", `/api/enrollments/${enrollment}/answers`, { expectedRevision: await revision(), idempotencyKey: randomUUID(), challengeId: issued.json().challengeId, answer: text }, reviewing);
    expect(submitted.json().result, submitted.body).toMatchObject({ pendingReview: true });
    // Awaiting review is neither retained nor missed, and a second check waits for it.
    expect(await item()).toMatchObject({ step: 0, lastOutcome: null });
    expect((await call(learner, "POST", `/api/enrollments/${enrollment}/retention/check`, { expectedRevision: await revision(), idempotencyKey: randomUUID(), objectiveId: "minimum" }, reviewing)).json().error)
      .toBe("RETENTION_CHECK_PENDING");
    const attemptId = (await db.query("SELECT id FROM attempts WHERE enrollment_id=$1 AND mode='retention'", [enrollment])).rows[0].id;
    const reviewed = await call(owner, "POST", `/api/admin/rubric-reviews/${attemptId}`, { decision: "met", idempotencyKey: "k-" + randomUUID(),
      criteria: [{ criterionId: "invariant", met: true, quote: "the kept value is never greater than any element" }] }, reviewing);
    expect(reviewed.statusCode, reviewed.body).toBe(200);
    expect(await item()).toMatchObject({ step: 1, lastOutcome: "retained", state: "retained" });
  });
});
