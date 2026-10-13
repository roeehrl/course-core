import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { createDatabase, type Database } from "../src/database.js";
import { migrate } from "../src/migrations.js";
import { createServer } from "../src/server.js";
import { issueLoginCode } from "../src/auth.js";
import { scanWakeups, closeReached } from "../src/wakeups.js";
import { retentionCourse } from "./retention-fixture.js";

const origin = "http://localhost:4391",
  schema = "wakeups_" + randomUUID().replaceAll("-", ""),
  directory = fileURLToPath(new URL("../migrations", import.meta.url));
let root: Database, db: Database, app: Awaited<ReturnType<typeof createServer>>;
beforeAll(async () => {
  const url = new URL(process.env.TEST_DATABASE_URL ?? "");
  if (process.env.DATABASE_URL || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !/^\/course_core_(?:ci|test(?:_[a-z0-9_]+)?)$/.test(url.pathname) || url.search || url.hash)
    throw Error("Explicit disposable loopback database required");
  root = createDatabase(url.href);
  await root.query("CREATE SCHEMA " + schema);
  url.searchParams.set("options", "-csearch_path=" + schema);
  db = createDatabase(url.href);
  await migrate(db, directory);
  app = await createServer(db, { origin, secureCookies: false });
});
afterAll(async () => {
  await app?.close();
  await db?.end();
  if (root) {
    await root.query("DROP SCHEMA " + schema + " CASCADE");
    await root.end();
  }
});

describe("supervisor wake-ups", () => {
  it("emits one supervised event per retention boundary and per approaching deadline", async () => {
    const workspace = randomUUID();
    await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspace, "wake-" + workspace, "Wake"]);
    const sign = async (role: string) => {
      const id = randomUUID();
      await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [id, "wake:" + id, role]);
      await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspace, id, role]);
      const r = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, id) } });
      return { cookie: r.cookies.map((c) => c.name + "=" + c.value).join("; "), csrf: r.json().csrfToken };
    };
    const owner = await sign("owner"), learner = await sign("learner");
    const call = (who: typeof owner, method: "GET" | "POST", url: string, payload?: unknown) =>
      app.inject({ method, url, headers: { origin, cookie: who.cookie, "x-csrf-token": who.csrf }, ...(payload === undefined ? {} : { payload: payload as object }) });
    const release = (await call(owner, "POST", `/api/workspaces/${workspace}/releases`, retentionCourse())).json().id;
    await call(owner, "POST", `/api/releases/${release}/publish`);
    const enrollment = (await call(learner, "POST", "/api/enrollments", { releaseId: release })).json().id;
    const send = async (action: string, body: Record<string, unknown>) => {
      const revision = (await call(learner, "GET", "/api/enrollments/" + enrollment)).json().revision;
      return call(learner, "POST", `/api/enrollments/${enrollment}/${action}`, { expectedRevision: revision, idempotencyKey: randomUUID(), ...body });
    };
    for (const [assessmentId, answer] of [["min-a", "two"], ["min-b", 4]] as const) {
      const issued = await send("challenges", { episodeId: "min", assessmentId, mode: "independent" });
      await send("answers", { challengeId: issued.json().challengeId, answer });
    }
    await call(learner, "GET", `/api/enrollments/${enrollment}/retention`);
    const events = async (type: string) => (await db.query("SELECT e.id FROM learning_events e JOIN outbox o ON o.event_id=e.id WHERE e.enrollment_id=$1 AND e.event_type=$2", [enrollment, type])).rowCount;
    // Not yet due: nothing.
    await scanWakeups(db);
    expect(await events("retention.due")).toBe(0);
    // A day later the check is due: exactly one wake-up, even when scanned repeatedly.
    const later = new Date(Date.now() + 25 * 3_600_000);
    await scanWakeups(db, { now: later });
    await Promise.all([scanWakeups(db, { now: later }), scanWakeups(db, { now: later })]);
    expect(await events("retention.due")).toBe(1);
    // The course deadline (fixture policy) enters a lead window large enough to include it.
    await scanWakeups(db, { deadlineLeadMs: 400 * 86_400_000 });
    await scanWakeups(db, { deadlineLeadMs: 400 * 86_400_000 });
    expect(await events("deadline.approaching")).toBe(1);
    // Wake-ups never change progress, gates or policy.
    const state = (await call(learner, "GET", "/api/enrollments/" + enrollment)).json();
    expect(state.lessons[0].gate.passed).toBe(true);
  });

  it("closes an enrollment whose course deadline has passed, once, with a gaps report, and never one that has time left", async () => {
    const workspace = randomUUID();
    await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspace, "cap-" + workspace, "Cap"]);
    const sign = async (role: string) => {
      const id = randomUUID();
      await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [id, "cap:" + id, role]);
      await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspace, id, role]);
      const r = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, id) } });
      return { cookie: r.cookies.map((c) => c.name + "=" + c.value).join("; "), csrf: r.json().csrfToken };
    };
    const owner = await sign("owner"), learner = await sign("learner");
    const call = (who: typeof owner, method: "GET" | "POST", url: string, payload?: unknown) =>
      app.inject({ method, url, headers: { origin, cookie: who.cookie, "x-csrf-token": who.csrf }, ...(payload === undefined ? {} : { payload: payload as object }) });
    const release = (await call(owner, "POST", `/api/workspaces/${workspace}/releases`, retentionCourse())).json().id;
    await call(owner, "POST", `/api/releases/${release}/publish`);
    const enrollment = (await call(learner, "POST", "/api/enrollments", { releaseId: release })).json().id;
    // Time remains: the policy refuses to close.
    await expect(closeReached(db, enrollment)).rejects.toMatchObject({ code: "CAP_NOT_REACHED" });
    // Move the course window back 31 days (a consistent 30-day window), as if the learner ran out of time.
    const anchor = new Date(Date.now() - 31 * 86_400_000), deadline = new Date(anchor.getTime() + 30 * 86_400_000);
    await db.query(`UPDATE policy_states SET snapshot=jsonb_set(snapshot,'{scopes}',(SELECT jsonb_agg(CASE WHEN s->>'scopeId'='course'
      THEN jsonb_set(jsonb_set(s,'{window,anchorInstant}',to_jsonb($2::text)),'{window,resolvedDeadline}',to_jsonb($3::text)) ELSE s END) FROM jsonb_array_elements(snapshot->'scopes') s)) WHERE enrollment_id=$1`,
      [enrollment, anchor.toISOString(), deadline.toISOString()]);
    await Promise.all([scanWakeups(db), scanWakeups(db)]);
    const res = await call(learner, "GET", "/api/enrollments/" + enrollment);
    const state = res.json();
    expect(state.status).toBe("closed");
    expect(state.closureReport).toMatchObject({ reason: "cap", coverage: "partial" });
    expect((await db.query("SELECT count(*) FROM learning_events WHERE enrollment_id=$1 AND event_type='enrollment.closed'", [enrollment])).rows[0].count).toBe("1");
    expect(await closeReached(db, enrollment)).toBe(0);
  });
});
