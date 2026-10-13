import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import { createDatabase, type Database } from "../src/database.js";
import { migrate } from "../src/migrations.js";
import { createServer } from "../src/server.js";
import { issueLoginCode } from "../src/auth.js";
import { fixture } from "./fixture.js";

const origin = "http://localhost:4383",
  schema = "people_" + randomUUID().replaceAll("-", ""),
  directory = fileURLToPath(new URL("../migrations", import.meta.url));
let root: Database, db: Database, app: Awaited<ReturnType<typeof createServer>>;
let workspace: string, owner: Session, admin: Session;
interface Session {
  userId: string;
  cookie: string;
  csrf: string;
}
async function redeem(token: string): Promise<Omit<Session, "userId"> & { status: number }> {
  const r = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token } });
  return {
    status: r.statusCode,
    cookie: r.cookies.map((c) => c.name + "=" + c.value).join("; "),
    csrf: r.statusCode === 200 ? r.json().csrfToken : "",
  };
}
async function session(role: string, workspaceId = workspace): Promise<Session> {
  const id = randomUUID();
  await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [id, "people:" + id, role + " user"]);
  await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspaceId, id, role]);
  return { userId: id, ...(await redeem(await issueLoginCode(db, id))) };
}
function call(who: Pick<Session, "cookie" | "csrf">, method: "GET" | "POST", url: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    headers: { origin, cookie: who.cookie, "x-csrf-token": who.csrf },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
}
const key = () => "k-" + randomUUID();
const base = () => `/api/admin/workspaces/${workspace}/people`;
const invite = (who: Session, body: Record<string, unknown>) =>
  call(who, "POST", base(), { displayName: "Invited person", role: "learner", idempotencyKey: key(), ...body });
const people = async (who = owner) => {
  const r = await call(who, "GET", base());
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
};
beforeAll(async () => {
  const connection = process.env.TEST_DATABASE_URL ?? "";
  const url = new URL(connection);
  if (
    process.env.DATABASE_URL ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    !/^\/course_core_(?:ci|test(?:_[a-z0-9_]+)?)$/.test(url.pathname) ||
    url.search ||
    url.hash
  )
    throw Error("Explicit disposable loopback database required");
  root = createDatabase(connection);
  await root.query("CREATE SCHEMA " + schema);
  url.searchParams.set("options", "-csearch_path=" + schema);
  db = createDatabase(url.href);
  await migrate(db, directory);
  app = await createServer(db, { origin, secureCookies: false });
});
beforeEach(async () => {
  workspace = randomUUID();
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspace, "people-" + workspace, "People"]);
  owner = await session("owner");
  admin = await session("admin");
});
afterAll(async () => {
  await app?.close();
  await db?.end();
  if (root) {
    await root.query("DROP SCHEMA " + schema + " CASCADE");
    await root.end();
  }
});

