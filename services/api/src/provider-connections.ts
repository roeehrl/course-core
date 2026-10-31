import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { z } from "zod";
import type { Actor, authService } from "./auth.js";
import { workspaceRole } from "./course-access.js";
import { transaction, type Database } from "./database.js";
import { ApiError, requireCondition } from "./errors.js";
import { appendEvent } from "./events.js";
import { providerConfigurationSchema } from "./provider-composition.js";
import {
  boundedMetadataInspection,
  metadataFailureCode,
  type ModelCatalog,
} from "./provider-metadata.js";
import {
  defaultJobPolicy,
  jobPolicySchema,
  normalizeCredential,
  type Version,
  type WorkspaceProviders,
} from "./provider-setup.js";
import {
  NEEDED_ROLES,
  SUGGESTION_ROLES,
  suggestModel,
  type SuggestionRole,
} from "./provider-suggestions.js";
import { YOUTUBE_SEARCH_CREDENTIAL } from "./research-media.js";

/**
 * Connections for the admin "AI services" page: one provider kind with its own key slot. The
 * server names the slot (COURSE_PROVIDER_<random>_API_KEY) and the adapter id, so an operator
 * never types either. A key travels only in the body of an add or replace request, is tested
 * with the provider's model listing before it is stored (unless the operator saves untested after
 * the provider was unreachable), and is never returned, logged, audited or put in a draft. Only
 * the last four characters of a key of at least 16 characters are kept as display metadata.
 */
type Configuration = z.infer<typeof providerConfigurationSchema>;
const KEY_ENDING_MINIMUM = 16;
export const keyEnding = (key: string) =>
  key.length >= KEY_ENDING_MINIMUM ? key.slice(-4) : null;
const idempotencyKey = z.string().regex(/^[A-Za-z0-9:_-]{8,200}$/);
const connectionName = z
  .string()
  .trim()
  .max(80)
  .refine((v) => !/[\u0000-\u001f\u007f]/.test(v));
const kind = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,99}$/);
const addSchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative(),
  idempotencyKey,
  kind,
  key: z.string().max(8192),
  name: connectionName.optional(),
  skipTest: z.boolean().optional(),
});
const replaceSchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative(),
  idempotencyKey,
  key: z.string().max(8192),
  skipTest: z.boolean().optional(),
});
const removeSchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative(),
  idempotencyKey,
});
/** Keys for services that are not model providers, by public id. */
export const SERVICE_KEYS = { youtube: YOUTUBE_SEARCH_CREDENTIAL } as const;
type ServiceKeyId = keyof typeof SERVICE_KEYS;
/** Failure codes that mean the stored key itself is wrong or not allowed. */
const KEY_PROBLEMS = new Set([
  "PROVIDER_METADATA_CREDENTIAL_MISSING",
  "PROVIDER_METADATA_CREDENTIAL_MALFORMED",
  "PROVIDER_METADATA_KEY_INVALID",
  "PROVIDER_METADATA_API_NOT_ENABLED",
  "PROVIDER_METADATA_KEY_RESTRICTED",
  "PROVIDER_METADATA_PERMISSION_DENIED",
  "PROVIDER_METADATA_RATE_LIMITED",
  "PROVIDER_METADATA_QUOTA_EXHAUSTED",
  "PROVIDER_METADATA_BILLING_REQUIRED",
  "PROVIDER_REQUEST_REJECTED",
  "PROVIDER_METADATA_REJECTED",
]);
const keyStatus = (outcome: string) =>
  outcome === "ok"
    ? "working"
    : KEY_PROBLEMS.has(outcome)
      ? "rejected"
      : "unreachable";
