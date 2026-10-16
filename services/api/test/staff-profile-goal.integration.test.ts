import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "../src/database.js";
import { createTestDatabase, type TestDatabase } from "./test-database.js";
import { createServer } from "../src/server.js";
import { issueLoginCode } from "../src/auth.js";
import { reviewedRubricEvaluator } from "../src/rubric-evaluator.js";
import { enrollmentProfileFor, WITHHELD_FROM_STAFF } from "../src/learner-privacy.js";
import { rubricCourse } from "./rubric-fixture.js";

// The learner's profile goal under the shared privacy rule (learner-privacy.ts): every
// staff role that may read the enrollment sees it on every staff surface; a role without
// enrollment access does not, and the learner model's own private copy stays withheld.
const origin = "http://localhost:4396",
  schema = "staff_goal_" + randomUUID().replaceAll("-", "");
let db: Database, app: Awaited<ReturnType<typeof createServer>>, testDatabase: TestDatabase | undefined;
let workspace: string, catalog: string, enrollment: string, learner: Session, goal: string, privateGoal: string;
interface Session { userId: string; cookie: string; csrf: string }

async function session(role: string, workspaceId = workspace): Promise<Session> {
  const id = randomUUID();
  await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [id, "goal:" + id, role + " person"]);
  await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspaceId, id, role]);
  const r = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, id) } });
  return { userId: id, cookie: r.cookies.map((c) => c.name + "=" + c.value).join("; "), csrf: r.json().csrfToken };
}
function call(who: Session, method: "GET" | "POST", url: string, payload?: unknown) {
  return app.inject({ method, url, headers: { origin, cookie: who.cookie, "x-csrf-token": who.csrf }, ...(payload === undefined ? {} : { payload: payload as object }) });
}
async function command(action: string, body: Record<string, unknown>) {
  const revision = (await call(learner, "GET", "/api/enrollments/" + enrollment)).json().revision;
  const r = await call(learner, "POST", `/api/enrollments/${enrollment}/${action}`, { expectedRevision: revision, idempotencyKey: randomUUID(), ...body });
  expect(r.statusCode, action + " " + r.body).toBe(200);
}
const surfaces = {
  enrollments: (who: Session) => call(who, "GET", `/api/admin/courses/${catalog}`),
  learnerView: (who: Session) => call(who, "GET", `/api/admin/enrollments/${enrollment}/learner-view`),
  staffExport: (who: Session) => call(who, "GET", `/api/admin/enrollments/${enrollment}/export`),
  learnerModel: (who: Session) => call(who, "GET", `/api/enrollments/${enrollment}/learner-model?episodeId=min`),
};
const profile = () => ({ displayName: "Goal learner", goal, pace: "focused" });

beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false, installedExtensions: [reviewedRubricEvaluator()] });
});
beforeEach(async () => {
  workspace = randomUUID();
  goal = "Explain comparisons to my team GOAL-" + randomUUID();
  privateGoal = "Private memory goal MODEL-" + randomUUID();
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspace, "goal-" + workspace, "Staff goal"]);
  const owner = await session("owner");
  const created = await call(owner, "POST", `/api/workspaces/${workspace}/releases`, rubricCourse());
  expect(created.statusCode, created.body).toBe(200);
  expect((await call(owner, "POST", `/api/releases/${created.json().id}/publish`)).statusCode).toBe(200);
  catalog = (await db.query("SELECT id FROM admin_course_catalog WHERE workspace_id=$1", [workspace])).rows[0].id;
  learner = await session("learner");
  enrollment = (await call(learner, "POST", "/api/enrollments", { releaseId: created.json().id })).json().id;
  await command("profile", { profile: profile() });
  // The learner model keeps its own copy of the goal; once the learner edits it there it is private.
  await command("learner-model/profile", { profile: { preferences: { goal: privateGoal }, priorKnowledge: [], thoughts: "" } });
});
afterAll(async () => {
  await app?.close();
  await db?.end();
  await testDatabase?.drop();
});

