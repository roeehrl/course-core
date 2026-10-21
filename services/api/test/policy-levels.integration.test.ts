import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import type { CourseManifest } from "@course-core/sdk";
import { createDatabase, type Database } from "../src/database.js";
import { createTestDatabase, type TestDatabase } from "./test-database.js";
import { createServer } from "../src/server.js";
import { issueLoginCode } from "../src/auth.js";
import { offsetClock } from "../src/clock.js";
import { DEFAULT_COURSE_POLICY_SETTINGS, DEFAULT_ORGANIZATION_CEILINGS } from "../src/policy-adapter.js";
import { closeReached } from "../src/wakeups.js";
import { fixture } from "./fixture.js";
import { retentionCourse } from "./retention-fixture.js";

/** G02/G03 policy levels, G05 batch adjustments, G09/Q05 allowance pools and the cross-learner
 * view, G15 the continuation track, M02 first-class records — over real HTTP and Postgres. */
const origin = "http://localhost:4393",
  schema = "policylevels_" + randomUUID().replaceAll("-", "");
const DAY = 86_400_000;
const clock = offsetClock();
let db: Database, app: Awaited<ReturnType<typeof createServer>>;
let workspace: string, owner: Session, instructor: Session, learner: Session, other: Session, course: string, release: string, version = 0;
interface Session { userId: string; cookie: string; csrf: string }
async function session(role: string, name = role + " person"): Promise<Session> {
  const id = randomUUID();
  await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [id, "levels:" + id, name]);
  await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspace, id, role]);
  const r = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, id) } });
  return { userId: id, cookie: r.cookies.map((c) => c.name + "=" + c.value).join("; "), csrf: r.json().csrfToken };
}
const call = (who: Session, method: "GET" | "POST" | "PUT", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { origin, cookie: who.cookie, "x-csrf-token": who.csrf }, ...(payload === undefined ? {} : { payload: payload as object }) });
async function publish(manifest: CourseManifest) {
  manifest.version = `1.0.${version++}`;
  const id = (await call(owner, "POST", `/api/workspaces/${workspace}/releases`, manifest)).json().id;
  expect((await call(owner, "POST", `/api/releases/${id}/publish`)).statusCode).toBe(200);
  return id as string;
}
async function enroll(who: Session) {
  const r = await call(who, "POST", "/api/enrollments", { releaseId: release });
  expect(r.statusCode, r.body).toBe(200);
  return r.json().id as string;
}
const revisionOf = async (who: Session, id: string) => (await call(who, "GET", `/api/enrollments/${id}`)).json().revision as number;
const ceilingsUrl = () => `/api/admin/workspaces/${workspace}/policy-ceilings`;
const ceilings = (over: Record<string, unknown> = {}) => ({ ...structuredClone(DEFAULT_ORGANIZATION_CEILINGS), ...over });
async function saveSettings(value: Record<string, unknown>) {
  const current = (await call(owner, "GET", `/api/admin/courses/${course}/policy-settings`)).json();
  const saved = await call(owner, "PUT", `/api/admin/courses/${course}/policy-settings`, { expectedRevision: current.revision, settings: value, reason: "Allowance review" });
  expect(saved.statusCode, saved.body).toBe(200);
  return saved.json();
}
const constraint = async (who: Session, id: string, scopeId: string) =>
  ((await call(who, "GET", `/api/enrollments/${id}/policy`)).json().constraints as { scopeId: string; effectiveDeadline: string; binding: { deadline: { scopeId: string; level: string } | null } }[])
    .find((c) => c.scopeId === scopeId)!;

let testDatabase: TestDatabase | undefined;
beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false, clock });
});
beforeEach(async () => {
  clock.set(0);
  workspace = randomUUID();
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspace, "levels-" + workspace, "Levels"]);
  owner = await session("owner");
  instructor = await session("instructor");
  learner = await session("learner", "Ada Learner");
  other = await session("learner", "Ben Learner");
  release = await publish(fixture());
  course = (await db.query("SELECT id FROM admin_course_catalog WHERE workspace_id=$1", [workspace])).rows[0].id;
});
afterAll(async () => {
  await app?.close();
  await db?.end();
  await testDatabase?.drop();
});

