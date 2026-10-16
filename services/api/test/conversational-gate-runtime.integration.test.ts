import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import type { ProviderAdapter, UsageReceipt } from "@course-core/providers";
import type { ProviderRequest } from "@course-core/supervisor";
import { checkGateDecision, type CourseManifest } from "@course-core/sdk";
import { createDatabase, type Database } from "../src/database.js";
import { createTestDatabase, type TestDatabase } from "./test-database.js";
import { createServer } from "../src/server.js";
import { issueLoginCode } from "../src/auth.js";
import { configureSupervisorBudget, createPostgresSupervisorBridge, type PostgresSupervisorBridge } from "../src/supervisor-bridge.js";
import { composeProviders } from "../src/provider-composition.js";
import { RUBRIC_EVALUATOR_ID, RUBRIC_EVALUATOR_INTEGRITY, RUBRIC_EVALUATOR_VERSION, reviewedRubricEvaluator, validateRubricAssessment } from "../src/rubric-evaluator.js";
import type { ConversationFindingsInput, RuntimeExtension } from "../src/publication.js";
import { gatedCourse, repairEvaluatorStub } from "./gated-fixture.js";
import { fixture } from "./fixture.js";
import { legacyGate } from "./legacy-gate.js";
import { allowUnpricedPaidWork } from "./cost-fixture.js";

// The conversational gate runtime (audit #11) on real PostgreSQL, the real supervisor bridge and
// provider gateway: the supervisor proposes quoted findings from the conversation turns, the host
// verifier checks every quote, and a human or an installed deterministic evaluator confirms.
// Only the model is scripted: these tests show the host's checks, never any model's quality.
const origin = "http://localhost:4398",
  schema = "conversational_runtime_" + randomUUID().replaceAll("-", ""),
  workspace = randomUUID(),
  token = randomUUID(),
  jobPolicy = { allowance: { microUsd: 100000, tokens: 200000 } };
let db: Database, app: Awaited<ReturnType<typeof createServer>>, bridge: PostgresSupervisorBridge, testDatabase: TestDatabase | undefined;
let owner: Session, instructor: Session, versions = 0;
interface Session { id: string; cookie: string; csrf: string }
interface Learner { session: Session; enrollment: string; catalog: string; course: CourseManifest }

const firstTurn = "I keep the smallest value seen so far and compare every next value with it. The kept value is never greater than any value already seen.";
const reply = "For example with 8, 2 and 5 my kept value goes 8, then 2, and it stays 2 because 5 is larger.";
const probeNote = "Can you walk through an example of your own, with numbers you choose?";
const INVARIANT = "The kept value is never greater than any value already seen";
const EXAMPLE = "my kept value goes 8, then 2";

/** What the scripted reviewer model returns for each request it sees. */
let draft: (input: { answer: string; earlierTurns?: { speaker: string; text: string }[] }) => unknown;
const seen: { answer: string; earlierTurns?: { speaker: string; text: string }[] }[] = [];
const usage: UsageReceipt = {
  accounting: { accountingKey: "synthetic" }, providerId: "test", modelId: "reviewer-model", operation: "assess",
  attempts: [{ attempt: 1, status: 200, outcome: "response", tokens: { input: 10, output: 20, total: 30, cachedInput: 0, thoughts: 0, toolInput: 0 } }],
  inputCharacters: 100, requestedMaxOutputTokens: 1000, requestedVideoSeconds: null, observedImageCount: null, observedVideoCount: null, cost: null,
};
const adapter: ProviderAdapter = { providerId: "test", validateModel() {}, ports: { structured_assessment: { async assess(req) {
  const input = JSON.parse(req.messages[0]!.text);
  seen.push(input);
  return { usage, output: draft(input) as never };
} } } };
const findings = (invariant: string, example: string) => ({ summary: "Drafted from the learner's words.", criteria: [
  { criterionId: "invariant", met: Boolean(invariant), quote: invariant, note: "" },
  { criterionId: "own-example", met: Boolean(example), quote: example, note: "" },
] });

