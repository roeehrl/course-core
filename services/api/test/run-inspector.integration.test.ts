import { randomUUID, randomBytes } from "node:crypto";
import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import { createDatabase, type Database } from "../src/database.js";
import { createTestDatabase, type TestDatabase } from "./test-database.js";
import { createServer } from "../src/server.js";
import { issueLoginCode } from "../src/auth.js";
import { digestJson } from "../src/repository.js";
import { sandboxed } from "../src/run-inspector.js";
import { fixture } from "./fixture.js";
import { recordSyntheticRun } from "./run-fixture.js";

// Real HTTP and PostgreSQL 17: the debug inspector's workflow, policy/budget and client/sync
// views, the audited run.payload reveal (U13) and the sandboxed replay (U15).
const origin = "http://localhost:4397",
  schema = "run_inspector_" + randomUUID().replaceAll("-", "");
let db: Database, app: Awaited<ReturnType<typeof createServer>>;
interface Session { userId: string; cookie: string; csrf: string }
let workspace: string, owner: Session, admin: Session, instructor: Session, reviewer: Session, observer: Session, learner: Session;
let catalog: string, release: string, enrollment: string;
const credential = randomBytes(24).toString("base64url");
const CANARIES = ["LEARNER_MODEL_CANARY", "HYPOTHESIS_TEXT_CANARY", "PROVIDER_CANDIDATE_CANARY", "COMPANION_REPLY_CANARY", "PRIVATE_REASONING_CANARY", credential];

async function person(role: string): Promise<Session> {
  const id = randomUUID();
  await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [id, "ri:" + id, role + " person"]);
  await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspace, id, role]);
  const r = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, id) } });
  return { userId: id, cookie: r.cookies.map((c) => c.name + "=" + c.value).join("; "), csrf: r.json().csrfToken };
}
const call = (who: Session, method: "GET" | "POST", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { origin, cookie: who.cookie, "x-csrf-token": who.csrf }, ...(payload === undefined ? {} : { payload: payload as object }) });
const runPath = (runId: string) => `/api/admin/courses/${catalog}/runs/${runId}`;

const recordRun = (options: { role?: "supervisor" | "companion"; tamper?: boolean; resource?: boolean } = {}) =>
  recordSyntheticRun(db, { workspaceId: workspace, enrollmentId: enrollment, releaseId: release, learnerId: learner.userId, credential, ...options });
const counts = async () => Object.fromEntries(await Promise.all(["supervisor_jobs", "supervisor_tool_calls", "supervisor_artifacts", "provider_dispatches", "supervisor_job_spend", "episode_progress", "evidence", "outbox"]
  .map(async (t) => [t, (await db.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n])));

let testDatabase: TestDatabase | undefined;
beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false });
}, 30000);
beforeEach(async () => {
  workspace = randomUUID();
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspace, "ri-" + workspace, "Run inspector"]);
  owner = await person("owner");
  admin = await person("admin");
  instructor = await person("instructor");
  reviewer = await person("reviewer");
  observer = await person("observer");
  learner = await person("learner");
  release = (await call(owner, "POST", `/api/workspaces/${workspace}/releases`, fixture())).json().id;
  expect((await call(owner, "POST", `/api/releases/${release}/publish`)).statusCode).toBe(200);
  catalog = (await call(owner, "GET", "/api/admin/session")).json().courses[0].id;
  enrollment = (await call(learner, "POST", "/api/enrollments", { releaseId: release })).json().id;
});
afterAll(async () => {
  await app?.close();
  await db?.end();
  await testDatabase?.drop();
});

