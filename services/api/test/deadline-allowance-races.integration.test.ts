import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "../src/database.js";
import { createServer } from "../src/server.js";
import { issueLoginCode } from "../src/auth.js";
import { closeReached } from "../src/wakeups.js";
import { DEFAULT_COURSE_POLICY_SETTINGS } from "../src/policy-adapter.js";
import { createTestDatabase, type TestDatabase } from "./test-database.js";
import { fixture } from "./fixture.js";

// Real HTTP and PostgreSQL 17: concurrent requests at the course deadline and on extension
// allowance. Each case fires the competing operations at the same moment and then checks the
// invariants on what was stored, whichever request won: nothing is accepted after the deadline,
// a course closes once, an extension and a closure never both take effect, and allowance is
// debited and refunded at most once however many devices or retries race.
const origin = "http://localhost:4397",
  schema = "deadline_races_" + randomUUID().replaceAll("-", "");
let db: Database, app: Awaited<ReturnType<typeof createServer>>, testDatabase: TestDatabase | undefined;
let workspace: string, owner: Session, release: string, course: string;
interface Session { userId: string; cookie: string; csrf: string }
type Offer = { terms: { offerId: string }; termsDigest: string };

async function session(role: string): Promise<Session> {
  const id = randomUUID();
  await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [id, "race:" + id, role + " person"]);
  await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspace, id, role]);
  const r = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, id) } });
  return { userId: id, cookie: r.cookies.map((c) => c.name + "=" + c.value).join("; "), csrf: r.json().csrfToken };
}
const call = (who: Session, method: "GET" | "POST" | "PUT", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { origin, cookie: who.cookie, "x-csrf-token": who.csrf }, ...(payload === undefined ? {} : { payload: payload as object }) });
async function ok(who: Session, method: "GET" | "POST" | "PUT", url: string, payload?: unknown) {
  const r = await call(who, method, url, payload);
  expect(r.statusCode, `${method} ${url}: ${r.body}`).toBe(200);
  return r.json();
}
async function saveExtensionSettings(extensions: Record<string, unknown>) {
  const current = await ok(owner, "GET", `/api/admin/courses/${course}/policy-settings`);
  await ok(owner, "PUT", `/api/admin/courses/${course}/policy-settings`, { expectedRevision: current.revision,
    settings: { ...structuredClone(DEFAULT_COURSE_POLICY_SETTINGS), extensions: { approval: "learner", offerCooldownHours: 0, maxOutstandingOffersPerScope: 2, maxOffersPerScope: 5, ...extensions } },
    reason: "Race suite settings" });
}
async function enrolled() {
  const learner = await session("learner");
  const id = (await ok(learner, "POST", "/api/enrollments", { releaseId: release })).id as string;
  return { learner, id };
}
const revisionOf = async (who: Session, id: string) => (await ok(who, "GET", `/api/enrollments/${id}`)).revision as number;
const adminView = (id: string) => ok(owner, "GET", `/api/admin/enrollments/${id}/policy`);
async function propose(learner: Session, id: string, days = 2): Promise<Offer> {
  const event = (await db.query("SELECT id FROM learning_events WHERE enrollment_id=$1 AND event_type='enrollment.started'", [id])).rows[0];
  return (await ok(owner, "POST", `/api/enrollments/${id}/extensions/propose`, { expectedRevision: await revisionOf(learner, id), idempotencyKey: randomUUID(), scopeId: "course", days,
    rationaleEventIds: [event.id], episodeIds: ["min"], planImpact: "Two more days for independent practice.", alternatives: ["Finish on the existing date with a gap report."] })).offer;
}
const accept = (learner: Session, id: string, offer: Offer, expectedRevision: number, idempotencyKey: string = randomUUID()) =>
  call(learner, "POST", `/api/enrollments/${id}/extensions/accept`, { expectedRevision, idempotencyKey, offerId: offer.terms.offerId, termsDigest: offer.termsDigest, explicitConsent: true });
