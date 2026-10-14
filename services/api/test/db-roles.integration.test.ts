import { randomUUID, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { createDatabase, type Database } from "../src/database.js";
import { migrate } from "../src/migrations.js";
import { createServer } from "../src/server.js";
import { issueLoginCode } from "../src/auth.js";
import { grantRuntimeAccess, assertRuntimePrivileges } from "../src/db-roles.js";
import { fixture } from "./fixture.js";

const origin = "http://localhost:4390",
  suffix = randomUUID().replaceAll("-", "").slice(0, 16),
  schema = "roles_" + suffix,
  role = "course_core_test_app_" + suffix,
  password = randomBytes(18).toString("hex"),
  directory = fileURLToPath(new URL("../migrations", import.meta.url));
let root: Database, owner: Database, runtime: Database, app: Awaited<ReturnType<typeof createServer>>;
beforeAll(async () => {
  const connection = process.env.TEST_DATABASE_URL ?? "";
  const url = new URL(connection);
  if (process.env.DATABASE_URL || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !/^\/course_core_(?:ci|test(?:_[a-z0-9_]+)?)$/.test(url.pathname) || url.search || url.hash)
    throw Error("Explicit disposable loopback database required");
  root = createDatabase(connection);
  await root.query("CREATE SCHEMA " + schema);
  await root.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
  const ownerUrl = new URL(url.href);
  ownerUrl.searchParams.set("options", "-csearch_path=" + schema);
  owner = createDatabase(ownerUrl.href);
  await migrate(owner, directory);
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
    await root.query("DROP SCHEMA IF EXISTS " + schema + " CASCADE");
    await root.query(`DROP OWNED BY ${role}`).catch(() => undefined);
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
