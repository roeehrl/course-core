import type { PoolClient } from "pg";
import type { RunRef } from "@course-core/supervisor";
import { confirmsDeterministically, conversationGate, gateConversation, reviewedRubric } from "./gates.js";
import { declarationMatchesInstalled } from "./extension-identity.js";
import { assertGradeAllowed } from "./policy-adapter.js";
import { readRelease } from "./release-cache.js";
import { digestJson } from "./repository.js";
import type { RubricSuggestion } from "./rubric-assist-contracts.js";
import { rubricDigest } from "./rubric-evaluator.js";
import { checkFindings, recordRubricJudgment, threadOf } from "./rubric-judgment.js";
import type { RuntimeExtension } from "./publication.js";

/** Why a verified proposal was not confirmed automatically. The answer then waits for a person. */
type Declined = "not_ready" | "proposal_not_met" | "quotes_not_learner_words" | "evaluator_declined" | "evaluator_failed" | "grading_closed" | "evaluator_unavailable";

/**
 * Deterministic confirmation of a gate conversation (audit #11). After the host verifier
 * accepted a model's quoted proposal and it was stored, a gate whose evaluator is declared
 * `method: 'deterministic'` asks its installed, integrity-matched adapter to confirm each quoted
 * finding. Core records "met" evidence only when every finding the proposal marks met is
 * confirmed, every required criterion is among them, and every quote is the learner's own words
 * in this conversation. Anything else records why and leaves the answer pending for a human
 * reviewer: deterministic confirmation never records "not met", and a model's judgment alone
 * never counts.
 */
export function deterministicConversationConfirmer(installed: readonly RuntimeExtension[]) {
  return async (client: PoolClient, ref: RunRef, suggestion: RubricSuggestion, suggestionId: string): Promise<void> => {
    const row = (await client.query(
      `SELECT a.id,a.enrollment_id,a.assessment_id,a.response,a.result,a.submitted_at,c.episode_id,e.workspace_id,e.status,e.course_release_id
       FROM attempts a JOIN assessment_challenges c ON c.attempt_id=a.id AND c.enrollment_id=a.enrollment_id JOIN enrollments e ON e.id=a.enrollment_id
       WHERE a.id=$1 AND a.enrollment_id=$2 AND e.workspace_id=$3 FOR UPDATE OF a`, [suggestion.attemptId, ref.enrollmentId, ref.workspaceId])).rows[0];
    const release = row && await readRelease(client, row.course_release_id, row.workspace_id);
    const course = release?.server_bundle, gate = course && conversationGate(course, row.assessment_id);
    const resolved = course && gate ? gateConversation(course, gate) : undefined;
    // Only gates whose evaluator confirms deterministically; every other gate keeps human confirmation.
    if (!course || !resolved || !confirmsDeterministically(resolved.evaluator)) return;
    const record = async (state: "confirmed" | Declined, extra: Record<string, unknown> = {}) => void await client.query("UPDATE rubric_suggestions SET automatic_check=$2 WHERE id=$1", [suggestionId, JSON.stringify({ state, evaluatorId: resolved.evaluator.id, evaluatorVersion: resolved.evaluator.version, ...extra })]);
    const view = reviewedRubric(course, row.assessment_id)!;
    const reviewed = (await client.query("SELECT 1 FROM rubric_reviews WHERE attempt_id=$1", [row.id])).rowCount;
    if (reviewed || row.status === "erased" || row.result?.status !== "pending_review" || rubricDigest(view) !== row.result.rubricDigest
      || suggestion.rubricDigest !== row.result.rubricDigest || suggestion.responseDigest !== digestJson(String(row.response))) return record("not_ready");
    const declaration = course.extensions.find((d: { id: string }) => d.id === resolved.evaluator.extensionId);
    const adapter = installed.find((e) => e.id === resolved.evaluator.extensionId && declaration !== undefined && declarationMatchesInstalled(declaration, e));
    if (!adapter?.confirmConversationFindings) return record("evaluator_unavailable");
    const thread = await threadOf(client, row.id);
    const turns = [...thread.map((t) => ({ turnId: t.attemptId, text: t.response })), { turnId: row.id as string, text: String(row.response) }];
    try { checkFindings(view.criteria, turns.map((t) => t.text), "met", suggestion.criteria); }
    catch (error) { return record((error as { code?: string }).code === "RUBRIC_QUOTE_REQUIRED" ? "quotes_not_learner_words" : "proposal_not_met"); }
    const findings = suggestion.criteria.map((c) => ({ criterionId: c.criterionId, met: c.met, quote: c.met ? c.quote : "",
      turnId: c.met ? turns.find((t) => t.text.includes(c.quote))?.turnId ?? null : null }));
    let verdicts: readonly { criterionId: string; confirmed: boolean }[];
    try {
      verdicts = adapter.confirmConversationFindings({ rubric: { id: resolved.rubric.id, version: resolved.rubric.version, criteria: view.criteria }, learnerTurns: turns, findings });
    } catch { return record("evaluator_failed"); }
    const confirmed = findings.filter((f) => f.met).every((f) => verdicts.filter((v) => v.criterionId === f.criterionId).length === 1
      && verdicts.find((v) => v.criterionId === f.criterionId)!.confirmed === true);
    if (!confirmed) return record("evaluator_declined", { criteria: verdicts.filter((v) => findings.some((f) => f.criterionId === v.criterionId)).map((v) => ({ criterionId: v.criterionId, confirmed: v.confirmed === true })) });
    // An on-time submission may be confirmed after the cutoff without reopening it (P08); a policy refusal leaves it for a person.
    await client.query("SAVEPOINT conversation_confirmation");
    try { await assertGradeAllowed(client, { enrollmentId: row.enrollment_id, attemptId: row.id, episodeId: row.episode_id, submittedAt: row.submitted_at }, new Date().toISOString()); }
    catch { await client.query("ROLLBACK TO SAVEPOINT conversation_confirmation"); return record("grading_closed"); }
    await client.query("RELEASE SAVEPOINT conversation_confirmation");
    const confirmer = { evaluatorId: resolved.evaluator.id, evaluatorVersion: resolved.evaluator.version, extensionId: adapter.id, extensionVersion: adapter.version, integrity: adapter.integrity };
    const criteria = findings.map((f) => ({ criterionId: f.criterionId, met: f.met, ...(f.met ? { quote: f.quote } : {}) }));
    await recordRubricJudgment(client, { attempt: { ...row, workspace_id: row.workspace_id }, attemptId: row.id, assessment: view, thread, decision: "met", criteria,
      requestDigest: digestJson({ confirmer, suggestionId, criteria }), suggestionId, confirmation: { kind: "deterministic", confirmer } });
    await record("confirmed");
  };
}