/** A deterministic conversation evaluator for the tests: fixed text rules over the quoted spans
 * Core found in the learner's own turns. It stands in for a course's installed adapter; what a
 * real course's rules accept is that course's concern, not something these tests establish. */
const CHECK_ID = "public-fixed-explanation-check", CHECK_INTEGRITY = "sha256-" + "d".repeat(64);
const checked: ConversationFindingsInput[] = [];
function fixedCheck(): RuntimeExtension {
  return { id: CHECK_ID, version: "1.0.0", integrity: CHECK_INTEGRITY, capabilities: ["assessment.evaluate"], platforms: ["web"], rubricReady: true, validateRubricAssessment,
    confirmConversationFindings(input) {
      checked.push(input);
      return input.findings.map((f) => ({ criterionId: f.criterionId,
        confirmed: f.met && f.turnId !== null && (f.criterionId === "invariant" ? /never greater/.test(f.quote) : /\d.*\d/.test(f.quote)) }));
    } };
}
/** The versioned conversational gate, judged by the fixed check instead of a person. */
function deterministicCourse(version: string) {
  const c = gatedCourse(version, { conversation: true });
  c.extensions.push({ id: CHECK_ID, version: "1.0.0", integrity: CHECK_INTEGRITY, platforms: ["web"], execution: "server", entrypoint: "evaluators/fixed-check.json",
    capabilities: ["assessment.evaluate"], accessibility: { keyboard: true, reducedMotion: true, textAlternative: "Explanation checked by fixed rules." } });
  // Listed first, so the conversation of the gate is judged by it.
  c.evaluators!.unshift({ id: "fixed-check", version: "1.0.0", extensionId: CHECK_ID, method: "deterministic", itemTypes: ["trace"], rubricIds: ["explain-minimum"],
    humanConfirmation: "none", outputs: { uncertainty: true, provenance: true }, tests: { fixtureRef: "fixtures/fixed-check.json", acceptsValidVariants: true, rejectsMisconceptions: true } });
  return c;
}
/** A 0.4 gate judged in conversation: its evaluator definition names exactly one cited rubric. */
function legacyCourse(version: string) {
  const c = fixture();
  c.version = version;
  c.extensions.push({ id: RUBRIC_EVALUATOR_ID, version: RUBRIC_EVALUATOR_VERSION, integrity: RUBRIC_EVALUATOR_INTEGRITY, platforms: ["web"], execution: "server",
    entrypoint: "evaluators/reviewed-rubric-v1.json", capabilities: ["assessment.evaluate"],
    accessibility: { keyboard: true, reducedMotion: true, textAlternative: "Written explanation reviewed against a rubric." } });
  c.rubrics = [{ id: "explain-minimum", version: "1.0.0", title: "Explaining a running minimum", requiresCitedEvidence: true, uncertain: "pending_review", criteria: [
    { id: "invariant", description: "States that the kept value is never greater than any value already seen.", required: true, evidence: "cited_learner_span" },
    { id: "own-example", description: "Works through an example of their own.", required: true, evidence: "cited_learner_span" },
  ] }];
  c.evaluators = [{ id: "explanation-review", version: "1.0.0", extensionId: RUBRIC_EVALUATOR_ID, method: "human", itemTypes: ["rubric"], rubricIds: ["explain-minimum"],
    humanConfirmation: "required", outputs: { uncertainty: true, provenance: true }, tests: { fixtureRef: "fixtures/explanations.json", acceptsValidVariants: true, rejectsMisconceptions: true } }];
  legacyGate(c.gates[0]).conversationalEvaluatorId = "explanation-review";
  return c;
}

