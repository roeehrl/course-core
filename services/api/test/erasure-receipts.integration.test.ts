import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "../src/database.js";
import { createServer } from "../src/server.js";
import { issueLoginCode } from "../src/auth.js";
import { migrate } from "../src/migrations.js";
import { digestJson } from "../src/repository.js";
import { throttleKey } from "../src/passwords.js";
import { ERASED_DIGEST } from "../src/erased-digests.js";
import { ACCOUNT_ERASURE_CONFIRMATION } from "../src/account-erasure.js";
import { createTestDatabase, type TestDatabase } from "./test-database.js";
import { fixture } from "./fixture.js";

// Two places kept personal data past erasure. Course admin command receipts stored the whole
// admin workspace view (every learner's profile and evidence review notes) as their replay
// response. People administration receipts and events kept an erased account's login name and
// revocation reason, and digests over its display and login name.

const origin = "http://localhost:4388",
  schema = "erasure_receipts_" + randomUUID().replaceAll("-", "");
const migrations = fileURLToPath(new URL("../migrations", import.meta.url));
let db: Database, app: Awaited<ReturnType<typeof createServer>>, testDatabase: TestDatabase | undefined;
let workspace: string, catalog: string, release: string, owner: Session;
interface Session { userId: string; cookie: string; csrf: string }

