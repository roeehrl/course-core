import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { AGENT_ROLES, type AgentRole } from "../agent-strategies.js";
import type { Actor } from "../auth.js";
import { workspaceRole } from "../course-access.js";
import { transaction, type Database } from "../database.js";
import { ApiError, requireCondition } from "../errors.js";
import { composeProviders, providerConfigurationSchema } from "../provider-composition.js";
import type { WorkspaceProviders } from "../provider-setup.js";
import { gradeDialogue } from "./graders.js";
import { roleRevisions } from "./revision.js";
import { reportSchema } from "./runner.js";
import { canonicalJson, covers, dialoguesFor, sha256, type EvalSuite } from "./suite.js";

/**
 * The activation gate (requirement N07): a provider, model or prompt revision of a role cannot
 * become active until a passing evaluation of that exact revision against the current suite is
 * recorded, or a workspace owner records an explicit override for it. Both are append-only
 * rows bound to the role revision digest and the suite digest, so a later change to either one
 * needs new evidence.
 *
 * Every role is gated (requirement N07). The public suite covers every Core strategy (companion,
 * supervisor plan and tool loop, research, reviewer, media image and video); a role bound to a
 * strategy the suite does not cover (a host's own pack) needs an owner's explicit override for its
 * exact revision, recorded with a reason, before it activates.
 * The gate applies at activation only; there is no runtime gate. Active roles are never
 * deactivated: a version saved before the gate existed, a role activated while its strategy was
 * not covered, or one activated on evidence for an older suite keeps running and is reported as
 * grandfathered (`not_evaluated`, `stale` or `not_covered`) until a check or an owner override for
 * its current revision is recorded. Saving a change that leaves a role's revision as it is never
 * needs new evidence for that role; changing it does.
 */
export const GATE_VERSION = "core.provider-eval-gate/1";
export type RoleDecision = {
  revisionDigest: string; strategy: string | null;
  decision: "passed" | "override" | "unchanged" | "not_covered";
  grandfathered: boolean; resultId?: string; overrideId?: string;
};
export interface VersionEvaluation { gate: typeof GATE_VERSION; suiteId: string; suiteDigest: string; roles: Partial<Record<AgentRole, RoleDecision>> }
type Sql = Database | PoolClient;
type Configuration = z.infer<typeof providerConfigurationSchema>;

async function evidence(client: Sql, workspace: string, role: string, digest: string, suiteDigest: string) {
  const passed = (await client.query<{ id: string; created_at: Date }>(
    "SELECT id,created_at FROM provider_eval_results WHERE workspace_id=$1 AND role=$2 AND revision_digest=$3 AND suite_digest=$4 AND outcome='passed' ORDER BY created_at DESC,id LIMIT 1",
    [workspace, role, digest, suiteDigest])).rows[0];
  const override = passed ? undefined : (await client.query<{ id: string; created_at: Date }>(
    "SELECT id,created_at FROM provider_eval_overrides WHERE workspace_id=$1 AND role=$2 AND revision_digest=$3 AND suite_digest=$4 ORDER BY created_at DESC,id LIMIT 1",
    [workspace, role, digest, suiteDigest])).rows[0];
  const latest = (await client.query<{ id: string; outcome: string; suite_digest: string; created_at: Date }>(
    "SELECT id,outcome,suite_digest,created_at FROM provider_eval_results WHERE workspace_id=$1 AND role=$2 AND revision_digest=$3 ORDER BY created_at DESC,id LIMIT 1",
    [workspace, role, digest])).rows[0];
  return { passed, override, latest };
}

export type RoleCheck = "passed" | "approved" | "unchanged" | "not_needed" | "needed" | "failed";
/**
 * The gate's view of every bound role of `next` without throwing: what activation would record,
 * and which changed covered roles still lack evidence (`missing`).
 */
