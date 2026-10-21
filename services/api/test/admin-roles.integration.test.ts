import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import type { CourseManifest } from "@course-core/sdk";
import { createDatabase, type Database } from "../src/database.js";
import { createTestDatabase, type TestDatabase } from "./test-database.js";
import { createServer } from "../src/server.js";
import { issueLoginCode } from "../src/auth.js";
import { adminPermissionMatrix } from "../src/admin-routes.js";
import { auditPayload, AUDIT_PAYLOAD_PROJECTIONS } from "../src/workspace-audit.js";
import { nearestDeadline } from "../src/course-overview.js";
import { fixture } from "./fixture.js";

// Real HTTP and PostgreSQL 17: who may call which administration endpoint, with
// course-scoped grants (active, expired, revoked, other course) and the new roles.
const origin = "http://localhost:4398",
  schema = "roles_" + randomUUID().replaceAll("-", "");
let db: Database, app: Awaited<ReturnType<typeof createServer>>;
interface Session { userId: string; cookie: string; csrf: string }
let workspace: string, catalog: string, otherCatalog: string, enrollment: string, release: string;
const sessions: Record<string, Session> = {};
const CHAT_MARKER = "private-companion-question-" + randomUUID().slice(0, 8);

async function person(role: string, name = role + " person"): Promise<Session> {
  const id = randomUUID();
  await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [id, "roles:" + id, name]);
  await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspace, id, role]);
  const r = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, id) } });
  expect(r.statusCode, r.body).toBe(200);
  return { userId: id, cookie: r.cookies.map((c) => c.name + "=" + c.value).join("; "), csrf: r.json().csrfToken };
}
const call = (who: Session, method: "GET" | "POST", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { origin, cookie: who.cookie, "x-csrf-token": who.csrf }, ...(payload === undefined ? {} : { payload: payload as object }) });
const ok = async (who: Session, method: "GET" | "POST", url: string, payload?: unknown) => {
  const r = await call(who, method, url, payload);
  expect(r.statusCode, `${method} ${url}: ${r.body}`).toBe(200);
  return r.json();
};
async function publish(manifest: CourseManifest) {
  const id = (await ok(sessions.owner!, "POST", `/api/workspaces/${workspace}/releases`, manifest)).id as string;
  await ok(sessions.owner!, "POST", `/api/releases/${id}/publish`);
  return id;
}
const grant = (userId: string, catalogId: string, role: string, expiresAt = new Date(Date.now() + 86_400_000).toISOString()) =>
  call(sessions.owner!, "POST", `/api/admin/workspaces/${workspace}/course-grants`, { userId, catalogId, role, expiresAt, reasonCode: "support_case", idempotencyKey: "g-" + randomUUID() });