describe("organization and enrollment levels (G02, G03)", () => {
  it("previews ceilings against every course before saving, applies them to new enrollments, and names the organization when it binds", async () => {
    const before = await enroll(other);
    const view = await call(owner, "GET", ceilingsUrl());
    expect(view.statusCode, view.body).toBe(200);
    expect(view.json()).toMatchObject({ source: "default", revision: 0, appliesTo: "new_enrollments" });
    // Test before save: a 10-day ceiling clips the course's 30-day window, which the preview says.
    const proposed = ceilings({ maxEnrollmentDays: 10, work: { additionalMinutes: 500, additionalEpisodes: null, remediationCyclesPerConcept: null } });
    const preview = await call(owner, "POST", `${ceilingsUrl()}/preview`, { ceilings: proposed });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json().impact).toEqual([expect.objectContaining({ courseId: course, feasible: true,
      issues: expect.arrayContaining([expect.objectContaining({ code: "LOOSER_CHILD_DEADLINE", scopeId: "course" })]) })]);
    // Nothing was saved by the preview.
    expect((await call(owner, "GET", ceilingsUrl())).json().revision).toBe(0);
    expect((await call(owner, "POST", `${ceilingsUrl()}/preview`, { ceilings: { ...proposed, maxEnrollmentDays: 0 } })).statusCode).toBe(400);
    const saved = await call(owner, "PUT", ceilingsUrl(), { expectedRevision: 0, ceilings: proposed, reason: "Organization terms 2026" });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toMatchObject({ revision: 1, source: "configured", outcome: "saved" });
    expect((await call(owner, "PUT", ceilingsUrl(), { expectedRevision: 0, ceilings: proposed, reason: "Again" })).json().error).toBe("STALE_REVISION");
    // A new learner's course is bound by the organization's 10-day ceiling; the explanation names it.
    const after = await enroll(learner);
    const bound = await constraint(learner, after, "course");
    expect(bound.binding.deadline).toMatchObject({ scopeId: "organization", level: "organization", kind: "window" });
    expect(Date.parse(bound.effectiveDeadline) - Date.now()).toBeLessThan(11 * DAY);
    const episode = await constraint(learner, after, "episode:min");
    expect(episode.binding.deadline).toMatchObject({ scopeId: "organization" });
    // The existing learner keeps the terms they started with.
    expect((await constraint(other, before, "course")).binding.deadline).toMatchObject({ scopeId: "course" });
    // History keeps who saved what and why.
    const historyBody = (await call(owner, "GET", `/api/admin/courses/${course}/policy-history`)).json();
    const history = historyBody.revisions;
    expect(history[0]).toMatchObject({ level: "organization", revision: 1, reason: "Organization terms 2026", changedBy: { id: owner.userId } });
    // The same route's field-by-field timeline shows the ceiling change above the course.
    const ceilingEntry = historyBody.entries.find((e: { source: string }) => e.source === "organization_ceilings");
    expect(ceilingEntry).toMatchObject({ revision: 1, reason: "Organization terms 2026" });
    expect(ceilingEntry.changes.length).toBeGreaterThan(0);
    expect(ceilingEntry.changes.every((c: { before: string | null }) => c.before === null)).toBe(true);
    expect((await db.query("SELECT count(*)::int AS n FROM learning_events WHERE workspace_id=$1 AND event_type='policy.ceilings_changed'", [workspace])).rows[0].n).toBe(1);
  });

  it("lets only workspace owners and admins change ceilings", async () => {
    expect((await call(instructor, "GET", ceilingsUrl())).statusCode).toBe(200);
    expect((await call(instructor, "PUT", ceilingsUrl(), { expectedRevision: 0, ceilings: ceilings(), reason: "x" })).statusCode).toBe(403);
    expect((await call(instructor, "POST", `${ceilingsUrl()}/preview`, { ceilings: ceilings() })).statusCode).toBe(403);
    expect((await call(learner, "GET", ceilingsUrl())).statusCode).toBe(403);
    const elsewhere = randomUUID();
    await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [elsewhere, "other-" + elsewhere, "Other"]);
    expect((await call(owner, "GET", `/api/admin/workspaces/${elsewhere}/policy-ceilings`)).statusCode).toBe(403);
  });

  it("an organization that turns extensions off disables every course's extensions for new learners", async () => {
    await call(owner, "PUT", ceilingsUrl(), { expectedRevision: 0, ceilings: ceilings({ extensionsAllowed: false }), reason: "No extensions" });
    const id = await enroll(learner);
    const preview = await call(learner, "POST", `/api/enrollments/${id}/extensions/preview`, { scopeId: "course", days: 1 });
    expect(preview.json().error).toBe("EXTENSIONS_DISABLED");
  });

  it("refuses an enrollment-level change that loosens its parent, and applies one that tightens it", async () => {
    const id = await enroll(learner);
    const end = (await constraint(learner, id, "course")).effectiveDeadline;
    const later = new Date(Date.parse(end) + 5 * DAY).toISOString(), earlier = new Date(Date.parse(end) - 5 * DAY).toISOString();
    const loose = await call(owner, "POST", `/api/admin/courses/${course}/policy/cohort/preview`, { change: { scopeId: "enrollment", hardDeadline: later } });
    expect(loose.statusCode, loose.body).toBe(200);
    expect(loose.json().refused).toEqual([{ enrollmentId: id, code: "LOOSER_THAN_PARENT" }]);
    const tight = await call(owner, "POST", `/api/admin/courses/${course}/policy/cohort/preview`, { change: { scopeId: "enrollment", hardDeadline: earlier } });
    expect(tight.json().enrollments).toHaveLength(1);
    const applied = await call(owner, "POST", `/api/admin/courses/${course}/policy/cohort/apply`, { migrationId: tight.json().migrationId, previewDigest: tight.json().previewDigest, reason: "Learner asked to finish sooner" });
    expect(applied.statusCode, applied.body).toBe(200);
    const bound = await constraint(learner, id, "episode:min");
    expect(bound.binding.deadline).toMatchObject({ scopeId: "enrollment", level: "enrollment" });
    expect(bound.effectiveDeadline).toBe(earlier.replace(".000Z", ".000Z"));
    // Every policy revision is a first-class record with its cause (M02).
    const revisions = (await call(owner, "GET", `/api/admin/enrollments/${id}/policy-revisions`)).json().revisions;
    expect(revisions[0]).toMatchObject({ cause: "migrate_policy" });
    expect(revisions.at(-1)).toMatchObject({ policyRevision: 1, cause: "created" });
  });
});

