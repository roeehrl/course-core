import { z } from "zod";
import { modelAssignmentsSchema } from "./google-model-setup.js";
import { randomUUID } from "node:crypto";
import {
  googleMetadataAdapter,
  anthropicMetadataAdapter,
  boundedMetadataInspection,
  metadataFailureCode,
  type MetadataAdapter,
} from "./provider-metadata.js";
import { appendEvent } from "./events.js";
import type { PoolClient } from "pg";
import type { ProviderRuntime } from "./provider-runtime.js";
import {
  composeProviders,
  providerConfigurationSchema,
  unconfiguredProviders,
  type AdapterFactory,
} from "./provider-composition.js";
import type { CredentialVault } from "./key-vault.js";
import { transaction, type Database } from "./database.js";
import type { Actor } from "./auth.js";
import { workspaceRole } from "./course-access.js";
import { requireCondition, ApiError } from "./errors.js";
import { requestSupervisorCancellation } from "./supervisor-cancellation.js";
import { activationDecision, type VersionEvaluation } from "./agent-evals/gate.js";
import { publicSuite } from "./agent-evals/public-suite.js";
import type { EvalSuite } from "./agent-evals/suite.js";

export const jobPolicySchema = z.strictObject({
  allowance: z.strictObject({
    microUsd: z.number().int().min(1).max(1000000000),
    tokens: z.number().int().min(1).max(1000000000),
  }),
  durationMs: z.number().int().min(1000).max(86400000),
  timeoutMs: z.number().int().min(100).max(120000),
  maxAttempts: z.number().int().min(1).max(5),
});
export type SupervisorJobPolicy = z.infer<typeof jobPolicySchema>;
export const defaultJobPolicy: SupervisorJobPolicy = {
  allowance: { microUsd: 100000, tokens: 10000 },
  durationMs: 300000,
  timeoutMs: 60000,
  maxAttempts: 3,
};
export function configurationTokenBounds(
  configuration: z.infer<typeof providerConfigurationSchema>,
) {
  return Object.fromEntries(
    Object.entries(configuration.roles)
      .filter(
        (entry): entry is [string, NonNullable<(typeof entry)[1]>] =>
          !!entry[1],
      )
      .map(([role, binding]) => [
        role,
        role === "media" && binding.mediaKind === "video"
          ? 1
          : (binding.maxToolRounds ?? 1) *
            (binding.maxInputCharacters * 4 + binding.maxOutputTokens + 4096),
      ]),
  );
}
const credentialName = z
  .string()
  .regex(/^(?:GOOGLE_API_KEY|COURSE_PROVIDER_[A-Z0-9_]+_API_KEY)$/);
export const providerSetupSchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative(),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9:_-]{8,200}$/),
  configuration: providerConfigurationSchema,
  jobPolicy: jobPolicySchema,
  // Values are checked by normalizeCredential, which gives empty and malformed keys their own codes.
  credentials: z
    .record(credentialName, z.string().max(8192).nullable())
    .default({}),
});
/** Whitespace and invisible characters a copy and paste can add around a key. */
const pastedEdges =
  /^[\s\u200b-\u200d\u2060\ufeff]+|[\s\u200b-\u200d\u2060\ufeff]+$/g;
/**
 * A key as stored and sent: surrounding whitespace, line breaks and zero-width characters
 * from a paste are removed. An empty key is refused (400 PROVIDER_CREDENTIAL_EMPTY), and so
 * is one that still contains anything but printable ASCII (400 PROVIDER_CREDENTIAL_MALFORMED):
 * provider API keys never do, and a key that does would only fail later at the provider.
 */
export function normalizeCredential(value: string) {
  const key = value.replace(pastedEdges, "");
  requireCondition(key, "PROVIDER_CREDENTIAL_EMPTY", 400);
  requireCondition(
    /^[\x21-\x7e]+$/.test(key),
    "PROVIDER_CREDENTIAL_MALFORMED",
    400,
  );
  return key;
}
/** Limits on testing typed keys. Each test makes provider requests from this host. */
export interface KeyTestLimits {
  timeoutMs: number;
  perMinute: number;
  perHour: number;
  concurrent: number;
}
export const defaultKeyTestLimits: KeyTestLimits = {
  timeoutMs: 10000,
  perMinute: 6,
  perHour: 30,
  concurrent: 2,
};
interface Version {
  revision: number;
  configuration: z.infer<typeof providerConfigurationSchema>;
  job_policy: SupervisorJobPolicy;
  sealed_credentials: Record<string, string>;
}
const aad = (workspace: string, revision: number, name: string) =>
  JSON.stringify(["course-core-provider-v1", workspace, revision, name]);