let testDatabase: TestDatabase | undefined;
beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false });
  workspace = randomUUID();
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspace, "roles-" + workspace, "Roles"]);
  for (const role of ["owner", "admin", "author", "instructor", "reviewer", "observer", "support_observer", "service", "learner"]) sessions[role] = await person(role);
  for (const name of ["scoped_active", "scoped_reviewer", "scoped_author", "scoped_expired", "scoped_revoked", "scoped_none", "scoped_other"]) sessions[name] = await person("course_scoped", name);
  const releaseId = await publish(fixture());
  release = releaseId;
  const other = fixture();
  other.id = "ordering-other";
  other.title = "Other course";
  await publish(other);
  const courses = (await ok(sessions.owner!, "GET", "/api/admin/session")).courses as { id: string; title: string }[];
  catalog = courses.find((c) => c.title === "Ordering values")!.id;
  otherCatalog = courses.find((c) => c.title === "Other course")!.id;
  // The learner enrolls and writes to their companion; nobody else may read that.
  enrollment = (await ok(sessions.learner!, "POST", "/api/enrollments", { releaseId })).id;
  const revision = (await ok(sessions.learner!, "GET", `/api/enrollments/${enrollment}`)).revision;
  await ok(sessions.learner!, "POST", `/api/enrollments/${enrollment}/companion`, { expectedRevision: revision, idempotencyKey: randomUUID(), episodeId: "min", content: CHAT_MARKER });
  expect((await grant(sessions.scoped_active!.userId, catalog, "instructor")).statusCode).toBe(200);
  expect((await grant(sessions.scoped_other!.userId, otherCatalog, "instructor")).statusCode).toBe(200);
  expect((await grant(sessions.scoped_reviewer!.userId, catalog, "reviewer")).statusCode).toBe(200);
  expect((await grant(sessions.scoped_author!.userId, catalog, "author")).statusCode).toBe(200);
  const expiring = await grant(sessions.scoped_expired!.userId, catalog, "instructor");
  expect(expiring.statusCode, expiring.body).toBe(200);
  // Expiry is enforced by the clock on every request; move this grant into the past.
  await db.query("ALTER TABLE course_access_grants DISABLE TRIGGER course_access_grants_guard");
  await db.query("UPDATE course_access_grants SET created_at=created_at-interval '3 days',expires_at=clock_timestamp()-interval '1 hour' WHERE id=$1", [expiring.json().grantId]);
  await db.query("ALTER TABLE course_access_grants ENABLE TRIGGER course_access_grants_guard");
  const revoked = (await grant(sessions.scoped_revoked!.userId, catalog, "instructor")).json();
  expect((await call(sessions.owner!, "POST", `/api/admin/workspaces/${workspace}/course-grants/${revoked.grantId}/revoke`, { reasonCode: "case_closed", idempotencyKey: "r-" + randomUUID() })).statusCode).toBe(200);
}, 60000);
afterAll(async () => {
  await app?.close();
  await db?.end();
  await testDatabase?.drop();
});

const ACTORS = ["owner", "admin", "author", "instructor", "reviewer", "observer", "support_observer", "service", "learner",
  "scoped_active", "scoped_reviewer", "scoped_author", "scoped_expired", "scoped_revoked", "scoped_none", "scoped_other"] as const;