async function signIn(id: string): Promise<Session> {
  const r = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, id) } });
  expect(r.statusCode, r.body).toBe(200);
  return { userId: id, cookie: r.cookies.map((c) => c.name + "=" + c.value).join("; "), csrf: r.json().csrfToken };
}
async function session(role: string, inWorkspace = workspace): Promise<Session> {
  const id = randomUUID();
  await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [id, "receipts:" + id, role + " person"]);
  await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [inWorkspace, id, role]);
  return signIn(id);
}
function call(who: Session, method: "GET" | "POST" | "PATCH", url: string, payload?: unknown, headers: Record<string, string> = {}) {
  return app.inject({ method, url, headers: { origin, cookie: who.cookie, "x-csrf-token": who.csrf, ...headers }, ...(payload === undefined ? {} : { payload: payload as object }) });
}
/** Tables (as `table:rows`) whose rows contain `needle` anywhere, in any column. */
async function tablesContaining(needle: string) {
  const tables = (await db.query("SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() AND table_type='BASE TABLE'")).rows.map((r) => r.table_name as string);
  const hits: string[] = [];
  for (const table of tables) {
    const n = (await db.query(`SELECT count(*)::int AS n FROM "${table}" t WHERE t::text LIKE $1`, ["%" + needle + "%"])).rows[0].n;
    if (n) hits.push(`${table}:${n}`);
  }
  return hits;
}
const canary = (label: string) => `${label}${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const snapshot = async () => (await call(owner, "GET", `/api/admin/courses/${catalog}`)).json();
/** A course command through the admin API with fresh revision and key headers. */
async function adminCommand(method: "POST" | "PATCH", path: string, body: unknown, key: string = randomUUID()) {
  const r = await call(owner, method, `/api/admin/courses/${catalog}${path}`, body, { "if-match": String((await snapshot()).revision), "idempotency-key": key });
  expect(r.statusCode, r.body).toBe(200);
  return { key, response: r };
}
const replay = (method: "POST" | "PATCH", path: string, body: unknown, key: string, revision: string) =>
  call(owner, method, `/api/admin/courses/${catalog}${path}`, body, { "if-match": revision, "idempotency-key": key });

async function learnerWithEvidence() {
  const learner = await session("learner");
  const enrollment = (await call(learner, "POST", "/api/enrollments", { releaseId: release })).json().id as string;
  const command = async (action: string, body: Record<string, unknown>) => {
    const revision = (await call(learner, "GET", "/api/enrollments/" + enrollment)).json().revision;
    const r = await call(learner, "POST", `/api/enrollments/${enrollment}/${action}`, { expectedRevision: revision, idempotencyKey: randomUUID(), ...body });
    expect(r.statusCode, action + " " + r.body).toBe(200);
    return r.json();
  };
  await command("read", { episodeId: "min", blockId: "min-text" });
  const challenge = await command("challenges", { episodeId: "min", assessmentId: "min-b", mode: "independent" });
  await command("answers", { challengeId: challenge.challengeId, answer: 4 });
  const evidence = (await db.query("SELECT id FROM evidence WHERE enrollment_id=$1", [enrollment])).rows[0].id as string;
  return { learner, enrollment, evidence };
}

beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false });
});
beforeEach(async () => {
  workspace = randomUUID();
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspace, "receipts-" + workspace, "Receipts"]);
  owner = await session("owner");
  release = (await call(owner, "POST", `/api/workspaces/${workspace}/releases`, fixture())).json().id;
  await call(owner, "POST", `/api/releases/${release}/publish`);
  catalog = (await call(owner, "GET", "/api/admin/session")).json().courses.find((c: { workspaceId?: string }) => !c.workspaceId || c.workspaceId === workspace).id;
});
afterAll(async () => {
  await app?.close();
  await db?.end();
  await testDatabase?.drop();
});

describe("course admin command receipts", () => {
  it("store no workspace view, so no learner's profile or review note outlives erasure in them", async () => {
    const { enrollment, evidence } = await learnerWithEvidence();
    const name = canary("Name "), goal = canary("Goal "), note = canary("Note ");
    const enrollmentRevision = () => snapshot().then((s) => s.enrollments.find((e: { id: string }) => e.id === enrollment).revision as number);
    await adminCommand("PATCH", `/enrollments/${enrollment}/profile`, { profile: { displayName: name, goal, pace: "steady" }, enrollmentRevision: await enrollmentRevision() });
    await adminCommand("POST", `/enrollments/${enrollment}/evidence/${evidence}/review`, { decision: "accept", note, enrollmentRevision: await enrollmentRevision() });
    // A command about the course, not the learner: its reply lists the learner as they are now.
    const course = { title: "Receipts course", description: "Renamed." };
    const renamed = await adminCommand("PATCH", "", course);
    expect(renamed.response.body).toContain(name);
    expect(renamed.response.body).toContain("Review: " + note);

    // The verified leak: before this change every receipt here held the whole view, and the last
    // one held the learner's name, goal and review note.
    const stored = (await db.query("SELECT response FROM admin_command_receipts WHERE catalog_id=$1", [catalog])).rows.map((r) => r.response);
    expect(stored).toHaveLength(3);
    for (const response of stored) {
      expect(Object.keys(response).sort()).toEqual(["message", "receipt"]);
      for (const needle of [name, goal, note]) expect(JSON.stringify(response)).not.toContain(needle);
    }

    // A replay answers as the command did: same receipt, the workspace as it is.
    const revision = String((await snapshot()).revision);
    const again = await replay("PATCH", "", course, renamed.key, revision);
    expect(again.statusCode, again.body).toBe(200);
    expect(again.body).toBe(renamed.response.body);

    const erased = await call(owner, "POST", `/api/admin/enrollments/${enrollment}/erase`, {
      confirmation: `ERASE ${enrollment.slice(0, 8)}`, reason: "Learner asked for their course data to be removed.",
    });
    expect(erased.statusCode, erased.body).toBe(200);
    for (const needle of [name, goal, note]) expect(await tablesContaining(needle), needle).toEqual([]);
    // After erasure the same replay still answers, without the erased learner's details.
    const afterErasure = await replay("PATCH", "", course, renamed.key, revision);
    expect(afterErasure.statusCode, afterErasure.body).toBe(200);
    expect(afterErasure.json().receipt).toEqual(renamed.response.json().receipt);
    for (const needle of [name, goal, note]) expect(afterErasure.body).not.toContain(needle);
  });

  it("a receipt still holding a stored view (written before migration 069) replays with the current view, not the stored one", async () => {
    const course = { title: "Legacy receipt", description: "" };
    const first = await adminCommand("PATCH", "", course);
    const stale = canary("Stale ");
    await db.query("UPDATE admin_command_receipts SET response=response||$3::jsonb WHERE catalog_id=$1 AND idempotency_key=$2",
      [catalog, first.key, JSON.stringify({ workspace: { enrollments: [{ profile: { displayName: stale } }] } })]);
    const again = await replay("PATCH", "", course, first.key, String((await snapshot()).revision));
    expect(again.statusCode, again.body).toBe(200);
    expect(again.body).not.toContain(stale);
    expect(again.body).toBe(first.response.body);
    // A different request under the same key is still a conflict.
    expect((await replay("PATCH", "", { ...course, title: "Other" }, first.key, String((await snapshot()).revision))).json().error).toBe("IDEMPOTENCY_CONFLICT");
  });
});

describe("account erasure and people administration records", () => {
  const people = (ws = workspace) => `/api/admin/workspaces/${ws}/people`;

  it("removes the login name, revocation reason and name digests from receipts and events; other people's stay", async () => {
    // The learner also belongs to a second workspace, so revoking them here leaves them able to sign in.
    const other = randomUUID();
    await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [other, "receipts-" + other, "Other"]);
    const displayName = canary("Person "), login = canary("canary.login."), relogin = canary("canary.relogin."), reason = canary("Revoked because ");
    const invite = { displayName, role: "learner", loginName: login, idempotencyKey: randomUUID() };
    const invited = await call(owner, "POST", people(), invite);
    expect(invited.statusCode, invited.body).toBe(200);
    const userId = invited.json().userId as string;
    const reset = { loginName: relogin, idempotencyKey: randomUUID() };
    expect((await call(owner, "POST", `${people()}/${userId}/password`, reset)).statusCode).toBe(200);
    expect((await call(owner, "POST", `${people()}/${userId}/revoke`, { expectedRole: "learner", reason, idempotencyKey: randomUUID() })).statusCode).toBe(200);
    await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'learner')", [other, userId]);
    // A failed password sign-in leaves a throttle row keyed by a digest of the login name.
    const failed = await app.inject({ method: "POST", url: "/auth/login", headers: { origin }, payload: { login: relogin, password: "not-the-password-1234" } });
    expect(failed.statusCode).toBe(401);
    const throttle = throttleKey("login", relogin);
    expect((await db.query("SELECT count(*)::int AS n FROM password_login_failures WHERE account_key=$1", [throttle])).rows[0].n).toBe(1);
    // Someone else invited the same way: nothing of theirs changes.
    const bystanderLogin = canary("bystander.");
    const bystander = { displayName: "Bystander", role: "learner", loginName: bystanderLogin, idempotencyKey: randomUUID() };
    expect((await call(owner, "POST", people(), bystander)).statusCode).toBe(200);

    // Digests over the name: hashing guesses of the display and login name finds the stored one.
    const inviteDigest = digestJson({ actorId: owner.userId, operation: "people.invited", semantic: invite });
    const resetDigest = digestJson({ actorId: owner.userId, operation: "people.password_reset", semantic: { userId, ...reset } });
    const digests = (await db.query("SELECT request_digest FROM people_command_receipts WHERE workspace_id=$1", [workspace])).rows.map((r) => r.request_digest);
    expect(digests).toEqual(expect.arrayContaining([inviteDigest, resetDigest]));
    for (const needle of [login, relogin, reason]) expect(await tablesContaining(needle), needle).not.toEqual([]);

    const learner = await signIn(userId);
    const erased = await call(learner, "POST", "/api/account/erase", { confirmation: ACCOUNT_ERASURE_CONFIRMATION, reason: "Please remove my account and data." });
    expect(erased.statusCode, erased.body).toBe(200);
    expect(erased.json().counts).toMatchObject({ "account.peopleReceipts": 3, "account.peopleEvents": 3, "account.loginThrottleRows": 1 });

    for (const needle of [displayName, login, relogin, reason, inviteDigest, resetDigest, throttle]) expect(await tablesContaining(needle), needle).toEqual([]);
    // The skeleton stays: which command, about whom, by whom, with the receipt key still reserved.
    const receipts = (await db.query("SELECT request_digest,response FROM people_command_receipts WHERE workspace_id=$1 AND response->>'userId'=$2", [workspace, userId])).rows;
    expect(receipts).toHaveLength(3);
    for (const r of receipts) expect(r).toMatchObject({ request_digest: ERASED_DIGEST, response: { userId, accountErased: true } });
    const events = (await db.query("SELECT event_type,payload FROM learning_events WHERE workspace_id=$1 AND event_type LIKE 'people.%' AND payload->>'userId'=$2 ORDER BY sequence", [workspace, userId])).rows;
    expect(events).toEqual([
      { event_type: "people.invited", payload: { userId, role: "learner", accountErased: true } },
      { event_type: "people.password_reset", payload: { userId, mustChangePassword: true, accountErased: true } },
      { event_type: "people.revoked", payload: { userId, previousRole: "learner", recordsRetained: true, accountErased: true } },
    ]);
    // The workspace audit log still lists the three commands.
    const audit = (await call(owner, "GET", `/api/admin/workspaces/${workspace}/audit`)).json();
    expect(JSON.stringify(audit)).not.toContain(login);
    // A replay of the invitation is refused, not re-run and not answered with the old record.
    const again = await call(owner, "POST", people(), invite);
    expect(again.statusCode, again.body).toBe(410);
    expect(again.json().error).toBe("ACCOUNT_ERASED");
    expect((await db.query("SELECT count(*)::int AS n FROM app_users WHERE display_name=$1", [displayName])).rows[0].n).toBe(0);

    // The bystander's records are untouched and still replay.
    expect(await tablesContaining(bystanderLogin)).toEqual(expect.arrayContaining([expect.stringMatching(/^people_command_receipts:/), expect.stringMatching(/^learning_events:/)]));
    const bystanderReplay = await call(owner, "POST", people(), bystander);
    expect(bystanderReplay.json()).toMatchObject({ loginName: bystanderLogin, replayed: true });
  });
});

describe("migration 069 for records written before it", () => {
  it("drops stored workspace views and redacts accounts erased earlier, leaving other people alone", async () => {
    const before = await mkdtemp(join(tmpdir(), "course-core-068-"));
    const old = await createTestDatabase(schema + "_m", { migrated: false });
    const pool = createDatabase(old.url);
    try {
      for (const name of (await readdir(migrations)).filter((name) => name.endsWith(".sql") && name < "069")) await copyFile(join(migrations, name), join(before, name));
      await migrate(pool, before);
      const ws = randomUUID(), gone = randomUUID(), kept = randomUUID(), staff = randomUUID(), cat = randomUUID();
      await pool.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,'Old')", [ws, "old-" + ws]);
      await pool.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$4,'Erased account'),($2,'old:k','K'),($3,'old:s','S')", [gone, kept, staff, "erased:" + gone]);
      await pool.query("INSERT INTO admin_course_catalog(id,workspace_id,course_key,title) VALUES($1,$2,'k','Old course')", [cat, ws]);
      await pool.query("INSERT INTO account_erasures(id,user_id,enrollment_ids,counts,reason) VALUES($1,$2,'[]','{}','Asked to be removed.')", [randomUUID(), gone]);
      const receipt = { receipt: { id: randomUUID(), authority: "server", outcome: "saved" }, message: "Saved." };
      await pool.query("INSERT INTO admin_command_receipts(catalog_id,idempotency_key,request_digest,actor_id,response) VALUES($1,'admin-old-1',$2,$3,$4)",
        [cat, "c".repeat(64), staff, JSON.stringify({ workspace: { enrollments: [{ profile: { displayName: "OLD_PROFILE_NAME" } }] }, ...receipt })]);
      for (const [user, key, response] of [
        [gone, "people-old-1", { userId: gone, role: "learner", loginName: "old.gone.login" }],
        [gone, "people-old-2", { userId: gone, previousRole: "learner", reason: "OLD_REVOKE_REASON", recordsRetained: true }],
        [kept, "people-old-3", { userId: kept, role: "learner", loginName: "old.kept.login" }],
      ] as const) {
        await pool.query("INSERT INTO people_command_receipts(workspace_id,idempotency_key,request_digest,actor_id,response) VALUES($1,$2,$3,$4,$5)",
          [ws, key, digestJson({ user, key }), staff, JSON.stringify(response)]);
        await pool.query("INSERT INTO learning_events(id,workspace_id,actor_id,actor_kind,event_type,payload,correlation_id,idempotency_key) VALUES($1,$2,$3,'staff',$4,$5,$6,$7)",
          [randomUUID(), ws, staff, "people." + (key === "people-old-2" ? "revoked" : "invited"), JSON.stringify(response), randomUUID(), "people:" + key]);
      }

      expect(await migrate(pool, migrations)).toContain("069_receipt_redaction.sql");
      expect((await pool.query("SELECT response FROM admin_command_receipts")).rows).toEqual([{ response: receipt }]);
      const people = Object.fromEntries((await pool.query("SELECT idempotency_key,request_digest,response FROM people_command_receipts")).rows.map((r) => [r.idempotency_key, r]));
      expect(people["people-old-1"]).toEqual({ idempotency_key: "people-old-1", request_digest: ERASED_DIGEST, response: { userId: gone, role: "learner", accountErased: true } });
      expect(people["people-old-2"]).toMatchObject({ request_digest: ERASED_DIGEST, response: { userId: gone, previousRole: "learner", recordsRetained: true, accountErased: true } });
      expect(people["people-old-3"]).toEqual({ idempotency_key: "people-old-3", request_digest: digestJson({ user: kept, key: "people-old-3" }), response: { userId: kept, role: "learner", loginName: "old.kept.login" } });
      const events = (await pool.query("SELECT idempotency_key,payload FROM learning_events ORDER BY idempotency_key")).rows;
      expect(events).toEqual([
        { idempotency_key: "people:people-old-1", payload: { userId: gone, role: "learner", accountErased: true } },
        { idempotency_key: "people:people-old-2", payload: { userId: gone, previousRole: "learner", recordsRetained: true, accountErased: true } },
        { idempotency_key: "people:people-old-3", payload: { userId: kept, role: "learner", loginName: "old.kept.login" } },
      ]);
      // Running the function again changes nothing.
      expect((await pool.query("SELECT erase_account_records($1) AS c", [gone])).rows[0].c).toEqual({ peopleEvents: 0, peopleReceipts: 0, loginThrottleRows: 0 });
    } finally {
      await pool.end();
      await old.drop();
      await rm(before, { recursive: true, force: true });
    }
  });

  it("deletes login throttle rows by the same digest passwords.ts computes", async () => {
    const user = randomUUID(), login = canary("throttle.login.");
    await db.query("INSERT INTO app_users(id,subject,display_name,login_name) VALUES($1,$2,'T',$3)", [user, "throttle:" + user, login]);
    await db.query("INSERT INTO password_login_failures(account_key,address_key) VALUES($1,$2),($3,$2)", [throttleKey("login", login), "a".repeat(64), throttleKey("login", login + "x")]);
    expect((await db.query("SELECT erase_account_records($1) AS c", [user])).rows[0].c).toMatchObject({ loginThrottleRows: 1 });
    expect((await db.query("SELECT account_key FROM password_login_failures WHERE account_key=ANY($1)", [[throttleKey("login", login), throttleKey("login", login + "x")]])).rows)
      .toEqual([{ account_key: throttleKey("login", login + "x") }]);
  });
});
