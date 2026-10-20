import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from "vitest";
import { checkGateDecision, validateRecord, type CourseManifest } from "@course-core/sdk";
import { createDatabase, type Database } from "../src/database.js";
import { createTestDatabase, type TestDatabase } from "./test-database.js";
import { createServer } from "../src/server.js";
import { issueLoginCode } from "../src/auth.js";
import { reviewedRubricEvaluator } from "../src/rubric-evaluator.js";
import { gatedCourse, repairEvaluatorStub, teachBackAnswer } from "./gated-fixture.js";
import { retentionCourse } from "./retention-fixture.js";

// Gate-review metrics are recorded by the routes after commit; capture the calls (kind, action, outcome).
const appeals = vi.hoisted(() => [] as unknown[][]);
vi.mock("../src/telemetry.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/telemetry.js")>()),
  countAppeal: (...args: unknown[]) => { appeals.push(args); } }));

// Real HTTP and PostgreSQL 17. The code-repair evaluator is a labelled stub (see gated-fixture.ts).
const origin = "http://localhost:4396",
  schema = "gates_" + randomUUID().replaceAll("-", "");
let db: Database, app: Awaited<ReturnType<typeof createServer>>;
let workspace: string, owner: Session, learner: Session, instructor: Session, release: string, enrollment: string, catalog: string, course: CourseManifest, versions = 0;
interface Session { userId: string; cookie: string; csrf: string }
async function session(role: string): Promise<Session> {
  const id = randomUUID();
  await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [id, "gates:" + id, role + " person"]);
  await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspace, id, role]);
  const r = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, id) } });
  return { userId: id, cookie: r.cookies.map((c) => c.name + "=" + c.value).join("; "), csrf: r.json().csrfToken };
}
const call = (who: Session, method: "GET" | "POST", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { origin, cookie: who.cookie, "x-csrf-token": who.csrf }, ...(payload === undefined ? {} : { payload: payload as object }) });
const view = async (who = learner, id = enrollment) => (await call(who, "GET", "/api/enrollments/" + id)).json();
async function send(action: string, body: Record<string, unknown>, who = learner, id = enrollment) {
  return call(who, "POST", `/api/enrollments/${id}/${action}`, { expectedRevision: (await view(who, id)).revision, idempotencyKey: randomUUID(), ...body });
}
async function issue(assessmentId: string, mode = "independent", who = learner, id = enrollment) {
  const issued = await send("challenges", { episodeId: "min", assessmentId, mode }, who, id);
  expect(issued.statusCode, issued.body).toBe(200);
  return issued.json();
}
async function answer(assessmentId: string, body: Record<string, unknown>, who = learner, id = enrollment) {
  const challenge = await issue(assessmentId, "independent", who, id);
  return send("answers", { challengeId: challenge.challengeId, ...body }, who, id);
}
const decision = async (who = learner, id = enrollment) => {
  const r = await call(who, "GET", `/api/enrollments/${id}/gates/min-gate/decision`);
  expect(r.statusCode, r.body).toBe(200);
  return r.json().decision;
};
/** Core identifiers are UUIDs; SDK record IDs must start with a letter. Prefix them to check the record shape. */
const sdkIds = (record: Record<string, unknown>) => JSON.parse(JSON.stringify(record).replace(/"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/g, '"core-$1"'));
const gateOf = async () => (await view()).lessons.find((l: { id: string }) => l.id === "min").gate;
const complete = (body: Record<string, unknown> = {}) => send("complete", { episodeId: "min", ...body });
async function publish(manifest: CourseManifest) {
  const imported = await call(owner, "POST", `/api/workspaces/${workspace}/releases`, manifest);
  expect(imported.statusCode, imported.body).toBe(200);
  return { id: imported.json().id as string, published: await call(owner, "POST", `/api/releases/${imported.json().id}/publish`) };
}
async function makeReady() {
  expect((await answer("min-b", { answer: 4 })).json().result.passed).toBe(true);
  expect((await answer("min-predict", { answer: 12.6 })).json().result.passed).toBe(true);
}
const findings = (quote1: string | undefined, quote2: string | undefined) => [
  { criterionId: "invariant", met: Boolean(quote1), ...(quote1 ? { quote: quote1 } : {}) },
  { criterionId: "own-example", met: Boolean(quote2), ...(quote2 ? { quote: quote2 } : {}) },
];
const pendingFor = async (assessmentId: string) =>
  (await call(instructor, "GET", `/api/admin/courses/${catalog}/rubric-reviews`)).json().pending.find((p: { enrollmentId: string; assessmentId: string }) => p.enrollmentId === enrollment && p.assessmentId === assessmentId);

let testDatabase: TestDatabase | undefined;
beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false, installedExtensions: [reviewedRubricEvaluator(), repairEvaluatorStub()] });
}, 30000);
beforeEach(async () => {
  workspace = randomUUID();
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspace, "gates-" + workspace, "Gates"]);
  owner = await session("owner");
  learner = await session("learner");
  instructor = await session("instructor");
  course = gatedCourse(`5.0.${versions++}`);
  const { id, published } = await publish(course);
  expect(published.statusCode, published.body).toBe(200);
  release = id;
  enrollment = (await call(learner, "POST", "/api/enrollments", { releaseId: release })).json().id;
  catalog = (await call(owner, "GET", "/api/admin/session")).json().courses[0].id;
  expect((await send("read", { episodeId: "min", blockId: "min-text" })).statusCode).toBe(200);
});
afterAll(async () => {
  await app?.close();
  await db?.end();
  await testDatabase?.drop();
});

