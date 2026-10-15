import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import type { CourseManifest } from "@course-core/sdk";
import { createDatabase, type Database } from "../src/database.js";
import { createTestDatabase, type TestDatabase } from "./test-database.js";
import { createServer } from "../src/server.js";
import { issueLoginCode } from "../src/auth.js";
import { DEFAULT_COURSE_POLICY_SETTINGS } from "../src/policy-adapter.js";
import { fixture } from "./fixture.js";

const origin = "http://localhost:4391",
  schema = "policyadmin_" + randomUUID().replaceAll("-", "");
let db: Database, app: Awaited<ReturnType<typeof createServer>>;
let workspace: string, owner: Session, instructor: Session, learner: Session, other: Session, release: string, course: string, version = 0;
interface Session { userId: string; cookie: string; csrf: string }
async function session(role: string): Promise<Session> {
  const id = randomUUID();
  await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [id, "policy:" + id, role + " person"]);
  await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspace, id, role]);
  const r = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, id) } });
  return { userId: id, cookie: r.cookies.map((c) => c.name + "=" + c.value).join("; "), csrf: r.json().csrfToken };
}
const call = (who: Session, method: "GET" | "POST" | "PUT", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { origin, cookie: who.cookie, "x-csrf-token": who.csrf }, ...(payload === undefined ? {} : { payload: payload as object }) });
const settings = (over: Record<string, unknown> = {}) => ({ ...structuredClone(DEFAULT_COURSE_POLICY_SETTINGS), ...over });
async function saveSettings(value: ReturnType<typeof settings>) {
  const current = (await call(owner, "GET", `/api/admin/courses/${course}/policy-settings`)).json();
  const saved = await call(owner, "PUT", `/api/admin/courses/${course}/policy-settings`, { expectedRevision: current.revision, settings: value, reason: "Course policy review" });
  expect(saved.statusCode, saved.body).toBe(200);
  return saved.json();
}
async function publish(manifest: CourseManifest) {
  manifest.version = `1.0.${version++}`;
  const id = (await call(owner, "POST", `/api/workspaces/${workspace}/releases`, manifest)).json().id;
  return { id, published: await call(owner, "POST", `/api/releases/${id}/publish`) };
}
async function enroll(who: Session) {
  const r = await call(who, "POST", "/api/enrollments", { releaseId: release });
  expect(r.statusCode, r.body).toBe(200);
  return r.json().id as string;
}
const revisionOf = async (id: string) => (await call(learner, "GET", `/api/enrollments/${id}`)).json().revision as number;
const adminRevision = async (id: string) => (await call(owner, "GET", `/api/admin/enrollments/${id}/policy`)).json().revision as number;
async function propose(id: string, days = 2) {
  const event = (await db.query("SELECT id FROM learning_events WHERE enrollment_id=$1 AND event_type='enrollment.started'", [id])).rows[0];
  const r = await call(owner, "POST", `/api/enrollments/${id}/extensions/propose`, { expectedRevision: await revisionOf(id), idempotencyKey: randomUUID(), scopeId: "course", days,
    rationaleEventIds: [event.id], episodeIds: ["min"], planImpact: "Two more days for independent practice.", alternatives: ["Finish on the existing date with a gap report."] });
  expect(r.statusCode, r.body).toBe(200);
  return r.json().offer as { terms: { offerId: string }; termsDigest: string };
}
const accept = async (who: Session, id: string, offer: { terms: { offerId: string }; termsDigest: string }, expectedRevision?: number) =>
  call(who, "POST", `/api/enrollments/${id}/extensions/accept`, { expectedRevision: expectedRevision ?? await revisionOf(id), idempotencyKey: randomUUID(),
    offerId: offer.terms.offerId, termsDigest: offer.termsDigest, explicitConsent: true });
const snapshotOf = async (id: string) => (await db.query("SELECT snapshot FROM policy_states WHERE enrollment_id=$1", [id])).rows[0].snapshot;

