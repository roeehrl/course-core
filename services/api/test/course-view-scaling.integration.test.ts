import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { compileCourse } from "@course-core/sdk/compiler";
import { createDatabase, type Database } from "../src/database.js";
import { createTestDatabase, type TestDatabase } from "./test-database.js";
import { issueLoginCode } from "../src/auth.js";
import { createServer } from "../src/server.js";
import { ensureCatalog, releaseCheckStatistics } from "../src/admin-routes.js";
import type { RuntimeExtension } from "../src/publication.js";
import { fixture } from "./fixture.js";

// Regression for the course view on Core 0.1.58: GET /api/admin/courses/:id selected every
// release with both bundles (megabytes each), then re-compiled, re-digested and re-checked every
// release's server bundle on every request in one synchronous pass, so a course with a few large
// releases held the event loop for seconds per view and sign-ins waited behind it. The budgets
// below are counts (bundles read, releases checked), not times, so they do not depend on load.
const schema = `course_view_${randomUUID().replaceAll("-", "")}`, origin = "http://127.0.0.1:4381";
const RELEASES = 6;
let testDatabase: TestDatabase, db: Database, app: Awaited<ReturnType<typeof createServer>>;
let catalogId: string, cookie: string;
const installed: RuntimeExtension[] = [];
const releaseIds: string[] = [];

/** Rows carrying a bundle column that the API received from PostgreSQL. */
const bundles = { server: 0, learner: 0 };
const query = pg.Client.prototype.query;
vi.spyOn(pg.Client.prototype, "query").mockImplementation(function (this: pg.Client, ...args: unknown[]) {
  const result = (query as (...a: unknown[]) => unknown).apply(this, args);
  if (result && typeof (result as Promise<unknown>).then === "function")
    void (result as Promise<pg.QueryResult>).then((value) => {
      for (const row of value?.rows ?? []) {
        if (row && typeof row === "object" && "server_bundle" in row) bundles.server++;
        if (row && typeof row === "object" && "learner_bundle" in row) bundles.learner++;
      }
    }, () => undefined);
  return result as never;
} as never);

async function counted(work: () => Promise<unknown>) {
  const before = releaseCheckStatistics(), server = bundles.server, learner = bundles.learner;
  const value = await work();
  const after = releaseCheckStatistics();
  return { value, computed: after.computed - before.computed, reused: after.reused - before.reused,
    serverBundles: bundles.server - server, learnerBundles: bundles.learner - learner };
}
async function view() {
  const response = await app.inject({ url: `/api/admin/courses/${catalogId}`, headers: { cookie, origin } });
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as { course: { objectives: string[] }; releases: { id: string; version: string; checks: unknown[] }[] };
}

beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false, installedExtensions: installed });
  const workspaceId = randomUUID(), userId = randomUUID();
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,'course-view','Course view')", [workspaceId]);
  await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,'Synthetic owner')", [userId, `course-view:${userId}`]);
  await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'owner')", [workspaceId, userId]);
  const login = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, userId) } });
  expect(login.statusCode, login.body).toBe(200);
  cookie = login.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  for (let i = 0; i < RELEASES; i++) {
    const compiled = compileCourse({ ...fixture(), version: `1.0.${i}` }), id = randomUUID();
    await db.query(
      `INSERT INTO course_releases(id,workspace_id,course_key,version,digest,server_bundle,learner_bundle,status,created_by,created_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now()+($10 * interval '1 second'))`,
      [id, workspaceId, compiled.server.id, compiled.server.version, compiled.digest, JSON.stringify(compiled.server),
        JSON.stringify(compiled.learner), i === 0 ? "published" : "draft", userId, i],
    );
    catalogId = await ensureCatalog(db, id);
    releaseIds.push(id);
  }
}, 30000);
afterAll(async () => {
  vi.restoreAllMocks();
  await app?.close();
  await db?.end();
  await testDatabase?.drop();
});

describe("course view cost", () => {
  it("checks each release once, never reads a learner bundle, and then reads no bundle at all", async () => {
    const cold = await counted(view);
    expect(cold.computed).toBe(RELEASES);
    expect(cold.serverBundles).toBe(RELEASES);
    expect(cold.learnerBundles).toBe(0);
    const warm = await counted(view);
    expect({ computed: warm.computed, reused: warm.reused, serverBundles: warm.serverBundles, learnerBundles: warm.learnerBundles })
      .toEqual({ computed: 0, reused: RELEASES, serverBundles: 0, learnerBundles: 0 });
    // The same answer either way: every release, newest first, with its checks and the newest one's objectives.
    expect(warm.value).toEqual(cold.value);
    const shown = cold.value as Awaited<ReturnType<typeof view>>;
    expect(shown.releases.map((r) => r.version)).toEqual(Array.from({ length: RELEASES }, (_, i) => `1.0.${RELEASES - 1 - i}`));
    expect(shown.releases.every((r) => r.checks.length > 0)).toBe(true);
    expect(shown.course.objectives).toEqual(fixture().objectives.map((o) => o.description));
  });
  it("re-checks exactly the release whose row changed, and every release when the installed extensions change", async () => {
    await view();
    await db.query("UPDATE course_releases SET status=status WHERE id=$1", [releaseIds[2]]);
    const changed = await counted(view);
    expect({ computed: changed.computed, serverBundles: changed.serverBundles, learnerBundles: changed.learnerBundles })
      .toEqual({ computed: 1, serverBundles: 1, learnerBundles: 0 });
    installed.push({ id: "course-view-test-extension", version: "1.0.0", integrity: "sha256-test", capabilities: [], platforms: ["web"] });
    try {
      const extended = await counted(view);
      expect(extended.computed).toBe(RELEASES);
    } finally { installed.pop(); }
  });
  it("the course overview reads no bundle once the active release's checks are known", async () => {
    await view();
    const overview = await counted(async () => {
      const response = await app.inject({ url: `/api/admin/courses/${catalogId}/overview`, headers: { cookie, origin } });
      expect(response.statusCode, response.body).toBe(200);
    });
    expect({ computed: overview.computed, serverBundles: overview.serverBundles, learnerBundles: overview.learnerBundles })
      .toEqual({ computed: 0, serverBundles: 0, learnerBundles: 0 });
  });
});
