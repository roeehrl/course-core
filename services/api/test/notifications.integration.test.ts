import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "../src/database.js";
import { createServer } from "../src/server.js";
import { issueLoginCode } from "../src/auth.js";
import { credentialVault } from "../src/key-vault.js";
import { WorkspaceProviders, defaultJobPolicy } from "../src/provider-setup.js";
import { scriptedConfiguration } from "../src/agent-evals/scripted-model.js";
import { ACCOUNT_ERASURE_CONFIRMATION } from "../src/account-erasure.js";
import { NOTIFICATION_LIMITS, notifyUser, resetNotificationRefresh } from "../src/notifications.js";
import { createTestDatabase, type TestDatabase } from "./test-database.js";
import { fixture } from "./fixture.js";

// Real HTTP and PostgreSQL 17: the in-app notification center (owner decision 8, Q08). Staff see
// approvals waiting, AI roles that need a check, failed AI runs, the AI budget near its limit and
// overdue backups, each from its own source and only when their role can act on it; learners see
// their own notifications only. Read state, counts, links, bounds and erasure.
const origin = "http://localhost:4393",
  schema = "notifications_" + randomUUID().replaceAll("-", "");
let db: Database, app: Awaited<ReturnType<typeof createServer>>, testDatabase: TestDatabase | undefined;
interface Session { userId: string; cookie: string; csrf: string }
let workspace: string, owner: Session, catalog: string, release: string;

async function person(role: string, name = role + " person"): Promise<Session> {
  const id = randomUUID();
  await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [id, "notify:" + id, name]);
  await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspace, id, role]);
  const r = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, id) } });
  return { userId: id, cookie: r.cookies.map((c) => c.name + "=" + c.value).join("; "), csrf: r.json().csrfToken };
}
const call = (who: Session, method: "GET" | "POST", url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method, url, headers: { origin, cookie: who.cookie, "x-csrf-token": who.csrf, ...headers }, ...(payload === undefined ? {} : { payload: payload as object }) });
const staffUrl = () => `/api/admin/workspaces/${workspace}/notifications`;
async function staff(who: Session, query = "") {
  resetNotificationRefresh();
  const r = await call(who, "GET", staffUrl() + query);
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as { unread: number; nextCursor: string | null; items: { id: string; kind: string; params: Record<string, unknown>; link: string; read: boolean }[] };
}
const kinds = (body: { items: { kind: string }[] }) => body.items.map((i) => i.kind).sort();
async function enrolled(who: Session) {
  const r = await call(who, "POST", "/api/enrollments", { releaseId: release });
  expect(r.statusCode, r.body).toBe(200);
  return r.json().id as string;
}
async function backup(minutesAgo: number, encrypted: boolean) {
  await db.query(`INSERT INTO platform_backup_reports(id,kind,outcome,code,started_at,finished_at,encrypted,core_version,tables,rows,bytes)
    VALUES($1,'backup','succeeded',NULL,clock_timestamp()-make_interval(mins=>$2)-interval '5 seconds',clock_timestamp()-make_interval(mins=>$2),$3,'0.1.50',80,1200,40960)`,
  [randomUUID(), minutesAgo, encrypted]);
}

beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false, workspaceProviders: new WorkspaceProviders(db, credentialVault(randomBytes(32))) });
}, 30000);
beforeEach(async () => {
  workspace = randomUUID();
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspace, "notify-" + workspace, "Notifications"]);
  await db.query("DELETE FROM platform_backup_reports");
  owner = await person("owner", "Owner Ada");
  release = (await call(owner, "POST", `/api/workspaces/${workspace}/releases`, fixture())).json().id;
  expect((await call(owner, "POST", `/api/releases/${release}/publish`)).statusCode).toBe(200);
  catalog = (await call(owner, "GET", "/api/admin/session")).json().courses[0].id;
});
afterAll(async () => {
  await app?.close();
  await db?.end();
  await testDatabase?.drop();
});

