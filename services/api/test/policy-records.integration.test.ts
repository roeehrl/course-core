import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { commitWork, reserveWork, type PolicyState } from "@course-core/policy";
import { createDatabase, type Database } from "../src/database.js";
import { createTestDatabase, type TestDatabase } from "./test-database.js";
import { createServer } from "../src/server.js";
import { issueLoginCode } from "../src/auth.js";
import { fixture } from "./fixture.js";

/** M02: first-class records of the policy domain (migration 095), written in the same
 * transaction as every change of the policy document, whatever code path makes it. */
const origin = "http://localhost:4394",
  schema = "policyrecords_" + randomUUID().replaceAll("-", "");
let db: Database, app: Awaited<ReturnType<typeof createServer>>;
interface Session { id: string; cookie: string; csrf: string }
let testDatabase: TestDatabase | undefined;
beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false });
});
afterAll(async () => {
  await app?.close();
  await db?.end();
  await testDatabase?.drop();
});

async function enrolled() {
  const workspace = randomUUID();
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspace, "records-" + workspace, "Records"]);
  const sign = async (role: string): Promise<Session> => {
    const id = randomUUID();
    await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [id, "records:" + id, role]);
    await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspace, id, role]);
    const r = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, id) } });
    return { id, cookie: r.cookies.map((c) => c.name + "=" + c.value).join("; "), csrf: r.json().csrfToken };
  };
  const call = (who: Session, method: "GET" | "POST", url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { origin, cookie: who.cookie, "x-csrf-token": who.csrf }, ...(payload === undefined ? {} : { payload: payload as object }) });
  const owner = await sign("owner");
  const course = fixture();
  course.policy.work = { additionalMinutes: 120, additionalEpisodes: 4 };
  const release = (await call(owner, "POST", `/api/workspaces/${workspace}/releases`, course)).json().id as string;
  expect((await call(owner, "POST", `/api/releases/${release}/publish`)).statusCode).toBe(200);
  const learner = await sign("learner");
  const enrollment = (await call(learner, "POST", "/api/enrollments", { releaseId: release })).json().id as string;
  return { enrollment, release, learner, call };
}
const policyOf = async (id: string) => (await db.query<{ snapshot: PolicyState }>("SELECT snapshot FROM policy_states WHERE enrollment_id=$1", [id])).rows[0]!.snapshot;
const save = (id: string, state: PolicyState) =>
  db.query("UPDATE policy_states SET snapshot=$2,policy_revision=$3,ledger_revision=$4 WHERE enrollment_id=$1", [id, JSON.stringify(state), state.policyRevision, state.ledgerRevision]);

describe("first-class policy records", () => {
  it("projects work reservations and the policy at each revision from any write, in the same transaction", async () => {
    const { enrollment } = await enrolled();
    const state = await policyOf(enrollment);
    const now = new Date().toISOString();
    const reserved = reserveWork(state, { reservationId: "work-1", scopeId: "episode:min", work: { additionalMinutes: 20, additionalEpisodes: 1, remediation: [] },
      expectedPolicyRevision: state.policyRevision, expectedLedgerRevision: state.ledgerRevision, idempotencyKey: randomUUID(), now }).state;
    // A write that rolls back leaves no record behind.
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE policy_states SET snapshot=$2,ledger_revision=$3 WHERE enrollment_id=$1", [enrollment, JSON.stringify(reserved), reserved.ledgerRevision]);
      await client.query("ROLLBACK");
    } finally { client.release(); }
    expect((await db.query("SELECT count(*)::int AS n FROM work_reservations WHERE enrollment_id=$1", [enrollment])).rows[0].n).toBe(0);
    await save(enrollment, reserved);
    expect((await db.query("SELECT reservation_id,scope_id,state,purpose,ancestor_scope_ids FROM work_reservations WHERE enrollment_id=$1", [enrollment])).rows)
      .toEqual([{ reservation_id: "work-1", scope_id: "episode:min", state: "reserved", purpose: "extra", ancestor_scope_ids: ["organization", "course", "enrollment", "chapter:order", "episode:min"] }]);
    const committed = commitWork(reserved, { reservationId: "work-1", workId: "published-1", expectedPolicyRevision: reserved.policyRevision,
      expectedLedgerRevision: reserved.ledgerRevision, idempotencyKey: randomUUID(), now }).state;
    await save(enrollment, committed);
    expect((await db.query("SELECT state,work_id FROM work_reservations WHERE enrollment_id=$1", [enrollment])).rows).toEqual([{ state: "committed", work_id: "published-1" }]);
    // Ledger-only changes keep the one policy revision; its scopes and pools are recorded once.
    const revisions = (await db.query("SELECT policy_revision,cause,jsonb_array_length(scopes) AS scopes FROM learning_policy_revisions WHERE enrollment_id=$1 ORDER BY policy_revision", [enrollment])).rows;
    expect(revisions).toEqual([{ policy_revision: 1, cause: "created", scopes: state.scopes.length }]);
    // Pools of the release are records too, with their balance.
    expect((await db.query("SELECT pool_id,unit,total,debited,refunded FROM extension_pools WHERE enrollment_id=$1", [enrollment])).rows)
      .toEqual(state.pools.map((p) => ({ pool_id: p.poolId, unit: p.unit, total: p.total, debited: 0, refunded: 0 })));
    expect(state.pools.length).toBeGreaterThan(0);
  });

  it("records each gate of a stored release as the gate revision decisions are judged by", async () => {
    const { enrollment, release, learner, call } = await enrolled();
    const digest = (await db.query("SELECT digest FROM course_releases WHERE id=$1", [release])).rows[0].digest;
    const gates = (await db.query("SELECT gate_id,gate_version FROM gate_revisions WHERE course_digest=$1 ORDER BY gate_id", [digest])).rows;
    expect(gates.length).toBe(fixture().gates.length);
    const revision = (await call(learner, "GET", `/api/enrollments/${enrollment}`)).json().revision;
    const issued = await call(learner, "POST", `/api/enrollments/${enrollment}/challenges`, { expectedRevision: revision, idempotencyKey: randomUUID(), episodeId: "min", assessmentId: "min-a", mode: "independent" });
    expect(issued.statusCode, issued.body).toBe(200);
    await call(learner, "POST", `/api/enrollments/${enrollment}/answers`, { expectedRevision: revision + 1, idempotencyKey: randomUUID(), challengeId: issued.json().challengeId, answer: "two" });
    // Every decision names a recorded gate revision.
    const orphans = (await db.query(`SELECT count(*)::int AS n FROM gate_decisions d WHERE d.enrollment_id=$1 AND NOT EXISTS
      (SELECT 1 FROM gate_revisions g WHERE g.course_digest=d.course_digest AND g.gate_id=d.gate_id AND g.gate_version=d.gate_version)`, [enrollment])).rows[0].n;
    expect(orphans).toBe(0);
    expect((await db.query("SELECT count(*)::int AS n FROM gate_decisions WHERE enrollment_id=$1", [enrollment])).rows[0].n).toBeGreaterThan(0);
  });
});
