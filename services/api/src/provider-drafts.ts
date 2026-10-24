import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { z } from "zod";
import { pricingCovers } from "@course-core/providers";
import type { Actor, authService } from "./auth.js";
import { workspaceRole } from "./course-access.js";
import { transaction, type Database } from "./database.js";
import { ApiError, requireCondition } from "./errors.js";
import { appendEvent } from "./events.js";
import {
  evaluateActivation,
  roleChecks,
  type VersionEvaluation,
} from "./agent-evals/gate.js";
import { modelAssignmentsSchema } from "./google-model-setup.js";
import { upgradeLegacyProviderConfiguration } from "./provider-defaults.js";
import {
  composeProviders,
  providerConfigurationSchema,
} from "./provider-composition.js";
import type { ProviderConnections } from "./provider-connections.js";
import { pricingInForce } from "./provider-costs.js";
import {
  configurationTokenBounds,
  defaultJobPolicy,
  jobPolicySchema,
  safeConfiguration,
  type SupervisorJobPolicy,
  type Version,
  type WorkspaceProviders,
} from "./provider-setup.js";
import { SUGGESTION_ROLES } from "./provider-suggestions.js";

/**
 * The workspace's single open setup draft (admin "AI services" page). The server builds the
 * configuration from the operator's model choices exactly as the guided preview does, keeps it
 * until it is activated or discarded, and reports per job what activation still needs (a
 * quality check or an owner's approval, a price). Activation runs the same save path as every
 * other change, so the evaluation gate, token bounds and revision checks still apply on the
 * server. Drafts never contain secrets.
 */
