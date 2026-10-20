import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, transaction, type Database } from "../src/database.js";
import { createTestDatabase, type TestDatabase } from "./test-database.js";
import { createServer } from "../src/server.js";
import { issueLoginCode } from "../src/auth.js";
import { createPostgresSupervisorBridge } from "../src/supervisor-bridge.js";
import { setSupervisionControl } from "../src/supervision-control.js";
import { DAILY_SUGGESTIONS } from "../src/cross-course.js";
import { WITHHELD_FROM_STAFF } from "../src/learner-privacy.js";
import { fixture } from "./fixture.js";

// Cross-course coordination through real HTTP and PostgreSQL: the staff mapping role matrix, the
// learner's per-pair opt-in, the host planner and verifier behind the learner coordinator, erasure,
// and that nothing here changes evidence or gates.
const origin = "http://localhost:4398",
  schema = "cross_course_" + randomUUID().replaceAll("-", ""),
  serviceToken = "cross-course-test-service-token";
let db: Database, app: Awaited<ReturnType<typeof createServer>>, testDatabase: TestDatabase | undefined;
interface Session { userId: string; cookie: string; csrf: string }
let wsA: string, wsB: string, releaseA: string, releaseB: string, catalogA: string;
let owner: Session, learner: Session, enrollmentA: string, enrollmentB: string;

async function person(roles: Record<string, string>, label = "person"): Promise<Session> {
  const id = randomUUID();
  await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [id, "cross:" + id, label]);
  for (const [workspace, role] of Object.entries(roles)) await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspace, id, role]);
  const r = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, id) } });
  return { userId: id, cookie: r.cookies.map((c) => c.name + "=" + c.value).join("; "), csrf: r.json().csrfToken };
}
function call(who: Session, method: "GET" | "POST", url: string, payload?: unknown) {
  return app.inject({ method, url, headers: { origin, cookie: who.cookie, "x-csrf-token": who.csrf }, ...(payload === undefined ? {} : { payload: payload as object }) });
}
async function ok(who: Session, method: "GET" | "POST", url: string, payload?: unknown) {
  const r = await call(who, method, url, payload);
  expect(r.statusCode, `${method} ${url} ${r.body}`).toBe(200);
  return r.json();
}
async function send(enrollment: string, action: string, body: Record<string, unknown>) {
  const revision = (await ok(learner, "GET", `/api/enrollments/${enrollment}`)).revision;
  return ok(learner, "POST", `/api/enrollments/${enrollment}/${action}`, { expectedRevision: revision, idempotencyKey: randomUUID(), ...body });
}
/** Independent answers to both families of the minimum gate: the objective is demonstrated. */
async function demonstrateMinimum(enrollment: string) {
  for (const [assessmentId, answer] of [["min-a", "two"], ["min-b", 4]] as const) {
    const issued = await send(enrollment, "challenges", { episodeId: "min", assessmentId, mode: "independent" });
    await send(enrollment, "answers", { challengeId: issued.challengeId, answer });
  }
}
async function publish(workspace: string, course: ReturnType<typeof fixture>) {
  const created = await ok(owner, "POST", `/api/workspaces/${workspace}/releases`, course);
  await ok(owner, "POST", `/api/releases/${created.id}/publish`);
  return created.id as string;
}
const links = () => [
  { relation: "equivalent", from: { releaseId: releaseA, objectiveId: "minimum" }, to: { releaseId: releaseB, objectiveId: "minimum" } },
  // In course A, "maximum" is a prerequisite of course B's "minimum" (course structure for this test).
  { relation: "prerequisite_of", from: { releaseId: releaseA, objectiveId: "maximum" }, to: { releaseId: releaseB, objectiveId: "minimum" } },
];
const save = (who: Session, expectedRevision: number, body: Record<string, unknown> = {}) =>
  call(who, "POST", "/api/admin/concept-mappings", { releaseIds: [releaseA, releaseB], expectedRevision, idempotencyKey: "map-" + randomUUID(), links: links(), ...body });
const consent = (granted: boolean, from = enrollmentB, other = enrollmentA) =>
  call(learner, "POST", `/api/enrollments/${from}/cross-course/consent`, { otherEnrollmentId: other, granted, idempotencyKey: "consent-" + randomUUID() });
