import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createDatabase, type Database } from "../src/database.js";
import { createTestDatabase, type TestDatabase } from "./test-database.js";
import { createServer } from "../src/server.js";
import { issueLoginCode } from "../src/auth.js";
import { credentialVault } from "../src/key-vault.js";
import {
  WorkspaceProviders,
  defaultJobPolicy,
  type KeyTestLimits,
} from "../src/provider-setup.js";
import { googleMetadataAdapter } from "../src/provider-metadata.js";
import {
  googleError,
  googleModels,
  metadataStub,
  type StubReply,
} from "./metadata-stub-server.js";

// The guided "Add a connection" path end to end over HTTP and real PostgreSQL. The Google
// metadata adapter talks to a loopback stub server; no provider is contacted.
const schema = "provider_key_" + randomUUID().replaceAll("-", ""),
  workspace = randomUUID(),
  limitedWorkspace = randomUUID(),
  otherWorkspace = randomUUID(),
  origin = "http://localhost:4310",
  goodKey = ["SYNTHETIC", "GOOGLE", "KEY", "CANARY"].join("_");
let db: Database,
  app: Awaited<ReturnType<typeof createServer>>,
  service: WorkspaceProviders,
  stub: Awaited<ReturnType<typeof metadataStub>>,
  owner: Session,
  admin: Session,
  learner: Session,
  limitedOwner: Session,
  otherOwner: Session,
  testDatabase: TestDatabase | undefined;
interface Session {
  id: string;
  cookie: string;
  csrf: string;
}
let script: (key: string) => StubReply = () => ({
  status: 200,
  body: googleModels,
});
const limits: KeyTestLimits = {
  timeoutMs: 500,
  perMinute: 100,
  perHour: 100,
  concurrent: 2,
};
// Everything the process prints while this file runs; a key must never appear in it.
const printed: string[] = [];
const headers = (s: Session) => ({
    cookie: s.cookie,
    origin,
    "x-csrf-token": s.csrf,
  }),
  base = `/api/admin/workspaces/${workspace}/provider-setup`;
async function login(role: string, scope = workspace) {
  const id = randomUUID();
  await db.query(
    "INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)",
    [id, "test:" + id, "Key test user"],
  );
  await db.query(
    "INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)",
    [scope, id, role],
  );
  const r = await app.inject({
    method: "POST",
    url: "/auth/redeem",
    headers: { origin },
    payload: { token: await issueLoginCode(db, id) },
  });
  expect(r.statusCode).toBe(200);
  return {
    id,
    cookie: r.cookies.map((c) => `${c.name}=${c.value}`).join("; "),
    csrf: r.json().csrfToken,
  };
}
beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  stub = await metadataStub((request) =>
    script(String(request.headers["x-goog-api-key"] ?? "")),
  );
  service = new WorkspaceProviders(
    db,
    credentialVault(randomBytes(32)),
    {},
    undefined,
    { google: googleMetadataAdapter(stub.fetch) },
    undefined,
    limits,
  );
  app = await createServer(db, {
    loginCodes: true,
    origin,
    secureCookies: false,
    workspaceProviders: service,
  });
  for (const id of [workspace, limitedWorkspace, otherWorkspace])
    await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [
      id,
      "key-" + id,
      "Public qualification",
    ]);
  owner = await login("owner");
  admin = await login("admin");
  learner = await login("learner");
  limitedOwner = await login("owner", limitedWorkspace);
  otherOwner = await login("owner", otherWorkspace);
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

/** The exact request the admin guide sends for "Save new connection". */
async function saveGuidedConnection(key: string) {
  const current = (
      await app.inject({ method: "GET", url: base, headers: headers(owner) })
    ).json(),
    id = "connection-" + randomUUID().slice(0, 8),
    name =
      "COURSE_PROVIDER_" +
      randomUUID().replaceAll("-", "").slice(0, 16).toUpperCase() +
      "_API_KEY";
  const configuration = structuredClone(current.configuration);
  configuration.adapters.push({ id, kind: "google", credentialEnv: name });
  const response = await app.inject({
    method: "POST",
    url: base,
    headers: headers(owner),
    payload: {
      expectedRevision: current.revision,
      idempotencyKey: randomUUID(),
      configuration,
      jobPolicy: current.jobPolicy ?? defaultJobPolicy,
      credentials: { [name]: key },
    },
  });
  return { response, id, name, revision: current.revision + 1 };
}
async function inspect(revision: number, adapterId: string) {
  const r = await app.inject({
    method: "POST",
    url: base + "/inspect-models",
    headers: headers(owner),
    payload: {
      expectedRevision: revision,
      idempotencyKey: randomUUID(),
      adapterId,
    },
  });
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
}