type Configuration = z.infer<typeof providerConfigurationSchema>;
const idempotencyKey = z.string().regex(/^[A-Za-z0-9:_-]{8,200}$/);
const mediaSchema = modelAssignmentsSchema.shape.media.unwrap().unwrap();
const assignment = z.strictObject({
  connectionId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,127}$/),
  remoteModel: z.string().min(1).max(2048),
  media: mediaSchema.omit({ remoteModel: true }).optional(),
});
const modelsDraftSchema = z.strictObject({
  baseRevision: z.number().int().nonnegative(),
  /** A role absent keeps its current model; null turns the job off. */
  assignments: z.partialRecord(z.enum(SUGGESTION_ROLES), assignment.nullable()),
  jobPolicy: jobPolicySchema.optional(),
});
const jsonDraftSchema = z.strictObject({
  baseRevision: z.number().int().nonnegative(),
  configuration: providerConfigurationSchema,
  jobPolicy: jobPolicySchema,
});
const activateSchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative(),
  idempotencyKey,
  confirmCancelRunning: z.boolean(),
});
interface DraftRow {
  id: string;
  base_revision: number;
  source: "models" | "json";
  configuration: Configuration;
  job_policy: SupervisorJobPolicy;
  updated_at: Date;
}
const EMPTY: Configuration = {
  registry: { revision: "ai-services", models: [] },
  adapters: [],
  roles: {},
};
function registryModels(configuration: Configuration) {
  return (
    (
      configuration.registry as {
        models?: { id: string; providerId: string; remoteModel: string }[];
      }
    )?.models ?? []
  );
}
/** Role → connection and model of a configuration, for display. */
export function roleModels(configuration: Configuration) {
  const models = registryModels(configuration);
  return Object.fromEntries(
    Object.entries(configuration.roles).map(([role, binding]) => {
      const model = models.find((m) => m.id === binding?.modelId);
      return [
        role,
        {
          modelId: binding!.modelId,
          connectionId: model?.providerId ?? null,
          remoteModel: model?.remoteModel ?? null,
          mediaKind: binding?.mediaKind ?? null,
        },
      ];
    }),
  );
}
export class ProviderDrafts {
  constructor(
    readonly db: Database,
    readonly providers: WorkspaceProviders,
    readonly connections: ProviderConnections,
  ) {}
  private async previous(client: Database | PoolClient, workspace: string, old: Version | undefined) {
    if (!old) return undefined;
    const evaluation =
      (
        await client.query<{ evaluation: VersionEvaluation | null }>(
          "SELECT evaluation FROM workspace_provider_versions WHERE workspace_id=$1 AND revision=$2",
          [workspace, old.revision],
        )
      ).rows[0]?.evaluation ?? null;
    return {
      configuration: providerConfigurationSchema.parse(old.configuration),
      evaluation,
    };
  }
  /** What the page shows for a draft: per job its model, check state and price state. */
  async view(client: Database | PoolClient, workspace: string, row: DraftRow) {
    const old = await this.providers.version(client, workspace),
      configuration = providerConfigurationSchema.parse(row.configuration),
      evaluated = await evaluateActivation(
        client as PoolClient,
        workspace,
        this.providers.evalSuite,
        await this.previous(client, workspace, old),
        configuration,
      ),
      checks = roleChecks(evaluated),
      models = roleModels(configuration),
      runtime = composeProviders(
        configuration,
        () => "configuration-validation-only",
        this.providers.factories,
      ),
      bound = runtime.roleModels(),
      active = old
        ? roleModels(providerConfigurationSchema.parse(old.configuration))
        : {};
    const roles = [];
    for (const role of SUGGESTION_ROLES) {
      const model = models[role];
      if (!model) continue;
      const binding = bound[role],
        price = await pricingInForce(client, workspace, model.modelId);
      roles.push({
        role,
        ...model,
        check: checks[role]?.check ?? "not_needed",
        priced: !!price && !!binding && pricingCovers(price, binding.pricingKind),
        changed:
          active[role]?.connectionId !== model.connectionId ||
          active[role]?.remoteModel !== model.remoteModel,
      });
    }
    const tokenBounds = configurationTokenBounds(configuration);
    return {
      id: row.id,
      baseRevision: row.base_revision,
      source: row.source,
      stale: row.base_revision !== (old?.revision ?? 0),
      roles,
      removedRoles: Object.keys(active).filter((role) => !models[role]),
      jobPolicy: row.job_policy,
      tokenBounds,
      waitingForCheck: roles.filter((r) => r.check === "needed" || r.check === "failed").map((r) => r.role),
      updatedAt: row.updated_at.toISOString(),
      secretsIncluded: false as const,
    };
  }
  private async store(
    actor: Actor,
    workspace: string,
    build: (client: PoolClient, old: Version | undefined) => Promise<{
      baseRevision: number;
      source: "models" | "json";
      configuration: Configuration;
      jobPolicy: SupervisorJobPolicy;
    }>,
  ) {
    return transaction(this.db, async (client) => {
      await this.providers.lockForChange(client, workspace, actor);
      const old = await this.providers.version(client, workspace),
        draft = await build(client, old);
      requireCondition(
        draft.baseRevision === (old?.revision ?? 0),
        "STALE_PROVIDER_REVISION",
        409,
      );
      safeConfiguration(draft.configuration);
      try {
        composeProviders(
          draft.configuration,
          () => "configuration-validation-only",
          this.providers.factories,
        );
      } catch {
        throw new ApiError(400, "PROVIDER_CONFIGURATION_INVALID");
      }
      const id = randomUUID(),
        row = (
          await client.query<DraftRow>(
            `INSERT INTO provider_setup_drafts(workspace_id,id,base_revision,source,configuration,job_policy,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)
             ON CONFLICT(workspace_id) DO UPDATE SET id=EXCLUDED.id,base_revision=EXCLUDED.base_revision,source=EXCLUDED.source,
               configuration=EXCLUDED.configuration,job_policy=EXCLUDED.job_policy,created_by=EXCLUDED.created_by,updated_at=clock_timestamp()
             RETURNING id,base_revision,source,configuration,job_policy,updated_at`,
            [
              workspace,
              id,
              draft.baseRevision,
              draft.source,
              JSON.stringify(upgradeLegacyProviderConfiguration(draft.configuration, draft.jobPolicy.allowance.tokens)),
              JSON.stringify(draft.jobPolicy),
              actor.id,
            ],
          )
        ).rows[0]!;
      return this.view(client, workspace, row);
    });
  }
  /** A draft from model choices per job, built against each connection's model list. */
  async fromModels(actor: Actor, workspace: string, raw: unknown) {
    await workspaceRole(this.db, actor, workspace, ["owner", "admin"]);
    const parsed = modelsDraftSchema.safeParse(raw);
    requireCondition(parsed.success, "PROVIDER_DRAFT_INVALID", 400);
    const input = parsed.data;
    // Model lists are read before the transaction: they may call the provider (metadata only).
    const version = await this.providers.version(this.db, workspace);
    requireCondition(
      input.baseRevision === (version?.revision ?? 0),
      "STALE_PROVIDER_REVISION",
      409,
    );
    const byConnection = new Map<string, Record<string, unknown>>();
    for (const [role, choice] of Object.entries(input.assignments)) {
      if (!choice) continue;
      requireCondition(version, "PROVIDER_CONNECTION_NOT_FOUND", 404);
      const entry = byConnection.get(choice.connectionId) ?? {};
      entry[role] =
        role === "media"
          ? { remoteModel: choice.remoteModel, kind: "image", ...choice.media }
          : choice.remoteModel;
      byConnection.set(choice.connectionId, entry);
    }
    const catalogs = new Map<string, Awaited<ReturnType<ProviderConnections["catalog"]>>>();
    for (const connectionId of byConnection.keys())
      catalogs.set(connectionId, await this.connections.catalog(workspace, version!, connectionId));
    return this.store(actor, workspace, async (_client, old) => {
      let configuration: Configuration = old
        ? providerConfigurationSchema.parse(old.configuration)
        : structuredClone(EMPTY);
      for (const [role, choice] of Object.entries(input.assignments))
        if (choice === null) delete configuration.roles[role as keyof Configuration["roles"]];
      for (const [connectionId, assignments] of byConnection) {
        const { adapter, catalog } = catalogs.get(connectionId)!,
          builder = this.providers.metadataAdapters[adapter.kind]?.buildDraft;
        requireCondition(builder, "PROVIDER_GUIDE_UNSUPPORTED", 409);
        const parsedAssignments = modelAssignmentsSchema.safeParse(assignments);
        requireCondition(parsedAssignments.success, "PROVIDER_DRAFT_INVALID", 400);
        configuration = providerConfigurationSchema.parse(
          builder({
            configuration,
            adapterId: connectionId,
            catalog,
            assignments: parsedAssignments.data,
          }),
        );
      }
      // The per-request token allowance must cover every job's bound; it grows to fit.
      const base = input.jobPolicy ?? (old ? jobPolicySchema.parse(old.job_policy) : defaultJobPolicy),
        needed = Math.max(1, ...Object.values(configurationTokenBounds(configuration)));
      return {
        baseRevision: input.baseRevision,
        source: "models",
        configuration,
        jobPolicy: {
          ...base,
          allowance: {
            ...base.allowance,
            tokens: Math.min(1000000000, Math.max(base.allowance.tokens, needed)),
          },
        },
      };
    });
  }
  /** The developer editor's path: the same draft and activation, from a whole configuration. */
  async fromJson(actor: Actor, workspace: string, raw: unknown) {
    await workspaceRole(this.db, actor, workspace, ["owner", "admin"]);
    const parsed = jsonDraftSchema.safeParse(raw);
    requireCondition(parsed.success, "PROVIDER_CONFIGURATION_INVALID", 400);
    requireCondition(
      parsed.data.configuration.adapters.length <= 20 &&
        JSON.stringify(parsed.data.configuration.registry ?? null).length <= 80000,
      "PROVIDER_CONFIGURATION_INVALID",
      400,
    );
    return this.store(actor, workspace, async () => ({
      baseRevision: parsed.data.baseRevision,
      source: "json",
      configuration: parsed.data.configuration,
      jobPolicy: parsed.data.jobPolicy,
    }));
  }
  private async row(client: Database | PoolClient, workspace: string) {
    const row = (
      await client.query<DraftRow>(
        "SELECT id,base_revision,source,configuration,job_policy,updated_at FROM provider_setup_drafts WHERE workspace_id=$1",
        [workspace],
      )
    ).rows[0];
    // A draft made before Core set Gemini thinking is read with the same upgrade as the active
    // setup, so its roles compare equal to what saving it will store (provider-defaults.ts).
    return row ? { ...row, configuration: upgradeLegacyProviderConfiguration(row.configuration as never,
      (row.job_policy as { allowance?: { tokens?: number } } | null)?.allowance?.tokens) } : row;
  }
  async current(actor: Actor, workspace: string) {
    await workspaceRole(this.db, actor, workspace, ["owner", "admin"]);
    return transaction(this.db, async (client) => {
      const row = await this.row(client, workspace);
      return { draft: row ? await this.view(client, workspace, row) : null };
    });
  }
  async discard(actor: Actor, workspace: string) {
    return transaction(this.db, async (client) => {
      await this.providers.lockForChange(client, workspace, actor);
      const removed = await client.query(
        "DELETE FROM provider_setup_drafts WHERE workspace_id=$1",
        [workspace],
      );
      return { discarded: removed.rowCount === 1 };
    });
  }
  /** Makes the draft the active setup. Refuses while jobs would be stopped unless confirmed. */
  async activate(actor: Actor, workspace: string, draftId: string, raw: unknown) {
    const parsed = activateSchema.safeParse(raw);
    requireCondition(parsed.success, "PROVIDER_DRAFT_INVALID", 400);
    const input = parsed.data,
      digest = this.providers.vault.requestDigest(workspace, {
        kind: "provider_draft_activation",
        draftId,
        ...input,
      });
    return transaction(this.db, async (client) => {
      await this.providers.lockForChange(client, workspace, actor);
      const cached = await this.providers.receipt(client, workspace, input.idempotencyKey, digest);
      if (cached) return cached;
      const row = await this.row(client, workspace);
      requireCondition(row && row.id === draftId, "PROVIDER_DRAFT_NOT_FOUND", 404);
      const old = await this.providers.version(client, workspace);
      requireCondition(
        input.expectedRevision === (old?.revision ?? 0) &&
          row.base_revision === input.expectedRevision,
        "STALE_PROVIDER_REVISION",
        409,
      );
      const running = await this.providers.runningJobs(client, workspace);
      if (running > 0 && !input.confirmCancelRunning)
        throw new ApiError(409, "PROVIDER_JOBS_RUNNING", "PROVIDER_JOBS_RUNNING", { count: running });
      const committed = await this.providers.commitVersion(client, workspace, actor, {
        old,
        configuration: providerConfigurationSchema.parse(row.configuration),
        jobPolicy: jobPolicySchema.parse(row.job_policy),
        credentials: {},
        cancelRunning: true,
      });
      await client.query("DELETE FROM provider_setup_drafts WHERE workspace_id=$1 AND id=$2", [workspace, draftId]);
      const decisions = Object.fromEntries(
        Object.entries(committed.evaluation.roles).map(([role, d]) => [role, d!.decision]),
      );
      await appendEvent(client, {
        workspaceId: workspace,
        actorId: actor.id,
        actorKind: "staff",
        type: "provider.setup.activated",
        payload: { revision: committed.revision, source: row.source, evaluation: decisions },
        idempotencyKey: `provider.setup.activated:${randomUUID()}`,
      });
      const result = {
        revision: committed.revision,
        configurationSaved: true,
        cancelledPendingJobs: committed.cancelledPendingJobs,
        evaluation: decisions,
        budgetChanged: false,
      };
      await this.providers.storeReceipt(client, workspace, actor, input.idempotencyKey, digest, result, "activation");
      return result;
    });
  }
}

