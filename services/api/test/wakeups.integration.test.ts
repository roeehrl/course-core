import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import type { CourseManifest } from "@course-core/sdk";
import { createDatabase, type Database } from "../src/database.js";
import { migrate } from "../src/migrations.js";
import { createServer } from "../src/server.js";
import { issueLoginCode } from "../src/auth.js";
import { scanWakeups, closeReached, wakeupStatistics, type WakeupFailure } from "../src/wakeups.js";
import { retentionCourse } from "./retention-fixture.js";

const origin = "http://localhost:4391",
  schema = "wakeups_" + randomUUID().replaceAll("-", ""),
  directory = fileURLToPath(new URL("../migrations", import.meta.url));
const DAY = 86_400_000;
let root: Database, db: Database, app: Awaited<ReturnType<typeof createServer>>;
interface Session { id: string; cookie: string; csrf: string }
beforeAll(async () => {
  const url = new URL(process.env.TEST_DATABASE_URL ?? "");
  if (process.env.DATABASE_URL || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !/^\/course_core_(?:ci|test(?:_[a-z0-9_]+)?)$/.test(url.pathname) || url.search || url.hash)
    throw Error("Explicit disposable loopback database required");
  root = createDatabase(url.href);
  await root.query("CREATE SCHEMA " + schema);
  url.searchParams.set("options", "-csearch_path=" + schema);
  db = createDatabase(url.href);
  await migrate(db, directory);
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false });
});
afterAll(async () => {
  await app?.close();
  await db?.end();
  if (root) {
    await root.query("DROP SCHEMA " + schema + " CASCADE");
    await root.end();
  }
});

/** A workspace with a published course; learners enroll over HTTP like real users. */
async function workspaceWith(course: CourseManifest) {
  const workspace = randomUUID();
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspace, "wake-" + workspace, "Wake"]);
  const sign = async (role: string): Promise<Session> => {
    const id = randomUUID();
    await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [id, "wake:" + id, role]);
    await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspace, id, role]);
    const r = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, id) } });
    return { id, cookie: r.cookies.map((c) => c.name + "=" + c.value).join("; "), csrf: r.json().csrfToken };
  };
  const call = (who: Session, method: "GET" | "POST", url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { origin, cookie: who.cookie, "x-csrf-token": who.csrf }, ...(payload === undefined ? {} : { payload: payload as object }) });
  const owner = await sign("owner");
  const release = (await call(owner, "POST", `/api/workspaces/${workspace}/releases`, course)).json().id;
  expect((await call(owner, "POST", `/api/releases/${release}/publish`)).statusCode).toBe(200);
  const enroll = async () => {
    const learner = await sign("learner");
    const r = await call(learner, "POST", "/api/enrollments", { releaseId: release });
    expect(r.statusCode, r.body).toBe(200);
    return { learner, enrollment: r.json().id as string };
  };
  return { workspace, release, owner, call, enroll };
}
const events = async (enrollment: string, type: string) =>
  Number((await db.query("SELECT count(*) FROM learning_events e JOIN outbox o ON o.event_id=e.id WHERE e.enrollment_id=$1 AND e.event_type=$2", [enrollment, type])).rows[0].count);
const statusOf = async (ids: string[]) =>
  (await db.query<{ id: string; status: string }>("SELECT id,status FROM enrollments WHERE id=ANY($1::uuid[]) ORDER BY id", [ids])).rows;
/** Repeats bounded scans until a full pass over all active enrollments has completed. */
async function fullPass(options: Parameters<typeof scanWakeups>[1]) {
  const results = [];
  for (let i = 0; i < 20; i++) {
    const result = await scanWakeups(db, options);
    results.push(result);
    if (result.wrapped) return results;
  }
  throw Error("scan never wrapped");
}

