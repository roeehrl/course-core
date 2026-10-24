import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "../src/database.js";
import { createTestDatabase, type TestDatabase } from "./test-database.js";
import { createServer } from "../src/server.js";
import { issueLoginCode } from "../src/auth.js";
import { credentialVault } from "../src/key-vault.js";
import { WorkspaceProviders, defaultJobPolicy } from "../src/provider-setup.js";
import { anthropicAdapterFactory } from "../src/provider-composition.js";
import { PUBLIC_SCRIPTED_MODELS, publicSuite } from "../src/agent-evals/public-suite.js";
import { dialoguesFor, dialogueStrategy, teachingContext } from "../src/agent-evals/suite.js";
import { ScriptedModel, SCRIPTED_CREDENTIAL, SCRIPTED_RESEARCH_MODEL_ID, scriptedConfiguration } from "../src/agent-evals/scripted-model.js";
import type { Dialogue } from "../src/agent-evals/suite.js";
import { GATE_VERSION } from "../src/agent-evals/gate.js";
import { roleRevisions } from "../src/agent-evals/revision.js";
import { estimateMicroUsd, settleRefusedQualityCheckCalls, typicalUsage } from "../src/provider-quality-checks.js";
import { createPostgresSupervisorBridge } from "../src/supervisor-bridge.js";

// Quality checks run from the admin page, over HTTP and real PostgreSQL. The model is Core's
// offline scripted model behind the real Anthropic adapter: the adapter builds real requests and a
// local `fetch` answers them from fixed tables. No provider is contacted and no key exists; a pass
// here proves the accounting and the gate path, not any real model's quality.
const schema = "quality_checks_" + randomUUID().replaceAll("-", ""), origin = "http://localhost:4310";
let db: Database, testDatabase: TestDatabase | undefined, providers: WorkspaceProviders;
let app: Awaited<ReturnType<typeof createServer>>, quick: Awaited<ReturnType<typeof createServer>>;
interface Session { id: string; cookie: string; csrf: string }
const jobPolicy = { ...defaultJobPolicy, allowance: { microUsd: 100000, tokens: 1_000_000 } };
// The draft binds the companion tutor and the supervisor's plan strategy: their dialogues only.
const conversations = publicSuite().dialogues.filter((d) => ["core.companion.tutor", "core.supervisor.plan"].includes(dialogueStrategy(d) ?? "")).length;

/** What the scripted provider does next: answer from a table, refuse the key, or answer in full with
 * output the adapter refuses (empty text, or structured output that is not JSON). */
let mode: "reference" | "known-bad" | "reject" | "malformed" = "reference";
const models = { reference: new ScriptedModel(PUBLIC_SCRIPTED_MODELS.reference), "known-bad": new ScriptedModel(PUBLIC_SCRIPTED_MODELS["known-bad"]) };
let sent = 0;
const scriptedFetch: typeof fetch = async (input, init) => {
  sent++;
  if (mode === "reject")
    return new Response(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "synthetic refusal" } }),
      { status: 401, headers: { "content-type": "application/json" } });
  if (mode === "malformed") {
    const body = JSON.parse(String(init?.body)) as { model: string; output_config?: { format?: unknown } };
    return new Response(JSON.stringify({ id: "msg_malformed", type: "message", role: "assistant", model: body.model, stop_reason: "end_turn",
      content: [{ type: "text", text: body.output_config?.format ? "{not json" : "" }], usage: { input_tokens: 400, output_tokens: 20 } }),
    { status: 200, headers: { "content-type": "application/json" } });
  }
  return models[mode].fetch(input, init);
};
/** Holds a run before its next conversation until the test lets it go. */
let hold: Promise<void> | null = null;
const beforeDialogue = async (dialogue: Dialogue) => {
  if (hold) await hold;
  models.reference.current = dialogue.id;
  models["known-bad"].current = dialogue.id;
};

const headers = (s: Session) => ({ cookie: s.cookie, origin, "x-csrf-token": s.csrf });
const setup = (w: string) => `/api/admin/workspaces/${w}/provider-setup`;
const checks = (w: string) => `${setup(w)}/quality-check`;
async function newWorkspace() {
  const id = randomUUID();
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [id, "qc-" + id, "Quality check"]);
  return id;
}
async function login(role: string, workspace: string): Promise<Session> {
  const id = randomUUID();
  await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [id, "test:" + id, "Quality check " + role]);
  await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspace, id, role]);
  const r = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, id) } });
  expect(r.statusCode).toBe(200);
  return { id, cookie: r.cookies.map((c) => `${c.name}=${c.value}`).join("; "), csrf: r.json().csrfToken };
}
const call = (s: Session, method: "GET" | "POST", url: string, payload?: unknown, server = app) =>
  server.inject({ method, url, headers: headers(s), ...(payload === undefined ? {} : { payload: payload as object }) });
const key = () => "quality-check:" + randomUUID();

