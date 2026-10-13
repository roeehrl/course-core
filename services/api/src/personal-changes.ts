import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import type { Database } from "./database.js";
import { transaction } from "./database.js";
import type { authService } from "./auth.js";
import { requireCondition } from "./errors.js";
import { appendEvent } from "./events.js";
import { enrollmentCommand, loadEnrollment, type CommandInput, type EnrollmentContext } from "./repository.js";

/** Optional personal blocks the learner hid. Required changes are never hideable. */
export async function hiddenOptionalBlocks(client: PoolClient | Database, context: EnrollmentContext) {
  const optional = new Set((context.release.adaptationRequirements ?? []).filter((r) => r.classification === "optional" && !r.replacesBaseBlock).map((r) => `${r.episodeId}/${r.blockId}`));
  if (!optional.size) return new Set<string>();
  const rows = (await client.query<{ episode_id: string; block_id: string }>("SELECT episode_id,block_id FROM personal_change_visibility WHERE enrollment_id=$1 AND hidden", [context.enrollment.id])).rows;
  return new Set(rows.map((r) => `${r.episode_id}/${r.block_id}`).filter((key) => optional.has(key)));
}
/** Keys of personal blocks that are optional: never required for coverage. */
export function optionalPersonalBlocks(context: EnrollmentContext) {
  return new Set((context.release.adaptationRequirements ?? []).filter((r) => r.classification === "optional" && !r.replacesBaseBlock).map((r) => `${r.episodeId}/${r.blockId}`));
}
async function changes(client: PoolClient, context: EnrollmentContext) {
  const rows = (
    await client.query(
      `SELECT p.id,p.body,x.plan_revision,x.applied_at FROM adaptation_applications x JOIN adaptation_proposals p ON p.id=x.proposal_id AND p.enrollment_id=x.enrollment_id
       WHERE x.enrollment_id=$1 ORDER BY x.plan_revision`,
      [context.enrollment.id],
    )
  ).rows;
  const hidden = await hiddenOptionalBlocks(client, context);
  const requirements = context.release.adaptationRequirements ?? [];
  const titles = Object.fromEntries(context.release.server_bundle.chapters.flatMap((c) => c.episodes).map((e) => [e.id, e.title]));
  return rows.flatMap((row) =>
    ((row.body?.operations ?? []) as { id: string; type: string; episodeId: string; blockId?: string }[]).map((op) => {
      const blockId = op.type === "replace_teaching" ? op.blockId! : op.id;
      const requirement = requirements.find((r) => r.episodeId === op.episodeId && r.blockId === blockId);
      const optional = requirement?.classification === "optional" && !requirement.replacesBaseBlock;
      return {
        proposalId: row.id,
        planRevision: row.plan_revision,
        appliedAt: row.applied_at.toISOString(),
        episodeId: op.episodeId,
        episodeTitle: titles[op.episodeId] ?? op.episodeId,
        blockId,
        kind: op.type,
        why: typeof row.body?.rationale === "string" ? row.body.rationale : "",
        classification: requirement?.classification ?? "unknown",
        hideable: optional,
        hidden: hidden.has(`${op.episodeId}/${blockId}`),
      };
    }),
  );
}
export function registerPersonalChangeRoutes(app: FastifyInstance, db: Database, auth: ReturnType<typeof authService>) {
  const base = "/api/enrollments/:enrollmentId/personal-changes";
  const params = { type: "object", additionalProperties: false, required: ["enrollmentId"], properties: { enrollmentId: { type: "string", format: "uuid" } } };
  app.get(base, { schema: { params } }, async (request) => {
    const actor = await auth.authenticate(request), { enrollmentId } = request.params as { enrollmentId: string };
    return transaction(db, async (client) => ({ changes: await changes(client, await loadEnrollment(client, actor, enrollmentId)), evidenceUnaffected: true }));
  });
  app.post(`${base}/visibility`, {
    schema: { params, body: { type: "object", additionalProperties: false, required: ["expectedRevision", "idempotencyKey", "episodeId", "blockId", "hidden"],
      properties: { expectedRevision: { type: "integer", minimum: 1 }, idempotencyKey: { type: "string", minLength: 8, maxLength: 200 },
        episodeId: { type: "string", minLength: 1, maxLength: 200 }, blockId: { type: "string", minLength: 1, maxLength: 200 }, hidden: { type: "boolean" } } } },
  }, async (request) => {
    const actor = await auth.authenticate(request), { enrollmentId } = request.params as { enrollmentId: string },
      input = request.body as CommandInput & { episodeId: string; blockId: string; hidden: boolean };
    return enrollmentCommand(db, actor, enrollmentId, "personal_change.visibility", input, async (client, context) => {
      requireCondition(context.enrollment.user_id === actor.id, "LEARNER_ONLY", 403);
      // Required personal changes stay; disagreement goes through review, not hiding.
      requireCondition(optionalPersonalBlocks(context).has(`${input.episodeId}/${input.blockId}`), "CHANGE_NOT_HIDEABLE", 409);
      await client.query(
        `INSERT INTO personal_change_visibility(enrollment_id,episode_id,block_id,hidden) VALUES($1,$2,$3,$4)
         ON CONFLICT (enrollment_id,episode_id,block_id) DO UPDATE SET hidden=EXCLUDED.hidden,changed_at=clock_timestamp()`,
        [enrollmentId, input.episodeId, input.blockId, input.hidden],
      );
      await client.query("UPDATE enrollments SET revision=revision+1 WHERE id=$1", [enrollmentId]);
      await appendEvent(client, { workspaceId: context.enrollment.workspace_id, enrollmentId, actorId: actor.id, actorKind: "learner", type: input.hidden ? "personal_change.hidden" : "personal_change.restored", payload: { episodeId: input.episodeId, blockId: input.blockId }, idempotencyKey: `${enrollmentId}:${input.idempotencyKey}`, supervise: true });
      return { episodeId: input.episodeId, blockId: input.blockId, hidden: input.hidden };
    });
  });
}
