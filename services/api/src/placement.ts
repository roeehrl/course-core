import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import type { CourseManifest } from "@course-core/sdk";
import { gateAssessmentIds } from "@course-core/sdk";
import type { Database } from "./database.js";
import { transaction } from "./database.js";
import type { authService } from "./auth.js";
import { requireCondition } from "./errors.js";
import { appendEvent } from "./events.js";
import { enrollmentCommand, loadEnrollment, type CommandInput, type EnrollmentContext } from "./repository.js";
import { episodes, gateDecision, learningSnapshot } from "./learning.js";

export interface RunAttempt {
  episodeId: string;
  assessmentId: string;
  familyId: string;
  objectiveIds: string[];
  passed: boolean;
  /** Submitted but not yet authoritatively evaluated (e.g. a written answer awaiting review).
   * Pending is unknown, never wrong: it neither places out nor stops placement as a failure. */
  pending?: boolean;
  independent: boolean;
  evidence: { id: string; objectiveId: string; passed?: boolean }[];
}
export interface PlacementPlan {
  exemptEpisodeIds: string[];
  /** First episode the learner would study if they accept the proposal. */
  startEpisodeId: string | null;
  nextItem: { episodeId: string; assessmentId: string } | null;
  stopReason:
    | "continuing"
    | "not_demonstrated"
    | "protected_episode"
    | "not_placeable"
    | "no_fresh_items"
    | "item_limit"
    | "course_covered"
    | "pending_evaluation"
    | "placement_disabled";
  stoppedAtEpisodeId: string | null;
  demonstrated: { objectiveId: string; evidenceIds: string[]; families: string[] }[];
  /** Objectives with an answer still awaiting evaluation: undecided, so they stay on the path. */
  pendingObjectiveIds?: string[];
  itemsUsed: number;
  maxItems: number;
}

/** Conservative, auditable placement: walk the required path in order and
 * place out of an episode only when THIS run's independent placement evidence
 * satisfies its gate. A wrong or assisted answer, a protected episode, an
 * unplaceable episode or the item cap ends the walk; later episodes are never
 * exempted past an unproven prerequisite. An answer still awaiting evaluation
 * (a pending review, or an evaluator that could not run) is not a wrong answer:
 * its episode stays undecided, so the walk stops there as `pending_evaluation`
 * unless another unseen item can still be offered meanwhile. */
