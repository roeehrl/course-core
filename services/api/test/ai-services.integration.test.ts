import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { compileCourse } from "@course-core/sdk/compiler";
import { createDatabase, transaction, type Database } from "../src/database.js";
import { createTestDatabase, type TestDatabase } from "./test-database.js";
import { createServer } from "../src/server.js";
import { issueLoginCode } from "../src/auth.js";
import { credentialVault } from "../src/key-vault.js";
import { WorkspaceProviders, type KeyTestLimits } from "../src/provider-setup.js";
import { googleMetadataAdapter } from "../src/provider-metadata.js";
import { lockPaidWorkBudgets } from "../src/supervisor-bridge.js";
import { initialPolicy } from "../src/policy-adapter.js";
import { fixture } from "./fixture.js";
import { googleError, metadataStub, type StubReply } from "./metadata-stub-server.js";

// The "AI services" admin API end to end over HTTP and real PostgreSQL: connections with a
// server-named key slot, model suggestions, setup drafts with owner approval by draft and role,
// pricing a draft model, and the workspace default limit for each learner. The Google metadata
// adapter talks to a loopback stub; no provider is contacted and nothing is generated.
const schema = "ai_services_" + randomUUID().replaceAll("-", ""),
  workspace = randomUUID(),
  origin = "http://localhost:4310",
  goodKey = ["SYNTHETIC", "AI", "SERVICES", "KEY", "7Q2c"].join("_"),
  shortKey = "SHORT_KEY_9",
  rejectedKey = ["SYNTHETIC", "REJECTED", "KEY", "CANARY"].join("_");
const catalog = {
  models: [
    {
      name: "models/gemini-9.0-flash",
      displayName: "Gemini 9 Flash",
      inputTokenLimit: 1048576,
      outputTokenLimit: 8192,
      supportedGenerationMethods: ["generateContent"],
    },
    {
      name: "models/gemini-9.0-flash-lite",
      displayName: "Gemini 9 Flash Lite",
      inputTokenLimit: 1048576,
      outputTokenLimit: 8192,
      supportedGenerationMethods: ["generateContent"],
    },
    {
      name: "models/gemini-8.5-flash",
      displayName: "Gemini 8.5 Flash",
      inputTokenLimit: 1048576,
      outputTokenLimit: 8192,
      supportedGenerationMethods: ["generateContent"],
    },
    {
      name: "models/gemini-9.0-pro-preview",
      displayName: "Gemini 9 Pro Preview",
      inputTokenLimit: 1048576,
      outputTokenLimit: 8192,
      supportedGenerationMethods: ["generateContent"],
    },
    {
      name: "models/gemini-8.5-pro",
      displayName: "Gemini 8.5 Pro",
      inputTokenLimit: 1048576,
      outputTokenLimit: 8192,
      supportedGenerationMethods: ["generateContent"],
    },
  ],
};
let db: Database,
  app: Awaited<ReturnType<typeof createServer>>,
  stub: Awaited<ReturnType<typeof metadataStub>>,
  owner: Session,
  admin: Session,
  testDatabase: TestDatabase | undefined;
interface Session {
  id: string;
  cookie: string;
  csrf: string;
}
const script = (key: string): StubReply =>
  key === rejectedKey
    ? { status: 400, body: googleError(400, "INVALID_ARGUMENT", "API_KEY_INVALID") }
    : { status: 200, body: catalog };
const limits: KeyTestLimits = { timeoutMs: 2000, perMinute: 100, perHour: 100, concurrent: 2 };
const printed: string[] = [];
const bodies: string[] = [];
const headers = (s: Session) => ({ cookie: s.cookie, origin, "x-csrf-token": s.csrf }),
  base = `/api/admin/workspaces/${workspace}/provider-setup`;