it("a pasted key with surrounding whitespace is stored trimmed under the adapter binding, and inspection succeeds", async () => {
  // A browser password field keeps leading/trailing spaces and tabs from a paste.
  const saved = await saveGuidedConnection("  " + goodKey + " \t");
  expect(saved.response.statusCode, saved.response.body).toBe(200);
  const result = await inspect(saved.revision, saved.id);
  expect(result.reason).toBeNull();
  expect(result.state).toBe("complete");
  expect(result.result.models).toHaveLength(2);
  expect(stub.requests.at(-1)!.headers["x-goog-api-key"]).toBe(goodKey);
});

/** Every place a key could leak to: responses, logs, audit events, receipts and inspections. */
async function expectNowhere(value: string, bodies: string[]) {
  for (const body of bodies) expect(body).not.toContain(value);
  expect(printed.join("")).not.toContain(value);
  for (const table of [
    "learning_events",
    "provider_setup_receipts",
    "workspace_provider_inspections",
    "workspace_provider_versions",
  ]) {
    const rows = (await db.query(`SELECT * FROM ${table}`)).rows;
    expect(JSON.stringify(rows), table).not.toContain(value);
  }
}

it("refuses empty, whitespace-only and malformed keys with their own codes and stores nothing", async () => {
  const before = (
    await db.query(
      "SELECT count(*)::int AS n FROM workspace_provider_versions WHERE workspace_id=$1",
      [workspace],
    )
  ).rows[0].n;
  for (const [value, code] of [
    ["", "PROVIDER_CREDENTIAL_EMPTY"],
    ["   ", "PROVIDER_CREDENTIAL_EMPTY"],
    [" \t\r\n\u00a0\u200b", "PROVIDER_CREDENTIAL_EMPTY"],
    ["SYNTHETIC KEY", "PROVIDER_CREDENTIAL_MALFORMED"],
    ["SYNTHETIC\u200bKEY", "PROVIDER_CREDENTIAL_MALFORMED"],
    ["SYNTHETIC\nKEY", "PROVIDER_CREDENTIAL_MALFORMED"],
    // Look-alikes an auto-formatting app can put in a pasted key.
    ["AQ.SYNTHETIC\u00d7KEY", "PROVIDER_CREDENTIAL_MALFORMED"],
    ["AQ.SYNTHETIC\u2013KEY", "PROVIDER_CREDENTIAL_MALFORMED"],
    ["AQ.SYNTHETIC\u2011KEY", "PROVIDER_CREDENTIAL_MALFORMED"],
    ["\u201cAQ.SYNTHETIC_KEY\u201d", "PROVIDER_CREDENTIAL_MALFORMED"],
  ] as const) {
    const saved = await saveGuidedConnection(value);
    expect(saved.response.statusCode, JSON.stringify(value)).toBe(400);
    // The refusal names the code only; it never echoes the key or any part of it.
    expect(saved.response.json()).toEqual({ error: code });
  }
  expect(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM workspace_provider_versions WHERE workspace_id=$1",
        [workspace],
      )
    ).rows[0].n,
  ).toBe(before);
});

it("accepts dotted AQ. keys and classic AIza keys and sends them unchanged", async () => {
  for (const key of [
    ["AQ", "Ab8SYNTHETIC-dotted_KEY", "0000"].join("."),
    ["AIza", "SyNTHETIC-classic_KEY-000000000000000"].join(""),
  ]) {
    const saved = await saveGuidedConnection(`\u200b ${key}\n`);
    expect(saved.response.statusCode, saved.response.body).toBe(200);
    expect(saved.response.body).not.toContain(key);
    const result = await inspect(saved.revision, saved.id);
    expect(result.reason).toBeNull();
    expect(stub.requests.at(-1)!.headers["x-goog-api-key"]).toBe(key);
  }
});