const bridge = () => createPostgresSupervisorBridge(db, { serviceToken, workspaceIds: [wsA, wsB] });
const suggestionsIn = async (enrollment: string) =>
  (await db.query("SELECT kind,objective_id,source_objective_ids,state,verification FROM cross_course_suggestions WHERE enrollment_id=$1 ORDER BY kind", [enrollment])).rows;
const openWakeups = async (userId: string) =>
  (await db.query("SELECT reason FROM cross_course_wakeups WHERE user_id=$1 AND delivered_at IS NULL", [userId])).rows.map((r) => r.reason as string);

beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false, supervisor: { serviceToken, workspaceIds: [] } });
});
beforeEach(async () => {
  wsA = randomUUID(); wsB = randomUUID();
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,'Course A space'),($3,$4,'Course B space')", [wsA, "a-" + wsA, wsB, "b-" + wsB]);
  owner = await person({ [wsA]: "owner", [wsB]: "owner" }, "Owner of both");
  const a = fixture();
  const b = fixture(); b.id = "ordering-practice"; b.title = "Ordering practice";
  releaseA = await publish(wsA, a);
  releaseB = await publish(wsB, b);
  catalogA = (await db.query("SELECT id FROM admin_course_catalog WHERE workspace_id=$1", [wsA])).rows[0].id;
  learner = await person({ [wsA]: "learner", [wsB]: "learner" }, "Learner");
  enrollmentA = (await ok(learner, "POST", "/api/enrollments", { releaseId: releaseA })).id;
  enrollmentB = (await ok(learner, "POST", "/api/enrollments", { releaseId: releaseB })).id;
});
afterAll(async () => {
  await app?.close();
  await db?.end();
  await testDatabase?.drop();
});