describe("batch accommodations and outage adjustments (G05)", () => {
  const batch = (body: Record<string, unknown>) => call(owner, "POST", `/api/admin/courses/${course}/accommodations/batch/preview`, body);
  it("previews one outage adjustment for every active learner, applies it once with an audit trail, and keeps pools untouched", async () => {
    const a = await enroll(learner), b = await enroll(other);
    const before = { a: (await constraint(learner, a, "course")).effectiveDeadline, b: (await constraint(other, b, "course")).effectiveDeadline };
    const preview = await batch({ scopeId: "course", kind: "outage", change: { deadline: { kind: "window", calendarDays: 2 } } });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json().enrollments.map((e: { enrollmentId: string }) => e.enrollmentId).sort()).toEqual([a, b].sort());
    expect(preview.json().enrollments[0]).toMatchObject({ bindingAfter: { scopeId: "course" } });
    const body = { batchId: preview.json().batchId, previewDigest: preview.json().previewDigest, reason: "Incident 42: service unavailable for two days" };
    expect((await call(owner, "POST", `/api/admin/courses/${course}/accommodations/batch/apply`, { ...body, reason: "" })).statusCode).toBe(400);
    const applied = await call(owner, "POST", `/api/admin/courses/${course}/accommodations/batch/apply`, body);
    expect(applied.statusCode, applied.body).toBe(200);
    expect(applied.json()).toMatchObject({ applied: 2, replayed: false, outcome: "applied" });
    expect(Date.parse((await constraint(learner, a, "course")).effectiveDeadline) - Date.parse(before.a)).toBe(2 * DAY);
    expect(Date.parse((await constraint(other, b, "course")).effectiveDeadline) - Date.parse(before.b)).toBe(2 * DAY);
    // A replay applies nothing twice.
    expect((await call(owner, "POST", `/api/admin/courses/${course}/accommodations/batch/apply`, body)).json()).toMatchObject({ applied: 2, replayed: true });
    const overrides = (await db.query("SELECT enrollment_id,kind,batch_id,authorized_by FROM accommodation_overrides WHERE batch_id=$1 ORDER BY enrollment_id", [body.batchId])).rows;
    expect(overrides).toEqual([a, b].sort().map((id) => ({ enrollment_id: id, kind: "outage", batch_id: body.batchId, authorized_by: owner.userId })));
    const batches = (await call(instructor, "GET", `/api/admin/courses/${course}/accommodations/batches`)).json().batches;
    expect(batches[0]).toMatchObject({ batchId: body.batchId, kind: "outage", applied: 2, reason: body.reason });
    expect((await db.query("SELECT count(*)::int AS n FROM learning_events WHERE workspace_id=$1 AND event_type='policy.accommodation_batch_applied'", [workspace])).rows[0].n).toBe(1);
    // Discretionary pools are separate: nothing was debited.
    expect((await db.query("SELECT coalesce(sum(debited),0)::int AS n FROM extension_pools WHERE enrollment_id=ANY($1::uuid[])", [[a, b]])).rows[0].n).toBe(0);
  });

  it("refuses a stale batch as a whole, an outage that adds work per learner, and staff without policy authority", async () => {
    const a = await enroll(learner), b = await enroll(other);
    const preview = (await batch({ scopeId: "course", kind: "accommodation", change: { deadline: { kind: "window", calendarDays: 1 } }, enrollmentIds: [a, b] })).json();
    // One learner's terms change after the preview: nothing is applied to anyone.
    const one = (await batch({ scopeId: "course", kind: "accommodation", change: { deadline: { kind: "window", calendarDays: 3 } }, enrollmentIds: [b] })).json();
    expect((await call(owner, "POST", `/api/admin/courses/${course}/accommodations/batch/apply`, { batchId: one.batchId, previewDigest: one.previewDigest, reason: "Approved request" })).statusCode).toBe(200);
    const stale = await call(owner, "POST", `/api/admin/courses/${course}/accommodations/batch/apply`, { batchId: preview.batchId, previewDigest: preview.previewDigest, reason: "Approved request" });
    expect(stale.json().error).toBe("STALE_PREVIEW");
    expect((await db.query("SELECT count(*)::int AS n FROM accommodation_overrides WHERE enrollment_id=$1", [a])).rows[0].n).toBe(0);
    const work = await batch({ scopeId: "course", kind: "outage", change: { work: { additionalMinutes: 30 } } });
    expect(work.json().enrollments).toEqual([]);
    expect(work.json().refused.map((r: { code: string }) => r.code)).toEqual(["OUTAGE_DEADLINE_ONLY", "OUTAGE_DEADLINE_ONLY"]);
    expect((await call(instructor, "POST", `/api/admin/courses/${course}/accommodations/batch/preview`, { scopeId: "course", kind: "outage", change: { deadline: { kind: "window", calendarDays: 1 } } })).statusCode).toBe(403);
    expect((await call(learner, "POST", `/api/admin/courses/${course}/accommodations/batch/preview`, { scopeId: "course", kind: "outage", change: { deadline: { kind: "window", calendarDays: 1 } } })).statusCode).toBe(403);
    expect((await batch({ scopeId: "course", kind: "outage", change: {} })).statusCode).toBe(400);
    expect((await batch({ scopeId: "course", kind: "outage", change: { deadline: { kind: "window", calendarDays: 1 } }, enrollmentIds: [randomUUID()] })).statusCode).toBe(404);
  });
});

