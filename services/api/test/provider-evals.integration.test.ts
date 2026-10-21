import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "../src/database.js";
import { createTestDatabase, type TestDatabase } from "./test-database.js";
import { createServer } from "../src/server.js";
import { issueLoginCode } from "../src/auth.js";
import { credentialVault } from "../src/key-vault.js";
import { WorkspaceProviders, defaultJobPolicy } from "../src/provider-setup.js";
import { publicSuite, PUBLIC_SCRIPTED_MODELS } from "../src/agent-evals/public-suite.js";
import { scriptedConfiguration, scriptedRuntime } from "../src/agent-evals/scripted-model.js";
import { runSuite, type EvalReport } from "../src/agent-evals/runner.js";
import { roleRevisions } from "../src/agent-evals/revision.js";
import { buildSuite } from "../src/agent-evals/suite.js";

const schema = "provider_evals_" + randomUUID().replaceAll("-", ""), origin = "http://localhost:4310";
let db: Database, app: Awaited<ReturnType<typeof createServer>>, providers: WorkspaceProviders, testDatabase: TestDatabase | undefined;
interface Session { id: string; cookie: string; csrf: string }
const jobPolicy = { ...defaultJobPolicy, allowance: { microUsd: 100000, tokens: 1_000_000 } };
const headers = (s: Session) => ({ cookie: s.cookie, origin, "x-csrf-token": s.csrf });
const evals = (workspace: string) => `/api/admin/workspaces/${workspace}/provider-evals`;
const setup = (workspace: string) => `/api/admin/workspaces/${workspace}/provider-setup`;

async function newWorkspace() {
  const id = randomUUID();
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [id, "evals-" + id, "Eval gate"]);
  return id;
}
async function login(role: string, workspace: string): Promise<Session> {
  const id = randomUUID();
  await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [id, "test:" + id, "Eval gate user"]);
  await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspace, id, role]);
  const r = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, id) } });
  expect(r.statusCode).toBe(200);
  return { id, cookie: r.cookies.map((c) => `${c.name}=${c.value}`).join("; "), csrf: r.json().csrfToken };
}
const reports = new Map<string, EvalReport>();
/** A scripted run of the given answers. By default the answers run under the "reference" scripted
 * configuration, so known-bad answers become a failed result for that same revision. */
async function report(answers: "reference" | "known-bad", model = "reference") {
  const cacheKey = `${answers}/${model}`;
  if (!reports.has(cacheKey)) {
    const { scripted, configuration, runtime } = scriptedRuntime(model, PUBLIC_SCRIPTED_MODELS[answers]);
    reports.set(cacheKey, await runSuite({ suite: publicSuite(), configuration, runtime, mode: "scripted", model, beforeDialogue: (d) => { scripted.current = d.id; } }));
  }
  return structuredClone(reports.get(cacheKey)!);
}
const record = (who: Session, workspace: string, body: unknown, key = randomUUID()) =>
  app.inject({ method: "POST", url: evals(workspace) + "/results", headers: headers(who), payload: { idempotencyKey: key, report: body } });
const override = (who: Session, workspace: string, body: Record<string, unknown>) =>
  app.inject({ method: "POST", url: evals(workspace) + "/overrides", headers: headers(who), payload: { idempotencyKey: randomUUID(), reason: "Owner accepts this revision after a manual review of its answers.", ...body } });
const status = async (who: Session, workspace: string) => {
  const r = await app.inject({ url: evals(workspace), headers: headers(who) });
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
};
async function save(who: Session, workspace: string, configuration: unknown, policy = jobPolicy) {
  const before = (await app.inject({ url: setup(workspace), headers: headers(who) })).json();
  return app.inject({ method: "POST", url: setup(workspace), headers: headers(who), payload: { expectedRevision: before.revision, idempotencyKey: randomUUID(), configuration, jobPolicy: policy, credentials: {} } });
}
const versions = async (workspace: string) => Number((await db.query("SELECT count(*) FROM workspace_provider_versions WHERE workspace_id=$1", [workspace])).rows[0].count);
const reference = scriptedConfiguration("reference");
const withCompanionTokens = (tokens: number) => ({ ...reference, roles: { ...reference.roles, companion: { ...reference.roles.companion, maxOutputTokens: tokens } } });

beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  providers = new WorkspaceProviders(db, credentialVault(randomBytes(32)));
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false, workspaceProviders: providers });
}, 30000);
afterAll(async () => {
  await app?.close();
  await db?.end();
  await testDatabase?.drop();
});

describe("provider eval routes", () => {
  it("role matrix: owners and admins read and record; only owners override; nobody else, nor another workspace", async () => {
    const workspace = await newWorkspace(), other = await newWorkspace();
    const digest = (await roleRevisions(reference)).companion!.digest;
    const sessions = Object.fromEntries(await Promise.all(["owner", "admin", "author", "instructor", "reviewer", "learner", "observer", "support_observer"]
      .map(async (role) => [role, await login(role, workspace)] as const)));
    const foreignOwner = await login("owner", other), body = await report("reference");
    for (const [role, who] of Object.entries(sessions)) {
      const allowed = role === "owner" || role === "admin";
      expect((await app.inject({ url: evals(workspace), headers: headers(who) })).statusCode, role).toBe(allowed ? 200 : 403);
      expect((await record(who, workspace, body)).statusCode, role).toBe(allowed ? 200 : 403);
      expect((await override(who, workspace, { role: "companion", revisionDigest: digest })).statusCode, role).toBe(role === "owner" ? 200 : 403);
    }
    expect((await app.inject({ url: evals(workspace), headers: headers(foreignOwner) })).statusCode).toBe(403);
    expect((await record(foreignOwner, workspace, body)).statusCode).toBe(403);
    expect((await override(foreignOwner, workspace, { role: "companion", revisionDigest: digest })).statusCode).toBe(403);
    expect((await app.inject({ url: evals(workspace) })).statusCode).toBe(401);
    const rows = await db.query("SELECT role,actor_id FROM provider_eval_results WHERE workspace_id=$1", [workspace]);
    expect(new Set(rows.rows.map((r) => r.actor_id))).toEqual(new Set([sessions.owner!.id, sessions.admin!.id]));
    expect(Number((await db.query("SELECT count(*) FROM provider_eval_overrides WHERE workspace_id=$1", [workspace])).rows[0].count)).toBe(1);
  });

  it("refuses activation without a passing evaluation, records failures, and activates only the evaluated revision", async () => {
    const workspace = await newWorkspace(), owner = await login("owner", workspace);
    const refused = await save(owner, workspace, reference);
    expect(refused.statusCode, refused.body).toBe(409);
    const revisions = await roleRevisions(reference);
    expect(refused.json()).toEqual({ error: "PROVIDER_EVAL_REQUIRED", details: { suiteId: publicSuite().id, suiteDigest: publicSuite().digest, roles: [
      { role: "supervisor", revisionDigest: revisions.supervisor!.digest, reason: "not_evaluated" },
      { role: "companion", revisionDigest: revisions.companion!.digest, reason: "not_evaluated" }] } });
    expect(await versions(workspace)).toBe(0);

    // The known-bad scripted model is its own revision: its failure says nothing about this one.
    const ownRevision = await record(owner, workspace, await report("known-bad", "known-bad"));
    expect(ownRevision.json().results.map((r: { revisionDigest: string; outcome: string }) => [r.revisionDigest === revisions.companion!.digest, r.outcome])).toEqual([[false, "failed"], [false, "failed"]]);
    expect((await save(owner, workspace, reference)).json().details.roles.map((r: { reason: string }) => r.reason)).toEqual(["not_evaluated", "not_evaluated"]);
    // Leaky answers for this revision are recorded as failed and still cannot activate.
    const bad = await record(owner, workspace, await report("known-bad"));
    expect(bad.statusCode, bad.body).toBe(200);
    expect(bad.json().results.map((r: { role: string; outcome: string }) => [r.role, r.outcome])).toEqual([["companion", "failed"], ["supervisor", "failed"]]);
    expect(JSON.stringify(bad.json())).not.toContain("You're clearly confused");
    // Forged grades do not help: Core regrades the answers itself.
    const forged = await report("known-bad");
    forged.passed = true;
    for (const role of forged.roles) { role.passed = true; for (const d of role.dialogues) d.grade = { ...d.grade, passed: true, graders: d.grade.graders.map((g) => ({ ...g, passed: true, findings: [] })) }; }
    expect((await record(owner, workspace, forged)).json().results.every((r: { outcome: string }) => r.outcome === "failed")).toBe(true);
    const stillRefused = await save(owner, workspace, reference);
    expect(stillRefused.statusCode).toBe(409);
    expect(stillRefused.json().details.roles.map((r: { reason: string }) => r.reason)).toEqual(["failed", "failed"]);
    expect((await status(owner, workspace)).providerRevision).toBe(0);

    const good = await record(owner, workspace, await report("reference"));
    expect(good.json().results.map((r: { outcome: string }) => r.outcome)).toEqual(["passed", "passed"]);
    const activated = await save(owner, workspace, reference);
    expect(activated.statusCode, activated.body).toBe(200);
    expect(activated.json().evaluation).toEqual({ supervisor: "passed", companion: "passed" });
    const after = await status(owner, workspace);
    expect(after.gatedAtActivation).toBe(true);
    expect(after.roles.map((r: { role: string; status: string; grandfathered: boolean }) => [r.role, r.status, r.grandfathered]))
      .toEqual([["supervisor", "passed", false], ["companion", "passed", false]]);
    expect(after.results[0].failed).toEqual([]);
    expect(after.results.some((r: { outcome: string; failed: { graders: string[] }[] }) => r.outcome === "failed" && r.failed.some((f) => f.graders.includes("hint_leakage")))).toBe(true);
    // Activated: the stored version binds both roles (no credential is stored, so neither is ready).
    expect((await providers.resolve(workspace)).status()).toMatchObject({ companion: { status: "configuration_missing" }, supervisor: { status: "configuration_missing" } });

    // A job-policy-only change keeps both role revisions: no new evaluation needed.
    const policyOnly = await save(owner, workspace, reference, { ...jobPolicy, maxAttempts: 2 });
    expect(policyOnly.statusCode, policyOnly.body).toBe(200);
    expect(policyOnly.json().evaluation).toEqual({ supervisor: "unchanged", companion: "unchanged" });
    expect((await status(owner, workspace)).roles.every((r: { status: string }) => r.status === "passed")).toBe(true);
  });

  it("stale digests are refused: a changed binding, a mismatched report and a changed suite all need new evidence", async () => {
    const workspace = await newWorkspace(), owner = await login("owner", workspace);
    expect((await record(owner, workspace, await report("reference"))).statusCode).toBe(200);
    expect((await save(owner, workspace, reference)).statusCode).toBe(200);
    // Same model, one changed limit: a new companion revision with no result for it.
    const changed = await save(owner, workspace, withCompanionTokens(1500));
    expect(changed.statusCode).toBe(409);
    expect(changed.json().details.roles).toEqual([{ role: "companion", revisionDigest: (await roleRevisions(withCompanionTokens(1500))).companion!.digest, reason: "not_evaluated" }]);
    // A report whose configuration was edited after the run no longer matches its revision digest.
    const edited = await report("reference");
    edited.configuration = withCompanionTokens(1500);
    const mismatch = await record(owner, workspace, edited);
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json()).toMatchObject({ error: "PROVIDER_EVAL_REVISION_MISMATCH", details: { role: "companion" } });
    // A report against another suite digest is refused outright.
    const otherSuite = await report("reference");
    otherSuite.suite.digest = "0".repeat(64);
    expect((await record(owner, workspace, otherSuite)).json()).toMatchObject({ error: "PROVIDER_EVAL_SUITE_STALE", details: { suiteDigest: publicSuite().digest } });
    // Incomplete or malformed reports.
    const missing = await report("reference");
    missing.roles[0]!.dialogues.pop();
    expect((await record(owner, workspace, missing)).json()).toEqual({ error: "PROVIDER_EVAL_REPORT_INCOMPLETE" });
    const secret = await report("reference");
    secret.configuration = { ...reference, adapters: [{ ...reference.adapters[0]!, apiKey: "synthetic" }] };
    expect((await record(owner, workspace, secret)).statusCode).toBe(400);
    expect((await record(owner, workspace, { schema: "nope" })).json()).toEqual({ error: "PROVIDER_EVAL_REPORT_INVALID" });

    // When Core ships a changed suite, earlier results no longer count for new activations, and
    // the active roles show as stale (still active).
    const base = publicSuite(), dialogues = base.dialogues.map((d, i) => i === 0 ? { ...structuredClone(d), description: d.description + " Revised." } : d);
    const newer = new WorkspaceProviders(db, providers.vault, {}, undefined, undefined, buildSuite(base.id, "1.0.1", dialogues));
    const upgraded = await createServer(db, { loginCodes: true, origin, secureCookies: false, workspaceProviders: newer });
    try {
      const view = (await upgraded.inject({ url: evals(workspace), headers: headers(owner) })).json();
      expect(view.suite.digest).not.toBe(base.digest);
      expect(view.roles.map((r: { status: string }) => r.status)).toEqual(["stale", "stale"]);
      expect((await newer.resolve(workspace)).status().companion.status).toBe("configuration_missing");
      const before = (await upgraded.inject({ url: setup(workspace), headers: headers(owner) })).json();
      const r = await upgraded.inject({ method: "POST", url: setup(workspace), headers: headers(owner),
        payload: { expectedRevision: before.revision, idempotencyKey: randomUUID(), configuration: withCompanionTokens(1500), jobPolicy, credentials: {} } });
      expect(r.statusCode).toBe(409);
      expect((await upgraded.inject({ method: "POST", url: evals(workspace) + "/results", headers: headers(owner), payload: { idempotencyKey: randomUUID(), report: await report("reference") } })).json().error)
        .toBe("PROVIDER_EVAL_SUITE_STALE");
    } finally { await upgraded.close(); }
  });

  it("an owner override activates exactly the overridden revision and is listed with its reason", async () => {
    const workspace = await newWorkspace(), owner = await login("owner", workspace), admin = await login("admin", workspace);
    const configuration = { ...reference, roles: { companion: reference.roles.companion } };
    const refused = await save(admin, workspace, configuration);
    const digest = refused.json().details.roles[0].revisionDigest;
    expect((await override(admin, workspace, { role: "companion", revisionDigest: digest })).statusCode).toBe(403);
    expect((await override(owner, workspace, { role: "companion", revisionDigest: digest, reason: "too short" })).json()).toEqual({ error: "PROVIDER_EVAL_OVERRIDE_INVALID" });
    expect((await override(owner, workspace, { role: "companion", revisionDigest: "z".repeat(64) })).statusCode).toBe(400);
    const key = randomUUID(), body = { idempotencyKey: key, role: "companion", revisionDigest: digest, reason: "Accepted after reviewing transcripts from the held-out set." };
    const first = await app.inject({ method: "POST", url: evals(workspace) + "/overrides", headers: headers(owner), payload: body });
    expect(first.statusCode, first.body).toBe(200);
    expect((await app.inject({ method: "POST", url: evals(workspace) + "/overrides", headers: headers(owner), payload: body })).json()).toEqual(first.json());
    expect((await app.inject({ method: "POST", url: evals(workspace) + "/overrides", headers: headers(owner), payload: { ...body, reason: body.reason + " Changed." } })).json())
      .toEqual({ error: "IDEMPOTENCY_CONFLICT" });
    const saved = await save(admin, workspace, configuration);
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().evaluation).toEqual({ companion: "override" });
    const view = await status(admin, workspace);
    expect(view.roles).toEqual([expect.objectContaining({ role: "companion", status: "override", overrideId: first.json().id, grandfathered: false })]);
    expect(view.overrides).toEqual([expect.objectContaining({ id: first.json().id, actorId: owner.id, reason: body.reason, revisionDigest: digest })]);
    // The override does not stretch to another revision.
    expect((await save(admin, workspace, { ...configuration, roles: { companion: { ...configuration.roles.companion, maxInputCharacters: 20000 } } })).statusCode).toBe(409);
  });

  it("result recording is idempotent per key", async () => {
    const workspace = await newWorkspace(), owner = await login("owner", workspace), key = randomUUID();
    const first = await record(owner, workspace, await report("reference"), key);
    expect((await record(owner, workspace, await report("reference"), key)).json()).toEqual(first.json());
    expect((await record(owner, workspace, await report("known-bad"), key)).json()).toEqual({ error: "IDEMPOTENCY_CONFLICT" });
    expect(Number((await db.query("SELECT count(*) FROM provider_eval_results WHERE workspace_id=$1", [workspace])).rows[0].count)).toBe(2);
  });

  it("every role is gated: the tool loop, research, reviewer and media need evidence too, and a scripted pass for each activates them", async () => {
    const workspace = await newWorkspace(), owner = await login("owner", workspace);
    const all = scriptedConfiguration("reference", "all");
    const refused = await save(owner, workspace, all);
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().details.roles.map((r: { role: string; reason: string }) => [r.role, r.reason]))
      .toEqual([["supervisor", "not_evaluated"], ["companion", "not_evaluated"], ["research", "not_evaluated"], ["media", "not_evaluated"], ["reviewer", "not_evaluated"]]);
    const { scripted, configuration, runtime } = scriptedRuntime("reference", PUBLIC_SCRIPTED_MODELS.reference, "all");
    const run = await runSuite({ suite: publicSuite(), configuration, runtime, mode: "scripted", model: "reference", beforeDialogue: (d) => { scripted.current = d.id; } });
    const recorded = await record(owner, workspace, run);
    expect(recorded.statusCode, recorded.body).toBe(200);
    expect(recorded.json().results.map((r: { role: string; outcome: string }) => [r.role, r.outcome]))
      .toEqual([["companion", "passed"], ["supervisor", "passed"], ["research", "passed"], ["reviewer", "passed"], ["media", "passed"]]);
    const saved = await save(owner, workspace, all);
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().evaluation).toEqual({ supervisor: "passed", companion: "passed", research: "passed", media: "passed", reviewer: "passed" });
    expect((await status(owner, workspace)).roles.map((r: { role: string; strategy: string; covered: boolean; status: string }) => [r.role, r.strategy, r.covered, r.status]))
      .toEqual([["supervisor", "core.supervisor.tool-loop", true, "passed"], ["companion", "core.companion.tutor", true, "passed"],
        ["research", "core.research.public-topic", true, "passed"], ["media", "core.media.image", true, "passed"], ["reviewer", "core.reviewer.rubric-assist", true, "passed"]]);
    // A known-bad tool loop, research or reviewer answer is recorded as failed and cannot activate a changed revision.
    const bad = scriptedRuntime("reference", PUBLIC_SCRIPTED_MODELS["known-bad"], "all");
    const failedRun = await runSuite({ suite: publicSuite(), configuration: bad.configuration, runtime: bad.runtime, mode: "scripted", model: "reference",
      beforeDialogue: (d) => { bad.scripted.current = d.id; } });
    const failed = await record(owner, workspace, failedRun);
    expect(failed.json().results.filter((r: { outcome: string }) => r.outcome === "failed").map((r: { role: string }) => r.role)).toEqual(["companion", "supervisor", "research", "reviewer"]);
  });

  it("a role bound to a strategy the suite does not cover activates only with an owner's override of that exact revision", async () => {
    const workspace = await newWorkspace(), owner = await login("owner", workspace);
    // A suite without media dialogues: the media role is not covered.
    const base = publicSuite(), noMedia = buildSuite(base.id, "2.0.1", base.dialogues.filter((d) => d.role !== "media"));
    const partial = new WorkspaceProviders(db, providers.vault, {}, undefined, undefined, noMedia);
    const server = await createServer(db, { loginCodes: true, origin, secureCookies: false, workspaceProviders: partial });
    try {
      const all = scriptedConfiguration("reference", "all");
      const media = { ...all, roles: { media: all.roles.media } };
      const before = (await server.inject({ url: setup(workspace), headers: headers(owner) })).json();
      const refused = await server.inject({ method: "POST", url: setup(workspace), headers: headers(owner),
        payload: { expectedRevision: before.revision, idempotencyKey: randomUUID(), configuration: media, jobPolicy, credentials: {} } });
      expect(refused.statusCode).toBe(409);
      expect(refused.json().details.roles).toEqual([expect.objectContaining({ role: "media", reason: "not_covered" })]);
      const approved = await server.inject({ method: "POST", url: evals(workspace) + "/overrides", headers: headers(owner),
        payload: { idempotencyKey: randomUUID(), role: "media", revisionDigest: refused.json().details.roles[0].revisionDigest, reason: "Owner reviewed the media prompts by hand for this revision." } });
      expect(approved.statusCode, approved.body).toBe(200);
      const saved = await server.inject({ method: "POST", url: setup(workspace), headers: headers(owner),
        payload: { expectedRevision: before.revision, idempotencyKey: randomUUID(), configuration: media, jobPolicy, credentials: {} } });
      expect(saved.statusCode, saved.body).toBe(200);
      expect(saved.json().evaluation).toEqual({ media: "override" });
      expect((await server.inject({ url: evals(workspace), headers: headers(owner) })).json().roles).toEqual([expect.objectContaining({ role: "media", covered: false, status: "override" })]);
    } finally { await server.close(); }
  });

  it("grandfathers provider versions saved before the gate: still active, shown as not evaluated, gated on change", async () => {
    const workspace = await newWorkspace(), owner = await login("owner", workspace);
    // A version as an upgraded deployment has it: written before migration 083, so evaluation is NULL.
    await db.query("INSERT INTO workspace_provider_versions(workspace_id,revision,configuration,job_policy,sealed_credentials,changed_by) VALUES($1,1,$2,$3,'{}',$4)",
      [workspace, JSON.stringify(reference), JSON.stringify(jobPolicy), owner.id]);
    await db.query("INSERT INTO workspace_provider_settings(workspace_id,revision) VALUES($1,1)", [workspace]);
    const view = await status(owner, workspace);
    expect(view.gatedAtActivation).toBe(false);
    expect(view.roles.map((r: { role: string; status: string; grandfathered: boolean }) => [r.role, r.status, r.grandfathered]))
      .toEqual([["supervisor", "not_evaluated", true], ["companion", "not_evaluated", true]]);
    expect(Object.keys((await providers.resolve(workspace)).roleModels())).toEqual(["companion", "supervisor"]);
    // Unrelated changes (job policy, credentials) keep the grandfathered roles.
    const policy = await save(owner, workspace, reference, { ...jobPolicy, maxAttempts: 2 });
    expect(policy.statusCode, policy.body).toBe(200);
    expect(policy.json().evaluation).toEqual({ supervisor: "unchanged", companion: "unchanged" });
    expect((await status(owner, workspace)).roles.map((r: { grandfathered: boolean; status: string }) => [r.status, r.grandfathered]))
      .toEqual([["not_evaluated", true], ["not_evaluated", true]]);
    // Changing a role's model is a new revision and needs evidence.
    const changed = await save(owner, workspace, withCompanionTokens(1500));
    expect(changed.statusCode).toBe(409);
    expect(changed.json().details.roles.map((r: { role: string }) => r.role)).toEqual(["companion"]);
    // A recorded pass for the unchanged revision upgrades its status without a new activation.
    await record(owner, workspace, await report("reference"));
    expect((await status(owner, workspace)).roles.map((r: { status: string; grandfathered: boolean }) => [r.status, r.grandfathered]))
      .toEqual([["passed", true], ["passed", true]]);
  });
});
