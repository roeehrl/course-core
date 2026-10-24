import type { FastifyInstance } from "fastify";
import type { authService } from "./auth.js";
import type { PoolClient } from "pg";
import { transaction, type Database } from "./database.js";
import { appendEvent } from "./events.js";
import {
  effectiveLearnerLimitSql,
  learnerLimitSourceSql,
  type DefaultLearnerLimitMode,
} from "./learner-limit.js";
import { requireCondition } from "./errors.js";
import { WorkspaceProviders } from "./provider-setup.js";
import { z } from "zod";
/** Money is the binding limit when tokens are left out: their limit is then the maximum. */
const MAX_LIMIT = 1000000000;
const budgetSchema = z
  .strictObject({
    expectedRevision: z.number().int().nonnegative(),
    idempotencyKey: z.string().regex(/^[A-Za-z0-9:_-]{8,200}$/),
    enrollmentId: z.string().uuid().optional(),
    /** `default_enrollment` is the limit of every learner whose own limit was never set. */
    scope: z.enum(["workspace", "enrollment", "default_enrollment"]).optional(),
    /** `default_enrollment` only: "unlimited" is the explicit choice of no per-learner limit
     * (learner-limit.ts) and carries no amounts; "limit" (the default) sets `limits`. */
    mode: z.enum(["limit", "unlimited"]).optional(),
    limits: z
      .strictObject({
        microUsd: z.number().int().min(0).max(MAX_LIMIT),
        tokens: z.number().int().min(0).max(MAX_LIMIT).optional(),
      })
      .optional(),
    paidWorkApproved: z.boolean(),
  })
  .refine(
    (input) =>
      input.scope === undefined ||
      (input.scope === "enrollment") === (input.enrollmentId !== undefined),
  )
  .refine((input) =>
    input.mode === "unlimited"
      ? input.scope === "default_enrollment" && input.limits === undefined
      : input.limits !== undefined,
  );
