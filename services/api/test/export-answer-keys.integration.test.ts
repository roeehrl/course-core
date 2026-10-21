import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import { createDatabase, type Database } from "../src/database.js";
import { createTestDatabase, type TestDatabase } from "./test-database.js";
import { createServer } from "../src/server.js";
import { issueLoginCode } from "../src/auth.js";
import { WITHHELD_FROM_STAFF } from "../src/learner-privacy.js";
import { fixture } from "./fixture.js";

// Answer keys, hidden fixtures and generator internals never reach a learner through a data
// export, for canonical course items or for generated variants. Every key below carries a
// distinctive marker, and the raw response bytes are searched for it.
const origin = "http://localhost:4386",
  schema = "export_keys_" + randomUUID().replaceAll("-", "");
let db: Database, app: Awaited<ReturnType<typeof createServer>>, testDatabase: TestDatabase | undefined;
let workspace: string, release: string, owner: Session, learner: Session, enrollment: string, marker: string;
interface Session {
  userId: string;
  cookie: string;
  csrf: string;
}
async function session(role: string): Promise<Session> {
  const id = randomUUID();
  await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [id, "export-keys:" + id, role + " person"]);
  await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspace, id, role]);
  const r = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, id) } });
  return { userId: id, cookie: r.cookies.map((c) => c.name + "=" + c.value).join("; "), csrf: r.json().csrfToken };
}
function call(who: Session, method: "GET" | "POST", url: string, payload?: unknown) {
  return app.inject({ method, url, headers: { origin, cookie: who.cookie, "x-csrf-token": who.csrf }, ...(payload === undefined ? {} : { payload: payload as object }) });
}
async function command(action: string, body: Record<string, unknown>) {
  const snapshot = (await call(learner, "GET", "/api/enrollments/" + enrollment)).json();
  const r = await call(learner, "POST", `/api/enrollments/${enrollment}/${action}`, { expectedRevision: snapshot.revision, idempotencyKey: randomUUID(), ...body });
  expect(r.statusCode, action + " " + r.body).toBe(200);
  return r;
}
/** The canonical course with a trace item whose answer key carries the marker. */
function course() {
  const c = fixture();
  const min = c.chapters[0]!.episodes.find((e) => e.id === "min")!;
  min.blocks.push({ id: "min-trace", type: "assessment", assessmentId: "min-t" });
  c.assessments.push({
    id: "min-t", type: "trace", objectiveIds: ["minimum"], familyId: "trace", prompt: "Trace finding the minimum of 4 and 9.",
    steps: [{ id: "s1", prompt: "Which value is kept after the first comparison?" }],
    grading: { expected: [{ stepId: "s1", answer: `${marker}-trace-key` }], match: "exact", explanation: "Keep the smaller value at each comparison." },
  } as (typeof c.assessments)[number]);
  return c;
}
/** A generated item variant as the adaptation pipeline stores it, every private part marked. */
function variantArtifact(id: string) {
  return {
    id, kind: "assessment_variant", digest: "c".repeat(64), generator: { id: `${marker}-generator`, version: "1.0.0" },
    objectiveIds: ["minimum"], sourceRefs: ["teaching"], canonicalAssessmentId: "min-a",
    assessment: {
      id: `variant-${id}`, type: "choice", objectiveIds: ["minimum"], familyId: `${marker}-family`, prompt: "Which is smaller, 6 or 11?",
      options: [{ id: "six", text: "6" }, { id: "eleven", text: "11", misconceptionId: `${marker}-misconception` }],
      grading: { correctOptionId: "six", explanation: `${marker}-variant-explanation` }, rubricInternal: `${marker}-rubric-internal`,
    },
    hiddenFixtures: { cases: [{ input: `${marker}-hidden-input`, expected: `${marker}-hidden-output` }] },
    recipe: { recipeId: `${marker}-recipe`, variables: { a: 6, b: 11 }, evaluatorSecret: `${marker}-evaluator-secret` },
  };
}
/** Stores generated artifacts for the enrollment exactly where the adaptation pipeline does.
 * An `erased` artifact is stored as erasure leaves it ({}). */
