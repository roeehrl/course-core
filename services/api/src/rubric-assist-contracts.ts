import { z } from "zod";
import type { OutputSchema } from "@course-core/providers";

/** What a model may see for written-answer assistance: the author's question
 * and rubric, the answer text and, in a review conversation, its earlier turns
 * (the learner's earlier answers and the reviewer's questions). No learner
 * identity, history or profile. */
export interface RubricAssistInput {
  requestId: string;
  attemptId: string;
  prompt: string;
  criteria: { id: string; description: string; required: boolean }[];
  response: string;
  /** Earlier turns of the same review conversation, oldest first; empty for a first answer. */
  earlierTurns: { speaker: "learner" | "reviewer"; text: string }[];
  rubricDigest: string;
  responseDigest: string;
}

export const rubricAssistOutputSchema: OutputSchema = {
  type: "object",
  required: ["criteria", "summary"],
  properties: {
    summary: { type: "string" },
    criteria: {
      type: "array",
      minItems: 1,
      maxItems: 12,
      items: {
        type: "object",
        required: ["criterionId", "met", "quote", "note"],
        properties: { criterionId: { type: "string" }, met: { type: "boolean" }, quote: { type: "string" }, note: { type: "string" } },
      },
    },
  },
};

const finding = z.strictObject({
  criterionId: z.string().min(1).max(128),
  met: z.boolean(),
  quote: z.string().max(800),
  note: z.string().max(500),
});
/** A draft for a human reviewer. It is never a grade and never evidence. */
export const rubricSuggestionSchema = z.strictObject({
  kind: z.literal("rubric_suggestion"),
  requestId: z.string().uuid(),
  attemptId: z.string().uuid(),
  rubricDigest: z.string().regex(/^[a-f0-9]{64}$/),
  responseDigest: z.string().regex(/^[a-f0-9]{64}$/),
  summary: z.string().max(1000),
  criteria: z.array(finding).min(1).max(12),
});
export type RubricSuggestion = z.infer<typeof rubricSuggestionSchema>;

/** The learner's own words in the conversation: never the reviewer's questions. */
export const learnerWordsOf = (input: Pick<RubricAssistInput, "response"> & { earlierTurns?: RubricAssistInput["earlierTurns"] }) =>
  [...(input.earlierTurns ?? []).filter((t) => t.speaker === "learner").map((t) => t.text), input.response];

/** Deterministic host checks: every criterion exactly once, and every "met"
 * finding quotes the learner's own words verbatim (at least 10 characters),
 * from any of their turns. A summary or a judgment without a quote is not evidence. */
export function rubricSuggestionProblems(suggestion: Pick<RubricSuggestion, "criteria">, input: Pick<RubricAssistInput, "criteria" | "response"> & { earlierTurns?: RubricAssistInput["earlierTurns"] }) {
  const problems: string[] = [], words = learnerWordsOf(input);
  const ids = suggestion.criteria.map((c) => c.criterionId);
  if (ids.length !== input.criteria.length || input.criteria.some((c) => ids.filter((id) => id === c.id).length !== 1)) problems.push("criteria_mismatch");
  for (const c of suggestion.criteria)
    if (c.met && (c.quote.trim().length < 10 || !words.some((w) => w.includes(c.quote)))) problems.push("quote_not_in_answer:" + c.criterionId);
  return problems;
}