/** A workspace with a stored key, no model on, and an open draft whose two jobs wait for a check. */
async function prepared(options: { price?: boolean; limitMicroUsd?: number } = {}) {
  const workspace = await newWorkspace(), owner = await login("owner", workspace);
  const configuration = scriptedConfiguration("reference");
  const saved = await call(owner, "POST", setup(workspace), { expectedRevision: 0, idempotencyKey: key(),
    configuration: { ...configuration, roles: {} }, jobPolicy, credentials: { [SCRIPTED_CREDENTIAL]: "offline-scripted-model-key" } });
  expect(saved.statusCode, saved.body).toBe(200);
  const draft = await call(owner, "POST", setup(workspace) + "/drafts/json", { baseRevision: 1, configuration, jobPolicy });
  expect(draft.statusCode, draft.body).toBe(200);
  expect(draft.json().waitingForCheck).toEqual(["companion", "supervisor"]);
  if (options.price ?? true) await price(owner, workspace);
  if (options.limitMicroUsd !== undefined) await limit(owner, workspace, options.limitMicroUsd);
  return { workspace, owner, draftId: draft.json().id as string };
}
async function price(owner: Session, workspace: string, modelId = "eval-scripted") {
  const r = await call(owner, "POST", `/api/admin/workspaces/${workspace}/provider-pricing`, { idempotencyKey: key(), modelId,
    expectedVersion: 0, status: "active", currency: "USD", inputMicroUsdPerMillionTokens: 1_000_000, outputMicroUsdPerMillionTokens: 5_000_000,
    cachedInputMicroUsdPerMillionTokens: null, microUsdPerRequest: null, microUsdPerOutputSecond: null, effectiveFrom: new Date().toISOString(),
    sourceNote: "Synthetic test price" });
  expect(r.statusCode, r.body).toBe(200);
}
async function limit(owner: Session, workspace: string, microUsd: number) {
  const budgets = (await call(owner, "GET", setup(workspace) + "/budgets")).json();
  const r = await call(owner, "POST", setup(workspace) + "/budgets", { expectedRevision: budgets.workspace.revision, idempotencyKey: key(),
    limits: { microUsd }, paidWorkApproved: true });
  expect(r.statusCode, r.body).toBe(200);
}
async function finished(owner: Session, workspace: string, id: string, server = app) {
  for (let i = 0; i < 200; i++) {
    const r = await call(owner, "GET", `${checks(workspace)}/${id}`, undefined, server);
    expect(r.statusCode, r.body).toBe(200);
    if (r.json().state !== "running") return r.json();
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("The check did not finish");
}
const used = async (workspace: string) =>
  (await db.query("SELECT used_micro_usd::int AS usd,used_tokens::bigint AS tokens FROM supervisor_workspace_budgets WHERE workspace_id=$1", [workspace])).rows[0];
const ledger = async (workspace: string) =>
  (await db.query("SELECT state,enrollment_id,reserved_micro_usd::int AS reserved,charged_micro_usd::int AS charged,actual_micro_usd::int AS actual FROM provider_spend_ledger WHERE workspace_id=$1 AND source='quality_check' ORDER BY source_ref", [workspace])).rows;

beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  providers = new WorkspaceProviders(db, credentialVault(randomBytes(32)), { anthropic: anthropicAdapterFactory(scriptedFetch) });
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false, workspaceProviders: providers, qualityChecks: { perHour: 4, beforeDialogue } });
  // A second server whose checks time out after one second.
  quick = await createServer(db, { loginCodes: true, origin, secureCookies: false, workspaceProviders: providers, qualityChecks: { deadlineMs: 1000, beforeDialogue } });
}, 30000);
afterAll(async () => {
  hold = null;
  await app?.close();
  await quick?.close();
  await db?.end();
  await testDatabase?.drop();
});

