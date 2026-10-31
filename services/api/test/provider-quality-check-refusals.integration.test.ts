import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type Database } from "../src/database.js";
import { createTestDatabase, type TestDatabase } from "./test-database.js";
import { createServer } from "../src/server.js";
import { issueLoginCode } from "../src/auth.js";
import { credentialVault } from "../src/key-vault.js";
import { WorkspaceProviders, defaultJobPolicy } from "../src/provider-setup.js";
import { googleAdapterFactory } from "../src/provider-composition.js";

// Quality checks on a Gemini setup, over HTTP and real PostgreSQL, with the real Google adapter
// and a local `fetch` that answers like generateContent (success and Google's documented error
// bodies). No provider is contacted and no key exists. What is proven: the request shape the
// supervisor sends, and the reason a stopped check records and shows; not any model's quality.
const schema = "quality_refusals_" + randomUUID().replaceAll("-", ""), origin = "http://localhost:4310";
let db: Database, testDatabase: TestDatabase | undefined, app: Awaited<ReturnType<typeof createServer>>;
interface Session { id: string; cookie: string; csrf: string }
const jobPolicy = { ...defaultJobPolicy, allowance: { microUsd: 100000, tokens: 1_000_000 } };
const CREDENTIAL = "COURSE_PROVIDER_GOOGLE_REFUSAL_API_KEY", SECRET = "offline-google-refusal-key";
const binding = { modelId: "gemini-check", maxInputCharacters: 30000, maxOutputTokens: 4000 };
const configuration = {
  registry: { revision: "google-refusals", models: [{ id: "gemini-check", providerId: "google-check", remoteModel: "gemini-3.8-flash", enabled: true,
    capabilities: ["tutoring", "structured_assessment"], tools: [], limits: { maxInputCharacters: 100000, maxOutputTokens: 4000 },
    providerConfig: { transport: "generate_content", apiVersion: "v1beta", maxResponseBytes: 1000000, thinking: { level: "medium" } } }] },
  adapters: [{ id: "google-check", kind: "google", credentialEnv: CREDENTIAL }],
  roles: { companion: { ...binding }, supervisor: { ...binding, maxToolRounds: 4 } },
};

/** Echoed request data in Google's `message`, which must never be stored or shown. */
const ECHO = "Invalid value at 'generation_config' private-echo";
const googleError = (code: number, status: string, details: unknown[] = []) =>
  new Response(JSON.stringify({ error: { code, status, message: ECHO, details } }), { status: code, headers: { "content-type": "application/json" } });
const info = (reason: string) => ({ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason, domain: "googleapis.com" });
const quota = (quotaId: string) => ({ "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId }] });
const answer = (text: string) => new Response(JSON.stringify({ candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ text }] } }],
  usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 40, totalTokenCount: 340 } }), { status: 200, headers: { "content-type": "application/json" } });

/** What the local Gemini does: behave like Google (refuse the old structured-output shape), or refuse every call with one error. */
let refusal: (() => Response) | null = null, structuredRefusal: (() => Response) | null = null;
const bodies: Record<string, unknown>[] = [];
const googleFetch = (async (_input: string, init: RequestInit) => {
  const body = JSON.parse(String(init.body)) as { generationConfig?: Record<string, unknown> };
  bodies.push(body);
  if (refusal) return refusal();
  const generation = body.generationConfig ?? {};
  if (structuredRefusal && generation.responseJsonSchema) return structuredRefusal();
  // Google's answer to the shape Core sent before: responseFormat.text.mimeType is an enum.
  if (generation.responseFormat) return googleError(400, "INVALID_ARGUMENT", [{ "@type": "type.googleapis.com/google.rpc.BadRequest" }]);
  if (generation.responseMimeType === "application/json")
    return answer(JSON.stringify({ decision: "finish", tool: "none", argumentsJson: "{}", summary: "No change is needed for this learner now." }));
  return answer("Let's look at the first step together: what does the question ask you to compare?");
}) as typeof globalThis.fetch;

