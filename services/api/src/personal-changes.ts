import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import type { Database } from "./database.js";
import { transaction } from "./database.js";
import type { authService } from "./auth.js";
import { requireCondition } from "./errors.js";
import { appendEvent } from "./events.js";
import { enrollmentCommand, loadEnrollment, type CommandInput, type EnrollmentContext } from "./repository.js";
import { applyPendingChangeWithin, declinePendingChangeWithin, liveComponents, pendingChanges, revertPersonalChange, type AdaptationRuntime } from "./adaptation-store.js";
import { transferChecks } from "./adaptation-transfer.js";

/** Optional personal blocks the learner hid. Required changes are never hideable. */
export async function hiddenOptionalBlocks(client: PoolClient | Database, context: EnrollmentContext) {
  const optional = new Set((context.release.adaptationRequirements ?? []).filter((r) => r.classification === "optional" && !r.replacesBaseBlock).map((r) => `${r.episodeId}/${r.blockId}`));
  if (!optional.size) return new Set<string>();
  const rows = (await client.query<{ episode_id: string; block_id: string }>("SELECT episode_id,block_id FROM personal_change_visibility WHERE enrollment_id=$1 AND hidden", [context.enrollment.id])).rows;
  const hidden = new Set(rows.map((r) => `${r.episode_id}/${r.block_id}`).filter((key) => optional.has(key)));
  // Hiding an optional inserted episode hides every block of it.
  for (const r of context.release.adaptationRequirements ?? []) if (r.insertedEpisode && hidden.has(`${r.episodeId}/${r.blockId}`))
    for (const block of context.release.server_bundle.chapters.flatMap((c) => c.episodes).find((e) => e.id === r.episodeId)?.blocks ?? []) hidden.add(`${r.episodeId}/${block.id}`);
  return hidden;
}
/** Keys of personal blocks that are optional: never required for coverage. */
export function optionalPersonalBlocks(context: EnrollmentContext) {
  return new Set((context.release.adaptationRequirements ?? []).filter((r) => r.classification === "optional" && !r.replacesBaseBlock).map((r) => `${r.episodeId}/${r.blockId}`));
}
/** The learner-facing label for who wrote a change. Only author-reviewed bank entries are
 * reviewed by a person; anything generated is labelled unverified, whatever checks it passed. */
export function changeProvenance(adapterIds: string[]): { provenance: "author_reviewed" | "generated"; unverified: boolean } {
  const reviewed = adapterIds.length > 0 && adapterIds.every((id) => id.startsWith("authored-"));
  return { provenance: reviewed ? "author_reviewed" : "generated", unverified: !reviewed };
}
/** Applied personal changes as the learner sees them, with their hidden state, sources,
 * provenance and whether they can still be undone. Reverted changes stay listed as history. */
