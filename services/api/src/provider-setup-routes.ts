import type { FastifyInstance } from "fastify";
import type { authService } from "./auth.js";
import { transaction, type Database } from "./database.js";
import { requireCondition } from "./errors.js";
import { WorkspaceProviders } from "./provider-setup.js";
import { z } from "zod";
const budgetSchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative(),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9:_-]{8,200}$/),
  enrollmentId: z.string().uuid().optional(),
  limits: z.strictObject({
    microUsd: z.number().int().min(0).max(1000000000),
    tokens: z.number().int().min(0).max(1000000000),
  }),
  paidWorkApproved: z.boolean(),
});
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
      const workspace = (
        await db.query(
          "SELECT configuration_revision AS revision,limit_micro_usd,limit_tokens,used_micro_usd,used_tokens FROM supervisor_workspace_budgets WHERE workspace_id=$1",
          [workspaceId],
        )
      ).rows[0] ?? {
        revision: 0,
        limit_micro_usd: "0",
        limit_tokens: "0",
        used_micro_usd: "0",
        used_tokens: "0",
      };
      const enrollments = (
        await db.query(
          `SELECT e.id AS "enrollmentId",COALESCE(b.configuration_revision,0) AS revision,COALESCE(b.limit_micro_usd,0)::text AS limit_micro_usd,COALESCE(b.limit_tokens,0)::text AS limit_tokens,COALESCE(b.used_micro_usd,0)::text AS used_micro_usd,COALESCE(b.used_tokens,0)::text AS used_tokens FROM enrollments e LEFT JOIN supervisor_enrollment_budgets b ON b.enrollment_id=e.id AND b.workspace_id=e.workspace_id WHERE e.workspace_id=$1 ORDER BY e.started_at DESC,e.id LIMIT 100`,
          [workspaceId],
        )
      ).rows;
      return {
        workspace,
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
      const input = parsed.data;
      requireCondition(
        input.paidWorkApproved ||
          (input.limits.microUsd === 0 && input.limits.tokens === 0),
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
            "UPDATE supervisor_enrollment_budgets SET limit_micro_usd=$3,limit_tokens=$4,configuration_revision=$5 WHERE enrollment_id=$1 AND workspace_id=$2",
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
          scope: input.enrollmentId ? "enrollment" : "workspace",
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
        return result;
      });
    },
  );
}