const EMPTY_CONFIGURATION: Configuration = {
  registry: { revision: "ai-services", models: [] },
  adapters: [],
  roles: {},
};
const CATALOG_TTL_MS = 10 * 60 * 1000;
interface ConnectionRow {
  adapter_id: string;
  name: string;
  key_ending: string | null;
  key_status: "working" | "rejected" | "untested" | "unreachable";
  key_reason: string | null;
  tested_at: Date | null;
}
/** Roles whose bound model is served by each adapter. */
export function rolesByAdapter(configuration: Configuration) {
  const models =
      (configuration.registry as { models?: { id: string; providerId: string }[] })
        ?.models ?? [],
    result = new Map<string, SuggestionRole[]>();
  for (const [role, binding] of Object.entries(configuration.roles)) {
    const adapter = models.find((m) => m.id === binding?.modelId)?.providerId;
    if (!adapter) continue;
    result.set(adapter, [
      ...(result.get(adapter) ?? []),
      role as SuggestionRole,
    ]);
  }
  return result;
}
export class ProviderConnections {
  /** Recent model lists per stored key (by a hash of the key, never the key). */
  private readonly catalogs = new Map<
    string,
    { at: number; catalog: ModelCatalog }
  >();
  constructor(
    readonly db: Database,
    readonly providers: WorkspaceProviders,
  ) {}
  private cacheKey(workspace: string, adapterId: string, key: string) {
    return `${workspace}:${adapterId}:${createHash("sha256").update(key).digest("hex")}`;
  }
  /** The connections of the active version: adapters with a key slot and a metadata check. */
  private connectionsOf(configuration: Configuration) {
    return configuration.adapters.filter(
      (a): a is typeof a & { credentialEnv: string } =>
        !!a.credentialEnv &&
        Object.hasOwn(this.providers.metadataAdapters, a.kind),
    );
  }
  async list(actor: Actor, workspace: string) {
    await workspaceRole(this.db, actor, workspace, ["owner", "admin"]);
    const version = await this.providers.version(this.db, workspace),
      configuration = version
        ? providerConfigurationSchema.parse(version.configuration)
        : EMPTY_CONFIGURATION,
      rows = (
        await this.db.query<ConnectionRow>(
          "SELECT adapter_id,name,key_ending,key_status,key_reason,tested_at FROM workspace_provider_connections WHERE workspace_id=$1",
          [workspace],
        )
      ).rows,
      used = rolesByAdapter(configuration),
      stored = new Set(Object.keys(version?.sealed_credentials ?? {}));
    return {
      revision: version?.revision ?? 0,
      connections: this.connectionsOf(configuration).map((adapter) => {
        const row = rows.find((r) => r.adapter_id === adapter.id);
        return {
          id: adapter.id,
          kind: adapter.kind,
          label: this.providers.metadataAdapters[adapter.kind]!.label,
          name: row?.name ?? "",
          keyEnding: row?.key_ending ?? null,
          keyStored: stored.has(adapter.credentialEnv),
          keyStatus: row?.key_status ?? "untested",
          keyReason: row?.key_reason ?? null,
          testedAt: row?.tested_at?.toISOString() ?? null,
          usedByRoles: used.get(adapter.id) ?? [],
        };
      }),
      serviceKeys: Object.entries(SERVICE_KEYS).map(([id, slot]) => ({
        id,
        configured: stored.has(slot),
      })),
      keyStorage: "encrypted_server_vault" as const,
    };
  }
  /** Writes a new version with `change` applied, holding the setup lock. */
  private async change(
    actor: Actor,
    workspace: string,
    input: { expectedRevision: number; idempotencyKey: string },
    requestDigest: string,
    apply: (
      client: PoolClient,
      old: Version | undefined,
      configuration: Configuration,
    ) => Promise<{
      configuration: Configuration;
      credentials: Record<string, string | null>;
      after: (revision: number) => Promise<Record<string, unknown>>;
    }>,
  ) {
    return transaction(this.db, async (client) => {
      await this.providers.lockForChange(client, workspace, actor);
      const cached = await this.providers.receipt(
        client,
        workspace,
        input.idempotencyKey,
        requestDigest,
      );
      if (cached) return cached;
      const old = await this.providers.version(client, workspace);
      requireCondition(
        input.expectedRevision === (old?.revision ?? 0),
        "STALE_PROVIDER_REVISION",
        409,
      );
      const current = old
        ? providerConfigurationSchema.parse(old.configuration)
        : structuredClone(EMPTY_CONFIGURATION);
      const next = await apply(client, old, current);
      const committed = await this.providers.commitVersion(
        client,
        workspace,
        actor,
        {
          old,
          configuration: next.configuration,
          jobPolicy: old ? jobPolicySchema.parse(old.job_policy) : defaultJobPolicy,
          credentials: next.credentials,
          // A job keeps the version (and key) it started with; nothing running is stopped.
          cancelRunning: false,
        },
      );
      const result = {
        revision: committed.revision,
        ...(await next.after(committed.revision)),
      };
      await this.providers.storeReceipt(
        client,
        workspace,
        actor,
        input.idempotencyKey,
        requestDigest,
        result,
        "connection",
      );
      return result;
    });
  }
  private async audit(
    client: PoolClient,
    actor: Actor,
    workspace: string,
    type: string,
    payload: Record<string, unknown>,
  ) {
    await appendEvent(client, {
      workspaceId: workspace,
      actorId: actor.id,
      actorKind: "staff",
      type,
      payload,
      idempotencyKey: `${type}:${randomUUID()}`,
    });
  }
  /** Tests a typed key unless the operator saves it untested; a refusal throws its reason code. */
  private async tested(
    actor: Actor,
    workspace: string,
    kindName: string,
    key: string,
    skipTest: boolean | undefined,
    adapterId?: string,
  ) {
    if (skipTest) return { status: "untested" as const, reason: null };
    const checked = await this.providers.checkKey(
      actor,
      workspace,
      kindName,
      key,
    );
    if (checked.outcome !== "ok")
      throw new ApiError(
        checked.outcome === "PROVIDER_METADATA_UNSUPPORTED" ? 409 : 422,
        checked.outcome,
      );
    if (adapterId && checked.catalog)
      this.catalogs.set(this.cacheKey(workspace, adapterId, key), {
        at: Date.now(),
        catalog: checked.catalog,
      });
    return {
      status: "working" as const,
      reason: null,
      catalog: checked.catalog,
    };
  }
  /** A pre-check outside the transaction: a repeated request returns its receipt untested. */
  private async earlier(workspace: string, idempotency: string, digest: string) {
    const row = (
      await this.db.query(
        "SELECT request_digest,result FROM provider_setup_receipts WHERE workspace_id=$1 AND idempotency_key=$2",
        [workspace, idempotency],
      )
    ).rows[0];
    if (!row) return undefined;
    requireCondition(row.request_digest === digest, "IDEMPOTENCY_CONFLICT", 409);
    return row.result as Record<string, unknown>;
  }
  async add(actor: Actor, workspace: string, raw: unknown) {
    await workspaceRole(this.db, actor, workspace, ["owner", "admin"]);
    const parsed = addSchema.safeParse(raw);
    requireCondition(parsed.success, "PROVIDER_CONNECTION_INVALID", 400);
    const input = { ...parsed.data, key: normalizeCredential(parsed.data.key) };
    requireCondition(
      Object.hasOwn(this.providers.metadataAdapters, input.kind),
      "PROVIDER_METADATA_UNSUPPORTED",
      409,
    );
    const digest = this.providers.vault.requestDigest(workspace, {
      operation: "provider_connection_add",
      ...input,
    });
    const repeated = await this.earlier(workspace, input.idempotencyKey, digest);
    if (repeated) return repeated;
    const adapterId = `connection-${randomBytes(4).toString("hex")}`,
      slot = `COURSE_PROVIDER_${randomBytes(8).toString("hex").toUpperCase()}_API_KEY`;
    const test = await this.tested(
      actor,
      workspace,
      input.kind,
      input.key,
      input.skipTest,
      adapterId,
    );
    return this.change(actor, workspace, input, digest, async (client, _old, configuration) => {
      requireCondition(
        configuration.adapters.length < 20,
        "PROVIDER_CONFIGURATION_INVALID",
        400,
      );
      configuration.adapters.push({
        id: adapterId,
        kind: input.kind,
        credentialEnv: slot,
      });
      return {
        configuration,
        credentials: { [slot]: input.key },
        after: async () => {
          await client.query(
            `INSERT INTO workspace_provider_connections(workspace_id,adapter_id,name,key_ending,key_status,key_reason,tested_at)
             VALUES($1,$2,$3,$4,$5,$6,CASE WHEN $5='untested' THEN NULL ELSE clock_timestamp() END)`,
            [
              workspace,
              adapterId,
              input.name ?? "",
              keyEnding(input.key),
              test.status,
              test.reason,
            ],
          );
          await this.audit(client, actor, workspace, "provider.connection.added", {
            connectionId: adapterId,
            kind: input.kind,
            tested: test.status === "working",
          });
          return {
            connection: {
              id: adapterId,
              kind: input.kind,
              keyEnding: keyEnding(input.key),
              keyStatus: test.status,
            },
          };
        },
      };
    });
  }
  private adapterOf(configuration: Configuration, id: string) {
    const adapter = this.connectionsOf(configuration).find((a) => a.id === id);
    requireCondition(adapter, "PROVIDER_CONNECTION_NOT_FOUND", 404);
    return adapter;
  }
  async replaceKey(actor: Actor, workspace: string, id: string, raw: unknown) {
    await workspaceRole(this.db, actor, workspace, ["owner", "admin"]);
    const parsed = replaceSchema.safeParse(raw);
    requireCondition(parsed.success, "PROVIDER_CONNECTION_INVALID", 400);
    const input = { ...parsed.data, key: normalizeCredential(parsed.data.key) };
    const digest = this.providers.vault.requestDigest(workspace, {
      kind: "provider_connection_key",
      id,
      ...input,
    });
    const repeated = await this.earlier(workspace, input.idempotencyKey, digest);
    if (repeated) return repeated;
    const version = await this.providers.version(this.db, workspace);
    requireCondition(version, "PROVIDER_CONNECTION_NOT_FOUND", 404);
    const adapter = this.adapterOf(
      providerConfigurationSchema.parse(version.configuration),
      id,
    );
    const test = await this.tested(
      actor,
      workspace,
      adapter.kind,
      input.key,
      input.skipTest,
      adapter.id,
    );
    return this.change(actor, workspace, input, digest, async (client, _old, configuration) => {
      const target = this.adapterOf(configuration, id);
      return {
        configuration,
        credentials: { [target.credentialEnv]: input.key },
        after: async () => {
          await client.query(
            `INSERT INTO workspace_provider_connections(workspace_id,adapter_id,key_ending,key_status,key_reason,tested_at)
             VALUES($1,$2,$3,$4,$5,CASE WHEN $4='untested' THEN NULL ELSE clock_timestamp() END)
             ON CONFLICT(workspace_id,adapter_id) DO UPDATE SET key_ending=EXCLUDED.key_ending,key_status=EXCLUDED.key_status,
               key_reason=EXCLUDED.key_reason,tested_at=EXCLUDED.tested_at`,
            [workspace, id, keyEnding(input.key), test.status, test.reason],
          );
          await this.audit(client, actor, workspace, "provider.connection.key_replaced", {
            connectionId: id,
            tested: test.status === "working",
          });
          return {
            connection: {
              id,
              kind: target.kind,
              keyEnding: keyEnding(input.key),
              keyStatus: test.status,
            },
          };
        },
      };
    });
  }
  async remove(actor: Actor, workspace: string, id: string, raw: unknown) {
    await workspaceRole(this.db, actor, workspace, ["owner", "admin"]);
    const parsed = removeSchema.safeParse(raw);
    requireCondition(parsed.success, "PROVIDER_CONNECTION_INVALID", 400);
    const input = parsed.data,
      digest = this.providers.vault.requestDigest(workspace, {
        kind: "provider_connection_remove",
        id,
        ...input,
      });
    return this.change(actor, workspace, input, digest, async (client, _old, configuration) => {
      const target = this.adapterOf(configuration, id),
        roles = rolesByAdapter(configuration).get(id) ?? [];
      if (roles.length)
        throw new ApiError(409, "PROVIDER_CONNECTION_IN_USE", "PROVIDER_CONNECTION_IN_USE", { roles });
      requireCondition(
        !configuration.adapters.some(
          (a) => a.automaticFallback?.credentialEnv === target.credentialEnv,
        ),
        "PROVIDER_CONNECTION_IN_USE",
        409,
      );
      configuration.adapters = configuration.adapters.filter((a) => a.id !== id);
      const registry = configuration.registry as {
        revision: string;
        models?: { providerId: string }[];
      };
      configuration.registry = {
        ...registry,
        models: (registry.models ?? []).filter((m) => m.providerId !== id),
      };
      return {
        configuration,
        credentials: { [target.credentialEnv]: null },
        after: async () => {
          await client.query(
            "DELETE FROM workspace_provider_connections WHERE workspace_id=$1 AND adapter_id=$2",
            [workspace, id],
          );
          await this.audit(client, actor, workspace, "provider.connection.removed", {
            connectionId: id,
          });
          return { removed: id };
        },
      };
    });
  }
  /** Tests the stored key again (metadata listing only) and records the result. */
  async test(actor: Actor, workspace: string, id: string) {
    await workspaceRole(this.db, actor, workspace, ["owner", "admin"]);
    const version = await this.providers.version(this.db, workspace);
    requireCondition(version, "PROVIDER_CONNECTION_NOT_FOUND", 404);
    const adapter = this.adapterOf(
        providerConfigurationSchema.parse(version.configuration),
        id,
      ),
      key = this.providers.activeSecrets(workspace, version)[adapter.credentialEnv];
    const outcome = key
      ? (await this.providers.checkKey(actor, workspace, adapter.kind, key)).outcome
      : "PROVIDER_METADATA_CREDENTIAL_MISSING";
    await this.record(workspace, id, outcome);
    return { id, outcome, keyStatus: keyStatus(outcome) };
  }
  private async record(workspace: string, id: string, outcome: string) {
    await this.db.query(
      `INSERT INTO workspace_provider_connections(workspace_id,adapter_id,key_status,key_reason,tested_at) VALUES($1,$2,$3,$4,clock_timestamp())
       ON CONFLICT(workspace_id,adapter_id) DO UPDATE SET key_status=EXCLUDED.key_status,key_reason=EXCLUDED.key_reason,tested_at=EXCLUDED.tested_at`,
      [workspace, id, keyStatus(outcome), outcome === "ok" ? null : outcome],
    );
  }
  /**
   * The model list for one connection's stored key, cached for ten minutes per key. Used by the
   * page and by drafts; a refusal throws its reason code and marks the connection.
   */
  async catalog(workspace: string, version: Version, adapterId: string) {
    const adapter = this.adapterOf(
        providerConfigurationSchema.parse(version.configuration),
        adapterId,
      ),
      key = this.providers.activeSecrets(workspace, version)[adapter.credentialEnv];
    if (!key) {
      await this.record(workspace, adapterId, "PROVIDER_METADATA_CREDENTIAL_MISSING");
      throw new ApiError(409, "PROVIDER_METADATA_CREDENTIAL_MISSING");
    }
    const cacheKey = this.cacheKey(workspace, adapterId, key),
      hit = this.catalogs.get(cacheKey);
    if (hit && Date.now() - hit.at < CATALOG_TTL_MS)
      return { adapter, catalog: hit.catalog };
    let catalog: ModelCatalog;
    try {
      catalog = await boundedMetadataInspection(
        this.providers.metadataAdapters[adapter.kind]!,
        {
          getCredential: () => key,
          configuration: version.configuration,
          signal: AbortSignal.timeout(15000),
        },
      );
      requireCondition(
        !JSON.stringify(catalog).includes(key),
        "PROVIDER_METADATA_INVALID",
        503,
      );
    } catch (error) {
      const code = metadataFailureCode(error);
      await this.record(workspace, adapterId, code);
      throw new ApiError(409, code);
    }
    await this.record(workspace, adapterId, "ok");
    if (this.catalogs.size > 200) this.catalogs.clear();
    this.catalogs.set(cacheKey, { at: Date.now(), catalog });
    return { adapter, catalog };
  }
  async models(actor: Actor, workspace: string, id: string) {
    await workspaceRole(this.db, actor, workspace, ["owner", "admin"]);
    const version = await this.providers.version(this.db, workspace);
    requireCondition(version, "PROVIDER_CONNECTION_NOT_FOUND", 404);
    const { adapter, catalog } = await this.catalog(workspace, version, id),
      methods = this.providers.metadataAdapters[adapter.kind]!.roleMethods;
    return {
      connectionId: id,
      kind: adapter.kind,
      models: catalog.models.map((m) => ({
        remoteModel: m.remoteModel,
        displayName: m.displayName,
        description: m.description,
        inputTokenLimit: m.inputTokenLimit,
        outputTokenLimit: m.outputTokenLimit,
        methods: m.methods,
      })),
      truncated: catalog.truncated,
      roles: SUGGESTION_ROLES.map((role) => {
        const method =
          role === "media"
            ? (methods?.media?.image ?? null)
            : (methods?.[role] ?? null);
        return {
          role,
          needed: NEEDED_ROLES.includes(role),
          method,
          videoMethod: role === "media" ? (methods?.media?.video ?? null) : null,
          offered: role === "media" ? !!methods?.media : !!method,
          suggested:
            role === "media" ? null : suggestModel(adapter.kind, role, catalog, method),
        };
      }),
      generationPerformed: false as const,
      capabilitiesVerified: false as const,
    };
  }
  async setServiceKey(actor: Actor, workspace: string, id: string, raw: unknown) {
    await workspaceRole(this.db, actor, workspace, ["owner", "admin"]);
    requireCondition(Object.hasOwn(SERVICE_KEYS, id), "PROVIDER_SERVICE_KEY_UNKNOWN", 404);
    const parsed = z
      .strictObject({
        expectedRevision: z.number().int().nonnegative(),
        idempotencyKey,
        key: z.string().max(8192).nullable(),
      })
      .safeParse(raw);
    requireCondition(parsed.success, "PROVIDER_CONNECTION_INVALID", 400);
    const input = {
        ...parsed.data,
        key: parsed.data.key === null ? null : normalizeCredential(parsed.data.key),
      },
      slot = SERVICE_KEYS[id as ServiceKeyId],
      digest = this.providers.vault.requestDigest(workspace, {
        kind: "provider_service_key",
        id,
        ...input,
      });
    return this.change(actor, workspace, input, digest, async (client, _old, configuration) => ({
      configuration,
      credentials: { [slot]: input.key },
      after: async () => {
        await this.audit(client, actor, workspace, "provider.service_key.changed", {
          service: id,
          configured: input.key !== null,
        });
        return { service: id, configured: input.key !== null };
      },
    }));
  }
}