export function registerProviderDraftRoutes(
  app: FastifyInstance,
  auth: ReturnType<typeof authService>,
  service: ProviderDrafts,
) {
  const base = "/api/admin/workspaces/:workspaceId/provider-setup/drafts",
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
        id: { type: "string", format: "uuid" },
      },
    };
  const p = (request: { params: unknown }) =>
    request.params as { workspaceId: string; id: string };
  const silent = { logLevel: "silent" as const };
  app.post(base, { schema: { params }, bodyLimit: 16384, ...silent }, async (request) =>
    service.fromModels(await auth.authenticate(request), p(request).workspaceId, request.body),
  );
  app.post(base + "/json", { schema: { params }, bodyLimit: 200000, ...silent }, async (request) =>
    service.fromJson(await auth.authenticate(request), p(request).workspaceId, request.body),
  );
  app.get(base + "/current", { schema: { params }, ...silent }, async (request) =>
    service.current(await auth.authenticate(request), p(request).workspaceId),
  );
  app.delete(base + "/current", { schema: { params }, ...silent }, async (request) =>
    service.discard(await auth.authenticate(request), p(request).workspaceId),
  );
  app.post(
    base + "/:id/activate",
    { schema: { params: withId }, bodyLimit: 4096, ...silent },
    async (request) =>
      service.activate(
        await auth.authenticate(request),
        p(request).workspaceId,
        p(request).id,
        request.body,
      ),
  );
}