type ActorName = (typeof ACTORS)[number];
// Course-scoped members hold the role of their active grant on that one course, on every
// route (course-access.ts): scoped_active is an instructor, scoped_reviewer a reviewer and
// scoped_author an author on `catalog`; scoped_other is an instructor on `otherCatalog` only;
// expired, revoked and grant-less members have no role anywhere.
const READ_COURSE: ActorName[] = ["owner", "admin", "author", "instructor", "reviewer", "observer", "support_observer", "service", "scoped_active", "scoped_reviewer", "scoped_author"];
const REVIEWERS: ActorName[] = ["owner", "admin", "instructor", "reviewer", "scoped_active", "scoped_reviewer"];
const STAFF_READERS: ActorName[] = ["owner", "admin", "instructor", "scoped_active"];
const endpoints: { name: string; url: () => string; allowed: ActorName[]; denied?: number }[] = [
  { name: "course workspace", url: () => `/api/admin/courses/${catalog}`, allowed: READ_COURSE },
  { name: "course overview", url: () => `/api/admin/courses/${catalog}/overview`, allowed: READ_COURSE },
  { name: "other course overview", url: () => `/api/admin/courses/${otherCatalog}/overview`, allowed: ["owner", "admin", "author", "instructor", "reviewer", "observer", "support_observer", "service", "scoped_other"] },
  { name: "workspace audit", url: () => `/api/admin/workspaces/${workspace}/audit`, allowed: ["owner", "admin", "support_observer"] },
  { name: "enrollment policy", url: () => `/api/admin/enrollments/${enrollment}/policy`, allowed: ["owner", "admin", "instructor", "reviewer", "support_observer", "scoped_active", "scoped_reviewer"] },
  { name: "people", url: () => `/api/admin/workspaces/${workspace}/people`, allowed: ["owner", "admin"] },
  { name: "course grants", url: () => `/api/admin/workspaces/${workspace}/course-grants`, allowed: ["owner", "admin"] },
  { name: "view as learner", url: () => `/api/admin/enrollments/${enrollment}/learner-view`, allowed: ["owner", "admin"] },
  { name: "teaching hypotheses", url: () => `/api/admin/enrollments/${enrollment}/hypotheses`, allowed: STAFF_READERS },
  { name: "written answer queue", url: () => `/api/admin/courses/${catalog}/rubric-reviews`, allowed: REVIEWERS },
  { name: "other course written answer queue", url: () => `/api/admin/courses/${otherCatalog}/rubric-reviews`, allowed: ["owner", "admin", "instructor", "reviewer", "scoped_other"] },
  { name: "gate review queue", url: () => `/api/admin/courses/${catalog}/gate-reviews`, allowed: REVIEWERS },
  { name: "other course gate review queue", url: () => `/api/admin/courses/${otherCatalog}/gate-reviews`, allowed: ["owner", "admin", "instructor", "reviewer", "scoped_other"] },
  { name: "second opinion queue", url: () => `/api/admin/courses/${catalog}/rubric-appeals`, allowed: REVIEWERS },
  { name: "review assist agreement", url: () => `/api/admin/courses/${catalog}/rubric-assist/agreement`, allowed: REVIEWERS },
  { name: "research requests", url: () => `/api/admin/releases/${release}/research`, allowed: STAFF_READERS },
  { name: "research library", url: () => `/api/admin/releases/${release}/research/library`, allowed: READ_COURSE },
  { name: "media jobs", url: () => `/api/admin/releases/${release}/media-jobs`, allowed: REVIEWERS },
  { name: "adaptation registry", url: () => `/api/admin/releases/${release}/adaptation-registry`, allowed: ["owner", "admin"] },
  // The learner may download their own record from either prefix.
  { name: "staff data export", url: () => `/api/admin/enrollments/${enrollment}/export`, allowed: ["learner", "owner", "admin"] },
  { name: "learning event export", url: () => `/api/admin/enrollments/${enrollment}/event-export`, allowed: ["learner", "owner", "admin"] },
  // Routes merged after the shared rule (#104 placement, #105 supervision, #97 policy) use it too.
  { name: "course placement", url: () => `/api/admin/courses/${catalog}/placement`, allowed: READ_COURSE },
  { name: "enrollment placement", url: () => `/api/admin/enrollments/${enrollment}/placement`, allowed: ["owner", "admin", "instructor", "reviewer", "support_observer", "service", "scoped_active", "scoped_reviewer"] },
  { name: "enrollment supervision", url: () => `/api/admin/enrollments/${enrollment}/supervision`, allowed: REVIEWERS },
  // AI supervision settings, spending limits and authority decisions: owner and admin only (Q08, B06, B09).
  { name: "supervision settings", url: () => `/api/admin/workspaces/${workspace}/supervision/settings`, allowed: ["owner", "admin"] },
  { name: "supervision authority requests", url: () => `/api/admin/workspaces/${workspace}/supervision/requests`, allowed: ["owner", "admin"] },
  { name: "learner AI spending limits", url: () => `/api/admin/workspaces/${workspace}/supervision/enrollments/${enrollment}/budget`, allowed: ["owner", "admin"] },
  // The learner's own decisions and teaching actions: theirs alone.
  { name: "learner supervision requests", url: () => `/api/enrollments/${enrollment}/supervision/requests`, allowed: ["learner"] },
  // Policy levels and allowances (094-096): course reads follow policy.read on that course; the
  // organization ceilings are workspace-wide, so a course grant never opens them.
  { name: "organization ceilings", url: () => `/api/admin/workspaces/${workspace}/policy-ceilings`, allowed: ["owner", "admin", "instructor", "reviewer", "support_observer"] },
  { name: "course allowances", url: () => `/api/admin/courses/${catalog}/allowances`, allowed: ["owner", "admin", "instructor", "reviewer", "support_observer", "scoped_active", "scoped_reviewer"] },
  { name: "course policy history", url: () => `/api/admin/courses/${catalog}/policy-history`, allowed: ["owner", "admin", "instructor", "reviewer", "support_observer", "scoped_active", "scoped_reviewer"] },
  { name: "accommodation batches", url: () => `/api/admin/courses/${catalog}/accommodations/batches`, allowed: ["owner", "admin", "instructor", "reviewer", "support_observer", "scoped_active", "scoped_reviewer"] },
  { name: "enrollment policy revisions", url: () => `/api/admin/enrollments/${enrollment}/policy-revisions`, allowed: ["owner", "admin", "instructor", "reviewer", "support_observer", "scoped_active", "scoped_reviewer"] },
  // The continuation track is the learner's own choice.
  { name: "continuation track", url: () => `/api/enrollments/${enrollment}/continuation`, allowed: ["learner"] },
  // Learner-owned reads that staff read roles may also open, under the learner-privacy rule.
  { name: "learner model", url: () => `/api/enrollments/${enrollment}/learner-model`, allowed: ["learner", ...STAFF_READERS] },
  { name: "learner hypotheses", url: () => `/api/enrollments/${enrollment}/learner-model/hypotheses`, allowed: ["learner", ...STAFF_READERS] },
  { name: "enrollment events", url: () => `/api/enrollments/${enrollment}/events`, allowed: ["learner", ...STAFF_READERS] },
  // The companion conversation is private to the learner: no staff role reads it.
  { name: "companion chat", url: () => `/api/enrollments/${enrollment}/companion`, allowed: ["learner"] },
];