let testDatabase: TestDatabase | undefined;
beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false });
});
beforeEach(async () => {
  workspace = randomUUID();
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspace, "policy-" + workspace, "Policy"]);
  owner = await session("owner");
  instructor = await session("instructor");
  learner = await session("learner");
  other = await session("learner");
  const first = await publish(fixture());
  expect(first.published.statusCode, first.published.body).toBe(200);
  release = first.id;
  course = (await db.query("SELECT id FROM admin_course_catalog WHERE workspace_id=$1", [workspace])).rows[0].id;
});
afterAll(async () => {
  await app?.close();
  await db?.end();
  await testDatabase?.drop();
});

describe("feasibility before enrollment and publication (P18)", () => {
  it("refuses to publish a release whose required path is already past its deadline, with alternatives", async () => {
    const late = fixture();
    late.policy = { mode: "bounded", hardDeadline: "2020-01-01T00:00:00Z", existingMaterialAccess: "read_only" };
    const { id, published } = await publish(late);
    expect(published.statusCode).toBe(409);
    expect(published.json().error).toBe("PUBLISH_INFEASIBLE");
    expect(published.json().details.issues[0]).toMatchObject({ severity: "error", code: "DEADLINE_ALREADY_REACHED", scopeId: "course" });
    expect(published.json().details.alternatives).toEqual(["authorized_policy_change", "choose_a_smaller_goal"]);
    expect(published.json().details.masteryCriteria).toBe("unchanged");
    expect((await db.query("SELECT status FROM course_releases WHERE id=$1", [id])).rows[0].status).toBe("draft");
  });
  it("refuses learner and admin enrollment when the estimated core path cannot fit, unless the learner accepts documented gaps", async () => {
    await saveSettings(settings({ pacing: { minutesPerRequiredEpisode: 600, finalAssessmentMinutes: 120, studyMinutesPerDay: 15 } }));
    const refused = await call(learner, "POST", "/api/enrollments", { releaseId: release });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe("ENROLLMENT_INFEASIBLE");
    // Two required episodes of 600 minutes plus a 120-minute final check; 30 whole days at 15 minutes a day.
    expect(refused.json().details.issues.find((i: { code: string }) => i.code === "TIME_ENVELOPE_TOO_SMALL")).toMatchObject({ scopeId: "course", neededMinutes: 1320, availableMinutes: 450 });
    expect(refused.json().details.alternatives).toEqual(["request_allowed_extension", "authorized_policy_change", "continue_with_documented_gaps", "choose_a_smaller_goal"]);
    expect((await db.query("SELECT count(*)::int AS n FROM enrollments WHERE user_id=$1", [learner.userId])).rows[0].n).toBe(0);
    const catalogRevision = (await db.query("SELECT revision FROM admin_course_catalog WHERE id=$1", [course])).rows[0].revision;
    const admin = await app.inject({ method: "POST", url: `/api/admin/courses/${course}/enrollments`,
      headers: { origin, cookie: owner.cookie, "x-csrf-token": owner.csrf, "if-match": String(catalogRevision), "idempotency-key": "enroll-" + randomUUID() },
      payload: { learnerRef: other.userId, profile: { displayName: "Other", goal: "", pace: "steady" } } });
    expect(admin.json().error).toBe("ENROLLMENT_INFEASIBLE");
    const knowing = await call(learner, "POST", "/api/enrollments", { releaseId: release, acceptDocumentedGaps: true });
    expect(knowing.statusCode, knowing.body).toBe(200);
    expect(knowing.json().feasibility).toMatchObject({ feasible: false, masteryCriteria: "unchanged" });
    const started = (await db.query("SELECT payload FROM learning_events WHERE enrollment_id=$1 AND event_type='enrollment.started'", [knowing.json().id])).rows[0].payload;
    expect(started).toMatchObject({ feasible: false, issueCodes: expect.arrayContaining(["TIME_ENVELOPE_TOO_SMALL"]) });
    // The publication check uses the same settings: a new release with this envelope is refused.
    expect((await publish(fixture())).published.json().error).toBe("PUBLISH_INFEASIBLE");
  });
  it("refuses to select a release for new learners through the admin workflow once its envelope is infeasible", async () => {
    await saveSettings(settings({ pacing: { minutesPerRequiredEpisode: 600, finalAssessmentMinutes: null, studyMinutesPerDay: 10 } }));
    const revision = (await db.query("SELECT revision FROM admin_course_catalog WHERE id=$1", [course])).rows[0].revision;
    const activated = await app.inject({ method: "POST", url: `/api/admin/courses/${course}/releases/${release}/transitions`,
      headers: { origin, cookie: owner.cookie, "x-csrf-token": owner.csrf, "if-match": String(revision), "idempotency-key": "activate-" + randomUUID() },
      payload: { action: "activate" } });
    expect(activated.statusCode, activated.body.slice(0, 400)).toBe(409);
    expect(activated.json()).toMatchObject({ error: "PUBLISH_INFEASIBLE", details: { alternatives: expect.arrayContaining(["continue_with_documented_gaps"]) } });
  });
});

