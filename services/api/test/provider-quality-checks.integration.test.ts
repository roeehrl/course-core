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
import { ScriptedModel, SCRIPTED_CREDENTIAL, scriptedConfiguration } from "../src/agent-evals/scripted-model.js";
import type { Dialogue } from "../src/agent-evals/suite.js";

// Quality checks run from the admin page, over HTTP and real PostgreSQL. The model is Core's
// offline scripted model behind the real Anthropic adapter: the adapter builds real requests and a
// local `fetch` answers them from fixed tables. No provider is contacted and no key exists; a pass
// here proves the accounting and the gate path, not any real model's quality.
const schema = "quality_checks_" + randomUUID().replaceAll("-", ""), origin = "http://localhost:4310";
let db: Database, testDatabase: TestDatabase | undefined;
let app: Awaited<ReturnType<typeof createServer>>, quick: Awaited<ReturnType<typeof createServer>>;
interface Session { id: string; cookie: string; csrf: string }
const jobPolicy = { ...defaultJobPolicy, allowance: { microUsd: 100000, tokens: 1_000_000 } };
const conversations = publicSuite().dialogues.filter((d) => d.role === "companion" || d.role === "supervisor").length;

/** What the scripted provider does next: answer from a table, or refuse the key. */
let mode: "reference" | "known-bad" | "reject" = "reference";
const models = { reference: new ScriptedModel(PUBLIC_SCRIPTED_MODELS.reference), "known-bad": new ScriptedModel(PUBLIC_SCRIPTED_MODELS["known-bad"]) };
let sent = 0;
const scriptedFetch: typeof fetch = async (input, init) => {
  sent++;
  if (mode === "reject")
    return new Response(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "synthetic refusal" } }),
      { status: 401, headers: { "content-type": "application/json" } });
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
async function price(owner: Session, workspace: string) {
  const r = await call(owner, "POST", `/api/admin/workspaces/${workspace}/provider-pricing`, { idempotencyKey: key(), modelId: "eval-scripted",
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
  const providers = new WorkspaceProviders(db, credentialVault(randomBytes(32)), { anthropic: anthropicAdapterFactory(scriptedFetch) });
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
});