describe("role × endpoint matrix", () => {
  for (const endpoint of endpoints)
    it(`${endpoint.name}: only ${endpoint.allowed.join(", ")}`, async () => {
      const results = Object.fromEntries(await Promise.all(ACTORS.map(async (actor) => [actor, (await call(sessions[actor]!, "GET", endpoint.url())).statusCode] as const)));
      const expected = Object.fromEntries(ACTORS.map((actor) => [actor, endpoint.allowed.includes(actor) ? 200 : "denied"]));
      const observed = Object.fromEntries(Object.entries(results).map(([actor, status]) => [actor, status === 200 ? 200 : [403, 404].includes(status) ? "denied" : status]));
      expect(observed).toEqual(expected);
    });

  it("supervision control follows the grant's role: a scoped instructor may control, a scoped reviewer only inspects", async () => {
    const as = async (actor: ActorName) => (await ok(sessions[actor]!, "GET", `/api/admin/enrollments/${enrollment}/supervision`)).canControl;
    expect(await as("scoped_active")).toBe(true);
    expect(await as("scoped_reviewer")).toBe(false);
    expect(await as("instructor")).toBe(true);
  });

  it("the learner reads their own chat; no staff surface carries it", async () => {
    const own = await ok(sessions.learner!, "GET", `/api/enrollments/${enrollment}/companion`);
    expect(JSON.stringify(own)).toContain(CHAT_MARKER);
    for (const [who, url] of [["admin", `/api/admin/enrollments/${enrollment}/learner-view`], ["owner", `/api/admin/courses/${catalog}/overview`],
      ["owner", `/api/admin/workspaces/${workspace}/audit?limit=200`], ["admin", `/api/admin/courses/${catalog}`]] as const) {
      const r = await call(sessions[who]!, "GET", url);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.body).not.toContain(CHAT_MARKER);
    }
  });

  it("the session course list follows grants: active course only, nothing when expired, revoked or absent", async () => {
    const titles = async (actor: ActorName) => ((await ok(sessions[actor]!, "GET", "/api/admin/session")).courses as { title: string; role: string; accessExpiresAt?: string }[]);
    const active = await titles("scoped_active");
    expect(active).toEqual([expect.objectContaining({ title: "Ordering values", role: "instructor", accessExpiresAt: expect.any(String) })]);
    expect((await titles("scoped_other")).map((c) => c.title)).toEqual(["Other course"]);
    for (const actor of ["scoped_expired", "scoped_revoked", "scoped_none", "learner"] as const) expect(await titles(actor)).toEqual([]);
    expect((await titles("support_observer")).map((c) => c.role)).toEqual(["support_observer", "support_observer"]);
  });

  it("the matrix lists every role a membership can hold except course_scoped, which has no workspace permission", async () => {
    const constraint = (await db.query("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname='memberships_role_check'")).rows[0].def as string;
    const roles = [...constraint.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(roles.filter((r) => !(r! in adminPermissionMatrix))).toEqual(["course_scoped"]);
    expect(adminPermissionMatrix.support_observer).not.toContain("evidence.review");
    expect(adminPermissionMatrix.support_observer).not.toContain("learner.view");
    expect(adminPermissionMatrix.service).toEqual(["course.read", "enrollment.read"]);
  });
});

