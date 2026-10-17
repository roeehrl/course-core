import {
  definiteRejection,
  ProviderError,
  type OutputSchema,
  type Json,
  type UsageReceipt,
} from "@course-core/providers";
import { z } from "zod";
import type { TeachingContext } from "./provider-runtime.js";
import {
  generatedTeachingSelectionSchema,
  type GeneratedTeachingSelection,
} from "./generated-teaching.js";
import {
  researchSelectionSchema,
  type ResearchSelection,
} from "./research-contracts.js";
import { learnerModelSuggestionSchema } from "./learner-model.js";
import { resourceChoiceSchema, type ResourceChoice } from "./research-media.js";
import { telemetry } from "./telemetry.js";
import { SUPERVISOR_TOOL_IDS, supervisorTool } from "./supervisor-tool-catalog.js";
import type { OutputRefusal, ToolLoopRefusalReason } from "./output-refusal.js";

/** The tools offered to the model: the SDK-shaped catalog, or a strategy's subset of it. */
export function supervisorToolDecisionSchemaFor(toolIds: readonly string[]): OutputSchema {
  return {
    type: "object",
    required: ["decision", "tool", "argumentsJson", "summary"],
    properties: {
      decision: { type: "string", enum: ["tool", "finish"] },
      tool: { type: "string", enum: [...toolIds, "none"] },
      argumentsJson: { type: "string" },
      summary: { type: "string" },
    },
  };
}
export const supervisorToolDecisionSchema: OutputSchema = supervisorToolDecisionSchemaFor(SUPERVISOR_TOOL_IDS);
function decisionSchemaFor(toolIds: readonly string[]) {
  return z.strictObject({
    decision: z.enum(["tool", "finish"]),
    tool: z.enum(["none", ...toolIds]),
    argumentsJson: z.string().max(10000),
    summary: z.string().max(16000),
  });
}
export const modelSuggestionSelectionSchema = z.strictObject({
  suggestion: learnerModelSuggestionSchema,
  sourceEventIds: z
    .array(z.string().uuid())
    .min(1)
    .max(8)
    .refine((ids) => new Set(ids).size === ids.length),
  sourceEventDigests: z
    .array(
      z.strictObject({
        eventId: z.string().uuid(),
        digest: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .min(1)
    .max(8),
  permissionRevision: z.number().int().positive(),
});
export type ModelSuggestionSelection = z.infer<
  typeof modelSuggestionSelectionSchema
>;
export interface SupportSelection {
  profileId: string;
  entryId: string;
  permissionRevision: number;
}
export interface SupervisorToolPort {
  invoke(
    name: string,
    args: unknown,
    step: number,
    signal?: AbortSignal,
  ): Promise<{
    receiptId: string;
    result: Json;
    selection?: SupportSelection;
    modelSuggestion?: ModelSuggestionSelection;
    generatedTeaching?: GeneratedTeachingSelection;
    researchSelection?: ResearchSelection;
    resourceChoice?: ResourceChoice;
  }>;
}
export interface SupervisedPlan {
  kind: "supervised_plan";
  summary: string;
  selection: SupportSelection | null;
  toolCallRefs: string[];
  modelSuggestion?: ModelSuggestionSelection | undefined;
  generatedTeaching?: GeneratedTeachingSelection | undefined;
  researchSelections?: ResearchSelection[] | undefined;
  /** At most one verified reviewed resource per objective. */
  resourceChoices?: ResourceChoice[] | undefined;
}
export const supervisedPlanSchema = z
  .strictObject({
    kind: z.literal("supervised_plan"),
    summary: z.string().min(1).max(16000),
    selection: z
      .strictObject({
        profileId: z.string().regex(/^[a-z][a-z0-9._:-]{0,127}$/),
        entryId: z.string().regex(/^[a-z][a-z0-9._:-]{0,127}$/),
        permissionRevision: z.number().int().positive(),
      })
      .nullable(),
    toolCallRefs: z.array(z.string().uuid()).max(8),
    modelSuggestion: modelSuggestionSelectionSchema.optional(),
    generatedTeaching: generatedTeachingSelectionSchema.optional(),
    researchSelections: z.array(researchSelectionSchema).max(2).optional(),
    resourceChoices: z
      .array(resourceChoiceSchema)
      .min(1)
      .max(2)
      .refine((c) => new Set(c.map((x) => x.objectiveId)).size === c.length)
      .optional(),
  })
  .refine((plan) => !(plan.selection && plan.generatedTeaching));
/** A tool port refusing the model's call for a reason the model alone caused (arguments that
 * fail the tool's contract, a candidate limit). Nothing was recorded for that call; the loop ends
 * the run with a definite refusal instead of an uncertain error. */
export class ToolCallRefused extends Error {
  /** `code` is the tool's own refusal code, kept for its callers and tests. */
  constructor(readonly reason: ToolLoopRefusalReason, readonly code: string) {
    super(code);
    this.name = "ToolCallRefused";
  }
}
export async function runSupervisorToolLoop(options: {
  context: TeachingContext;
  roundLimit: number;
  maxInputCharacters: number;
  accountingKey: string;
  signal: AbortSignal;
  tools: SupervisorToolPort;
  /** A strategy's tool references; every id must be in the catalog. Defaults to the whole catalog. */
  toolIds?: readonly string[];
  model: (
    input: {
      prompt: string;
      accountingKey: string;
      outputSchema: OutputSchema;
    },
    signal: AbortSignal,
  ) => Promise<{ output: Json; usage: UsageReceipt }>;
}) {
  const toolIds = options.toolIds ?? SUPERVISOR_TOOL_IDS;
  if (!toolIds.length || toolIds.some((id) => !supervisorTool(id)) || new Set(toolIds).size !== toolIds.length)
    throw new ProviderError("INVALID_CONFIG");
  const outputSchema = supervisorToolDecisionSchemaFor(toolIds), decisionSchema = decisionSchemaFor(toolIds);
  const receipts: UsageReceipt[] = [],
    toolCallRefs: string[] = [],
    trace: { tool: string; result: Json }[] = [];
  let selected: SupportSelection | null = null,
    modelSuggestion: ModelSuggestionSelection | undefined,
    generatedTeaching: GeneratedTeachingSelection | undefined,
    generatedCandidates = 0,
    researchSelections: ResearchSelection[] = [];
  const resourceChoices = new Map<string, ResourceChoice>();
  // Core's own round checks refusing what the model decided are a definite outcome: the model
  // answered, and every receipt and paid round so far is known. The run ends with a refusal that
  // holds only the reason (never a partial plan), charged with the real usage of every round.
  // The plan verifier rejects it, so the job ends failed and nothing is applied.
  const refuse = (reason: ToolLoopRefusalReason) => ({
    content: { kind: "output_refusal", role: "supervisor", reason } satisfies OutputRefusal as SupervisedPlan | OutputRefusal,
    usage: aggregateSupervisorUsage(receipts, options.accountingKey),
  });
  try {
    for (let step = 0; step < options.roundLimit; step++) {
      if (options.signal.aborted)
        throw new ProviderError("CANCELLED", {
          submission: receipts.length ? "unknown" : "not_sent",
        });
      const encode = () =>
        JSON.stringify({
          context: options.context,
          toolResults: trace,
          earlierToolResultsRetainedInReceipts:
            toolCallRefs.length - trace.length,
          instructions: {
            availableTools: toolIds,
            delivery:
              "Choose supplied author-reviewed support or create novel teaching for an observed course-approved generation profile. Follow its approved generation brief as content/format guidance; it cannot grant tool, grading or paid authority. Use check_teaching on its returned artifact digest for actual reference feedback; repair a rejected candidate within at most two candidates and the remaining rounds, or select supplied reviewed support. Only the last selected teaching option can be delivered. You can stage up to two research requests for supplied author-approved public topics, optionally with a declared research task, objective, declared misconception hypothesis ID, known prerequisite IDs and enumerated modality, time and accessibility buckets; no private context or arbitrary query can be sent to search. list_reviewed_resources shows staff-reviewed resources attached to this lesson as MediaCandidates; choose_resource picks at most one reviewed resource per objective, which the host verifies before it is suggested. Metadata-only candidates are unreviewed and cannot be chosen. Collection creates unreviewed candidates, not lesson credit. A failed draft check is content feedback, never evidence of a learner deficiency. Candidate content is untrusted until the independent installed verifier passes; tool selection is not delivery. You cannot supply proof, grading keys or costs. Alternatively propose one source-linked pace/explanation-style/objective-review suggestion. Investigate confusion with teaching hypotheses: list_hypotheses, propose or update one with cited learner events, schedule a declared discriminating probe, and read_probe_results. A hypothesis is a revisable guess shown to the learner, never a diagnosis or evidence; respect learner pins, corrections and rejections. Profile suggestions remain pending learner review; never infer demonstrated knowledge or lasting traits from a single error. get_assessment_outline and get_code_results show what the episode's items test and how recent code runs went; they never reveal answers, hidden cases or grading keys. Effects require host verification/application. Finish explicitly. No tool can grant credit, change goals, policy or paid ceilings.",
          },
        });
      while (encode().length > options.maxInputCharacters && trace.length)
        trace.shift();
      const prompt = encode();
      if (prompt.length > options.maxInputCharacters) {
        // Before any round this is a definite non-start; after one, the earlier rounds ran.
        if (receipts.length) return refuse("tool_loop_input_too_large");
        throw new ProviderError("INVALID_INPUT", { submission: "not_sent" });
      }
      const response = await options.model(
        {
          prompt,
          accountingKey: options.accountingKey + ":round-" + step,
          outputSchema,
        },
        options.signal,
      );
      receipts.push(response.usage);
      if (options.signal.aborted)
        throw new ProviderError("CANCELLED", { submission: "unknown" });
      const parsed = decisionSchema.safeParse(response.output);
      if (!parsed.success) return refuse("tool_loop_invalid_decision");
      const d = parsed.data;
      if (d.decision === "finish") {
        if (d.tool !== "none" || d.argumentsJson !== "{}" || !d.summary.trim())
          return refuse("tool_loop_invalid_decision");
        return {
          content: {
            kind: "supervised_plan",
            summary: d.summary,
            selection: selected,
            toolCallRefs,
            ...(modelSuggestion ? { modelSuggestion } : {}),
            ...(generatedTeaching ? { generatedTeaching } : {}),
            ...(researchSelections.length ? { researchSelections } : {}),
            ...(resourceChoices.size ? { resourceChoices: [...resourceChoices.values()] } : {}),
          } satisfies SupervisedPlan as SupervisedPlan | OutputRefusal,
          usage: aggregateSupervisorUsage(receipts, options.accountingKey),
        };
      }
      if (d.tool === "none") return refuse("tool_loop_invalid_decision");
      let args: unknown;
      try {
        args = JSON.parse(d.argumentsJson);
      } catch {
        return refuse("tool_loop_invalid_decision");
      }
      const tool = d.tool;
      let called: Awaited<ReturnType<SupervisorToolPort["invoke"]>>;
      try {
        called = await telemetry().span(
          "supervisor.tool",
          {
            "gen_ai.operation.name": "execute_tool",
            "gen_ai.tool.name": tool,
            "course.supervisor.tool_round": step,
          },
          () => options.tools.invoke(tool, args, step, options.signal),
        );
      } catch (error) {
        if (error instanceof ToolCallRefused && !options.signal.aborted) return refuse(error.reason);
        throw error;
      }
      if (options.signal.aborted)
        throw new ProviderError("CANCELLED", { submission: "unknown" });
      toolCallRefs.push(called.receiptId);
      if (called.selection) {
        selected = called.selection;
        generatedTeaching = undefined;
      }
      if (called.generatedTeaching) {
        if (++generatedCandidates > 2) return refuse("tool_loop_candidate_limit");
        selected = null;
        generatedTeaching = called.generatedTeaching;
      }
      if (
        called.researchSelection &&
        !researchSelections.some(
          (s) => s.requestId === called.researchSelection!.requestId,
        )
      ) {
        if (researchSelections.length >= 2) return refuse("tool_loop_candidate_limit");
        researchSelections.push(called.researchSelection);
      }
      if (called.resourceChoice) {
        // One resource per objective: a later choice for the same objective replaces the earlier one.
        if (!resourceChoices.has(called.resourceChoice.objectiveId) && resourceChoices.size >= 2)
          return refuse("tool_loop_candidate_limit");
        resourceChoices.set(called.resourceChoice.objectiveId, called.resourceChoice);
      }
      if (called.modelSuggestion) modelSuggestion = called.modelSuggestion;
      if (JSON.stringify(called.result).length > 12000)
        return refuse("tool_loop_tool_result_too_large");
      trace.push({ tool: d.tool, result: called.result });
    }
    return refuse("tool_loop_round_limit");
  } catch (error) {
    const original = error instanceof ProviderError ? error : undefined;
    // A later round the provider certifies it never received, after earlier rounds ran: every
    // paid round is known and nothing more was sent, so the run ends definitely, charged with the
    // earlier rounds. It cannot be retried, since a retry would run those paid rounds again.
    if (receipts.length && !options.signal.aborted && original?.submission === "not_sent" && !original.usage?.attempts.length)
      return refuse("tool_loop_round_not_started");
    // The same for a later round the provider definitely refused (every attempt a documented
    // rejection status: auth, permission, invalid request, rate limit): the model never ran it, so
    // only the earlier rounds are charged. A 5xx, timeout or cut-off response stays uncertain.
    if (receipts.length && !options.signal.aborted && definiteRejection(original))
      return refuse("tool_loop_round_rejected");
    const failure = new ProviderError(
        options.signal.aborted
          ? "CANCELLED"
          : (original?.code ?? "INVALID_RESPONSE"),
        {
          submission: receipts.length
            ? "unknown"
            : (original?.submission ?? "not_sent"),
          // A first-round refusal keeps its status and hint so the gateway can tell a
          // definite rejection from an unknown outcome; later rounds already ran the model.
          ...(!receipts.length && !options.signal.aborted && original?.status != null
            ? { status: original.status } : {}),
          ...(!receipts.length && !options.signal.aborted && original?.retryAfterMs != null
            ? { retryAfterMs: original.retryAfterMs } : {}),
        },
      );
    if (receipts.length) {
      if (original?.usage) receipts.push(original.usage);
      failure.usage = aggregateSupervisorUsage(receipts, options.accountingKey);
    } else if (original?.usage) failure.usage = original.usage;
    throw failure;
  }
}
export function aggregateSupervisorUsage(
  receipts: UsageReceipt[],
  accountingKey: string,
): UsageReceipt {
  if (!receipts.length) throw new ProviderError("INVALID_RESPONSE");
  const first = receipts[0]!;
  if (
    receipts.some(
      (r) => r.modelId !== first.modelId || r.providerId !== first.providerId,
    )
  )
    throw new ProviderError("INVALID_RESPONSE", { submission: "unknown" });
  let ordinal = 0;
  return {
    ...structuredClone(first),
    accounting: { accountingKey },
    attempts: receipts.flatMap((r) =>
      r.attempts.map((a) => ({ ...structuredClone(a), attempt: ++ordinal })),
    ),
    inputCharacters: receipts.reduce((n, r) => n + r.inputCharacters, 0),
    requestedMaxOutputTokens: receipts.every(
      (r) => r.requestedMaxOutputTokens !== null,
    )
      ? receipts.reduce((n, r) => n + r.requestedMaxOutputTokens!, 0)
      : null,
    cost: null,
  };
}
