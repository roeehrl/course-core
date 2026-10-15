import { randomUUID, randomBytes } from "node:crypto";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { createDatabase, type Database } from "../src/database.js";
import { createTestDatabase, type TestDatabase } from "./test-database.js";
import { baseDatabaseUrl } from "./database-template.js";
import { createServer } from "../src/server.js";
import { issueLoginCode } from "../src/auth.js";
import { grantRuntimeAccess, assertRuntimePrivileges } from "../src/db-roles.js";
import { fixture } from "./fixture.js";

const origin = "http://localhost:4390",
  suffix = randomUUID().replaceAll("-", "").slice(0, 16),
  schema = "roles_" + suffix,
  role = "course_core_test_app_" + suffix,
  password = randomBytes(18).toString("hex");
let root: Database, owner: Database, runtime: Database, app: Awaited<ReturnType<typeof createServer>>;
let testDatabase: TestDatabase | undefined;
beforeAll(async () => {
  const connection = baseDatabaseUrl().href;
  // Roles are cluster-wide, so they are managed from the base test database.
  root = createDatabase(connection);
  testDatabase = await createTestDatabase(schema);
  await root.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
  const ownerUrl = new URL(testDatabase.url);
  owner = createDatabase(ownerUrl.href);
  await grantRuntimeAccess(owner, role);
  const runtimeUrl = new URL(ownerUrl.href);
  runtimeUrl.username = role;
  runtimeUrl.password = password;
  runtime = createDatabase(runtimeUrl.href);
  app = await createServer(runtime, { loginCodes: true, origin, secureCookies: false });
});
afterAll(async () => {
  await app?.close();
  await runtime?.end();
  await owner?.end();
  if (root) {
    // Dropping the file's database removes every grant to the role there.
    await testDatabase?.drop();
    await root.query(`DROP ROLE IF EXISTS ${role}`);
    await root.end();
  }
});

describe("least-privilege runtime database role", () => {
  it("serves real learner flows, including erasure through immutable history, without schema rights", async () => {
    await expect(assertRuntimePrivileges(runtime)).resolves.toBeUndefined();
    await expect(assertRuntimePrivileges(owner)).rejects.toThrow(/least-privilege/);
    const workspace = randomUUID();
    await runtime.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspace, "roles-" + workspace, "Roles"]);
    const sign = async (r: string) => {
      const id = randomUUID();
      await runtime.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [id, "roles:" + id, r]);
      await runtime.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspace, id, r]);
      const res = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(runtime, id) } });
      return { cookie: res.cookies.map((c) => c.name + "=" + c.value).join("; "), csrf: res.json().csrfToken };
    };
    const ownerSession = await sign("owner"), learner = await sign("learner");
    const call = (who: typeof learner, method: "GET" | "POST", url: string, payload?: unknown) =>
      app.inject({ method, url, headers: { origin, cookie: who.cookie, "x-csrf-token": who.csrf }, ...(payload === undefined ? {} : { payload: payload as object }) });
    const release = (await call(ownerSession, "POST", `/api/workspaces/${workspace}/releases`, fixture())).json().id;
    expect((await call(ownerSession, "POST", `/api/releases/${release}/publish`)).statusCode).toBe(200);
    const enrollment = (await call(learner, "POST", "/api/enrollments", { releaseId: release })).json().id;
    const send = async (action: string, body: Record<string, unknown>) => {
      const revision = (await call(learner, "GET", "/api/enrollments/" + enrollment)).json().revision;
      return call(learner, "POST", `/api/enrollments/${enrollment}/${action}`, { expectedRevision: revision, idempotencyKey: randomUUID(), ...body });
    };
    const issued = await send("challenges", { episodeId: "min", assessmentId: "min-a", mode: "independent" });
    expect((await send("answers", { challengeId: issued.json().challengeId, answer: "two" })).statusCode).toBe(200);
    expect((await send("learner-model/profile", { profile: { preferences: {}, priorKnowledge: [], thoughts: "x" } })).statusCode).toBe(200);
    // The audited view as learner (migration 030) works under the runtime grants, and its record stays append-only.
    const viewed = await call(ownerSession, "GET", `/api/admin/enrollments/${enrollment}/learner-view`);
    expect(viewed.statusCode, viewed.body).toBe(200);
    expect((await call(learner, "GET", `/api/enrollments/${enrollment}/staff-views`)).json().views).toHaveLength(1);
    await expect(runtime.query("DELETE FROM staff_learner_views WHERE enrollment_id=$1", [enrollment])).rejects.toThrow(/STAFF_VIEW_AUDIT_IMMUTABLE/);
    await expect(runtime.query("TRUNCATE staff_learner_views")).rejects.toThrow(/permission denied/);
    // A staff export (migration 038) is recorded with its role under the runtime grants and is append-only too.
    expect((await call(ownerSession, "GET", `/api/admin/enrollments/${enrollment}/export`)).statusCode).toBe(200);
    expect((await call(learner, "GET", `/api/enrollments/${enrollment}/staff-views`)).json().exports).toMatchObject([{ exporterRole: "owner" }]);
    await expect(runtime.query("UPDATE data_exports SET digest=repeat('0',64) WHERE enrollment_id=$1", [enrollment])).rejects.toThrow(/DATA_EXPORT_AUDIT_IMMUTABLE/);
    await expect(runtime.query("DELETE FROM data_exports WHERE enrollment_id=$1", [enrollment])).rejects.toThrow(/DATA_EXPORT_AUDIT_IMMUTABLE/);
    const erased = await call(learner, "POST", `/api/enrollments/${enrollment}/erase`, { confirmation: `ERASE ${enrollment.slice(0, 8)}`, reason: "Testing erasure as runtime role." });
    expect(erased.statusCode, erased.body).toBe(200);
  });
  it("refuses schema changes, truncation and new objects for the runtime role", async () => {
    for (const sql of [
      "DROP TABLE evidence",
      "ALTER TABLE evidence ADD COLUMN x int",
      "TRUNCATE learning_events",
      "CREATE TABLE smuggled(x int)",
      "DROP TRIGGER learner_model_changes_immutable ON learner_model_changes",
      "CREATE OR REPLACE FUNCTION erasure_permits(old_row jsonb) RETURNS boolean LANGUAGE sql AS 'SELECT true'",
    ])
      await expect(runtime.query(sql), sql).rejects.toThrow(/permission denied|must be owner/);
  });
});
