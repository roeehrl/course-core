/**
 * The fixed reasons Core writes into the personal changes it makes. A proposal keeps the English
 * sentence (it is part of the sealed, digested proposal), but learners and staff are shown the
 * code, which the apps translate. Free text a trusted pipeline wrote is sent as is.
 */
export const ADAPTATION_RATIONALES = {
  fresh_question: "Learner requested a fresh verified question within an existing canonical family.",
  staff_remedial_episode: "Course staff inserted an exact author-reviewed remedial episode.",
  supervisor_remedial_episode: "Supervisor inserted an exact author-reviewed remedial episode after learner opt-in.",
  supervisor_reviewed_explanation: "Supervisor selected an exact author-reviewed explanation after learner opt-in.",
  supervisor_generated_teaching:
    "Supervisor generated new teaching after learner opt-in; installed course reference checks verified its content.",
} as const;
export type AdaptationRationaleCode = keyof typeof ADAPTATION_RATIONALES;

const BY_TEXT = new Map<string, AdaptationRationaleCode>(
  Object.entries(ADAPTATION_RATIONALES).map(([code, text]) => [text, code as AdaptationRationaleCode]),
);

/** How a stored rationale is shown: a code for Core's own reasons (including rows written before
 * codes existed), otherwise the free text. */
export function rationaleView(rationale: unknown): { whyCode: AdaptationRationaleCode | null; why: string } {
  const text = typeof rationale === "string" ? rationale : "";
  const code = BY_TEXT.get(text.trim()) ?? null;
  return { whyCode: code, why: code ? "" : text };
}
