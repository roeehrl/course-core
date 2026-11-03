import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compileCourse } from "@course-core/sdk/compiler";
import type { CourseManifest } from "@course-core/sdk";
import { createDatabase, type Database } from "../src/database.js";
import { createTestDatabase, type TestDatabase } from "./test-database.js";
import { issueLoginCode } from "../src/auth.js";
import { createServer } from "../src/server.js";
import { ensureCatalog, releaseCheckRunner, releaseCheckStatistics } from "../src/admin-routes.js";
import type { RuntimeExtension } from "../src/publication.js";
import { largeCourse } from "./large-course-fixture.js";

// Regression for the first admin course view after an install. Importing a release ran none of
// its checks, so GET /api/admin/courses/:id ran every visual check of the course cold, inside
// its request and its database transaction: about 4 s on 16 cores and over 15 s on a 2-vCPU CI
// runner for a real 57-scene course. The view now answers from recorded checks only; checks not
// recorded yet run in the background, on their own connection and outside any transaction, and
// the view shows those releases as checking. A stub renderer makes the check's timing explicit.
const schema = `cold_checks_${randomUUID().replaceAll("-", "")}`, origin = "http://127.0.0.1:4382";
const VISUALS = 4;
let testDatabase: TestDatabase, db: Database, workspaceId: string, ownerId: string, headers: Record<string, string>;
const servers: Awaited<ReturnType<typeof createServer>>[] = [];

/** Lets a test hold every visual check until it opens the gate. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { opened, open };
}
/** A stub of the installed SVG renderer whose (off-thread) visual checks a test controls. */
function stubRenderer() {
  const stub = {
    gate: gate(),
    prepared: 0,
    validated: 0,
    invalid: new Set<string>(),
    /** Sessions of this database left inside a transaction while a check was running. */
    openTransactions: [] as number[],
    extension: undefined as unknown as RuntimeExtension,
  };
  stub.extension = {
    id: "course-core-svg-v1", version: "9.9.9", integrity: `sha256-${"5".repeat(64)}`, capabilities: ["visual.render"], platforms: ["web"],
    prepareVisuals: async () => {
      stub.prepared++;
      await stub.gate.opened;
      stub.openTransactions.push((await db.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND state LIKE 'idle in transaction%'")).rows[0]!.n);
    },
    validateVisual: (visual) => {
      stub.validated++;
      if (stub.invalid.has(visual.id)) throw Object.assign(new Error("invalid scene"), { code: "SCENE_INVALID" });
    },
  };
  return stub;
}
async function server(stub: ReturnType<typeof stubRenderer>, releaseCheckWaitMs: number) {
  const app = await createServer(db, { loginCodes: true, origin, secureCookies: false, installedExtensions: [stub.extension], releaseCheckWaitMs });
  servers.push(app);
  return app;
}
function course(renderer: RuntimeExtension): CourseManifest {
  return largeCourse(`cold-${randomUUID().slice(0, 8)}`, renderer, VISUALS);
}
async function catalogOf(releaseId: string) {
  return (await db.query<{ catalog_id: string }>("SELECT catalog_id FROM admin_release_reviews WHERE release_id=$1", [releaseId])).rows[0]!.catalog_id;
}
type View = { revision: string; releases: { id: string; checking: boolean; checks: { code: string; passed: boolean; params?: Record<string, string> }[] }[] };
async function view(app: Awaited<ReturnType<typeof createServer>>, catalogId: string) {
  const start = performance.now();
  const response = await app.inject({ url: `/api/admin/courses/${catalogId}`, headers });
  expect(response.statusCode, response.body).toBe(200);
  return { body: response.json() as View, ms: performance.now() - start };
}

beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  workspaceId = randomUUID();
  const userId = (ownerId = randomUUID());
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,'cold-checks','Cold checks')", [workspaceId]);
  await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,'Synthetic owner')", [userId, `cold-checks:${userId}`]);
  await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'owner')", [workspaceId, userId]);
  const app = await createServer(db, { loginCodes: true, origin, secureCookies: false });
  const login = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, userId) } });
  expect(login.statusCode, login.body).toBe(200);
  headers = { origin, cookie: login.cookies.map((c) => `${c.name}=${c.value}`).join("; "), "x-csrf-token": login.json().csrfToken as string };
  await app.close();
}, 30000);
afterAll(async () => {
  for (const app of servers) await app.close();
  await db?.end();
  await testDatabase?.drop();
});