const grantRows = async (id: string) => (await db.query("SELECT count(*)::int AS n FROM extension_grants WHERE enrollment_id=$1", [id])).rows[0].n as number;
const snapshotOf = async (id: string) => (await db.query("SELECT snapshot FROM policy_states WHERE enrollment_id=$1", [id])).rows[0].snapshot;
const statusOf = async (id: string) => (await db.query("SELECT status FROM enrollments WHERE id=$1", [id])).rows[0].status as string;
const closures = async (id: string) => (await db.query("SELECT count(*)::int AS n FROM learning_events WHERE enrollment_id=$1 AND event_type='enrollment.closed'", [id])).rows[0].n as number;
/** Settles a promise that may reject (closeReached refuses with CAP_NOT_REACHED) into a value or an error code. */
const settle = <T,>(p: Promise<T>) => p.then((value) => ({ value }), (error: { code?: string }) => ({ error: error.code ?? String(error) }));

beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false });
});
beforeEach(async () => {
  workspace = randomUUID();
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspace, "races-" + workspace, "Races"]);
  owner = await session("owner");
  release = (await ok(owner, "POST", `/api/workspaces/${workspace}/releases`, fixture())).id;
  await ok(owner, "POST", `/api/releases/${release}/publish`);
  course = (await db.query("SELECT id FROM admin_course_catalog WHERE workspace_id=$1", [workspace])).rows[0].id;
}, 30000);
afterAll(async () => {
  await app?.close();
  await db?.end();
  await testDatabase?.drop();
}, 60000);

describe("answers racing the course deadline", () => {
  it("accepts only answers checked before the deadline, then closes each course once after its last accepted answer", async () => {
    const learners = await Promise.all(Array.from({ length: 12 }, () => enrolled()));
    // Each learner holds an issued question before the deadline moves close.
    const issued = await Promise.all(learners.map(async ({ learner, id }) => (await ok(learner, "POST", `/api/enrollments/${id}/challenges`,
      { expectedRevision: await revisionOf(learner, id), idempotencyKey: randomUUID(), episodeId: "min", assessmentId: "min-a", mode: "independent" })).challengeId as string));
    const revisions = await Promise.all(learners.map(({ learner, id }) => revisionOf(learner, id)));
    // The course's ultimate deadline is set 2 s ahead (stored state only: the server keeps the real clock).
    const deadline = new Date(Date.now() + 2000);
    for (const { id } of learners)
      await db.query("UPDATE policy_states SET snapshot=jsonb_set(snapshot,'{scopes,0,ultimateDeadline}',to_jsonb($2::text)) WHERE enrollment_id=$1", [id, deadline.toISOString()]);
    // Answers are spread from 900 ms before to 750 ms after the deadline; every closure scan runs
    // twice, concurrently, 50 ms after it, so answers, closures and duplicates all overlap.
    const answers = learners.map(({ learner, id }, i) => sleep(Math.max(0, deadline.getTime() - 900 + i * 150 - Date.now()))
      .then(() => call(learner, "POST", `/api/enrollments/${id}/answers`, { expectedRevision: revisions[i], idempotencyKey: randomUUID(), challengeId: issued[i], answer: "two" })));
    const closing = sleep(Math.max(0, deadline.getTime() + 50 - Date.now())).then(() => Promise.all(learners.flatMap(({ id }) =>
      [settle(closeReached(db, id, { now: new Date(deadline.getTime() + 1) })), settle(closeReached(db, id, { now: new Date(deadline.getTime() + 1) }))])));
    const [results] = await Promise.all([Promise.all(answers), closing]);
    for (const [i, r] of results.entries()) {
      const { id } = learners[i]!;
      if (r.statusCode !== 200) {
        expect(r.statusCode, r.body).toBe(409);
        expect(["DEADLINE_REACHED", "ENROLLMENT_INACTIVE"]).toContain(r.json().error);
      }
      const attempts = (await db.query("SELECT submitted_at FROM attempts WHERE enrollment_id=$1", [id])).rows as { submitted_at: Date }[];
      // An accepted answer is stored once and was started before the deadline; a refused one leaves nothing.
      expect(attempts).toHaveLength(r.statusCode === 200 ? 1 : 0);
      for (const a of attempts) expect(a.submitted_at.getTime()).toBeLessThan(deadline.getTime());
      // Each course closes exactly once, after any answer it accepted.
      expect(await statusOf(id)).toBe("closed");
      expect(await closures(id)).toBe(1);
      const order = (await db.query("SELECT event_type FROM learning_events WHERE enrollment_id=$1 AND event_type IN ('assessment.submitted','enrollment.closed') ORDER BY sequence", [id])).rows.map((e) => e.event_type);
      expect(order.at(-1)).toBe("enrollment.closed");
    }
    // Both sides of the boundary were exercised.
    expect(results.some((r) => r.statusCode === 200)).toBe(true);
    expect(results.some((r) => r.statusCode === 409)).toBe(true);
    // After closure every learner is refused new work.
    for (const [i, { learner, id }] of learners.entries()) {
      const late = await call(learner, "POST", `/api/enrollments/${id}/answers`, { expectedRevision: await revisionOf(learner, id), idempotencyKey: randomUUID(), challengeId: issued[i], answer: "two" });
      expect(late.statusCode).toBe(409);
    }
  }, 60000);
});

