import { randomBytes, randomUUID } from "node:crypto";
import { beforeAll, afterAll, it, expect } from "vitest";
import type { ProviderAdapter, UsageReceipt } from "@course-core/providers";
import { createDatabase, transaction, type Database } from "../src/database.js";
import { createTestDatabase, type TestDatabase } from "./test-database.js";
import { createServer } from "../src/server.js";
import { issueLoginCode } from "../src/auth.js";
import { credentialVault } from "../src/key-vault.js";
import { WorkspaceProviders, defaultJobPolicy } from "../src/provider-setup.js";
import { createPostgresSupervisorBridge } from "../src/supervisor-bridge.js";
import { fixture } from "./fixture.js";
import { allowUnpricedPaidWork } from "./cost-fixture.js";

const schema = "provider_setup_" + randomUUID().replaceAll("-", ""),
  workspace = randomUUID(),
  otherWorkspace = randomUUID(),
  origin = "http://localhost:4310",
  token = randomUUID();
let db: Database,
  app: Awaited<ReturnType<typeof createServer>>,
  service: WorkspaceProviders,
  owner: Session,
  learner: Session,
  foreign: Session,
  releaseId: string,
  enrollment: string;
interface Session {
  id: string;
  cookie: string;
  csrf: string;
}
const seen: string[] = [],
  usage: UsageReceipt = {
    accounting: { accountingKey: "synthetic" },
    providerId: "fake",
    modelId: "portable",
    operation: "tutor",
    attempts: [
      {
        attempt: 1,
        status: 200,
        outcome: "response",
        tokens: {
          input: 10,
          output: 10,
          total: 20,
          cachedInput: 0,
          thoughts: 0,
          toolInput: 0,
        },
      },
    ],
    inputCharacters: 100,
    requestedMaxOutputTokens: 1000,
    requestedVideoSeconds: null,
    observedImageCount: null,
    observedVideoCount: null,
    cost: null,
  };
const configuration = () => ({
  registry: {
    revision: "workspace-config",
    models: [
      {
        id: "portable",
        providerId: "fake",
        remoteModel: "opaque/model",
        providerConfig: {},
        enabled: true,
        capabilities: ["tutoring"],
        limits: { maxInputCharacters: 30000, maxOutputTokens: 1000 },
      },
    ],
  },
  adapters: [
    { id: "fake", kind: "fake", credentialEnv: "COURSE_PROVIDER_FAKE_API_KEY" },
  ],
  roles: {
    companion: {
      modelId: "portable",
      maxInputCharacters: 12000,
      maxOutputTokens: 1000,
    },
  },
});
const headers = (s: Session) => ({
    cookie: s.cookie,
    origin,
    "x-csrf-token": s.csrf,
  }),
  base = `/api/admin/workspaces/${workspace}/provider-setup`,
  jobPolicy = {
    ...defaultJobPolicy,
    allowance: { microUsd: 100000, tokens: 100000 },
  };