describe("quality check from the AI services page", () => {
  it("refuses, in order, without a draft, prices, a spending limit or enough budget, and says which", async () => {
    const workspace = await newWorkspace(), owner = await login("owner", workspace);
    const empty = (await call(owner, "GET", checks(workspace))).json();
    expect(empty).toMatchObject({ draftId: null, blocked: { code: "PROVIDER_QUALITY_CHECK_NO_DRAFT" }, latest: null });
    const none = await call(owner, "POST", checks(workspace), { idempotencyKey: key(), draftId: randomUUID() });
    expect(none.statusCode).toBe(404);

    const { workspace: w, owner: o, draftId } = await prepared({ price: false });
    let status = (await call(o, "GET", checks(w))).json();
    expect(status.blocked).toEqual({ code: "PROVIDER_QUALITY_CHECK_PRICES_MISSING", roles: ["companion", "supervisor"] });
    expect(status.conversations).toBe(conversations);
    const unpriced = await call(o, "POST", checks(w), { idempotencyKey: key(), draftId });
    expect(unpriced.statusCode).toBe(409);
    expect(unpriced.json()).toEqual({ error: "PROVIDER_QUALITY_CHECK_PRICES_MISSING", details: { roles: ["companion", "supervisor"] } });

    await price(o, w);
    status = (await call(o, "GET", checks(w))).json();
    expect(status.blocked).toEqual({ code: "PROVIDER_QUALITY_CHECK_LIMIT_MISSING" });
    // conversations × (3000 input tokens at $1/M + 600 output tokens at $5/M) = $0.006 each.
    expect(status.estimateMicroUsd).toBe(conversations * 6000);
    expect(status.reserveMicroUsd).toBe(conversations * 100000);
    expect((await call(o, "POST", checks(w), { idempotencyKey: key(), draftId })).json().error).toBe("PROVIDER_QUALITY_CHECK_LIMIT_MISSING");

    await limit(o, w, 1_000_000);
    const short = await call(o, "POST", checks(w), { idempotencyKey: key(), draftId });
    expect(short.statusCode).toBe(409);
    expect(short.json()).toEqual({ error: "PROVIDER_QUALITY_CHECK_BUDGET_REACHED",
      details: { neededMicroUsd: conversations * 100000, availableMicroUsd: 1_000_000 } });
    // Nothing was reserved, sent or recorded by a refusal.
    expect(await ledger(w)).toEqual([]);
    expect(Number((await db.query("SELECT count(*) FROM provider_quality_checks WHERE workspace_id=$1", [w])).rows[0].count)).toBe(0);
    expect((await used(w)).usd).toBe(0);
    // A draft id that is not the open draft is refused.
    await limit(o, w, 5_000_000);
    expect((await call(o, "POST", checks(w), { idempotencyKey: key(), draftId: randomUUID() })).statusCode).toBe(404);
  });

  it("runs the check on the server, charges the workspace budget per call, records the pass and lets the models turn on", async () => {
    const { workspace, owner, draftId } = await prepared({ limitMicroUsd: 5_000_000 });
    mode = "reference";
    let release!: () => void;
    hold = new Promise<void>((resolve) => (release = resolve));
    const idempotencyKey = key(), before = sent;
    const started = await call(owner, "POST", checks(workspace), { idempotencyKey, draftId });
    expect(started.statusCode, started.body).toBe(200);
    expect(started.json()).toMatchObject({ state: "running", total: conversations, completed: 0, roles: ["companion", "supervisor"],
      estimateMicroUsd: conversations * 6000, reservedMicroUsd: conversations * 100000 });
    const id = started.json().id;
    // While it runs: the full reservation is held, a retry returns the same check, another start is refused.
    expect((await used(workspace)).usd).toBe(conversations * 100000);
    expect((await call(owner, "POST", checks(workspace), { idempotencyKey, draftId })).json().id).toBe(id);
    expect((await call(owner, "POST", checks(workspace), { idempotencyKey, draftId: randomUUID() })).json().error).toBe("IDEMPOTENCY_CONFLICT");
    const again = await call(owner, "POST", checks(workspace), { idempotencyKey: key(), draftId });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("PROVIDER_QUALITY_CHECK_RUNNING");
    expect((await call(owner, "GET", checks(workspace))).json().blocked).toEqual({ code: "PROVIDER_QUALITY_CHECK_RUNNING" });
    hold = null;
    release();

    const done = await finished(owner, workspace, id);
    expect(done).toMatchObject({ state: "passed", reason: null, completed: conversations });
    expect(done.outcome.map((o: { role: string; passed: boolean; failed: unknown[] }) => [o.role, o.passed, o.failed.length]))
      .toEqual([["companion", true, 0], ["supervisor", true, 0]]);
    expect(sent - before).toBe(conversations);
    // Every call settled at its reported usage and price; the rest of each reservation came back.
    const rows = await ledger(workspace);
    expect(rows).toHaveLength(conversations);
    for (const row of rows) {
      expect(row).toMatchObject({ state: "reconciled", enrollment_id: null, reserved: 100000 });
      expect(row.charged).toBe(row.actual);
      expect(row.charged).toBeGreaterThan(0);
    }
    const charged = rows.reduce((n, r) => n + r.charged, 0);
    expect(done.chargedMicroUsd).toBe(charged);
    expect((await used(workspace)).usd).toBe(charged);
    // Recorded exactly as an uploaded report would be.
    const results = (await db.query("SELECT role,outcome,mode,idempotency_key FROM provider_eval_results WHERE workspace_id=$1 ORDER BY role", [workspace])).rows;
    expect(results).toEqual([
      { role: "companion", outcome: "passed", mode: "live", idempotency_key: `quality-check:${id}` },
      { role: "supervisor", outcome: "passed", mode: "live", idempotency_key: `quality-check:${id}` }]);
    const draft = (await call(owner, "GET", setup(workspace) + "/drafts/current")).json().draft;
    expect(draft.waitingForCheck).toEqual([]);
    expect(draft.roles.map((r: { check: string }) => r.check)).toEqual(["passed", "passed"]);
    const on = await call(owner, "POST", `${setup(workspace)}/drafts/${draftId}/activate`, { expectedRevision: 1, idempotencyKey: key(), confirmCancelRunning: false });
    expect(on.statusCode, on.body).toBe(200);
    expect(on.json().evaluation).toEqual({ companion: "passed", supervisor: "passed" });
    // Audited, with no answer text, prompt or key.
    const audit = (await db.query("SELECT event_type,payload FROM learning_events WHERE workspace_id=$1 AND event_type LIKE 'provider.quality_check.%' ORDER BY sequence", [workspace])).rows;
    expect(audit.map((r) => r.event_type)).toEqual(["provider.quality_check.started", "provider.quality_check.finished"]);
    expect(audit[1].payload).toMatchObject({ checkId: id, state: "passed", chargedMicroUsd: charged });
    expect(JSON.stringify(audit)).not.toContain("offline-scripted-model-key");
    // The spending view stays per learner: workspace calls carry no enrollment.
    const spend = await call(owner, "GET", `/api/admin/workspaces/${workspace}/provider-spend`);
    expect(spend.statusCode, spend.body).toBe(200);
    expect(spend.json().byEnrollment).toEqual([]);
    expect(Number(spend.json().totals.charged)).toBe(charged);
    // Nothing is left to check.
    expect((await call(owner, "GET", checks(workspace))).json().blocked).toEqual({ code: "PROVIDER_QUALITY_CHECK_NO_DRAFT" });
  });

  it("records answers that break the rules as a failed result, with the failed rules, and keeps the models waiting", async () => {
    const { workspace, owner, draftId } = await prepared({ limitMicroUsd: 5_000_000 });
    mode = "known-bad";
    const started = await call(owner, "POST", checks(workspace), { idempotencyKey: key(), draftId });
    expect(started.statusCode, started.body).toBe(200);
    const done = await finished(owner, workspace, started.json().id);
    mode = "reference";
    expect(done.state).toBe("failed");
    const failed = done.outcome.flatMap((o: { failed: { graders: string[] }[] }) => o.failed.flatMap((f) => f.graders));
    expect(failed.length).toBeGreaterThan(0);
    expect(JSON.stringify(done)).not.toContain("You're clearly confused");
    const draft = (await call(owner, "GET", setup(workspace) + "/drafts/current")).json().draft;
    expect(draft.waitingForCheck.sort()).toEqual(["companion", "supervisor"]);
    expect(draft.roles.map((r: { check: string }) => r.check)).toEqual(["failed", "failed"]);
    // A failed run is still paid work: it was charged at its reported usage.
    expect((await ledger(workspace)).every((r) => r.state === "reconciled")).toBe(true);
    // The owner can run it again later (a new key) once the models change; it is offered again now.
    expect((await call(owner, "GET", checks(workspace))).json().blocked).toBeNull();
  });

  it("settles a reply the adapter refused at its reported usage, releases the rest and records the conversation failed with its reason", async () => {
    const { workspace, owner, draftId } = await prepared({ limitMicroUsd: 5_000_000 });
    mode = "malformed";
    const before = sent;
    const started = await call(owner, "POST", checks(workspace), { idempotencyKey: key(), draftId });
    expect(started.statusCode, started.body).toBe(200);
    const done = await finished(owner, workspace, started.json().id);
    mode = "reference";
    expect(sent - before).toBeGreaterThanOrEqual(conversations);
    expect(done).toMatchObject({ state: "failed", reason: null, completed: conversations });
    // Every conversation failed with the refusal's reason code; no reply text is kept.
    const failed = done.outcome.flatMap((o: { failed: { reason?: string }[] }) => o.failed);
    expect(failed).toHaveLength(conversations);
    expect(new Set(failed.map((f: { reason?: string }) => f.reason))).toEqual(new Set(["provider_output_invalid"]));
    expect(JSON.stringify(done)).not.toContain("not json");
    const grades = (await db.query("SELECT grades FROM provider_eval_results WHERE workspace_id=$1", [workspace])).rows
      .flatMap((r) => r.grades as { graders: { findings: string[] }[] }[]);
    expect(grades.every((g) => g.graders.every((x) => x.findings[0] === "no_answer:provider_output_invalid"))).toBe(true);
    // Paid at the reported usage and price, never held as uncertain at the full reservation.
    const rows = await ledger(workspace);
    expect(rows).toHaveLength(conversations);
    for (const row of rows) {
      expect(row).toMatchObject({ state: "reconciled", reserved: 100000 });
      expect(row.charged).toBe(row.actual);
      expect(row.charged).toBeGreaterThan(0);
      expect(row.charged).toBeLessThan(100000);
    }
    const charged = rows.reduce((n, r) => n + r.charged, 0);
    expect(done.chargedMicroUsd).toBe(charged);
    expect((await used(workspace)).usd).toBe(charged);
    const draft = (await call(owner, "GET", setup(workspace) + "/drafts/current")).json().draft;
    expect(draft.roles.map((r: { check: string }) => r.check)).toEqual(["failed", "failed"]);
  });

  it("settles a refused-reply call an older Core left uncertain in the reconcile pass, and leaves calls it cannot prove", async () => {
    const { workspace, owner, draftId } = await prepared({ limitMicroUsd: 5_000_000 });
    // Simulates a finished check of an older Core: its recorded result says which conversations had no answer and why.
    const id = randomUUID(), suiteDigest = publicSuite().digest, revision = "a".repeat(64);
    await db.query(`INSERT INTO provider_quality_checks(id,workspace_id,draft_id,provider_revision,actor_id,idempotency_key,request_digest,state,roles,total_dialogues,
      estimate_micro_usd,reserved_micro_usd,deadline_at,finished_at) VALUES($1,$2,$3,1,$4,$5,$6,'failed',ARRAY['companion'],4,6000,400000,now(),now())`,
      [id, workspace, draftId, owner.id, key(), "0".repeat(64)]);
    const finding = (code: string | null) => ({ dialogueId: randomUUID(), passed: code === null,
      graders: [{ grader: "hint_leakage", passed: code === null, findings: code === null ? [] : [`no_answer:${code}`] }] });
    await db.query(`INSERT INTO provider_eval_results(id,workspace_id,role,revision_digest,suite_id,suite_digest,grader_version,mode,outcome,grades,actor_id,idempotency_key,request_digest)
      VALUES($1,$2,'companion',$3,$4,$5,'1','live','failed',$6,$7,$8,$9)`,
      [randomUUID(), workspace, revision, publicSuite().id, suiteDigest, JSON.stringify([finding("INVALID_RESPONSE"), finding("TIMEOUT"), finding(null), finding("INCOMPLETE_OUTPUT")]),
        owner.id, `quality-check:${id}`, "1".repeat(64)]);
    const states = ["uncertain", "uncertain", "reconciled", "uncertain"];
    for (const [n, state] of states.entries())
      await db.query(`INSERT INTO provider_spend_ledger(id,source,source_ref,attempt,workspace_id,enrollment_id,role,state,reserved_micro_usd,reserved_tokens,charged_micro_usd,
          actual_micro_usd,pricing_version_id,settled_at)
        VALUES($1,'quality_check',$2,1,$3,NULL,$4,$5,100000,1000,100000,$6,$7,now())`,
        [randomUUID(), `${id}:${n}`, workspace, n === 3 ? "supervisor" : "companion", state, state === "reconciled" ? 100000 : null,
          state === "reconciled" ? (await db.query("SELECT id FROM provider_model_prices WHERE workspace_id=$1 LIMIT 1", [workspace])).rows[0].id : null]);
    // A check that recorded no result (stopped early) proves nothing.
    const other = randomUUID();
    await db.query(`INSERT INTO provider_quality_checks(id,workspace_id,draft_id,provider_revision,actor_id,idempotency_key,request_digest,state,reason_code,roles,total_dialogues,
      estimate_micro_usd,reserved_micro_usd,deadline_at,finished_at) VALUES($1,$2,$3,1,$4,$5,$6,'error','PROVIDER_QUALITY_CHECK_INTERRUPTED',ARRAY['companion'],1,6000,100000,now(),now())`,
      [other, workspace, draftId, owner.id, key(), "0".repeat(64)]);
    await db.query(`INSERT INTO provider_spend_ledger(id,source,source_ref,attempt,workspace_id,enrollment_id,role,state,reserved_micro_usd,reserved_tokens,charged_micro_usd,settled_at)
      VALUES($1,'quality_check',$2,1,$3,NULL,'companion','uncertain',100000,1000,100000,now())`, [randomUUID(), `${other}:0`, workspace]);
    const budgetBefore = await used(workspace);
    // Another workspace's reconcile pass leaves these rows alone.
    expect(await settleRefusedQualityCheckCalls(db, [randomUUID()], 100)).toBe(0);
    // The dispatcher's reconcile pass settles them.
    const bridge = createPostgresSupervisorBridge(db, { serviceToken: "s".repeat(32), workspaceIds: [workspace] });
    await bridge.reconcile(100);
    const rows = (await db.query("SELECT source_ref,state,charged_micro_usd::int AS charged FROM provider_spend_ledger WHERE workspace_id=$1 AND source='quality_check' ORDER BY source_ref", [workspace])).rows;
    const byRef = Object.fromEntries(rows.map((r) => [r.source_ref, r]));
    // The refused reply is definite: no longer uncertain. No usage was kept for it, so its reservation stays charged, never guessed down.
    expect(byRef[`${id}:0`]).toMatchObject({ state: "unpriced", charged: 100000 });
    // A timeout's fate is unknown, a reconciled row is already settled, a role that does not match the recorded position is not proven.
    expect(byRef[`${id}:1`]).toMatchObject({ state: "uncertain", charged: 100000 });
    expect(byRef[`${id}:2`]).toMatchObject({ state: "reconciled" });
    expect(byRef[`${id}:3`]).toMatchObject({ state: "uncertain" });
    expect(byRef[`${other}:0`]).toMatchObject({ state: "uncertain" });
    expect(await used(workspace)).toEqual(budgetBefore);
    // Each row changes at most once.
    expect(await settleRefusedQualityCheckCalls(db, [workspace], 100)).toBe(0);
  });

  it("stops at a refused key with the key reason, records nothing and releases what was never charged", async () => {
    const { workspace, owner, draftId } = await prepared({ limitMicroUsd: 5_000_000 });
    mode = "reject";
    const before = sent;
    const started = await call(owner, "POST", checks(workspace), { idempotencyKey: key(), draftId });
    const done = await finished(owner, workspace, started.json().id);
    mode = "reference";
    expect(done).toMatchObject({ state: "error", reason: "PROVIDER_METADATA_KEY_INVALID", chargedMicroUsd: 0 });
    expect(sent - before).toBe(1);
    expect((await ledger(workspace)).every((r) => r.state === "not_started" && r.charged === 0)).toBe(true);
    expect((await used(workspace)).usd).toBe(0);
    expect(Number((await db.query("SELECT count(*) FROM provider_eval_results WHERE workspace_id=$1", [workspace])).rows[0].count)).toBe(0);
  });

  it("ends a check that runs past its deadline as timed out and frees what it never sent", async () => {
    const { workspace, owner, draftId } = await prepared({ limitMicroUsd: 5_000_000 });
    let release!: () => void;
    hold = new Promise<void>((resolve) => (release = resolve));
    const started = await call(owner, "POST", checks(workspace), { idempotencyKey: key(), draftId }, quick);
    expect(started.statusCode, started.body).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    hold = null;
    release();
    const done = await finished(owner, workspace, started.json().id, quick);
    expect(done).toMatchObject({ state: "error", reason: "PROVIDER_QUALITY_CHECK_TIMEOUT", completed: 0 });
    expect((await used(workspace)).usd).toBe(0);
  });

  it("ends a check a stopped server left running and keeps its unsettled calls charged", async () => {
    const { workspace, owner, draftId } = await prepared({ limitMicroUsd: 5_000_000 });
    const id = randomUUID();
    await db.query(`INSERT INTO provider_quality_checks(id,workspace_id,draft_id,provider_revision,actor_id,idempotency_key,request_digest,state,roles,total_dialogues,
      estimate_micro_usd,reserved_micro_usd,deadline_at,created_at) VALUES($1,$2,$3,1,$4,$5,$6,'running',ARRAY['companion'],1,6000,100000,now()-interval '10 minutes',now()-interval '20 minutes')`,
      [id, workspace, draftId, owner.id, key(), "0".repeat(64)]);
    await db.query(`INSERT INTO provider_spend_ledger(id,source,source_ref,attempt,workspace_id,enrollment_id,role,state,reserved_micro_usd,reserved_tokens,charged_micro_usd)
      VALUES($1,'quality_check',$2,1,$3,NULL,'companion','reserved',100000,1000,100000)`, [randomUUID(), `${id}:0`, workspace]);
    const status = (await call(owner, "GET", checks(workspace))).json();
    expect(status.latest).toMatchObject({ id, state: "error", reason: "PROVIDER_QUALITY_CHECK_INTERRUPTED", chargedMicroUsd: 100000 });
    expect(status.blocked).toBeNull();
    expect((await ledger(workspace))[0]).toMatchObject({ state: "uncertain", charged: 100000 });
  });

  it("limits how many checks a workspace starts in an hour", async () => {
    const { workspace, owner, draftId } = await prepared({ limitMicroUsd: 5_000_000 });
    for (let i = 0; i < 4; i++)
      await db.query(`INSERT INTO provider_quality_checks(id,workspace_id,draft_id,provider_revision,actor_id,idempotency_key,request_digest,state,reason_code,roles,
        total_dialogues,estimate_micro_usd,reserved_micro_usd,deadline_at,finished_at) VALUES($1,$2,$3,1,$4,$5,$6,'error','PROVIDER_METADATA_NETWORK',ARRAY['companion'],1,0,0,now(),now())`,
        [randomUUID(), workspace, draftId, owner.id, key(), "0".repeat(64)]);
    const r = await call(owner, "POST", checks(workspace), { idempotencyKey: key(), draftId });
    expect(r.statusCode).toBe(429);
    expect(r.json().error).toBe("PROVIDER_QUALITY_CHECK_RATE_LIMITED");
  });

  it("lets only owners and administrators of the workspace see or start a check, from the page's own origin", async () => {
    const { workspace, owner, draftId } = await prepared({ limitMicroUsd: 5_000_000 });
    const other = await newWorkspace(), foreign = await login("owner", other);
    for (const role of ["author", "instructor", "reviewer", "learner", "observer", "support_observer"]) {
      const who = await login(role, workspace);
      expect((await call(who, "GET", checks(workspace))).statusCode, role).toBe(403);
      expect((await call(who, "POST", checks(workspace), { idempotencyKey: key(), draftId })).statusCode, role).toBe(403);
    }
    expect((await call(foreign, "GET", checks(workspace))).statusCode).toBe(403);
    expect((await call(foreign, "POST", checks(workspace), { idempotencyKey: key(), draftId })).statusCode).toBe(403);
    expect((await app.inject({ url: checks(workspace) })).statusCode).toBe(401);
    const noCsrf = await app.inject({ method: "POST", url: checks(workspace), headers: { cookie: owner.cookie, origin }, payload: { idempotencyKey: key(), draftId } });
    expect(noCsrf.statusCode).toBe(403);
    const badOrigin = await app.inject({ method: "POST", url: checks(workspace), headers: { ...headers(owner), origin: "https://elsewhere.example" },
      payload: { idempotencyKey: key(), draftId } });
    expect(badOrigin.statusCode).toBe(403);
    expect((await call(owner, "POST", checks(workspace), { idempotencyKey: "short", draftId })).statusCode).toBe(400);
    expect(Number((await db.query("SELECT count(*) FROM provider_quality_checks WHERE workspace_id=$1", [workspace])).rows[0].count)).toBe(0);
    // An administrator may run it.
    const admin = await login("admin", workspace);
    mode = "reference";
    const started = await call(admin, "POST", checks(workspace), { idempotencyKey: key(), draftId });
    expect(started.statusCode, started.body).toBe(200);
    expect((await finished(admin, workspace, started.json().id)).state).toBe("passed");
  });

  it("checks a media job without a price: it calls no model, costs and reserves nothing, and paid calls keep their ledger order", async () => {
    const workspace = await newWorkspace(), owner = await login("owner", workspace);
    const all = scriptedConfiguration("reference", "all"), plan = scriptedConfiguration("reference");
    const configuration = { ...all, roles: { companion: all.roles.companion, supervisor: plan.roles.supervisor, media: all.roles.media } };
    const saved = await call(owner, "POST", setup(workspace), { expectedRevision: 0, idempotencyKey: key(),
      configuration: { ...all, roles: {} }, jobPolicy, credentials: { [SCRIPTED_CREDENTIAL]: "offline-scripted-model-key" } });
    expect(saved.statusCode, saved.body).toBe(200);
    const draft = await call(owner, "POST", setup(workspace) + "/drafts/json", { baseRevision: 1, configuration, jobPolicy });
    expect(draft.statusCode, draft.body).toBe(200);
    expect([...draft.json().waitingForCheck].sort()).toEqual(["companion", "media", "supervisor"]);
    // Only the text model is priced; the image model has no price at all.
    await price(owner, workspace);
    await limit(owner, workspace, 5_000_000);
    const media = dialoguesFor(publicSuite(), "media", "core.media.image").length;
    expect(media).toBeGreaterThan(0);
    const status = (await call(owner, "GET", checks(workspace))).json();
    expect(status).toMatchObject({ target: "draft", blocked: null, conversations: conversations + media,
      estimateMicroUsd: conversations * 6000, reserveMicroUsd: conversations * 100000 });
    expect(status.roles.find((r: { role: string }) => r.role === "media")).toEqual({ role: "media", remoteModel: "course-core-eval-reference-image",
      conversations: media, priced: true, estimateMicroUsd: 0 });
    mode = "reference";
    const before = sent;
    const started = await call(owner, "POST", checks(workspace), { idempotencyKey: key(), draftId: draft.json().id });
    expect(started.statusCode, started.body).toBe(200);
    expect(started.json()).toMatchObject({ total: conversations + media, reservedMicroUsd: conversations * 100000 });
    const id = started.json().id, done = await finished(owner, workspace, id);
    expect(done).toMatchObject({ state: "passed", completed: conversations + media });
    expect(done.outcome.map((o: { role: string; passed: boolean }) => [o.role, o.passed])).toEqual([["companion", true], ["supervisor", true], ["media", true]]);
    // The media conversations sent nothing and hold no ledger row; each paid call settled its own row.
    expect(sent - before).toBe(conversations);
    const refs = (await db.query("SELECT source_ref,role,state FROM provider_spend_ledger WHERE workspace_id=$1 AND source='quality_check'", [workspace])).rows;
    expect(refs.map((r) => r.source_ref).sort()).toEqual(Array.from({ length: conversations }, (_, n) => `${id}:${n}`).sort());
    expect(refs.every((r) => r.role !== "media" && r.state === "reconciled")).toBe(true);
    expect((await used(workspace)).usd).toBe(done.chargedMicroUsd);
  });

  it("checks a media-only setup with no price and no spending limit, since it reserves nothing", async () => {
    const workspace = await newWorkspace(), owner = await login("owner", workspace);
    const all = scriptedConfiguration("reference", "all");
    expect((await call(owner, "POST", setup(workspace), { expectedRevision: 0, idempotencyKey: key(),
      configuration: { ...all, roles: {} }, jobPolicy, credentials: { [SCRIPTED_CREDENTIAL]: "offline-scripted-model-key" } })).statusCode).toBe(200);
    const draft = await call(owner, "POST", setup(workspace) + "/drafts/json", { baseRevision: 1, configuration: { ...all, roles: { media: all.roles.media } }, jobPolicy });
    expect(draft.statusCode, draft.body).toBe(200);
    const status = (await call(owner, "GET", checks(workspace))).json();
    expect(status).toMatchObject({ target: "draft", blocked: null, estimateMicroUsd: 0, reserveMicroUsd: 0 });
    const before = sent;
    const started = await call(owner, "POST", checks(workspace), { idempotencyKey: key(), draftId: draft.json().id });
    expect(started.statusCode, started.body).toBe(200);
    expect(await finished(owner, workspace, started.json().id)).toMatchObject({ state: "passed", chargedMicroUsd: 0 });
    expect(sent - before).toBe(0);
    expect(await ledger(workspace)).toEqual([]);
  });
});

