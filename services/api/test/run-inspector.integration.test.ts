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

const recordRun = (options: { role?: "supervisor" | "companion"; tamper?: boolean } = {}) =>
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
    expect(body.workflow.nodes.find((n: { kind: string }) => n.kind === "operation").label).toBe("Attempt 1 · provider completed");
    expect(body.workflow.nodes.filter((n: { kind: string }) => n.kind === "tool_call").map((n: { label: string }) => n.label)).toEqual(calls.map((c) => `Step ${c.step}: ${c.tool}`));
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
    expect((await db.query("SELECT count(*)::int AS n FROM learning_events WHERE event_type='run.payload_revealed'")).rows[0].n).toBe(0);
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
    expect(body.payload.artifacts[0]).toMatchObject({ kind: "supervised_plan", withheld: false, content: { summary: "Offer the number-line walkthrough before the next check.", toolCallRefs: calls.map((c) => c.id) } });
    expect(body.withheld).toEqual(expect.arrayContaining([{ ref: `tool:${calls[1]!.id}`, category: "learner-model" }, { ref: `tool:${calls[2]!.id}`, category: "hypothesis-tool-text" }]));
    expect(body.rule.withheld).toEqual(["companion", "learner-model", "hypothesis-tool-text"]);
    for (const canary of [...CANARIES, "chain_of_thought", "api_key"]) expect(revealed.body).not.toContain(canary);

    // The receipt is on the learner's record and in the workspace audit log.
    const receipt = (await db.query("SELECT enrollment_id,actor_id,actor_kind,payload FROM learning_events WHERE event_type='run.payload_revealed'")).rows;
    expect(receipt).toEqual([{ enrollment_id: enrollment, actor_id: admin.userId, actor_kind: "staff",
      payload: { receiptId: body.receipt.id, catalogId: catalog, runId: jobId, reason: "incident_investigation", payloadDigest: digestJson(body.payload), withheld: ["learner-model", "hypothesis-tool-text"] } }]);
    const audit = (await call(owner, "GET", `/api/admin/workspaces/${workspace}/audit?type=run.payload_revealed`)).json().events;
    expect(audit[0]).toMatchObject({ actor: "admin person", payloadWithheld: false, payload: { runId: jobId, reason: "incident_investigation" } });
  });

  it("withholds a companion run's reply as part of the private conversation", async () => {
    const { jobId } = await recordRun({ role: "companion" });
    const revealed = await call(owner, "POST", `${runPath(jobId)}/payload`, { reason: "bug_report" });
    expect(revealed.statusCode).toBe(200);
    expect(revealed.json().payload.artifacts[0]).toMatchObject({ kind: "companion_message", content: null, withheld: true });
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
    for (const canary of [...CANARIES, "Offer the number-line"]) expect(replay.body).not.toContain(canary);
    expect(await counts()).toEqual(before);
    expect((await db.query("SELECT revision FROM enrollments WHERE id=$1", [enrollment])).rows[0].revision).toBe(revision);
    const receipt = (await db.query("SELECT enrollment_id,actor_id,payload FROM learning_events WHERE event_type='run.replayed'")).rows;
    expect(receipt).toEqual([{ enrollment_id: null, actor_id: instructor.userId, payload: expect.objectContaining({ runId: jobId, replayRunId: body.replayRunId, outcome: "matches" }) }]);
    // Each replay is a new run id.
    expect((await call(instructor, "POST", `${runPath(jobId)}/replay`)).json().replayRunId).not.toBe(body.replayRunId);
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
    expect(listed.json()).toEqual({ courseId: catalog, runs: [{ id: jobId, label: "supervisor run", status: "ready", startedAt: expect.any(String), episodeId: "min", blockId: null }] });
    expect((await call(instructor, "GET", `/api/admin/enrollments/${enrollment}/runs?episodeId=max`)).json().runs).toEqual([]);
    expect((await call(observer, "GET", `/api/admin/enrollments/${enrollment}/runs`)).statusCode).toBe(403);
    expect((await call(learner, "GET", `/api/admin/enrollments/${enrollment}/runs`)).statusCode).toBe(403);
  });
});