describe("workspace people administration", () => {
  it("invites a learner with a single-use code that is never replayed and lets them learn", async () => {
    const body = { displayName: "QA learner", role: "learner", idempotencyKey: key() };
    const created = await call(owner, "POST", base(), body);
    expect(created.statusCode, created.body).toBe(200);
    const { userId, signIn } = created.json();
    expect(signIn.learnerUrl).toBe(`${origin}/#signin=${signIn.code}`);
    expect(signIn.expiresInMinutes).toBe(10);
    // A replay returns the same person but never re-reveals or re-issues a code.
    const replay = await call(owner, "POST", base(), body);
    expect(replay.json()).toMatchObject({ userId, replayed: true });
    expect(replay.json().signIn).toBeUndefined();
    expect((await call(owner, "POST", base(), { ...body, displayName: "Someone else" })).json().error).toBe("IDEMPOTENCY_CONFLICT");
    const receipts = await db.query("SELECT response::text FROM people_command_receipts WHERE workspace_id=$1", [workspace]);
    for (const row of receipts.rows) expect(row.response).not.toContain(signIn.code);
    const learner = await redeem(signIn.code);
    expect(learner.status).toBe(200);
    expect((await redeem(signIn.code)).status).toBe(401);
    expect((await call(learner, "GET", base())).statusCode).toBe(403);
    const release = (await call(owner, "POST", `/api/workspaces/${workspace}/releases`, fixture())).json().id;
    expect((await call(owner, "POST", `/api/releases/${release}/publish`)).statusCode).toBe(200);
    expect((await call(learner, "POST", "/api/enrollments", { releaseId: release })).statusCode).toBe(200);
    const listed = await people();
    const person = listed.people.find((p: { userId: string }) => p.userId === userId);
    expect(person).toMatchObject({ role: "learner", enrollments: 1, canIssueSignIn: true, canRevoke: true });
    expect(listed.people.find((p: { userId: string }) => p.userId === owner.userId)).toMatchObject({ self: true, canRevoke: false, canChangeRole: false });
  });

  it("keeps privileged roles under owner control and blocks self-changes and stale edits", async () => {
    for (const role of ["owner", "admin"])
      expect((await invite(admin, { role })).json().error, role).toBe("ROLE_NOT_ASSIGNABLE");
    const author = (await invite(admin, { role: "author" })).json().userId;
    expect(author).toBeTruthy();
    const change = (who: Session, userId: string, role: string, expectedRole: string) =>
      call(who, "POST", `${base()}/${userId}/role`, { role, expectedRole, idempotencyKey: key() });
    expect((await change(admin, owner.userId, "learner", "owner")).json().error).toBe("ROLE_NOT_ASSIGNABLE");
    expect((await change(admin, author, "admin", "author")).json().error).toBe("ROLE_NOT_ASSIGNABLE");
    expect((await change(admin, admin.userId, "owner", "admin")).json().error).toBe("SELF_CHANGE_FORBIDDEN");
    expect((await change(owner, owner.userId, "learner", "owner")).json().error).toBe("SELF_CHANGE_FORBIDDEN");
    expect((await change(admin, author, "reviewer", "learner")).json().error).toBe("STALE_ROLE");
    expect((await change(admin, author, "reviewer", "author")).statusCode).toBe(200);
    expect((await change(owner, admin.userId, "reviewer", "admin")).statusCode).toBe(200);
    // The demoted admin immediately loses people administration.
    expect((await call(admin, "GET", base())).statusCode).toBe(403);
    const revoke = (who: Session, userId: string, expectedRole: string) =>
      call(who, "POST", `${base()}/${userId}/revoke`, { expectedRole, reason: "No longer part of this course team.", idempotencyKey: key() });
    expect((await revoke(owner, owner.userId, "owner")).json().error).toBe("SELF_CHANGE_FORBIDDEN");
    const other = await session("admin");
    expect((await revoke(other, owner.userId, "owner")).json().error).toBe("ROLE_NOT_ASSIGNABLE");
    const events = (await db.query("SELECT event_type FROM learning_events WHERE workspace_id=$1 AND event_type LIKE 'people.%' ORDER BY sequence", [workspace])).rows.map((r) => r.event_type);
    expect(events).toEqual(["people.invited", "people.role_changed", "people.role_changed"]);
  });

  it("issues sign-in codes only for accounts invited here that belong nowhere else", async () => {
    const learner = (await invite(owner, {})).json().userId;
    const issue = (who: Session, userId: string) => call(who, "POST", `${base()}/${userId}/sign-in`, { idempotencyKey: key() });
    const issued = await issue(admin, learner);
    expect(issued.statusCode, issued.body).toBe(200);
    expect((await redeem(issued.json().signIn.code)).status).toBe(200);
    // Bootstrap/externally created accounts and the owner are never impersonable.
    const external = await session("learner");
    expect((await issue(owner, external.userId)).json().error).toBe("SIGN_IN_NOT_ISSUABLE");
    expect((await issue(admin, owner.userId)).json().error).toBe("ROLE_NOT_ASSIGNABLE");
    // A code would also unlock another workspace: refused once the person belongs there.
    const second = randomUUID();
    await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [second, "second-" + second, "Second"]);
    await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'admin')", [second, learner]);
    expect((await issue(owner, learner)).json().error).toBe("SIGN_IN_NOT_ISSUABLE");
    // A foreign workspace's owner cannot manage this workspace at all.
    const foreign = await session("owner", second);
    expect((await call(foreign, "GET", base())).statusCode).toBe(403);
    expect((await issue(foreign, learner)).statusCode).toBe(403);
  });

  it("revokes access while retaining learning records and ending sessions with no other membership", async () => {
    const created = (await invite(owner, {})).json();
    const learner = await redeem(created.signIn.code);
    const release = (await call(owner, "POST", `/api/workspaces/${workspace}/releases`, fixture())).json().id;
    await call(owner, "POST", `/api/releases/${release}/publish`);
    const enrollment = (await call(learner, "POST", "/api/enrollments", { releaseId: release })).json().id;
    expect((await call(learner, "GET", "/api/enrollments/" + enrollment)).statusCode).toBe(200);
    const revoked = await call(admin, "POST", `${base()}/${created.userId}/revoke`, {
      expectedRole: "learner",
      reason: "Pilot participation ended by request.",
      idempotencyKey: key(),
    });
    expect(revoked.statusCode, revoked.body).toBe(200);
    expect(revoked.json()).toMatchObject({ previousRole: "learner", recordsRetained: true });
    expect((await call(learner, "GET", "/api/enrollments/" + enrollment)).statusCode).toBe(401);
    expect((await db.query("SELECT count(*)::int AS n FROM enrollments WHERE id=$1", [enrollment])).rows[0].n).toBe(1);
    expect((await people()).people.some((p: { userId: string }) => p.userId === created.userId)).toBe(false);
  });
});