/**
 * Upgrade rehearsal (requirement N07): the exact shape a 0.1.50 pilot left behind. Its active version
 * binds companion, supervisor (tool loop), research and reviewer; its stored evaluation recorded the
 * companion as approved by an owner (for the suite of that release) and the other three as not
 * covered, since 0.1.50 activated them freely. After the upgrade the suite covers every role and
 * its digest changed.
 */
describe("upgrade from a release where only the companion and the plan supervisor were checked", () => {
  const OLD_SUITE_DIGEST = "b".repeat(64);
  const pilot = () => {
    const all = scriptedConfiguration("reference", "all");
    return { ...all, roles: { companion: all.roles.companion, supervisor: all.roles.supervisor, research: all.roles.research, reviewer: all.roles.reviewer } };
  };
  async function upgradedPilot() {
    const workspace = await newWorkspace(), owner = await login("owner", workspace), configuration = pilot();
    // The keys are stored as the setup stores them (revision 1); the version is then put in the state 0.1.50 left it.
    const saved = await call(owner, "POST", setup(workspace), { expectedRevision: 0, idempotencyKey: key(),
      configuration: { ...configuration, roles: {} }, jobPolicy, credentials: { [SCRIPTED_CREDENTIAL]: "offline-scripted-model-key" } });
    expect(saved.statusCode, saved.body).toBe(200);
    const revisions = await roleRevisions(configuration), overrideId = randomUUID();
    await db.query(`INSERT INTO provider_eval_overrides(id,workspace_id,role,revision_digest,suite_id,suite_digest,reason,actor_id,idempotency_key,request_digest,created_at)
      VALUES($1,$2,'companion',$3,'core-public',$4,'Owner approved the tutor before the pilot started.',$5,$6,$7,now()-interval '30 days')`,
      [overrideId, workspace, revisions.companion!.digest, OLD_SUITE_DIGEST, owner.id, key(), "0".repeat(64)]);
    const decision = (role: "companion" | "supervisor" | "research" | "reviewer", rest: object) =>
      ({ revisionDigest: revisions[role]!.digest, strategy: revisions[role]!.strategy, grandfathered: false, ...rest });
    const evaluation = { gate: GATE_VERSION, suiteId: "core-public", suiteDigest: OLD_SUITE_DIGEST, roles: {
      companion: decision("companion", { decision: "override", overrideId }), supervisor: decision("supervisor", { decision: "not_covered" }),
      research: decision("research", { decision: "not_covered" }), reviewer: decision("reviewer", { decision: "not_covered" }) } };
    await db.query("UPDATE workspace_provider_versions SET configuration=$2,evaluation=$3 WHERE workspace_id=$1 AND revision=1",
      [workspace, JSON.stringify(configuration), JSON.stringify(evaluation)]);
    await price(owner, workspace);
    await price(owner, workspace, SCRIPTED_RESEARCH_MODEL_ID);
    return { workspace, owner, configuration, revisions };
  }
  const evalStatus = async (owner: Session, workspace: string) => {
    const r = await call(owner, "GET", `/api/admin/workspaces/${workspace}/provider-evals`);
    expect(r.statusCode, r.body).toBe(200);
    return Object.fromEntries(r.json().roles.map((r: { role: string; status: string; grandfathered: boolean; revisionDigest: string }) =>
      [r.role, [r.status, r.grandfathered]]));
  };

  it("keeps every job running, lets unrelated changes save, gates only the changed job, and offers a check of what is on", async () => {
    const { workspace, owner, configuration, revisions } = await upgradedPilot();
    // Every job is on and needs a check: the companion's approval was for the older checks.
    expect(await evalStatus(owner, workspace)).toEqual({ companion: ["stale", true], supervisor: ["not_evaluated", true],
      research: ["not_evaluated", true], reviewer: ["not_evaluated", true] });
    // No runtime gate: the jobs keep serving.
    const runtime = await providers.resolve(workspace);
    for (const role of ["companion", "supervisor", "research", "reviewer"] as const) expect(runtime.availability(role).status, role).toBe("ready");
    const tutor = publicSuite().dialogues.find((d) => d.role === "companion")!;
    models.reference.current = tutor.id;
    mode = "reference";
    const served = await runtime.execute("companion", teachingContext(tutor), "upgrade-rehearsal", new AbortController().signal);
    expect((served.content as { kind: string }).kind).toBe("companion_text");

    // Unrelated changes save without a check: the job policy (a new version) and the spending limit.
    const policy = await call(owner, "POST", setup(workspace), { expectedRevision: 1, idempotencyKey: key(), configuration,
      jobPolicy: { ...jobPolicy, maxAttempts: 2 }, credentials: {} });
    expect(policy.statusCode, policy.body).toBe(200);
    expect(policy.json().evaluation).toEqual({ supervisor: "unchanged", companion: "unchanged", research: "unchanged", reviewer: "unchanged" });
    await limit(owner, workspace, 50_000_000);
    expect(await evalStatus(owner, workspace)).toEqual({ companion: ["stale", true], supervisor: ["not_evaluated", true],
      research: ["not_evaluated", true], reviewer: ["not_evaluated", true] });
    // Changing the supervisor's model is refused, naming only the supervisor.
    const changed = await call(owner, "POST", setup(workspace), { expectedRevision: 2, idempotencyKey: key(), jobPolicy, credentials: {},
      configuration: { ...configuration, roles: { ...configuration.roles, supervisor: { ...configuration.roles.supervisor, maxOutputTokens: 1500 } } } });
    expect(changed.statusCode).toBe(409);
    expect(changed.json().error).toBe("PROVIDER_EVAL_REQUIRED");
    expect(changed.json().details.roles.map((r: { role: string }) => r.role)).toEqual(["supervisor"]);

    // An owner approves the reviewer's active revision without a check: it shows as approved.
    const approved = await call(owner, "POST", `/api/admin/workspaces/${workspace}/provider-evals/overrides`, { idempotencyKey: key(), role: "reviewer",
      revisionDigest: revisions.reviewer!.digest, reason: "Owner reviewed the reviewer drafts by hand after the upgrade." });
    expect(approved.statusCode, approved.body).toBe(200);
    expect((await evalStatus(owner, workspace)).reviewer).toEqual(["override", true]);

    // With no draft open, the page is offered a check of the jobs that are on and still need one.
    const status = (await call(owner, "GET", checks(workspace))).json();
    const suite = publicSuite(), expected = { companion: 0, supervisor: 0, research: 0 } as Record<string, number>;
    const strategies = { companion: "core.companion.tutor", supervisor: "core.supervisor.tool-loop", research: "core.research.public-topic" } as const;
    const pricing = { inputMicroUsdPerMillionTokens: 1_000_000, outputMicroUsdPerMillionTokens: 5_000_000 } as Parameters<typeof estimateMicroUsd>[0];
    for (const role of ["companion", "supervisor", "research"] as const)
      expected[role] = estimateMicroUsd(pricing, dialoguesFor(suite, role, strategies[role]).map((d) => typicalUsage(d, role === "supervisor" ? 6 : undefined)));
    const total = ["companion", "supervisor", "research"].reduce((n, role) => n + dialoguesFor(suite, role, strategies[role as keyof typeof strategies]).length, 0);
    expect(status).toMatchObject({ target: "active", draftId: null, blocked: null, conversations: total, reserveMicroUsd: total * 100000,
      estimateMicroUsd: expected.companion! + expected.supervisor! + expected.research! });
    expect(status.roles.map((r: { role: string }) => r.role)).toEqual(["companion", "supervisor", "research"]);
    // The tool loop's several rounds make its conversations cost more than one call each.
    expect(expected.supervisor!).toBeGreaterThan(dialoguesFor(suite, "supervisor", strategies.supervisor).length * 6000);

    // Running it with the scripted reference model records passes for the active revisions.
    const idempotencyKey = key();
    const started = await call(owner, "POST", checks(workspace), { idempotencyKey, target: "active" });
    expect(started.statusCode, started.body).toBe(200);
    expect(started.json()).toMatchObject({ target: "active", draftId: null, roles: ["companion", "supervisor", "research"], total });
    expect((await call(owner, "POST", checks(workspace), { idempotencyKey, target: "active" })).json().id).toBe(started.json().id);
    const done = await finished(owner, workspace, started.json().id);
    expect(done.state, JSON.stringify(done.outcome)).toBe("passed");
    expect(await evalStatus(owner, workspace)).toEqual({ companion: ["passed", true], supervisor: ["passed", true],
      research: ["passed", true], reviewer: ["override", true] });
    expect((await used(workspace)).usd).toBe(done.chargedMicroUsd);
    // Nothing on needs a check now, and the jobs were never turned off.
    expect((await call(owner, "GET", checks(workspace))).json()).toMatchObject({ target: null, blocked: { code: "PROVIDER_QUALITY_CHECK_NO_DRAFT" } });
    const refused = await call(owner, "POST", checks(workspace), { idempotencyKey: key(), target: "active" });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe("PROVIDER_QUALITY_CHECK_NOT_NEEDED");
    expect((await providers.resolve(workspace)).availability("supervisor").status).toBe("ready");
  });

  it("lets only owners and administrators check the active setup, and an administrator cannot approve it", async () => {
    const { workspace, revisions } = await upgradedPilot();
    for (const role of ["author", "instructor", "reviewer", "learner", "observer"]) {
      const who = await login(role, workspace);
      expect((await call(who, "POST", checks(workspace), { idempotencyKey: key(), target: "active" })).statusCode, role).toBe(403);
    }
    const admin = await login("admin", workspace);
    expect((await call(admin, "POST", `/api/admin/workspaces/${workspace}/provider-evals/overrides`, { idempotencyKey: key(), role: "companion",
      revisionDigest: revisions.companion!.digest, reason: "An administrator may not approve without a check." })).statusCode).toBe(403);
    expect((await call(admin, "POST", checks(workspace), { idempotencyKey: key(), target: "draft" })).statusCode).toBe(400);
    // Without a spending limit the check cannot start, and says so.
    const blocked = await call(admin, "POST", checks(workspace), { idempotencyKey: key(), target: "active" });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error).toBe("PROVIDER_QUALITY_CHECK_LIMIT_MISSING");
    expect(Number((await db.query("SELECT count(*) FROM provider_quality_checks WHERE workspace_id=$1", [workspace])).rows[0].count)).toBe(0);
  });
});