describe("run inspector views", () => {
  it("adds the workflow graph, policies and budgets, and client and sync state without any payload", async () => {
    const { jobId, calls } = await recordRun();
    const view = await call(instructor, "GET", `${runPath(jobId)}?payload=true&reveal=1`);
    expect(view.statusCode, view.body).toBe(200);
    const body = view.json();
    expect(body.payload).toBe("withheld");
    const kinds = body.workflow.nodes.map((n: { kind: string }) => n.kind);
    expect(kinds).toEqual(["input_event", "run", "checkpoint", "operation", "tool_call", "tool_call", "tool_call", "tool_call", "artifact"]);
    // Facts only (IDs, codes, counts): the admin app words each node, so no English leaves the server.
    expect(body.workflow.nodes.find((n: { kind: string }) => n.kind === "operation")).toMatchObject({ facts: { attempt: 1, providerState: "completed" } });
    expect(body.workflow.nodes.filter((n: { kind: string }) => n.kind === "tool_call").map((n: { facts: unknown }) => n.facts)).toEqual(calls.map((c) => ({ step: c.step, tool: c.tool })));
    expect(body.workflow.nodes.every((n: object) => !("label" in n))).toBe(true);
    expect(body.policies).toMatchObject({ jobBudget: { microUsd: 900, tokens: 800 }, charged: { microUsd: 300, tokens: 120 },
      operations: [{ reservation: { microUsd: 900, tokens: 800 }, usage: { microUsd: 300, tokens: 120 } }],
      enrollmentBudget: { limit: { microUsd: 5000, tokens: 4000 }, used: { microUsd: 300 }, daily: { microUsd: 2000, tokens: null } }, supervision: { state: "active" } });
    expect(body.policies.fence.enrollmentRevisionNow).toBeGreaterThan(0);
    expect(body.sync).toMatchObject({ inputEvent: { platform: "web", appVersion: "1.4.2", clientSequence: "17" }, eventsSince: 0, enrollmentRevisionAtRun: body.policies.fence.enrollmentRevision });
    expect(body.sync.inputEvent.clockSkewMs).toBeGreaterThanOrEqual(1000);
    for (const canary of [...CANARIES, "chain_of_thought", "api_key", "Offer the number-line"]) expect(view.body).not.toContain(canary);
  });
});