describe("course grants", () => {
  it("are only for course_scoped members, one open grant per course, bounded expiry, never to oneself", async () => {
    const r1 = await grant(sessions.instructor!.userId, catalog, "reviewer");
    expect(r1.json().error).toBe("COURSE_SCOPED_MEMBER_REQUIRED");
    expect((await grant(sessions.scoped_active!.userId, catalog, "reviewer")).json().error).toBe("COURSE_GRANT_EXISTS");
    expect((await grant(sessions.scoped_none!.userId, catalog, "admin")).json().error).toBe("INVALID_INPUT");
    expect((await grant(sessions.scoped_none!.userId, catalog, "reviewer", new Date(Date.now() - 1000).toISOString())).json().error).toBe("GRANT_EXPIRY_INVALID");
    expect((await grant(sessions.scoped_none!.userId, catalog, "reviewer", new Date(Date.now() + 400 * 86_400_000).toISOString())).json().error).toBe("GRANT_EXPIRY_INVALID");
    expect((await grant(sessions.scoped_none!.userId, randomUUID(), "reviewer")).json().error).toBe("COURSE_NOT_FOUND");
    // Non-managers cannot grant.
    const asInstructor = await call(sessions.instructor!, "POST", `/api/admin/workspaces/${workspace}/course-grants`,
      { userId: sessions.scoped_none!.userId, catalogId: catalog, role: "reviewer", expiresAt: new Date(Date.now() + 3_600_000).toISOString(), reasonCode: "x_case", idempotencyKey: "g-" + randomUUID() });
    expect(asInstructor.statusCode).toBe(403);
  });

  it("an expired grant is closed when a new one is made; revocation ends access on the next request and is idempotent", async () => {
    const renewed = await grant(sessions.scoped_expired!.userId, otherCatalog, "observer");
    expect(renewed.statusCode, renewed.body).toBe(200);
    const listed = (await ok(sessions.admin!, "GET", `/api/admin/workspaces/${workspace}/course-grants`)).grants as { userId: string; state: string; catalogId: string }[];
    expect(listed.filter((g) => g.userId === sessions.scoped_expired!.userId).map((g) => g.state).sort()).toEqual(["active", "expired"]);
    // Make one more grant and revoke it while the member has a page open.
    const fresh = await person("course_scoped", "scoped_fresh");
    const made = (await grant(fresh.userId, catalog, "reviewer")).json();
    expect((await call(fresh, "GET", `/api/admin/courses/${catalog}`)).statusCode).toBe(200);
    const body = { reasonCode: "access_review", idempotencyKey: "rv-" + randomUUID() };
    const url = `/api/admin/workspaces/${workspace}/course-grants/${made.grantId}/revoke`;
    expect((await ok(sessions.admin!, "POST", url, body))).toMatchObject({ state: "revoked", revokeReasonCode: "access_review", replayed: false });
    expect((await ok(sessions.admin!, "POST", url, body))).toMatchObject({ state: "revoked", replayed: true });
    expect((await call(sessions.admin!, "POST", url, { ...body, idempotencyKey: "rv-" + randomUUID() })).json().error).toBe("COURSE_GRANT_REVOKED");
    expect((await call(fresh, "GET", `/api/admin/courses/${catalog}`)).statusCode).toBe(403);
    // The rows are the access record: no update after revocation and no delete.
    await expect(db.query("UPDATE course_access_grants SET role='observer' WHERE id=$1", [made.grantId])).rejects.toThrow(/COURSE_GRANT_IMMUTABLE/);
    await expect(db.query("DELETE FROM course_access_grants WHERE id=$1", [made.grantId])).rejects.toThrow(/COURSE_GRANT_IMMUTABLE/);
  });

  it("removing a course_scoped member revokes their open grants", async () => {
    const member = await person("course_scoped", "scoped_removed");
    await grant(member.userId, catalog, "observer");
    await ok(sessions.owner!, "POST", `/api/admin/workspaces/${workspace}/people/${member.userId}/revoke`, { expectedRole: "course_scoped", reason: "Support engagement finished.", idempotencyKey: "pr-" + randomUUID() });
    const rows = (await db.query("SELECT revoke_reason_code FROM course_access_grants WHERE user_id=$1", [member.userId])).rows;
    expect(rows).toEqual([{ revoke_reason_code: "membership_revoked" }]);
  });

  it("a service role is assigned by owners only", async () => {
    const r = await call(sessions.admin!, "POST", `/api/admin/workspaces/${workspace}/people`, { displayName: "Sync bot", role: "service", idempotencyKey: "inv-" + randomUUID() });
    expect(r.json().error).toBe("ROLE_NOT_ASSIGNABLE");
    expect((await call(sessions.owner!, "POST", `/api/admin/workspaces/${workspace}/people`, { displayName: "Sync bot", role: "service", idempotencyKey: "inv-" + randomUUID() })).statusCode).toBe(200);
  });
});