describe("course policy settings", () => {
  it("shows documented defaults, saves with a revision check and applies only to new enrollments", async () => {
    const initial = (await call(instructor, "GET", `/api/admin/courses/${course}/policy-settings`)).json();
    expect(initial).toMatchObject({ source: "default", revision: 0, settings: DEFAULT_COURSE_POLICY_SETTINGS, appliesTo: "new_enrollments" });
    expect(initial.preview.feasibility.feasible).toBe(true);
    const before = await enroll(learner);
    const put = (body: unknown, who = owner) => call(who, "PUT", `/api/admin/courses/${course}/policy-settings`, body);
    expect((await put({ expectedRevision: 0, settings: settings(), reason: "x" }, instructor)).statusCode).toBe(403);
    expect((await put({ expectedRevision: 0, settings: settings({ timeZone: "+02:00" }), reason: "x" })).statusCode).toBe(400);
    expect((await put({ expectedRevision: 3, settings: settings(), reason: "x" })).json().error).toBe("STALE_REVISION");
    const saved = await saveSettings(settings({ timeZone: "Europe/Berlin", disambiguation: "later", closedQuestionBudget: 3,
      headroom: { core: { additionalMinutes: 0, additionalEpisodes: 0 }, finalAssessment: { additionalMinutes: 0, additionalEpisodes: 0 } } }));
    expect(saved).toMatchObject({ source: "configured", revision: 1 });
    const after = await enroll(other);
    const old = await snapshotOf(before), fresh = await snapshotOf(after);
    expect(old.scopes[0].window.disambiguation).toBe("compatible");
    expect(old.afterClosure).toEqual({ questionBudget: 20 });
    expect(fresh.scopes[0].window.disambiguation).toBe("later");
    expect(fresh.afterClosure).toEqual({ questionBudget: 3 });
    const audit = (await db.query("SELECT payload FROM learning_events WHERE workspace_id=$1 AND event_type='policy.settings_changed'", [workspace])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].payload).toMatchObject({ revision: 1, reason: "Course policy review" });
  });
  it("defaults hard deadlines to reject and windows to compatible; opting in changes only new enrollments", async () => {
    // A chapter hard deadline at 02:30 New York time two days before the next spring-forward,
    // so a two-day extension would land in the skipped hour.
    const now = new Date(), year = now.getUTCMonth() >= 2 ? now.getUTCFullYear() + 1 : now.getUTCFullYear();
    const march = new Date(Date.UTC(year, 2, 1)), firstSunday = 1 + ((7 - march.getUTCDay()) % 7), springForward = firstSunday + 7;
    const deadline = new Date(Date.UTC(year, 2, springForward - 2, 7, 30)).toISOString();
    const zoned = fixture();
    zoned.policy.window!.timeZone = "America/New_York";
    zoned.chapters[0]!.policy = { mode: "bounded", hardDeadline: deadline, existingMaterialAccess: "read_only",
      extensions: { enabled: true, calendarDays: 2, maxGrants: 1, maxDaysPerGrant: 2, learnerAcceptanceRequired: true } };
    release = (await publish(zoned)).id;
    const defaults = (await call(owner, "GET", `/api/admin/courses/${course}/policy-settings`)).json();
    expect(defaults.settings).toMatchObject({ disambiguation: "compatible", hardDeadlineDisambiguation: "reject" });
    const absolute = defaults.preview.calendar.find((row: { rule: string; scopeId: string }) => row.rule === "absolute" && row.scopeId === "chapter:order");
    // The preview shows what reject refuses: the two-day extension endpoint does not exist locally.
    expect(absolute).toMatchObject({ timeZone: "America/New_York", disambiguation: "reject", rejectedExtensionDays: [2] });
    const before = await enroll(learner);
    let stored = await snapshotOf(before);
    expect(stored.scopes.find((s: { scopeId: string }) => s.scopeId === "chapter:order").hardDeadline).toEqual({ at: deadline, timeZone: "America/New_York", disambiguation: "reject" });
    expect(stored.scopes[0].window.disambiguation).toBe("compatible");
    const opted = (await call(owner, "POST", `/api/admin/courses/${course}/policy-settings/preview`, { settings: settings({ hardDeadlineDisambiguation: "compatible" }) })).json();
    expect(opted.preview.calendar.find((row: { rule: string; scopeId: string }) => row.rule === "absolute" && row.scopeId === "chapter:order").rejectedExtensionDays).toEqual([]);
    await saveSettings(settings({ hardDeadlineDisambiguation: "compatible" }));
    const after = await enroll(other);
    expect((await snapshotOf(after)).scopes.find((s: { scopeId: string }) => s.scopeId === "chapter:order").hardDeadline.disambiguation).toBe("compatible");
    // The existing enrollment keeps the rule it started with.
    stored = await snapshotOf(before);
    expect(stored.scopes.find((s: { scopeId: string }) => s.scopeId === "chapter:order").hardDeadline.disambiguation).toBe("reject");
    expect(stored.scopes[0].window.disambiguation).toBe("compatible");
  });
  it("previews DST effects of the window under the chosen disambiguation before saving", async () => {
    const zoned = fixture();
    zoned.policy.window!.timeZone = "America/New_York";
    // Publishing selects this release for new learners, so the settings preview uses it.
    release = (await publish(zoned)).id;
    const preview = await call(owner, "POST", `/api/admin/courses/${course}/policy-settings/preview`, { settings: settings({ disambiguation: "reject" }) });
    expect(preview.statusCode, preview.body).toBe(200);
    const window = preview.json().preview.calendar.find((row: { rule: string }) => row.rule === "window");
    expect(window).toMatchObject({ scopeId: "course", timeZone: "America/New_York", disambiguation: "reject", rejectsSomeStarts: true });
    expect(window.transitions.map((t: { kind: string }) => t.kind)).toEqual(expect.arrayContaining(["gap", "overlap"]));
    expect(window.transitions.every((t: { resolution: string }) => t.resolution === "rejected")).toBe(true);
    const later = (await call(owner, "POST", `/api/admin/courses/${course}/policy-settings/preview`, { settings: settings({ disambiguation: "later" }) })).json();
    expect(later.preview.calendar[0].rejectsSomeStarts).toBe(false);
    // A preview saves nothing.
    expect((await call(owner, "GET", `/api/admin/courses/${course}/policy-settings`)).json().revision).toBe(0);
  });
  it("snapshots reserved core and final-assessment headroom and keeps personal extras on a separate counter", async () => {
    const capped = fixture();
    capped.policy.work = { additionalMinutes: 120, additionalEpisodes: 6 };
    release = (await publish(capped)).id;
    await saveSettings(settings({ headroom: { core: { additionalMinutes: 30, additionalEpisodes: 2 }, finalAssessment: { additionalMinutes: 20, additionalEpisodes: 1 } } }));
    const id = await enroll(learner);
    const snapshot = await snapshotOf(id);
    expect(snapshot.reservations.map((r: { reservationId: string; purpose: string }) => [r.reservationId, r.purpose])).toEqual([["headroom:core", "core"], ["headroom:final_assessment", "final_assessment"]]);
    const policy = (await call(learner, "GET", `/api/enrollments/${id}/policy`)).json();
    expect(policy.coverage).toMatchObject({ denominator: 2, coveredCoreObjectives: 0, personalExtras: { committed: { count: 0 }, reserved: { count: 0 } } });
    const courseScope = policy.constraints.find((c: { scopeId: string }) => c.scopeId === "course");
    expect(courseScope.quotas.find((q: { metric: string }) => q.metric === "additionalMinutes")).toMatchObject({ limit: 120, reserved: 50, remaining: 70 });
  });
});