describe("migration 036", () => {
  it("adds immutable gate decision records, the decision link on progress and optional confidence", async () => {
    const columns = async (table: string) => (await db.query("SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2", [schema, table])).rows.map((r) => r.column_name);
    expect(await columns("gate_decisions")).toEqual(expect.arrayContaining(["gate_version", "course_digest", "policy_revision", "status", "criterion_results", "learner_visible_reason", "next_actions", "inputs_digest", "supersedes", "superseded_at"]));
    expect(await columns("episode_progress")).toContain("gate_decision_id");
    expect(await columns("attempts")).toContain("confidence");
    const record = await decision();
    await expect(db.query("UPDATE gate_decisions SET status='ready' WHERE id=$1", [record.decisionId])).rejects.toThrow(/GATE_DECISION_IMMUTABLE/);
    await expect(db.query("DELETE FROM gate_decisions WHERE id=$1", [record.decisionId])).rejects.toThrow(/GATE_DECISION_IMMUTABLE/);
    await expect(db.query("UPDATE gate_decisions SET status='bogus' WHERE id=$1", [record.decisionId])).rejects.toThrow();
    await answer("min-predict", { answer: 12.5, confidence: 4 });
    await expect(db.query("UPDATE attempts SET confidence=9 WHERE enrollment_id=$1", [enrollment])).rejects.toThrow();
    // A second current decision for the same gate is impossible.
    await expect(db.query(`INSERT INTO gate_decisions(id,enrollment_id,workspace_id,gate_id,gate_version,course_digest,policy_revision,status,criterion_results,missing_objective_ids,
      unresolved_misconception_ids,evidence_refs,evaluator,learner_visible_reason,next_actions,inputs_digest) VALUES($1,$2,$3,'min-gate','1.0.0','d',1,'ready','[]','[]','[]','[]','{}','r','[]',$4)`,
      [randomUUID(), enrollment, workspace, "a".repeat(64)])).rejects.toThrow();
  });
});

describe("publish-time assessment rules", () => {
  it("rejects recognition-only, transfer-less and unchecked-misconception versioned gates at import", async () => {
    const recognition = gatedCourse("9.0.0");
    Object.assign(recognition.gates[0]!, { interactiveCheckRefs: ["min-a"], practicalTaskRefs: [], minimumIndependentEvidence: { families: 1, transferItems: 1 } });
    const r1 = await call(owner, "POST", `/api/workspaces/${workspace}/releases`, recognition);
    expect(r1.statusCode).toBe(400);
    expect(r1.json().issues.map((i: { code: string }) => i.code)).toContain("RECOGNITION_ONLY_GATE");
    const noTransfer = gatedCourse("9.0.1");
    Object.assign(noTransfer.gates[0]!, { readinessCriteria: (noTransfer.gates[0] as { readinessCriteria: { kind: string }[] }).readinessCriteria.filter((c) => c.kind !== "transfer_success") });
    expect((await call(owner, "POST", `/api/workspaces/${workspace}/releases`, noTransfer)).json().issues.map((i: { code: string }) => i.code)).toContain("MISSING_TRANSFER_CRITERION");
    const unchecked = gatedCourse("9.0.2");
    Object.assign(unchecked.gates[0]!, { readinessCriteria: (unchecked.gates[0] as { readinessCriteria: { kind: string }[] }).readinessCriteria.filter((c) => c.kind !== "no_critical_misconception") });
    expect((await call(owner, "POST", `/api/workspaces/${workspace}/releases`, unchecked)).json().issues.map((i: { code: string }) => i.code)).toContain("MISSING_MISCONCEPTION_CHECK");
  });
  it("refuses at publish what Core cannot enforce: unconfirmed conversational judgments, uncited production rubrics and 0.4 conversational gates", async () => {
    const unconfirmed = gatedCourse("9.1.0", { conversation: true });
    unconfirmed.evaluators![0]!.humanConfirmation = "on_uncertain";
    const a = await publish(unconfirmed);
    expect(a.published.statusCode).toBe(409);
    expect(a.published.json().error).toBe("PUBLISH_CONVERSATION_RUBRIC_UNSUPPORTED");
    const uncited = gatedCourse("9.1.1");
    uncited.rubrics![0]!.requiresCitedEvidence = false;
    uncited.rubrics![0]!.criteria[1]!.evidence = "observation";
    const b = await publish(uncited);
    expect(b.published.json().error).toBe("PUBLISH_RUBRIC_EVIDENCE_UNSUPPORTED");
    const legacy = gatedCourse("9.1.2");
    Object.assign(legacy.gates[1]!, { conversationalEvaluatorId: legacy.extensions[0]!.id });
    expect((await publish(legacy)).published.json().error).toBe("PUBLISH_CONVERSATIONAL_GATE_UNSUPPORTED");
    // None of the refused drafts became learnable.
    expect((await db.query("SELECT count(*)::int AS n FROM course_releases WHERE workspace_id=$1 AND status='published'", [workspace])).rows[0].n).toBe(1);
  });
});