async function storeGenerated(artifacts: Record<string, unknown>[], erased: string[] = []) {
  const digest = "a".repeat(64), proposalId = randomUUID();
  await db.query(
    "INSERT INTO adaptation_registry_versions(course_release_id,workspace_id,revision,base_digest,configuration,configuration_digest,approved_by) VALUES($1,$2,1,$3,$4,$3,$5)",
    [release, workspace, digest, JSON.stringify({ secret: `${marker}-registry` }), owner.userId],
  );
  await db.query(
    `INSERT INTO adaptation_proposals(id,enrollment_id,workspace_id,course_release_id,registry_revision,proposal_key,base_digest,proposal_digest,expected_plan_revision,
       verified_policy_revision,body,assignments,evidence_fence,authority_ref,created_by) VALUES($1,$2,$3,$4,1,$5,$6,$6,0,1,$7,'[]','{}','authority',$8)`,
    [proposalId, enrollment, workspace, release, "proposal-" + proposalId, digest, JSON.stringify({ artifacts }), owner.userId],
  );
  for (const [n, artifact] of artifacts.entries())
    await db.query("INSERT INTO adaptation_artifacts(enrollment_id,artifact_id,proposal_id,artifact_digest,body) VALUES($1,$2,$3,$4,$5)", [
      enrollment, artifact.id, proposalId, String(n + 1).repeat(64), erased.includes(artifact.id as string) ? "{}" : JSON.stringify(artifact),
    ]);
}

beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false });
});
beforeEach(async () => {
  workspace = randomUUID();
  marker = "KEYMARK" + randomUUID().replaceAll("-", "");
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspace, "keys-" + workspace, "Export keys"]);
  owner = await session("owner");
  learner = await session("learner");
  const created = await call(owner, "POST", `/api/workspaces/${workspace}/releases`, course());
  expect(created.statusCode, created.body).toBe(200);
  release = created.json().id;
  expect((await call(owner, "POST", `/api/releases/${release}/publish`)).statusCode).toBe(200);
  enrollment = (await call(learner, "POST", "/api/enrollments", { releaseId: release })).json().id;
});
afterAll(async () => {
  await app?.close();
  await db?.end();
  await testDatabase?.drop();
});

