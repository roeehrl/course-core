import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import { createDatabase, type Database } from "../src/database.js";
import { migrate } from "../src/migrations.js";
import { createServer } from "../src/server.js";
import { issueLoginCode } from "../src/auth.js";
import { retentionCourse } from "./retention-fixture.js";

const origin = "http://localhost:4388",
  schema = "retention_" + randomUUID().replaceAll("-", ""),
  directory = fileURLToPath(new URL("../migrations", import.meta.url));
let root: Database, db: Database, app: Awaited<ReturnType<typeof createServer>>;
let workspace: string, owner: Session, learner: Session, enrollment: string;
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
/** Simulate the passage of time by moving the stored schedule back. */
async function age(days: number) {
  await status(); // schedules are derived from evidence timestamps on first read
  await db.query("UPDATE retention_schedules SET demonstrated_at=demonstrated_at-make_interval(days=>$2),due_at=due_at-make_interval(days=>$2) WHERE enrollment_id=$1", [enrollment, days]);
}
async function check(value: unknown) {
  const issued = await send("retention/check", { objectiveId: "minimum" });
  expect(issued.statusCode, issued.body).toBe(200);
  expect(issued.json().question).not.toHaveProperty("grading");
  return send("answers", { challengeId: issued.json().challengeId, answer: value });
}
beforeAll(async () => {
  const connection = process.env.TEST_DATABASE_URL ?? "";
  const url = new URL(connection);
  if (process.env.DATABASE_URL || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !/^\/course_core_(?:ci|test(?:_[a-z0-9_]+)?)$/.test(url.pathname) || url.search || url.hash)
    throw Error("Explicit disposable loopback database required");
  root = createDatabase(connection);
  await root.query("CREATE SCHEMA " + schema);
  url.searchParams.set("options", "-csearch_path=" + schema);
  db = createDatabase(url.href);
  await migrate(db, directory);
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false });
});
beforeEach(async () => {
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
  if (root) {
    await root.query("DROP SCHEMA " + schema + " CASCADE");
    await root.end();
  }
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
    expect(Date.parse(s.items[0].dueAt) - Date.now()).toBeGreaterThan(DAY - 60_000);
    // Demonstrated understanding is not revoked by one delayed miss.
    expect((await call(learner, "GET", "/api/enrollments/" + enrollment)).json().lessons[0].gate.passed).toBe(true);
    await db.query("UPDATE retention_schedules SET due_at=clock_timestamp()-interval '1 second' WHERE enrollment_id=$1", [enrollment]);
    expect((await check(-2)).json().result.passed).toBe(true);
    s = await status();
    expect(s.items[0]).toMatchObject({ state: "retained", freshItemsLeft: 0 });
    await db.query("UPDATE retention_schedules SET due_at=clock_timestamp()-interval '1 second' WHERE enrollment_id=$1", [enrollment]);
    expect((await send("retention/check", { objectiveId: "minimum" })).json().error).toBe("RETENTION_ITEMS_EXHAUSTED");
  });
});
