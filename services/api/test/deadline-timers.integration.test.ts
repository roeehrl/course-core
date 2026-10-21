import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { applyAccommodation, previewAccommodation, type PolicyState } from "@course-core/policy";
import { createDatabase, type Database } from "../src/database.js";
import { createTestDatabase, type TestDatabase } from "./test-database.js";
import { createServer } from "../src/server.js";
import { issueLoginCode } from "../src/auth.js";
import { scanWakeups } from "../src/wakeups.js";
import { retentionCourse } from "./retention-fixture.js";

/** G13: durable per-deadline timers with commit-time fences (migration 096, wakeups.ts). */
const origin = "http://localhost:4392",
  schema = "timers_" + randomUUID().replaceAll("-", "");
const DAY = 86_400_000;
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
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspace, "timers-" + workspace, "Timers"]);
  const sign = async (role: string): Promise<Session> => {
    const id = randomUUID();
    await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [id, "timers:" + id, role]);
    await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspace, id, role]);
    const r = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, id) } });
    return { id, cookie: r.cookies.map((c) => c.name + "=" + c.value).join("; "), csrf: r.json().csrfToken };
  };
  const call = (who: Session, method: "GET" | "POST", url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { origin, cookie: who.cookie, "x-csrf-token": who.csrf }, ...(payload === undefined ? {} : { payload: payload as object }) });
  const owner = await sign("owner");
  const release = (await call(owner, "POST", `/api/workspaces/${workspace}/releases`, retentionCourse())).json().id;
  expect((await call(owner, "POST", `/api/releases/${release}/publish`)).statusCode).toBe(200);
  const learner = await sign("learner");
  const enrollment = (await call(learner, "POST", "/api/enrollments", { releaseId: release })).json().id as string;
  return { workspace, owner, learner, enrollment, call };
}
const status = async (id: string) => (await db.query("SELECT status FROM enrollments WHERE id=$1", [id])).rows[0].status as string;
const pending = async (id: string) => (await db.query<{ phase: string; scope_id: string; deadline_at: Date; policy_revision: number }>(
  "SELECT phase,scope_id,deadline_at,policy_revision FROM policy_deadline_timers WHERE enrollment_id=$1 AND state='pending' ORDER BY phase", [id])).rows;
const policyOf = async (id: string) => (await db.query<{ snapshot: PolicyState }>("SELECT snapshot FROM policy_states WHERE enrollment_id=$1", [id])).rows[0]!.snapshot;
/** Scans until nothing more is waiting (a queued plan or a due timer). */
async function drain(options: Parameters<typeof scanWakeups>[1] = {}) {
  for (let i = 0; i < 10; i++) if ((await scanWakeups(db, options)).wrapped) return;
}
/** The policy document with a three-day outage adjustment on the course window, as a migration-free ledger change. */
function extended(state: PolicyState, now: string) {
  const args = { scopeId: "course", accommodationId: randomUUID(), reasonRef: "incident", kind: "outage" as const, change: { deadline: { kind: "window" as const, calendarDays: 3 } } };
  const preview = previewAccommodation(state, args);
  return applyAccommodation(state, { ...args, now, previewDigest: preview.previewDigest, expectedPolicyRevision: state.policyRevision, expectedLedgerRevision: state.ledgerRevision,
    idempotencyKey: randomUUID(), authorityReceipt: { receiptId: randomUUID(), actorId: "staff", enrollmentId: state.enrollmentId, scopeId: "course", permission: "accommodate", termsDigest: preview.previewDigest, authorizedAt: now } }).state;
}

