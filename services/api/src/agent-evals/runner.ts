import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ProviderError, type Json, type UsageReceipt } from "@course-core/providers";
import type { SupervisorToolPort } from "../supervisor-tool-loop.js";
import type { ProviderRuntime } from "../provider-runtime.js";
import { EVAL_ROLES, GRADER_VERSION, REPORT_SCHEMA, dialoguesFor, sha256, teachingContext, type Dialogue, type EvalRole, type EvalSuite } from "./suite.js";
import { answerText, evalOutputSchema, gradeDialogue, type DialogueGrade, type EvalOutput } from "./graders.js";
import { roleRevisions } from "./revision.js";

/** Advisory LLM-judge verdict. Never part of `passed`, never accepted as gate evidence. */
export interface AdvisoryJudgement { kind: "llm_judge_advisory"; state: "judged" | "refused" | "failed"; criteria: { id: string; met: boolean }[]; reason?: string }
export type AdvisoryJudge = (dialogue: Dialogue, output: EvalOutput, signal: AbortSignal) => Promise<AdvisoryJudgement>;
export interface DialogueRun { dialogueId: string; output: EvalOutput; grade: DialogueGrade; advisory?: AdvisoryJudgement }
/** What one model call returned, for the host's cost accounting: the provider's usage receipt and
 * the error when the call failed. Never stored in a report. */
export interface CallRecord { role: EvalRole; dialogue: Dialogue; usage: UsageReceipt | null; error: unknown }
export interface RoleRun { role: EvalRole; strategy: string; revisionDigest: string; dialogues: DialogueRun[]; passed: boolean }
export interface EvalReport {
  schema: typeof REPORT_SCHEMA;
  suite: { id: string; version: string; digest: string };
  graderVersion: typeof GRADER_VERSION;
  mode: "scripted" | "live";
  /** Scripted model name, when scripted. */
  model?: string;
  /** The provider configuration that ran (credential names only, never values). */
  configuration: unknown;
  roles: RoleRun[];
  skipped: { role: EvalRole; reason: "not_bound" | "not_covered" | "unavailable" }[];
  passed: boolean;
}

/** What a stored runtime result is, for grading. `tools` are the tool calls a tool-loop run made. */
export function evalOutput(content: unknown, tools: readonly string[] = []): EvalOutput {
  const value = content as { kind?: string; text?: unknown; summary?: unknown; needs?: unknown; reason?: unknown; sources?: unknown; criteria?: unknown };
  if (value?.kind === "companion_text" && typeof value.text === "string") return { kind: "text", text: value.text.slice(0, 32000) };
  if (value?.kind === "supervised_plan" && typeof value.summary === "string") return { kind: "tool_plan", summary: value.summary.slice(0, 16000), tools: tools.slice(0, 16) };
  if (value?.kind === "research_candidate" && typeof value.text === "string") return { kind: "research", text: value.text.slice(0, 32000), sources: Array.isArray(value.sources) ? Math.min(512, value.sources.length) : 0 };
  if (value?.kind === "rubric_suggestion") {
    const parsed = evalOutputSchema.safeParse({ kind: "review", summary: value.summary, criteria: value.criteria });
    return parsed.success ? parsed.data : { kind: "error", code: "UNEXPECTED_OUTPUT" };
  }
  if (value?.kind === "rubric_refusal") return { kind: "refusal", reason: String(value.reason).slice(0, 100) };
  if (value?.kind === "teaching_proposal") {
    const parsed = evalOutputSchema.safeParse({ kind: "plan", summary: value.summary, needs: value.needs });
    return parsed.success ? parsed.data : { kind: "error", code: "UNEXPECTED_OUTPUT" };
  }
  if (value?.kind === "output_refusal") return { kind: "refusal", reason: String(value.reason).slice(0, 100) };
  return { kind: "error", code: "UNEXPECTED_OUTPUT" };
}

/**
 * Runs every covered dialogue through the runtime's own role path (`ProviderRuntime.execute`):
 * the bound strategy assembles the prompt and calls the configured adapter. The scripted
 * model and a live provider differ only below the adapter.
 */