describe("concept mappings: staff-authored, versioned and audited", () => {
  it("only owners or admins of both courses may save; reading needs course access to both", async () => {
    const instructorB = await person({ [wsA]: "owner", [wsB]: "instructor" });
    const authorB = await person({ [wsA]: "admin", [wsB]: "author" });
    const learnerB = await person({ [wsA]: "owner", [wsB]: "learner" });
    const outsider = await person({ [wsA]: "owner" });
    const reviewerBoth = await person({ [wsA]: "reviewer", [wsB]: "reviewer" });
    const scoped = await person({ [wsA]: "course_scoped", [wsB]: "owner" });
    // A course grant (even as author) never confers owner or admin.
    await db.query(`INSERT INTO course_access_grants(id,workspace_id,catalog_id,user_id,role,reason_code,granted_by,expires_at)
      VALUES($1,$2,$3,$4,'author','support_case',$5,clock_timestamp()+interval '1 day')`, [randomUUID(), wsA, catalogA, scoped.userId, owner.userId]);
    const adminBoth = await person({ [wsA]: "admin", [wsB]: "admin" });
    for (const [who, status] of [[instructorB, 403], [authorB, 403], [reviewerBoth, 403], [scoped, 403], [learnerB, 404], [outsider, 404]] as const)
      expect((await save(who, 0)).statusCode).toBe(status);
    const created = await save(adminBoth, 0);
    expect(created.statusCode, created.body).toBe(200);
    expect(created.json()).toMatchObject({ revision: 1, state: "active", authoredBy: "staff", inferred: false, replayed: false });
    expect(created.json().history[0]).toMatchObject({ revision: 1, action: "created", linkCount: 2, roles: { a: "admin", b: "admin" }, author: { id: adminBoth.userId } });
    // Reading: course.read on both (reviewers and instructors may read; a learner or outsider may not).
    const query = `/api/admin/concept-mappings?first=${releaseB}&second=${releaseA}`;
    expect((await call(reviewerBoth, "GET", query)).json().mapping.revision).toBe(1);
    expect((await call(instructorB, "GET", query)).statusCode).toBe(200);
    expect((await call(learnerB, "GET", query)).statusCode).toBe(404);
    expect((await call(outsider, "GET", query)).statusCode).toBe(404);
    // The editor's course picker lists only courses the actor may map.
    const candidates = await ok(instructorB, "GET", "/api/admin/concept-mappings/candidates");
    expect(candidates.courses.map((c: { workspaceId: string }) => c.workspaceId)).toEqual([wsA]);
    expect((await ok(adminBoth, "GET", "/api/admin/concept-mappings/candidates")).courses).toHaveLength(2);
  });

  it("validates links, versions every save, replays idempotently and keeps an immutable history", async () => {
    const wrong = await save(owner, 0, { links: [{ relation: "equivalent", from: { releaseId: releaseA, objectiveId: "nope" }, to: { releaseId: releaseB, objectiveId: "minimum" } }] });
    expect([wrong.statusCode, wrong.json().error]).toEqual([422, "OBJECTIVE_OUT_OF_SCOPE"]);
    const twice = await save(owner, 0, { links: [...links(), { relation: "overlaps", from: { releaseId: releaseB, objectiveId: "minimum" }, to: { releaseId: releaseA, objectiveId: "minimum" } }] });
    expect(twice.json().error).toBe("CONCEPT_MAPPING_DUPLICATE_LINK");
    const same = await call(owner, "POST", "/api/admin/concept-mappings", { releaseIds: [releaseA, releaseA], expectedRevision: 0, idempotencyKey: "same-" + randomUUID(), links: [] });
    expect(same.json().error).toBe("CONCEPT_MAPPING_SAME_RELEASE");
    const key = "map-" + randomUUID();
    const body = { releaseIds: [releaseB, releaseA], expectedRevision: 0, idempotencyKey: key, links: links(), note: "Reviewed with both course teams." };
    const first = await ok(owner, "POST", "/api/admin/concept-mappings", body);
    const replay = await ok(owner, "POST", "/api/admin/concept-mappings", body);
    expect(replay).toMatchObject({ id: first.id, revision: 1, replayed: true });
    expect((await call(owner, "POST", "/api/admin/concept-mappings", { ...body, links: [] })).json().error).toBe("IDEMPOTENCY_CONFLICT");
    expect((await save(owner, 0)).json().error).toBe("CONCEPT_MAPPING_STALE");
    // Symmetric relations are stored from the "a" release; direction is kept for prerequisites.
    const revised = await ok(owner, "POST", "/api/admin/concept-mappings", { releaseIds: [releaseA, releaseB], expectedRevision: 1, idempotencyKey: "map-" + randomUUID(),
      links: [{ relation: "overlaps", from: { releaseId: releaseB, objectiveId: "maximum" }, to: { releaseId: releaseA, objectiveId: "maximum" } }] });
    expect(revised.history.map((h: { action: string }) => h.action)).toEqual(["revised", "created"]);
    const a = [releaseA, releaseB].sort()[0];
    expect(revised.links[0].from.releaseId).toBe(a);
    const retired = await ok(owner, "POST", `/api/admin/concept-mappings/${first.id}/retire`, { expectedRevision: 2, idempotencyKey: "retire-" + randomUUID() });
    expect(retired).toMatchObject({ state: "retired", revision: 3 });
    // Stored versions cannot be changed or deleted, by anyone.
    await expect(db.query("UPDATE concept_mapping_versions SET links='[]' WHERE mapping_id=$1", [first.id])).rejects.toThrow(/CONCEPT_MAPPING_HISTORY_IMMUTABLE/);
    await expect(db.query("DELETE FROM concept_mapping_versions WHERE mapping_id=$1", [first.id])).rejects.toThrow(/CONCEPT_MAPPING_HISTORY_IMMUTABLE/);
    // Only staff authorship can be stored.
    await expect(db.query(`INSERT INTO concept_mapping_versions(mapping_id,revision,action,links,links_digest,author_kind,authored_by,a_role,b_role,idempotency_key,request_digest)
      VALUES($1,9,'revised','[]',$2,'model',$3,'owner','owner','model-key-1',$2)`, [first.id, "a".repeat(64), owner.userId])).rejects.toThrow();
    // Two versions of the same course are not a cross-course pair.
    const next = fixture(); next.version = "1.1.0";
    const releaseA2 = await publish(wsA, next);
    const sameCourse = await call(owner, "POST", "/api/admin/concept-mappings", { releaseIds: [releaseA, releaseA2], expectedRevision: 0, idempotencyKey: "same-" + randomUUID(), links: [] });
    expect(sameCourse.json().error).toBe("CONCEPT_MAPPING_SAME_COURSE");
  });
});

