import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CourseManifest } from "@course-core/sdk";
import { createDatabase, type Database } from "../src/database.js";
import { createServer } from "../src/server.js";
import { issueLoginCode } from "../src/auth.js";
import { reviewedRubricEvaluator } from "../src/rubric-evaluator.js";
import { createTestDatabase, type TestDatabase } from "./test-database.js";
import { fixture } from "./fixture.js";
import { gatedCourse, repairEvaluatorStub } from "./gated-fixture.js";

// Real HTTP and PostgreSQL 17 (Q09): answer keys and rubrics edited on a draft release with the
// course's test answers checked first, wrong-answer fixture management and recorded test runs.
const origin = "http://localhost:4396",
  schema = "assessment_admin_" + randomUUID().replaceAll("-", "");
let db: Database, app: Awaited<ReturnType<typeof createServer>>, testDatabase: TestDatabase | undefined;
interface Session { userId: string; cookie: string; csrf: string }
let workspace: string, owner: Session, author: Session, observer: Session, instructor: Session, learner: Session;
let catalog: string, published: string, draft: string, versions = 0;

async function person(role: string, workspaceId = workspace): Promise<Session> {
  const id = randomUUID();
  await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [id, "aa:" + id, role + " person"]);
  await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspaceId, id, role]);
  const r = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, id) } });
  return { userId: id, cookie: r.cookies.map((c) => c.name + "=" + c.value).join("; "), csrf: r.json().csrfToken };
}
const call = (who: Session, method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { origin, cookie: who.cookie, "x-csrf-token": who.csrf }, ...(payload === undefined ? {} : { payload: payload as object }) });
async function release(course: CourseManifest, publish: boolean) {
  const created = await call(owner, "POST", `/api/workspaces/${workspace}/releases`, course);
  expect(created.statusCode, created.body).toBe(200);
  if (publish) expect((await call(owner, "POST", `/api/releases/${created.json().id}/publish`)).statusCode).toBe(200);
  return created.json().id as string;
}
/** A published release and a draft of the next version of the same course. */
async function course(make: (version: string) => CourseManifest = (v) => ({ ...fixture(), version: v })) {
  const minor = versions++;
  published = await release(make(`8.${minor}.0`), true);
  draft = await release(make(`8.${minor}.1`), false);
  catalog = (await call(owner, "GET", "/api/admin/session")).json().courses[0].id;
}
const base = () => `/api/admin/courses/${catalog}`;
const items = async (releaseId = draft, who = owner) => call(who, "GET", `${base()}/releases/${releaseId}/assessments`);
const digestOf = async (releaseId = draft) => (await items(releaseId)).json().release.digest as string;
const addFixture = (body: Record<string, unknown>, who = owner) => call(who, "POST", `${base()}/assessment-fixtures`, { releaseId: published, ...body });
const putKey = async (grading: unknown, extra: Record<string, unknown> = {}, releaseId = draft) =>
  call(owner, "PUT", `${base()}/releases/${releaseId}/assessments/min-a/key`, { grading, expectedDigest: await digestOf(releaseId), ...extra });

beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false, installedExtensions: [reviewedRubricEvaluator(), repairEvaluatorStub()] });
}, 30_000);
beforeEach(async () => {
  workspace = randomUUID();
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspace, "aa-" + workspace, "Assessment admin"]);
  owner = await person("owner");
  author = await person("author");
  observer = await person("observer");
  instructor = await person("instructor");
  learner = await person("learner");
});
afterAll(async () => {
  await app?.close();
  await db?.end();
  await testDatabase?.drop();
});

