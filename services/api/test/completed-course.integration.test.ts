import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import { closeEnrollment, previewClosure } from "@course-core/policy";
import { createDatabase, type Database } from "../src/database.js";
import { createTestDatabase, type TestDatabase } from "./test-database.js";
import { createServer } from "../src/server.js";
import { issueLoginCode } from "../src/auth.js";
import { fixture } from "./fixture.js";

const origin = "http://localhost:4389",
  schema = "completed_" + randomUUID().replaceAll("-", "");
let db: Database, app: Awaited<ReturnType<typeof createServer>>;
let workspace: string, owner: Session, learner: Session, enrollment: string;
interface Session { cookie: string; csrf: string }
async function session(role: string): Promise<Session> {
  const id = randomUUID();
  await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [id, "completed:" + id, role]);
  await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspace, id, role]);
  const r = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, id) } });
  return { cookie: r.cookies.map((c) => c.name + "=" + c.value).join("; "), csrf: r.json().csrfToken };
}
const call = (who: Session, method: "GET" | "POST", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { origin, cookie: who.cookie, "x-csrf-token": who.csrf }, ...(payload === undefined ? {} : { payload: payload as object }) });
async function send(action: string, body: Record<string, unknown>) {
  const revision = (await call(learner, "GET", "/api/enrollments/" + enrollment)).json().revision;
  return call(learner, "POST", `/api/enrollments/${enrollment}/${action}`, { expectedRevision: revision, idempotencyKey: randomUUID(), ...body });
}
async function complete(access: "read_only" | "closed") {
  const row = (await db.query("SELECT snapshot FROM policy_states WHERE enrollment_id=$1", [enrollment])).rows[0];
  for (const scope of row.snapshot.scopes) scope.existingMaterialAccess = access;
  const policy = row.snapshot, now = new Date().toISOString();
  const command = { now, reason: "completed" as const, coveredObjectiveIds: policy.coreObjectiveIds, demonstratedConceptIds: [] };
  const preview = previewClosure(policy, command);
  const closed = closeEnrollment(policy, { ...command, previewDigest: preview.previewDigest, expectedPolicyRevision: policy.policyRevision, expectedLedgerRevision: policy.ledgerRevision,
    idempotencyKey: "completion:" + enrollment, authorityReceipt: { receiptId: randomUUID(), actorId: "system:test", enrollmentId: enrollment, scopeId: "course", permission: "close_enrollment", termsDigest: preview.previewDigest, authorizedAt: now } });
  await db.query("UPDATE policy_states SET snapshot=$2,policy_revision=$3,ledger_revision=$4 WHERE enrollment_id=$1", [enrollment, JSON.stringify(closed.state), closed.state.policyRevision, closed.state.ledgerRevision]);
  await db.query("UPDATE enrollments SET status='completed',policy_revision=$2,closed_at=now(),revision=revision+1 WHERE id=$1", [enrollment, closed.state.policyRevision]);
}
let testDatabase: TestDatabase | undefined;
beforeAll(async () => {
  const connection = process.env.TEST_DATABASE_URL ?? "";
  const url = new URL(connection);
  if (process.env.DATABASE_URL || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !/^\/course_core_(?:ci|test(?:_[a-z0-9_]+)?)$/.test(url.pathname) || url.search || url.hash)
    throw Error("Explicit disposable loopback database required");
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false });
});
beforeEach(async () => {
  workspace = randomUUID();
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspace, "done-" + workspace, "Completed"]);
  owner = await session("owner");
  learner = await session("learner");
  const release = (await call(owner, "POST", `/api/workspaces/${workspace}/releases`, fixture())).json().id;
  await call(owner, "POST", `/api/releases/${release}/publish`);
  enrollment = (await call(learner, "POST", "/api/enrollments", { releaseId: release })).json().id;
});
afterAll(async () => {
  await app?.close();
  await db?.end();
  await testDatabase?.drop();
});

describe("questions after a course is completed", () => {
  it("keeps bounded explanatory questions but no new required work", async () => {
    await complete("read_only");
    const asked = await send("companion", { episodeId: "min", content: "Why does keeping the smaller value work?" });
    expect(asked.statusCode, asked.body).toBe(200);
    expect(asked.json().state).toBe("queued");
    const events = (await db.query("SELECT payload FROM learning_events WHERE enrollment_id=$1 AND event_type='companion.requested'", [enrollment])).rows;
    expect(events).toHaveLength(1);
    // Completion does not reopen checks or planning.
    expect((await send("challenges", { episodeId: "min", assessmentId: "min-a", mode: "independent" })).statusCode).toBe(409);
  });
  it("refuses questions when the course closed access to existing material", async () => {
    await complete("closed");
    expect((await send("companion", { episodeId: "min", content: "Why does keeping the smaller value work?" })).json().error).toBe("ACCESS_CLOSED");
  });
});