async function session(role: string): Promise<Session> {
  const id = randomUUID();
  await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [id, "runtime:" + id, role + " person"]);
  await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspace, id, role]);
  const r = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, id) } });
  return { id, cookie: r.cookies.map((c) => c.name + "=" + c.value).join("; "), csrf: r.json().csrfToken };
}
const call = (who: Session, method: "GET" | "POST", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { origin, cookie: who.cookie, "x-csrf-token": who.csrf }, ...(payload === undefined ? {} : { payload: payload as object }) });
async function enroll(course: CourseManifest, consent: boolean): Promise<Learner> {
  const release = (await call(owner, "POST", `/api/workspaces/${workspace}/releases`, course)).json().id;
  const published = await call(owner, "POST", `/api/releases/${release}/publish`);
  expect(published.statusCode, published.body).toBe(200);
  const learner = await session("learner");
  const enrollment = (await call(learner, "POST", "/api/enrollments", { releaseId: release })).json().id;
  await configureSupervisorBudget(db, { workspaceId: workspace, enrollmentId: enrollment }, { microUsd: 1000000, tokens: 2000000 });
  const catalog = (await call(owner, "GET", "/api/admin/session")).json().courses[0].id;
  const self: Learner = { session: learner, enrollment, catalog, course };
  expect((await send(self, "read", { episodeId: "min", blockId: "min-text" })).statusCode).toBe(200);
  if (consent) expect((await send(self, "review-assist", { granted: true })).json()).toMatchObject({ granted: true });
  return self;
}
async function send(who: Learner, action: string, body: Record<string, unknown>) {
  const revision = (await call(who.session, "GET", "/api/enrollments/" + who.enrollment)).json().revision;
  return call(who.session, "POST", `/api/enrollments/${who.enrollment}/${action}`, { expectedRevision: revision, idempotencyKey: randomUUID(), ...body });
}
const decision = async (who: Learner, gate = "min-gate") => (await call(who.session, "GET", `/api/enrollments/${who.enrollment}/gates/${gate}/decision`)).json().decision;
const queue = async (who: Learner) => (await call(instructor, "GET", `/api/admin/courses/${who.catalog}/rubric-reviews`)).json().pending
  .filter((p: { enrollmentId: string }) => p.enrollmentId === who.enrollment);
const evidenceCount = async (who: Learner) => (await db.query("SELECT count(*)::int AS n FROM evidence WHERE enrollment_id=$1 AND result ? 'reviewed'", [who.enrollment])).rows[0].n;
const transition = (command: unknown) => app.inject({ method: "POST", url: "/v1/supervisor/bridge", headers: { authorization: "Bearer " + token }, payload: { method: "transition", command } });
const requestFor = async (attemptId: string) => (await db.query("SELECT id,origin,requested_by,state FROM rubric_assist_requests WHERE attempt_id=$1 AND state<>'superseded'", [attemptId])).rows[0];
/** Runs the supervisor's proposal job through the real bridge: prepare, provider call, verify, apply. */
async function runProposal(requestId: string) {
  const event = (await db.query("SELECT activation_event_id FROM rubric_assist_requests WHERE id=$1", [requestId])).rows[0].activation_event_id;
  const outbox = (await bridge.claimOutboxEvent(event, randomUUID(), 30000))!;
  const [ref] = await bridge.prepareOutbox(outbox);
  await bridge.ackOutbox(outbox);
  const claim = await bridge.transition({ type: "claim", ref: ref!, checkpointId: "generate", ownerId: randomUUID(), availability: { status: "ready" } });
  const operation = claim.snapshot.operations[0]!;
  const request: ProviderRequest = { schemaVersion: 1, operationId: operation.id, job: claim.snapshot.specification.key, role: "reviewer",
    checkpoint: claim.snapshot.specification.checkpoints[0]!, fence: claim.snapshot.specification.fence };
  const r = await app.inject({ method: "POST", url: "/v1/operations", headers: { authorization: "Bearer " + token, "idempotency-key": operation.id }, payload: request });
  await bridge.transition({ type: "settle", ref: ref!, operationId: operation.id, ownerId: operation.ownerId, outcome: r.json() });
  const verified = (await transition({ type: "verify", ref })).json();
  const applied = verified.snapshot?.state === "ready" ? (await transition({ type: "apply", ref })).json() : undefined;
  return { outcome: r.json(), verified: verified.snapshot?.state ?? verified.error, applied: applied?.snapshot?.state ?? applied?.error };
}
async function explain(who: Learner, text = firstTurn) {
  const issued = await send(who, "challenges", { episodeId: "min", assessmentId: "gate-conversation:min-gate", mode: "independent" });
  expect(issued.statusCode, issued.body).toBe(200);
  const answered = await send(who, "answers", { challengeId: issued.json().challengeId, answer: text });
  expect(answered.statusCode, answered.body).toBe(200);
  return (await db.query("SELECT id FROM attempts WHERE enrollment_id=$1 AND assessment_id='gate-conversation:min-gate' ORDER BY submitted_at DESC LIMIT 1", [who.enrollment])).rows[0].id as string;
}
async function passFamily(who: Learner) {
  const issued = await send(who, "challenges", { episodeId: "min", assessmentId: "min-b", mode: "independent" });
  expect((await send(who, "answers", { challengeId: issued.json().challengeId, answer: 4 })).json().result.passed).toBe(true);
}
const review = (attemptId: string, body: Record<string, unknown>) =>
  call(instructor, "POST", `/api/admin/rubric-reviews/${attemptId}`, { idempotencyKey: "review-" + randomUUID(), ...body });

beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  const providers = composeProviders({
    registry: { revision: "runtime-test", models: [{ id: "reviewer-model", providerId: "test", remoteModel: "reviewer", providerConfig: {}, enabled: true,
      capabilities: ["structured_assessment"], tools: [], limits: { maxInputCharacters: 40000, maxOutputTokens: 2000 } }] },
    adapters: [{ id: "test", kind: "test", credentialEnv: "COURSE_PROVIDER_TEST_API_KEY" }],
    roles: { reviewer: { modelId: "reviewer-model", maxInputCharacters: 20000, maxOutputTokens: 1000 } },
  }, () => "synthetic", { test: () => adapter });
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false, installedExtensions: [reviewedRubricEvaluator(), repairEvaluatorStub(), fixedCheck()], providers,
    supervisor: { serviceToken: token, workspaceIds: [workspace], jobPolicy } });
  bridge = createPostgresSupervisorBridge(db, { workspaceIds: [workspace], jobPolicy });
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspace, "runtime", "Runtime"]);
  await allowUnpricedPaidWork(db, workspace);
  owner = await session("owner");
  instructor = await session("instructor");
  await configureSupervisorBudget(db, { workspaceId: workspace }, { microUsd: 10000000, tokens: 100000000 });
}, 30000);
afterAll(async () => {
  await app?.close();
  await db?.end();
  await testDatabase?.drop();
});

