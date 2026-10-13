import { z } from "zod";
import type { PoolClient } from "pg";
import type { ProviderRuntime } from "./provider-runtime.js";
import {
  composeProviders,
  providerConfigurationSchema,
  unconfiguredProviders,
  type AdapterFactory,
} from "./provider-composition.js";
import type { CredentialVault } from "./credential-vault.js";
import { transaction, type Database } from "./database.js";
import { membership, type Actor } from "./auth.js";
import { requireCondition, ApiError } from "./errors.js";

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
  credentials: z
    .record(credentialName, z.string().min(1).max(8192).nullable())
    .default({}),
});
interface Version {
  revision: number;
  configuration: z.infer<typeof providerConfigurationSchema>;
  job_policy: SupervisorJobPolicy;
  sealed_credentials: Record<string, string>;
}
const aad = (workspace: string, revision: number, name: string) =>
  JSON.stringify(["course-core-provider-v1", workspace, revision, name]);
function safeConfiguration(value: unknown) {
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
  ) {}
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
    return Object.fromEntries(
      Object.entries(row.sealed_credentials).map(([name, body]) => [
        name,
        this.vault.open(aad(workspace, row.revision, name), body),
      ]),
    );
  }
  runtime(workspace: string, row: Version) {
    const secrets = this.values(workspace, row);
    return composeProviders(
      row.configuration,
      (name) => secrets[name],
      this.factories,
    );
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
    await membership(this.db, actor, workspace, ["owner", "admin"]);
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
    };
  }
  async save(actor: Actor, workspace: string, raw: unknown) {
    const parsed = providerSetupSchema.safeParse(raw);
    requireCondition(parsed.success, "PROVIDER_CONFIGURATION_INVALID", 400);
    const input = parsed.data;
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
        const sealed = Object.fromEntries(
          Object.entries(secrets).map(([name, value]) => [
            name,
            this.vault.seal(aad(workspace, revision, name), value),
          ]),
        );
        await client.query(
          "INSERT INTO workspace_provider_versions(workspace_id,revision,configuration,job_policy,sealed_credentials,changed_by) VALUES($1,$2,$3,$4,$5,$6)",
          [
            workspace,
            revision,
            JSON.stringify(input.configuration),
            JSON.stringify(input.jobPolicy),
            JSON.stringify(sealed),
            actor.id,
          ],
        );
        await client.query(
          "INSERT INTO workspace_provider_settings(workspace_id,revision) VALUES($1,$2) ON CONFLICT(workspace_id) DO UPDATE SET revision=EXCLUDED.revision,updated_at=clock_timestamp()",
          [workspace, revision],
        );
        const cancelled = await client.query(
          "UPDATE supervisor_jobs SET cancellation_requested=true WHERE workspace_id=$1 AND NOT cancellation_requested AND state NOT IN ('applied','cancelled','failed')",
          [workspace],
        );
        const receiptResult = {
          revision,
          configurationSaved: true,
          verification: "not_run",
          cancelledPendingJobs: cancelled.rowCount ?? 0,
          budgetChanged: false,
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