async function login(role: string, scope = workspace) {
  const id = randomUUID();
  await db.query(
    "INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)",
    [id, "test:" + id, "Setup test user"],
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
let testDatabase: TestDatabase | undefined;
beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  service = new WorkspaceProviders(db, credentialVault(randomBytes(32)), {
    fake: ({ providerId, getCredential }) =>
      ({
        providerId,
        validateModel() {},
        ports: {
          tutoring: {
            async tutor() {
              seen.push(getCredential() ?? "MISSING");
              return {
                usage,
                output: { text: "Compare all members carefully." },
              };
            },
          },
        },
      }) satisfies ProviderAdapter,
  });
  app = await createServer(db, { loginCodes: true,
    origin,
    secureCookies: false,
    workspaceProviders: service,
    supervisor: {
      serviceToken: token,
      workspaceIds: [workspace, otherWorkspace],
    },
  });
  for (const id of [workspace, otherWorkspace])
    await db.query("INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)", [
      id,
      "setup-" + id,
      "Public qualification",
    ]);
  await allowUnpricedPaidWork(db, workspace);
  owner = await login("owner");
  learner = await login("learner");
  foreign = await login("owner", otherWorkspace);
  const imported = await app.inject({
    method: "POST",
    url: `/api/workspaces/${workspace}/releases`,
    headers: headers(owner),
    payload: fixture(),
  });
  expect(imported.statusCode, imported.body).toBe(200);
  releaseId = imported.json().id;
  expect(
    (
      await app.inject({
        method: "POST",
        url: `/api/releases/${releaseId}/publish`,
        headers: headers(owner),
      })
    ).statusCode,
  ).toBe(200);
  enrollment = (
    await app.inject({
      method: "POST",
      url: "/api/enrollments",
      headers: headers(learner),
      payload: { releaseId },
    })
  ).json().id;
}, 30000);
afterAll(async () => {
  await app?.close();
  await db?.end();
  await testDatabase?.drop();
});
const read = async () => {
  const r = await app.inject({ url: base, headers: headers(owner) });
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
};
async function save(
  credentials: Record<string, string | null>,
  revision?: number,
) {
  const before = await read();
  return app.inject({
    method: "POST",
    url: base,
    headers: headers(owner),
    payload: {
      expectedRevision: revision ?? before.revision,
      idempotencyKey: randomUUID(),
      configuration: configuration(),
      jobPolicy,
      credentials,
    },
  });
}
it("defaults grant no budget; only authenticated administrators can save encrypted credentials, never read them back", async () => {
  expect((await read()).revision).toBe(0);
  expect(
    (
      await app.inject({ url: base + "/budgets", headers: headers(owner) })
    ).json().workspace.limit_tokens,
  ).toBe("0");
  for (const actor of [learner, foreign])
    expect(
      (await app.inject({ url: base, headers: headers(actor) })).statusCode,
    ).toBe(403);
  const credential = "ENCRYPTION_CANARY_" + randomUUID(),
    r = await save({ COURSE_PROVIDER_FAKE_API_KEY: credential });
  expect(r.statusCode, r.body).toBe(200);
  expect(r.body).not.toContain(credential);
  const projected = await read();
  expect(JSON.stringify(projected)).not.toContain(credential);
  expect(projected.verification).toBe("not_run");
  expect(projected.credentials).toEqual([
    { name: "COURSE_PROVIDER_FAKE_API_KEY", configured: true },
  ]);
  const stored = (
    await db.query(
      "SELECT configuration,sealed_credentials FROM workspace_provider_versions WHERE workspace_id=$1",
      [workspace],
    )
  ).rows;
  expect(JSON.stringify(stored)).not.toContain(credential);
  expect(
    JSON.stringify(
      (await db.query("SELECT * FROM provider_setup_receipts")).rows,
    ),
  ).not.toContain(credential);
  expect(
    (
      await app.inject({ url: base + "/budgets", headers: headers(owner) })
    ).json().workspace.limit_tokens,
  ).toBe("0");
});
it("requires explicit budget approval, CAS revisions and same-key replay; does not erase reserved usage", async () => {
  const payload = {
    expectedRevision: 0,
    idempotencyKey: randomUUID(),
    limits: { microUsd: 1000000, tokens: 1000000 },
    paidWorkApproved: false,
  };
  const refused = await app.inject({
    method: "POST",
    url: base + "/budgets",
    headers: headers(owner),
    payload,
  });
  expect(refused.statusCode).toBe(409);
  expect(refused.json().error).toBe("PAID_WORK_CONSENT_REQUIRED");
  payload.paidWorkApproved = true;
  const saved = await app.inject({
    method: "POST",
    url: base + "/budgets",
    headers: headers(owner),
    payload,
  });
  expect(saved.statusCode, saved.body).toBe(200);
  expect(
    (
      await app.inject({
        method: "POST",
        url: base + "/budgets",
        headers: headers(owner),
        payload,
      })
    ).json(),
  ).toEqual(saved.json());
  const conflict = await app.inject({
    method: "POST",
    url: base + "/budgets",
    headers: headers(owner),
    payload: { ...payload, limits: { microUsd: 1, tokens: 1 } },
  });
  expect(conflict.statusCode).toBe(409);
  const child = await app.inject({
    method: "POST",
    url: base + "/budgets",
    headers: headers(owner),
    payload: {
      ...payload,
      idempotencyKey: randomUUID(),
      enrollmentId: enrollment,
    },
  });
  expect(child.statusCode, child.body).toBe(200);
  await db.query(
    "UPDATE supervisor_workspace_budgets SET used_tokens=42 WHERE workspace_id=$1",
    [workspace],
  );
  const below = await app.inject({
    method: "POST",
    url: base + "/budgets",
    headers: headers(owner),
    payload: {
      ...payload,
      idempotencyKey: randomUUID(),
      expectedRevision: 1,
      limits: { microUsd: 1000000, tokens: 0 },
    },
  });
  expect(below.statusCode).toBe(409);
  expect(below.json().error).toBe("PROVIDER_BUDGET_BELOW_USAGE");
});
it("pins real jobs to workspace credentials and admission policy, rejects cross-workspace capabilities, and retains completed receipts after rotation", async () => {
  const credential = "DISPATCH_CANARY_" + randomUUID();
  expect(
    (await save({ COURSE_PROVIDER_FAKE_API_KEY: credential })).statusCode,
  ).toBe(200);
  const snapshot = (
    await app.inject({
      url: `/api/enrollments/${enrollment}`,
      headers: headers(learner),
    })
  ).json();
  const asked = await app.inject({
    method: "POST",
    url: `/api/enrollments/${enrollment}/companion`,
    headers: headers(learner),
    payload: {
      expectedRevision: snapshot.revision,
      idempotencyKey: randomUUID(),
      episodeId: "min",
      content: "Explain comparison.",
    },
  });
  expect(asked.statusCode, asked.body).toBe(200);
  const bridge = createPostgresSupervisorBridge(db, {
      workspaceIds: [workspace],
      providerBinding: (client, id) => service.bind(client, id),
    }),
    outbox = (await bridge.claimOutboxEvent(asked.json().eventId, randomUUID(), 30000))!;
  const [ref] = await bridge.prepareOutbox(outbox);
  await bridge.ackOutbox(outbox);
  const claimed = await bridge.transition({
    type: "claim",
    ref: ref!,
    checkpointId: "generate",
    ownerId: randomUUID(),
    availability: { status: "ready" },
  });
  expect(claimed.effect).toBe("invoke");
  expect(claimed.snapshot.specification.budget).toEqual(jobPolicy.allowance);
  const operation = claimed.snapshot.operations[0]!,
    request = {
      schemaVersion: 1,
      operationId: operation.id,
      job: claimed.snapshot.specification.key,
      role: "companion",
      checkpoint: claimed.snapshot.specification.checkpoints[0],
      fence: claimed.snapshot.specification.fence,
    };
  const invoke = () =>
    app.inject({
      method: "POST",
      url: "/v1/operations",
      headers: {
        authorization: "Bearer " + token,
        "idempotency-key": operation.id,
      },
      payload: request,
    });
  const outcome = await invoke();
  expect(outcome.statusCode, outcome.body).toBe(200);
  expect(outcome.json().status).toBe("succeeded");
  expect(seen).toEqual([credential]);
  expect(
    (
      await app.inject({
        url: "/v1/capabilities?workspaceId=" + otherWorkspace,
        headers: { authorization: "Bearer " + token },
      })
    ).json().companion.status,
  ).toBe("configuration_missing");
  expect(
    (
      await app.inject({
        url: "/v1/capabilities?workspaceId=" + randomUUID(),
        headers: { authorization: "Bearer " + token },
      })
    ).statusCode,
  ).toBe(403);
  const rotate = await save({
    COURSE_PROVIDER_FAKE_API_KEY: "ROTATED_" + randomUUID(),
  });
  expect(rotate.statusCode).toBe(200);
  expect(rotate.json().cancelledPendingJobs).toBeGreaterThan(0);
  // The cancellation is signalled, not only stored: the job's workflow is told to stop its call now.
  const [delivery] = await bridge.claimCancellations(randomUUID(), 10, 30000);
  expect(delivery).toMatchObject({ reason: "provider_changed", workspaceId: workspace, jobs: [ref] });
  expect(await bridge.ackCancellation(delivery!, true)).toBe(true);
  expect(await bridge.claimCancellations(randomUUID(), 10, 30000)).toEqual([]);
  // Its call is still out, so reconciliation leaves the job to its workflow instead of halting it.
  await bridge.reconcile(10);
  expect((await db.query("SELECT state,cancellation_requested FROM supervisor_jobs WHERE id=$1", [ref!.jobId])).rows[0]).toEqual({
    state: "running",
    cancellation_requested: true,
  });
  expect((await invoke()).json()).toEqual(outcome.json());
  expect(seen).toHaveLength(1);
  expect(
    (
      await db.query(
        "SELECT provider_revision FROM supervisor_jobs WHERE id=$1",
        [ref!.jobId],
      )
    ).rows[0].provider_revision,
  ).toBeLessThan((await read()).revision);
});
it("rejects credentials in public configuration, unsafe bindings and stale or forged revisions; origin/CSRF is enforced", async () => {
  const before = await read(),
    publicSecret = {
      ...configuration(),
      registry: {
        ...configuration().registry,
        models: [
          {
            ...configuration().registry.models[0],
            providerConfig: { api_key: "BAD_CANARY" },
          },
        ],
      },
    };
  const payload = {
    expectedRevision: before.revision,
    idempotencyKey: randomUUID(),
    configuration: publicSecret,
    jobPolicy,
    credentials: {},
  };
  expect(
    (
      await app.inject({
        method: "POST",
        url: base,
        headers: headers(owner),
        payload,
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (
      await app.inject({
        method: "POST",
        url: base,
        headers: { cookie: owner.cookie, origin },
        payload: { ...payload, configuration: configuration() },
      })
    ).statusCode,
  ).toBe(403);
  expect((await save({}, 0)).statusCode).toBe(409);
  expect(
    (
      await app.inject({
        method: "POST",
        url: base,
        headers: headers(learner),
        payload: { ...payload, configuration: configuration() },
      })
    ).statusCode,
  ).toBe(403);
});
it("concurrent reordered configuration retries produce one encrypted version and reject an undersized admission envelope", async () => {
  const before = await read(),
    cfg = configuration(),
    payload = {
      expectedRevision: before.revision,
      idempotencyKey: randomUUID(),
      configuration: cfg,
      jobPolicy,
      credentials: {},
    };
  const reordered = {
    ...payload,
    configuration: {
      ...cfg,
      registry: {
        models: cfg.registry.models,
        revision: cfg.registry.revision,
      },
    },
  };
  const count = Number(
    (
      await db.query(
        "SELECT count(*) FROM workspace_provider_versions WHERE workspace_id=$1",
        [workspace],
      )
    ).rows[0].count,
  );
  const [a, b] = await Promise.all([
    app.inject({ method: "POST", url: base, headers: headers(owner), payload }),
    app.inject({
      method: "POST",
      url: base,
      headers: headers(owner),
      payload: reordered,
    }),
  ]);
  expect(a.statusCode, a.body).toBe(200);
  expect(b.statusCode, b.body).toBe(200);
  expect(a.json()).toEqual(b.json());
  expect(
    Number(
      (
        await db.query(
          "SELECT count(*) FROM workspace_provider_versions WHERE workspace_id=$1",
          [workspace],
        )
      ).rows[0].count,
    ),
  ).toBe(count + 1);
  const small = await app.inject({
    method: "POST",
    url: base,
    headers: headers(owner),
    payload: {
      ...payload,
      expectedRevision: a.json().revision,
      idempotencyKey: randomUUID(),
      jobPolicy: {
        ...jobPolicy,
        allowance: { ...jobPolicy.allowance, tokens: 1000 },
      },
    },
  });
  expect(small.statusCode).toBe(409);
  expect(small.json().error).toBe("PROVIDER_TOKEN_RESERVATION_TOO_SMALL");
  expect((await read()).revision).toBe(a.json().revision);
});
it("scoped metadata receipts deduplicate retries, keep credentials private and never modify paid ledgers", async () => {
  let calls = 0;
  service.metadataAdapters.fake = {
    label: "Synthetic metadata",
    inspect: async ({ getCredential }) => {
      calls++;
      expect(getCredential()).toBeTruthy();
      return {
        models: [
          {
            remoteModel: "public-model",
            displayName: "Public model",
            description: "Metadata, not a live assessment.",
            inputTokenLimit: 120000,
            outputTokenLimit: 4000,
            methods: ["generateContent"],
          },
        ],
        pages: 1,
        truncated: false,
        generationPerformed: false,
        capabilitiesVerified: false,
      };
    },
    buildDraft: (input) => input.configuration,
  };
  const before = await read(),
    payload = {
      expectedRevision: before.revision,
      idempotencyKey: randomUUID(),
      adapterId: "fake",
    },
    budgetsBefore = (
      await app.inject({ url: base + "/budgets", headers: headers(owner) })
    ).json();
  const inspected = await app.inject({
    method: "POST",
    url: base + "/inspect-models",
    headers: headers(owner),
    payload,
  });
  expect(inspected.statusCode, inspected.body).toBe(200);
  expect(inspected.json().state).toBe("complete");
  expect(inspected.json().result.generationPerformed).toBe(false);
  expect(
    (
      await app.inject({
        method: "POST",
        url: base + "/inspect-models",
        headers: headers(owner),
        payload,
      })
    ).json(),
  ).toEqual(inspected.json());
  expect(calls).toBe(1);
  expect(
    (
      await app.inject({ url: base + "/budgets", headers: headers(owner) })
    ).json(),
  ).toEqual(budgetsBefore);
  for (const actor of [learner, foreign])
    expect(
      (
        await app.inject({
          method: "POST",
          url: base + "/inspect-models",
          headers: headers(actor),
          payload,
        })
      ).statusCode,
    ).toBe(403);
  const draft = await app.inject({
    method: "POST",
    url: base + "/preview-models",
    headers: headers(owner),
    payload: {
      expectedRevision: before.revision,
      inspectionId: inspected.json().id,
      assignments: { companion: "public-model" },
    },
  });
  expect(draft.statusCode, draft.body).toBe(200);
  expect(draft.json().paidBudgetChanged).toBe(false);
  expect(draft.json().capabilitiesVerified).toBe(false);
  expect((await read()).revision).toBe(before.revision);
});
it("rotation during metadata inspection discards stale results and expired interrupted requests never silently resubmit", async () => {
  let release!: () => void,
    entered!: () => void,
    calls = 0;
  const waiting = new Promise<void>((done) => {
      release = done;
    }),
    entry = new Promise<void>((done) => {
      entered = done;
    });
  service.metadataAdapters.fake = {
    label: "Synthetic metadata",
    inspect: async () => {
      calls++;
      entered();
      await waiting;
      return {
        models: [],
        pages: 1,
        truncated: false,
        generationPerformed: false,
        capabilitiesVerified: false,
      };
    },
  };
  const before = await read(),
    payload = {
      expectedRevision: before.revision,
      idempotencyKey: randomUUID(),
      adapterId: "fake",
    },
    pending = app.inject({
      method: "POST",
      url: base + "/inspect-models",
      headers: headers(owner),
      payload,
    });
  await entry;
  expect((await save({})).statusCode).toBe(200);
  release();
  const result = await pending;
  expect(result.statusCode, result.body).toBe(200);
  expect(result.json().state).toBe("failed");
  expect(result.json().reason).toBe("PROVIDER_METADATA_SCOPE_CHANGED");
  expect(result.json().result).toBeNull();
  const current = await read(),
    key = randomUUID();
  await db.query(
    "INSERT INTO workspace_provider_inspections(id,workspace_id,provider_revision,adapter_id,actor_id,idempotency_key,state,deadline_at) VALUES($1,$2,$3,'fake',$4,$5,'in_flight',clock_timestamp()-interval '1 second')",
    [randomUUID(), workspace, current.revision, owner.id, key],
  );
  const interrupted = await app.inject({
    method: "POST",
    url: base + "/inspect-models",
    headers: headers(owner),
    payload: {
      expectedRevision: current.revision,
      idempotencyKey: key,
      adapterId: "fake",
    },
  });
  expect(interrupted.json().state).toBe("failed");
  expect(interrupted.json().reason).toBe("PROVIDER_METADATA_INTERRUPTED");
  expect(calls).toBe(1);
});
it("membership revocation during inspection cannot expose a completed catalog or authorize a preview", async () => {
  const operator = await login("admin"),
    before = await read();
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>((done) => {
      release = done;
    }),
    entry = new Promise<void>((done) => {
      entered = done;
    });
  service.metadataAdapters.fake = {
    label: "Synthetic metadata",
    inspect: async () => {
      entered();
      await waiting;
      return {
        models: [],
        pages: 1,
        truncated: false,
        generationPerformed: false,
        capabilitiesVerified: false,
      };
    },
  };
  const pending = app.inject({
    method: "POST",
    url: base + "/inspect-models",
    headers: headers(operator),
    payload: {
      expectedRevision: before.revision,
      idempotencyKey: randomUUID(),
      adapterId: "fake",
    },
  });
  await entry;
  await db.query(
    "DELETE FROM memberships WHERE workspace_id=$1 AND user_id=$2",
    [workspace, operator.id],
  );
  release();
  const result = await pending;
  expect(result.statusCode, result.body).toBe(200);
  expect(result.json().state).toBe("failed");
  expect(result.json().result).toBeNull();
  expect(result.json().reason).toBe("PROVIDER_METADATA_SCOPE_CHANGED");
  const forbidden = await app.inject({
    method: "POST",
    url: base + "/preview-models",
    headers: headers(operator),
    payload: {
      expectedRevision: before.revision,
      inspectionId: result.json().id,
      assignments: {},
    },
  });
  expect(forbidden.statusCode).toBe(403);
});