describe("staff notifications", () => {
  it("starts empty on a quiet workspace", async () => {
    expect(await staff(owner)).toEqual({ unread: 0, items: [], nextCursor: null });
  });

  it("approvals waiting: counts the course's queue, links to its overview, reaches reviewers but not authors", async () => {
    const revision = (await call(owner, "GET", `/api/admin/courses/${catalog}`)).json().revision as string;
    const created = await call(owner, "POST", `/api/admin/courses/${catalog}/releases`, { version: "2.0.0", notes: "Draft.", manifest: { ...fixture(), version: "2.0.0" } },
      { "if-match": revision, "idempotency-key": "cmd-" + randomUUID() });
    expect(created.statusCode, created.body).toBe(200);
    const draft = created.json().workspace.releases.find((r: { version: string }) => r.version === "2.0.0").id as string;
    const next = (await call(owner, "GET", `/api/admin/courses/${catalog}`)).json().revision as string;
    expect((await call(owner, "POST", `/api/admin/courses/${catalog}/releases/${draft}/transitions`, { action: "submit-review" },
      { "if-match": next, "idempotency-key": "cmd-" + randomUUID() })).statusCode).toBe(200);
    const body = await staff(owner);
    expect(body.unread).toBe(1);
    expect(body.items).toEqual([expect.objectContaining({ kind: "approvals_waiting", read: false, link: `/courses/${catalog}/overview`,
      params: expect.objectContaining({ courseId: catalog, count: 1, releases: 1 }) })]);
    expect(kinds(await staff(await person("reviewer")))).toEqual(["approvals_waiting"]);
    expect(kinds(await staff(await person("author")))).toEqual([]);
  });

  it("AI check needed: one per role whose setup has no passing check, owners and admins only; it never stops the role", async () => {
    await db.query("INSERT INTO workspace_provider_versions(workspace_id,revision,configuration,job_policy,sealed_credentials,changed_by) VALUES($1,1,$2,$3,'{}',$4)",
      [workspace, JSON.stringify(scriptedConfiguration("reference")), JSON.stringify(defaultJobPolicy), owner.userId]);
    await db.query("INSERT INTO workspace_provider_settings(workspace_id,revision) VALUES($1,1)", [workspace]);
    const body = await staff(owner);
    expect(body.items.filter((i) => i.kind === "ai_check_needed").map((i) => [i.params.role, i.link]).sort())
      .toEqual([["companion", "/providers"], ["supervisor", "/providers"]]);
    expect(body.items.every((i) => i.params.failed === false)).toBe(true);
    expect(kinds(await staff(await person("admin")))).toEqual(["ai_check_needed", "ai_check_needed"]);
    expect(kinds(await staff(await person("instructor")))).toEqual([]);
  });

  it("failed AI runs in the last day, per course, for roles that inspect runs; a later failure makes it unread again", async () => {
    const learner = await person("learner"), enrollment = await enrolled(learner);
    const fail = (hoursAgo: number) => db.query(`INSERT INTO supervisor_jobs(id,enrollment_id,workspace_id,workflow_id,role,state,expected_revision,specification,updated_at)
      VALUES($1,$2,$5,$3,'companion','failed',1,'{}',clock_timestamp()-make_interval(hours=>$4))`, [randomUUID(), enrollment, "wf-" + randomUUID(), hoursAgo, workspace]);
    await fail(30);
    expect(kinds(await staff(owner))).toEqual([]);
    await fail(2);
    let body = await staff(owner);
    expect(body.items).toEqual([expect.objectContaining({ kind: "jobs_failed", link: `/courses/${catalog}/runs`, params: { courseId: catalog, count: 1 }, read: false })]);
    expect((await call(owner, "POST", staffUrl() + "/read", { all: true })).json()).toMatchObject({ changed: 1, unread: 0 });
    expect((await staff(owner)).unread).toBe(0);
    await fail(1);
    body = await staff(owner);
    expect(body).toMatchObject({ unread: 1, items: [{ kind: "jobs_failed", params: { count: 2 }, read: false }] });
    expect(kinds(await staff(await person("reviewer")))).toEqual(["jobs_failed"]);
    expect(kinds(await staff(await person("support_observer")))).toEqual([]);
  });

  it("budget near its limit from 80%, owners and admins; it clears when the limit is raised", async () => {
    await db.query("INSERT INTO supervisor_workspace_budgets(workspace_id,limit_micro_usd,limit_tokens,used_micro_usd,used_tokens) VALUES($1,1000000,0,790000,0)", [workspace]);
    expect(kinds(await staff(owner))).toEqual([]);
    await db.query("UPDATE supervisor_workspace_budgets SET used_micro_usd=850000 WHERE workspace_id=$1", [workspace]);
    expect((await staff(owner)).items).toEqual([expect.objectContaining({ kind: "budget_near_limit", link: "/providers", params: { percent: 85, level: 80 } })]);
    await db.query("UPDATE supervisor_workspace_budgets SET limit_micro_usd=5000000 WHERE workspace_id=$1", [workspace]);
    expect(await staff(owner)).toMatchObject({ unread: 0, items: [] });
  });

  it("backups overdue past the recovery target; an unencrypted but recent backup is not a problem", async () => {
    await backup(10, false);
    expect(kinds(await staff(owner))).toEqual([]);
    await db.query("DELETE FROM platform_backup_reports");
    await backup(90, true);
    expect((await staff(owner)).items).toEqual([expect.objectContaining({ kind: "backups_overdue", link: "/platform",
      params: { minutes: 90, targetMinutes: 60, severe: false } })]);
    expect(kinds(await staff(await person("instructor")))).toEqual([]);
  });

  it("marks one notification read, pages with a cursor, refuses bad input and people who are not staff of this workspace", async () => {
    await db.query("INSERT INTO supervisor_workspace_budgets(workspace_id,limit_micro_usd,limit_tokens,used_micro_usd,used_tokens) VALUES($1,100,100,95,0)", [workspace]);
    await backup(200, true);
    const body = await staff(owner, "?limit=1");
    expect(body.items).toHaveLength(1);
    expect(body.unread).toBe(2);
    expect(body.nextCursor).toEqual(expect.any(String));
    const second = await staff(owner, `?limit=1&before=${body.nextCursor}`);
    expect(second.items).toHaveLength(1);
    expect(second.items[0]!.id).not.toBe(body.items[0]!.id);
    const read = await call(owner, "POST", staffUrl() + "/read", { ids: [body.items[0]!.id] });
    expect(read.json()).toMatchObject({ changed: 1, unread: 1 });
    expect((await call(owner, "GET", staffUrl() + "?limit=500")).statusCode).toBe(400);
    expect((await call(owner, "GET", staffUrl() + "?before=garbage")).statusCode).toBe(400);
    expect((await call(owner, "POST", staffUrl() + "/read", { ids: ["not-a-uuid"] })).statusCode).toBe(400);
    expect((await call(owner, "POST", staffUrl() + "/read", {})).statusCode).toBe(400);
    for (const role of ["learner", "service", "course_scoped"]) {
      const who = await person(role);
      expect((await call(who, "GET", staffUrl())).statusCode, role).toBe(403);
      expect((await call(who, "POST", staffUrl() + "/read", { all: true })).statusCode, role).toBe(403);
    }
    // Another workspace's owner, and nobody signed in.
    const mine = workspace;
    workspace = randomUUID();
    await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspace, "notify-" + workspace, "Other"]);
    const stranger = await person("owner");
    workspace = mine;
    expect((await call(stranger, "GET", staffUrl())).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: staffUrl() })).statusCode).toBe(401);
    // Reading never touches someone else's notifications.
    const other = await person("admin");
    await staff(other);
    expect((await call(other, "POST", staffUrl() + "/read", { ids: [second.items[0]!.id] })).json().changed).toBe(0);
  });
});