async function login(role: string) {
  const id = randomUUID();
  await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [id, "test:" + id, "AI services " + role]);
  await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)", [workspace, id, role]);
  const r = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, id) } });
  expect(r.statusCode).toBe(200);
  return { id, cookie: r.cookies.map((c) => `${c.name}=${c.value}`).join("; "), csrf: r.json().csrfToken };
}
async function call(s: Session, method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown) {
  const r = await app.inject({ method, url, headers: headers(s), ...(payload === undefined ? {} : { payload: payload as object }) });
  bodies.push(r.body);
  return r;
}
const key = () => "ai-services:" + randomUUID();
async function revision() {
  return (await call(owner, "GET", base)).json().revision as number;
}
async function seedEnrollment() {
  const userId = randomUUID(), enrollmentId = randomUUID(), releaseId = randomUUID();
  const course = compileCourse(fixture());
  await db.query("INSERT INTO app_users (id,subject,display_name) VALUES ($1,$2,$3)", [userId, `synthetic:${userId}`, "Synthetic learner"]);
  await db.query(
    `INSERT INTO course_releases (id,workspace_id,course_key,version,digest,server_bundle,learner_bundle,status,created_by)
     VALUES ($1,$2,$3,'1.0.0',$4,$5,$6,'published',$7)`,
    [releaseId, workspace, course.server.id + "-" + releaseId.slice(0, 8), course.digest, JSON.stringify(course.server), JSON.stringify(course.learner), userId],
  );
  await db.query("INSERT INTO memberships (workspace_id,user_id,role) VALUES ($1,$2,'learner')", [workspace, userId]);
  const policy = initialPolicy(course.server, enrollmentId, userId, new Date().toISOString());
  await db.query("INSERT INTO enrollments (id,workspace_id,course_release_id,user_id,policy,current_episode_id) VALUES ($1,$2,$3,$4,$5,'min')", [
    enrollmentId, workspace, releaseId, userId, JSON.stringify(course.server.policy),
  ]);
  await db.query("INSERT INTO policy_states (enrollment_id,policy_revision,ledger_revision,snapshot) VALUES ($1,1,0,$2)", [enrollmentId, JSON.stringify(policy)]);
  return enrollmentId;
}
async function available(enrollmentId: string) {
  return transaction(db, (client) => lockPaidWorkBudgets(client, { workspaceId: workspace, enrollmentId }));
}

beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  stub = await metadataStub((request) => script(String(request.headers["x-goog-api-key"] ?? "")));
  const service = new WorkspaceProviders(db, credentialVault(randomBytes(32)), {}, undefined, { google: googleMetadataAdapter(stub.fetch) }, undefined, limits);
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false, workspaceProviders: service });
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspace, "ai-" + workspace, "AI services workspace"]);
  owner = await login("owner");
  admin = await login("admin");
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream);
    vi.spyOn(stream, "write").mockImplementation(((chunk: unknown, ...rest: never[]) => {
      printed.push(String(chunk));
      return write(chunk as string, ...rest);
    }) as typeof stream.write);
  }
}, 30000);
afterAll(async () => {
  vi.restoreAllMocks();
  await app?.close();
  await stub?.close();
  await db?.end();
  await testDatabase?.drop();
});