describe("course overview", () => {
  it("summarizes release, lifecycle, risks, defects, supervisor health and approvals; role-limited sections are null", async () => {
    const full = await ok(sessions.owner!, "GET", `/api/admin/courses/${catalog}/overview`);
    expect(full).toMatchObject({ catalogId: catalog, release: { active: { version: "1.0.0", status: "published" }, counts: { published: 1 } },
      lifecycle: { active: 1 }, deadlineRisks: [], contentDefects: { activeReleaseChecksFailing: [], evidenceInvalidatedLast30Days: 0 },
      supervisorHealth: { failedLast24h: 0 }, approvalQueue: { writtenAnswers: 0, gateReviews: 0, secondOpinions: 0 } });
    expect(full.release.pinnedLearners).toEqual([expect.objectContaining({ version: "1.0.0", learners: 1 })]);
    const observer = await ok(sessions.observer!, "GET", `/api/admin/courses/${catalog}/overview`);
    expect(observer).toMatchObject({ lifecycle: null, deadlineRisks: null, supervisorHealth: null });
    const support = await ok(sessions.support_observer!, "GET", `/api/admin/courses/${catalog}/overview`);
    expect(support.lifecycle).not.toBeNull();
    expect(support.supervisorHealth).toBeNull();
  });

  it("flags an active learner whose nearest deadline is within a week", async () => {
    const snapshot = (await db.query("SELECT snapshot FROM policy_states WHERE enrollment_id=$1", [enrollment])).rows[0].snapshot;
    const soon = new Date(Date.now() + 2.5 * 86_400_000).toISOString();
    const withDeadline = { ...snapshot, scopes: snapshot.scopes.map((s: { kind: string }, i: number) => (i === 0 ? { ...s, ultimateDeadline: soon } : s)) };
    expect(nearestDeadline(withDeadline)).toBe(soon);
    expect(nearestDeadline(null)).toBeNull();
    await db.query("UPDATE policy_states SET snapshot=$2 WHERE enrollment_id=$1", [enrollment, JSON.stringify(withDeadline)]);
    try {
      const overview = await ok(sessions.instructor!, "GET", `/api/admin/courses/${catalog}/overview`);
      expect(overview.deadlineRisks).toEqual([expect.objectContaining({ enrollmentId: enrollment, deadline: soon, daysLeft: 2, remainingEpisodes: 2 })]);
    } finally {
      await db.query("UPDATE policy_states SET snapshot=$2 WHERE enrollment_id=$1", [enrollment, JSON.stringify(snapshot)]);
    }
  });
});