export function placementPlan(
  course: CourseManifest,
  digest: string,
  attempts: RunAttempt[],
  exposedAssessmentIds: string[],
  options: { allowNextItem: boolean; itemsUsed?: number },
): PlacementPlan {
  const policy = course.placement;
  const maxItems = policy?.maxItems ?? 0;
  // Questions this run has spent: at least the answered ones, plus any shown and left to expire.
  const itemsUsed = Math.max(options.itemsUsed ?? 0, attempts.length);
  const plan: PlacementPlan = {
    exemptEpisodeIds: [],
    startEpisodeId: null,
    nextItem: null,
    stopReason: "continuing",
    stoppedAtEpisodeId: null,
    demonstrated: [],
    pendingObjectiveIds: [],
    itemsUsed,
    maxItems,
  };
  if (!policy?.enabled) return { ...plan, stopReason: "placement_disabled", startEpisodeId: episodes(course)[0]?.id ?? null };
  const evidence = attempts.filter((a) => !a.pending).flatMap((a) =>
    a.evidence.map((e) => ({
      id: e.id,
      objective_id: e.objectiveId,
      independent: a.independent,
      result: { passed: e.passed ?? a.passed },
      family_id: a.familyId,
      assessment_id: a.assessmentId,
      course_digest: digest,
      mode: "placement",
    })),
  );
  const demonstrated = new Set<string>();
  for (const episode of episodes(course)) {
    if (episode.requirement === "optional") continue;
    const stop = (reason: PlacementPlan["stopReason"]) => {
      plan.stopReason = reason;
      plan.stoppedAtEpisodeId = episode.id;
      plan.startEpisodeId = episode.id;
    };
    if (policy.protectedEpisodeIds.includes(episode.id)) { stop("protected_episode"); break; }
    const gate = course.gates.find((g) => g.id === episode.gateId);
    if (!gate || !episode.objectiveIds.every((o) => policy.objectiveIds.includes(o))) { stop("not_placeable"); break; }
    const prerequisites = course.objectives
      .filter((o) => episode.objectiveIds.includes(o.id))
      .flatMap((o) => o.prerequisites)
      .filter((id) => !episode.objectiveIds.includes(id));
    if (!prerequisites.every((id) => demonstrated.has(id))) { stop("not_placeable"); break; }
    const decision = gateDecision(course, gate, evidence as never, digest);
    if (decision.passed) {
      plan.exemptEpisodeIds.push(episode.id);
      for (const o of decision.objectives.filter((x) => x.passed)) {
        demonstrated.add(o.id);
        plan.demonstrated.push({ objectiveId: o.id, evidenceIds: o.evidenceIds, families: o.families });
      }
      continue;
    }
    const tried = attempts.filter((a) => a.episodeId === episode.id), waiting = tried.filter((a) => a.pending);
    if (tried.some((a) => !a.pending && (!a.passed || !a.independent))) { stop("not_demonstrated"); break; }
    // A family whose answer awaits evaluation is not asked again while it is undecided.
    const satisfiedFamilies = new Set(tried.filter((a) => a.pending || (a.passed && a.independent)).map((a) => a.familyId));
    const undecided = () => {
      plan.pendingObjectiveIds = [...new Set(waiting.flatMap((a) => a.objectiveIds))];
      stop("pending_evaluation");
    };
    const candidate = gateAssessmentIds(gate).find((id) => {
      const item = course.assessments.find((x) => x.id === id);
      return item && policy.assessmentIds.includes(id) && !exposedAssessmentIds.includes(id) && !satisfiedFamilies.has(item.familyId);
    });
    if (!candidate) { if (waiting.length) undecided(); else stop("no_fresh_items"); break; }
    if (itemsUsed >= maxItems) { if (waiting.length) undecided(); else stop("item_limit"); break; }
    if (!options.allowNextItem && waiting.length) { undecided(); break; }
    if (options.allowNextItem) plan.nextItem = { episodeId: episode.id, assessmentId: candidate };
    plan.startEpisodeId = episode.id;
    plan.stoppedAtEpisodeId = episode.id;
    break;
  }
  if (plan.stopReason === "continuing" && !plan.nextItem) {
    plan.stopReason = plan.startEpisodeId ? plan.stopReason : "course_covered";
  }
  return plan;
}