describe("learner notifications", () => {
  it("are the learner's own: idempotent per key, read state, never another person's", async () => {
    const learner = await person("learner"), other = await person("learner"), enrollment = await enrolled(learner);
    const offer = { workspaceId: workspace, userId: learner.userId, audience: "learner" as const, kind: "move_offer", enrollmentId: enrollment,
      params: { fromVersion: "1.0.0", toVersion: "2.0.0" }, link: `/enrollments/${enrollment}`, dedupeKey: `move-offer:${enrollment}:2.0.0` };
    await notifyUser(db, offer);
    await notifyUser(db, offer);
    await notifyUser(db, { ...offer, kind: "reply_ready", params: { episodeId: "min" }, link: `/enrollments/${enrollment}/companion`, dedupeKey: "reply-ready:1" });
    const mine = (await call(learner, "GET", "/api/me/notifications")).json();
    expect(mine.unread).toBe(2);
    expect(mine.items.map((i: { kind: string }) => i.kind)).toEqual(["reply_ready", "move_offer"]);
    expect((await call(other, "GET", "/api/me/notifications")).json()).toEqual({ unread: 0, items: [], nextCursor: null });
    expect((await call(other, "POST", "/api/me/notifications/read", { ids: [mine.items[0].id] })).json().changed).toBe(0);
    expect((await call(learner, "POST", "/api/me/notifications/read", { ids: [mine.items[0].id] })).json()).toMatchObject({ changed: 1, unread: 1 });
    // Learner notifications never show in the staff bell, even for a learner who is also staff.
    await db.query("UPDATE memberships SET role='owner' WHERE user_id=$1", [learner.userId]);
    expect(kinds(await staff(learner))).toEqual([]);
    expect((await app.inject({ method: "GET", url: "/api/me/notifications" })).statusCode).toBe(401);
  });

  it("keeps at most the per-person cap and drops read ones after the retention period", async () => {
    const learner = await person("learner");
    for (let i = 0; i < NOTIFICATION_LIMITS.maxPerPerson + 5; i++)
      await notifyUser(db, { workspaceId: workspace, userId: learner.userId, audience: "learner", kind: "course_updated", dedupeKey: "bulk:" + i, params: { toVersion: "2.0." + i } });
    const count = async () => Number((await db.query("SELECT count(*) FROM notifications WHERE user_id=$1", [learner.userId])).rows[0].count);
    expect(await count()).toBe(NOTIFICATION_LIMITS.maxPerPerson);
    // The newest stay.
    expect((await db.query("SELECT 1 FROM notifications WHERE user_id=$1 AND dedupe_key='bulk:0'", [learner.userId])).rowCount).toBe(0);
    await db.query("UPDATE notifications SET read_at=clock_timestamp()-interval '31 days' WHERE user_id=$1 AND dedupe_key IN ('bulk:10','bulk:11')", [learner.userId]);
    await notifyUser(db, { workspaceId: workspace, userId: learner.userId, audience: "learner", kind: "course_updated", dedupeKey: "bulk:new" });
    expect(await count()).toBe(NOTIFICATION_LIMITS.maxPerPerson - 1);
    const page = (await call(learner, "GET", "/api/me/notifications?limit=50")).json();
    expect(page.items).toHaveLength(50);
    // Oversized parameters and outside links are refused by the table itself.
    await expect(notifyUser(db, { workspaceId: workspace, userId: learner.userId, audience: "learner", kind: "course_updated", dedupeKey: "big", params: { x: "a".repeat(3000) } })).rejects.toThrow();
    await expect(notifyUser(db, { workspaceId: workspace, userId: learner.userId, audience: "learner", kind: "course_updated", dedupeKey: "far", link: "https://example.com" })).rejects.toThrow();
  });

  it("erasure: an enrollment's notifications go with it; account erasure removes every notification of the person", async () => {
    const learner = await person("learner"), enrollment = await enrolled(learner), second = await enrolled(await person("learner"));
    void second;
    const add = (key: string, enrollmentId: string | null) => notifyUser(db, { workspaceId: workspace, userId: learner.userId, audience: "learner", kind: "reply_ready", dedupeKey: key, enrollmentId });
    await add("a", enrollment);
    await add("b", null);
    const erased = await call(learner, "POST", `/api/enrollments/${enrollment}/erase`, { confirmation: `ERASE ${enrollment.slice(0, 8)}`, reason: "Please remove my course data." });
    expect(erased.statusCode, erased.body).toBe(200);
    expect(erased.json().counts.notifications).toBe(1);
    expect((await db.query("SELECT dedupe_key FROM notifications WHERE user_id=$1", [learner.userId])).rows).toEqual([{ dedupe_key: "b" }]);
    const account = await call(learner, "POST", "/api/account/erase", { confirmation: ACCOUNT_ERASURE_CONFIRMATION, reason: "Remove my account and data." });
    expect(account.statusCode, account.body).toBe(200);
    expect(account.json().counts["account.notifications"]).toBe(1);
    expect((await db.query("SELECT count(*)::int AS n FROM notifications WHERE user_id=$1", [learner.userId])).rows[0].n).toBe(0);
  });
});
