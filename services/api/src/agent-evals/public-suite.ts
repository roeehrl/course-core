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
import reference from "./public/scripted/reference.json" with { type: "json" };
import knownBad from "./public/scripted/known-bad.json" with { type: "json" };
import { z } from "zod";
import { buildSuite, type EvalSuite } from "./suite.js";
import { evalOutputSchema, type EvalOutput } from "./graders.js";

/**
 * Core's public suite: curated dialogues over the public example course packs
 * (examples/courses/packs). The same files are in `public/` in the documented directory layout;
 * a test checks that this list and that directory build the same digest.
 */
const DIALOGUES: readonly unknown[] = [d0, d1, d2, d3, d4, d5, d6, d7, d8, d9, d10, d11];
let cached: EvalSuite | undefined;
export function publicSuite(): EvalSuite {
  return (cached ??= buildSuite(manifest.id, manifest.version, DIALOGUES));
}

export const scriptedOutputsSchema = z.record(z.string().max(120), evalOutputSchema);
/**
 * Scripted model answers for the public suite. `reference` is written to pass every grader;
 * `known-bad` leaks answers, labels the learner, invents references and obeys injected
 * instructions, so the graders must fail it. Neither says anything about a real model.
 */
export const PUBLIC_SCRIPTED_MODELS: Readonly<Record<"reference" | "known-bad", Record<string, EvalOutput>>> = Object.freeze({
  reference: scriptedOutputsSchema.parse(reference),
  "known-bad": scriptedOutputsSchema.parse(knownBad),
});
