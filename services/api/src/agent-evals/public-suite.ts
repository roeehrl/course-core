import manifest from "./public/suite.json" with { type: "json" };
import d0 from "./public/dialogues/companion.adversarial.prompt-injection.json" with { type: "json" };
import d1 from "./public/dialogues/companion.expert.distance-change-travel.json" with { type: "json" };
import d2 from "./public/dialogues/companion.frustrated.total-travel.json" with { type: "json" };
import d3 from "./public/dialogues/companion.guessing.observation-choice.json" with { type: "json" };
import d4 from "./public/dialogues/companion.inconsistent.time-greetings.json" with { type: "json" };
import d5 from "./public/dialogues/companion.novice.fair-comparison.json" with { type: "json" };
import d6 from "./public/dialogues/companion.novice.signed-order.json" with { type: "json" };
import d7 from "./public/dialogues/companion.terse.endpoint-answer.json" with { type: "json" };
import d8 from "./public/dialogues/companion.uncertain.unit-conversion.json" with { type: "json" };
import d9 from "./public/dialogues/supervisor.adversarial.history-injection.json" with { type: "json" };
import d10 from "./public/dialogues/supervisor.inconsistent.mixed-evidence.json" with { type: "json" };
import d11 from "./public/dialogues/supervisor.novice.single-error.json" with { type: "json" };
import d12 from "./public/dialogues/supervisor.tool-loop.adversarial.history-injection.json" with { type: "json" };
import d13 from "./public/dialogues/supervisor.tool-loop.novice.single-error.json" with { type: "json" };
import d14 from "./public/dialogues/research.novice.approved-topic.json" with { type: "json" };
import d15 from "./public/dialogues/reviewer.adversarial.grade-injection.json" with { type: "json" };
import d16 from "./public/dialogues/media.image.lesson-only-prompt.json" with { type: "json" };
import d17 from "./public/dialogues/media.video.lesson-only-prompt.json" with { type: "json" };
import d18 from "./public/dialogues/companion.adversarial.pasted-check-number.json" with { type: "json" };
import d19 from "./public/dialogues/companion.adversarial.pasted-check-hebrew.json" with { type: "json" };
import d20 from "./public/dialogues/companion.guessing.check-elimination.json" with { type: "json" };
import d21 from "./public/dialogues/companion.uncertain.check-confirmation.json" with { type: "json" };
import d22 from "./public/dialogues/companion.guessing.check-hint-option.json" with { type: "json" };
import d23 from "./public/dialogues/companion.guessing.check-hint-option-hebrew.json" with { type: "json" };
import d24 from "./public/dialogues/companion.guessing.check-elimination-hebrew.json" with { type: "json" };
import d25 from "./public/dialogues/companion.novice.after-pasted-check.json" with { type: "json" };
import d26 from "./public/dialogues/companion.novice.check-lesson-number.json" with { type: "json" };
import reference from "./public/scripted/reference.json" with { type: "json" };
import knownBad from "./public/scripted/known-bad.json" with { type: "json" };
import overTriggering from "./public/scripted/over-triggering.json" with { type: "json" };
import { z } from "zod";
import { buildSuite, type EvalSuite } from "./suite.js";
import { scriptedAnswerSchema, type ScriptedAnswer } from "./scripted-model.js";

/**
 * Core's public suite: curated dialogues over the public example course packs
 * (examples/courses/packs). The same files are in `public/` in the documented directory layout;
 * a test checks that this list and that directory build the same digest.
 */
const DIALOGUES: readonly unknown[] = [d0, d1, d2, d3, d4, d5, d6, d7, d8, d9, d10, d11, d12, d13, d14, d15, d16, d17, d18, d19, d20, d21, d22, d23, d24, d25, d26];
let cached: EvalSuite | undefined;
export function publicSuite(): EvalSuite {
  return (cached ??= buildSuite(manifest.id, manifest.version, DIALOGUES));
}

export const scriptedOutputsSchema = z.record(z.string().max(120), scriptedAnswerSchema);
/**
 * Scripted model answers for the public suite. `reference` is written to pass every grader;
 * `known-bad` leaks answers, labels the learner, invents references and obeys injected
 * instructions, so the graders must fail it. `over-triggering` answers as the reference does but
 * refuses ordinary questions as if they were graded checks (the live finding after a pasted check),
 * so the check-mode grader must fail it. None says anything about a real model.
 */
export const PUBLIC_SCRIPTED_MODELS: Readonly<Record<"reference" | "known-bad" | "over-triggering", Record<string, ScriptedAnswer>>> = Object.freeze({
  reference: scriptedOutputsSchema.parse(reference),
  "known-bad": scriptedOutputsSchema.parse(knownBad),
  "over-triggering": scriptedOutputsSchema.parse({ ...reference, ...overTriggering }),
});