it("a key stored as pasted by an earlier release is used without its surrounding whitespace", async () => {
  const saved = await saveGuidedConnection(goodKey);
  expect(saved.response.statusCode, saved.response.body).toBe(200);
  // Rewrite the stored value as 0.1.48 kept it: the paste, untrimmed.
  await db.query(
    "UPDATE workspace_provider_versions SET sealed_credentials=jsonb_set(sealed_credentials,ARRAY[$3::text],to_jsonb($4::text)) WHERE workspace_id=$1 AND revision=$2",
    [
      workspace,
      saved.revision,
      saved.name,
      service.vault.seal(
        JSON.stringify([
          "course-core-provider-v1",
          workspace,
          saved.revision,
          saved.name,
        ]),
        " " + goodKey + "\t ",
      ),
    ],
  );
  const result = await inspect(saved.revision, saved.id);
  expect(result.state).toBe("complete");
  expect(stub.requests.at(-1)!.headers["x-goog-api-key"]).toBe(goodKey);
  expect(await service.credential(workspace, saved.name)).toBe(goodKey);
});

it("an inspection records the precise refusal: invalid key, API not enabled, quota, timeout", async () => {
  const saved = await saveGuidedConnection(goodKey);
  expect(saved.response.statusCode).toBe(200);
  for (const [reply, code] of [
    [
      { status: 400, body: googleError(400, "INVALID_ARGUMENT", "API_KEY_INVALID") },
      "PROVIDER_METADATA_KEY_INVALID",
    ],
    [
      { status: 403, body: googleError(403, "PERMISSION_DENIED", "SERVICE_DISABLED") },
      "PROVIDER_METADATA_API_NOT_ENABLED",
    ],
    [
      { status: 429, body: googleError(429, "RESOURCE_EXHAUSTED") },
      "PROVIDER_METADATA_RATE_LIMITED",
    ],
  ] as const) {
    script = () => reply;
    const result = await inspect(saved.revision, saved.id);
    expect(result).toMatchObject({ state: "failed", reason: code, result: null });
    expect(
      (
        await db.query(
          "SELECT reason_code FROM workspace_provider_inspections WHERE id=$1",
          [result.id],
        )
      ).rows[0].reason_code,
    ).toBe(code);
  }
  script = () => ({ status: 200, body: googleModels });
});

async function testKey(session: Session, payload: unknown, scope = workspace) {
  return app.inject({
    method: "POST",
    url: `/api/admin/workspaces/${scope}/provider-setup/test-key`,
    headers: headers(session),
    payload: payload as Record<string, unknown>,
  });
}
it("tests a typed key with a metadata listing only, reports the precise outcome and never stores, logs or audits the key", async () => {
  const bodies: string[] = [],
    versions = (
      await db.query(
        "SELECT count(*)::int AS n FROM workspace_provider_versions WHERE workspace_id=$1",
        [workspace],
      )
    ).rows[0].n,
    typed = ["SYNTHETIC", "TYPED", "KEY", "CANARY"].join("_"),
    cases: [StubReply, string, number | null][] = [
      [{ status: 200, body: googleModels }, "ok", 2],
      [
        {
          status: 400,
          body: googleError(400, "INVALID_ARGUMENT", "API_KEY_INVALID", "API key not valid."),
        },
        "PROVIDER_METADATA_KEY_INVALID",
        null,
      ],
      [
        { status: 403, body: googleError(403, "PERMISSION_DENIED", "SERVICE_DISABLED") },
        "PROVIDER_METADATA_API_NOT_ENABLED",
        null,
      ],
      [
        { status: 403, body: googleError(403, "PERMISSION_DENIED") },
        "PROVIDER_METADATA_PERMISSION_DENIED",
        null,
      ],
      [
        { status: 429, body: googleError(429, "RESOURCE_EXHAUSTED") },
        "PROVIDER_METADATA_RATE_LIMITED",
        null,
      ],
      [{ hang: true }, "PROVIDER_METADATA_TIMEOUT", null],
    ];
  const sent = stub.requests.length;
  for (const [reply, outcome, modelCount] of cases) {
    script = () => reply;
    const r = await testKey(admin, { kind: "google", key: " " + typed + "\n" });
    bodies.push(r.body);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({
      kind: "google",
      outcome,
      modelCount,
      truncated: outcome === "ok" ? false : null,
      stored: false,
      generationPerformed: false,
    });
  }
  script = () => ({ status: 200, body: googleModels });
  // One metadata GET per test, with the trimmed key in its header and nowhere else.
  const requests = stub.requests.slice(sent);
  expect(requests).toHaveLength(cases.length);
  for (const request of requests) {
    expect(request.method).toBe("GET");
    expect(request.path).toBe("/v1beta/models?pageSize=100");
    expect(request.headers["x-goog-api-key"]).toBe(typed);
  }
  // An installed kind is required; nothing is requested for another.
  const unsupported = await testKey(owner, { kind: "unknown-kind", key: typed });
  bodies.push(unsupported.body);
  expect(unsupported.json()).toMatchObject({
    outcome: "PROVIDER_METADATA_UNSUPPORTED",
    modelCount: null,
  });
  expect(stub.requests).toHaveLength(sent + cases.length);
  // Nothing was saved, and the audit log has the outcome of each test but not the key.
  expect(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM workspace_provider_versions WHERE workspace_id=$1",
        [workspace],
      )
    ).rows[0].n,
  ).toBe(versions);
  const audit = await app.inject({
    method: "GET",
    url: `/api/admin/workspaces/${workspace}/audit?type=provider.key_tested&limit=50`,
    headers: headers(owner),
  });
  expect(audit.statusCode, audit.body).toBe(200);
  const events = audit.json().events as {
    payload: Record<string, unknown>;
    actor: string;
  }[];
  expect(events.map((e) => e.payload).reverse()).toEqual([
    ...cases.map(([, outcome, modelCount]) => ({
      kind: "google",
      outcome,
      modelCount,
    })),
    { kind: null, outcome: "PROVIDER_METADATA_UNSUPPORTED", modelCount: null },
  ]);
  bodies.push(audit.body);
  await expectNowhere(typed, bodies);
});

