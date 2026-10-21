import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createDatabase, type Database } from "../src/database.js";
import { createTestDatabase, type TestDatabase } from "./test-database.js";
import { createServer } from "../src/server.js";
import { issueLoginCode } from "../src/auth.js";
import { credentialVault } from "../src/key-vault.js";
import { WorkspaceProviders, defaultJobPolicy } from "../src/provider-setup.js";
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
  origin = "http://localhost:4310",
  goodKey = ["SYNTHETIC", "GOOGLE", "KEY", "CANARY"].join("_");
let db: Database,
  app: Awaited<ReturnType<typeof createServer>>,
  service: WorkspaceProviders,
  stub: Awaited<ReturnType<typeof metadataStub>>,
  owner: Session,
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
const headers = (s: Session) => ({
    cookie: s.cookie,
    origin,
    "x-csrf-token": s.csrf,
  }),
  base = `/api/admin/workspaces/${workspace}/provider-setup`;
async function login(role: string) {
  const id = randomUUID();
  await db.query(
    "INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)",
    [id, "test:" + id, "Key test user"],
  );
  await db.query(
    "INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)",
    [workspace, id, role],
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
  );
  app = await createServer(db, {
    loginCodes: true,
    origin,
    secureCookies: false,
    workspaceProviders: service,
  });
  await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [
    workspace,
    "key-" + workspace,
    "Public qualification",
  ]);
  owner = await login("owner");
}, 30000);
afterAll(async () => {
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