describe("answer keys never leave the server in a data export", () => {
  it("a learner's export keeps their answers, scores and feedback but no canonical or generated key", async () => {
    // The canonical trace item: its question carries no key, and a wrong answer is recorded with feedback.
    const issued = await command("challenges", { episodeId: "min", assessmentId: "min-t", mode: "practice" });
    expect(issued.body).not.toContain(marker);
    expect(issued.json().question).toEqual({
      id: "min-t", type: "trace", objectiveIds: ["minimum"], prompt: "Trace finding the minimum of 4 and 9.", allowAbstain: true,
      steps: [{ id: "s1", prompt: "Which value is kept after the first comparison?" }],
    });
    // An open challenge is shown again in the enrollment snapshot: still no key.
    expect((await call(learner, "GET", "/api/enrollments/" + enrollment)).body).not.toContain(marker);
    const answered = await command("answers", { challengeId: issued.json().challengeId, answer: { s1: "my own trace answer" } });
    expect(answered.json().result).toMatchObject({ passed: false, explanation: "Keep the smaller value at each comparison." });
    expect(answered.body).not.toContain(marker);
    // Generated personal teaching: an explanation and two item variants, one later erased to {}.
    await storeGenerated([
      { id: "teach-1", kind: "explanation", digest: "d".repeat(64), generator: { id: `${marker}-generator`, version: "1.0.0" }, objectiveIds: ["minimum"], sourceRefs: ["teaching"], markdown: "Compare two values at a time." },
      variantArtifact("variant-1"),
      variantArtifact("variant-2"),
    ], ["variant-2"]);

    const r = await call(learner, "GET", `/api/enrollments/${enrollment}/export`);
    expect(r.statusCode, r.body).toBe(200);
    // The raw bytes, not a parsed view: no marked key, fixture, recipe, generator or field anywhere.
    expect(r.rawPayload.toString("utf8")).not.toContain(marker);
    expect(r.body).not.toMatch(/"grading"|correctOptionId|hiddenFixtures|"recipe"|absoluteTolerance|misconceptionId/);
    const doc = r.json();
    expect(doc.audience).toBe("learner");
    // Their own answer, score, feedback and timestamp stay.
    const attempt = doc.attempts.items.find((a: { assessment_id: string }) => a.assessment_id === "min-t");
    expect(attempt).toMatchObject({ response: { s1: "my own trace answer" }, result: { passed: false, explanation: "Keep the smaller value at each comparison." } });
    expect(Date.parse(attempt.submitted_at)).not.toBeNaN();
    expect(doc.supervision.personalTeaching).toEqual([
      { artifactId: "teach-1", kind: "explanation", objectiveIds: ["minimum"], sourceRefs: ["teaching"], markdown: "Compare two values at a time." },
      {
        artifactId: "variant-1", kind: "assessment_variant", objectiveIds: ["minimum"], sourceRefs: ["teaching"],
        question: { id: "variant-variant-1", type: "choice", objectiveIds: ["minimum"], prompt: "Which is smaller, 6 or 11?", allowAbstain: true, options: [{ id: "six", text: "6" }, { id: "eleven", text: "11" }] },
      },
      { artifactId: "variant-2", erased: true },
    ]);
  });

  it("generated content (check questions, code exercises, simulations, components, waiting changes, reports) exports no key", async () => {
    const common = { digest: "e".repeat(64), generator: { id: `${marker}-generator`, version: "1.0.0" }, objectiveIds: ["minimum"], sourceRefs: ["teaching"] };
    await storeGenerated([
      { ...common, id: "check-1", kind: "assessment_variant", canonicalAssessmentId: "min-a",
        assessment: { id: "check-1--item", type: "numeric", objectiveIds: ["minimum"], familyId: `${marker}-family`, prompt: "How many boxes are highlighted?",
          grading: { expected: 3, absoluteTolerance: 0, explanation: `${marker}-check-explanation` } },
        hiddenFixtures: { protocol: "scene-model-v1", model: { read: `${marker}-model` }, visualDigest: `${marker}-visual-digest`, claimedAnswer: `${marker}-claimed` } },
      { ...common, id: "code-1", kind: "assessment_variant", canonicalAssessmentId: "min-a",
        assessment: { id: "code-1--item", type: "code", objectiveIds: ["minimum"], familyId: `${marker}-family`, prompt: "Return the smaller value.", language: "python",
          starterCode: "def smaller(a, b):\n    pass\n", grading: { evaluatorId: `${marker}-evaluator`, fixtureRef: `${marker}-fixture` } },
        hiddenFixtures: { protocol: "generated-code-v1", cases: [{ id: "t1", input: `${marker}-input`, expected: `${marker}-expected` }],
          referenceSolution: `${marker}-reference`, wrongSolutions: [`${marker}-wrong`] } },
      { ...common, id: "sim-1", kind: "visual", visual: { id: "sim-1", title: "Boxes" } },
      { ...common, id: "component-1", kind: "practice", markdown: "Drag the slider to compare the values." },
    ]);
    const proposal = (await db.query("SELECT proposal_id FROM adaptation_artifacts WHERE enrollment_id=$1 AND artifact_id='code-1'", [enrollment])).rows[0].proposal_id;
    // The component with its hidden tests, a waiting generated change and the proposal's validation report.
    await db.query("INSERT INTO generated_components(enrollment_id,workspace_id,proposal_id,episode_id,block_id,digest,artifact_digest,body) VALUES($1,$2,$3,'min','component-1',$4,$4,$5)",
      [enrollment, workspace, proposal, "f".repeat(64), JSON.stringify({ source: `${marker}-source`, tests: [`${marker}-component-test`] })]);
    await db.query("INSERT INTO adaptation_validation_reports(enrollment_id,workspace_id,proposal_id,report) VALUES($1,$2,$3,$4)",
      [enrollment, workspace, proposal, JSON.stringify({ checks: [{ id: "key", detail: `${marker}-report` }] })]);
    const job = randomUUID();
    await db.query(`INSERT INTO supervisor_jobs(id,enrollment_id,workspace_id,workflow_id,role,state,expected_revision,specification) VALUES($1,$2,$3,$4,'supervisor','running',1,'{}')`,
      [job, enrollment, workspace, `export-keys-${job}`]);
    await db.query("INSERT INTO adaptation_pending_changes(id,enrollment_id,workspace_id,job_id,episode_id,artifact_kind,selection,reason) VALUES($1,$2,$3,$4,'min','assessment_variant',$5,'attempt_in_progress')",
      [randomUUID(), enrollment, workspace, job, JSON.stringify({ artifact: variantArtifact("pending-1") })]);
    for (const who of [learner, owner]) {
      const r = await call(who, "GET", who === learner ? `/api/enrollments/${enrollment}/export` : `/api/admin/enrollments/${enrollment}/export`);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.rawPayload.toString("utf8")).not.toContain(marker);
      expect(r.body).not.toMatch(/"grading"|hiddenFixtures|referenceSolution|wrongSolutions|claimedAnswer|"selection"|"report"/);
      const doc = r.json();
      expect(doc.supervision.personalTeaching.map((a: { artifactId: string }) => a.artifactId).sort()).toEqual(["check-1", "code-1", "component-1", "sim-1"]);
      expect(doc.supervision.personalTeaching.find((a: { artifactId: string }) => a.artifactId === "code-1").question).toMatchObject({ language: "python", starterCode: "def smaller(a, b):\n    pass\n" });
      expect(doc.supervision.pendingPersonalChanges).toEqual([expect.objectContaining({ artifact_kind: "assessment_variant", status: "waiting", reason: "attempt_in_progress" })]);
      expect(doc.supervision.generatedComponents).toEqual([expect.objectContaining({ block_id: "component-1", digest: "f".repeat(64) })]);
    }
  });

  it("a staff export follows the privacy rule and carries no key either", async () => {
    await command("companion", { episodeId: "min", content: "A private question " + marker.toLowerCase() });
    await storeGenerated([variantArtifact("variant-1")]);
    const learnerCopy = await call(learner, "GET", `/api/enrollments/${enrollment}/export`);
    const staffCopy = await call(owner, "GET", `/api/admin/enrollments/${enrollment}/export`);
    expect(staffCopy.statusCode, staffCopy.body).toBe(200);
    const doc = staffCopy.json();
    expect(doc).toMatchObject({ audience: "staff", withheld: WITHHELD_FROM_STAFF, companion: null, learnerModel: null });
    expect(staffCopy.rawPayload.toString("utf8")).not.toContain(marker);
    expect(staffCopy.body).not.toContain(marker.toLowerCase());
    expect(staffCopy.body).not.toMatch(/"grading"|correctOptionId|hiddenFixtures|"recipe"/);
    // The same allowlisted teaching as the learner's own copy.
    expect(doc.supervision.personalTeaching).toEqual(learnerCopy.json().supervision.personalTeaching);
    // The learner's own copy keeps their conversation; still no key.
    expect(learnerCopy.body).toContain(marker.toLowerCase());
    expect(learnerCopy.rawPayload.toString("utf8")).not.toContain(marker);
    // Instructors still get no export at all.
    expect((await call(await session("instructor"), "GET", `/api/admin/enrollments/${enrollment}/export`)).statusCode).toBe(404);
  });
});