describe("run.payload reveal (U13)", () => {
  it("is refused to every role without run.payload, whatever the request says", async () => {
    const { jobId } = await recordRun();
    for (const who of [instructor, reviewer, observer, learner]) {
      const refused = await call(who, "POST", `${runPath(jobId)}/payload`, { reason: "quality_review" });
      expect(refused.statusCode).toBe(403);
      for (const canary of ["Offer the number-line", ...CANARIES]) expect(refused.body).not.toContain(canary);
    }
    expect((await call(owner, "POST", `${runPath(jobId)}/payload`, {})).statusCode).toBe(400);
    expect((await call(owner, "POST", `${runPath(jobId)}/payload`, { reason: "curiosity" })).statusCode).toBe(400);
    expect((await call(owner, "POST", `${runPath(jobId)}/payload`, { reason: "quality_review", scope: "everything" })).statusCode).toBe(400);
    expect((await call(owner, "POST", `${runPath(randomUUID())}/payload`, { reason: "quality_review" })).statusCode).toBe(404);
    expect((await db.query("SELECT count(*)::int AS n FROM learning_events WHERE event_type='run.payload_revealed' AND workspace_id=$1", [workspace])).rows[0].n).toBe(0);
  });

  it("reveals allowlisted payload to owners and admins with an audit receipt, never what the privacy rule withholds", async () => {
    const { jobId, calls } = await recordRun();
    const revealed = await call(admin, "POST", `${runPath(jobId)}/payload`, { reason: "incident_investigation" });
    expect(revealed.statusCode, revealed.body).toBe(200);
    expect(revealed.headers["cache-control"]).toBe("no-store");
    const body = revealed.json();
    expect(body.payload.inputs[0].context).toEqual({ kind: "learning_event", eventId: expect.any(String), eventType: "episode.help_requested", courseReleaseId: release, episodeId: "min" });
    const byTool = Object.fromEntries(body.payload.toolCalls.map((t: { tool: string }) => [t.tool, t]));
    expect(byTool.choose_support).toMatchObject({ withheld: false, arguments: { profileId: "ordering-support", entryId: "number-line" }, result: { selected: true } });
    expect(byTool.get_profile).toMatchObject({ withheld: true, arguments: null, result: null });
    expect(byTool.propose_hypothesis).toMatchObject({ withheld: true, arguments: null });
    expect(body.payload.artifacts[0]).toMatchObject({ kind: "supervised_plan", withheld: false, content: {
      summary: { withheld: "model_text", length: "Offer the number-line walkthrough before the next check.".length, fingerprint: expect.stringMatching(/^[0-9a-f]{16}$/) },
      selection: { profileId: "ordering-support", entryId: "number-line" }, toolCallRefs: calls.map((c) => c.id) } });
    expect(revealed.body).not.toContain("Offer the number-line");
    expect(body.withheld).toEqual(expect.arrayContaining([{ ref: `tool:${calls[1]!.id}`, category: "learner-model" }, { ref: `tool:${calls[2]!.id}`, category: "hypothesis-tool-text" }]));
    expect(body.rule.withheld).toEqual(["companion", "learner-model", "hypothesis-tool-text", "model-text"]);
    for (const canary of [...CANARIES, "chain_of_thought", "api_key"]) expect(revealed.body).not.toContain(canary);

    // The receipt is on the learner's record and in the workspace audit log.
    const receipt = (await db.query("SELECT enrollment_id,actor_id,actor_kind,payload FROM learning_events WHERE event_type='run.payload_revealed' AND workspace_id=$1", [workspace])).rows;
    expect(receipt).toEqual([{ enrollment_id: enrollment, actor_id: admin.userId, actor_kind: "staff",
      payload: { receiptId: body.receipt.id, catalogId: catalog, runId: jobId, reason: "incident_investigation", payloadDigest: digestJson(body.payload), withheld: ["learner-model", "hypothesis-tool-text"] } }]);
    const audit = (await call(owner, "GET", `/api/admin/workspaces/${workspace}/audit?type=run.payload_revealed`)).json().events;
    expect(audit[0]).toMatchObject({ actor: "admin person", payloadWithheld: false, payload: { runId: jobId, reason: "incident_investigation" } });
    const copy = (await call(owner, "GET", `/api/admin/workspaces/${workspace}/audit?type=run.payload_reveal_audited`)).json().events;
    expect(copy).toEqual([expect.objectContaining({ enrollmentId: null, actor: "admin person",
      payload: { receiptId: body.receipt.id, catalogId: catalog, runId: jobId, enrollmentId: enrollment, reason: "incident_investigation", payloadDigest: body.receipt.payloadDigest } })]);
  });

  it("withholds a companion run's reply as part of the private conversation", async () => {
    const { jobId } = await recordRun({ role: "companion" });
    const revealed = await call(owner, "POST", `${runPath(jobId)}/payload`, { reason: "bug_report" });
    expect(revealed.statusCode).toBe(200);
    expect(revealed.json().payload.artifacts[0]).toMatchObject({ kind: "companion_message", content: null, sha256: null, withheld: true });
    expect(revealed.body).not.toContain(digestJson({ kind: "companion_message", text: "COMPANION_REPLY_CANARY" }));
    expect(revealed.json().withheld).toEqual([{ ref: expect.stringMatching(/^artifact:/), category: "companion" }]);
    expect(revealed.body).not.toContain("COMPANION_REPLY_CANARY");
  });

  it("reveals nothing when the receipt cannot be written", async () => {
    const { jobId } = await recordRun();
    await db.query(`CREATE FUNCTION refuse_reveal_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'RECEIPT_UNAVAILABLE'; END $$`);
    await db.query(`CREATE TRIGGER refuse_reveal_receipt BEFORE INSERT ON learning_events FOR EACH ROW WHEN (NEW.event_type='run.payload_revealed') EXECUTE FUNCTION refuse_reveal_receipt()`);
    try {
      const failed = await call(owner, "POST", `${runPath(jobId)}/payload`, { reason: "quality_review" });
      expect(failed.statusCode).toBe(500);
      expect(failed.body).not.toContain("Offer the number-line");
      expect(failed.body).not.toContain("ordering-support");
    } finally {
      await db.query("DROP TRIGGER refuse_reveal_receipt ON learning_events");
      await db.query("DROP FUNCTION refuse_reveal_receipt()");
    }
  });
});