it("key tests need an owner or administrator and a non-empty key", async () => {
  const sent = stub.requests.length;
  const denied = await testKey(learner, { kind: "google", key: goodKey });
  expect(denied.statusCode).toBe(403);
  for (const [payload, code] of [
    [{ kind: "google", key: "  " }, "PROVIDER_CREDENTIAL_EMPTY"],
    [{ kind: "google", key: "SYNTHETIC KEY" }, "PROVIDER_CREDENTIAL_MALFORMED"],
    [
      { kind: "google", key: "AQ.SYNTHETIC\u00d7KEY" },
      "PROVIDER_CREDENTIAL_MALFORMED",
    ],
    [{ kind: "google" }, "PROVIDER_KEY_TEST_INVALID"],
    [{ kind: "Google!", key: goodKey }, "PROVIDER_KEY_TEST_INVALID"],
    [{ kind: "google", key: goodKey, save: true }, "PROVIDER_KEY_TEST_INVALID"],
  ] as const) {
    const r = await testKey(owner, payload);
    expect(r.statusCode, JSON.stringify(payload)).toBe(400);
    expect(r.json()).toEqual({ error: code });
  }
  expect(stub.requests).toHaveLength(sent);
  // The CSRF/origin checks of every admin mutation apply.
  const forged = await app.inject({
    method: "POST",
    url: base + "/test-key",
    headers: { cookie: owner.cookie, origin: "http://evil.example" },
    payload: { kind: "google", key: goodKey },
  });
  expect(forged.statusCode).toBe(403);
});

it("key tests are rate limited per workspace, including concurrent tests", async () => {
  const saved = { ...limits };
  try {
    limits.perMinute = 3;
    script = () => ({ hang: true });
    // Two running tests fill the concurrency limit; a third is refused at once.
    const running = [
      testKey(limitedOwner, { kind: "google", key: goodKey }, limitedWorkspace),
      testKey(limitedOwner, { kind: "google", key: goodKey }, limitedWorkspace),
    ];
    await new Promise((resolve) => setTimeout(resolve, 100));
    const third = await testKey(
      limitedOwner,
      { kind: "google", key: goodKey },
      limitedWorkspace,
    );
    expect(third.statusCode).toBe(429);
    expect(third.json()).toEqual({ error: "PROVIDER_KEY_TEST_RATE_LIMITED" });
    for (const r of await Promise.all(running))
      expect(r.json().outcome).toBe("PROVIDER_METADATA_TIMEOUT");
    script = () => ({ status: 200, body: googleModels });
    expect(
      (await testKey(limitedOwner, { kind: "google", key: goodKey }, limitedWorkspace))
        .statusCode,
    ).toBe(200);
    // Three tests started this minute: the next one waits for the window.
    const limited = await testKey(
      limitedOwner,
      { kind: "google", key: goodKey },
      limitedWorkspace,
    );
    expect(limited.statusCode).toBe(429);
    // Another workspace keeps its own allowance.
    expect(
      (
        await testKey(
          otherOwner,
          { kind: "google", key: goodKey },
          otherWorkspace,
        )
      ).statusCode,
    ).toBe(200);
  } finally {
    Object.assign(limits, saved);
    script = () => ({ status: 200, body: googleModels });
  }
});
