import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "../src/database.js";
import { createServer } from "../src/server.js";
import { issueLoginCode } from "../src/auth.js";
import { createTestDatabase, type TestDatabase } from "./test-database.js";
import { fixture } from "./fixture.js";

// Real HTTP and PostgreSQL 17: an enrollment whose stored policy state was written by an older
// version, before `refunds`, `exceptionalGrants`, `afterClosure` and a reservation's `purpose`
// existed. Every learner and staff read of it applies the schema's defaults instead of failing
// (the learner's "Saved dates unavailable" was a 500 on this route), a read never rewrites the
// stored row, and a stored state the schema rejects is reported as a server fault.
const origin = "http://localhost:4398",
  schema = "policy_shape_" + randomUUID().replaceAll("-", "");
let db: Database, app: Awaited<ReturnType<typeof createServer>>, testDatabase: TestDatabase | undefined;
let workspace: string, owner: Session, learner: Session, enrollment: string;
interface Session { userId: string; cookie: string; csrf: string }

async function session(role: string): Promise<Session> {
  const id = randomUUID();
  await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [id, "shape:" + id, role + " person"]);
  await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspace, id, role]);
  const r = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, id) } });
  return { userId: id, cookie: r.cookies.map((c) => c.name + "=" + c.value).join("; "), csrf: r.json().csrfToken };
}
const call = (who: Session, method: "GET" | "POST", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { origin, cookie: who.cookie, "x-csrf-token": who.csrf }, ...(payload === undefined ? {} : { payload: payload as object }) });
const stored = async () => (await db.query("SELECT snapshot FROM policy_states WHERE enrollment_id=$1", [enrollment])).rows[0].snapshot as Record<string, unknown>;
/** Rewrites the stored state into the shape an older version wrote: no refunds, exceptional
 * grants or closed-course allowance, and reservations without a purpose or funding record. */
async function olderShape() {
  await db.query(`UPDATE policy_states SET snapshot = (snapshot - 'refunds' - 'exceptionalGrants' - 'afterClosure')
    || jsonb_build_object('reservations', coalesce((SELECT jsonb_agg(r - 'purpose' - 'funding') FROM jsonb_array_elements(snapshot->'reservations') r), '[]'::jsonb))
    WHERE enrollment_id=$1`, [enrollment]);
}

beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false });
});
beforeEach(async () => {
  workspace = randomUUID();
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspace, "shape-" + workspace, "Stored policy shape"]);
  owner = await session("owner");
  learner = await session("learner");
  const release = (await call(owner, "POST", `/api/workspaces/${workspace}/releases`, fixture())).json().id;
  expect((await call(owner, "POST", `/api/releases/${release}/publish`)).statusCode).toBe(200);
  const started = await call(learner, "POST", "/api/enrollments", { releaseId: release });
  expect(started.statusCode, started.body).toBe(200);
  enrollment = started.json().id;
});
afterAll(async () => {
  await app?.close();
  await db?.end();
  await testDatabase?.drop();
});

describe("a policy state stored by an older version", () => {
  it("is read with the schema's defaults by the learner and staff routes", async () => {
    await olderShape();
    const before = await stored();
    expect(before).not.toHaveProperty("refunds");
    expect(before).not.toHaveProperty("exceptionalGrants");

    const policy = await call(learner, "GET", `/api/enrollments/${enrollment}/policy`);
    expect(policy.statusCode, policy.body).toBe(200);
    const body = policy.json();
    expect(body.refunds).toEqual([]);
    expect(body.exceptionalGrants).toEqual([]);
    expect(body.constraints.length).toBeGreaterThan(0);
    expect(body.coverage).toBeDefined();

    const admin = await call(owner, "GET", `/api/admin/enrollments/${enrollment}/policy`);
    expect(admin.statusCode, admin.body).toBe(200);
    expect(admin.json().refunds).toEqual([]);
    expect(admin.json().exceptionalGrants).toEqual([]);

    // The lesson snapshot and the course page read the same state.
    expect((await call(learner, "GET", `/api/enrollments/${enrollment}`)).statusCode).toBe(200);

    // Reading fills defaults in memory only; the stored row changes when a policy transition writes it.
    expect(await stored()).toEqual(before);
  });

  it("reports a stored state the schema rejects as a server fault, not a conflict", async () => {
    await db.query(`UPDATE policy_states SET snapshot = jsonb_set(snapshot, '{refunds}', '"not a list"'::jsonb) WHERE enrollment_id=$1`, [enrollment]);
    const policy = await call(learner, "GET", `/api/enrollments/${enrollment}/policy`);
    expect(policy.statusCode).toBe(500);
    expect(policy.json().error).toBe("POLICY_STATE_INVALID");
  });
});