/** A spending limit change in the workspace audit log (amounts, mode and consent only). */
async function auditBudgetChange(
  client: PoolClient,
  workspaceId: string,
  actorId: string,
  idempotencyKey: string,
  payload: Record<string, unknown>,
) {
  await appendEvent(client, {
    workspaceId,
    ...(typeof payload.enrollmentId === "string"
      ? { enrollmentId: payload.enrollmentId }
      : {}),
    actorId,
    actorKind: "staff",
    type: "provider.budget_changed",
    payload,
    idempotencyKey: `provider-budget:${idempotencyKey}`,
    supervise: false,
  });
}
export function registerProviderSetupRoutes(
  app: FastifyInstance,
  db: Database,
  auth: ReturnType<typeof authService>,
  service: WorkspaceProviders,
) {
  const base = "/api/admin/workspaces/:workspaceId/provider-setup",
    params = {
      type: "object",
      additionalProperties: false,
      required: ["workspaceId"],
      properties: { workspaceId: { type: "string", format: "uuid" } },
    };
  app.get(base, { schema: { params }, logLevel: "silent" }, async (request) =>
    service.read(
      await auth.authenticate(request),
      (request.params as { workspaceId: string }).workspaceId,
    ),
  );
  app.post(
    base + "/preview-models",
    { schema: { params }, bodyLimit: 8192, logLevel: "silent" },
    async (request) =>
      service.previewModels(
        await auth.authenticate(request),
        (request.params as { workspaceId: string }).workspaceId,
        request.body,
      ),
  );
  app.post(
    base + "/inspect-models",
    { schema: { params }, bodyLimit: 4096, logLevel: "silent" },
    async (request) =>
      service.inspect(
        await auth.authenticate(request),
        (request.params as { workspaceId: string }).workspaceId,
        request.body,
      ),
  );
  // The typed key is in this body: the route is never logged and the key is never echoed.
  app.post(
    base + "/test-key",
    { schema: { params }, bodyLimit: 16384, logLevel: "silent" },
    async (request) =>
      service.testKey(
        await auth.authenticate(request),
        (request.params as { workspaceId: string }).workspaceId,
        request.body,
      ),
  );
  app.post(
    base,
    { schema: { params }, bodyLimit: 200000, logLevel: "silent" },
    async (request) =>
      service.save(
        await auth.authenticate(request),
        (request.params as { workspaceId: string }).workspaceId,
        request.body,
      ),
  );
  app.get(
    base + "/budgets",
    { schema: { params }, logLevel: "silent" },
    async (request) => {
      const actor = await auth.authenticate(request),
        { workspaceId } = request.params as { workspaceId: string };
      await service.read(actor, workspaceId);
      const row = (
        await db.query(
          `SELECT configuration_revision AS revision,limit_micro_usd::text,limit_tokens::text,used_micro_usd::text,used_tokens::text,
             default_enrollment_revision,default_enrollment_limit_mode,default_enrollment_limit_micro_usd::text,default_enrollment_limit_tokens::text
           FROM supervisor_workspace_budgets WHERE workspace_id=$1`,
          [workspaceId],
        )
      ).rows[0];
      const workspace = row
        ? {
            revision: row.revision,
            limit_micro_usd: row.limit_micro_usd,
            limit_tokens: row.limit_tokens,
            used_micro_usd: row.used_micro_usd,
            used_tokens: row.used_tokens,
          }
        : {
            revision: 0,
            limit_micro_usd: "0",
            limit_tokens: "0",
            used_micro_usd: "0",
            used_tokens: "0",
          };
      // mode: "unset" (nothing chosen: learners without an own limit get no paid work), "limit"
      // (the amounts below) or "unlimited" (no per-learner limit, by the owner's choice).
      const defaultEnrollment = {
        revision: row?.default_enrollment_revision ?? 0,
        mode: (row?.default_enrollment_limit_mode ?? "unset") as DefaultLearnerLimitMode,
        limit_micro_usd: row?.default_enrollment_limit_micro_usd ?? null,
        limit_tokens: row?.default_enrollment_limit_tokens ?? null,
      };
      // A learner without an own limit shows the workspace choice, which is what applies
      // (limitSource "unlimited" with null amounts: no per-learner limit).
      const enrollments = (
        await db.query(
          `SELECT e.id AS "enrollmentId",COALESCE(b.configuration_revision,0) AS revision,
             ${learnerLimitSourceSql()} AS "limitSource",
             ${effectiveLearnerLimitSql("micro_usd")}::text AS limit_micro_usd,${effectiveLearnerLimitSql("tokens")}::text AS limit_tokens,
             COALESCE(b.used_micro_usd,0)::text AS used_micro_usd,COALESCE(b.used_tokens,0)::text AS used_tokens
           FROM enrollments e LEFT JOIN supervisor_enrollment_budgets b ON b.enrollment_id=e.id AND b.workspace_id=e.workspace_id
             LEFT JOIN supervisor_workspace_budgets w ON w.workspace_id=e.workspace_id
           WHERE e.workspace_id=$1 ORDER BY e.started_at DESC,e.id LIMIT 100`,
          [workspaceId],
        )
      ).rows;
      return {
        workspace,
        defaultEnrollment,
        enrollments,
        maximumEnrollments: 100,
        usedIncludesReservations: true,
        configurationGrantsNoBudget: true,
      };
    },
  );
  app.post(
    base + "/budgets",
    { schema: { params }, bodyLimit: 4096, logLevel: "silent" },
    async (request) => {
      const actor = await auth.authenticate(request),
        { workspaceId } = request.params as { workspaceId: string },
        parsed = budgetSchema.safeParse(request.body);
      requireCondition(parsed.success, "PROVIDER_BUDGET_INVALID", 400);
      // "No limit per learner" is stored as its own mode, never as a missing amount.
      const unlimited = parsed.data.mode === "unlimited",
        given = parsed.data.limits ?? { microUsd: 0 };
      const input = {
          ...parsed.data,
          limits: {
            microUsd: given.microUsd,
            tokens: given.tokens ?? (given.microUsd === 0 ? 0 : MAX_LIMIT),
          },
        },
        scope =
          input.scope ?? (input.enrollmentId ? "enrollment" : "workspace");
      // Lifting the per-learner limit lets any learner spend up to the workspace total: it is
      // paid work and needs the same consent as a positive amount.
      requireCondition(
        input.paidWorkApproved ||
          (!unlimited && input.limits.microUsd === 0 && input.limits.tokens === 0),
        "PAID_WORK_CONSENT_REQUIRED",
        409,
      );
      return transaction(db, async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          "provider-setup:" + workspaceId,
        ]);
        const member = (
          await client.query(
            "SELECT role FROM memberships WHERE workspace_id=$1 AND user_id=$2 FOR SHARE",
            [workspaceId, actor.id],
          )
        ).rows[0];
        requireCondition(
          member && ["owner", "admin"].includes(member.role),
          "FORBIDDEN",
          403,
        );
        const requestDigest = service.vault.requestDigest(workspaceId, {
            kind: "provider_budget",
            ...input,
          }),
          receipt = (
            await client.query(
              "SELECT request_digest,result FROM provider_setup_receipts WHERE workspace_id=$1 AND idempotency_key=$2",
              [workspaceId, input.idempotencyKey],
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
        if (input.enrollmentId)
          requireCondition(
            (
              await client.query(
                "SELECT id FROM enrollments WHERE id=$1 AND workspace_id=$2 FOR UPDATE",
                [input.enrollmentId, workspaceId],
              )
            ).rowCount,
            "SUPERVISOR_NOT_FOUND",
            404,
          );
        await client.query(
          "INSERT INTO supervisor_workspace_budgets(workspace_id) VALUES($1) ON CONFLICT DO NOTHING",
          [workspaceId],
        );
        const parent = (
          await client.query(
            "SELECT * FROM supervisor_workspace_budgets WHERE workspace_id=$1 FOR UPDATE",
            [workspaceId],
          )
        ).rows[0]!;
        if (scope === "default_enrollment") {
          requireCondition(
            parent.default_enrollment_revision === input.expectedRevision,
            "STALE_PROVIDER_BUDGET_REVISION",
            409,
          );
          const revision = parent.default_enrollment_revision + 1;
          await client.query(
            "UPDATE supervisor_workspace_budgets SET default_enrollment_limit_mode=$2,default_enrollment_limit_micro_usd=$3,default_enrollment_limit_tokens=$4,default_enrollment_revision=$5 WHERE workspace_id=$1",
            unlimited
              ? [workspaceId, "unlimited", null, null, revision]
              : [workspaceId, "limit", input.limits.microUsd, input.limits.tokens, revision],
          );
          const result = {
            revision,
            mode: unlimited ? ("unlimited" as const) : ("limit" as const),
            limits: unlimited ? null : input.limits,
            scope,
            doesNotGrantMastery: true,
            consentRecorded: input.paidWorkApproved,
          };
          await client.query(
            "INSERT INTO provider_setup_receipts(workspace_id,idempotency_key,request_digest,result,actor_id,operation) VALUES($1,$2,$3,$4,$5,$6)",
            [workspaceId, input.idempotencyKey, requestDigest, JSON.stringify(result), actor.id, "budget"],
          );
          await auditBudgetChange(client, workspaceId, actor.id, input.idempotencyKey, {
            scope,
            mode: result.mode,
            previousMode: parent.default_enrollment_limit_mode,
            limits: result.limits,
            consentRecorded: input.paidWorkApproved,
          });
          return result;
        }
        let target = parent;
        if (input.enrollmentId) {
          await client.query(
            "INSERT INTO supervisor_enrollment_budgets(enrollment_id,workspace_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
            [input.enrollmentId, workspaceId],
          );
          target = (
            await client.query(
              "SELECT * FROM supervisor_enrollment_budgets WHERE enrollment_id=$1 AND workspace_id=$2 FOR UPDATE",
              [input.enrollmentId, workspaceId],
            )
          ).rows[0]!;
        }
        requireCondition(
          target.configuration_revision === input.expectedRevision,
          "STALE_PROVIDER_BUDGET_REVISION",
          409,
        );
        requireCondition(
          input.limits.microUsd >= Number(target.used_micro_usd) &&
            input.limits.tokens >= Number(target.used_tokens),
          "PROVIDER_BUDGET_BELOW_USAGE",
          409,
        );
        const revision = target.configuration_revision + 1;
        if (input.enrollmentId)
          await client.query(
            "UPDATE supervisor_enrollment_budgets SET limit_micro_usd=$3,limit_tokens=$4,configuration_revision=$5,limit_source='own' WHERE enrollment_id=$1 AND workspace_id=$2",
            [
              input.enrollmentId,
              workspaceId,
              input.limits.microUsd,
              input.limits.tokens,
              revision,
            ],
          );
        else
          await client.query(
            "UPDATE supervisor_workspace_budgets SET limit_micro_usd=$2,limit_tokens=$3,configuration_revision=$4 WHERE workspace_id=$1",
            [workspaceId, input.limits.microUsd, input.limits.tokens, revision],
          );
        const result = {
          revision,
          limits: input.limits,
          scope,
          doesNotGrantMastery: true,
          consentRecorded: input.paidWorkApproved,
        };
        await client.query(
          "INSERT INTO provider_setup_receipts(workspace_id,idempotency_key,request_digest,result,actor_id,operation) VALUES($1,$2,$3,$4,$5,$6)",
          [
            workspaceId,
            input.idempotencyKey,
            requestDigest,
            JSON.stringify(result),
            actor.id,
            "budget",
          ],
        );
        await auditBudgetChange(client, workspaceId, actor.id, input.idempotencyKey, {
          scope,
          ...(input.enrollmentId ? { enrollmentId: input.enrollmentId } : {}),
          limits: input.limits,
          consentRecorded: input.paidWorkApproved,
        });
        return result;
      });
    },
  );
}
