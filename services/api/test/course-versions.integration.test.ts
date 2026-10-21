import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "../src/database.js";
import { createTestDatabase, type TestDatabase } from "./test-database.js";
import { createServer } from "../src/server.js";
import { issueLoginCode } from "../src/auth.js";
import { newestVersion } from "../src/course-versions.js";
import { fixture } from "./fixture.js";

// Real HTTP and PostgreSQL 17: course versions move forward (K13). Publishing a version lower than
// one already published needs an explicit confirmation on both publication routes, and is audited.
const origin = "http://localhost:4396",
  schema = "course_versions_" + randomUUID().replaceAll("-", "");
let db: Database, app: Awaited<ReturnType<typeof createServer>>, testDatabase: TestDatabase | undefined;
let workspace: string;
interface Session { userId: string; cookie: string; csrf: string }
const sessions: Record<string, Session> = {};

async function session(role: string): Promise<Session> {
  const id = randomUUID();
  await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [id, "versions:" + id, role + " person"]);
  await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspace, id, role]);
  const r = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, id) } });
  expect(r.statusCode, r.body).toBe(200);
  return { userId: id, cookie: r.cookies.map((c) => c.name + "=" + c.value).join("; "), csrf: r.json().csrfToken };
}
const call = (who: Session, method: "GET" | "POST", url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method, url, headers: { origin, cookie: who.cookie, "x-csrf-token": who.csrf, ...headers }, ...(payload === undefined ? {} : { payload: payload as object }) });
const course = (id: string, version: string) => ({ ...fixture(), id, version });
async function imported(id: string, version: string) {
  const r = await call(sessions.owner!, "POST", `/api/workspaces/${workspace}/releases`, course(id, version));
  expect(r.statusCode, r.body).toBe(200);
  return r.json().id as string;
}
const status = async (releaseId: string) => (await db.query("SELECT status FROM course_releases WHERE id=$1", [releaseId])).rows[0].status as string;

beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false });
  workspace = randomUUID();
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspace, "versions-" + workspace, "Versions"]);
  for (const role of ["owner", "author", "reviewer"]) sessions[role] = await session(role);
}, 60000);
afterAll(async () => {
  await app?.close();
  await db?.end();
  await testDatabase?.drop();
});

describe("course version direction at publication", () => {
  it("compares semantic versions, ignoring legacy values", () => {
    expect(newestVersion(["1.2.0", "1.10.0", "1.9.9", "2.0.0-rc.1", "legacy"])).toBe("2.0.0-rc.1");
    expect(newestVersion(["2.0.0-rc.1", "2.0.0"])).toBe("2.0.0");
    expect(newestVersion(["legacy"])).toBeNull();
  });

  it("publishes newer versions freely and refuses an older one unless explicitly confirmed", async () => {
    const v2 = await imported("direction", "2.0.0");
    expect((await call(sessions.owner!, "POST", `/api/releases/${v2}/publish`)).statusCode).toBe(200);
    const v21 = await imported("direction", "2.1.0");
    expect((await call(sessions.owner!, "POST", `/api/releases/${v21}/publish`)).statusCode).toBe(200);
    const v15 = await imported("direction", "1.5.0");
    const refused = await call(sessions.owner!, "POST", `/api/releases/${v15}/publish`);
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json()).toMatchObject({ error: "PUBLISH_VERSION_OLDER_THAN_PUBLISHED", details: { version: "1.5.0", newestPublished: "2.1.0" } });
    expect(await status(v15)).toBe("draft");
    // Only an explicit true confirms; anything else is a malformed request.
    for (const payload of [{ confirmOlderVersion: false }, { confirmOlderVersion: "yes" }, { other: true }])
      expect((await call(sessions.owner!, "POST", `/api/releases/${v15}/publish`, payload)).statusCode, JSON.stringify(payload)).toBe(400);
    expect(await status(v15)).toBe("draft");
    const confirmed = await call(sessions.owner!, "POST", `/api/releases/${v15}/publish`, { confirmOlderVersion: true });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    expect(await status(v15)).toBe("published");
    const event = (await db.query("SELECT payload FROM learning_events WHERE workspace_id=$1 AND event_type='course.published' AND payload->>'releaseId'=$2", [workspace, v15])).rows[0];
    expect(event.payload).toMatchObject({ olderVersionConfirmed: true, newestPublished: "2.1.0" });
    // Another course's versions do not count.
    const other = await imported("direction-other", "0.1.0");
    expect((await call(sessions.owner!, "POST", `/api/releases/${other}/publish`)).statusCode).toBe(200);
  });

  it("an archived release still counts as published", async () => {
    const v3 = await imported("archived-course", "3.0.0");
    expect((await call(sessions.owner!, "POST", `/api/releases/${v3}/publish`)).statusCode).toBe(200);
    await db.query("UPDATE course_releases SET status='archived' WHERE id=$1", [v3]);
    const v1 = await imported("archived-course", "1.0.0");
    expect((await call(sessions.owner!, "POST", `/api/releases/${v1}/publish`)).json().error).toBe("PUBLISH_VERSION_OLDER_THAN_PUBLISHED");
  });

  it("the reviewed administration publish refuses an older version until confirmed, and audits it", async () => {
    const v2 = await imported("reviewed", "2.0.0");
    expect((await call(sessions.owner!, "POST", `/api/releases/${v2}/publish`)).statusCode).toBe(200);
    const catalogId = (await db.query("SELECT id FROM admin_course_catalog WHERE workspace_id=$1 AND course_key='reviewed'", [workspace])).rows[0].id as string;
    const path = `/api/admin/courses/${catalogId}`;
    const mutate = async (who: Session, suffix: string, payload: unknown) => {
      const revision = (await call(who, "GET", path)).json().revision as string;
      return call(who, "POST", path + suffix, payload, { "if-match": revision, "idempotency-key": randomUUID() });
    };
    const created = await mutate(sessions.author!, "/releases", { version: "1.9.0", notes: "Back-port of an older version." });
    expect(created.statusCode, created.body).toBe(200);
    const id = created.json().workspace.releases.find((r: { version: string }) => r.version === "1.9.0").id as string;
    expect((await mutate(sessions.author!, `/releases/${id}/transitions`, { action: "submit-review" })).statusCode).toBe(200);
    expect((await mutate(sessions.reviewer!, `/releases/${id}/transitions`, { action: "approve" })).statusCode).toBe(200);
    const refused = await mutate(sessions.owner!, `/releases/${id}/transitions`, { action: "publish" });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().error).toBe("PUBLISH_VERSION_OLDER_THAN_PUBLISHED");
    expect((await mutate(sessions.owner!, `/releases/${id}/transitions`, { action: "publish", confirmOlderVersion: false })).statusCode).toBe(400);
    expect(await status(id)).toBe("draft");
    const published = await mutate(sessions.owner!, `/releases/${id}/transitions`, { action: "publish", confirmOlderVersion: true });
    expect(published.statusCode, published.body).toBe(200);
    expect(await status(id)).toBe("published");
    const audit = (await db.query("SELECT payload FROM learning_events WHERE workspace_id=$1 AND event_type='release.older_version_published'", [workspace])).rows;
    expect(audit.map((row) => row.payload)).toEqual([expect.objectContaining({ releaseId: id, version: "1.9.0", newestPublished: "2.0.0" })]);
  });
});