describe("sandboxed replay (U15)", () => {
  it("replays frozen inputs with stubbed tools under a new run id, writes nothing but its receipt, and matches the stored plan", async () => {
    const { jobId, calls } = await recordRun();
    const before = await counts();
    const revision = (await db.query("SELECT revision FROM enrollments WHERE id=$1", [enrollment])).rows[0].revision;
    const replay = await call(instructor, "POST", `${runPath(jobId)}/replay`);
    expect(replay.statusCode, replay.body).toBe(200);
    const body = replay.json();
    expect(body).toMatchObject({ sourceRunId: jobId, outcome: "matches", reason: null, sideEffects: "stubbed", progressWrites: "denied", providerCalls: 0 });
    expect(body.replayRunId).not.toBe(jobId);
    expect(body.steps.map((s: { tool: string; recordedReceiptId: string }) => [s.tool, s.recordedReceiptId])).toEqual(calls.map((c) => [c.tool, c.id]));
    expect(body.replayedPlanDigest).toBe(body.recordedPlanDigest);
    // Withheld tools carry no digests; the others are keyed per replay, so no guess can be tested.
    for (const step of body.steps)
      if (["get_profile", "propose_hypothesis"].includes(step.tool)) expect(step).toMatchObject({ argumentsDigest: null, resultDigest: null });
      else expect(step.resultDigest).toMatch(/^[0-9a-f]{64}$/);
    const choose = calls.find((c) => c.tool === "choose_support")!;
    expect(body.steps.find((s: { tool: string }) => s.tool === "choose_support").resultDigest).not.toBe(digestJson(choose.outcome.result));
    for (const canary of [...CANARIES, "Offer the number-line"]) expect(replay.body).not.toContain(canary);
    expect(await counts()).toEqual(before);
    expect((await db.query("SELECT revision FROM enrollments WHERE id=$1", [enrollment])).rows[0].revision).toBe(revision);
    const receipt = (await db.query("SELECT enrollment_id,actor_id,payload FROM learning_events WHERE event_type='run.replayed' AND workspace_id=$1", [workspace])).rows;
    expect(receipt).toEqual([{ enrollment_id: null, actor_id: instructor.userId, payload: expect.objectContaining({ runId: jobId, replayRunId: body.replayRunId, outcome: "matches" }) }]);
    // Each replay is a new run id.
    expect((await call(instructor, "POST", `${runPath(jobId)}/replay`)).json().replayRunId).not.toBe(body.replayRunId);
  });

  it("replays a plan with a chosen reviewed resource to the same plan, and a changed choice diverges", async () => {
    const { jobId } = await recordRun({ resource: true });
    const replay = await call(instructor, "POST", `${runPath(jobId)}/replay`);
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toMatchObject({ outcome: "matches", reason: null, providerCalls: 0 });
    expect(replay.json().steps.map((s: { tool: string }) => s.tool)).toContain("choose_resource");
    await db.query("UPDATE supervisor_tool_calls SET outcome=jsonb_set(outcome,'{resourceChoice,candidateDigest}',to_jsonb(repeat('f',64))) WHERE job_id=$1 AND tool='choose_resource'", [jobId]);
    expect((await call(instructor, "POST", `${runPath(jobId)}/replay`)).json()).toMatchObject({ outcome: "diverged", reason: "plan_differs" });
  });

  it("reports divergence and runs that cannot be replayed, and is closed to roles without run.inspect", async () => {
    const tampered = await recordRun({ tamper: true });
    expect((await call(owner, "POST", `${runPath(tampered.jobId)}/replay`)).json()).toMatchObject({ outcome: "diverged", reason: "plan_differs" });
    const companion = await recordRun({ role: "companion" });
    expect((await call(owner, "POST", `${runPath(companion.jobId)}/replay`)).json()).toMatchObject({ outcome: "not_replayable", reason: "no_recorded_plan" });
    // A recorded call that no longer matches its step is a divergence, not a live call.
    const moved = await recordRun();
    await db.query("UPDATE supervisor_tool_calls SET step=5 WHERE job_id=$1 AND tool='choose_support'", [moved.jobId]);
    expect((await call(owner, "POST", `${runPath(moved.jobId)}/replay`)).json()).toMatchObject({ outcome: "diverged", reason: "tool_call_diverged" });
    await db.query("UPDATE supervisor_tool_calls SET step=3,outcome=jsonb_set(outcome,'{selection,entryId}','\"changed\"') WHERE job_id=$1 AND tool='choose_support'", [moved.jobId]);
    expect((await call(owner, "POST", `${runPath(moved.jobId)}/replay`)).json()).toMatchObject({ outcome: "diverged", reason: "plan_differs" });
    await db.query("UPDATE supervisor_artifacts SET content=content || '{\"summary\":\"edited\"}' WHERE job_id=$1", [moved.jobId]);
    expect((await call(owner, "POST", `${runPath(moved.jobId)}/replay`)).json()).toMatchObject({ outcome: "not_replayable", reason: "recorded_plan_integrity" });
    for (const who of [observer, learner]) expect((await call(who, "POST", `${runPath(tampered.jobId)}/replay`)).statusCode).toBe(403);
  });

  it("runs inside a transaction where PostgreSQL refuses every write", async () => {
    const revision = (await db.query("SELECT revision FROM enrollments WHERE id=$1", [enrollment])).rows[0].revision;
    await expect(sandboxed(db, (client) => client.query("UPDATE enrollments SET revision=revision+1 WHERE id=$1", [enrollment]))).rejects.toMatchObject({ code: "25006" });
    await expect(sandboxed(db, (client) => client.query("INSERT INTO outbox(event_id,kind,payload) VALUES($1,'supervisor.event','{}')", [randomUUID()]))).rejects.toMatchObject({ code: "25006" });
    expect((await db.query("SELECT revision FROM enrollments WHERE id=$1", [enrollment])).rows[0].revision).toBe(revision);
  });
});