describe("admin approval, revocation, refund and exceptional grants", () => {
  it("routes an accepted offer that needs admin approval to an audited admin grant (G10, G18)", async () => {
    await saveSettings(settings({ extensions: { approval: "learner_and_admin", offerCooldownHours: 0, maxOutstandingOffersPerScope: 2, maxOffersPerScope: 5 } }));
    const id = await enroll(learner);
    const offer = await propose(id);
    const accepted = await accept(learner, id, offer);
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.json().offer.state).toBe("accepted_pending_admin");
    expect(accepted.json().balances[0].remaining).toBe(2);
    const view = (await call(owner, "GET", `/api/admin/enrollments/${id}/policy`)).json();
    expect(view.pendingApprovals).toEqual([offer.terms.offerId]);
    const url = `/api/admin/enrollments/${id}/extensions/${offer.terms.offerId}/grant`;
    const body = { expectedRevision: view.revision, idempotencyKey: "approve-" + randomUUID() };
    expect((await call(instructor, "POST", url, body)).statusCode).toBe(403);
    expect((await call(learner, "POST", url, body)).statusCode).toBe(403);
    const granted = await call(owner, "POST", url, body);
    expect(granted.statusCode, granted.body).toBe(200);
    expect(granted.json().policy.balances[0].remaining).toBe(0);
    expect(granted.json().policy.offers[0].state).toBe("granted");
    expect(granted.json().policy.grants[0].authorityReceipts[0]).toMatchObject({ actorId: "role:admin", permission: "grant_extension" });
    const replay = await call(owner, "POST", url, body);
    expect(replay.json()).toEqual(granted.json());
    expect((await db.query("SELECT count(*)::int AS n FROM extension_grants WHERE enrollment_id=$1", [id])).rows[0].n).toBe(1);
    const approval = (await db.query("SELECT actor_id,payload FROM learning_events WHERE enrollment_id=$1 AND event_type='extension.approved'", [id])).rows;
    expect(approval).toHaveLength(1);
    expect(approval[0].actor_id).toBe(owner.userId);
    expect((await call(owner, "POST", url, { expectedRevision: await adminRevision(id), idempotencyKey: "approve-" + randomUUID() })).json().error).toBe("LEARNER_ACCEPTANCE_REQUIRED");
  });
  it("lets an administrator reject a pending offer without using allowance", async () => {
    await saveSettings(settings({ extensions: { approval: "learner_and_admin", offerCooldownHours: 0, maxOutstandingOffersPerScope: 2, maxOffersPerScope: 5 } }));
    const id = await enroll(learner);
    const offer = await propose(id);
    await accept(learner, id, offer);
    const rejected = await call(owner, "POST", `/api/admin/enrollments/${id}/extensions/${offer.terms.offerId}/reject`, { expectedRevision: await adminRevision(id), idempotencyKey: "reject-" + randomUUID(), reason: "Outside the course window policy." });
    expect(rejected.statusCode, rejected.body).toBe(200);
    expect(rejected.json().policy.offers[0].state).toBe("rejected");
    expect(rejected.json().policy.balances[0].remaining).toBe(2);
  });
  it("P02: two offers racing for the last allowance days grant at most once, on real PostgreSQL", async () => {
    await saveSettings(settings({ extensions: { approval: "learner", offerCooldownHours: 0, maxOutstandingOffersPerScope: 2, maxOffersPerScope: 5 } }));
    const id = await enroll(learner);
    const first = await propose(id), second = await propose(id);
    const revision = await revisionOf(id);
    // Two devices accept different offers at the same moment.
    const raced = await Promise.all([accept(learner, id, first, revision), accept(learner, id, second, revision)]);
    expect(raced.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    // The losing offer is revalidated against the new balance and cannot overdraw it.
    const loser = raced[0]!.statusCode === 200 ? second : first;
    const retried = await accept(learner, id, loser);
    expect(retried.statusCode).toBe(409);
    expect(["TERMS_CHANGED", "ALLOWANCE_EXHAUSTED", "STALE_OFFER"]).toContain(retried.json().error);
    expect((await db.query("SELECT count(*)::int AS n FROM extension_grants WHERE enrollment_id=$1", [id])).rows[0].n).toBe(1);
    const snapshot = await snapshotOf(id);
    expect(snapshot.grants).toHaveLength(1);
    const balance = (await call(learner, "GET", `/api/enrollments/${id}/policy`)).json().balances[0];
    expect(balance).toEqual({ poolId: "course:calendar", remaining: 0, grantsRemaining: 0 });
  });
  it("revokes, refunds and makes exceptional grants as separate audited operations (G16)", async () => {
    const id = await enroll(learner);
    const offer = await propose(id);
    expect((await accept(learner, id, offer)).statusCode).toBe(200);
    let view = (await call(owner, "GET", `/api/admin/enrollments/${id}/policy`)).json();
    const grantId = view.grants[0].grantId, extended = view.constraints[0].effectiveDeadline;
    const base = `/api/admin/enrollments/${id}`;
    expect((await call(instructor, "POST", `${base}/grants/${grantId}/revoke/preview`, {})).statusCode).toBe(403);
    const revokePreview = (await call(owner, "POST", `${base}/grants/${grantId}/revoke/preview`, {})).json();
    expect(revokePreview).toMatchObject({ grantId, shortensDeadline: true, allowanceRefunded: false });
    const revoked = await call(owner, "POST", `${base}/grants/${grantId}/revoke`, { expectedRevision: revokePreview.revision, idempotencyKey: "revoke-" + randomUUID(),
      previewId: revokePreview.previewId, previewDigest: revokePreview.previewDigest, reason: "Granted in error; ticket 42." });
    expect(revoked.statusCode, revoked.body).toBe(200);
    view = revoked.json().policy;
    expect(view.grants[0].revocation).toMatchObject({ reasonRef: revokePreview.reasonRef });
    expect(Date.parse(view.constraints[0].effectiveDeadline)).toBeLessThan(Date.parse(extended));
    expect(view.balances[0].remaining).toBe(0);
    // A preview cannot be replayed after the ledger moved.
    expect((await call(owner, "POST", `${base}/grants/${grantId}/revoke`, { expectedRevision: view.revision, idempotencyKey: "revoke-" + randomUUID(),
      previewId: revokePreview.previewId, previewDigest: revokePreview.previewDigest, reason: "again" })).json().error).toBe("STALE_PREVIEW");
    const refundPreview = (await call(owner, "POST", `${base}/grants/${grantId}/refund/preview`, { poolId: "course:calendar", amount: 2 })).json();
    expect(refundPreview.balanceAfter.remaining).toBe(2);
    const refunded = await call(owner, "POST", `${base}/grants/${grantId}/refund`, { expectedRevision: refundPreview.revision, idempotencyKey: "refund-" + randomUUID(),
      previewId: refundPreview.previewId, previewDigest: refundPreview.previewDigest, reason: "Outage credit." });
    expect(refunded.statusCode, refunded.body).toBe(200);
    expect(refunded.json().policy.balances[0].remaining).toBe(2);
    expect(refunded.json().policy.refunds).toHaveLength(1);
    expect((await call(owner, "POST", `${base}/grants/${grantId}/refund/preview`, { poolId: "course:calendar", amount: 1 })).json().error).toBe("REFUND_EXCEEDS_DEBIT");
    const exceptionPreview = (await call(owner, "POST", `${base}/exceptions/preview`, { scopeId: "course", change: { deadline: { kind: "window", calendarDays: 5 } } })).json();
    expect(exceptionPreview.poolDebits).toEqual([]);
    const exception = await call(owner, "POST", `${base}/exceptions/apply`, { expectedRevision: exceptionPreview.revision, idempotencyKey: "exception-" + randomUUID(),
      previewId: exceptionPreview.previewId, previewDigest: exceptionPreview.previewDigest, reason: "Program committee decision 7." });
    expect(exception.statusCode, exception.body).toBe(200);
    expect(exception.json().policy.exceptionalGrants).toHaveLength(1);
    expect(exception.json().policy.constraints[0].effectiveDeadline).toBe(exceptionPreview.effectiveDeadlineAfter);
    expect(exception.json().policy.balances[0].remaining).toBe(2);
    const events = (await db.query("SELECT event_type,actor_id FROM learning_events WHERE enrollment_id=$1 AND event_type LIKE 'policy.%_authorized' ORDER BY sequence", [id])).rows;
    expect(events.map((e) => e.event_type)).toEqual(["policy.revocation_authorized", "policy.refund_authorized", "policy.exception_authorized"]);
    expect(events.every((e) => e.actor_id === owner.userId)).toBe(true);
    const ledger = await snapshotOf(id);
    expect(ledger.audit.slice(-3).map((a: { operation: string }) => a.operation)).toEqual(["revoke_grant", "refund_allowance", "exceptional_grant"]);
  });
});