describe("the learner's opt-in, the coordinator's host passes and their limits", () => {
  beforeEach(async () => {
    expect((await save(owner, 0)).statusCode).toBe(200);
  });

  it("plans nothing without an opt-in, and only verified, learner-private suggestions with one", async () => {
    await demonstrateMinimum(enrollmentA);
    const host = bridge();
    // No opt-in: the coordinator would not run, and a pass finds nothing to do.
    expect(await host.crossCourseConsent(learner.userId)).toEqual({ active: false, consentRevision: 0 });
    expect(await host.planCrossCourse(learner.userId, 0)).toEqual({ status: "no_consent", consentRevision: 0, created: 0 });
    expect(await host.observeEnrollment(wsB, enrollmentB)).toEqual({ learnerId: null });
    expect(await openWakeups(learner.userId)).toEqual([]); // New evidence without an opt-in wakes nothing.
    // The pair is offered in either course's profile, off by default.
    const view = await ok(learner, "GET", `/api/enrollments/${enrollmentB}/cross-course`);
    expect(view.pairs).toEqual([expect.objectContaining({ otherEnrollmentId: enrollmentA, consent: { granted: false, revision: 0, changedAt: null }, canGrant: true,
      mapping: expect.objectContaining({ links: 2, relations: { equivalent: 1, prerequisite_of: 1, overlaps: 0 } }) })]);
    expect((await consent(true)).json()).toMatchObject({ granted: true, revision: 1 });
    expect(await openWakeups(learner.userId)).toEqual(["consent_granted"]);
    expect(await host.crossCourseConsent(learner.userId)).toEqual({ active: true, consentRevision: 1 });
    expect(await host.planCrossCourse(learner.userId, 1)).toEqual({ status: "planned", consentRevision: 1, created: 3 });
    const made = await suggestionsIn(enrollmentB);
    expect(made.map((s) => [s.kind, s.objective_id, s.source_objective_ids])).toEqual([
      ["pacing", null, ["maximum"]], ["prerequisite_reminder", "minimum", ["maximum"]], ["shown_elsewhere", "minimum", ["minimum"]]]);
    // Each was verified against the opt-in, the mapping version and course A's own gate rule; none grants anything.
    expect(made.find((s) => s.kind === "shown_elsewhere")!.verification).toMatchObject({ verifier: "cross-course-host-v1", consentRevision: 1, mappingRevision: 1,
      source: [{ objectiveId: "minimum", demonstrated: true, families: 2, required: 2 }], grantsMastery: false, grantsEvidence: false, changesGates: false });
    expect(await suggestionsIn(enrollmentA)).toEqual([]);
    // A repeat pass proposes nothing twice.
    expect((await host.planCrossCourse(learner.userId, 1)).created).toBe(0);
    // The learner sees them in course B; staff see none of it, anywhere.
    const mine = await ok(learner, "GET", `/api/enrollments/${enrollmentB}/cross-course`);
    expect(mine.suggestions.map((s: { kind: string; otherCourseTitle: string; grantsMastery: boolean }) => [s.kind, s.otherCourseTitle, s.grantsMastery]))
      .toEqual(expect.arrayContaining([["shown_elsewhere", "Ordering values", false]]));
    expect((await call(owner, "GET", `/api/enrollments/${enrollmentB}/cross-course`)).statusCode).toBe(404);
    const staffCopy = await ok(owner, "GET", `/api/admin/enrollments/${enrollmentB}/export`);
    expect(staffCopy.crossCourse).toBeNull();
    expect(staffCopy.withheld).toEqual(WITHHELD_FROM_STAFF);
    expect(WITHHELD_FROM_STAFF.map((w) => w.id)).toContain("cross-course");
    const ownCopy = await ok(learner, "GET", `/api/enrollments/${enrollmentB}/export`);
    expect(ownCopy.crossCourse.suggestions).toHaveLength(3);
    expect(ownCopy.crossCourse.consents[0]).toMatchObject({ other_enrollment_id: enrollmentA, state: "granted" });
  });

  it("never changes evidence, mastery or gates; a confirmation is a supervised learner event in that course only", async () => {
    await demonstrateMinimum(enrollmentA);
    await consent(true);
    await bridge().planCrossCourse(learner.userId, 1);
    const before = {
      evidence: (await db.query("SELECT count(*)::int AS n FROM evidence WHERE enrollment_id=$1", [enrollmentB])).rows[0].n,
      decisions: (await db.query("SELECT count(*)::int AS n FROM gate_decisions WHERE enrollment_id=$1", [enrollmentB])).rows[0].n,
      progress: (await db.query("SELECT count(*)::int AS n FROM episode_progress WHERE enrollment_id=$1", [enrollmentB])).rows[0].n,
    };
    const shown = (await ok(learner, "GET", `/api/enrollments/${enrollmentB}/cross-course`)).suggestions.find((s: { kind: string }) => s.kind === "shown_elsewhere");
    const confirmed = await ok(learner, "POST", `/api/enrollments/${enrollmentB}/cross-course/suggestions/${shown.id}/decision`, { action: "confirm", idempotencyKey: "decide-" + randomUUID() });
    expect(confirmed).toMatchObject({ state: "confirmed", grantsMastery: false });
    const event = (await db.query("SELECT e.payload,e.actor_kind,o.kind AS outbox FROM learning_events e LEFT JOIN outbox o ON o.event_id=e.id WHERE e.enrollment_id=$1 AND e.event_type='cross_course.suggestion_confirmed'", [enrollmentB])).rows;
    expect(event).toEqual([{ payload: { suggestionId: shown.id, kind: "shown_elsewhere", objectiveId: "minimum", grantsMastery: false }, actor_kind: "learner", outbox: "supervisor.event" }]);
    // Course B's own gate rule still says not demonstrated; nothing was written to its evidence or gates.
    const model = await ok(learner, "GET", `/api/enrollments/${enrollmentB}/learner-model?episodeId=min`);
    expect(model.understanding.find((u: { objectiveId: string }) => u.objectiveId === "minimum")).toMatchObject({ demonstrated: false, status: "needs_evidence" });
    expect({
      evidence: (await db.query("SELECT count(*)::int AS n FROM evidence WHERE enrollment_id=$1", [enrollmentB])).rows[0].n,
      decisions: (await db.query("SELECT count(*)::int AS n FROM gate_decisions WHERE enrollment_id=$1", [enrollmentB])).rows[0].n,
      progress: (await db.query("SELECT count(*)::int AS n FROM episode_progress WHERE enrollment_id=$1", [enrollmentB])).rows[0].n,
    }).toEqual(before);
    const snapshot = await ok(learner, "GET", `/api/enrollments/${enrollmentB}`);
    expect(JSON.stringify(snapshot.evidence ?? [])).not.toContain(enrollmentA);
    // Dismissing records the choice; deciding twice the other way is refused; staff cannot decide.
    const pacing = (await ok(learner, "GET", `/api/enrollments/${enrollmentB}/cross-course`)).suggestions.find((s: { kind: string }) => s.kind === "pacing");
    expect((await ok(learner, "POST", `/api/enrollments/${enrollmentB}/cross-course/suggestions/${pacing.id}/decision`, { action: "dismiss", idempotencyKey: "decide-" + randomUUID() })).state).toBe("dismissed");
    expect((await call(learner, "POST", `/api/enrollments/${enrollmentB}/cross-course/suggestions/${pacing.id}/decision`, { action: "confirm", idempotencyKey: "decide-" + randomUUID() })).statusCode).toBe(409);
    const reminder = (await ok(learner, "GET", `/api/enrollments/${enrollmentB}/cross-course`)).suggestions.find((s: { kind: string }) => s.kind === "prerequisite_reminder");
    expect((await call(owner, "POST", `/api/enrollments/${enrollmentB}/cross-course/suggestions/${reminder.id}/decision`, { action: "confirm", idempotencyKey: "decide-" + randomUUID() })).statusCode).toBe(404);
  });

  it("re-verifies on confirmation: evidence that stopped counting withdraws the suggestion", async () => {
    await demonstrateMinimum(enrollmentA);
    await consent(true);
    await bridge().planCrossCourse(learner.userId, 1);
    const shown = (await ok(learner, "GET", `/api/enrollments/${enrollmentB}/cross-course`)).suggestions.find((s: { kind: string }) => s.kind === "shown_elsewhere");
    // The learner excludes one of the course A answers from AI context: it no longer crosses either.
    const evidenceId = (await db.query("SELECT id FROM evidence WHERE enrollment_id=$1 AND objective_id='minimum' ORDER BY created_at LIMIT 1", [enrollmentA])).rows[0].id;
    const revision = (await ok(learner, "GET", `/api/enrollments/${enrollmentA}`)).revision;
    await ok(learner, "POST", `/api/enrollments/${enrollmentA}/learner-model/evidence/${evidenceId}/control`, { expectedRevision: revision, idempotencyKey: "exclude-" + randomUUID(), action: "exclude" });
    expect(await openWakeups(learner.userId)).toContain("consent_granted");
    const decided = await ok(learner, "POST", `/api/enrollments/${enrollmentB}/cross-course/suggestions/${shown.id}/decision`, { action: "confirm", idempotencyKey: "decide-" + randomUUID() });
    expect(decided).toMatchObject({ state: "withdrawn", reason: "SOURCE_NOT_DEMONSTRATED" });
    expect((await db.query("SELECT 1 FROM learning_events WHERE enrollment_id=$1 AND event_type='cross_course.suggestion_confirmed'", [enrollmentB])).rowCount).toBe(0);
  });

  it("revocation removes what was shared and stops the coordinator; erasure of either course removes the link", async () => {
    await demonstrateMinimum(enrollmentA);
    await consent(true);
    const host = bridge();
    await host.planCrossCourse(learner.userId, 1);
    expect(await suggestionsIn(enrollmentB)).toHaveLength(3);
    // The dispatcher's delivery of the grant: an active wake-up.
    const [grant] = await host.claimCrossCourse(randomUUID(), 10, 30_000);
    expect(grant).toMatchObject({ learnerId: learner.userId, active: true, consentRevision: 1, reason: "consent_granted" });
    expect(await host.ackCrossCourse(grant!, true)).toBe(true);
    const revoked = await consent(false, enrollmentA, enrollmentB);
    expect(revoked.json()).toMatchObject({ granted: false, revision: 2, removedSuggestions: 3 });
    expect(await suggestionsIn(enrollmentB)).toEqual([]);
    expect(await host.planCrossCourse(learner.userId, 2)).toEqual({ status: "no_consent", consentRevision: 2, created: 0 });
    const [stop] = await host.claimCrossCourse(randomUUID(), 10, 30_000);
    expect(stop).toMatchObject({ active: false, consentRevision: 2, reason: "consent_revoked" });
    await host.ackCrossCourse(stop!, true);
    // The history keeps the learner's choices (identifiers and states only) and cannot be rewritten.
    const consentId = (await db.query("SELECT id FROM cross_course_consents WHERE user_id=$1", [learner.userId])).rows[0].id;
    expect((await db.query("SELECT granted FROM cross_course_consent_changes WHERE consent_id=$1 ORDER BY revision", [consentId])).rows).toEqual([{ granted: true }, { granted: false }]);
    await expect(db.query("UPDATE cross_course_consent_changes SET granted=true WHERE consent_id=$1", [consentId])).rejects.toThrow(/CROSS_COURSE_CONSENT_HISTORY_IMMUTABLE/);
    await expect(db.query("DELETE FROM cross_course_consent_changes WHERE consent_id=$1", [consentId])).rejects.toThrow(/CROSS_COURSE_CONSENT_HISTORY_IMMUTABLE/);
    // Granting again starts afresh; then erasing course A removes the pair, its history and B's suggestions.
    await consent(true);
    expect((await host.planCrossCourse(learner.userId, 3)).created).toBe(3);
    const erased = await call(learner, "POST", `/api/enrollments/${enrollmentA}/erase`, { confirmation: `ERASE ${enrollmentA.slice(0, 8)}`, reason: "Learner asked for their course data to be removed." });
    expect(erased.statusCode, erased.body).toBe(200);
    expect(erased.json().counts).toMatchObject({ crossCourseConsents: 1, crossCourseConsentChanges: 3, crossCourseSuggestions: 3 });
    expect((await db.query("SELECT count(*)::int AS n FROM cross_course_consents WHERE a_enrollment_id=$1 OR b_enrollment_id=$1", [enrollmentA])).rows[0].n).toBe(0);
    expect((await db.query("SELECT count(*)::int AS n FROM cross_course_suggestions WHERE source_enrollment_id=$1 OR enrollment_id=$1", [enrollmentA])).rows[0].n).toBe(0);
    // The coordinator is woken (coalesced into the open wake-up) and finds nothing left.
    expect(await openWakeups(learner.userId)).toHaveLength(1);
    expect(await host.crossCourseConsent(learner.userId)).toMatchObject({ active: false });
    expect((await ok(learner, "GET", `/api/enrollments/${enrollmentB}/cross-course`)).pairs).toEqual([]);
  });

  it("keeps to the learner's daily allowance, pending caps, staff supervision controls and authorized workspaces", async () => {
    await demonstrateMinimum(enrollmentA);
    await consent(true);
    // Staff paused AI supervision in course B: nothing is suggested there.
    await transaction(db, (client) => setSupervisionControl(client, { workspaceId: wsB, enrollmentId: enrollmentB, action: "pause", idempotencyKey: "pause-" + randomUUID() }));
    expect((await bridge().planCrossCourse(learner.userId, 1)).created).toBe(0);
    await transaction(db, (client) => setSupervisionControl(client, { workspaceId: wsB, enrollmentId: enrollmentB, action: "resume", idempotencyKey: "resume-" + randomUUID() }));
    // A dispatcher authorized for only one of the two workspaces cannot act for the pair.
    const partial = createPostgresSupervisorBridge(db, { serviceToken, workspaceIds: [wsA] });
    expect(await partial.planCrossCourse(learner.userId, 1)).toMatchObject({ status: "no_consent", created: 0 });
    // The day's allowance used up: the coordinator waits until it renews.
    const consentId = (await db.query("SELECT id FROM cross_course_consents WHERE user_id=$1", [learner.userId])).rows[0].id;
    const mappingId = (await db.query("SELECT id FROM concept_mappings WHERE a_release_id=ANY($1::uuid[])", [[releaseA, releaseB]])).rows[0].id;
    for (let i = 0; i < DAILY_SUGGESTIONS; i++)
      await db.query(`INSERT INTO cross_course_suggestions(id,consent_id,enrollment_id,workspace_id,source_enrollment_id,kind,objective_id,source_objective_ids,relation,mapping_id,mapping_revision,consent_revision,dedupe_key,verification,state,decided_at)
        VALUES($1,$2,$3,$4,$5,'shown_elsewhere','maximum','["maximum"]','overlaps',$6,1,1,$7,'{}','dismissed',clock_timestamp())`,
      [randomUUID(), consentId, enrollmentA, wsA, enrollmentB, mappingId, (i + "").padStart(64, "0")]);
    const waiting = await bridge().planCrossCourse(learner.userId, 1);
    expect(waiting).toMatchObject({ status: "budget_wait", created: 0 });
    expect(waiting.retryAfterMs).toBeGreaterThan(0);
    expect(waiting.retryAfterMs).toBeLessThanOrEqual(86_400_000);
  });

  it("serves the coordinator's host calls over the authenticated bridge only", async () => {
    await consent(true);
    const rpc = (body: unknown, token = serviceToken) => app.inject({ method: "POST", url: "/v1/supervisor/bridge", headers: { authorization: `Bearer ${token}` }, payload: body as object });
    // This server authorizes no workspace: every learner looks unconsented to it.
    expect((await rpc({ method: "crosscourse.consent", learnerId: learner.userId })).json()).toEqual({ active: false, consentRevision: 1 });
    expect((await rpc({ method: "crosscourse.consent", learnerId: learner.userId }, "wrong-token")).statusCode).toBe(401);
    expect((await rpc({ method: "crosscourse.plan", learnerId: "not-a-uuid", consentRevision: 1 })).statusCode).toBe(400);
    expect((await rpc({ method: "crosscourse.claim", ownerId: randomUUID(), limit: 10, leaseMs: 30_000 })).json()).toEqual([]);
  });
});