const headers = (s: Session) => ({ cookie: s.cookie, origin, "x-csrf-token": s.csrf });
const setup = (w: string) => `/api/admin/workspaces/${w}/provider-setup`;
const checks = (w: string) => `${setup(w)}/quality-check`;
const key = () => "quality-check:" + randomUUID();
const call = (s: Session, method: "GET" | "POST", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: headers(s), ...(payload === undefined ? {} : { payload: payload as object }) });
async function prepared() {
  const workspace = randomUUID(), owner = randomUUID();
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [workspace, "qr-" + workspace, "Refusals"]);
  await db.query("INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)", [owner, "test:" + owner, "Refusals owner"]);
  await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'owner')", [workspace, owner]);
  const r = await app.inject({ method: "POST", url: "/auth/redeem", headers: { origin }, payload: { token: await issueLoginCode(db, owner) } });
  expect(r.statusCode).toBe(200);
  const session: Session = { id: owner, cookie: r.cookies.map((c) => `${c.name}=${c.value}`).join("; "), csrf: r.json().csrfToken };
  const saved = await call(session, "POST", setup(workspace), { expectedRevision: 0, idempotencyKey: key(),
    configuration: { ...configuration, roles: {} }, jobPolicy, credentials: { [CREDENTIAL]: SECRET } });
  expect(saved.statusCode, saved.body).toBe(200);
  const draft = await call(session, "POST", setup(workspace) + "/drafts/json", { baseRevision: 1, configuration, jobPolicy });
  expect(draft.statusCode, draft.body).toBe(200);
  const priced = await call(session, "POST", `/api/admin/workspaces/${workspace}/provider-pricing`, { idempotencyKey: key(), modelId: "gemini-check",
    expectedVersion: 0, status: "active", currency: "USD", inputMicroUsdPerMillionTokens: 1_000_000, outputMicroUsdPerMillionTokens: 5_000_000,
    cachedInputMicroUsdPerMillionTokens: null, microUsdPerRequest: null, microUsdPerOutputSecond: null, effectiveFrom: new Date().toISOString(),
    sourceNote: "Synthetic test price" });
  expect(priced.statusCode, priced.body).toBe(200);
  const budgets = (await call(session, "GET", setup(workspace) + "/budgets")).json();
  const limited = await call(session, "POST", setup(workspace) + "/budgets", { expectedRevision: budgets.workspace.revision, idempotencyKey: key(),
    limits: { microUsd: 50_000_000 }, paidWorkApproved: true });
  expect(limited.statusCode, limited.body).toBe(200);
  return { workspace, session, draftId: draft.json().id as string };
}
async function run() {
  const { workspace, session, draftId } = await prepared();
  const started = await call(session, "POST", checks(workspace), { idempotencyKey: key(), draftId });
  expect(started.statusCode, started.body).toBe(200);
  for (let i = 0; i < 400; i++) {
    const r = await call(session, "GET", `${checks(workspace)}/${started.json().id}`);
    expect(r.statusCode, r.body).toBe(200);
    if (r.json().state !== "running") {
      const row = (await db.query("SELECT reason_code,reason_detail FROM provider_quality_checks WHERE id=$1", [started.json().id])).rows[0];
      const events = (await db.query("SELECT payload FROM learning_events WHERE workspace_id=$1 AND event_type='provider.quality_check.finished'", [workspace])).rows;
      expect(events).toHaveLength(1);
      return { check: r.json(), row, events, workspace };
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("The check did not finish");
}

beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  const providers = new WorkspaceProviders(db, credentialVault(randomBytes(32)), { google: googleAdapterFactory(googleFetch) });
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false, workspaceProviders: providers, qualityChecks: { perHour: 20 } });
}, 30000);
afterAll(async () => {
  await app?.close();
  await db?.end();
  await testDatabase?.drop();
});