describe("allowance pools and the cross-learner view (G09, Q05)", () => {
  it("configures minute and per-chapter day pools with a preview, draws minutes on request, and queues the approval across learners", async () => {
    const manifest = fixture();
    manifest.policy.work = { additionalMinutes: 600, additionalEpisodes: 10 };
    release = await publish(manifest);
    const pools = [
      { id: "study-time", unit: "planned_minute", appliesTo: "course", sharing: "shared", total: 120, maxPerGrant: 60, maxGrants: 2 },
      { id: "chapter-days", unit: "calendar_day", appliesTo: "every_chapter", sharing: "per_scope", total: 4, maxPerGrant: 2, maxGrants: 2 },
    ];
    const value = { ...structuredClone(DEFAULT_COURSE_POLICY_SETTINGS), extensions: { ...DEFAULT_COURSE_POLICY_SETTINGS.extensions, approval: "learner_and_admin" }, extensionPools: pools };
    const preview = await call(owner, "POST", `/api/admin/courses/${course}/policy-settings/preview`, { settings: value });
    expect(preview.statusCode, preview.body).toBe(200);
    const coverage = preview.json().preview.pools as { poolId: string; unusableScopeIds: string[]; source: string }[];
    expect(coverage.find((p) => p.poolId === "admin:study-time")).toMatchObject({ source: "admin", unusableScopeIds: [] });
    // The fixture's chapters have no deadline of their own: a day pool there could never be used, and the preview says so.
    const chapterPool = coverage.find((p) => p.poolId.startsWith("admin:chapter-days:"))!;
    expect(chapterPool.unusableScopeIds).toEqual([chapterPool.poolId.slice("admin:chapter-days:".length)]);
    expect((await call(owner, "POST", `/api/admin/courses/${course}/policy-settings/preview`, { settings: { ...value, extensionPools: [{ ...pools[0], maxPerGrant: 500 }] } })).statusCode).toBe(400);
    await saveSettings(value);
    const id = await enroll(learner);
    const event = (await db.query("SELECT id FROM learning_events WHERE enrollment_id=$1 AND event_type='enrollment.started'", [id])).rows[0].id;
    // Planned minutes are a named unit, paid from the minute pool.
    const minutes = await call(learner, "POST", `/api/enrollments/${id}/extensions/preview`, { scopeId: "course", minutes: 30 });
    expect(minutes.statusCode, minutes.body).toBe(200);
    expect(minutes.json().poolDebits).toEqual([{ poolId: "admin:study-time", amount: 30 }]);
    expect((await call(learner, "POST", `/api/enrollments/${id}/extensions/preview`, { scopeId: "course", episodes: 1 })).json().error).toBe("NO_POOL_FOR_UNIT");
    expect((await call(learner, "POST", `/api/enrollments/${id}/extensions/preview`, { scopeId: "course" })).statusCode).toBe(400);
    const proposed = await call(owner, "POST", `/api/enrollments/${id}/extensions/propose`, { expectedRevision: await revisionOf(learner, id), idempotencyKey: randomUUID(),
      scopeId: "course", minutes: 30, rationaleEventIds: [event], episodeIds: ["min"], planImpact: "Thirty more minutes of guided practice.", alternatives: ["Continue with a documented gap."] });
    expect(proposed.statusCode, proposed.body).toBe(200);
    const offer = proposed.json().offer;
    const accepted = await call(learner, "POST", `/api/enrollments/${id}/extensions/accept`, { expectedRevision: await revisionOf(learner, id), idempotencyKey: randomUUID(),
      offerId: offer.terms.offerId, termsDigest: offer.termsDigest, explicitConsent: true });
    expect(accepted.json().offer.state).toBe("accepted_pending_admin");
    // One queue across learners: the accepted offer waits for an administrator.
    const queue = await call(instructor, "GET", `/api/admin/courses/${course}/allowances`);
    expect(queue.statusCode, queue.body).toBe(200);
    expect(queue.json().offers).toEqual([expect.objectContaining({ enrollmentId: id, displayName: "Ada Learner", offerId: offer.terms.offerId, state: "accepted_pending_admin",
      poolDebits: [{ poolId: "admin:study-time", amount: 30 }], requiredApprovals: ["role:admin"] })]);
    const pending = queue.json().offers[0];
    const granted = await call(owner, "POST", `/api/admin/enrollments/${id}/extensions/${pending.offerId}/grant`, { expectedRevision: pending.enrollmentRevision, idempotencyKey: randomUUID() });
    expect(granted.statusCode, granted.body).toBe(200);
    expect((await call(owner, "GET", `/api/admin/courses/${course}/allowances`)).json().offers).toEqual([]);
    const all = (await call(owner, "GET", `/api/admin/courses/${course}/allowances?view=all`)).json();
    expect(all.offers[0]).toMatchObject({ offerId: pending.offerId, state: "granted" });
    expect(all.pools.find((p: { poolId: string }) => p.poolId === "admin:study-time")).toEqual({ poolId: "admin:study-time", unit: "planned_minute", learners: 1, total: 120, used: 30, grants: 1 });
    // The grant raised the course work cap by exactly the drawn minutes.
    const quota = ((await call(learner, "GET", `/api/enrollments/${id}/policy`)).json().constraints as { scopeId: string; quotas: { metric: string; limit: number }[] }[])
      .find((c) => c.scopeId === "course")!.quotas.find((q) => q.metric === "additionalMinutes")!;
    expect(quota.limit).toBe(630);
    expect((await call(learner, "GET", `/api/admin/courses/${course}/allowances`)).statusCode).toBe(403);
    expect((await call(owner, "GET", `/api/admin/courses/${course}/allowances?view=everything`)).statusCode).toBe(400);
  });
});