export async function runSuite(options: {
  suite: EvalSuite; configuration: unknown; runtime: ProviderRuntime; mode: "scripted" | "live"; model?: string;
  roles?: readonly EvalRole[];
  /** Called before each dialogue's model call; a rejection stops the run (the host's budget or deadline). */
  beforeDialogue?: (dialogue: Dialogue) => void | Promise<void>;
  /** Called after each dialogue's model call with its usage, before grading continues. */
  afterCall?: (call: CallRecord) => void | Promise<void>;
  judge?: AdvisoryJudge; signal?: AbortSignal;
}): Promise<EvalReport> {
  const { suite, runtime } = options, signal = options.signal ?? new AbortController().signal;
  const bound = runtime.strategyContracts().bound as Partial<Record<string, string>>;
  const revisions = await roleRevisions(options.configuration as Parameters<typeof roleRevisions>[0]);
  const roles: RoleRun[] = [], skipped: EvalReport["skipped"] = [];
  for (const role of options.roles ?? EVAL_ROLES) {
    const strategy = bound[role], dialogues = dialoguesFor(suite, role, strategy);
    if (!strategy) { skipped.push({ role, reason: "not_bound" }); continue; }
    if (!dialogues.length) { skipped.push({ role, reason: "not_covered" }); continue; }
    if (runtime.availability(role).status !== "ready") { skipped.push({ role, reason: "unavailable" }); continue; }
    const runs: DialogueRun[] = [];
    for (const [index, dialogue] of dialogues.entries()) {
      await options.beforeDialogue?.(dialogue);
      let output: EvalOutput, usage: UsageReceipt | null = null, failure: unknown = null;
      try {
        const context = teachingContext(dialogue);
        if (role === "media") {
          // Media is judged on the request Core assembles; nothing is generated or paid for.
          const request = await runtime.assembledRequest(role, context);
          output = request && typeof request.prompt === "string" ? { kind: "media_prompt", prompt: request.prompt.slice(0, 70000) } : { kind: "error", code: "NO_REQUEST" };
        } else {
          const called: string[] = [];
          const result = await runtime.execute(role, context, `agent-eval-${role}-${index}`, signal, scriptedTools(dialogue, called));
          usage = result.usage;
          output = evalOutput(result.content, called);
        }
      } catch (error) {
        failure = error;
        usage = error instanceof ProviderError ? error.usage ?? null : null;
        output = { kind: "error", code: error instanceof ProviderError ? error.code : "UNEXPECTED" };
      }
      await options.afterCall?.({ role, dialogue, usage, error: failure });
      const run: DialogueRun = { dialogueId: dialogue.id, output, grade: gradeDialogue(dialogue, output) };
      if (options.judge && dialogue.judge && answerText(output) !== null) run.advisory = await options.judge(dialogue, output, signal);
      runs.push(run);
    }
    roles.push({ role, strategy, revisionDigest: revisions[role]!.digest, dialogues: runs, passed: runs.every((r) => r.grade.passed) });
  }
  return {
    schema: REPORT_SCHEMA, suite: { id: suite.id, version: suite.version, digest: suite.digest }, graderVersion: GRADER_VERSION,
    mode: options.mode, ...(options.model ? { model: options.model } : {}), configuration: options.configuration, roles, skipped,
    passed: roles.length > 0 && roles.every((r) => r.passed),
  };
}

/** Deterministic tools for a tool-loop dialogue: each answers from the dialogue's fixture and the
 * call is recorded for the tool-scope grader. Undefined for dialogues without tools. */
function scriptedTools(dialogue: Dialogue, called: string[]): SupervisorToolPort | undefined {
  const rule = dialogue.expect.tools;
  if (!rule) return undefined;
  return { async invoke(name) {
    called.push(name);
    const result = rule.results[name] ?? { available: false, reason: "not_in_fixture" };
    return { receiptId: randomUUID(), result: structuredClone(result) as Json };
  } };
}

/**
 * Optional LLM judge through the bound reviewer role (Core's rubric-assist strategy): the
 * dialogue's judge criteria are the rubric and the agent's answer is the response. Advisory
 * only. The reviewer's own checks still apply (it must quote the answer for each met criterion).
 */
export function reviewerJudge(runtime: ProviderRuntime): AdvisoryJudge {
  return async (dialogue, output, signal) => {
    const text = answerText(output) ?? "", criteria = dialogue.judge!.criteria.map((c) => ({ id: c.id, description: c.description, required: true }));
    try {
      const result = await runtime.execute("reviewer", { ...teachingContext(dialogue), rubricReview: {
        requestId: randomUUID(), attemptId: randomUUID(), prompt: dialogue.context.question, criteria, response: text, earlierTurns: [],
        rubricDigest: sha256(JSON.stringify(criteria)), responseDigest: sha256(text) } }, `agent-eval-judge-${dialogue.id.slice(0, 80)}`, signal);
      const content = result.content as { kind?: string; criteria?: { criterionId: string; met: boolean }[]; reason?: string };
      if (content.kind === "rubric_suggestion") return { kind: "llm_judge_advisory", state: "judged", criteria: (content.criteria ?? []).map((c) => ({ id: c.criterionId, met: c.met })) };
      return { kind: "llm_judge_advisory", state: "refused", criteria: [], reason: String(content.reason ?? "refused").slice(0, 100) };
    } catch (error) {
      return { kind: "llm_judge_advisory", state: "failed", criteria: [], reason: error instanceof ProviderError ? error.code : "UNEXPECTED" };
    }
  };
}

/** Report shape the API accepts; the API ignores the report's own grades and regrades. */
export const reportSchema = z.strictObject({
  schema: z.literal(REPORT_SCHEMA),
  suite: z.strictObject({ id: z.string().max(120), version: z.string().max(40), digest: z.string().regex(/^[a-f0-9]{64}$/) }),
  graderVersion: z.string().max(100),
  mode: z.enum(["scripted", "live"]),
  model: z.string().max(80).optional(),
  configuration: z.unknown(),
  roles: z.array(z.strictObject({
    role: z.enum(EVAL_ROLES as [EvalRole, ...EvalRole[]]), strategy: z.string().max(200), revisionDigest: z.string().regex(/^[a-f0-9]{64}$/),
    dialogues: z.array(z.strictObject({ dialogueId: z.string().max(120), output: evalOutputSchema, grade: z.unknown().optional(), advisory: z.unknown().optional() })).max(200),
    passed: z.boolean(),
  })).min(1).max(EVAL_ROLES.length),
  skipped: z.array(z.unknown()).max(10),
  passed: z.boolean(),
});
