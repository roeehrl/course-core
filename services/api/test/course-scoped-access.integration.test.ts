import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { createDatabase, transaction, type Database } from "../src/database.js";
import { createTestDatabase, type TestDatabase } from "./test-database.js";
import { createServer } from "../src/server.js";
import { issueLoginCode } from "../src/auth.js";
import { appendEvent } from "../src/events.js";
import { reviewedRubricEvaluator } from "../src/rubric-evaluator.js";
import { rubricCourse, rubricExplanation } from "./rubric-fixture.js";
import { fixture } from "./fixture.js";

// Real HTTP and PostgreSQL 17. Course-scoped grants are honoured by every staff route, not
// only course administration: a course-scoped reviewer decides written answers on their own
// course, is refused on any other course and loses access the moment the grant expires or is
// revoked. Staff reads of the enrollment event feed follow the learner-privacy rule.
const origin = "http://localhost:4396",
  schema = "scoped_" + randomUUID().replaceAll("-", "");
let db: Database, app: Awaited<ReturnType<typeof createServer>>;
interface Session { userId: string; cookie: string; csrf: string }
let workspace: string, catalog: string, otherCatalog: string, enrollment: string, attempt: string;
const s: Record<string, Session> = {};

async function person(role: string, name = role + " person"): Promise<Session> {
  const id = randomUUID();
  await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [id, "scoped:" + id, name]);
  await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspace, id, role]);
  const r = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, id) } });
  expect(r.statusCode, r.body).toBe(200);
  return { userId: id, cookie: r.cookies.map((c) => c.name + "=" + c.value).join("; "), csrf: r.json().csrfToken };
}
const call = (who: Session, method: "GET" | "POST", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { origin, cookie: who.cookie, "x-csrf-token": who.csrf }, ...(payload === undefined ? {} : { payload: payload as object }) });
async function ok(who: Session, method: "GET" | "POST", url: string, payload?: unknown) {
  const r = await call(who, method, url, payload);
  expect(r.statusCode, `${method} ${url}: ${r.body}`).toBe(200);
  return r.json();
}
async function send(who: Session, id: string, action: string, body: Record<string, unknown>) {
  const revision = (await ok(who, "GET", "/api/enrollments/" + id)).revision;
  return ok(who, "POST", `/api/enrollments/${id}/${action}`, { expectedRevision: revision, idempotencyKey: randomUUID(), ...body });
}
async function grant(who: Session, catalogId: string, role: string) {
  const r = await call(s.owner!, "POST", `/api/admin/workspaces/${workspace}/course-grants`,
    { userId: who.userId, catalogId, role, expiresAt: new Date(Date.now() + 86_400_000).toISOString(), reasonCode: "support_case", idempotencyKey: "g-" + randomUUID() });
  expect(r.statusCode, r.body).toBe(200);
  return r.json().grantId as string;
}
async function expire(grantId: string) {
  await db.query("ALTER TABLE course_access_grants DISABLE TRIGGER course_access_grants_guard");
  try {
    await db.query("UPDATE course_access_grants SET created_at=created_at-interval '3 days',expires_at=clock_timestamp()-interval '1 minute' WHERE id=$1", [grantId]);
  } finally {
    await db.query("ALTER TABLE course_access_grants ENABLE TRIGGER course_access_grants_guard");
  }
}
const revoke = (grantId: string) => ok(s.owner!, "POST", `/api/admin/workspaces/${workspace}/course-grants/${grantId}/revoke`, { reasonCode: "case_closed", idempotencyKey: "r-" + randomUUID() });
const findings = [
  { criterionId: "invariant", met: true, quote: "the kept value is never greater than any element" },
  { criterionId: "every-element", met: true, quote: "compare every next element with it" },
  { criterionId: "edge", met: false, note: "Empty list not discussed." },
];
const decide = (who: Session, attemptId: string) =>
  call(who, "POST", `/api/admin/rubric-reviews/${attemptId}`, { decision: "met", criteria: findings, idempotencyKey: "k-" + randomUUID() });