describe("cohort-wide migration (G11, P16)", () => {
  it("previews every enrollment, names shortened grants and applies only with explicit acknowledgement", async () => {
    const a = await enroll(learner), b = await enroll(other);
    expect((await accept(learner, a, await propose(a))).statusCode).toBe(200);
    const granted = (await snapshotOf(a)).grants[0].grantId;
    const earlier = new Date(Date.now() + 20 * 86_400_000).toISOString();
    const url = `/api/admin/courses/${course}/policy/cohort`;
    expect((await call(instructor, "POST", `${url}/preview`, { change: { scopeId: "course", hardDeadline: earlier } })).statusCode).toBe(403);
    const preview = await call(owner, "POST", `${url}/preview`, { change: { scopeId: "course", hardDeadline: earlier } });
    expect(preview.statusCode, preview.body).toBe(200);
    const body = preview.json();
    expect(body.enrollments.map((e: { enrollmentId: string }) => e.enrollmentId).sort()).toEqual([a, b].sort());
    expect(body.shortenedGrantIds).toEqual([granted]);
    const apply = (over: Record<string, unknown> = {}) => call(owner, "POST", `${url}/apply`, { migrationId: body.migrationId, previewDigest: body.previewDigest, reason: "Program ends early.", ...over });
    expect((await apply()).json().error).toBe("SHORTENED_GRANT_UNACKNOWLEDGED");
    expect((await apply({ acknowledgedShortenedGrantIds: ["other"] })).json().error).toBe("SHORTENED_GRANT_UNACKNOWLEDGED");
    const applied = await apply({ acknowledgedShortenedGrantIds: [granted] });
    expect(applied.statusCode, applied.body).toBe(200);
    expect(applied.json()).toMatchObject({ applied: 2, replayed: false });
    for (const id of [a, b]) {
      const snapshot = await snapshotOf(id);
      expect(snapshot.migrations).toHaveLength(1);
      expect(snapshot.scopes[0].hardDeadline.at).toBe(earlier);
      expect(snapshot.scopes[0].window).toBeDefined();
    }
    expect((await snapshotOf(a)).grants).toHaveLength(1);
    expect((await apply({ acknowledgedShortenedGrantIds: [granted] })).json()).toMatchObject({ replayed: true });
    const events = (await db.query("SELECT payload FROM learning_events WHERE workspace_id=$1 AND event_type='policy.migration_authorized'", [workspace])).rows;
    expect(events).toHaveLength(2);
    expect(events.find((e) => e.payload.shortenedGrantIds.length)?.payload.shortenedGrantIds).toEqual([granted]);
  });
  it("refuses a stale cohort preview after any enrollment changed", async () => {
    const a = await enroll(learner);
    const body = (await call(owner, "POST", `/api/admin/courses/${course}/policy/cohort/preview`, { change: { scopeId: "course", targetDate: new Date(Date.now() + 9 * 86_400_000).toISOString() } })).json();
    expect(body.shortenedGrantIds).toEqual([]);
    await propose(a);
    const stale = await call(owner, "POST", `/api/admin/courses/${course}/policy/cohort/apply`, { migrationId: body.migrationId, previewDigest: body.previewDigest, reason: "Pacing hint." });
    expect(stale.json().error).toBe("STALE_PREVIEW");
    expect((await snapshotOf(a)).migrations).toHaveLength(0);
  });
});