export async function evaluateActivation(client: Sql, workspace: string, suite: EvalSuite,
  previous: { configuration: Configuration; evaluation: VersionEvaluation | null } | undefined, next: Configuration) {
  const nextRevisions = await roleRevisions(next), previousRevisions = previous ? await roleRevisions(previous.configuration) : {};
  const roles: VersionEvaluation["roles"] = {}, missing: { role: AgentRole; revisionDigest: string; reason: string }[] = [];
  for (const role of AGENT_ROLES) {
    const revision = nextRevisions[role];
    if (!revision) continue;
    const base = { revisionDigest: revision.digest, strategy: revision.strategy };
    if (previous && previousRevisions[role]?.digest === revision.digest) {
      const before = previous.evaluation?.roles[role];
      const grandfathered = !before || (before.decision === "unchanged" ? before.grandfathered : before.decision === "not_covered");
      roles[role] = { ...base, decision: "unchanged", grandfathered,
        ...(before?.resultId ? { resultId: before.resultId } : {}), ...(before?.overrideId ? { overrideId: before.overrideId } : {}) };
      continue;
    }
    const found = await evidence(client, workspace, role, revision.digest, suite.digest);
    const covered = covers(suite, role, revision.strategy);
    if (covered && found.passed) roles[role] = { ...base, decision: "passed", grandfathered: false, resultId: found.passed.id };
    else if (found.override) roles[role] = { ...base, decision: "override", grandfathered: false, overrideId: found.override.id };
    // Not covered: only an owner's override of this exact revision can activate it.
    else missing.push({ role, revisionDigest: revision.digest,
      reason: !covered ? "not_covered" : !found.latest ? "not_evaluated" : found.latest.suite_digest !== suite.digest ? "stale_suite" : "failed" });
  }
  return { roles, missing };
}
/**
 * Roles of an active configuration that have neither a passing result nor an owner override for
 * their current revision and the current suite: they keep running (there is no runtime gate), but a
 * change to them needs new evidence. `covered` says whether Core's suite can check the role; a role
 * it cannot check (a host's own strategy) needs an owner's approval instead.
 */
export async function uncheckedRoles(client: Sql, workspace: string, suite: EvalSuite, configuration: Configuration) {
  const revisions = await roleRevisions(configuration);
  const result: { role: AgentRole; revisionDigest: string; strategy: string | null; covered: boolean; failed: boolean }[] = [];
  for (const role of AGENT_ROLES) {
    const revision = revisions[role];
    if (!revision) continue;
    const found = await evidence(client, workspace, role, revision.digest, suite.digest);
    if (found.passed || found.override) continue;
    result.push({ role, revisionDigest: revision.digest, strategy: revision.strategy, covered: covers(suite, role, revision.strategy),
      failed: found.latest?.suite_digest === suite.digest && found.latest.outcome === "failed" });
  }
  return result;
}
/** Whether a role's stored activation rests on evidence for an older suite (or none at all). */
async function activatedWithoutCurrentEvidence(client: Sql, suite: EvalSuite, decision: RoleDecision | undefined) {
  if (!decision || decision.grandfathered || decision.decision === "not_covered") return true;
  const table = decision.resultId ? "provider_eval_results" : decision.overrideId ? "provider_eval_overrides" : null;
  if (!table) return false;
  const row = (await client.query<{ suite_digest: string }>(`SELECT suite_digest FROM ${table} WHERE id=$1`,
    [decision.resultId ?? decision.overrideId])).rows[0];
  return !row || row.suite_digest !== suite.digest;
}
/** Plain per-role check states for the admin page: what a role still needs before activation. */
export function roleChecks(evaluated: Awaited<ReturnType<typeof evaluateActivation>>) {
  const checks: Partial<Record<AgentRole, { check: RoleCheck; revisionDigest: string }>> = {};
  for (const [role, decision] of Object.entries(evaluated.roles) as [AgentRole, RoleDecision][])
    checks[role] = { revisionDigest: decision.revisionDigest, check: decision.decision === "passed" ? "passed" : decision.decision === "override" ? "approved"
      : decision.decision === "unchanged" ? "unchanged" : "not_needed" };
  for (const item of evaluated.missing) checks[item.role] = { revisionDigest: item.revisionDigest, check: item.reason === "failed" ? "failed" : "needed" };
  return checks;
}

/**
 * Decides whether `next` may become the active configuration. Unchanged roles keep their
 * standing; changed or new covered roles need evidence. Throws 409 PROVIDER_EVAL_REQUIRED
 * listing every role that lacks it.
 */