describe("an extension racing the cap closure", () => {
  it("either the extension is granted and the course stays open, or the course closes and nothing is granted, never both", async () => {
    await saveExtensionSettings({});
    const runs = await Promise.all(Array.from({ length: 10 }, async () => {
      const e = await enrolled();
      const offer = await propose(e.learner, e.id);
      const deadline = (await adminView(e.id)).constraints[0].effectiveDeadline as string;
      return { ...e, offer, revision: await revisionOf(e.learner, e.id), after: new Date(Date.parse(deadline) + 60_000) };
    }));
    // A minute past the original deadline on the scan's clock; the offer adds two days.
    const outcomes = await Promise.all(runs.map(async (run) => {
      const [accepted, closed] = await Promise.all([accept(run.learner, run.id, run.offer, run.revision), settle(closeReached(db, run.id, { now: run.after }))]);
      return { run, accepted, closed };
    }));
    for (const { run, accepted, closed } of outcomes) {
      const status = await statusOf(run.id), grants = await grantRows(run.id), snapshot = await snapshotOf(run.id);
      if (accepted.statusCode === 200) {
        // The grant won: the later scan saw the extended deadline and refused to close.
        expect(closed).toEqual({ error: "CAP_NOT_REACHED" });
        expect(status).toBe("active");
        expect(grants).toBe(1);
        expect(snapshot.grants).toHaveLength(1);
      } else {
        expect(accepted.statusCode, accepted.body).toBe(409);
        expect(closed).toEqual({ value: 1 });
        expect(status).toBe("closed");
        expect(grants).toBe(0);
        expect(snapshot.grants).toHaveLength(0);
      }
      expect(await closures(run.id)).toBe(status === "closed" ? 1 : 0);
    }
  }, 60000);
});