describe("the continuation track after closure (G15)", () => {
  async function closedWithReview() {
    release = await publish(retentionCourse());
    const id = await enroll(learner);
    const send = async (action: string, body: Record<string, unknown>) =>
      call(learner, "POST", `/api/enrollments/${id}/${action}`, { expectedRevision: await revisionOf(learner, id), idempotencyKey: randomUUID(), ...body });
    for (const [assessmentId, answer] of [["min-a", "two"], ["min-b", 4]] as const) {
      const issued = await send("challenges", { episodeId: "min", assessmentId, mode: "independent" });
      expect(issued.statusCode, issued.body).toBe(200);
      await send("answers", { challengeId: issued.json().challengeId, answer });
    }
    await call(learner, "GET", `/api/enrollments/${id}/retention`);
    expect(await closeReached(db, id, { now: new Date(Date.now() + 31 * DAY) })).toBe(1);
    clock.advance(2 * DAY);
    return { id, send };
  }
  it("offers an explicit opt-in that allows review only, never reopens the course, and can be stopped", async () => {
    const { id, send } = await closedWithReview();
    const closure = (await db.query("SELECT reason,coverage FROM closure_reports WHERE enrollment_id=$1", [id])).rows[0];
    expect(closure).toEqual({ reason: "cap", coverage: "partial" });
    const view = (await call(learner, "GET", `/api/enrollments/${id}/continuation`)).json();
    expect(view).toMatchObject({ available: true, track: null, terms: { requiredWork: false, credit: false, reopensCourse: false, canStopAnytime: true } });
    // Without the opt-in, a closed course takes no review check.
    expect((await send("retention/check", { objectiveId: "minimum" })).json().error).toBe("ENROLLMENT_INACTIVE");
    // Consent must be explicit, and only the learner can give it.
    expect((await send("continuation", {})).statusCode).toBe(400);
    expect((await call(owner, "POST", `/api/enrollments/${id}/continuation`, { expectedRevision: await revisionOf(learner, id), idempotencyKey: randomUUID(), explicitConsent: true })).statusCode).toBe(404);
    const opted = await send("continuation", { explicitConsent: true });
    expect(opted.statusCode, opted.body).toBe(200);
    expect(opted.json().track).toMatchObject({ state: "active" });
    expect((await send("continuation", { explicitConsent: true })).json().error).toBe("CONTINUATION_ALREADY_ACTIVE");
    // Review works on the track: a held-out check, answered and graded, with no change to the closed course.
    const issued = await send("retention/check", { objectiveId: "minimum" });
    expect(issued.statusCode, issued.body).toBe(200);
    const answered = await send("answers", { challengeId: issued.json().challengeId, answer: 7 });
    expect(answered.statusCode, answered.body).toBe(200);
    expect((await db.query("SELECT status FROM enrollments WHERE id=$1", [id])).rows[0].status).toBe("closed");
    const policy = (await db.query("SELECT snapshot FROM policy_states WHERE enrollment_id=$1", [id])).rows[0].snapshot;
    expect(policy).toMatchObject({ status: "closed", closure: { reason: "cap", coverage: "partial" } });
    // Required work stays impossible: a new lesson check is refused.
    expect((await send("challenges", { episodeId: "min", assessmentId: "min-a", mode: "independent" })).statusCode).toBe(409);
    const stopped = await send("continuation/stop", {});
    expect(stopped.json().track).toMatchObject({ state: "stopped" });
    expect((await send("continuation/stop", {})).json().error).toBe("CONTINUATION_NOT_ACTIVE");
    expect((await db.query("SELECT event_type FROM learning_events WHERE enrollment_id=$1 AND event_type LIKE 'continuation.%' ORDER BY sequence", [id])).rows.map((r) => r.event_type))
      .toEqual(["continuation.opted_in", "continuation.stopped"]);
  });
  it("is unavailable while the course is open", async () => {
    const id = await enroll(learner);
    expect((await call(learner, "GET", `/api/enrollments/${id}/continuation`)).json()).toMatchObject({ available: false, track: null });
    const r = await call(learner, "POST", `/api/enrollments/${id}/continuation`, { expectedRevision: await revisionOf(learner, id), idempotencyKey: randomUUID(), explicitConsent: true });
    expect(r.json().error).toBe("ENROLLMENT_NOT_CLOSED");
  });
});