describe("durable deadline timers", () => {
  it("plans one timer per boundary from the committed policy, at the enrollment's own end", async () => {
    const { enrollment } = await enrolled();
    await drain();
    const state = await policyOf(enrollment);
    const end = state.scopes.find((s) => s.scopeId === "course")!.window!.resolvedDeadline;
    expect((await pending(enrollment)).map((t) => [t.phase, t.scope_id, t.deadline_at.toISOString(), t.policy_revision]))
      .toEqual([["approaching", "course", new Date(end).toISOString(), state.policyRevision], ["cap", "enrollment", new Date(end).toISOString(), state.policyRevision]]);
    // The resolved constraints of every scope are recorded with the binding level (M02).
    const snapshot = (await db.query("SELECT effective_deadline,binding_scope_id,binding_level,policy_revision FROM policy_constraint_snapshots WHERE enrollment_id=$1 AND scope_id='episode:min'", [enrollment])).rows[0];
    expect(snapshot).toMatchObject({ binding_scope_id: "course", binding_level: "course", policy_revision: state.policyRevision });
    expect(snapshot.effective_deadline.toISOString()).toBe(new Date(end).toISOString());
  });

  it("re-plans when any code path changes the policy, so a moved deadline never fires at its old time", async () => {
    const { enrollment } = await enrolled();
    await drain();
    const before = await policyOf(enrollment);
    const oldEnd = Date.parse(before.scopes.find((s) => s.scopeId === "course")!.window!.resolvedDeadline);
    // A direct write (no route) still queues a re-plan in the same transaction.
    const next = extended(before, new Date().toISOString());
    await db.query("UPDATE policy_states SET snapshot=$2,policy_revision=$3,ledger_revision=$4 WHERE enrollment_id=$1", [enrollment, JSON.stringify(next), next.policyRevision, next.ledgerRevision]);
    expect((await db.query("SELECT 1 FROM policy_timer_plans WHERE enrollment_id=$1", [enrollment])).rowCount).toBe(1);
    // An hour after the old end, the enrollment stays open: its timer moved three days.
    await drain({ now: new Date(oldEnd + 3_600_000) });
    expect(await status(enrollment)).toBe("active");
    expect((await pending(enrollment)).find((t) => t.phase === "cap")!.deadline_at.getTime()).toBe(oldEnd + 3 * DAY);
    expect((await db.query("SELECT count(*)::int AS n FROM policy_deadline_timers WHERE enrollment_id=$1 AND state='superseded' AND phase='cap'", [enrollment])).rows[0].n).toBe(1);
    await drain({ now: new Date(oldEnd + 3 * DAY) });
    expect(await status(enrollment)).toBe("closed");
  });

  it("fences a due timer against a policy change committed while it waited for the policy lock", async () => {
    const { enrollment } = await enrolled();
    await drain();
    const before = await policyOf(enrollment);
    const oldEnd = Date.parse(before.scopes.find((s) => s.scopeId === "course")!.window!.resolvedDeadline);
    // A grant in flight: it holds the policy row lock while the old cap timer becomes due.
    const grant = await db.connect();
    try {
      await grant.query("BEGIN");
      await grant.query("SELECT 1 FROM policy_states WHERE enrollment_id=$1 FOR UPDATE", [enrollment]);
      const scan = scanWakeups(db, { now: new Date(oldEnd + 60_000) });
      // Wait until the scan is blocked on the lock, then commit the extension.
      for (let i = 0; i < 100; i++) {
        const waiting = (await db.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'")).rows[0].n;
        if (waiting) break;
        if (i === 99) throw new Error("the scan never waited for the policy lock");
        await new Promise((r) => setTimeout(r, 20));
      }
      const next = extended(before, new Date().toISOString());
      await grant.query("UPDATE policy_states SET snapshot=$2,policy_revision=$3,ledger_revision=$4 WHERE enrollment_id=$1", [enrollment, JSON.stringify(next), next.policyRevision, next.ledgerRevision]);
      await grant.query("COMMIT");
      const result = await scan;
      expect(result.closed).toBe(0);
    } finally { grant.release(); }
    expect(await status(enrollment)).toBe("active");
    const cap = (await pending(enrollment)).find((t) => t.phase === "cap")!;
    expect([cap.deadline_at.getTime(), cap.policy_revision]).toEqual([oldEnd + 3 * DAY, before.policyRevision + 1]);
  });

  it("fires each due boundary once across concurrent workers, and a closed enrollment keeps no timers", async () => {
    const { enrollment } = await enrolled();
    await drain();
    const end = Date.parse((await policyOf(enrollment)).scopes.find((s) => s.scopeId === "course")!.window!.resolvedDeadline);
    const later = new Date(end + 1_000);
    const results = await Promise.all(Array.from({ length: 4 }, () => scanWakeups(db, { now: later, deadlineLeadMs: 40 * DAY })));
    expect(results.reduce((n, r) => n + r.closed, 0)).toBe(1);
    expect(await status(enrollment)).toBe("closed");
    expect((await db.query("SELECT count(*)::int AS n FROM learning_events WHERE enrollment_id=$1 AND event_type='enrollment.closed'", [enrollment])).rows[0].n).toBe(1);
    await drain({ now: later });
    expect(await pending(enrollment)).toEqual([]);
    // The closure report is a first-class record committed with the closure (M02).
    expect((await db.query("SELECT reason,coverage FROM closure_reports WHERE enrollment_id=$1", [enrollment])).rows).toEqual([{ reason: "cap", coverage: "partial" }]);
  });

  it("a late timer cannot close early: the policy re-checks the cap at commit", async () => {
    const { enrollment } = await enrolled();
    await drain();
    // Corrupt nothing, but forge a cap timer that claims an earlier end under the current revision.
    const state = await policyOf(enrollment);
    await db.query(`INSERT INTO policy_deadline_timers(enrollment_id,scope_id,phase,deadline_at,level,policy_revision,ledger_revision)
      VALUES($1,'enrollment','cap',$2,'enrollment',$3,$4)`, [enrollment, new Date(Date.now() - 60_000), state.policyRevision, state.ledgerRevision]);
    const result = await scanWakeups(db);
    expect(result.closed).toBe(0);
    expect(await status(enrollment)).toBe("active");
  });
});