describe("answer keys and test answers (Q09)", () => {
  it("lists a release's questions with their keys to course writers only", async () => {
    await course();
    const listed = await items();
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.headers["cache-control"]).toBe("no-store");
    expect(listed.json().release).toMatchObject({ id: draft, status: "draft", editable: true });
    expect(listed.json().items.find((i: { assessmentId: string }) => i.assessmentId === "min-a"))
      .toMatchObject({ kind: "key", type: "choice", editable: true, key: { correctOptionId: "two" }, options: [{ id: "two", text: "2" }, { id: "five", text: "5" }], fixtures: 0 });
    expect((await items(published)).json().release).toMatchObject({ status: "published", editable: false });
    expect((await items(draft, author)).statusCode).toBe(200);
    // Keys reveal answers: roles without course.write, and learners, never get them.
    for (const who of [observer, instructor, learner]) expect((await items(draft, who)).statusCode, "role").toBeGreaterThanOrEqual(403);
    const elsewhere = randomUUID();
    await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [elsewhere, "aa-" + elsewhere, "Elsewhere"]);
    expect((await items(draft, await person("owner", elsewhere))).statusCode).toBe(403);
    expect((await items(randomUUID())).statusCode).toBe(404);
  });

  it("keeps wrong-answer and right-answer fixtures per question, checked against the key when added", async () => {
    await course();
    const wrong = await addFixture({ assessmentId: "min-a", answer: "five", expected: "incorrect", label: "Picks the larger value" });
    expect(wrong.statusCode, wrong.body).toBe(200);
    expect(wrong.json()).toMatchObject({ assessmentId: "min-a", expected: "incorrect", outcome: "incorrect", status: "passed" });
    // A fixture the current key disagrees with is kept and reported as failing.
    expect((await addFixture({ assessmentId: "min-b", answer: 9, expected: "correct", label: "Says nine" })).json()).toMatchObject({ outcome: "incorrect", status: "failed" });
    expect((await addFixture({ assessmentId: "min-a", answer: "two", expected: "correct" })).json()).toMatchObject({ status: "passed" });
    expect((await addFixture({ assessmentId: "min-a", answer: "five", expected: "incorrect" })).json().error).toBe("FIXTURE_DUPLICATE");
    expect((await addFixture({ assessmentId: "min-a", answer: "seven", expected: "incorrect" })).json().error).toBe("FIXTURE_ANSWER_INVALID");
    expect((await addFixture({ assessmentId: "min-b", answer: { value: 4, unit: "cm" }, expected: "correct" })).json().error).toBe("FIXTURE_ANSWER_INVALID");
    expect((await addFixture({ assessmentId: "no-such-item", answer: "two", expected: "correct" })).statusCode).toBe(404);
    for (const bad of [{ assessmentId: "min-a", answer: "two", expected: "maybe" }, { assessmentId: "min-a", answer: ["two"], expected: "correct" }, { assessmentId: "min-a", expected: "correct" },
      { assessmentId: "min-a", answer: "two", expected: "correct", label: "x".repeat(201) }])
      expect((await addFixture(bad)).statusCode, JSON.stringify(bad)).toBe(400);
    expect((await addFixture({ assessmentId: "min-a", answer: "two", expected: "correct" }, observer)).statusCode).toBe(403);
    const listed = (await call(owner, "GET", `${base()}/assessment-fixtures?assessmentId=min-a`)).json();
    expect(listed.fixtures.map((f: { answer: unknown; expected: string }) => [f.answer, f.expected])).toEqual([["five", "incorrect"], ["two", "correct"]]);
    expect((await call(observer, "GET", `${base()}/assessment-fixtures`)).statusCode).toBe(403);
    // Removal is soft and audited; a second removal finds nothing.
    const id = listed.fixtures[0].fixtureId;
    expect((await call(owner, "DELETE", `${base()}/assessment-fixtures/${id}`)).json()).toEqual({ fixtureId: id, removed: true });
    expect((await call(owner, "DELETE", `${base()}/assessment-fixtures/${id}`)).statusCode).toBe(404);
    expect((await db.query("SELECT removed_by FROM assessment_fixtures WHERE id=$1", [id])).rows[0].removed_by).toBe(owner.userId);
    expect((await call(owner, "GET", `${base()}/assessment-fixtures?assessmentId=min-a`)).json().fixtures).toHaveLength(1);
    const types = (await db.query("SELECT event_type FROM learning_events WHERE workspace_id=$1 AND event_type LIKE 'admin.assessment.%' ORDER BY sequence", [workspace])).rows.map((r) => r.event_type);
    expect(types).toEqual(["admin.assessment.fixture_added", "admin.assessment.fixture_added", "admin.assessment.fixture_added", "admin.assessment.fixture_removed"]);
  });

  it("previews a key change against the test answers, and saves a failing one only when asked", async () => {
    await course();
    await addFixture({ assessmentId: "min-a", answer: "five", expected: "incorrect", label: "Picks the larger value" });
    await addFixture({ assessmentId: "min-a", answer: "two", expected: "correct" });
    const bad = { correctOptionId: "five", explanation: "Five is the answer." };
    const preview = await call(owner, "POST", `${base()}/releases/${draft}/assessments/min-a/key/preview`, { grading: bad });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json()).toMatchObject({ failing: 2, changed: 2 });
    expect(preview.json().results[0]).toMatchObject({ label: "Picks the larger value", expected: "incorrect", before: "incorrect", outcome: "correct", status: "failed", changed: true });
    const before = await digestOf();
    const refused = await putKey(bad);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: "FIXTURES_FAIL", details: { failing: 2 } });
    expect(await digestOf()).toBe(before);
    // A change the fixtures agree with saves; the draft is re-validated and needs review again.
    const reworded = await putKey({ correctOptionId: "two", explanation: "Two is below five, so it is the smaller value." });
    expect(reworded.statusCode, reworded.body).toBe(200);
    expect(reworded.json()).toMatchObject({ failing: 0, changed: 0 });
    expect(reworded.json().digest).not.toBe(before);
    expect((await db.query("SELECT state,reviewed_digest FROM admin_release_reviews WHERE release_id=$1", [draft])).rows[0]).toEqual({ state: "draft", reviewed_digest: null });
    const stored = (await db.query("SELECT server_bundle FROM course_releases WHERE id=$1", [draft])).rows[0].server_bundle as CourseManifest;
    expect(stored.assessments.find((a) => a.id === "min-a")!.grading).toEqual({ correctOptionId: "two", explanation: "Two is below five, so it is the smaller value." });
    expect((await putKey(bad, { acceptFailingFixtures: true })).json()).toMatchObject({ failing: 2 });
    // Published releases never change; a stale editor, a bad key and a code or written item are refused.
    expect((await putKey(bad, {}, published)).json().error).toBe("PUBLISHED_RELEASE_IMMUTABLE");
    expect((await call(owner, "PUT", `${base()}/releases/${draft}/assessments/min-a/key`, { grading: bad, expectedDigest: before })).json().error).toBe("RELEASE_CHANGED");
    expect((await putKey({ correctOptionId: "seven", explanation: "No such option." })).json().error).toBe("INVALID_KEY");
    expect((await putKey({ correctOptionId: "two" })).json().error).toBe("INVALID_KEY");
    expect((await call(observer, "POST", `${base()}/releases/${draft}/assessments/min-a/key/preview`, { grading: bad })).statusCode).toBe(403);
    const audit = (await db.query("SELECT payload FROM learning_events WHERE workspace_id=$1 AND event_type='admin.assessment.key_changed' ORDER BY sequence", [workspace])).rows;
    expect(audit.map((r) => r.payload.failingFixtures)).toEqual([0, 2]);
  });

  it("edits numeric keys with tolerance and unit", async () => {
    await course();
    await addFixture({ assessmentId: "min-b", answer: 4, expected: "correct" });
    await addFixture({ assessmentId: "min-b", answer: 4.4, expected: "incorrect", label: "Rounding error" });
    const call4 = async (grading: unknown) => call(owner, "PUT", `${base()}/releases/${draft}/assessments/min-b/key`, { grading, expectedDigest: await digestOf() });
    // A looser tolerance would accept the rounding error: refused until asked.
    expect((await call4({ expected: 4, absoluteTolerance: 0.5, explanation: "4 is below 9." })).json()).toMatchObject({ error: "FIXTURES_FAIL", details: { failing: 1 } });
    expect((await call4({ expected: 4, absoluteTolerance: 0.1, explanation: "4 is below 9." })).statusCode).toBe(200);
    expect((await call4({ expected: 4, absoluteTolerance: -1, explanation: "Negative." })).json().error).toBe("INVALID_KEY");
  });

  it("runs every test answer against a release and keeps the report; readers see counts only", async () => {
    await course();
    await addFixture({ assessmentId: "min-a", answer: "five", expected: "incorrect" });
    await addFixture({ assessmentId: "max-a", answer: 9, expected: "correct" });
    const run = await call(owner, "POST", `${base()}/releases/${published}/fixture-runs`);
    expect(run.statusCode, run.body).toBe(200);
    expect(run.json()).toMatchObject({ passed: 2, failed: 0, notRunnable: 0, release: { id: published, status: "published" } });
    await putKey({ correctOptionId: "five", explanation: "Wrong on purpose." }, { acceptFailingFixtures: true });
    const second = (await call(owner, "POST", `${base()}/releases/${draft}/fixture-runs`)).json();
    expect(second).toMatchObject({ passed: 1, failed: 1 });
    expect(second.results.find((r: { status: string }) => r.status === "failed")).toMatchObject({ assessmentId: "min-a", expected: "incorrect", outcome: "correct" });
    const report = (await call(owner, "GET", `${base()}/fixture-runs`)).json().runs;
    expect(report.map((r: { failed: number; stale: boolean }) => [r.failed, r.stale])).toEqual([[1, false], [0, false]]);
    expect(report[0].results).toHaveLength(2);
    const counts = await call(observer, "GET", `${base()}/fixture-runs`);
    expect(counts.statusCode, counts.body).toBe(200);
    expect(counts.json().runs[0]).not.toHaveProperty("results");
    expect((await call(observer, "POST", `${base()}/releases/${draft}/fixture-runs`)).statusCode).toBe(403);
    expect((await call(learner, "GET", `${base()}/fixture-runs`)).statusCode).toBeGreaterThanOrEqual(403);
    // A later draft edit marks the run stale.
    await putKey({ correctOptionId: "two", explanation: "Fixed." });
    expect((await call(owner, "GET", `${base()}/fixture-runs`)).json().runs[0].stale).toBe(true);
  });

  it("edits a course rubric only under a new version, and reports code questions as not runnable here", async () => {
    await course((v) => gatedCourse(v));
    const listed = (await items()).json();
    expect(listed.rubrics[0]).toMatchObject({ id: "explain-minimum", version: "1.0.0", usedBy: ["min-teach", "min-counter", "min-design"] });
    expect(listed.items.find((i: { assessmentId: string }) => i.assessmentId === "min-repair")).toMatchObject({ kind: "not_editable", editable: false });
    expect(listed.items.find((i: { assessmentId: string }) => i.assessmentId === "min-teach")).toMatchObject({ kind: "course_rubric", rubricId: "explain-minimum" });
    const criteria = [{ id: "invariant", description: "States that the kept value never exceeds any value already read.", required: true },
      { id: "own-example", description: "Works through an example of their own.", required: true }];
    const put = async (body: Record<string, unknown>) => call(owner, "PUT", `${base()}/releases/${draft}/rubrics/explain-minimum`, { expectedDigest: await digestOf(), ...body });
    expect((await put({ criteria, version: "1.0.0" })).json().error).toBe("RUBRIC_VERSION_REQUIRED");
    expect((await put({ criteria })).json().error).toBe("RUBRIC_VERSION_REQUIRED");
    const saved = await put({ criteria, version: "1.1.0" });
    expect(saved.statusCode, saved.body).toBe(200);
    const stored = (await db.query("SELECT server_bundle FROM course_releases WHERE id=$1", [draft])).rows[0].server_bundle as CourseManifest;
    expect(stored.rubrics![0]).toMatchObject({ version: "1.1.0", criteria: [{ id: "invariant", description: criteria[0]!.description, evidence: "cited_learner_span" }, { id: "own-example" }] });
    expect((await put({ criteria: [{ id: "a", description: "Same id twice.", required: true }, { id: "a", description: "Again.", required: false }], version: "1.2.0" })).statusCode).toBe(400);
    expect((await call(owner, "PUT", `${base()}/releases/${draft}/rubrics/no-such-rubric`, { criteria, version: "1.0.0", expectedDigest: await digestOf() })).statusCode).toBe(404);
    expect((await addFixture({ assessmentId: "min-repair", answer: "def solve(values): return min(values)", expected: "correct" })).json().error).toBe("FIXTURE_NOT_RUNNABLE");
  });

  it("lists when each cited source was last reviewed against a review window, most urgent first (Q09 source freshness)", async () => {
    const day = 86_400_000, date = (ago: number) => new Date(Date.now() - ago * day - 60_000).toISOString();
    await course((v) => {
      const c = fixture();
      c.version = v;
      c.sources = [
        { id: "fresh", title: "Recent notes", url: "https://example.org/recent", reviewedAt: date(10) },
        { id: "soon", title: "Older notes", url: "https://example.org/older", reviewedAt: date(350) },
        { id: "old", title: "Old notes", url: "https://example.com/old", reviewedAt: date(500) },
      ];
      const block = c.chapters[0]!.episodes[0]!.blocks.find((b) => b.type === "text")!;
      (block as { sourceRefs?: string[] }).sourceRefs = ["old", "fresh"];
      return c;
    });
    const read = (windowDays?: number, who = owner) => call(who, "GET", `${base()}/releases/${published}/sources${windowDays ? `?windowDays=${windowDays}` : ""}`);
    const year = (await read()).json();
    expect(year).toMatchObject({ windowDays: 365, summary: { total: 3, current: 1, dueSoon: 1, overdue: 1, undated: 0 } });
    expect(year.sources.map((s: { id: string; status: string }) => [s.id, s.status])).toEqual([["old", "overdue"], ["soon", "due_soon"], ["fresh", "current"]]);
    expect(year.sources[0]).toMatchObject({ host: "example.com", ageDays: 500, citedBy: { blocks: 1, episodeIds: ["min"] } });
    expect(year.sources[1].citedBy).toEqual({ blocks: 0, episodeIds: [] });
    // A shorter window makes more sources due; only the offered windows are accepted.
    expect((await read(180)).json().summary).toMatchObject({ overdue: 2, current: 1 });
    expect((await read(42)).statusCode).toBe(400);
    // Readers of the course may look; people outside it may not.
    expect((await read(365, observer)).statusCode).toBe(200);
    const elsewhere = randomUUID();
    await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [elsewhere, "aa-" + elsewhere, "Elsewhere"]);
    const stranger = await person("owner", elsewhere);
    expect((await read(365, stranger)).statusCode).toBe(403);
  });
});