let testDatabase: TestDatabase | undefined;
beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false, installedExtensions: [reviewedRubricEvaluator()] });
  workspace = randomUUID();
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspace, "scoped-" + workspace, "Scoped"]);
  for (const role of ["owner", "admin", "instructor", "reviewer", "observer", "learner"]) s[role] = await person(role);
  for (const name of ["scoped_reviewer", "scoped_instructor", "scoped_other", "scoped_expired", "scoped_revoked", "scoped_author", "scoped_author_other"])
    s[name] = await person("course_scoped", name);
  const course = rubricCourse("2.0.0");
  const releaseId = (await ok(s.owner!, "POST", `/api/workspaces/${workspace}/releases`, course)).id as string;
  await ok(s.owner!, "POST", `/api/releases/${releaseId}/publish`);
  const other = fixture();
  other.id = "scoped-other";
  other.title = "Other course";
  const otherId = (await ok(s.owner!, "POST", `/api/workspaces/${workspace}/releases`, other)).id as string;
  await ok(s.owner!, "POST", `/api/releases/${otherId}/publish`);
  const courses = (await ok(s.owner!, "GET", "/api/admin/session")).courses as { id: string; title: string }[];
  catalog = courses.find((c) => c.title === course.title)!.id;
  otherCatalog = courses.find((c) => c.title === "Other course")!.id;
  await grant(s.scoped_reviewer!, catalog, "reviewer");
  await grant(s.scoped_instructor!, catalog, "instructor");
  await grant(s.scoped_other!, otherCatalog, "reviewer");
  await expire(await grant(s.scoped_expired!, catalog, "reviewer"));
  await revoke(await grant(s.scoped_revoked!, catalog, "reviewer"));
  await grant(s.scoped_author!, catalog, "author");
  await grant(s.scoped_author_other!, otherCatalog, "author");
  enrollment = (await ok(s.learner!, "POST", "/api/enrollments", { releaseId })).id;
  const issued = await send(s.learner!, enrollment, "challenges", { episodeId: "min", assessmentId: "min-explain", mode: "independent" });
  const answered = await send(s.learner!, enrollment, "answers", { challengeId: issued.challengeId, answer: rubricExplanation });
  expect(answered.result).toMatchObject({ pendingReview: true });
  attempt = (await ok(s.instructor!, "GET", `/api/admin/courses/${catalog}/rubric-reviews`)).pending[0].attemptId;
}, 60000);
afterAll(async () => {
  await app?.close();
  await db?.end();
  await testDatabase?.drop();
});

describe("course-scoped review", () => {
  it("refuses written-answer decisions to members scoped to another course, or with an expired or revoked grant", async () => {
    for (const who of ["scoped_other", "scoped_expired", "scoped_revoked", "scoped_author", "observer", "learner"]) {
      const r = await decide(s[who]!, attempt);
      expect(r.statusCode, `${who}: ${r.body}`).toBe(403);
      expect((await call(s[who]!, "GET", `/api/admin/courses/${catalog}/rubric-reviews`)).statusCode, who).toBe(403);
    }
    // The member scoped to the other course reads that course's queue (empty), not this one.
    expect((await ok(s.scoped_other!, "GET", `/api/admin/courses/${otherCatalog}/rubric-reviews`)).pending).toEqual([]);
    expect((await db.query("SELECT count(*)::int AS n FROM rubric_reviews WHERE attempt_id=$1", [attempt])).rows[0].n).toBe(0);
  });

  it("lets a course-scoped reviewer read the queue and decide a written answer on their course, then stops at revocation", async () => {
    const queue = (await ok(s.scoped_reviewer!, "GET", `/api/admin/courses/${catalog}/rubric-reviews`)).pending as { attemptId: string; response: string }[];
    expect(queue).toEqual([expect.objectContaining({ attemptId: attempt, response: rubricExplanation })]);
    expect((await ok(s.scoped_reviewer!, "GET", `/api/admin/courses/${catalog}/gate-reviews`)).reviews).toEqual([]);
    expect((await ok(s.scoped_reviewer!, "GET", `/api/admin/courses/${catalog}/rubric-appeals`)).appeals).toEqual([]);
    const decided = await decide(s.scoped_reviewer!, attempt);
    expect(decided.statusCode, decided.body).toBe(200);
    const row = (await db.query("SELECT reviewer_id,decision FROM rubric_reviews WHERE attempt_id=$1", [attempt])).rows[0];
    expect(row).toEqual({ reviewer_id: s.scoped_reviewer!.userId, decision: "met" });
    // Revocation ends access on the next request, on every review surface.
    const grantId = (await db.query("SELECT id FROM course_access_grants WHERE user_id=$1 AND revoked_at IS NULL", [s.scoped_reviewer!.userId])).rows[0].id;
    await revoke(grantId);
    for (const url of [`/api/admin/courses/${catalog}/rubric-reviews`, `/api/admin/courses/${catalog}/gate-reviews`, `/api/admin/courses/${catalog}/rubric-appeals`])
      expect((await call(s.scoped_reviewer!, "GET", url)).statusCode, url).toBe(403);
  });

  it("lets a course-scoped author import a new version of their course only", async () => {
    const next = rubricCourse("2.1.0");
    const imported = await call(s.scoped_author!, "POST", `/api/workspaces/${workspace}/releases`, next);
    expect(imported.statusCode, imported.body).toBe(200);
    expect((await call(s.scoped_author_other!, "POST", `/api/workspaces/${workspace}/releases`, rubricCourse("2.2.0"))).statusCode).toBe(403);
    const unknown = fixture();
    unknown.id = "scoped-new-course";
    expect((await call(s.scoped_author!, "POST", `/api/workspaces/${workspace}/releases`, unknown)).statusCode).toBe(403);
    // Publishing stays workspace-wide (owner/admin).
    expect((await call(s.scoped_author!, "POST", `/api/releases/${imported.json().id}/publish`)).statusCode).toBe(403);
  });
});