describe("the supervisor proposes quoted findings from the conversation turns", () => {
  it("proposes on its own when the learner opted in, reads the earlier turns, and still needs a person to confirm", async () => {
    const who = await enroll(gatedCourse(`7.0.${versions++}`, { conversation: true }), true);
    draft = () => findings(INVARIANT, "");
    const first = await explain(who);
    const proposal = await requestFor(first);
    expect(proposal).toMatchObject({ origin: "supervisor", requested_by: null, state: "requested" });
    expect((await queue(who))[0].assist).toMatchObject({ state: "requested", origin: "supervisor" });
    expect(await runProposal(proposal.id)).toMatchObject({ verified: "ready", applied: "applied" });
    expect(seen.at(-1)).toEqual({ question: expect.any(String), criteria: expect.any(Array), answer: firstTurn });
    // A verified proposal is a draft for the reviewer, nothing more: no evidence, no ready.
    expect((await queue(who))[0].assist).toMatchObject({ state: "suggested", origin: "supervisor", draft: { notAGrade: true }, automaticCheck: null });
    expect(await evidenceCount(who)).toBe(0);
    expect((await decision(who)).status).toBe("under_review");

    // The reviewer asks a neutral follow-up; the learner's reply gets its own proposal over the whole conversation.
    expect((await review(first, { decision: "needs_clarification", probeOnly: true, learnerNote: probeNote,
      criteria: [{ criterionId: "invariant", met: true, quote: INVARIANT }, { criterionId: "own-example", met: false }] })).statusCode).toBe(200);
    const replied = await send(who, `reviews/${first}/reply`, { answer: reply });
    expect(replied.statusCode, replied.body).toBe(200);
    const second = replied.json().attemptId, next = await requestFor(second);
    expect(next).toMatchObject({ origin: "supervisor" });
    // The model sees the earlier turns, labelled; quotes may come from any learner turn.
    draft = () => findings(INVARIANT, EXAMPLE);
    expect(await runProposal(next.id)).toMatchObject({ verified: "ready", applied: "applied" });
    expect(seen.at(-1)).toMatchObject({ answer: reply, earlierTurns: [{ speaker: "learner", text: firstTurn }, { speaker: "reviewer", text: probeNote }] });
    const [pending] = await queue(who);
    expect(pending.assist).toMatchObject({ state: "suggested", origin: "supervisor", draft: { criteria: [{ quote: INVARIANT }, { quote: EXAMPLE }] } });
    expect(await evidenceCount(who)).toBe(0);
    expect((await decision(who)).status).toBe("under_review");

    // The person confirms with the learner's own quotes; only now does the gate become ready.
    await passFamily(who);
    expect((await review(second, { decision: "met", suggestionId: pending.assist.draft.suggestionId,
      criteria: [{ criterionId: "invariant", met: true, quote: INVARIANT }, { criterionId: "own-example", met: true, quote: EXAMPLE }] })).statusCode).toBe(200);
    expect((await db.query("SELECT confirmation,reviewer_id FROM rubric_reviews WHERE attempt_id=$1", [second])).rows[0]).toEqual({ confirmation: "human", reviewer_id: instructor.id });
    expect((await decision(who)).status).toBe("ready");
  }, 60000);

  it("proposes nothing for a learner who has not opted in; a person still reviews the conversation", async () => {
    const who = await enroll(gatedCourse(`7.0.${versions++}`, { conversation: true }), false);
    const attempt = await explain(who);
    expect(await requestFor(attempt)).toBeUndefined();
    expect((await queue(who))[0].assist).toMatchObject({ state: "not_consented", origin: null });
    expect((await call(who.session, "GET", `/api/enrollments/${who.enrollment}/review-assist`)).json()).toMatchObject({ applies: true, granted: false });
  }, 30000);

  it("F05: a model impression without the learner's quotes never reaches a reviewer, a confirmer or a ready decision", async () => {
    const before = checked.length;
    const impression = () => ({ summary: "The learner clearly understands the running minimum.", criteria: [
      { criterionId: "invariant", met: true, quote: "", note: "Understands." }, { criterionId: "own-example", met: true, quote: "", note: "Understands." }] });
    const neverWritten = () => findings("The learner understands the running minimum well.", EXAMPLE);
    for (const scripted of [impression, neverWritten]) {
      const who = await enroll(deterministicCourse(`7.1.${versions++}`), true);
      await passFamily(who);
      draft = scripted;
      const attempt = await explain(who, firstTurn + " " + reply);
      const run = await runProposal((await requestFor(attempt)).id);
      expect(run.outcome.status).not.toBe("succeeded");
      expect(run.verified).not.toBe("ready");
      expect((await queue(who))[0].assist).toMatchObject({ draft: null, automaticCheck: null });
      expect(await evidenceCount(who)).toBe(0);
      expect((await db.query("SELECT count(*)::int AS n FROM rubric_reviews WHERE attempt_id=$1", [attempt])).rows[0].n).toBe(0);
      const record = await decision(who);
      expect(record.status).toBe("under_review");
      expect((await send(who, "complete", { episodeId: "min", gateDecisionId: record.decisionId })).json().error).toBe("GATE_NOT_READY");
    }
    // A reviewer's own question is not the learner's words either, even in the learner's conversation.
    const who = await enroll(deterministicCourse(`7.1.${versions++}`), true);
    draft = () => findings(INVARIANT, "");
    const first = await explain(who);
    await runProposal((await requestFor(first)).id);
    expect((await review(first, { decision: "needs_clarification", probeOnly: true, learnerNote: probeNote,
      criteria: [{ criterionId: "invariant", met: true, quote: INVARIANT }, { criterionId: "own-example", met: false }] })).statusCode).toBe(200);
    const second = (await send(who, `reviews/${first}/reply`, { answer: "I am not sure how to show it with numbers yet, sorry." })).json().attemptId;
    draft = () => findings(INVARIANT, "walk through an example of your own");
    expect((await runProposal((await requestFor(second)).id)).verified).not.toBe("ready");
    expect(await evidenceCount(who)).toBe(0);
    // The fixed check was never asked: no verified proposal met every required criterion with learner quotes.
    expect(checked.length).toBe(before);
    expect((await decision(who)).status).toBe("under_review");
  }, 90000);
});