describe("server-side gate decisions", () => {
  it("needs_evidence: the advance command is refused with concrete next actions and the decision is persisted", async () => {
    const refused = await complete();
    expect(refused.statusCode).toBe(409);
    const body = refused.json();
    expect(body.error).toBe("GATE_NOT_READY");
    expect(body.details.status).toBe("needs_evidence");
    expect(body.details.reason).toMatch(/2 different item families/);
    expect(body.details.nextActions[0]).toMatchObject({ kind: "attempt_check", targetId: "min-a" });
    expect(body.details.nextActions[0].label).toMatch(/fresh independent check on “Find a minimum” \(0 of 2 item families so far\)/);
    expect(body.details.nextActions.map((a: { kind: string }) => a.kind)).toEqual(expect.arrayContaining(["request_help", "review_material"]));
    expect(body.details.nextActions.find((a: { kind: string }) => a.kind === "review_material").label).toBe("Review “Minimum” before your next attempt");
    const persisted = (await db.query("SELECT * FROM gate_decisions WHERE enrollment_id=$1 AND superseded_at IS NULL", [enrollment])).rows;
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({ gate_id: "min-gate", gate_version: "1.0.0", status: "needs_evidence", course_digest: (await view()).courseDigest });
    expect(body.details.decision.decisionId).toBe(persisted[0].id);
    expect(validateRecord("gateDecision", sdkIds(body.details.decision))).toMatchObject({ valid: true });
    expect(checkGateDecision(course, sdkIds(body.details.decision))).toEqual({ valid: true, issues: [] });
    expect(await gateOf()).toMatchObject({ status: "needs_evidence", passed: false, decisionId: persisted[0].id });
  });
  it("needs_help: repeated unsuccessful or abstained attempts put help first", async () => {
    expect((await answer("min-a", { answer: "five" })).json().result.passed).toBe(false);
    expect((await answer("min-b", { abstain: true })).json().result.abstained).toBe(true);
    const record = await decision();
    expect(record.status).toBe("needs_help");
    expect(validateRecord("gateDecision", sdkIds(record))).toMatchObject({ valid: true });
    expect(record.nextActions[0]).toMatchObject({ kind: "request_help" });
    expect(record.nextActions[0].label).toMatch(/your last 2 attempts on this checkpoint did not succeed/);
    expect(record.unresolvedMisconceptionIds).toEqual(["picks-larger"]);
  });
  it("under_review: a submitted written task waits for review and nothing counts against the learner", async () => {
    const submitted = await answer("min-teach", { answer: teachBackAnswer });
    expect(submitted.json().result).toMatchObject({ pendingReview: true, passed: false });
    const record = await decision();
    expect(record.status).toBe("under_review");
    expect(validateRecord("gateDecision", sdkIds(record))).toMatchObject({ valid: true });
    expect(record.nextActions[0]).toMatchObject({ kind: "await_review" });
    expect(record.learnerVisibleReason).toMatch(/Nothing is counted against you/);
    expect((await complete()).json().details.status).toBe("under_review");
  });
  it("ready: independent families plus a production transfer task, then completion records the authorizing decision", async () => {
    await makeReady();
    const gate = await gateOf();
    expect(gate).toMatchObject({ status: "ready", passed: true });
    expect(gate.nextActions).toEqual([{ kind: "continue", label: "Continue to “Maximum”", targetId: "max" }]);
    const record = await decision();
    expect(record).toMatchObject({ status: "ready", nextActivityId: "max", evaluator: { kind: "host_policy", id: "course-core.gate-policy" } });
    expect(checkGateDecision(course, sdkIds(record))).toEqual({ valid: true, issues: [] });
    const done = await complete({ gateDecisionId: record.decisionId });
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json().lessons.find((l: { id: string }) => l.id === "min").status).toBe("completed");
    expect((await db.query("SELECT gate_decision_id FROM episode_progress WHERE enrollment_id=$1 AND episode_id='min'", [enrollment])).rows[0].gate_decision_id).toBe(record.decisionId);
  });
  it("closed_with_gaps: at the cap an unmet gate closes with gaps, appeal and extension actions, never a pass", async () => {
    await answer("min-b", { answer: 4 });
    const snapshot = (await db.query("SELECT snapshot FROM policy_states WHERE enrollment_id=$1", [enrollment])).rows[0].snapshot;
    snapshot.scopes[0].hardDeadline = { at: new Date(Date.now() - 1000).toISOString(), timeZone: "UTC", disambiguation: "reject" };
    await db.query("UPDATE policy_states SET snapshot=$2 WHERE enrollment_id=$1", [enrollment, JSON.stringify(snapshot)]);
    const record = await decision();
    expect(record.status).toBe("closed_with_gaps");
    expect(validateRecord("gateDecision", sdkIds(record))).toMatchObject({ valid: true });
    expect(record.nextActions.map((a: { kind: string }) => a.kind)).toEqual(["view_gaps", "appeal", "consider_extension"]);
    expect(record.nextActions[0].label).toBe("See what remains unproven: “Find a minimum”");
    expect(record.nextActions[1].label).toBe("Request a staff review of this decision within 14 days");
    const refused = await complete();
    expect(refused.json()).toMatchObject({ error: "GATE_NOT_READY", details: { status: "closed_with_gaps" } });
  });
  it("rejects a stale decision from another tab or policy revision, and an unlinked or forged one", async () => {
    await makeReady();
    const first = await decision();
    // Another tab answers one more check: the evidence set changes and the decision is superseded.
    expect((await answer("min-trace", { answer: { s1: "6", s2: " 4 ", s3: "4" } })).json().result.passed).toBe(true);
    const second = await decision();
    expect(second.decisionId).not.toBe(first.decisionId);
    expect(second.supersedes).toBe(first.decisionId);
    const stale = await complete({ gateDecisionId: first.decisionId });
    expect(stale.json()).toMatchObject({ error: "GATE_DECISION_STALE", details: { decision: { decisionId: second.decisionId, status: "ready" } } });
    // A changed policy revision (for example an accepted extension) also makes the old decision stale.
    await db.query("UPDATE policy_states SET policy_revision=policy_revision+1,snapshot=jsonb_set(snapshot,'{policyRevision}',to_jsonb(policy_revision+1)) WHERE enrollment_id=$1", [enrollment]);
    const third = await decision();
    expect(third.policyRevision).toBe(second.policyRevision + 1);
    expect((await complete({ gateDecisionId: second.decisionId })).json().error).toBe("GATE_DECISION_STALE");
    // Another learner's decision, or an unknown ID, is not linked to this gate.
    const other = await session("learner"), otherEnrollment = (await call(other, "POST", "/api/enrollments", { releaseId: release })).json().id;
    const foreign = await decision(other, otherEnrollment);
    expect((await complete({ gateDecisionId: foreign.decisionId })).json().error).toBe("GATE_DECISION_UNLINKED");
    expect((await complete({ gateDecisionId: randomUUID() })).json().error).toBe("GATE_DECISION_UNLINKED");
    // The current decision completes the episode.
    expect((await complete({ gateDecisionId: third.decisionId })).statusCode).toBe(200);
    const history = (await call(learner, "GET", `/api/enrollments/${enrollment}/gates/min-gate/decisions`)).json().decisions;
    expect(history.filter((d: { current: boolean }) => d.current)).toHaveLength(1);
    expect(history.map((d: { decisionId: string }) => d.decisionId)).toEqual(expect.arrayContaining([first.decisionId, second.decisionId, third.decisionId]));
  });
  it("an injected 'ready' record grants nothing: Core recomputes from evidence at commit time", async () => {
    await answer("min-b", { answer: 4 });
    const current = await decision();
    await db.query("UPDATE gate_decisions SET superseded_at=clock_timestamp() WHERE id=$1", [current.decisionId]);
    const forged = randomUUID();
    await db.query(`INSERT INTO gate_decisions(id,enrollment_id,workspace_id,gate_id,gate_version,episode_id,course_digest,policy_revision,status,criterion_results,missing_objective_ids,
      unresolved_misconception_ids,evidence_refs,evaluator,learner_visible_reason,next_actions,next_activity_id,inputs_digest) VALUES($1,$2,$3,'min-gate','1.0.0','min',$4,$5,'ready','[]','[]','[]','[]',$6,'Forged','[]','max',$7)`,
      [forged, enrollment, workspace, current.courseDigest, current.policyRevision, JSON.stringify({ kind: "host_policy", id: "x", version: "1" }), "b".repeat(64)]);
    expect((await complete()).json()).toMatchObject({ error: "GATE_NOT_READY", details: { status: "needs_evidence" } });
    expect((await complete({ gateDecisionId: forged })).json().error).toBe("GATE_DECISION_STALE");
    expect((await db.query("SELECT superseded_at FROM gate_decisions WHERE id=$1", [forged])).rows[0].superseded_at).not.toBeNull();
    expect((await db.query("SELECT count(*)::int AS n FROM episode_progress WHERE enrollment_id=$1 AND state='completed'", [enrollment])).rows[0].n).toBe(0);
  });
  it("recognition alone cannot pass a versioned gate, and a critical misconception must be ruled out later", async () => {
    // Two families, but both are recognition or application: no transfer.
    expect((await answer("min-a", { answer: "five" })).json().result.passed).toBe(false);
    expect((await answer("min-b", { answer: 4 })).json().result.passed).toBe(true);
    expect((await answer("min-trace", { answer: { s1: "6", s2: "4", s3: "4" } })).json().result.passed).toBe(true);
    let record = await decision();
    expect(record.status).toBe("needs_evidence");
    expect(record.criterionResults.find((c: { criterionId: string }) => c.criterionId === "families").met).toBe(true);
    expect(record.criterionResults.find((c: { criterionId: string }) => c.criterionId === "transfer").reason).toMatch(/choosing among given answers does not count as transfer/);
    // A transfer task that does not target the misconception leaves it unresolved.
    expect((await answer("min-repair", { answer: "def solve(values):\n    best = values[0]\n    for value in values:\n        if value < best:\n            best = value\n    return best\n" })).json().result.passed).toBe(true);
    record = await decision();
    expect(record.status).toBe("needs_evidence");
    expect(record.unresolvedMisconceptionIds).toEqual(["picks-larger"]);
    expect(record.nextActions[0]).toMatchObject({ kind: "attempt_check", targetId: "min-predict" });
    expect(record.nextActions[0].label).toMatch(/rules out the mix-up “Keeps the larger value/);
    // A later independent success on an item that can expose it resolves it.
    expect((await answer("min-predict", { answer: 12.5 })).json().result.passed).toBe(true);
    expect((await decision()).status).toBe("ready");
  });
  it("refuses an answer that reproduces a companion reply as agent-authored", async () => {
    const tutor = "The kept value is never greater than any value seen so far, because each step keeps the smaller one.";
    await db.query("INSERT INTO companion_messages(id,enrollment_id,role,content,context) VALUES($1,$2,'assistant',$3,'{}')", [randomUUID(), enrollment, tutor]);
    const refused = await answer("min-teach", { answer: teachBackAnswer });
    expect(refused.json().error).toBe("AGENT_AUTHORED_ANSWER");
    expect((await db.query("SELECT count(*)::int AS n FROM attempts WHERE enrollment_id=$1 AND assessment_id='min-teach'", [enrollment])).rows[0].n).toBe(0);
  });
});