describe("AI services", () => {
  let connectionId = "";
  it("lists the owner's workspace in the session before any course exists", async () => {
    const session = (await call(owner, "GET", "/api/admin/session")).json();
    expect(session.courses).toEqual([]);
    expect(session.workspaces).toEqual([{ id: workspace, title: "AI services workspace", role: "owner" }]);
  });

  it("refuses a rejected key with its reason and stores nothing", async () => {
    const r = await call(owner, "POST", base + "/connections", { expectedRevision: 0, idempotencyKey: key(), kind: "google", key: rejectedKey });
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toBe("PROVIDER_METADATA_KEY_INVALID");
    expect((await call(owner, "GET", base + "/connections")).json().connections).toEqual([]);
    expect(await revision()).toBe(0);
    const empty = await call(owner, "POST", base + "/connections", { expectedRevision: 0, idempotencyKey: key(), kind: "google", key: "  \n " });
    expect(empty.statusCode).toBe(400);
    expect(empty.json().error).toBe("PROVIDER_CREDENTIAL_EMPTY");
  });

  it("tests and saves a key under a server-named slot and shows only its last four characters", async () => {
    const idempotency = key();
    const r = await call(owner, "POST", base + "/connections", {
      expectedRevision: 0, idempotencyKey: idempotency, kind: "google", key: `  ${goodKey}\n`, name: "Google – school account",
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().connection).toMatchObject({ kind: "google", keyEnding: "7Q2c", keyStatus: "working" });
    connectionId = r.json().connection.id;
    expect(connectionId).toMatch(/^connection-[0-9a-f]{8}$/);
    // A repeated request returns the same receipt without a second connection.
    const again = await call(owner, "POST", base + "/connections", {
      expectedRevision: 0, idempotencyKey: idempotency, kind: "google", key: `  ${goodKey}\n`, name: "Google – school account",
    });
    expect(again.json()).toEqual(r.json());
    const list = (await call(owner, "GET", base + "/connections")).json();
    expect(list.connections).toEqual([
      expect.objectContaining({ id: connectionId, label: "Google", name: "Google – school account", keyEnding: "7Q2c", keyStatus: "working", keyStored: true, usedByRoles: [] }),
    ]);
    const setup = (await call(owner, "GET", base)).json();
    expect(setup.configuration.adapters[0].credentialEnv).toMatch(/^COURSE_PROVIDER_[0-9A-F]{16}_API_KEY$/);
    expect(setup.metadataKinds[0]).toMatchObject({ pricingUrl: expect.stringMatching(/^https:\/\//), keyHelpUrl: expect.stringMatching(/^https:\/\//) });
  });

  it("never shows the ending of a short key", async () => {
    const r = await call(owner, "POST", base + "/connections", { expectedRevision: await revision(), idempotencyKey: key(), kind: "google", key: shortKey });
    expect(r.statusCode).toBe(200);
    expect(r.json().connection.keyEnding).toBeNull();
    const removed = await call(owner, "DELETE", base + "/connections/" + r.json().connection.id, { expectedRevision: await revision(), idempotencyKey: key() });
    expect(removed.statusCode).toBe(200);
    expect((await call(owner, "GET", base + "/connections")).json().connections).toHaveLength(1);
  });

  it("suggests the newest stable model per job from the key's model list", async () => {
    const r = await call(owner, "GET", `${base}/connections/${connectionId}/models`);
    expect(r.statusCode).toBe(200);
    const roles = Object.fromEntries(r.json().roles.map((x: { role: string }) => [x.role, x]));
    expect(roles.companion).toMatchObject({ needed: true, suggested: "gemini-9.0-flash" });
    expect(roles.supervisor).toMatchObject({ needed: true, suggested: "gemini-9.0-flash" });
    expect(roles.reviewer).toMatchObject({ needed: false, suggested: "gemini-8.5-pro" });
    expect(roles.media).toMatchObject({ needed: false, suggested: null, offered: true });
  });

  let draftId = "";
  it("builds a draft from model choices that waits for a check on the tutor", async () => {
    const r = await call(owner, "POST", base + "/drafts", {
      baseRevision: await revision(),
      assignments: {
        companion: { connectionId, remoteModel: "gemini-9.0-flash" },
        supervisor: { connectionId, remoteModel: "gemini-9.0-flash" },
      },
    });
    expect(r.statusCode).toBe(200);
    const draft = r.json();
    draftId = draft.id;
    expect(draft.secretsIncluded).toBe(false);
    // Every role is gated on an evaluated revision (N07): the supervisor's tool loop too.
    expect(draft.waitingForCheck).toEqual(["companion", "supervisor"]);
    expect(draft.roles.map((x: { role: string; check: string; priced: boolean }) => [x.role, x.check, x.priced])).toEqual([
      ["companion", "needed", false],
      ["supervisor", "needed", false],
    ]);
    expect((await call(owner, "GET", base + "/drafts/current")).json().draft.id).toBe(draftId);
  });

  it("prices a draft model before activation", async () => {
    const view = (await call(owner, "GET", `/api/admin/workspaces/${workspace}/provider-pricing`)).json();
    const draftModel = view.models.find((m: { modelId: string }) => m.modelId === `${connectionId}:companion`);
    expect(draftModel).toMatchObject({ configured: false, draft: true, roles: ["companion"] });
    for (const role of ["companion", "supervisor"]) {
      const r = await call(owner, "POST", `/api/admin/workspaces/${workspace}/provider-pricing`, {
        idempotencyKey: key(), modelId: `${connectionId}:${role}`, expectedVersion: 0, status: "active", currency: "USD",
        inputMicroUsdPerMillionTokens: 300000, outputMicroUsdPerMillionTokens: 2500000, cachedInputMicroUsdPerMillionTokens: null,
        microUsdPerRequest: null, microUsdPerOutputSecond: null, effectiveFrom: new Date().toISOString(), sourceNote: "Google pricing page, read today",
      });
      expect(r.statusCode).toBe(200);
    }
    const draft = (await call(owner, "GET", base + "/drafts/current")).json().draft;
    expect(draft.roles.every((x: { priced: boolean }) => x.priced)).toBe(true);
  });

  it("keeps the quality-check gate at activation; only an owner approves by draft and job", async () => {
    const current = await revision();
    const refused = await call(owner, "POST", `${base}/drafts/${draftId}/activate`, { expectedRevision: current, idempotencyKey: key(), confirmCancelRunning: false });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe("PROVIDER_EVAL_REQUIRED");
    const reason = "Tested by hand in our synthetic pilot workspace.";
    const byAdmin = await call(admin, "POST", `/api/admin/workspaces/${workspace}/provider-evals/overrides`, { idempotencyKey: key(), draftId, role: "companion", reason });
    expect(byAdmin.statusCode).toBe(403);
    const tooShort = await call(owner, "POST", `/api/admin/workspaces/${workspace}/provider-evals/overrides`, { idempotencyKey: key(), draftId, role: "companion", reason: "short" });
    expect(tooShort.statusCode).toBe(400);
    const approved = await call(owner, "POST", `/api/admin/workspaces/${workspace}/provider-evals/overrides`, { idempotencyKey: key(), draftId, role: "companion", reason });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().revisionDigest).toMatch(/^[a-f0-9]{64}$/);
    expect((await call(owner, "POST", `/api/admin/workspaces/${workspace}/provider-evals/overrides`, { idempotencyKey: key(), draftId, role: "supervisor", reason })).statusCode).toBe(200);
    expect((await call(owner, "GET", base + "/drafts/current")).json().draft.waitingForCheck).toEqual([]);
    const stale = await call(owner, "POST", `${base}/drafts/${draftId}/activate`, { expectedRevision: current - 1, idempotencyKey: key(), confirmCancelRunning: false });
    expect(stale.json().error).toBe("STALE_PROVIDER_REVISION");
    const activated = await call(owner, "POST", `${base}/drafts/${draftId}/activate`, { expectedRevision: current, idempotencyKey: key(), confirmCancelRunning: false });
    expect(activated.statusCode).toBe(200);
    expect(activated.json()).toMatchObject({ revision: current + 1, evaluation: { companion: "override", supervisor: "override" } });
    expect((await call(owner, "GET", base + "/drafts/current")).json().draft).toBeNull();
    expect((await call(owner, "GET", base + "/connections")).json().connections[0].usedByRoles).toEqual(["companion", "supervisor"]);
  });

  it("refuses to remove a connection a job uses, naming the jobs", async () => {
    const r = await call(owner, "DELETE", `${base}/connections/${connectionId}`, { expectedRevision: await revision(), idempotencyKey: key() });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: "PROVIDER_CONNECTION_IN_USE", details: { roles: ["companion", "supervisor"] } });
  });

  it("replaces a key in the same slot without changing the jobs or their check", async () => {
    const before = (await call(owner, "GET", base)).json();
    const replacement = goodKey.replace("7Q2c", "8R3d");
    const r = await call(owner, "PUT", `${base}/connections/${connectionId}/key`, { expectedRevision: before.revision, idempotencyKey: key(), key: replacement });
    expect(r.statusCode).toBe(200);
    expect(r.json().connection.keyEnding).toBe("8R3d");
    const after = (await call(owner, "GET", base)).json();
    expect(after.configuration).toEqual(before.configuration);
    expect(after.revision).toBe(before.revision + 1);
    const tested = await call(owner, "POST", `${base}/connections/${connectionId}/test`, {});
    expect(tested.json()).toMatchObject({ outcome: "ok", keyStatus: "working" });
  });

  it("sends the developer JSON editor through the same draft, gate and activation", async () => {
    const setup = (await call(owner, "GET", base)).json();
    const configuration = structuredClone(setup.configuration);
    configuration.roles.companion.maxOutputTokens = 900;
    const draft = await call(owner, "POST", base + "/drafts/json", { baseRevision: setup.revision, configuration, jobPolicy: setup.jobPolicy });
    expect(draft.statusCode).toBe(200);
    expect(draft.json().waitingForCheck).toEqual(["companion"]);
    const refused = await call(owner, "POST", `${base}/drafts/${draft.json().id}/activate`, { expectedRevision: setup.revision, idempotencyKey: key(), confirmCancelRunning: false });
    expect(refused.json().error).toBe("PROVIDER_EVAL_REQUIRED");
    const secretLike = await call(owner, "POST", base + "/drafts/json", {
      baseRevision: setup.revision, configuration: { ...configuration, registry: { ...configuration.registry, apiKey: "x" } }, jobPolicy: setup.jobPolicy,
    });
    expect(secretLike.json().error).toBe("PROVIDER_SECRET_FIELD_FORBIDDEN");
    expect((await call(owner, "DELETE", base + "/drafts/current")).json()).toEqual({ discarded: true });
  });

  it("saves money-only limits and a default limit for each learner that new learners get", async () => {
    const enrollment = await seedEnrollment();
    const budgets = (await call(owner, "GET", base + "/budgets")).json();
    expect(budgets.defaultEnrollment).toEqual({ revision: 0, mode: "unset", limit_micro_usd: null, limit_tokens: null });
    // Without consent a positive limit is refused.
    const noConsent = await call(owner, "POST", base + "/budgets", { expectedRevision: 0, idempotencyKey: key(), scope: "default_enrollment", limits: { microUsd: 2000000 }, paidWorkApproved: false });
    expect(noConsent.json().error).toBe("PAID_WORK_CONSENT_REQUIRED");
    const total = await call(owner, "POST", base + "/budgets", { expectedRevision: 0, idempotencyKey: key(), limits: { microUsd: 25000000 }, paidWorkApproved: true });
    expect(total.json()).toMatchObject({ scope: "workspace", limits: { microUsd: 25000000, tokens: 1000000000 }, consentRecorded: true });
    // Before a default is set, a learner without an own limit has none: paid work is refused.
    expect((await available(enrollment)).microUsd).toBe(0);
    const perLearner = await call(owner, "POST", base + "/budgets", { expectedRevision: 0, idempotencyKey: key(), scope: "default_enrollment", limits: { microUsd: 2000000 }, paidWorkApproved: true });
    expect(perLearner.json()).toMatchObject({ scope: "default_enrollment", revision: 1, limits: { microUsd: 2000000, tokens: 1000000000 } });
    expect(await available(enrollment)).toEqual({ microUsd: 2000000, tokens: 1000000000 });
    // A learner who joins later gets the default too.
    const later = await seedEnrollment();
    expect((await available(later)).microUsd).toBe(2000000);
    const view = (await call(owner, "GET", base + "/budgets")).json();
    expect(view.defaultEnrollment).toEqual({ revision: 1, mode: "limit", limit_micro_usd: "2000000", limit_tokens: "1000000000" });
    expect(view.enrollments.find((e: { enrollmentId: string }) => e.enrollmentId === later)).toMatchObject({ limitSource: "default", limit_micro_usd: "2000000" });
    // An own limit (even zero) wins over the default.
    const own = await call(owner, "POST", base + "/budgets", { expectedRevision: 0, idempotencyKey: key(), enrollmentId: later, limits: { microUsd: 0, tokens: 0 }, paidWorkApproved: false });
    expect(own.json().scope).toBe("enrollment");
    expect((await available(later)).microUsd).toBe(0);
    expect((await available(enrollment)).microUsd).toBe(2000000);
    const stale = await call(owner, "POST", base + "/budgets", { expectedRevision: 0, idempotencyKey: key(), scope: "default_enrollment", limits: { microUsd: 1000000 }, paidWorkApproved: true });
    expect(stale.json().error).toBe("STALE_PROVIDER_BUDGET_REVISION");
  });

  it("keeps a service key (YouTube search) without a free-text slot name", async () => {
    const r = await call(owner, "PUT", `${base}/service-keys/youtube`, { expectedRevision: await revision(), idempotencyKey: key(), key: "synthetic-youtube-service-key" });
    expect(r.statusCode).toBe(200);
    expect((await call(owner, "GET", base + "/connections")).json().serviceKeys).toEqual([{ id: "youtube", configured: true }]);
    const unknown = await call(owner, "PUT", `${base}/service-keys/other`, { expectedRevision: await revision(), idempotencyKey: key(), key: "x" });
    expect(unknown.statusCode).toBe(404);
  });

  it("never returns, logs, audits or drafts a key", async () => {
    const audit = (await db.query("SELECT payload::text FROM learning_events WHERE workspace_id=$1", [workspace])).rows.map((r) => r.payload).join("\n");
    const stored = (await db.query("SELECT result::text FROM provider_setup_receipts WHERE workspace_id=$1", [workspace])).rows.map((r) => r.result).join("\n");
    const versions = (await db.query("SELECT configuration::text||sealed_credentials::text AS v FROM workspace_provider_versions WHERE workspace_id=$1", [workspace])).rows.map((r) => r.v).join("\n");
    const connections = (await db.query("SELECT row_to_json(c)::text AS v FROM workspace_provider_connections c")).rows.map((r) => r.v).join("\n");
    for (const secret of [goodKey, goodKey.replace("7Q2c", "8R3d"), shortKey, rejectedKey, "synthetic-youtube-service-key"])
      for (const text of [bodies.join("\n"), printed.join(""), audit, stored, versions, connections]) expect(text).not.toContain(secret);
    const types = (await db.query("SELECT event_type FROM learning_events WHERE workspace_id=$1", [workspace])).rows.map((r) => r.event_type);
    expect(types).toEqual(expect.arrayContaining(["provider.connection.added", "provider.connection.key_replaced", "provider.connection.removed", "provider.setup.activated", "provider.key_tested"]));
  });
});