describe("deterministic confirmation of a verified proposal", () => {
  it("records quoted evidence when the installed fixed check confirms every met finding, and says so to the learner", async () => {
    const who = await enroll(deterministicCourse(`7.2.${versions++}`), true);
    await passFamily(who);
    draft = () => findings(INVARIANT, EXAMPLE);
    const attempt = await explain(who, firstTurn + " " + reply);
    expect(await runProposal((await requestFor(attempt)).id)).toMatchObject({ verified: "ready", applied: "applied" });
    expect(checked.at(-1)).toMatchObject({ rubric: { id: "explain-minimum", version: "1.0.0" }, learnerTurns: [{ turnId: attempt }],
      findings: [{ criterionId: "invariant", met: true, quote: INVARIANT, turnId: attempt }, { criterionId: "own-example", met: true, quote: EXAMPLE, turnId: attempt }] });
    const confirmation = (await db.query("SELECT decision,reviewer_id,confirmation,confirmer,suggestion_id FROM rubric_reviews WHERE attempt_id=$1", [attempt])).rows[0];
    expect(confirmation).toMatchObject({ decision: "met", reviewer_id: null, confirmation: "deterministic",
      confirmer: { evaluatorId: "fixed-check", evaluatorVersion: "1.0.0", extensionId: CHECK_ID, extensionVersion: "1.0.0", integrity: CHECK_INTEGRITY } });
    expect(confirmation.suggestion_id).toEqual(expect.any(String));
    const evidence = (await db.query("SELECT result,independent FROM evidence WHERE attempt_id=$1", [attempt])).rows[0];
    expect(evidence).toMatchObject({ independent: true, result: { passed: true, reviewed: true, confirmation: "deterministic",
      conversation: { gateId: "min-gate", rubricId: "explain-minimum", rubricVersion: "1.0.0" },
      citedSpans: [{ turnId: attempt, quote: INVARIANT }, { turnId: attempt, quote: EXAMPLE }] } });
    // Nothing waits for a person any more, and the gate is ready without a redundant quiz.
    expect(await queue(who)).toEqual([]);
    const ready = await decision(who);
    expect(ready.status).toBe("ready");
    expect(checkGateDecision(who.course, JSON.parse(JSON.stringify(ready).replace(/"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/g, '"core-$1"'))).valid).toBe(true);
    const reviews = (await call(who.session, "GET", `/api/enrollments/${who.enrollment}/reviews`)).json().reviews;
    expect(reviews[0]).toMatchObject({ attemptId: attempt, status: "met", confirmedBy: "automatic_check", canAppeal: true });
    expect((await send(who, "complete", { episodeId: "min", gateDecisionId: ready.decisionId })).statusCode).toBe(200);
  }, 60000);

  it("leaves the answer to a person, with the reason, when the fixed check declines or the proposal is short of the rubric", async () => {
    const who = await enroll(deterministicCourse(`7.3.${versions++}`), true);
    // Verbatim learner words, but not what the fixed rules accept for the example criterion.
    draft = () => findings(INVARIANT, "compare every next value with it");
    const attempt = await explain(who);
    expect(await runProposal((await requestFor(attempt)).id)).toMatchObject({ verified: "ready", applied: "applied" });
    const [pending] = await queue(who);
    expect(pending.assist).toMatchObject({ state: "suggested", automaticCheck: { state: "evaluator_declined", evaluatorId: "fixed-check",
      criteria: [{ criterionId: "invariant", confirmed: true }, { criterionId: "own-example", confirmed: false }] } });
    expect(await evidenceCount(who)).toBe(0);
    expect((await decision(who)).status).toBe("under_review");
    // A proposal that does not meet every required criterion is never confirmed as "not met" either: it waits.
    const other = await enroll(deterministicCourse(`7.3.${versions++}`), true);
    draft = () => findings(INVARIANT, "");
    const short = await explain(other);
    await runProposal((await requestFor(short)).id);
    expect((await queue(other))[0].assist.automaticCheck).toMatchObject({ state: "proposal_not_met" });
    expect((await db.query("SELECT count(*)::int AS n FROM rubric_reviews WHERE attempt_id=$1", [short])).rows[0].n).toBe(0);
    // The person can still decide, under the usual quoting rules.
    expect((await review(attempt, { decision: "not_met", criteria: [{ criterionId: "invariant", met: true, quote: INVARIANT }, { criterionId: "own-example", met: false }] })).statusCode).toBe(200);
    expect((await decision(who)).status).toBe("needs_evidence");
  }, 60000);

  it("refuses a system activation for a request staff made, and a staff activation for the supervisor's", async () => {
    const who = await enroll(deterministicCourse(`7.4.${versions++}`), true);
    draft = () => findings(INVARIANT, "");
    const attempt = await explain(who);
    const request = await requestFor(attempt);
    await db.query("UPDATE learning_events SET actor_kind='staff' WHERE id=(SELECT activation_event_id FROM rubric_assist_requests WHERE id=$1)", [request.id]);
    const event = (await db.query("SELECT activation_event_id FROM rubric_assist_requests WHERE id=$1", [request.id])).rows[0].activation_event_id;
    const outbox = (await bridge.claimOutboxEvent(event, randomUUID(), 30000))!;
    // A permanent conflict consumes the event with its code: no job is ever prepared for it.
    expect(await bridge.prepareOutbox(outbox)).toEqual([]);
    expect((await db.query("SELECT disposition,reason_code FROM supervisor_preparations WHERE event_id=$1", [event])).rows[0]).toEqual({ disposition: "refused", reason_code: "RUBRIC_ASSIST_NOT_ACTIVATED" });
    expect((await db.query("SELECT job_id FROM rubric_assist_requests WHERE id=$1", [request.id])).rows[0].job_id).toBeNull();
  }, 30000);
});

describe("an unversioned 0.4 gate judged in conversation (conversationalEvaluatorId)", () => {
  it("publishes, offers the explanation, counts it as one family once a person confirms quotes, and lets the learner advance", async () => {
    const who = await enroll(legacyCourse(`7.5.${versions++}`), false);
    const open = await decision(who);
    expect(open.status).toBe("needs_evidence");
    expect(open.nextActions).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "attempt_check", targetId: "gate-conversation:min-gate",
      label: "Explain your reasoning in your own words for review against “Explaining a running minimum”" })]));
    const attempt = await explain(who, firstTurn + " " + reply);
    expect((await decision(who)).status).toBe("under_review");
    const [pending] = await queue(who);
    expect(pending).toMatchObject({ assessmentId: "gate-conversation:min-gate", conversationGateId: "min-gate" });
    // An impression is refused; the person must quote the learner.
    expect((await review(attempt, { decision: "met", criteria: [{ criterionId: "invariant", met: true }, { criterionId: "own-example", met: true, quote: EXAMPLE }] })).json().error).toBe("RUBRIC_QUOTE_REQUIRED");
    expect((await review(attempt, { decision: "met", criteria: [{ criterionId: "invariant", met: true, quote: INVARIANT }, { criterionId: "own-example", met: true, quote: EXAMPLE }] })).statusCode).toBe(200);
    // One family (the conversation) of the two the 0.4 gate needs.
    const one = await decision(who);
    expect(one.status).toBe("needs_evidence");
    expect(one.criterionResults).toEqual([expect.objectContaining({ criterionId: "independent_families:minimum", met: false, reason: expect.stringMatching(/\(1 so far\)/) })]);
    expect((await send(who, "complete", { episodeId: "min", gateDecisionId: one.decisionId })).statusCode).toBe(409);
    await passFamily(who);
    const ready = await decision(who);
    expect(ready).toMatchObject({ status: "ready", gateVersion: "legacy-0.4" });
    expect(ready.criterionResults[0]).toMatchObject({ met: true, evidenceRefs: expect.arrayContaining([expect.any(String), expect.any(String)]) });
    expect((await send(who, "complete", { episodeId: "min", gateDecisionId: ready.decisionId })).statusCode).toBe(200);
  }, 60000);

  it("refuses a reply that reproduces the companion's words: a conversation turn can be quoted as evidence", async () => {
    const who = await enroll(legacyCourse(`7.7.${versions++}`), false);
    const companion = "The kept value never exceeds any value seen so far because each comparison keeps the smaller one.";
    await db.query("INSERT INTO companion_messages(id,enrollment_id,role,content,context) VALUES($1,$2,'assistant',$3,'{}')", [randomUUID(), who.enrollment, companion]);
    const attempt = await explain(who);
    expect((await review(attempt, { decision: "needs_clarification", probeOnly: true, learnerNote: probeNote,
      criteria: [{ criterionId: "invariant", met: true, quote: INVARIANT }, { criterionId: "own-example", met: false }] })).statusCode).toBe(200);
    const copied = await send(who, `reviews/${attempt}/reply`, { answer: "Here is why. " + companion });
    expect(copied.statusCode).toBe(409);
    expect(copied.json().error).toBe("AGENT_AUTHORED_ANSWER");
    expect((await send(who, `reviews/${attempt}/reply`, { answer: reply })).statusCode).toBe(200);
  }, 30000);

  it("does not count a conversation whose findings quote no learner words, even if a row claims to be reviewed", async () => {
    const who = await enroll(legacyCourse(`7.6.${versions++}`), false);
    await passFamily(who);
    const attempt = await explain(who);
    // A forged row without cited spans (no server path writes one) is still not conversation evidence.
    await db.query(`INSERT INTO evidence (id,enrollment_id,attempt_id,objective_id,evaluator_ref,result,independent)
      VALUES ($1,$2,$3,'minimum','reviewed-rubric@1',$4,true)`, [randomUUID(), who.enrollment, attempt,
      JSON.stringify({ passed: true, reviewed: true, conversation: { gateId: "min-gate", rubricId: "explain-minimum", rubricVersion: "1.0.0" } })]);
    const record = await decision(who);
    expect(record.status).toBe("under_review");
    expect(record.criterionResults[0]).toMatchObject({ met: "pending", reason: expect.stringMatching(/\(1 so far\)/) });
  }, 30000);
});