export function registerProviderConnectionRoutes(
  app: FastifyInstance,
  auth: ReturnType<typeof authService>,
  service: ProviderConnections,
) {
  const base = "/api/admin/workspaces/:workspaceId/provider-setup",
    params = {
      type: "object",
      additionalProperties: false,
      required: ["workspaceId"],
      properties: { workspaceId: { type: "string", format: "uuid" } },
    },
    withId = {
      type: "object",
      additionalProperties: false,
      required: ["workspaceId", "id"],
      properties: {
        workspaceId: { type: "string", format: "uuid" },
        id: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,127}$" },
      },
    };
  const ids = (request: { params: unknown }) =>
    request.params as { workspaceId: string; id: string };
  // Key-carrying routes: never logged, small bodies, the key is never echoed.
  const silent = { logLevel: "silent" as const };
  app.get(base + "/connections", { schema: { params }, ...silent }, async (request) =>
    service.list(await auth.authenticate(request), ids(request).workspaceId),
  );
  app.post(
    base + "/connections",
    { schema: { params }, bodyLimit: 16384, ...silent },
    async (request) =>
      service.add(await auth.authenticate(request), ids(request).workspaceId, request.body),
  );
  app.put(
    base + "/connections/:id/key",
    { schema: { params: withId }, bodyLimit: 16384, ...silent },
    async (request) =>
      service.replaceKey(
        await auth.authenticate(request),
        ids(request).workspaceId,
        ids(request).id,
        request.body,
      ),
  );
  app.post(
    base + "/connections/:id/test",
    { schema: { params: withId }, bodyLimit: 1024, ...silent },
    async (request) =>
      service.test(await auth.authenticate(request), ids(request).workspaceId, ids(request).id),
  );
  app.delete(
    base + "/connections/:id",
    { schema: { params: withId }, bodyLimit: 1024, ...silent },
    async (request) =>
      service.remove(
        await auth.authenticate(request),
        ids(request).workspaceId,
        ids(request).id,
        request.body,
      ),
  );
  app.get(
    base + "/connections/:id/models",
    { schema: { params: withId }, ...silent },
    async (request) =>
      service.models(await auth.authenticate(request), ids(request).workspaceId, ids(request).id),
  );
  app.put(
    base + "/service-keys/:id",
    { schema: { params: withId }, bodyLimit: 16384, ...silent },
    async (request) =>
      service.setServiceKey(
        await auth.authenticate(request),
        ids(request).workspaceId,
        ids(request).id,
        request.body,
      ),
  );
}