export async function activationDecision(client: PoolClient, workspace: string, suite: EvalSuite,
  previous: { configuration: Configuration; evaluation: VersionEvaluation | null } | undefined, next: Configuration): Promise<VersionEvaluation> {
  const { roles, missing } = await evaluateActivation(client, workspace, suite, previous, next);
  if (missing.length)
    throw new ApiError(409, "PROVIDER_EVAL_REQUIRED", "PROVIDER_EVAL_REQUIRED", { suiteId: suite.id, suiteDigest: suite.digest, roles: missing });
  return { gate: GATE_VERSION, suiteId: suite.id, suiteDigest: suite.digest, roles };
}

const key = z.string().regex(/^[A-Za-z0-9:_-]{8,200}$/);
const recordSchema = z.strictObject({ idempotencyKey: key, report: reportSchema });
const overrideSchema = z.union([
  z.strictObject({
    idempotencyKey: key, role: z.enum(AGENT_ROLES), revisionDigest: z.string().regex(/^[a-f0-9]{64}$/),
    reason: z.string().trim().min(20).max(1000),
  }),
  // The admin page approves the exact revision of a role in the open setup draft; the server
  // resolves its digest, so nobody copies a fingerprint by hand.
  z.strictObject({
    idempotencyKey: key, role: z.enum(AGENT_ROLES), draftId: z.string().uuid(),
    reason: z.string().trim().min(20).max(1000),
  }),
]);
const iso = (value: Date | string) => new Date(value).toISOString();

export class ProviderEvaluations {
  constructor(readonly db: Database, readonly providers: WorkspaceProviders) {}
  get suite() { return this.providers.evalSuite; }

  private async member(client: PoolClient, actor: Actor, workspace: string, allowed: readonly string[]) {
    const member = (await client.query<{ role: string }>("SELECT role FROM memberships WHERE workspace_id=$1 AND user_id=$2 FOR SHARE", [workspace, actor.id])).rows[0];
    requireCondition(member && allowed.includes(member.role), "FORBIDDEN", 403);
  }

  /** Status of the active revision of every role, with recent results and overrides. Owners and admins. */
  async status(actor: Actor, workspace: string) {
    await workspaceRole(this.db, actor, workspace, ["owner", "admin"]);
    const suite = this.suite, active = await this.providers.version(this.db, workspace);
    const evaluation = active ? (await this.db.query<{ evaluation: VersionEvaluation | null }>(
      "SELECT evaluation FROM workspace_provider_versions WHERE workspace_id=$1 AND revision=$2", [workspace, active.revision])).rows[0]?.evaluation ?? null : null;
    const revisions = active ? await roleRevisions(active.configuration) : {};
    const roles = [];
    for (const role of AGENT_ROLES) {
      const revision = revisions[role];
      if (!revision) continue;
      // Grandfathered: on without evidence for the current suite (saved before the gate, activated
      // while its strategy was not covered, or approved for an older suite). It keeps running; a
      // change to it needs a check.
      const decision = evaluation?.roles[role], grandfathered = !evaluation || await activatedWithoutCurrentEvidence(this.db, suite, decision);
      const row = { role, strategy: revision.strategy, revisionDigest: revision.digest, grandfathered, activatedBy: decision?.decision ?? null };
      const found = await evidence(this.db, workspace, role, revision.digest, suite.digest);
      if (!covers(suite, role, revision.strategy)) {
        roles.push({ ...row, covered: false, status: found.override ? "override" as const : "not_covered" as const,
          ...(found.override ? { overrideId: found.override.id, overriddenAt: iso(found.override.created_at) } : {}) });
        continue;
      }
      const status = found.passed ? "passed" as const : found.override ? "override" as const
        : found.latest?.suite_digest === suite.digest && found.latest.outcome === "failed" ? "failed" as const
        : decision?.resultId || decision?.overrideId || found.latest ? "stale" as const : "not_evaluated" as const;
      roles.push({ ...row, covered: true, status, ...(found.passed ? { resultId: found.passed.id, evaluatedAt: iso(found.passed.created_at) } : {}),
        ...(found.override ? { overrideId: found.override.id, overriddenAt: iso(found.override.created_at) } : {}) });
    }
    const results = (await this.db.query(
      `SELECT id,role,revision_digest AS "revisionDigest",suite_id AS "suiteId",suite_digest AS "suiteDigest",grader_version AS "graderVersion",mode,outcome,grades,actor_id AS "actorId",created_at AS "createdAt"
       FROM provider_eval_results WHERE workspace_id=$1 ORDER BY created_at DESC,id LIMIT 50`, [workspace])).rows
      .map((r) => ({ ...r, createdAt: iso(r.createdAt), failed: (r.grades as { dialogueId: string; passed: boolean; graders: { grader: string; passed: boolean }[] }[])
        .filter((g) => !g.passed).map((g) => ({ dialogueId: g.dialogueId, graders: g.graders.filter((x) => !x.passed).map((x) => x.grader) })), grades: undefined }));
    const overrides = (await this.db.query(
      `SELECT id,role,revision_digest AS "revisionDigest",suite_digest AS "suiteDigest",reason,actor_id AS "actorId",created_at AS "createdAt"
       FROM provider_eval_overrides WHERE workspace_id=$1 ORDER BY created_at DESC,id LIMIT 50`, [workspace])).rows.map((r) => ({ ...r, createdAt: iso(r.createdAt) }));
    return {
      suite: { id: suite.id, version: suite.version, digest: suite.digest, dialogues: suite.dialogues.length,
        coverage: [...new Set(suite.dialogues.map((d) => d.role))].map((role) => ({ role, dialogues: suite.dialogues.filter((d) => d.role === role).length })) },
      providerRevision: active?.revision ?? 0, gatedAtActivation: evaluation !== null, roles, results, overrides,
      /** Scripted runs evaluate the scripted model only; their digests never match a real model binding. */
      evidence: "recorded_reports_regraded_by_core",
    };
  }