describe("the first course view after an import", () => {
  it("answers at once with the release checking, runs its checks once in the background, then shows them", async () => {
    const stub = stubRenderer(), app = await server(stub, 0);
    const imported = await app.inject({ method: "POST", url: `/api/workspaces/${workspaceId}/releases`, headers, payload: course(stub.extension) });
    expect(imported.statusCode, imported.body).toBe(200);
    const releaseId = imported.json().id as string, catalogId = await catalogOf(releaseId);
    const before = releaseCheckStatistics();
    // The import queued the checks after its commit; they are held at the gate. Views neither
    // wait for them nor run any check themselves, and asking again queues nothing new.
    const first = await Promise.all([view(app, catalogId), view(app, catalogId), view(app, catalogId)]);
    for (const { body } of first) expect(body.releases).toEqual([expect.objectContaining({ id: releaseId, checking: true, checks: [] })]);
    expect(stub.validated).toBe(0);
    expect(stub.prepared).toBe(1);
    stub.gate.open();
    await releaseCheckRunner(db).idle();
    expect(releaseCheckStatistics().computed - before.computed).toBe(1);
    // Every visual was checked once, and no transaction was open while the checks ran.
    expect(stub.validated).toBe(VISUALS);
    expect(stub.openTransactions).toEqual([0]);
    const later = await view(app, catalogId);
    expect(later.body.releases[0]).toMatchObject({ checking: false, checks: expect.arrayContaining([{ code: "RUNTIME_SUPPORTED", passed: true }]) });
    expect(stub.validated).toBe(VISUALS);
  });

  it("when the view waits for checks, it waits after its transaction has ended", async () => {
    const stub = stubRenderer(), app = await server(stub, 60_000);
    // Stored directly, as by an older server or a restore: nothing has checked it in this process.
    const compiled = compileCourse(course(stub.extension)), releaseId = randomUUID();
    await db.query(`INSERT INTO course_releases(id,workspace_id,course_key,version,digest,server_bundle,learner_bundle,status,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,'draft',$8)`, [releaseId, workspaceId, compiled.server.id, compiled.server.version, compiled.digest,
      JSON.stringify(compiled.server), JSON.stringify(compiled.learner), ownerId]);
    const catalogId = await ensureCatalog(db, releaseId);
    stub.gate.open();
    const shown = await view(app, catalogId);
    expect(shown.body.releases[0]).toMatchObject({ id: releaseId, checking: false, checks: expect.arrayContaining([{ code: "RUNTIME_SUPPORTED", passed: true }]) });
    expect(stub.prepared).toBe(1);
    expect(stub.openTransactions).toEqual([0]);
  });

  it("a release still being checked cannot enter review unless it passes, and its failure is shown once known", async () => {
    const stub = stubRenderer(), app = await server(stub, 0), manifest = course(stub.extension);
    stub.invalid.add(manifest.visuals[1]!.id);
    const imported = await app.inject({ method: "POST", url: `/api/workspaces/${workspaceId}/releases`, headers, payload: manifest });
    expect(imported.statusCode, imported.body).toBe(200);
    const releaseId = imported.json().id as string, catalogId = await catalogOf(releaseId);
    const shown = await view(app, catalogId);
    expect(shown.body.releases[0]).toMatchObject({ checking: true, checks: [] });
    stub.gate.open();
    // The transition runs the release's checks itself, whatever the view showed.
    const refused = await app.inject({ method: "POST", url: `/api/admin/courses/${catalogId}/releases/${releaseId}/transitions`,
      headers: { ...headers, "if-match": shown.body.revision, "idempotency-key": randomUUID() }, payload: { action: "submit-review" } });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json()).toMatchObject({ error: "PUBLISH_VISUAL_INVALID" });
    expect((await db.query("SELECT state FROM admin_release_reviews WHERE release_id=$1", [releaseId])).rows[0].state).toBe("draft");
    await releaseCheckRunner(db).idle();
    const known = await view(app, catalogId);
    expect(known.body.releases[0]).toMatchObject({ checking: false,
      checks: expect.arrayContaining([{ code: "RUNTIME_UNSUPPORTED", passed: false, params: { reason: "PUBLISH_VISUAL_INVALID" } }]) });
  });

  it("the course overview says the live release is still being checked rather than listing no defects", async () => {
    const stub = stubRenderer(), app = await server(stub, 0);
    const compiled = compileCourse(course(stub.extension)), releaseId = randomUUID();
    await db.query(`INSERT INTO course_releases(id,workspace_id,course_key,version,digest,server_bundle,learner_bundle,status,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,'published',$8)`, [releaseId, workspaceId, compiled.server.id, compiled.server.version, compiled.digest,
      JSON.stringify(compiled.server), JSON.stringify(compiled.learner), ownerId]);
    const catalogId = await ensureCatalog(db, releaseId);
    await db.query("UPDATE admin_course_catalog SET active_release_id=$2 WHERE id=$1", [catalogId, releaseId]);
    const overview = async () => {
      const response = await app.inject({ url: `/api/admin/courses/${catalogId}/overview`, headers });
      expect(response.statusCode, response.body).toBe(200);
      return response.json().contentDefects as { activeReleaseChecking: boolean; activeReleaseChecksFailing: unknown[] };
    };
    expect(await overview()).toMatchObject({ activeReleaseChecking: true, activeReleaseChecksFailing: [] });
    stub.gate.open();
    await releaseCheckRunner(db).idle();
    expect(await overview()).toMatchObject({ activeReleaseChecking: false, activeReleaseChecksFailing: [] });
  });
});