export function safeConfiguration(value: unknown) {
  const walk = (v: unknown, depth: number) => {
    requireCondition(depth < 30, "PROVIDER_CONFIGURATION_INVALID", 400);
    if (Array.isArray(v)) v.forEach((x) => walk(x, depth + 1));
    else if (v && typeof v === "object")
      for (const [key, item] of Object.entries(v)) {
        requireCondition(
          !/^(api[-_]?key|secret|password|authorization|credentials?|access[-_]?token|refresh[-_]?token)$/i.test(
            key,
          ),
          "PROVIDER_SECRET_FIELD_FORBIDDEN",
          400,
        );
        walk(item, depth + 1);
      }
  };
  requireCondition(
    JSON.stringify(value).length <= 100000,
    "PROVIDER_CONFIGURATION_INVALID",
    400,
  );
  walk(value, 0);
}
export class WorkspaceProviders {
  constructor(
    readonly db: Database,
    readonly vault: CredentialVault,
    readonly factories: Record<string, AdapterFactory> = {},
    readonly fallback: ProviderRuntime = unconfiguredProviders(),
    readonly metadataAdapters: Record<string, MetadataAdapter> = {
      google: googleMetadataAdapter(),
      anthropic: anthropicMetadataAdapter(),
    },
    /** The eval suite a changed role revision must pass before it activates (agent-evals/gate.ts). */
    readonly evalSuite: EvalSuite = publicSuite(),
    readonly keyTestLimits: KeyTestLimits = defaultKeyTestLimits,
  ) {}
  /** Recent key-test start times and running tests per workspace. This rate limit is per
   * API process; every completed test is also recorded in the workspace audit log. */
  private readonly keyTests = new Map<
    string,
    { started: number[]; running: number }
  >();
  /** Refuses secret-looking fields and oversized documents in a public configuration. */
  checkPublicConfiguration(value: unknown) {
    safeConfiguration(value);
  }
  async version(
    client: Database | PoolClient,
    workspace: string,
    revision?: number,
  ): Promise<Version | undefined> {
    const row = (
      await client.query<Version>(
        revision === undefined
          ? `SELECT v.revision,v.configuration,v.job_policy,v.sealed_credentials FROM workspace_provider_settings s JOIN workspace_provider_versions v USING(workspace_id,revision) WHERE s.workspace_id=$1`
          : `SELECT revision,configuration,job_policy,sealed_credentials FROM workspace_provider_versions WHERE workspace_id=$1 AND revision=$2`,
        revision === undefined ? [workspace] : [workspace, revision],
      )
    ).rows[0];
    return row;
  }
  private values(workspace: string, row: Version) {
    const values: Record<string, string> = {};
    for (const [name, body] of Object.entries(row.sealed_credentials)) {
      // Versions saved before keys were normalized hold the key as pasted; whitespace around
      // a key is never part of it. A value that is only whitespace counts as no key.
      const value = this.vault
        .open(aad(workspace, row.revision, name), body)
        .replace(pastedEdges, "");
      if (value) values[name] = value;
    }
    return values;
  }
  runtime(workspace: string, row: Version) {
    const secrets = this.values(workspace, row);
    return composeProviders(
      row.configuration,
      (name) => secrets[name],
      this.factories,
    );
  }
  /** One stored credential for a server-side adapter (e.g. YouTube search). The value
   * stays in process memory: it is never returned by a route, logged or put in a URL. */
  async credential(workspace: string, name: string, client: Database | PoolClient = this.db): Promise<string | undefined> {
    const row = await this.version(client, workspace);
    return row ? this.values(workspace, row)[name] : undefined;
  }
  async resolve(workspace: string, client: Database | PoolClient = this.db) {
    const row = await this.version(client, workspace);
    return row ? this.runtime(workspace, row) : this.fallback;
  }
  async resolveJob(jobId: string, workspace: string) {
    const row = (
      await this.db.query(
        "SELECT provider_revision FROM supervisor_jobs WHERE id=$1 AND workspace_id=$2",
        [jobId, workspace],
      )
    ).rows[0];
    requireCondition(row, "SUPERVISOR_NOT_FOUND", 404);
    if (row.provider_revision === null) return this.fallback;
    const version = await this.version(
      this.db,
      workspace,
      row.provider_revision,
    );
    requireCondition(version, "PROVIDER_CONFIGURATION_UNAVAILABLE", 503);
    return this.runtime(workspace, version);
  }
  async bind(client: PoolClient, workspace: string) {
    await client.query("SELECT id FROM workspaces WHERE id=$1 FOR SHARE", [
      workspace,
    ]);
    const row = await this.version(client, workspace);
    return row
      ? {
          revision: row.revision,
          jobPolicy: jobPolicySchema.parse(row.job_policy),
        }
      : null;
  }
  async read(actor: Actor, workspace: string) {
    await workspaceRole(this.db, actor, workspace, ["owner", "admin"]);
    const row = await this.version(this.db, workspace),
      runtime = row ? this.runtime(workspace, row) : this.fallback;
    return {
      revision: row?.revision ?? 0,
      configuration: row?.configuration ?? {
        registry: { revision: "unconfigured", models: [] },
        adapters: [],
        roles: {},
      },
      jobPolicy: row?.job_policy ?? defaultJobPolicy,
      tokenBounds: row ? configurationTokenBounds(row.configuration) : {},
      credentials: Object.keys(row?.sealed_credentials ?? {}).map((name) => ({
        name,
        configured: true,
      })),
      models: runtime.describe(),
      roles: runtime.status(),
      verification: "not_run",
      storage: "encrypted_server_vault",
      budgetIsSeparate: true,
      metadataKinds: this.metadataKinds(),
    };
  }
  metadataKinds() {
    return Object.entries(this.metadataAdapters).map(([kind, adapter]) => ({
      kind,
      label: adapter.label,
      guided: !!adapter.buildDraft,
      roleMethods: adapter.roleMethods ?? null,
    }));
  }
  async previewModels(actor: Actor, workspace: string, raw: unknown) {
    const parsed = z
      .strictObject({
        expectedRevision: z.number().int().positive(),
        inspectionId: z.string().uuid(),
        assignments: modelAssignmentsSchema,
      })
      .safeParse(raw);
    requireCondition(parsed.success, "PROVIDER_GUIDE_INVALID", 400);
    const input = parsed.data;
    return transaction(this.db, async (client) => {
      const member = (
        await client.query(
          "SELECT role FROM memberships WHERE workspace_id=$1 AND user_id=$2 FOR SHARE",
          [workspace, actor.id],
        )
      ).rows[0];
      requireCondition(
        member && ["owner", "admin"].includes(member.role),
        "FORBIDDEN",
        403,
      );
      const current = await this.version(client, workspace);
      requireCondition(
        current?.revision === input.expectedRevision,
        "STALE_PROVIDER_REVISION",
        409,
      );
      const receipt = (
        await client.query(
          "SELECT adapter_id,result FROM workspace_provider_inspections WHERE id=$1 AND workspace_id=$2 AND provider_revision=$3 AND actor_id=$4 AND state='complete'",
          [input.inspectionId, workspace, current.revision, actor.id],
        )
      ).rows[0];
      requireCondition(receipt, "PROVIDER_GUIDE_INSPECTION_REQUIRED", 409);
      const adapter = current.configuration.adapters.find(
          (a) => a.id === receipt.adapter_id,
        ),
        builder = adapter && this.metadataAdapters[adapter.kind]?.buildDraft;
      requireCondition(adapter && builder, "PROVIDER_GUIDE_UNSUPPORTED", 409);
      const configuration = providerConfigurationSchema.parse(
        builder({
          configuration: current.configuration,
          adapterId: adapter.id,
          catalog: receipt.result,
          assignments: input.assignments,
        }),
      );
      safeConfiguration(configuration);
      composeProviders(
        configuration,
        () => "configuration-validation-only",
        this.factories,
      );
      const tokenBounds = configurationTokenBounds(configuration);
      return {
        configuration,
        tokenBounds,
        minimumTokens: Math.max(1, ...Object.values(tokenBounds)),
        paidBudgetChanged: false,
        capabilitiesVerified: false,
        generationPerformed: false,
      };
    });
  }
  async inspect(actor: Actor, workspace: string, raw: unknown) {
    const schema = z.strictObject({
        expectedRevision: z.number().int().positive(),
        idempotencyKey: z.string().regex(/^[A-Za-z0-9:_-]{8,200}$/),
        adapterId: z.string().min(1).max(128),
      }),
      parsed = schema.safeParse(raw);
    requireCondition(parsed.success, "PROVIDER_METADATA_INVALID", 400);
    const input = parsed.data;
    const admitted = await transaction(this.db, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        "provider-metadata:" + workspace,
      ]);
      const member = (
        await client.query(
          "SELECT role FROM memberships WHERE workspace_id=$1 AND user_id=$2 FOR SHARE",
          [workspace, actor.id],
        )
      ).rows[0];
      requireCondition(
        member && ["owner", "admin"].includes(member.role),
        "FORBIDDEN",
        403,
      );
      await client.query(
        "UPDATE workspace_provider_inspections SET state='failed',reason_code='PROVIDER_METADATA_INTERRUPTED',finished_at=clock_timestamp() WHERE workspace_id=$1 AND state='in_flight' AND deadline_at<=clock_timestamp()",
        [workspace],
      );
      const old = (
        await client.query(
          "SELECT * FROM workspace_provider_inspections WHERE workspace_id=$1 AND idempotency_key=$2",
          [workspace, input.idempotencyKey],
        )
      ).rows[0];
      if (old) {
        requireCondition(
          old.actor_id === actor.id &&
            old.provider_revision === input.expectedRevision &&
            old.adapter_id === input.adapterId,
          "IDEMPOTENCY_CONFLICT",
          409,
        );
        return {
          cached: {
            id: old.id,
            state: old.state,
            result: old.result,
            reason: old.reason_code,
          },
        };
      }
      const version = await this.version(client, workspace);
      requireCondition(
        version && version.revision === input.expectedRevision,
        "STALE_PROVIDER_REVISION",
        409,
      );
      const adapter = version.configuration.adapters.find(
        (a) => a.id === input.adapterId,
      );
      requireCondition(
        adapter && Object.hasOwn(this.metadataAdapters, adapter.kind),
        "PROVIDER_METADATA_UNSUPPORTED",
        409,
      );
      requireCondition(
        Number(
          (
            await client.query(
              "SELECT count(*) FROM workspace_provider_inspections WHERE workspace_id=$1 AND state='in_flight'",
              [workspace],
            )
          ).rows[0].count,
        ) < 2,
        "PROVIDER_METADATA_BUSY",
        409,
      );
      const id = randomUUID();
      await client.query(
        "INSERT INTO workspace_provider_inspections(id,workspace_id,provider_revision,adapter_id,actor_id,idempotency_key,state,deadline_at) VALUES($1,$2,$3,$4,$5,$6,'in_flight',clock_timestamp()+interval '15 seconds')",
        [
          id,
          workspace,
          version.revision,
          adapter.id,
          actor.id,
          input.idempotencyKey,
        ],
      );
      return { id, version, adapter };
    });
    if (admitted.cached) return admitted.cached;
    const { id, version, adapter } = admitted;
    let result: unknown = null,
      reason: string | null = null;
    try {
      const secrets = this.values(workspace, version),
        credential = adapter.credentialEnv ? secrets[adapter.credentialEnv] : undefined;
      requireCondition(credential, "PROVIDER_METADATA_CREDENTIAL_MISSING", 409);
      result = await boundedMetadataInspection(
        this.metadataAdapters[adapter.kind]!,
        {
          getCredential: () => credential,
          configuration: version.configuration,
          signal: AbortSignal.timeout(15000),
        },
      );
      for (const value of Object.values(secrets))
        requireCondition(
          !JSON.stringify(result).includes(value),
          "PROVIDER_METADATA_INVALID",
          503,
        );
    } catch (e) {
      reason = metadataFailureCode(e);
      result = null;
    }
    return transaction(this.db, async (client) => {
      const member = (
          await client.query(
            "SELECT role FROM memberships WHERE workspace_id=$1 AND user_id=$2 FOR SHARE",
            [workspace, actor.id],
          )
        ).rows[0],
        current = await this.version(client, workspace);
      if (
        !member ||
        !["owner", "admin"].includes(member.role) ||
        current?.revision !== version.revision
      ) {
        reason = "PROVIDER_METADATA_SCOPE_CHANGED";
        result = null;
      }
      const receipt = (
        await client.query(
          "SELECT state,deadline_at>clock_timestamp() AS timely FROM workspace_provider_inspections WHERE id=$1 AND workspace_id=$2 FOR UPDATE",
          [id, workspace],
        )
      ).rows[0];
      if (!receipt?.timely || receipt.state !== "in_flight") {
        reason = "PROVIDER_METADATA_INTERRUPTED";
        result = null;
      }
      const state = reason ? "failed" : "complete";
      await client.query(
        "UPDATE workspace_provider_inspections SET state=$2,result=$3,reason_code=$4,finished_at=clock_timestamp() WHERE id=$1 AND workspace_id=$5",
        [
          id,
          state,
          result === null ? null : JSON.stringify(result),
          reason,
          workspace,
        ],
      );
      return { id, state, result, reason };
    });
  }
  /**
   * Tests a typed key before it is saved: the adapter's metadata listing only (no generation,
   * no learner data), within a short deadline. The key is used for this one request and then
   * dropped; it is not stored, returned, logged or audited. The audit log records who tested
   * which installed kind and the outcome code.
   */
  async testKey(actor: Actor, workspace: string, raw: unknown) {
    await workspaceRole(this.db, actor, workspace, ["owner", "admin"]);
    const parsed = z
      .strictObject({
        kind: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,99}$/),
        key: z.string().max(8192),
      })
      .safeParse(raw);
    requireCondition(parsed.success, "PROVIDER_KEY_TEST_INVALID", 400);
    const key = normalizeCredential(parsed.data.key),
      kind = parsed.data.kind,
      adapter = Object.hasOwn(this.metadataAdapters, kind)
        ? this.metadataAdapters[kind]
        : undefined;
    const limits = this.keyTestLimits,
      now = Date.now(),
      state = this.keyTests.get(workspace) ?? { started: [], running: 0 };
    state.started = state.started.filter((at) => at > now - 3600000);
    requireCondition(
      state.running < limits.concurrent &&
        state.started.length < limits.perHour &&
        state.started.filter((at) => at > now - 60000).length <
          limits.perMinute,
      "PROVIDER_KEY_TEST_RATE_LIMITED",
      429,
    );
    state.started.push(now);
    state.running++;
    this.keyTests.set(workspace, state);
    let outcome: string = "ok",
      modelCount: number | null = null,
      truncated: boolean | null = null;
    try {
      if (!adapter) outcome = "PROVIDER_METADATA_UNSUPPORTED";
      else {
        const catalog = await boundedMetadataInspection(adapter, {
          getCredential: () => key,
          configuration: null,
          signal: AbortSignal.timeout(limits.timeoutMs),
        });
        requireCondition(
          !JSON.stringify(catalog).includes(key),
          "PROVIDER_METADATA_INVALID",
          503,
        );
        modelCount = catalog.models.length;
        truncated = catalog.truncated;
      }
    } catch (e) {
      outcome = metadataFailureCode(e);
    } finally {
      state.running--;
    }
    await transaction(this.db, (client) =>
      appendEvent(client, {
        workspaceId: workspace,
        actorId: actor.id,
        actorKind: "staff",
        type: "provider.key_tested",
        payload: { kind: adapter ? kind : null, outcome, modelCount },
        idempotencyKey: "provider-key-test:" + randomUUID(),
      }),
    );
    return {
      kind,
      outcome,
      modelCount,
      truncated,
      stored: false,
      generationPerformed: false,
    };
  }
  async save(actor: Actor, workspace: string, raw: unknown) {
    const parsed = providerSetupSchema.safeParse(raw);
    requireCondition(parsed.success, "PROVIDER_CONFIGURATION_INVALID", 400);
    const input = {
      ...parsed.data,
      credentials: Object.fromEntries(
        Object.entries(parsed.data.credentials).map(([name, value]) => [
          name,
          value === null ? null : normalizeCredential(value),
        ]),
      ),
    };
    safeConfiguration(input.configuration);
    requireCondition(
      input.configuration.registry &&
        JSON.stringify(input.configuration.registry).length <= 80000 &&
        input.configuration.adapters.length <= 20,
      "PROVIDER_CONFIGURATION_INVALID",
      400,
    );
    const requestDigest = this.vault.requestDigest(workspace, input),
      result = await transaction(this.db, async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          "provider-setup:" + workspace,
        ]);
        await client.query(
          "SELECT id FROM workspaces WHERE id=$1 FOR NO KEY UPDATE",
          [workspace],
        );
        const member = (
          await client.query(
            "SELECT role FROM memberships WHERE workspace_id=$1 AND user_id=$2 FOR SHARE",
            [workspace, actor.id],
          )
        ).rows[0];
        requireCondition(
          member && ["owner", "admin"].includes(member.role),
          "FORBIDDEN",
          403,
        );
        const receipt = (
          await client.query(
            "SELECT request_digest,result FROM provider_setup_receipts WHERE workspace_id=$1 AND idempotency_key=$2",
            [workspace, input.idempotencyKey],
          )
        ).rows[0];
        if (receipt) {
          requireCondition(
            receipt.request_digest === requestDigest,
            "IDEMPOTENCY_CONFLICT",
            409,
          );
          return receipt.result;
        }
        const old = await this.version(client, workspace),
          revision = (old?.revision ?? 0) + 1;
        requireCondition(
          input.expectedRevision === revision - 1,
          "STALE_PROVIDER_REVISION",
          409,
        );
        const secrets = old ? this.values(workspace, old) : {};
        for (const [name, value] of Object.entries(input.credentials)) {
          if (value === null) delete secrets[name];
          else secrets[name] = value;
        }
        requireCondition(
          Object.keys(secrets).length <= 20 &&
            JSON.stringify(secrets).length <= 32768,
          "PROVIDER_CREDENTIAL_LIMIT",
          400,
        );
        const publicText = JSON.stringify(input.configuration);
        for (const value of Object.values(secrets))
          requireCondition(
            !publicText.includes(value),
            "PROVIDER_SECRET_FIELD_FORBIDDEN",
            400,
          );
        try {
          const runtime = composeProviders(
            input.configuration,
            (name) => secrets[name],
            this.factories,
          );
          requireCondition(
            runtime.describe().length <= 20,
            "PROVIDER_CONFIGURATION_INVALID",
            400,
          );
        } catch {
          throw new ApiError(400, "PROVIDER_CONFIGURATION_INVALID");
        }
        requireCondition(
          Object.values(configurationTokenBounds(input.configuration)).every(
            (bound) => bound <= input.jobPolicy.allowance.tokens,
          ),
          "PROVIDER_TOKEN_RESERVATION_TOO_SMALL",
          409,
        );
        // Agent eval gate: a changed or new revision of a covered role needs a passing
        // result or an owner override (409 PROVIDER_EVAL_REQUIRED otherwise).
        const previousEvaluation = old
          ? ((
              await client.query<{ evaluation: VersionEvaluation | null }>(
                "SELECT evaluation FROM workspace_provider_versions WHERE workspace_id=$1 AND revision=$2",
                [workspace, old.revision],
              )
            ).rows[0]?.evaluation ?? null)
          : null;
        const evaluation = await activationDecision(
          client,
          workspace,
          this.evalSuite,
          old
            ? { configuration: old.configuration, evaluation: previousEvaluation }
            : undefined,
          input.configuration,
        );
        const sealed = Object.fromEntries(
          Object.entries(secrets).map(([name, value]) => [
            name,
            this.vault.seal(aad(workspace, revision, name), value),
          ]),
        );
        await client.query(
          "INSERT INTO workspace_provider_versions(workspace_id,revision,configuration,job_policy,sealed_credentials,changed_by,evaluation) VALUES($1,$2,$3,$4,$5,$6,$7)",
          [
            workspace,
            revision,
            JSON.stringify(input.configuration),
            JSON.stringify(input.jobPolicy),
            JSON.stringify(sealed),
            actor.id,
            JSON.stringify(evaluation),
          ],
        );
        await client.query(
          "INSERT INTO workspace_provider_settings(workspace_id,revision) VALUES($1,$2) ON CONFLICT(workspace_id) DO UPDATE SET revision=EXCLUDED.revision,updated_at=clock_timestamp()",
          [workspace, revision],
        );
        // Recorded first (authoritative), then signalled so a call already under way ends now.
        const cancelled = await requestSupervisorCancellation(client, { workspaceId: workspace }, "provider_changed");
        const receiptResult = {
          revision,
          configurationSaved: true,
          verification: "not_run",
          cancelledPendingJobs: cancelled.newlyCancelled,
          budgetChanged: false,
          evaluation: Object.fromEntries(
            Object.entries(evaluation.roles).map(([role, d]) => [role, d!.decision]),
          ),
        };
        await client.query(
          "INSERT INTO provider_setup_receipts(workspace_id,idempotency_key,request_digest,result,actor_id,operation) VALUES($1,$2,$3,$4,$5,$6)",
          [
            workspace,
            input.idempotencyKey,
            requestDigest,
            JSON.stringify(receiptResult),
            actor.id,
            "configuration",
          ],
        );
        return receiptResult;
      });
    return result;
  }
}
