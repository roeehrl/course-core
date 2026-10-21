import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SDK_VERSION } from "@course-core/sdk";
import { createDatabase, type Database } from "../src/database.js";
import { createTestDatabase, type TestDatabase } from "./test-database.js";
import { createServer } from "../src/server.js";
import { issueLoginCode } from "../src/auth.js";
import { hostInventory } from "../src/host-inventory.js";
import { repositoryCoreVersion, supportedSdkRange } from "../src/course-package-routes.js";
import { svgRenderer } from "../src/svg-renderer.js";
import { declarativeActivityRuntime } from "../src/activity-runtime.js";
import type { RuntimeExtension } from "../src/publication.js";

// Real HTTP and PostgreSQL 17: the host inventory an author passes to the SDK's `course compat`
// (K12). Owners and admins download it; it is audited; it carries no workspace data or secrets.
const origin = "http://localhost:4393",
  schema = "host_inventory_" + randomUUID().replaceAll("-", "");
let db: Database, app: Awaited<ReturnType<typeof createServer>>, testDatabase: TestDatabase | undefined;
let workspace: string, installed: RuntimeExtension[];
interface Session { userId: string; cookie: string; csrf: string }

async function person(role: string): Promise<Session> {
  const id = randomUUID();
  await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [id, "inventory:" + id, role + " person"]);
  await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspace, id, role]);
  const r = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, id) } });
  return { userId: id, cookie: r.cookies.map((c) => c.name + "=" + c.value).join("; "), csrf: r.json().csrfToken };
}
const download = (who: Session | null, id = workspace) =>
  app.inject({ method: "GET", url: `/api/admin/workspaces/${id}/host-inventory`, headers: { origin, ...(who ? { cookie: who.cookie } : {}) } });

beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  installed = [await svgRenderer(), declarativeActivityRuntime()];
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false, installedExtensions: installed });
}, 30000);
beforeEach(async () => {
  workspace = randomUUID();
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspace, "inv-" + workspace, "Inventory"]);
});
afterAll(async () => {
  await app?.close();
  await db?.end();
  await testDatabase?.drop();
});

describe("host inventory (K12)", () => {
  it("an owner or admin downloads the SDK host inventory of this Core, and the download is audited", async () => {
    for (const role of ["owner", "admin"]) {
      const who = await person(role);
      const response = await download(who);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.headers["content-disposition"]).toBe(`attachment; filename="host-inventory-${repositoryCoreVersion()}.json"`);
      expect(response.headers["cache-control"]).toBe("no-store");
      const inventory = response.json();
      expect(inventory).toEqual(hostInventory(installed));
      expect(inventory).toMatchObject({ hostInventoryFormat: 1, coreVersion: repositoryCoreVersion(), sdk: { version: SDK_VERSION, supported: supportedSdkRange() }, platformAdapters: [] });
      const svg = installed[0]!;
      expect(inventory.renderers).toEqual([expect.objectContaining({ rendererId: svg.id, version: svg.version, targets: expect.arrayContaining(["web_desktop", "web_mobile"]) })]);
      expect(inventory.renderers[0].features).toEqual(expect.arrayContaining(["clip", "gradient", "image"]));
      expect(inventory.extensions).toEqual(expect.arrayContaining([{ id: svg.id, version: svg.version, integrity: svg.integrity }]));
      expect(inventory.capabilities).toEqual(expect.arrayContaining(["visual.render", "observation.emit"]));
      // Older builds Core still serves, with their own (smaller) feature sets.
      expect(inventory.servedPriorBuilds).toContainEqual({ id: svg.id, version: "0.1.0", integrity: expect.any(String), features: ["gradient", "path_draw"] });
      // Installed builds and capability names only: no workspace, people or host paths.
      expect(response.body).not.toContain(workspace);
      expect(response.body).not.toMatch(/\/Users\/|\/home\/|\/private\/|sk-|serviceToken/);
      const audit = (await db.query("SELECT actor_id,payload FROM learning_events WHERE workspace_id=$1 AND event_type='host_inventory.exported' AND actor_id=$2", [workspace, who.userId])).rows;
      expect(audit).toEqual([{ actor_id: who.userId, payload: { coreVersion: inventory.coreVersion, sdkVersion: SDK_VERSION, extensions: inventory.extensions.length, digest: response.headers["x-export-digest"] } }]);
    }
  });
  it("is refused to other roles, to members of another workspace and to anonymous callers, and records nothing", async () => {
    for (const role of ["author", "reviewer", "instructor", "support_observer", "learner"]) {
      expect((await download(await person(role))).statusCode, role).toBe(403);
    }
    expect((await download(null)).statusCode).toBe(401);
    const owner = await person("owner");
    const other = randomUUID();
    await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [other, "inv-" + other, "Other"]);
    expect((await download(owner, other)).statusCode).toBe(403);
    expect((await download(owner, "not-a-uuid")).statusCode).toBe(400);
    expect((await db.query("SELECT 1 FROM learning_events WHERE event_type='host_inventory.exported' AND workspace_id=ANY($1)", [[workspace, other]])).rowCount).toBe(0);
  });
});