describe("\"I don't know\" and confidence", () => {
  it("records an abstention and confidence without evidence or credit", async () => {
    const abstained = await answer("min-predict", { abstain: true, confidence: 2 });
    expect(abstained.statusCode, abstained.body).toBe(200);
    expect(abstained.json().result).toMatchObject({ passed: false, abstained: true, explanation: "12.5 is never replaced by a larger value." });
    const attempt = (await db.query("SELECT id,confidence,result,response FROM attempts WHERE enrollment_id=$1 AND assessment_id='min-predict'", [enrollment])).rows[0];
    expect(attempt).toMatchObject({ confidence: 2, result: { abstained: true, passed: false }, response: null });
    expect((await db.query("SELECT count(*)::int AS n FROM evidence WHERE attempt_id=$1", [attempt.id])).rows[0].n).toBe(0);
    // Confidence alone never passes: a confident wrong answer is still wrong; a hesitant right one still counts.
    const confident = await answer("min-b", { answer: 9 });
    expect(confident.json().result.passed).toBe(false);
    const mid = await issue("min-a");
    expect((await send("answers", { challengeId: mid.challengeId, answer: "two", confidence: 1 })).json().error).toBe("INVALID_CONFIDENCE");
    expect((await send("answers", { challengeId: mid.challengeId, answer: "two" })).json().result).toMatchObject({ passed: true, independent: true });
    expect((await gateOf()).objectives[0].families).toEqual(["compare"]);
  });
  it("validates abstention and confidence input", async () => {
    const challenge = await issue("min-predict");
    expect((await send("answers", { challengeId: challenge.challengeId, answer: 12.5, abstain: true })).json().error).toBe("INVALID_ANSWER");
    expect((await send("answers", { challengeId: challenge.challengeId })).json().error).toBe("INVALID_ANSWER");
    expect((await send("answers", { challengeId: challenge.challengeId, answer: 12.5, confidence: 6 })).json().error).toBe("INVALID_CONFIDENCE");
    expect((await send("answers", { challengeId: challenge.challengeId, abstain: false })).json().error).toBe("INVALID_REQUEST");
    const teach = await issue("min-teach");
    expect(teach.question.allowAbstain).toBe(false);
    expect((await send("answers", { challengeId: teach.challengeId, abstain: true })).json().error).toBe("ABSTAIN_NOT_ALLOWED");
  });
  it("uses the default 1, 3, 7 and 21 day review schedule when a course declares none", async () => {
    const manifest = retentionCourse() as CourseManifest & { retention: { intervalsDays?: number[] } };
    manifest.version = `7.0.${versions++}`;
    delete manifest.retention.intervalsDays;
    const { id } = await publish(manifest);
    const other = await session("learner"), otherEnrollment = (await call(other, "POST", "/api/enrollments", { releaseId: id })).json().id;
    const retention = await call(other, "GET", `/api/enrollments/${otherEnrollment}/retention`);
    expect(retention.json()).toMatchObject({ available: true, intervalsDays: [1, 3, 7, 21] });
  });
});

