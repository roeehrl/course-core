import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import { createDatabase, type Database } from "../src/database.js";
import { createTestDatabase, type TestDatabase } from "./test-database.js";
import { createServer } from "../src/server.js";
import { issueLoginCode } from "../src/auth.js";
import { retentionCourse } from "./retention-fixture.js";
import { offsetClock, serverClock, systemClock } from "../src/clock.js";

const origin = "http://localhost:4388",
  schema = "retention_" + randomUUID().replaceAll("-", "");
let db: Database, app: Awaited<ReturnType<typeof createServer>>;
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
const call = (who: Session, method: "GET" | "POST", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { origin, cookie: who.cookie, "x-csrf-token": who.csrf }, ...(payload === undefined ? {} : { payload: payload as object }) });
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
});
beforeEach(async () => {
  clock.set(0);
  workspace = randomUUID();
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspace, "ret-" + workspace, "Retention"]);
  owner = await session("owner");
  learner = await session("learner");
  const release = (await call(owner, "POST", `/api/workspaces/${workspace}/releases`, retentionCourse())).json().id;
  expect((await call(owner, "POST", `/api/releases/${release}/publish`)).statusCode).toBe(200);
  enrollment = (await call(learner, "POST", "/api/enrollments", { releaseId: release })).json().id;
});
afterAll(async () => {
  await app?.close();
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