describe("the learner's profile goal on staff surfaces", () => {
  it("is shown to owners and admins in the enrollment view, the staff export, view-as-learner and the learner-model read", async () => {
    for (const role of ["owner", "admin"]) {
      const who = await session(role);
      const course = await surfaces.enrollments(who);
      expect(course.statusCode, course.body).toBe(200);
      expect(course.json().enrollments.find((e: { id: string }) => e.id === enrollment).profile).toEqual(profile());

      const exported = await surfaces.staffExport(who);
      expect(exported.statusCode, exported.body).toBe(200);
      expect(exported.json()).toMatchObject({ audience: "staff", learnerModel: null, enrollment: { profile: profile() } });
      expect(exported.json().withheld).toEqual(WITHHELD_FROM_STAFF);

      const view = await surfaces.learnerView(who);
      expect(view.statusCode, view.body).toBe(200);
      expect(view.json().learner).toEqual(profile());
      expect(view.json().snapshot.profile).toEqual(profile());

      const model = await surfaces.learnerModel(who);
      expect(model.statusCode, model.body).toBe(200);
      expect(model.json()).toMatchObject({ access: "staff", profile: profile() });
      expect(model.json()).not.toHaveProperty("selfReport");

      // The learner model's own copy of the goal stays private on every one of them.
      for (const r of [course, exported, view, model]) expect(r.body).not.toContain(privateGoal);
    }
  });

  it("is shown to other roles exactly where they may already read the enrollment", async () => {
    for (const role of ["instructor", "reviewer", "support_observer"]) {
      const who = await session(role);
      const course = await surfaces.enrollments(who);
      expect(course.statusCode, course.body).toBe(200);
      expect(course.json().enrollments.find((e: { id: string }) => e.id === enrollment).profile.goal).toBe(goal);
      // The view and the export stay owner/admin only.
      expect((await surfaces.learnerView(who)).statusCode).toBe(403);
      expect((await surfaces.staffExport(who)).statusCode).toBe(404);
    }
    // Instructors also read the learner-model understanding, now with the enrollment profile.
    const instructor = await session("instructor");
    const model = await surfaces.learnerModel(instructor);
    expect(model.statusCode, model.body).toBe(200);
    expect(model.json().profile).toEqual(profile());
    expect(model.body).not.toContain(privateGoal);
  });

  it("stays hidden from an observer, who has no enrollment access, on every surface", async () => {
    const observer = await session("observer");
    const course = await surfaces.enrollments(observer);
    expect(course.statusCode, course.body).toBe(200);
    expect(course.json().enrollments).toEqual([]);
    expect((await surfaces.learnerView(observer)).statusCode).toBe(403);
    expect((await surfaces.staffExport(observer)).statusCode).toBe(404);
    expect((await surfaces.learnerModel(observer)).statusCode).toBe(403);
    for (const r of [course, await surfaces.learnerView(observer), await surfaces.staffExport(observer), await surfaces.learnerModel(observer)])
      expect(r.body).not.toContain(goal);
    // Course grants follow the same rule: an observer grant does not open it, an instructor grant does.
    const grant = async (role: string) => {
      const who = await session("course_scoped");
      await db.query("INSERT INTO course_access_grants(id,workspace_id,catalog_id,user_id,role,reason_code,granted_by,expires_at) VALUES($1,$2,$3,$4,$5,'synthetic_test',$4,clock_timestamp()+interval '1 day')",
        [randomUUID(), workspace, catalog, who.userId, role]);
      return who;
    };
    const scopedObserver = await grant("observer");
    const scopedCourse = await surfaces.enrollments(scopedObserver);
    expect(scopedCourse.statusCode, scopedCourse.body).toBe(200);
    expect(scopedCourse.json().enrollments).toEqual([]);
    for (const read of Object.values(surfaces)) expect((await read(scopedObserver)).body).not.toContain(goal);
    const scopedInstructor = await grant("instructor");
    expect((await surfaces.enrollments(scopedInstructor)).json().enrollments[0].profile.goal).toBe(goal);
    expect((await surfaces.learnerModel(scopedInstructor)).json().profile.goal).toBe(goal);
  });

  it("the shared rule: staff with enrollment access get exactly name, goal and pace; others get nothing; the learner gets their profile as stored", () => {
    const stored = { displayName: "Sam", goal: "Learn sorting", pace: "steady" };
    for (const role of ["owner", "admin", "instructor", "reviewer", "support_observer", "service"])
      expect(enrollmentProfileFor("staff", role, { ...stored, extra: "x" })).toEqual(stored);
    for (const role of ["observer", "author", "learner", "course_scoped", "", null, undefined])
      expect(enrollmentProfileFor("staff", role, stored)).toBeNull();
    expect(enrollmentProfileFor("learner", null, stored)).toBe(stored);
    expect(enrollmentProfileFor("staff", "admin", {})).toEqual({ displayName: "Learner", goal: "", pace: "steady" });
  });

  it("the learner still reads their own profile and private memory copy in full", async () => {
    const own = await call(learner, "GET", `/api/enrollments/${enrollment}/export`);
    expect(own.statusCode, own.body).toBe(200);
    expect(own.json().enrollment.profile).toEqual(profile());
    expect(own.body).toContain(privateGoal);
  });
});