describe("new item types over HTTP", () => {
  it("serves questions without keys, roles or misconception links", async () => {
    const choice = (await issue("min-a")).question, prediction = (await issue("min-predict")).question;
    const trace = (await issue("min-trace")).question, repair = (await issue("min-repair")).question, teach = (await issue("min-teach")).question;
    for (const q of [choice, prediction, trace, repair, teach]) {
      expect(q).not.toHaveProperty("grading");
      expect(q).not.toHaveProperty("familyId");
      expect(q).not.toHaveProperty("role");
      expect(q).not.toHaveProperty("misconceptionIds");
    }
    expect(choice.options).toEqual([{ id: "two", text: "2" }, { id: "five", text: "5" }]);
    expect(prediction).toMatchObject({ type: "prediction", unit: "cm", allowAbstain: true, confidence: { capture: "optional", scale: { minimum: 1, maximum: 5 } } });
    expect(trace.steps.map((s: { id: string }) => s.id)).toEqual(["s1", "s2", "s3"]);
    expect(repair).toMatchObject({ type: "code_repair", language: "python" });
    expect(repair.starterCode).toContain("if value > best:");
    expect(teach.criteria.map((c: { id: string }) => c.id)).toEqual(["invariant", "own-example"]);
    expect(JSON.stringify([choice, prediction, trace, repair, teach])).not.toMatch(/picks-larger|expected|fixtureRef|rubricId|explanation/);
  });
  it("accepts a prediction with its declared unit and refuses another unit without recording a wrong answer", async () => {
    const challenge = await issue("min-predict");
    const other = await send("answers", { challengeId: challenge.challengeId, answer: { value: 126, unit: "mm" } });
    expect(other.statusCode).toBe(400);
    expect(other.json()).toMatchObject({ error: "UNIT_MISMATCH", details: { expectedUnit: "cm" } });
    expect((await db.query("SELECT count(*)::int AS n FROM attempts WHERE enrollment_id=$1", [enrollment])).rows[0].n).toBe(0);
    // The same challenge is still open: restated in the declared unit, it is graded with the relative tolerance.
    expect((await send("answers", { challengeId: challenge.challengeId, answer: { value: 12.6, unit: "cm", note: "x" } })).json().error).toBe("INVALID_REQUEST");
    const restated = await send("answers", { challengeId: challenge.challengeId, answer: { value: 12.6, unit: "cm" } });
    expect(restated.json().result, restated.body).toMatchObject({ passed: true, independent: true, evaluator: "deterministic-prediction@1" });
    expect((await db.query("SELECT response FROM attempts WHERE enrollment_id=$1", [enrollment])).rows[0].response).toEqual({ value: 12.6, unit: "cm" });
  });
  it("grades prediction with relative tolerance and trace per step, deterministically", async () => {
    expect((await answer("min-predict", { answer: 12.7 })).json().result).toMatchObject({ passed: false, evaluator: "deterministic-prediction@1" });
    const wrong = (await answer("min-trace", { answer: { s1: "6", s2: "4", s3: "9" } })).json().result;
    expect(wrong).toMatchObject({ passed: false, steps: [{ stepId: "s1", correct: true }, { stepId: "s2", correct: true }, { stepId: "s3", correct: false }] });
    const bad = await issue("min-b");
    expect((await send("answers", { challengeId: bad.challengeId, answer: { s1: "4" } })).json().error).toBe("INVALID_ANSWER");
    const solution = await send("solution", { challengeId: bad.challengeId });
    expect(solution.json()).toMatchObject({ independentEligible: false, explanation: "4 is below 9." });
  });
  it("routes code repair to the installed code evaluator", async () => {
    const wrong = (await answer("min-repair", { answer: "def solve(values):\n    return max(values)\n" })).json().result;
    expect(wrong).toMatchObject({ passed: false, execution: { passedCases: 1, totalCases: 3 } });
    const evidence = (await db.query("SELECT evaluator_ref,result FROM evidence WHERE enrollment_id=$1", [enrollment])).rows;
    expect(evidence).toEqual([{ evaluator_ref: "public-repair-stub@1.0.0", result: { passed: false } }]);
  });
  it("routes counterexample, experiment design and teach-back to quoted human review", async () => {
    for (const id of ["min-counter", "min-design", "min-teach"]) {
      const submitted = await answer(id, { answer: teachBackAnswer });
      expect(submitted.json().result, id).toMatchObject({ pendingReview: true, passed: false });
    }
    const counter = await pendingFor("min-counter");
    expect(counter.rubric.map((c: { id: string }) => c.id)).toEqual(["invariant", "own-example"]);
    const review = (attemptId: string, body: Record<string, unknown>) =>
      call(instructor, "POST", `/api/admin/rubric-reviews/${attemptId}`, { decision: "met", idempotencyKey: "k-" + randomUUID(), ...body });
    // A judgment without the learner's own words is refused; so is a quote the learner did not write.
    expect((await review(counter.attemptId, { criteria: [{ criterionId: "invariant", met: true }, { criterionId: "own-example", met: true, quote: "For example with 7, 3 and 9" }] })).json().error).toBe("RUBRIC_QUOTE_REQUIRED");
    expect((await review(counter.attemptId, { criteria: findings("the learner clearly understands", "For example with 7, 3 and 9") })).json().error).toBe("RUBRIC_QUOTE_REQUIRED");
    const met = await review(counter.attemptId, { criteria: findings("The kept value is never greater than any value seen so far", "For example with 7, 3 and 9") });
    expect(met.statusCode, met.body).toBe(200);
    const evidence = (await db.query("SELECT result FROM evidence WHERE attempt_id=$1", [counter.attemptId])).rows[0].result;
    expect(evidence).toMatchObject({ passed: true, reviewed: true, citedSpans: [{ turnId: counter.attemptId, quote: "The kept value is never greater than any value seen so far" }, { turnId: counter.attemptId, quote: "For example with 7, 3 and 9" }] });
    // The reviewed counterexample is independent production evidence: with one more family the gate is ready.
    expect((await decision()).status).toBe("under_review");
    expect((await answer("min-b", { answer: 4 })).json().result.passed).toBe(true);
    for (const id of ["min-design", "min-teach"]) {
      const pending = await pendingFor(id);
      expect((await review(pending.attemptId, { decision: "not_met", criteria: findings(undefined, undefined) })).statusCode).toBe(200);
    }
    expect((await decision()).status).toBe("ready");
  });
});