describe("inspector entry from the learner's activity", () => {
  it("lists an enrollment's runs for one episode to roles with run.inspect only", async () => {
    const { jobId } = await recordRun();
    const listed = await call(instructor, "GET", `/api/admin/enrollments/${enrollment}/runs?episodeId=min`);
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json()).toEqual({ courseId: catalog, runs: [{ id: jobId, role: "supervisor", status: "ready", startedAt: expect.any(String), episodeId: "min", blockId: null }] });
    expect((await call(instructor, "GET", `/api/admin/enrollments/${enrollment}/runs?episodeId=max`)).json().runs).toEqual([]);
    expect((await call(observer, "GET", `/api/admin/enrollments/${enrollment}/runs`)).statusCode).toBe(403);
    expect((await call(learner, "GET", `/api/admin/enrollments/${enrollment}/runs`)).statusCode).toBe(403);
  });
});

// Regression cases from the independent privacy review of the reveal.
describe("reveal privacy regressions", () => {
  async function plantModelText(jobId: string) {
    const plan = (await db.query("SELECT content FROM supervisor_artifacts WHERE job_id=$1", [jobId])).rows[0].content;
    plan.summary = "Learner asked the companion: 'COMPANION_QUESTION_CANARY I feel stupid'. Profile says LEARNER_MODEL_ECHO. Reasoning: they likely confuse min/max.";
    await db.query("UPDATE supervisor_artifacts SET content=$2,digest=$3 WHERE job_id=$1", [jobId, JSON.stringify(plan), digestJson(plan)]);
    await db.query(`INSERT INTO supervisor_tool_calls(id,job_id,enrollment_id,workspace_id,operation_id,step,tool,request_digest,arguments,outcome)
      SELECT $2,job_id,enrollment_id,workspace_id,operation_id,7,'create_teaching',$3,$4,$5 FROM supervisor_tool_calls WHERE job_id=$1 LIMIT 1`,
      [jobId, randomUUID(), "c".repeat(64), JSON.stringify({ profileId: "p", kind: "episode", title: "TITLE_CANARY", markdown: "You said COMPANION_QUESTION_CANARY2",
        blocks: [{ type: "text", markdown: "BLOCK_CANARY one" }, { type: "text", markdown: "BLOCK_CANARY two" }], objectiveIds: ["minimum"], sourceRefs: [] }),
        JSON.stringify({ result: { available: true, rationale: "RATIONALE_CANARY", thinking: "THINKING_CANARY", thought: "THOUGHT_CANARY", analysis: "ANALYSIS_CANARY" } })]);
    await db.query(`INSERT INTO supervisor_tool_calls(id,job_id,enrollment_id,workspace_id,operation_id,step,tool,request_digest,arguments,outcome)
      SELECT $2,job_id,enrollment_id,workspace_id,operation_id,6,'get_evidence',$3,'{}',$4 FROM supervisor_tool_calls WHERE job_id=$1 LIMIT 1`,
      [jobId, randomUUID(), "d".repeat(64), JSON.stringify({ result: { available: true, attempts: [{ attemptId: randomUUID(), excludedFromAiContext: true }] } })]);
  }

  it("A: never returns model-written text or unlisted keys; shows only structure, length and a per-reveal fingerprint", async () => {
    const { jobId } = await recordRun();
    await plantModelText(jobId);
    const r = await call(owner, "POST", `${runPath(jobId)}/payload`, { reason: "quality_review" });
    expect(r.statusCode, r.body).toBe(200);
    for (const canary of ["COMPANION_QUESTION_CANARY", "LEARNER_MODEL_ECHO", "I feel stupid", "TITLE_CANARY", "BLOCK_CANARY", "RATIONALE_CANARY", "THINKING_CANARY",
      "THOUGHT_CANARY", "ANALYSIS_CANARY", "excludedFromAiContext"]) expect(r.body).not.toContain(canary);
    const teaching = r.json().payload.toolCalls.find((t: { tool: string }) => t.tool === "create_teaching");
    expect(teaching.arguments).toMatchObject({ profileId: "p", kind: "episode", title: { withheld: "model_text", length: 12 },
      blocks: [{ type: "text", markdown: { withheld: "model_text", length: 16 } }, { type: "text", markdown: { withheld: "model_text" } }] });
    expect(teaching.result).toEqual({ available: true, omittedKeys: 4 });
    // Fingerprints change with every reveal, so they cannot be compared with a guess.
    const again = await call(owner, "POST", `${runPath(jobId)}/payload`, { reason: "quality_review" });
    const fp = (x: { json(): { payload: { artifacts: { content: { summary: { fingerprint: string } } }[] } } }) => x.json().payload.artifacts[0]!.content.summary.fingerprint;
    expect(fp(again)).not.toBe(fp(r));
  });

  it("B: replay steps of withheld tools are no oracle for their content", async () => {
    const { jobId, calls } = await recordRun();
    const r = await call(reviewer, "POST", `${runPath(jobId)}/replay`);
    expect(r.statusCode).toBe(200);
    const profile = r.json().steps.find((s: { tool: string }) => s.tool === "get_profile");
    expect(profile).toMatchObject({ argumentsDigest: null, resultDigest: null });
    expect(r.body).not.toContain(digestJson({ available: true, preferences: "LEARNER_MODEL_CANARY" }));
    expect(r.body).not.toContain(digestJson(calls[2]!.arguments));
  });

  it("C: a withheld companion artifact's digest is not revealed", async () => {
    const { jobId } = await recordRun({ role: "companion" });
    const r = await call(owner, "POST", `${runPath(jobId)}/payload`, { reason: "quality_review" });
    expect(r.json().payload.artifacts[0].sha256).toBeNull();
  });

  it("evidence reads are withheld as learner-model, since they show AI-context exclusions", async () => {
    const { jobId } = await recordRun();
    await plantModelText(jobId);
    const r = (await call(owner, "POST", `${runPath(jobId)}/payload`, { reason: "quality_review" })).json();
    const evidence = r.payload.toolCalls.find((t: { tool: string }) => t.tool === "get_evidence");
    expect(evidence).toMatchObject({ withheld: true, arguments: null, result: null });
    expect(r.withheld).toContainEqual({ ref: `tool:${evidence.id}`, category: "learner-model" });
  });

  it("F: the learner sees the receipt on their record, and staff accountability survives the learner's erasure", async () => {
    const { jobId } = await recordRun();
    const revealed = (await call(owner, "POST", `${runPath(jobId)}/payload`, { reason: "learner_request" })).json();
    await db.query("UPDATE supervisor_jobs SET state='applied',runtime_snapshot=jsonb_set(runtime_snapshot,'{state}','\"applied\"') WHERE id=$1", [jobId]);
    const erased = await call(learner, "POST", `/api/enrollments/${enrollment}/erase`, { confirmation: `ERASE ${enrollment.slice(0, 8)}`, reason: "Synthetic erasure request." });
    expect(erased.statusCode, erased.body).toBe(200);
    const onRecord = (await db.query("SELECT payload FROM learning_events WHERE event_type='run.payload_revealed' AND enrollment_id=$1", [enrollment])).rows;
    expect(onRecord).toEqual([{ payload: { erased: true } }]);
    const kept = (await db.query("SELECT enrollment_id,actor_id,payload FROM learning_events WHERE event_type='run.payload_reveal_audited' AND workspace_id=$1", [workspace])).rows;
    expect(kept).toEqual([{ enrollment_id: null, actor_id: owner.userId, payload: { receiptId: revealed.receipt.id, catalogId: catalog, runId: jobId, enrollmentId: enrollment,
      reason: "learner_request", payloadDigest: revealed.receipt.payloadDigest } }]);
  });

  it("D/E: no other course's path and no role without the permission reaches a run", async () => {
    const { jobId } = await recordRun();
    const m = fixture(); m.id = "other"; m.title = "Other";
    const rel2 = (await call(owner, "POST", `/api/workspaces/${workspace}/releases`, m)).json().id;
    expect((await call(owner, "POST", `/api/releases/${rel2}/publish`)).statusCode).toBe(200);
    const other = (await call(owner, "GET", "/api/admin/session")).json().courses.find((c: { id: string }) => c.id !== catalog).id;
    expect((await call(owner, "GET", `/api/admin/courses/${other}/runs/${jobId}`)).statusCode).toBe(404);
    expect((await call(owner, "POST", `/api/admin/courses/${other}/runs/${jobId}/payload`, { reason: "quality_review" })).statusCode).toBe(404);
    expect((await call(owner, "POST", `/api/admin/courses/${other}/runs/${jobId}/replay`)).statusCode).toBe(404);
    for (const role of ["support_observer", "service", "author"]) {
      const p = await person(role);
      expect((await call(p, "GET", runPath(jobId))).statusCode).toBe(403);
      expect((await call(p, "POST", `${runPath(jobId)}/replay`)).statusCode).toBe(403);
      expect((await call(p, "POST", `${runPath(jobId)}/payload`, { reason: "quality_review" })).statusCode).toBe(403);
      expect((await call(p, "GET", `/api/admin/enrollments/${enrollment}/runs`)).statusCode).toBe(403);
    }
  });
});