describe("allowance under concurrent and repeated requests", () => {
  it("one offer accepted from many devices and retries is granted once and debits the allowance once", async () => {
    await saveExtensionSettings({});
    const { learner, id } = await enrolled();
    const offer = await propose(learner, id);
    const revision = await revisionOf(learner, id), retried = "retry-" + randomUUID();
    const results = await Promise.all([...Array.from({ length: 4 }, () => accept(learner, id, offer, revision, retried)), ...Array.from({ length: 4 }, () => accept(learner, id, offer, revision))]);
    const succeeded = results.filter((r) => r.statusCode === 200);
    expect(succeeded.length).toBeGreaterThanOrEqual(1);
    for (const r of results.filter((r) => r.statusCode !== 200)) expect(r.statusCode, r.body).toBe(409);
    // Every success is the same grant: the retried key replays the stored response, and a second key cannot add one.
    expect(new Set(succeeded.map((r) => JSON.stringify(r.json().policy?.grants ?? r.json().grants))).size).toBe(1);
    expect(await grantRows(id)).toBe(1);
    expect((await snapshotOf(id)).grants).toHaveLength(1);
    expect((await ok(learner, "GET", `/api/enrollments/${id}/policy`)).balances[0]).toEqual({ poolId: "course:calendar", remaining: 0, grantsRemaining: 0 });
  });

  it("proposals racing the outstanding-offer cap never exceed it", async () => {
    await saveExtensionSettings({ maxOutstandingOffersPerScope: 2 });
    const { learner, id } = await enrolled();
    const event = (await db.query("SELECT id FROM learning_events WHERE enrollment_id=$1 AND event_type='enrollment.started'", [id])).rows[0];
    // Each proposal retries with a fresh revision until it is either stored or refused for a policy reason.
    const proposeUntilDecided = async () => {
      for (let attempt = 0; attempt < 20; attempt++) {
        const r = await call(owner, "POST", `/api/enrollments/${id}/extensions/propose`, { expectedRevision: await revisionOf(learner, id), idempotencyKey: randomUUID(), scopeId: "course", days: 1,
          rationaleEventIds: [event.id], episodeIds: ["min"], planImpact: "One more day.", alternatives: ["Finish on the existing date."] });
        if (r.statusCode !== 409 || r.json().error !== "STALE_REVISION") return r;
      }
      throw new Error("proposal never decided");
    };
    const results = await Promise.all(Array.from({ length: 6 }, proposeUntilDecided));
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(2);
    for (const r of results.filter((r) => r.statusCode !== 200)) expect(r.statusCode, r.body).toBe(409);
    expect((await snapshotOf(id)).offers.filter((o: { state: string }) => o.state === "proposed")).toHaveLength(2);
  }, 60000);

  it("concurrent admin approvals grant once, and concurrent refunds of one grant refund once", async () => {
    await saveExtensionSettings({ approval: "learner_and_admin" });
    const { learner, id } = await enrolled();
    const offer = await propose(learner, id);
    expect((await accept(learner, id, offer, await revisionOf(learner, id))).statusCode).toBe(200);
    const url = `/api/admin/enrollments/${id}/extensions/${offer.terms.offerId}/grant`, revision = (await adminView(id)).revision, key = "approve-" + randomUUID();
    const approvals = await Promise.all([...Array.from({ length: 4 }, () => call(owner, "POST", url, { expectedRevision: revision, idempotencyKey: key })),
      ...Array.from({ length: 3 }, () => call(owner, "POST", url, { expectedRevision: revision, idempotencyKey: "approve-" + randomUUID() }))]);
    const approved = approvals.filter((r) => r.statusCode === 200);
    expect(approved.length).toBeGreaterThanOrEqual(1);
    for (const r of approvals.filter((r) => r.statusCode !== 200)) expect(r.statusCode, r.body).toBe(409);
    expect(new Set(approved.map((r) => JSON.stringify(r.json().policy.grants))).size).toBe(1);
    expect(await grantRows(id)).toBe(1);
    const grantId = (await adminView(id)).grants[0].grantId as string;
    const preview = await ok(owner, "POST", `/api/admin/enrollments/${id}/grants/${grantId}/refund/preview`, { poolId: "course:calendar", amount: 2 });
    const refunds = await Promise.all(Array.from({ length: 5 }, () => call(owner, "POST", `/api/admin/enrollments/${id}/grants/${grantId}/refund`,
      { expectedRevision: preview.revision, idempotencyKey: "refund-" + randomUUID(), previewId: preview.previewId, previewDigest: preview.previewDigest, reason: "Outage credit." })));
    expect(refunds.filter((r) => r.statusCode === 200)).toHaveLength(1);
    for (const r of refunds.filter((r) => r.statusCode !== 200)) expect(r.statusCode, r.body).toBe(409);
    const view = await adminView(id);
    expect(view.refunds).toHaveLength(1);
    // Refunded once: back to the full two days, never more than the pool started with.
    expect(view.balances[0].remaining).toBe(2);
  }, 60000);
});