interface RunRow {
  id: string;
  state: "declined" | "in_progress" | "finished" | "accepted";
  started_at: Date | null;
  finished_at: Date | null;
  accepted_at: Date | null;
  stop_reason: string | null;
  proposal: PlacementPlan | null;
  start_episode_id: string | null;
}
async function runFor(client: PoolClient, enrollmentId: string, lock = false) {
  return (
    await client.query<RunRow>(`SELECT * FROM placement_runs WHERE enrollment_id=$1 ${lock ? "FOR UPDATE" : ""}`, [enrollmentId])
  ).rows[0];
}
async function runAttempts(client: PoolClient, context: EnrollmentContext, run: RunRow) {
  const course = context.release.server_bundle;
  const rows = (
    await client.query(
      `SELECT c.episode_id,a.id AS attempt_id,a.assessment_id,a.family_id,a.result,c.independent_eligible,c.assistance,
         coalesce(json_agg(json_build_object('id',e.id,'objectiveId',e.objective_id,'passed',(e.result->>'passed')::boolean)) FILTER (WHERE e.id IS NOT NULL),'[]') AS evidence
       FROM assessment_challenges c JOIN attempts a ON a.id=c.attempt_id AND a.enrollment_id=c.enrollment_id
       LEFT JOIN evidence e ON e.attempt_id=a.id AND e.enrollment_id=a.enrollment_id AND e.invalidated_at IS NULL
       WHERE c.enrollment_id=$1 AND c.mode='placement' AND c.issued_at>=$2 AND c.course_digest=$3
         -- A clarified written answer continues as its reply; the reply carries the outcome.
         AND NOT EXISTS (SELECT 1 FROM attempts r WHERE r.continues_attempt_id=a.id AND r.enrollment_id=a.enrollment_id)
       GROUP BY c.episode_id,a.id,a.assessment_id,a.family_id,a.result,c.independent_eligible,c.assistance,a.submitted_at ORDER BY a.submitted_at`,
      [context.enrollment.id, run.started_at, context.release.digest],
    )
  ).rows;
  return rows.map((r): RunAttempt => {
    const evidence = r.evidence as RunAttempt["evidence"];
    // A reviewed answer's outcome is its evidence; awaiting review (or clarification) it is undecided.
    const pending = r.result?.status === "pending_review" && evidence.length === 0;
    return {
      episodeId: r.episode_id,
      assessmentId: r.assessment_id,
      familyId: r.family_id,
      objectiveIds: course.assessments.find((x) => x.id === r.assessment_id)?.objectiveIds ?? [],
      passed: pending ? false : evidence.length ? evidence.every((e) => e.passed === true) : Boolean(r.result?.passed),
      pending,
      independent: r.independent_eligible && r.assistance === "none",
      evidence,
    };
  });
}
/** Questions a placement run has used. The allowance belongs to the run, not
 * the enrollment: only placement items issued since this run started count.
 * Each question counts once: a reply to a reviewer's clarification request
 * continues its answer. An item shown and left to expire unanswered is spent
 * (the learner saw it, so it can no longer be fresh evidence); the item still
 * on screen is not yet, nor is one cut short when the learner finishes the run.
 * Item issuance and the run view both use this count, so the server never
 * offers a question it would then refuse as over the limit. */