describe("workspace audit", () => {
  it("shows staff and system payloads from the allowlist and withholds learner and agent payloads", async () => {
    const log = await ok(sessions.support_observer!, "GET", `/api/admin/workspaces/${workspace}/audit?limit=200`);
    const events = log.events as { type: string; actorKind: string; actor: string | null; payload: unknown; payloadWithheld: boolean }[];
    const published = events.find((e) => e.type === "course.published")!;
    expect(published).toMatchObject({ actorKind: "staff", actor: "owner person", payloadWithheld: false, payload: { releaseId: expect.any(String) } });
    const granted = events.filter((e) => e.type === "people.course_grant_created");
    expect(granted.length).toBeGreaterThanOrEqual(4);
    for (const g of granted) expect(g.payload).toMatchObject({ reasonCode: "support_case", grantId: expect.any(String), expiresAt: expect.any(String) });
    const learnerEvents = events.filter((e) => e.actorKind === "learner");
    expect(learnerEvents.length).toBeGreaterThan(0);
    for (const e of learnerEvents) expect(e).toMatchObject({ payload: null, payloadWithheld: true, actor: null });
    expect(JSON.stringify(log)).not.toContain(CHAT_MARKER);
    // Filters and paging.
    const staffOnly = await ok(sessions.owner!, "GET", `/api/admin/workspaces/${workspace}/audit?actorKind=staff&limit=2`);
    expect(staffOnly.events).toHaveLength(2);
    expect(staffOnly.events.every((e: { actorKind: string }) => e.actorKind === "staff")).toBe(true);
    const next = await ok(sessions.owner!, "GET", `/api/admin/workspaces/${workspace}/audit?actorKind=staff&limit=2&before=${staffOnly.nextBefore}`);
    expect(Number(next.events[0].sequence)).toBeLessThan(Number(staffOnly.events[1].sequence));
    expect((await call(sessions.owner!, "GET", `/api/admin/workspaces/${workspace}/audit?limit=999`)).statusCode).toBe(400);
    expect((await call(sessions.owner!, "GET", `/api/admin/workspaces/${workspace}/audit?type=DROP%20TABLE`)).statusCode).toBe(400);
  });

  it("projects payloads by type: a learner or agent kind, an unlisted type or an accommodation's free-text reason never shows", () => {
    expect(auditPayload("learner", "course.published", { releaseId: "x" })).toBeNull();
    expect(auditPayload("agent", "course.published", { releaseId: "x" })).toBeNull();
    expect(auditPayload("staff", "companion.requested", { content: "x" })).toBeNull();
    expect(auditPayload("staff", "policy.accommodation_authorized", { accommodationId: "a", reason: "medical detail", reasonRef: "r1" })).toEqual({ accommodationId: "a", reasonRef: "r1" });
    expect(Object.keys(AUDIT_PAYLOAD_PROJECTIONS).some((t) => /^(companion|learner_model|assessment\.submitted|gate\.review_requested|assessment\.appeal_requested)/.test(t))).toBe(false);
  });
});