export async function personalChanges(client: PoolClient, context: EnrollmentContext) {
  const rows = (
    await client.query(
      `SELECT p.id,p.body,p.assignments,x.plan_revision,x.applied_at,r.reverted_at,r.plan_revision AS reverted_revision,v.report AS validation,
         COALESCE((SELECT array_agg(DISTINCT f.adapter_id) FROM adaptation_proofs f WHERE f.proposal_id=p.id AND f.enrollment_id=p.enrollment_id),'{}') AS adapters
       FROM adaptation_applications x JOIN adaptation_proposals p ON p.id=x.proposal_id AND p.enrollment_id=x.enrollment_id
       LEFT JOIN adaptation_reverts r ON r.enrollment_id=x.enrollment_id AND r.proposal_id=x.proposal_id
       LEFT JOIN adaptation_validation_reports v ON v.enrollment_id=x.enrollment_id AND v.proposal_id=x.proposal_id
       WHERE x.enrollment_id=$1 ORDER BY x.plan_revision`,
      [context.enrollment.id],
    )
  ).rows;
  const hidden = await hiddenOptionalBlocks(client, context);
  const checks = await transferChecks(client, context.enrollment.id, context.release.server_bundle);
  const requirements = context.release.adaptationRequirements ?? [];
  const titles = Object.fromEntries(context.release.server_bundle.chapters.flatMap((c) => c.episodes).map((e) => [e.id, e.title]));
  const sources = new Map((context.release.server_bundle.sources ?? []).map((s: { id: string; title: string; url: string }) => [s.id, s]));
  // A change can be undone while it is live and no later live change rewrote the same block.
  const live = rows.filter((r) => !r.reverted_at);
  const rewrites = (row: (typeof rows)[number]) => ((row.body?.operations ?? []) as { type: string; episodeId?: string; blockId?: string; artifactId: string; id: string }[])
    .flatMap((o) => o.type === "replace_teaching" ? [`${o.episodeId}/${o.blockId}`] : o.type === "insert_episode" ? [`${o.artifactId}/`] : []);
  const blockedBy = (row: (typeof rows)[number]) => {
    const mine = new Set(rewrites(row));
    return live.some((later) => later.plan_revision > row.plan_revision && ((later.body?.operations ?? []) as { type: string; episodeId?: string; blockId?: string }[])
      .some((o) => (o.type === "replace_teaching" && (mine.has(`${o.episodeId}/${o.blockId}`) || mine.has(`${o.episodeId}/`))) || (o.type === "append_teaching" && mine.has(`${o.episodeId}/`))));
  };
  return rows.flatMap((row) => {
    const artifacts = (row.body?.artifacts ?? []) as { id: string; kind: string; sourceRefs?: string[]; assessment?: { id: string } }[];
    const { provenance, unverified } = changeProvenance(row.adapters as string[]);
    const reverted = Boolean(row.reverted_at);
    const hasVariant = artifacts.some((a) => a.kind === "assessment_variant");
    return ((row.body?.operations ?? []) as { id: string; type: string; episodeId?: string; blockId?: string; artifactId: string }[]).map((op) => {
      const blockId = op.type === "replace_teaching" ? op.blockId! : op.id;
      // An inserted episode is listed as itself; the operation ID addresses it.
      const episodeId = op.type === "insert_episode" ? op.artifactId : op.episodeId!;
      const requirement = requirements.find((r) => r.episodeId === episodeId && r.blockId === blockId);
      const optional = requirement?.classification === "optional" && !requirement.replacesBaseBlock;
      const artifact = artifacts.find((a) => a.id === op.artifactId);
      return {
        proposalId: row.id,
        planRevision: row.plan_revision,
        appliedAt: row.applied_at.toISOString(),
        episodeId,
        episodeTitle: titles[episodeId] ?? episodeId,
        blockId,
        kind: op.type,
        // A generated question is labelled where the learner answers it, by its item ID.
        ...(artifact?.kind === "assessment_variant" && artifact.assessment ? { assessmentId: artifact.assessment.id } : {}),
        why: typeof row.body?.rationale === "string" ? row.body.rationale : "",
        // A reverted change is no longer delivered; its classification comes from its recorded decision.
        classification: requirement?.classification
          ?? ((row.assignments ?? []) as { operationId: string; classification?: string }[]).find((a) => a.operationId === op.id)?.classification ?? "unknown",
        hideable: optional && !reverted,
        hidden: hidden.has(`${episodeId}/${blockId}`),
        provenance,
        unverified,
        sourceRefs: (artifact?.sourceRefs ?? []).slice(0, 20).map((id) => {
          const source = sources.get(id);
          return source ? { id, title: source.title, url: source.url } : { id, title: id, url: null };
        }),
        // Later independent checks on what this change taught (outcome only; never evidence).
        transferChecks: checks.filter((c) => c.proposalId === row.id).map((c) => ({ objectiveId: c.objectiveId, status: c.status, ...(c.amendedFrom ? { amendedFrom: c.amendedFrom } : {}) })),
        // What was checked before a generated change was added (check IDs and results only).
        ...(row.validation ? { validation: { hostChecks: (row.validation.hostChecks ?? []).map((c: { id: string }) => c.id),
          courseChecks: (row.validation.courseChecks?.checks ?? []).length, boundary: row.validation.boundary } } : {}),
        reverted,
        revertedAt: reverted ? new Date(row.reverted_at).toISOString() : null,
        revertable: !reverted && !hasVariant && op.type !== "suggest_profile_correction" && !blockedBy(row),
      };
    });
  });
}
export function registerPersonalChangeRoutes(app: FastifyInstance, db: Database, auth: ReturnType<typeof authService>, runtime: AdaptationRuntime) {
  const base = "/api/enrollments/:enrollmentId/personal-changes";
  const params = { type: "object", additionalProperties: false, required: ["enrollmentId"], properties: { enrollmentId: { type: "string", format: "uuid" } } };
  app.get(base, { schema: { params } }, async (request) => {
    const actor = await auth.authenticate(request), { enrollmentId } = request.params as { enrollmentId: string };
    return transaction(db, async (client) => {
      const context = await loadEnrollment(client, actor, enrollmentId);
      return { changes: await personalChanges(client, context), planRevision: context.release.planRevision ?? 0, evidenceUnaffected: true };
    });
  });
  // Undo one applied change: a new plan revision rolling back to the plan it was applied on.
  app.post(`${base}/revert`, {
    schema: { params, body: { type: "object", additionalProperties: false, required: ["expectedRevision", "idempotencyKey", "proposalId", "expectedPlanRevision"],
      properties: { expectedRevision: { type: "integer", minimum: 1 }, idempotencyKey: { type: "string", minLength: 8, maxLength: 200 },
        proposalId: { type: "string", format: "uuid" }, expectedPlanRevision: { type: "integer", minimum: 0 } } } },
  }, async (request) => {
    const actor = await auth.authenticate(request), { enrollmentId } = request.params as { enrollmentId: string };
    return revertPersonalChange(db, actor, { ...(request.body as { expectedRevision: number; idempotencyKey: string; proposalId: string; expectedPlanRevision: number }), enrollmentId });
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
  // Generated interactive components of live personal changes (E05): model and controls only, for
  // the lesson to run in Core's sandboxed runner frame. Their tests stay server-side.
  app.get("/api/enrollments/:enrollmentId/components", { schema: { params } }, async (request) => {
    const actor = await auth.authenticate(request), { enrollmentId } = request.params as { enrollmentId: string };
    return transaction(db, async (client) => ({ components: await liveComponents(client, await loadEnrollment(client, actor, enrollmentId)) }));
  });
  // Generated changes waiting for a safe boundary (E03): listed without their content; the learner
  // adds one once their attempt ends (every check runs again) or turns it down.
  app.get(`${base}/pending`, { schema: { params } }, async (request) => {
    const actor = await auth.authenticate(request), { enrollmentId } = request.params as { enrollmentId: string };
    return transaction(db, async (client) => {
      const context = await loadEnrollment(client, actor, enrollmentId);
      requireCondition(context.enrollment.user_id === actor.id, "LEARNER_ONLY", 403);
      return { pending: await pendingChanges(client, context) };
    });
  });
  const pendingBody = { type: "object", additionalProperties: false, required: ["expectedRevision", "idempotencyKey", "pendingId"],
    properties: { expectedRevision: { type: "integer", minimum: 1 }, idempotencyKey: { type: "string", minLength: 8, maxLength: 200, pattern: "^[A-Za-z0-9:_-]+$" },
      pendingId: { type: "string", format: "uuid" } } };
  app.post(`${base}/pending/apply`, { schema: { params, body: pendingBody } }, async (request) => {
    const actor = await auth.authenticate(request), { enrollmentId } = request.params as { enrollmentId: string },
      input = request.body as CommandInput & { pendingId: string };
    return enrollmentCommand(db, actor, enrollmentId, "personal_change.pending.apply", input, (client, context) => applyPendingChangeWithin(client, context, actor, input.pendingId, runtime));
  });
  app.post(`${base}/pending/decline`, { schema: { params, body: pendingBody } }, async (request) => {
    const actor = await auth.authenticate(request), { enrollmentId } = request.params as { enrollmentId: string },
      input = request.body as CommandInput & { pendingId: string };
    return enrollmentCommand(db, actor, enrollmentId, "personal_change.pending.decline", input, async (client, context) => {
      const result = await declinePendingChangeWithin(client, context, actor, input.pendingId);
      await appendEvent(client, { workspaceId: context.enrollment.workspace_id, enrollmentId, actorId: actor.id, actorKind: "learner", type: "personal_change.declined",
        payload: { pendingId: input.pendingId }, idempotencyKey: `${enrollmentId}:${input.idempotencyKey}`, supervise: true });
      return result;
    });
  });
}