describe("enrollment event feed privacy", () => {
  const MARK = {
    learner: "learner-note-" + randomUUID().slice(0, 8),
    agent: "agent-inference-" + randomUUID().slice(0, 8),
    staffReason: "accommodation-detail-" + randomUUID().slice(0, 8),
    staffUnlisted: "staff-unlisted-" + randomUUID().slice(0, 8),
    staffListed: "staff-decision-" + randomUUID().slice(0, 8),
    system: "system-state-" + randomUUID().slice(0, 8),
  };
  beforeAll(async () => {
    await transaction(db, async (client) => {
      const add = (actorKind: "learner" | "staff" | "agent" | "system", type: string, payload: Record<string, unknown>) =>
        appendEvent(client, { workspaceId: workspace, enrollmentId: enrollment, actorKind, type, payload, idempotencyKey: "plant:" + randomUUID() });
      await add("learner", "learner.note_written", { text: MARK.learner });
      await add("agent", "learner_model.proposal.created", { inference: MARK.agent });
      await add("staff", "policy.accommodation_authorized", { accommodationId: "acc-1", reasonRef: "ref-1", reason: MARK.staffReason });
      await add("staff", "staff.internal_note", { text: MARK.staffUnlisted });
      await add("staff", "assessment.reviewed", { attemptId: MARK.staffListed });
      await add("system", "enrollment.closed", { state: MARK.system });
    });
  });
  const feed = async (who: Session) => {
    const events: { event_type: string; actor_kind: string; payload: unknown; payloadWithheld: boolean }[] = [];
    let after = "0";
    for (;;) {
      const page = await ok(who, "GET", `/api/enrollments/${enrollment}/events?after=${after}`);
      events.push(...page.events);
      if (page.events.length < 100) return { events, withheld: page.withheld, body: JSON.stringify(events) };
      after = page.nextCursor;
    }
  };

  it("gives the learner every payload of their own record", async () => {
    const own = await feed(s.learner!);
    for (const mark of Object.values(MARK)) expect(own.body).toContain(mark);
    expect(own.events.every((e) => e.payloadWithheld === false)).toBe(true);
    expect(own.withheld).toBeUndefined();
  });

  for (const who of ["owner", "admin", "instructor", "scoped_instructor"])
    it(`shows ${who} only allowlisted staff/system payloads`, async () => {
      const staff = await feed(s[who]!);
      for (const mark of [MARK.learner, MARK.agent, MARK.staffReason, MARK.staffUnlisted]) expect(staff.body).not.toContain(mark);
      for (const mark of [MARK.staffListed, MARK.system]) expect(staff.body).toContain(mark);
      expect(staff.body).not.toContain(rubricExplanation);
      const byType = (type: string) => staff.events.find((e) => e.event_type === type)!;
      expect(byType("learner.note_written")).toMatchObject({ actor_kind: "learner", payload: null, payloadWithheld: true });
      expect(byType("learner_model.proposal.created")).toMatchObject({ payload: null, payloadWithheld: true });
      expect(byType("staff.internal_note")).toMatchObject({ payload: null, payloadWithheld: true });
      expect(byType("policy.accommodation_authorized")).toMatchObject({ payload: { accommodationId: "acc-1", reasonRef: "ref-1" }, payloadWithheld: false });
      for (const e of staff.events.filter((e) => e.actor_kind === "learner" || e.actor_kind === "agent")) expect(e.payload).toBeNull();
      expect(staff.withheld).toEqual([expect.objectContaining({ id: "event-payloads" })]);
    });

  for (const who of ["reviewer", "observer", "scoped_other", "scoped_expired", "scoped_revoked", "scoped_author"])
    it(`refuses the feed to ${who}`, async () => {
      expect([403, 404]).toContain((await call(s[who]!, "GET", `/api/enrollments/${enrollment}/events`)).statusCode);
    });
});

describe("one authorization path", () => {
  it("no source file outside course-access.ts takes a staff role from membership() directly", () => {
    const dir = join(import.meta.dirname, "..", "src");
    const offenders = readdirSync(dir).filter((f) => f.endsWith(".ts") && !["auth.ts", "course-access.ts"].includes(f))
      .filter((f) => /\bmembership\(/.test(readFileSync(join(dir, f), "utf8")));
    expect(offenders).toEqual([]);
  });
});