  /**
   * Records a runner report (`npm run eval:agents -- --report FILE`). Core does not trust the
   * report's own grades: it recomputes the revision digest from the report's configuration and
   * regrades every answer with its own graders and suite. Failed results are recorded too.
   */
  async record(actor: Actor, workspace: string, raw: unknown) {
    // Authorize before parsing and regrading a report of up to 1 MB; the transaction below checks again.
    await transaction(this.db, (client) => this.member(client, actor, workspace, ["owner", "admin"]));
    const parsed = recordSchema.safeParse(raw);
    requireCondition(parsed.success, "PROVIDER_EVAL_REPORT_INVALID", 400);
    const { report, idempotencyKey } = parsed.data, suite = this.suite;
    if (report.suite.digest !== suite.digest)
      throw new ApiError(409, "PROVIDER_EVAL_SUITE_STALE", "PROVIDER_EVAL_SUITE_STALE", { suiteId: suite.id, suiteDigest: suite.digest });
    const configuration = providerConfigurationSchema.safeParse(report.configuration);
    requireCondition(configuration.success, "PROVIDER_CONFIGURATION_INVALID", 400);
    this.providers.checkPublicConfiguration(configuration.data);
    let bound: Partial<Record<string, string>>;
    try { bound = composeProviders(configuration.data, () => "configuration-validation-only", this.providers.factories).strategyContracts().bound; }
    catch { throw new ApiError(400, "PROVIDER_CONFIGURATION_INVALID"); }
    const revisions = await roleRevisions(configuration.data);
    requireCondition(new Set(report.roles.map((r) => r.role)).size === report.roles.length, "PROVIDER_EVAL_REPORT_INVALID", 400);
    const graded = report.roles.map((run) => {
      const strategy = bound[run.role], dialogues = dialoguesFor(suite, run.role, strategy);
      requireCondition(dialogues.length && strategy === run.strategy, "PROVIDER_EVAL_ROLE_NOT_COVERED", 409);
      if (revisions[run.role]?.digest !== run.revisionDigest)
        throw new ApiError(409, "PROVIDER_EVAL_REVISION_MISMATCH", "PROVIDER_EVAL_REVISION_MISMATCH", { role: run.role, revisionDigest: revisions[run.role]?.digest ?? null });
      const outputs = new Map(run.dialogues.map((d) => [d.dialogueId, d.output]));
      requireCondition(outputs.size === run.dialogues.length && outputs.size === dialogues.length && dialogues.every((d) => outputs.has(d.id)),
        "PROVIDER_EVAL_REPORT_INCOMPLETE", 400);
      const grades = dialogues.map((d) => gradeDialogue(d, outputs.get(d.id)!));
      return { role: run.role, revisionDigest: run.revisionDigest, grades, outcome: grades.every((g) => g.passed) ? "passed" as const : "failed" as const };
    });
    const requestDigest = sha256(canonicalJson({ workspace, report }));
    return transaction(this.db, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["provider-eval:" + workspace]);
      await this.member(client, actor, workspace, ["owner", "admin"]);
      const earlier = (await client.query("SELECT id,role,revision_digest,suite_digest,outcome,mode,grades,request_digest FROM provider_eval_results WHERE workspace_id=$1 AND idempotency_key=$2 ORDER BY role",
        [workspace, idempotencyKey])).rows;
      if (earlier.length) {
        requireCondition(earlier.every((r) => r.request_digest === requestDigest), "IDEMPOTENCY_CONFLICT", 409);
        return { results: earlier.map((r) => ({ id: r.id, role: r.role, revisionDigest: r.revision_digest, suiteDigest: r.suite_digest, outcome: r.outcome, mode: r.mode, grades: r.grades })) };
      }
      const results = [];
      for (const item of graded) {
        const id = randomUUID();
        await client.query(
          "INSERT INTO provider_eval_results(id,workspace_id,role,revision_digest,suite_id,suite_digest,grader_version,mode,outcome,grades,actor_id,idempotency_key,request_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",
          [id, workspace, item.role, item.revisionDigest, suite.id, suite.digest, report.graderVersion, report.mode, item.outcome, JSON.stringify(item.grades), actor.id, idempotencyKey, requestDigest]);
        results.push({ id, role: item.role, revisionDigest: item.revisionDigest, suiteDigest: suite.digest, outcome: item.outcome, mode: report.mode, grades: item.grades });
      }
      return { results };
    });
  }

  /** An owner's explicit, audited decision to activate one revision without a passing result. */
  async override(actor: Actor, workspace: string, raw: unknown) {
    const parsed = overrideSchema.safeParse(raw);
    requireCondition(parsed.success, "PROVIDER_EVAL_OVERRIDE_INVALID", 400);
    const suite = this.suite, requestDigest = sha256(canonicalJson({ workspace, ...parsed.data }));
    return transaction(this.db, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["provider-eval:" + workspace]);
      await this.member(client, actor, workspace, ["owner"]);
      const earlier = (await client.query("SELECT id,role,revision_digest,suite_digest,request_digest,created_at FROM provider_eval_overrides WHERE workspace_id=$1 AND idempotency_key=$2",
        [workspace, parsed.data.idempotencyKey])).rows[0];
      if (earlier) {
        requireCondition(earlier.request_digest === requestDigest, "IDEMPOTENCY_CONFLICT", 409);
        return { id: earlier.id, role: earlier.role, revisionDigest: earlier.revision_digest, suiteDigest: earlier.suite_digest, createdAt: iso(earlier.created_at) };
      }
      let input: { idempotencyKey: string; role: AgentRole; revisionDigest: string; reason: string };
      if ("draftId" in parsed.data) {
        const draft = (await client.query<{ configuration: unknown }>("SELECT configuration FROM provider_setup_drafts WHERE workspace_id=$1 AND id=$2",
          [workspace, parsed.data.draftId])).rows[0];
        requireCondition(draft, "PROVIDER_DRAFT_NOT_FOUND", 404);
        const configuration = providerConfigurationSchema.parse(draft.configuration);
        const revision = (await roleRevisions(configuration))[parsed.data.role];
        // Covered or not: an owner may approve the exact revision of a bound role.
        requireCondition(revision, "PROVIDER_EVAL_ROLE_NOT_COVERED", 409);
        input = { idempotencyKey: parsed.data.idempotencyKey, role: parsed.data.role, revisionDigest: revision.digest, reason: parsed.data.reason };
      } else input = parsed.data;
      const id = randomUUID();
      const row = (await client.query<{ created_at: Date }>(
        "INSERT INTO provider_eval_overrides(id,workspace_id,role,revision_digest,suite_id,suite_digest,reason,actor_id,idempotency_key,request_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING created_at",
        [id, workspace, input.role, input.revisionDigest, suite.id, suite.digest, input.reason, actor.id, input.idempotencyKey, requestDigest])).rows[0]!;
      return { id, role: input.role, revisionDigest: input.revisionDigest, suiteDigest: suite.digest, createdAt: iso(row.created_at) };
    });
  }
}