describe("supervisor wake-ups", () => {
  it("emits one supervised event per retention boundary and per approaching deadline", async () => {
    const w = await workspaceWith(retentionCourse());
    const { learner, enrollment } = await w.enroll();
    const send = async (action: string, body: Record<string, unknown>) => {
      const revision = (await w.call(learner, "GET", "/api/enrollments/" + enrollment)).json().revision;
      return w.call(learner, "POST", `/api/enrollments/${enrollment}/${action}`, { expectedRevision: revision, idempotencyKey: randomUUID(), ...body });
    };
    for (const [assessmentId, answer] of [["min-a", "two"], ["min-b", 4]] as const) {
      const issued = await send("challenges", { episodeId: "min", assessmentId, mode: "independent" });
      await send("answers", { challengeId: issued.json().challengeId, answer });
    }
    await w.call(learner, "GET", `/api/enrollments/${enrollment}/retention`);
    // Not yet due: nothing.
    await scanWakeups(db);
    expect(await events(enrollment, "retention.due")).toBe(0);
    // A day later the check is due: exactly one wake-up, even when scanned repeatedly.
    const later = new Date(Date.now() + 25 * 3_600_000);
    await scanWakeups(db, { now: later });
    await Promise.all([scanWakeups(db, { now: later }), scanWakeups(db, { now: later })]);
    expect(await events(enrollment, "retention.due")).toBe(1);
    // The course deadline (fixture policy) enters a lead window large enough to include it.
    await scanWakeups(db, { deadlineLeadMs: 400 * DAY });
    await scanWakeups(db, { deadlineLeadMs: 400 * DAY });
    expect(await events(enrollment, "deadline.approaching")).toBe(1);
    // Wake-ups never change progress, gates or policy.
    const state = (await w.call(learner, "GET", "/api/enrollments/" + enrollment)).json();
    expect(state.lessons[0].gate.passed).toBe(true);
  });

  it("closes an enrollment whose course deadline has passed, once, with a gaps report, and never one that has time left", async () => {
    const w = await workspaceWith(retentionCourse());
    const { learner, enrollment } = await w.enroll();
    // Time remains: the policy refuses to close.
    await expect(closeReached(db, enrollment)).rejects.toMatchObject({ code: "CAP_NOT_REACHED" });
    expect((await scanWakeups(db)).closed).toBe(0);
    // 31 days later on the scan's clock the 30-day window has ended. No stored time is rewritten.
    const later = new Date(Date.now() + 31 * DAY);
    await Promise.all([scanWakeups(db, { now: later }), scanWakeups(db, { now: later })]);
    const state = (await w.call(learner, "GET", "/api/enrollments/" + enrollment)).json();
    expect(state.status).toBe("closed");
    expect(state.closureReport).toMatchObject({ reason: "cap", coverage: "partial" });
    expect((await db.query("SELECT count(*) FROM learning_events WHERE enrollment_id=$1 AND event_type='enrollment.closed'", [enrollment])).rows[0].count).toBe("1");
    expect((await db.query("SELECT payload FROM learning_events WHERE enrollment_id=$1 AND event_type='enrollment.closed'", [enrollment])).rows[0].payload).toMatchObject({ reason: "cap", cap: "deadline" });
    expect(await closeReached(db, enrollment, { now: later })).toBe(0);
  });

  it("reaches every active enrollment beyond the first batch, fairly, and closes the last one at the cap", async () => {
    const w = await workspaceWith(retentionCourse());
    const ids: string[] = [];
    for (let i = 0; i < 250; i += 25) ids.push(...(await Promise.all(Array.from({ length: 25 }, () => w.enroll()))).map((e) => e.enrollment));
    ids.sort();
    const before = wakeupStatistics();
    // Bounded batches of 100: each scan continues after the previous one rather than re-reading the same first rows.
    const warned = await fullPass({ deadlineLeadMs: 31 * DAY, batchSize: 100 });
    expect(warned.length).toBeGreaterThanOrEqual(3);
    expect(warned.slice(0, -1).every((r) => r.examined === 100)).toBe(true);
    const counts = (await db.query("SELECT e.enrollment_id,count(*)::int AS n FROM learning_events e WHERE e.enrollment_id=ANY($1::uuid[]) AND e.event_type='deadline.approaching' GROUP BY 1", [ids])).rows;
    expect(counts).toHaveLength(250);
    expect(counts.every((r) => r.n === 1)).toBe(true);
    // Past the cap: every one closes, including the highest ID, again in bounded batches.
    const later = new Date(Date.now() + 31 * DAY);
    const closing = await fullPass({ now: later, batchSize: 100 });
    expect(closing.reduce((sum, r) => sum + r.failed, 0)).toBe(0);
    const statuses = await statusOf(ids);
    expect(statuses.filter((r) => r.status === "closed")).toHaveLength(250);
    expect(statuses.at(-1)).toEqual({ id: ids.at(-1), status: "closed" });
    const after = wakeupStatistics();
    expect(after.closed - before.closed).toBeGreaterThanOrEqual(250);
    expect(after.scans - before.scans).toBe(warned.length + closing.length);
  }, 120_000);

  it("records a failing enrollment with its code, reports it, and still processes the rest", async () => {
    const w = await workspaceWith(retentionCourse());
    const [broken, orphan, healthy] = [await w.enroll(), await w.enroll(), await w.enroll()];
    // Failure injection, not time travel: an unreadable policy, and a learner whose membership was removed.
    await db.query("UPDATE policy_states SET snapshot=jsonb_set(snapshot,'{scopes}','[]'::jsonb) WHERE enrollment_id=$1", [broken.enrollment]);
    await db.query("DELETE FROM memberships WHERE workspace_id=$1 AND user_id=$2", [w.workspace, orphan.learner.id]);
    const reported: WakeupFailure[] = [];
    const later = new Date(Date.now() + 31 * DAY);
    const results = await fullPass({ now: later, onFailure: (failure) => { reported.push(failure); throw Error("a reporter error never stops the scan"); } });
    const failures = results.flatMap((r) => r.failures);
    expect(failures).toEqual(expect.arrayContaining([
      { enrollmentId: broken.enrollment, stage: "deadline", code: "INVALID_INPUT" },
      { enrollmentId: orphan.enrollment, stage: "closure", code: "FORBIDDEN" },
    ]));
    expect(reported).toEqual(expect.arrayContaining(failures));
    expect((await statusOf([healthy.enrollment]))[0]!.status).toBe("closed");
    const recorded = (await db.query("SELECT enrollment_id,stage,code,failures FROM wakeup_failures WHERE enrollment_id=ANY($1::uuid[]) ORDER BY stage", [[broken.enrollment, orphan.enrollment]])).rows;
    expect(recorded).toEqual([
      { enrollment_id: orphan.enrollment, stage: "closure", code: "FORBIDDEN", failures: 1 },
      { enrollment_id: broken.enrollment, stage: "deadline", code: "INVALID_INPUT", failures: 1 },
    ]);
    await fullPass({ now: later });
    expect((await db.query("SELECT failures FROM wakeup_failures WHERE enrollment_id=$1", [broken.enrollment])).rows[0].failures).toBe(2);
  });

  it("gives each learner sharing one absolute deadline their own wake-up", async () => {
    const course = retentionCourse();
    const deadline = new Date(Date.now() + 10 * DAY);
    deadline.setUTCHours(12, 0, 0, 0);
    course.policy = { mode: "bounded", hardDeadline: deadline.toISOString(), existingMaterialAccess: "read_only" };
    const w = await workspaceWith(course);
    const a = await w.enroll(), b = await w.enroll();
    const results = await fullPass({ deadlineLeadMs: 11 * DAY });
    expect(results.flatMap((r) => r.failures).filter((f) => [a.enrollment, b.enrollment].includes(f.enrollmentId))).toEqual([]);
    expect(await events(a.enrollment, "deadline.approaching")).toBe(1);
    expect(await events(b.enrollment, "deadline.approaching")).toBe(1);
  });

  it("signals binding chapter and episode deadlines, reports a passed one once, and does not close the course for it", async () => {
    const course = retentionCourse();
    course.chapters[0]!.policy = { mode: "bounded", window: { calendarDays: 7, timeZone: "UTC", anchor: "scope_assigned", pauseRule: "never" }, existingMaterialAccess: "read_only" };
    course.chapters[0]!.episodes[0]!.policy = { mode: "bounded", window: { calendarDays: 2, timeZone: "UTC", anchor: "scope_assigned", pauseRule: "never" }, existingMaterialAccess: "read_only" };
    const w = await workspaceWith(course);
    const { enrollment } = await w.enroll();
    const payloads = async (type: string) =>
      (await db.query("SELECT payload FROM learning_events WHERE enrollment_id=$1 AND event_type=$2 ORDER BY sequence", [enrollment, type])).rows.map((r) => r.payload);
    // Within three days only the episode's 2-day window binds; the chapter and course end later.
    await fullPass({ deadlineLeadMs: 3 * DAY });
    expect((await payloads("deadline.approaching")).map((p) => [p.scopeId, p.level])).toEqual([["episode:min", "episode"]]);
    // Five days on, the episode window has passed with its work unfinished: one report, no closure.
    const later = new Date(Date.now() + 5 * DAY);
    await fullPass({ now: later, deadlineLeadMs: 3 * DAY });
    await fullPass({ now: later, deadlineLeadMs: 3 * DAY });
    expect((await payloads("deadline.reached")).map((p) => p.scopeId)).toEqual(["episode:min"]);
    // The 7-day chapter window is now inside the lead window.
    expect((await payloads("deadline.approaching")).map((p) => p.scopeId)).toEqual(["episode:min", "chapter:order"]);
    expect((await statusOf([enrollment]))[0]!.status).toBe("active");
  });
});