describe("quality check on Gemini", () => {
  it("sends the supervisor's structured output as responseMimeType + responseJsonSchema, so Google does not refuse it", async () => {
    refusal = null;
    bodies.length = 0;
    const { check } = await run();
    // Every conversation ran and was graded: no provider fault stopped the check.
    expect(check.state === "passed" || check.state === "failed", JSON.stringify(check)).toBe(true);
    expect(check.reason).toBeNull();
    expect(check.reasonDetail).toBeNull();
    expect(check.completed).toBe(check.total);
    const structured = bodies.filter((b) => (b.generationConfig as Record<string, unknown>).responseJsonSchema);
    expect(structured.length).toBeGreaterThanOrEqual(2);
    for (const b of bodies) expect((b.generationConfig as Record<string, unknown>).responseFormat).toBeUndefined();
    for (const b of structured) expect((b.generationConfig as Record<string, unknown>).responseMimeType).toBe("application/json");
  }, 60000);

  it("names the supervisor and keeps Google's reason when only its structured request is refused", async () => {
    structuredRefusal = () => googleError(400, "INVALID_ARGUMENT", [{ "@type": "type.googleapis.com/google.rpc.BadRequest" }]);
    const { check, row } = await run();
    structuredRefusal = null;
    const expected = { role: "supervisor", providerCode: "UPSTREAM_REJECTED", status: 400, providerReason: "INVALID_ARGUMENT" };
    expect(check).toMatchObject({ state: "error", reason: "PROVIDER_REQUEST_REJECTED", reasonDetail: expected });
    expect(check.completed).toBe(check.total - 1);
    expect(row).toEqual({ reason_code: "PROVIDER_REQUEST_REJECTED", reason_detail: expected });
  }, 60000);

  it.each([
    ["400 INVALID_ARGUMENT", () => googleError(400, "INVALID_ARGUMENT", [{ "@type": "type.googleapis.com/google.rpc.BadRequest" }]),
      "PROVIDER_REQUEST_REJECTED", { providerCode: "UPSTREAM_REJECTED", status: 400, providerReason: "INVALID_ARGUMENT" }],
    ["403 PERMISSION_DENIED", () => googleError(403, "PERMISSION_DENIED", [info("SERVICE_DISABLED")]),
      "PROVIDER_METADATA_PERMISSION_DENIED", { providerCode: "PERMISSION_DENIED", status: 403, providerReason: "SERVICE_DISABLED" }],
    ["403 billing disabled", () => googleError(403, "PERMISSION_DENIED", [info("BILLING_DISABLED")]),
      "PROVIDER_METADATA_BILLING_REQUIRED", { providerCode: "BILLING_REQUIRED", status: 403, providerReason: "BILLING_DISABLED" }],
    ["429 daily quota", () => googleError(429, "RESOURCE_EXHAUSTED", [quota("GenerateRequestsPerDayPerProjectPerModel")]),
      "PROVIDER_METADATA_QUOTA_EXHAUSTED", { providerCode: "QUOTA_EXHAUSTED", status: 429, providerReason: "RESOURCE_EXHAUSTED" }],
    ["429 rate limit", () => googleError(429, "RESOURCE_EXHAUSTED", [quota("GenerateRequestsPerMinutePerProjectPerModel-PaidTier")]),
      "PROVIDER_METADATA_RATE_LIMITED", { providerCode: "THROTTLED", status: 429, providerReason: "RESOURCE_EXHAUSTED" }],
  ] as const)("records %s with its code, HTTP status and Google's reason, never the body or key", async (_name, respond, reason, detail) => {
    refusal = respond;
    const { check, row, events } = await run();
    refusal = null;
    const expected = { role: "companion", ...detail };
    expect(check).toMatchObject({ state: "error", reason, reasonDetail: expected, chargedMicroUsd: 0 });
    expect(row).toEqual({ reason_code: reason, reason_detail: expected });
    expect(events[0].payload).toMatchObject({ reason, reasonDetail: expected });
    for (const stored of [JSON.stringify(check), JSON.stringify(row), JSON.stringify(events)]) {
      expect(stored).not.toContain("private-echo");
      expect(stored).not.toContain(SECRET);
    }
  }, 60000);
});