describe("gate review and exception", () => {
  const requestReview = (body: Record<string, unknown>, who = learner, id = enrollment) => send("gates/min-gate/review-requests", body, who, id);
  const reason = "I worked through the lesson but ran out of time for the transfer task.";
  const queue = async (who = instructor) => (await call(who, "GET", `/api/admin/courses/${catalog}/gate-reviews`));
  const resolve = (requestId: string, body: Record<string, unknown>, who = instructor) =>
    call(who, "POST", `/api/admin/gate-reviews/${requestId}`, { idempotencyKey: "gr-" + randomUUID(), ...body });

  it("a learner asks for a review of the current decision only; staff uphold it with a reason the learner reads", async () => {
    await answer("min-b", { answer: 4 });
    const current = await decision();
    expect(current.status).toBe("needs_evidence");
    // A decision the learner was not shown now, another learner's decision, or an unknown ID is refused.
    const other = await session("learner"), otherEnrollment = (await call(other, "POST", "/api/enrollments", { releaseId: release })).json().id;
    const foreign = await decision(other, otherEnrollment);
    expect((await requestReview({ decisionId: foreign.decisionId, reason })).json().error).toBe("GATE_DECISION_UNLINKED");
    expect((await requestReview({ decisionId: randomUUID(), reason })).json().error).toBe("GATE_DECISION_UNLINKED");
    expect((await requestReview({ decisionId: current.decisionId, reason: "too short" })).json().error).toBe("REVIEW_REASON_REQUIRED");
    appeals.length = 0;
    // Nobody else can file it for the learner.
    const revision = (await view()).revision, asOther = (who: Session) =>
      call(who, "POST", `/api/enrollments/${enrollment}/gates/min-gate/review-requests`, { expectedRevision: revision, idempotencyKey: randomUUID(), decisionId: current.decisionId, reason });
    expect((await asOther(other)).statusCode).toBe(404);
    expect((await asOther(instructor)).statusCode).toBe(404);
    expect((await requestReview({ decisionId: current.decisionId, reason }, other, otherEnrollment)).json().error).toBe("GATE_DECISION_UNLINKED");
    const filed = await requestReview({ decisionId: current.decisionId, reason });
    expect(filed.statusCode, filed.body).toBe(200);
    const { requestId } = filed.json();
    expect((await requestReview({ decisionId: current.decisionId, reason })).json().error).toBe("GATE_REVIEW_OPEN");
    expect(appeals).toEqual([["gate_review", "opened"]]);
    expect((await gateOf()).review).toMatchObject({ requestId, state: "open", reviewerNote: null });
    // An owner's read-only view as the learner shows the same decision and the open request, and changes nothing.
    const decisionsBefore = (await db.query("SELECT count(*)::int AS n FROM gate_decisions WHERE enrollment_id=$1", [enrollment])).rows[0].n;
    const asLearner = await call(owner, "GET", `/api/admin/enrollments/${enrollment}/learner-view`);
    expect(asLearner.statusCode, asLearner.body).toBe(200);
    expect(asLearner.json().snapshot.lessons.find((l: { id: string }) => l.id === "min").gate).toMatchObject({
      status: "needs_evidence", decisionId: current.decisionId, learnerVisibleReason: current.learnerVisibleReason, review: { requestId, state: "open" }, exception: null });
    expect((await db.query("SELECT count(*)::int AS n FROM gate_decisions WHERE enrollment_id=$1", [enrollment])).rows[0].n).toBe(decisionsBefore);

    // Staff queue: learners and observers cannot read it; the queue carries the decision under review.
    expect((await queue(learner)).statusCode).toBe(403);
    const listed = (await queue()).json().reviews;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ requestId, enrollmentId: enrollment, reason, decision: { decisionId: current.decisionId, status: "needs_evidence" }, canGrantException: true });
    // A reviewer may uphold but not grant an exception; nobody reviews their own request.
    const reviewer = await session("reviewer");
    expect((await queue(reviewer)).json().reviews[0].canGrantException).toBe(false);
    expect((await resolve(requestId, { outcome: "exception", note: "Granting an exception here." }, reviewer)).json().error).toBe("FORBIDDEN");
    expect((await resolve(requestId, { outcome: "upheld", note: "short" }, reviewer)).json().error).toBe("INVALID_INPUT");
    const body = { outcome: "upheld", note: "The transfer task is still required; ask the companion for a worked example first.", idempotencyKey: "gr-upheld-1" };
    const upheld = await resolve(requestId, body, reviewer);
    expect(upheld.statusCode, upheld.body).toBe(200);
    expect(upheld.json()).toMatchObject({ state: "upheld", replayed: false, exception: null });
    expect((await resolve(requestId, body, reviewer)).json()).toMatchObject({ state: "upheld", replayed: true });
    expect((await resolve(requestId, { ...body, outcome: "exception" }, instructor)).json().error).toBe("GATE_REVIEW_ALREADY_DECIDED");
    // One resolution counted: the replay and the refused requests are not.
    expect(appeals).toEqual([["gate_review", "opened"], ["gate_review", "resolved", "upheld"]]);
    // The learner reads the reason; nothing about the decision or the advance rule changed.
    expect((await gateOf())).toMatchObject({ status: "needs_evidence", review: { state: "upheld", reviewerNote: body.note } });
    expect((await complete()).json().error).toBe("GATE_NOT_READY");
    const history = (await call(learner, "GET", `/api/enrollments/${enrollment}/gates/min-gate/review-requests`)).json().requests;
    expect(history).toEqual([expect.objectContaining({ requestId, state: "upheld", decisionId: current.decisionId })]);
    expect((await queue()).json().reviews).toHaveLength(0);
    // The learner's export includes the request; erasure redacts the reason and the reviewer's note.
    const exported = (await call(learner, "GET", `/api/enrollments/${enrollment}/export`)).json();
    expect(exported.gateReviewRequests).toEqual([expect.objectContaining({ id: requestId, reason, reviewer_note: body.note, state: "upheld" })]);
    const erased = await call(learner, "POST", `/api/enrollments/${enrollment}/erase`, { confirmation: `ERASE ${enrollment.slice(0, 8)}`, reason: "Learner asked for removal." });
    expect(erased.statusCode, erased.body).toBe(200);
    expect(erased.json().counts.gateReviewRequests).toBe(1);
    expect((await db.query("SELECT reason,reviewer_note FROM gate_review_requests WHERE id=$1", [requestId])).rows[0]).toEqual({ reason: "[erased]", reviewer_note: "[erased]" });
    expect((await queue()).json().reviews).toHaveLength(0);
  });

  it("shows the learner's review reason where staff decide it, never in staff copies of the record (per role)", async () => {
    await answer("min-b", { answer: 4 });
    const current = await decision();
    const marker = "GATE_REASON_" + randomUUID();
    const { requestId } = (await requestReview({ decisionId: current.decisionId, reason: `${reason} ${marker}` })).json();
    const admin = await session("admin"), reviewer = await session("reviewer");
    // Decision surfaces keep it: the course review queue and the enrollment's per-gate request list.
    for (const who of [owner, admin, instructor, reviewer]) {
      const listed = await queue(who);
      expect(listed.statusCode, listed.body).toBe(200);
      expect(listed.json().reviews[0]).toMatchObject({ requestId, reason: `${reason} ${marker}` });
    }
    for (const who of [owner, admin, instructor]) {
      const requests = await call(who, "GET", `/api/enrollments/${enrollment}/gates/min-gate/review-requests`);
      expect(requests.statusCode, requests.body).toBe(200);
      expect(requests.body).toContain(marker);
    }
    // The read-only learner view shows the request and its state, not the learner's words.
    for (const who of [owner, admin]) {
      const asLearner = await call(who, "GET", `/api/admin/enrollments/${enrollment}/learner-view`);
      expect(asLearner.statusCode, asLearner.body).toBe(200);
      expect(asLearner.json().snapshot.lessons.find((l: { id: string }) => l.id === "min").gate.review).toMatchObject({ requestId, state: "open" });
      expect(asLearner.json().withheld.map((w: { id: string }) => w.id)).toContain("gate-review-reason");
      expect(asLearner.body).not.toContain(marker);
    }
    // Staff exports keep the request, its state and the decision it names, with the reason withheld.
    for (const who of [owner, admin]) {
      const file = await call(who, "GET", `/api/admin/enrollments/${enrollment}/export`);
      expect(file.statusCode, file.body).toBe(200);
      expect(file.json().gateReviewRequests).toEqual([expect.objectContaining({ id: requestId, decision_id: current.decisionId, state: "open", reason: null })]);
      expect(file.json().withheld.map((w: { id: string }) => w.id)).toContain("gate-review-reason");
      expect(file.body).not.toContain(marker);
    }
    expect((await call(instructor, "GET", `/api/admin/enrollments/${enrollment}/export`)).statusCode).toBe(404);
    // The learner's own copy has their words.
    const own = await call(learner, "GET", `/api/enrollments/${enrollment}/export`);
    expect(own.json().gateReviewRequests).toEqual([expect.objectContaining({ id: requestId, reason: `${reason} ${marker}` })]);
  });

  it("an authorized exception lets the learner advance without becoming a pass or evidence, bound to the course version", async () => {
    await answer("min-b", { answer: 4 });
    const current = await decision();
    const { requestId } = (await requestReview({ decisionId: current.decisionId, reason })).json();
    const granted = await resolve(requestId, { outcome: "exception", note: "Documented accommodation; the transfer task stays open as a gap." });
    expect(granted.statusCode, granted.body).toBe(200);
    expect(granted.json()).toMatchObject({ state: "exception_granted", exception: { courseDigest: current.courseDigest, gateVersion: "1.0.0" } });
    // The decision is untouched: still not ready, still an SDK-valid record with its open criteria.
    const after = await decision();
    expect(after).toMatchObject({ decisionId: current.decisionId, status: "needs_evidence" });
    expect(validateRecord("gateDecision", sdkIds(after))).toMatchObject({ valid: true });
    expect(checkGateDecision(course, sdkIds(after))).toEqual({ valid: true, issues: [] });
    const gate = await gateOf();
    expect(gate).toMatchObject({ status: "needs_evidence", passed: false, exception: { requestId }, review: { state: "exception_granted" } });
    // While an exception stands the learner cannot file another request for the gate.
    expect((await requestReview({ decisionId: current.decisionId, reason })).json().error).toBe("GATE_EXCEPTION_GRANTED");
    // A stale decision ID is still refused; the current one advances under the exception.
    await answer("min-a", { answer: "five" });
    const latest = await decision();
    expect(latest.decisionId).not.toBe(current.decisionId);
    expect((await complete({ gateDecisionId: current.decisionId })).json().error).toBe("GATE_DECISION_STALE");
    const done = await complete({ gateDecisionId: latest.decisionId });
    expect(done.statusCode, done.body).toBe(200);
    const lessons = done.json().lessons, min = lessons.find((l: { id: string }) => l.id === "min");
    expect(min).toMatchObject({ status: "completed", exception: true, gate: { passed: false } });
    expect(min.gate.objectives.every((o: { passed: boolean }) => !o.passed)).toBe(true);
    expect(lessons.find((l: { id: string }) => l.id === "max").status).toBe("available");
    const progress = (await db.query("SELECT gate_decision_id,gate_exception_id,exception_course_digest FROM episode_progress WHERE enrollment_id=$1 AND episode_id='min'", [enrollment])).rows[0];
    expect(progress).toEqual({ gate_decision_id: latest.decisionId, gate_exception_id: requestId, exception_course_digest: latest.courseDigest });
    expect((await db.query("SELECT payload FROM learning_events WHERE enrollment_id=$1 AND event_type='episode.completed'", [enrollment])).rows[0].payload).toMatchObject({ gateExceptionId: requestId, gateDecisionId: latest.decisionId });
    // The exception only holds on the course version it was granted for.
    await db.query("UPDATE episode_progress SET exception_course_digest=$2 WHERE enrollment_id=$1", [enrollment, "c".repeat(64)]);
    const moved = (await view()).lessons;
    expect(moved.find((l: { id: string }) => l.id === "min").status).toBe("available");
    expect(moved.find((l: { id: string }) => l.id === "max").status).toBe("locked");
  });
  it("an exception is refused once the gate is ready, and only staff who may change enrollments grant it", async () => {
    await answer("min-b", { answer: 4 });
    const { requestId } = (await requestReview({ decisionId: (await decision()).decisionId, reason })).json();
    expect((await resolve(requestId, { outcome: "exception", note: "Learner asked for an exception." }, await session("reviewer"))).json().error).toBe("FORBIDDEN");
    expect((await resolve(requestId, { outcome: "upheld", note: "Learner asked for an exception." }, await session("observer"))).json().error).toBe("FORBIDDEN");
    expect((await answer("min-predict", { answer: 12.6 })).json().result.passed).toBe(true);
    expect((await decision()).status).toBe("ready");
    expect((await resolve(requestId, { outcome: "exception", note: "Learner asked for an exception." })).json().error).toBe("GATE_ALREADY_READY");
    // A learner who is also workspace staff cannot decide their own request.
    const selfEnrollment = (await call(owner, "POST", "/api/enrollments", { releaseId: release })).json().id;
    const own = await decision(owner, selfEnrollment);
    const filed = await requestReview({ decisionId: own.decisionId, reason }, owner, selfEnrollment);
    expect(filed.statusCode, filed.body).toBe(200);
    expect((await resolve(filed.json().requestId, { outcome: "exception", note: "Granting myself an exception." }, owner)).json().error).toBe("SELF_REVIEW_FORBIDDEN");
  });
  it("at a reached cap staff can uphold but not except; after an extension the open request can be excepted", async () => {
    await answer("min-b", { answer: 4 });
    const setDeadline = async (offsetMs: number) => {
      const snapshot = (await db.query("SELECT snapshot FROM policy_states WHERE enrollment_id=$1", [enrollment])).rows[0].snapshot;
      snapshot.scopes[0].hardDeadline = { at: new Date(Date.now() + offsetMs).toISOString(), timeZone: "UTC", disambiguation: "reject" };
      await db.query("UPDATE policy_states SET snapshot=$2 WHERE enrollment_id=$1", [enrollment, JSON.stringify(snapshot)]);
    };
    await setDeadline(-1000);
    const closed = await decision();
    expect(closed.status).toBe("closed_with_gaps");
    expect(closed.nextActions.map((a: { kind: string }) => a.kind)).toContain("appeal");
    const filed = await requestReview({ decisionId: closed.decisionId, reason });
    expect(filed.statusCode, filed.body).toBe(200);
    const note = "Your course team will extend the deadline first.";
    expect((await resolve(filed.json().requestId, { outcome: "exception", note })).json().error).toBe("GATE_CAP_REACHED");
    expect((await db.query("SELECT state FROM gate_review_requests WHERE id=$1", [filed.json().requestId])).rows[0].state).toBe("open");
    // The limit moves (as an accepted extension would): the same open request can now be excepted.
    await setDeadline(30 * 86_400_000);
    const granted = await resolve(filed.json().requestId, { outcome: "exception", note });
    expect(granted.statusCode, granted.body).toBe(200);
    expect((await decision()).status).toBe("needs_evidence");
    const done = await complete();
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json().lessons.find((l: { id: string }) => l.id === "min")).toMatchObject({ status: "completed", exception: true });
  });
  it("refuses requests the gate's appeal policy does not cover: ready decisions, a closed window, unversioned gates", async () => {
    await makeReady();
    const ready = await decision();
    expect((await requestReview({ decisionId: ready.decisionId, reason })).json().error).toBe("GATE_DECISION_NOT_REVIEWABLE");
    // A needs-evidence outcome older than the 14-day window can no longer be reviewed.
    const fresh = await session("learner"), id = (await call(fresh, "POST", "/api/enrollments", { releaseId: release })).json().id;
    const old = await decision(fresh, id);
    await db.query("ALTER TABLE gate_decisions DISABLE TRIGGER gate_decisions_immutable");
    try { await db.query("UPDATE gate_decisions SET decided_at=now()-interval '15 days' WHERE id=$1", [old.decisionId]); }
    finally { await db.query("ALTER TABLE gate_decisions ENABLE TRIGGER gate_decisions_immutable"); }
    expect((await requestReview({ decisionId: old.decisionId, reason }, fresh, id)).json().error).toBe("GATE_REVIEW_WINDOW_CLOSED");
    // An unversioned 0.4 gate declares no appeal policy.
    const legacy = await publish(retentionCourse());
    expect(legacy.published.statusCode, legacy.published.body).toBe(200);
    const legacyEnrollment = (await call(learner, "POST", "/api/enrollments", { releaseId: legacy.id })).json().id;
    const legacyGate = (await view(learner, legacyEnrollment)).lessons.find((l: { gate: unknown }) => l.gate).gate;
    const filed = await call(learner, "POST", `/api/enrollments/${legacyEnrollment}/gates/${legacyGate.gateId}/review-requests`,
      { expectedRevision: (await view(learner, legacyEnrollment)).revision, idempotencyKey: randomUUID(), decisionId: randomUUID(), reason });
    expect(filed.json().error).toBe("GATE_REVIEW_NOT_OFFERED");
  }, 20000);
});