export async function placementItemsUsed(
  client: Pick<PoolClient, "query">,
  enrollmentId: string,
  run: { started_at: Date | null; finished_at: Date | null },
  digest: string,
) {
  if (!run.started_at) return 0;
  return (
    await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM assessment_challenges c
       WHERE c.enrollment_id=$1 AND c.mode='placement' AND c.issued_at>=$2 AND c.course_digest=$3
         AND (c.attempt_id IS NOT NULL OR CASE WHEN $4::timestamptz IS NULL THEN c.expires_at<=clock_timestamp() ELSE c.expires_at<$4 END)
         AND NOT EXISTS (SELECT 1 FROM attempts a WHERE a.id=c.attempt_id AND a.continues_attempt_id IS NOT NULL)`,
      [enrollmentId, run.started_at, digest, run.finished_at],
    )
  ).rows[0]!.n;
}
/** Assessments seen anywhere before this item, excluding the item this run still
 * has on screen: a previously exposed item can never be fresh independent
 * placement evidence, including this run's own item that expired unanswered. */
async function exposedBefore(client: PoolClient, enrollmentId: string, since: Date | null) {
  return (
    await client.query<{ assessment_id: string }>(
      "SELECT assessment_id FROM assessment_challenges WHERE enrollment_id=$1 AND (mode<>'placement' OR issued_at<$2 OR attempt_id IS NOT NULL OR expires_at<=clock_timestamp())",
      [enrollmentId, since ?? new Date(0)],
    )
  ).rows.map((r) => r.assessment_id);
}
async function pendingItem(client: PoolClient, enrollmentId: string, since: Date | null) {
  return (
    await client.query<{ id: string; episode_id: string; assessment_id: string; expires_at: Date }>(
      "SELECT id,episode_id,assessment_id,expires_at FROM assessment_challenges WHERE enrollment_id=$1 AND mode='placement' AND attempt_id IS NULL AND expires_at>clock_timestamp() AND issued_at>=$2 ORDER BY issued_at DESC LIMIT 1",
      [enrollmentId, since ?? new Date(0)],
    )
  ).rows[0];
}
function hasStudied(context: EnrollmentContext) {
  return context.progress.some((p) => ["completed", "placed"].includes(p.state) || (p.completed_block_ids?.length ?? 0) > 0);
}
async function view(client: PoolClient, context: EnrollmentContext) {
  const course = context.release.server_bundle;
  const run = await runFor(client, context.enrollment.id);
  const available = Boolean(course.placement?.enabled);
  const base = {
    available,
    maxItems: course.placement?.maxItems ?? 0,
    declinable: true,
    studied: hasStudied(context),
    state: run?.state ?? (available ? "offered" : "unavailable"),
    grantsCompletion: false,
  };
  if (!run || run.state === "declined") return { ...base, run: null };
  const attempts = await runAttempts(client, context, run);
  const itemsUsed = Math.max(await placementItemsUsed(client, context.enrollment.id, run, context.release.digest), attempts.length);
  const pending = run.state === "in_progress" ? await pendingItem(client, context.enrollment.id, run.started_at) : undefined;
  const plan =
    run.state === "in_progress"
      ? placementPlan(course, context.release.digest, attempts, await exposedBefore(client, context.enrollment.id, run.started_at), { allowNextItem: true, itemsUsed })
      : run.proposal!;
  const titles = Object.fromEntries(episodes(course).map((e) => [e.id, e.title]));
  return {
    ...base,
    run: {
      startedAt: run.started_at,
      finishedAt: run.finished_at,
      acceptedAt: run.accepted_at,
      itemsUsed,
      pendingChallengeId: pending?.id ?? null,
      nextItem: pending ? { episodeId: pending.episode_id, assessmentId: pending.assessment_id } : plan.nextItem,
      stopReason: run.stop_reason ?? plan.stopReason,
      proposal: {
        exempt: plan.exemptEpisodeIds.map((id) => ({ episodeId: id, title: titles[id] })),
        startEpisodeId: plan.startEpisodeId,
        startTitle: plan.startEpisodeId ? titles[plan.startEpisodeId] : null,
        demonstrated: plan.demonstrated.map((d) => ({
          objectiveId: d.objectiveId,
          description: course.objectives.find((o) => o.id === d.objectiveId)?.description ?? d.objectiveId,
          families: d.families.length,
        })),
        // Awaiting evaluation is neither a pass nor a fail; these stay on the path unless later evidence decides them.
        pending: (plan.pendingObjectiveIds ?? []).map((id) => ({ objectiveId: id, description: course.objectives.find((o) => o.id === id)?.description ?? id })),
        untestedNote: "Objectives not listed were not tested and stay on your path; this is not a judgement of ability.",
      },
      acceptedStartEpisodeId: run.start_episode_id,
    },
  };
}

export function registerPlacementRoutes(app: FastifyInstance, db: Database, auth: ReturnType<typeof authService>) {
  const base = "/api/enrollments/:enrollmentId/placement";
  const params = { type: "object", additionalProperties: false, required: ["enrollmentId"], properties: { enrollmentId: { type: "string", format: "uuid" } } };
  const command = (extra: Record<string, unknown> = {}, required: string[] = []) => ({
    type: "object",
    additionalProperties: false,
    required: ["expectedRevision", "idempotencyKey", ...required],
    properties: { expectedRevision: { type: "integer", minimum: 1 }, idempotencyKey: { type: "string", minLength: 8, maxLength: 200 }, ...extra },
  });
  app.get(base, { schema: { params } }, async (request) => {
    const actor = await auth.authenticate(request), { enrollmentId } = request.params as { enrollmentId: string };
    return transaction(db, async (client) => view(client, await loadEnrollment(client, actor, enrollmentId)));
  });
  const bump = async (client: PoolClient, enrollmentId: string) => client.query("UPDATE enrollments SET revision=revision+1 WHERE id=$1", [enrollmentId]);
  app.post(`${base}/decline`, { schema: { params, body: command() } }, async (request) => {
    const actor = await auth.authenticate(request), { enrollmentId } = request.params as { enrollmentId: string };
    return enrollmentCommand(db, actor, enrollmentId, "placement.decline", request.body as CommandInput, async (client, context) => {
      const run = await runFor(client, enrollmentId, true);
      requireCondition(!run || run.state === "declined", "PLACEMENT_ALREADY_STARTED", 409);
      if (!run)
        await client.query("INSERT INTO placement_runs(id,enrollment_id,state) VALUES($1,$2,'declined')", [randomUUID(), enrollmentId]);
      await bump(client, enrollmentId);
      await appendEvent(client, { workspaceId: context.enrollment.workspace_id, enrollmentId, actorId: actor.id, actorKind: "learner", type: "placement.declined", payload: {}, idempotencyKey: `${enrollmentId}:placement-decline` }).catch(() => undefined);
      return { state: "declined" };
    });
  });
  app.post(`${base}/start`, { schema: { params, body: command() } }, async (request) => {
    const actor = await auth.authenticate(request), { enrollmentId } = request.params as { enrollmentId: string };
    return enrollmentCommand(db, actor, enrollmentId, "placement.start", request.body as CommandInput, async (client, context) => {
      requireCondition(context.release.server_bundle.placement?.enabled, "PLACEMENT_UNAVAILABLE", 409);
      requireCondition(context.enrollment.status === "active", "ENROLLMENT_INACTIVE", 409);
      // Placement is a starting-point tool; after study begins the normal path applies.
      requireCondition(!hasStudied(context), "PLACEMENT_AFTER_STUDY", 409);
      const run = await runFor(client, enrollmentId, true);
      requireCondition(!run || run.state === "declined", "PLACEMENT_ALREADY_TAKEN", 409);
      if (run) await client.query("UPDATE placement_runs SET state='in_progress',started_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1", [run.id]);
      else await client.query("INSERT INTO placement_runs(id,enrollment_id,state,started_at) VALUES($1,$2,'in_progress',clock_timestamp())", [randomUUID(), enrollmentId]);
      await bump(client, enrollmentId);
      await appendEvent(client, { workspaceId: context.enrollment.workspace_id, enrollmentId, actorId: actor.id, actorKind: "learner", type: "placement.started", payload: {}, idempotencyKey: `${enrollmentId}:placement-start` });
      return { state: "in_progress" };
    });
  });
  app.post(`${base}/finish`, { schema: { params, body: command() } }, async (request) => {
    const actor = await auth.authenticate(request), { enrollmentId } = request.params as { enrollmentId: string };
    return enrollmentCommand(db, actor, enrollmentId, "placement.finish", request.body as CommandInput, async (client, context) => {
      const run = await runFor(client, enrollmentId, true);
      requireCondition(run?.state === "in_progress", "PLACEMENT_NOT_IN_PROGRESS", 409);
      // A stop freezes the proposal from submitted evidence only; an unanswered item is simply unknown.
      const plan = placementPlan(context.release.server_bundle, context.release.digest, await runAttempts(client, context, run), [], {
        allowNextItem: false,
        itemsUsed: await placementItemsUsed(client, enrollmentId, run, context.release.digest),
      });
      const reason = plan.stopReason === "continuing" ? "stopped_by_learner" : plan.stopReason;
      await client.query("UPDATE placement_runs SET state='finished',finished_at=clock_timestamp(),stop_reason=$2,proposal=$3,updated_at=clock_timestamp() WHERE id=$1", [run.id, reason, JSON.stringify(plan)]);
      await client.query("UPDATE assessment_challenges SET expires_at=clock_timestamp() WHERE enrollment_id=$1 AND mode='placement' AND attempt_id IS NULL AND expires_at>clock_timestamp()", [enrollmentId]);
      await bump(client, enrollmentId);
      await appendEvent(client, { workspaceId: context.enrollment.workspace_id, enrollmentId, actorId: actor.id, actorKind: "learner", type: "placement.finished", payload: { exemptEpisodeIds: plan.exemptEpisodeIds, stopReason: reason, items: plan.itemsUsed }, idempotencyKey: `${enrollmentId}:placement-finish` });
      return { state: "finished", exemptEpisodeIds: plan.exemptEpisodeIds, startEpisodeId: plan.startEpisodeId, stopReason: reason, pendingObjectiveIds: plan.pendingObjectiveIds ?? [] };
    });
  });
  // startEpisodeId omitted = place out of every proposed episode (only when the
  // proposal itself has no remaining start point).
  app.post(`${base}/accept`, { schema: { params, body: command({ startEpisodeId: { type: "string", minLength: 1, maxLength: 200 } }) } }, async (request) => {
    const actor = await auth.authenticate(request), { enrollmentId } = request.params as { enrollmentId: string },
      input = request.body as CommandInput & { startEpisodeId?: string };
    return enrollmentCommand(db, actor, enrollmentId, "placement.accept", input, async (client, context) => {
      const run = await runFor(client, enrollmentId, true);
      requireCondition(run?.state === "finished" && run.proposal, "PLACEMENT_NOT_FINISHED", 409);
      const course = context.release.server_bundle, ordered = episodes(course).map((e) => e.id);
      const exempt = run.proposal.exemptEpisodeIds;
      // The learner may start at the proposed point or anywhere earlier, never later.
      const allowed = [...exempt, ...(run.proposal.startEpisodeId ? [run.proposal.startEpisodeId] : [])];
      requireCondition(
        input.startEpisodeId ? allowed.includes(input.startEpisodeId) : !run.proposal.startEpisodeId,
        "PLACEMENT_START_NOT_ALLOWED",
        409,
      );
      const cut = input.startEpisodeId ? ordered.indexOf(input.startEpisodeId) : ordered.length;
      const placed = exempt.filter((id) => ordered.indexOf(id) < cut);
      // Re-check each exemption against current evidence before writing it.
      const attempts = await runAttempts(client, context, run);
      const fresh = placementPlan(course, context.release.digest, attempts, [], { allowNextItem: false });
      requireCondition(placed.every((id) => fresh.exemptEpisodeIds.includes(id)), "PLACEMENT_EVIDENCE_CHANGED", 409);
      for (const episodeId of placed) {
        const episode = episodes(course).find((e) => e.id === episodeId)!, gate = course.gates.find((g) => g.id === episode.gateId)!;
        const refs = gateDecision(course, gate, context.evidence.filter((e) => e.mode === "placement"), context.release.digest).objectives.flatMap((o) => o.evidenceIds);
        // 'placed' records exemption evidence; no reading or lesson visit is invented.
        await client.query(
          `INSERT INTO episode_progress (enrollment_id,episode_id,state,evidence_refs,completed_at) VALUES ($1,$2,'placed',$3,now())
           ON CONFLICT (enrollment_id,episode_id) DO UPDATE SET state='placed',evidence_refs=EXCLUDED.evidence_refs,completed_at=now()`,
          [enrollmentId, episodeId, JSON.stringify(refs)],
        );
        await appendEvent(client, { workspaceId: context.enrollment.workspace_id, enrollmentId, actorId: actor.id, actorKind: "learner", type: "episode.placed", payload: { episodeId, evidenceIds: refs, source: "placement_run" }, idempotencyKey: `${enrollmentId}:placed:${episodeId}`, supervise: true });
      }
      await client.query("UPDATE placement_runs SET state='accepted',accepted_at=clock_timestamp(),start_episode_id=$2,updated_at=clock_timestamp() WHERE id=$1", [run.id, input.startEpisodeId ?? null]);
      await bump(client, enrollmentId);
      await appendEvent(client, { workspaceId: context.enrollment.workspace_id, enrollmentId, actorId: actor.id, actorKind: "learner", type: "placement.accepted", payload: { startEpisodeId: input.startEpisodeId ?? null, placedEpisodeIds: placed }, idempotencyKey: `${enrollmentId}:placement-accept` });
      const after = await loadEnrollment(client, actor, enrollmentId);
      return { state: "accepted", placedEpisodeIds: placed, nextEpisodeId: learningSnapshot(course, after.release.digest, after.progress, after.evidence).nextEpisodeId };
    });
  });
}
