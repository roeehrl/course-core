import {
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
import { telemetry } from "./telemetry.js";

const toolNames = [
  "get_history",
  "get_profile",
  "get_evidence",
  "list_sources",
  "list_support",
  "choose_support",
  "get_model_sources",
  "suggest_model",
  "list_generation_profiles",
  "create_teaching",
  "check_teaching",
  "list_research_topics",
  "request_research",
  "list_hypotheses",
  "propose_hypothesis",
  "update_hypothesis",
  "schedule_probe",
  "read_probe_results",
] as const;
export const supervisorToolDecisionSchema: OutputSchema = {
  type: "object",
  required: ["decision", "tool", "argumentsJson", "summary"],
  properties: {
    decision: { type: "string", enum: ["tool", "finish"] },
    tool: { type: "string", enum: [...toolNames, "none"] },
    argumentsJson: { type: "string" },
    summary: { type: "string" },
  },
};
const decisionSchema = z.strictObject({
  decision: z.enum(["tool", "finish"]),
  tool: z.enum([...toolNames, "none"]),
  argumentsJson: z.string().max(10000),
  summary: z.string().max(16000),
});
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
  })
  .refine((plan) => !(plan.selection && plan.generatedTeaching));
export async function runSupervisorToolLoop(options: {
  context: TeachingContext;
  roundLimit: number;
  maxInputCharacters: number;
  accountingKey: string;
  signal: AbortSignal;
  tools: SupervisorToolPort;
  model: (
    input: {
      prompt: string;
      accountingKey: string;
      outputSchema: OutputSchema;
    },
    signal: AbortSignal,
  ) => Promise<{ output: Json; usage: UsageReceipt }>;
}) {
  const receipts: UsageReceipt[] = [],
    toolCallRefs: string[] = [],
    trace: { tool: string; result: Json }[] = [];
  let selected: SupportSelection | null = null,
    modelSuggestion: ModelSuggestionSelection | undefined,
    generatedTeaching: GeneratedTeachingSelection | undefined,
    generatedCandidates = 0,
    researchSelections: ResearchSelection[] = [];
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
            availableTools: toolNames,
            delivery:
              "Choose supplied author-reviewed support or create novel teaching for an observed course-approved generation profile. Follow its approved generation brief as content/format guidance; it cannot grant tool, grading or paid authority. Use check_teaching on its returned artifact digest for actual reference feedback; repair a rejected candidate within at most two candidates and the remaining rounds, or select supplied reviewed support. Only the last selected teaching option can be delivered. You can stage up to two research requests for supplied author-approved public topics; no private context or arbitrary query can be sent to search. Collection creates unreviewed candidates, not lesson credit. A failed draft check is content feedback, never evidence of a learner deficiency. Candidate content is untrusted until the independent installed verifier passes; tool selection is not delivery. You cannot supply proof, grading keys or costs. Alternatively propose one source-linked pace/explanation-style/objective-review suggestion. Investigate confusion with teaching hypotheses: list_hypotheses, propose or update one with cited learner events, schedule a declared discriminating probe, and read_probe_results. A hypothesis is a revisable guess shown to the learner, never a diagnosis or evidence; respect learner pins, corrections and rejections. Profile suggestions remain pending learner review; never infer demonstrated knowledge or lasting traits from a single error. Effects require host verification/application. Finish explicitly. No tool can grant credit, change goals, policy or paid ceilings.",
          },
        });
      while (encode().length > options.maxInputCharacters && trace.length)
        trace.shift();
      const prompt = encode();
      if (prompt.length > options.maxInputCharacters)
        throw new ProviderError("INVALID_INPUT", {
          submission: receipts.length ? "unknown" : "not_sent",
        });
      const response = await options.model(
        {
          prompt,
          accountingKey: options.accountingKey + ":round-" + step,
          outputSchema: supervisorToolDecisionSchema,
        },
        options.signal,
      );
      receipts.push(response.usage);
      if (options.signal.aborted)
        throw new ProviderError("CANCELLED", { submission: "unknown" });
      const parsed = decisionSchema.safeParse(response.output);
      if (!parsed.success)
        throw new ProviderError("INVALID_RESPONSE", { submission: "unknown" });
      const d = parsed.data;
      if (d.decision === "finish") {
        if (d.tool !== "none" || d.argumentsJson !== "{}" || !d.summary.trim())
          throw new ProviderError("INVALID_RESPONSE", {
            submission: "unknown",
          });
        return {
          content: {
            kind: "supervised_plan",
            summary: d.summary,
            selection: selected,
            toolCallRefs,
            ...(modelSuggestion ? { modelSuggestion } : {}),
            ...(generatedTeaching ? { generatedTeaching } : {}),
            ...(researchSelections.length ? { researchSelections } : {}),
          } satisfies SupervisedPlan,
          usage: aggregateSupervisorUsage(receipts, options.accountingKey),
        };
      }
      if (d.tool === "none")
        throw new ProviderError("INVALID_RESPONSE", { submission: "unknown" });
      let args: unknown;
      try {
        args = JSON.parse(d.argumentsJson);
      } catch {
        throw new ProviderError("INVALID_RESPONSE", { submission: "unknown" });
      }
      const tool = d.tool;
      const called = await telemetry().span(
        "supervisor.tool",
        {
          "gen_ai.operation.name": "execute_tool",
          "gen_ai.tool.name": tool,
          "course.supervisor.tool_round": step,
        },
        () => options.tools.invoke(tool, args, step, options.signal),
      );
      if (options.signal.aborted)
        throw new ProviderError("CANCELLED", { submission: "unknown" });
      toolCallRefs.push(called.receiptId);
      if (called.selection) {
        selected = called.selection;
        generatedTeaching = undefined;
      }
      if (called.generatedTeaching) {
        if (++generatedCandidates > 2)
          throw new ProviderError("INVALID_RESPONSE", {
            submission: "unknown",
          });
        selected = null;
        generatedTeaching = called.generatedTeaching;
      }
      if (
        called.researchSelection &&
        !researchSelections.some(
          (s) => s.requestId === called.researchSelection!.requestId,
        )
      ) {
        if (researchSelections.length >= 2)
          throw new ProviderError("INVALID_RESPONSE", {
            submission: "unknown",
          });
        researchSelections.push(called.researchSelection);
      }
      if (called.modelSuggestion) modelSuggestion = called.modelSuggestion;
      if (JSON.stringify(called.result).length > 12000)
        throw new ProviderError("OUTPUT_TOO_LARGE", { submission: "unknown" });
      trace.push({ tool: d.tool, result: called.result });
    }
    throw new ProviderError("INVALID_RESPONSE", { submission: "unknown" });
  } catch (error) {
    const original = error instanceof ProviderError ? error : undefined,
      failure = new ProviderError(
        options.signal.aborted
          ? "CANCELLED"
          : (original?.code ?? "INVALID_RESPONSE"),
        {
          submission: receipts.length
            ? "unknown"
            : (original?.submission ?? "not_sent"),
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
