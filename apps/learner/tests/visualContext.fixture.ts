import { toVisualExperience, type Scene } from "@course-core/visuals/headless";

/** Public, domain-neutral fixture used by actual component/browser callbacks. */
export function visualContextFixture() {
  const scene: Scene = {
    version: 1, id: "context-study", title: "A measured change",
    description: "Adjust the amount, choose a rule, and move through time.",
    state: {
      amount: { kind: "number", label: "Amount", initial: 2, min: 0, max: 10, step: 0.5 },
      enabled: { kind: "boolean", label: "Show result", initial: true },
      mode: { kind: "enum", label: "Rule", initial: "linear", options: ["linear", "square"] },
    },
    controls: ["amount", "enabled", "mode"],
    nodes: [
      { kind: "rect", id: "meter", x: 10, y: 20, width: { op: "mul", args: [{ state: "amount" }, 15] }, height: 24, fill: "#087665" },
      { kind: "text", id: "result", x: 15, y: 100, visible: { state: "enabled" }, fontSize: 20, fill: "#19383E", text: { op: "concat", args: ["Value = ", { op: "if", args: [{ op: "eq", args: [{ state: "mode" }, "square"] }, { op: "mul", args: [{ state: "amount" }, { state: "amount" }] }, { state: "amount" }] }] } },
    ],
    layouts: { compact: { width: 320, height: 160 }, expanded: { width: 480, height: 160 }, breakpoint: 500 },
    timeline: { durationMs: 1000, tracks: [{ node: "meter", property: "x", keyframes: [{ atMs: 0, value: 10 }, { atMs: 1000, value: 110 }] }], cues: [{ atMs: 0, text: "Observe the starting value." }, { atMs: 500, text: "Explore the second half." }] },
    accessibility: { text: "The amount is transformed by either a linear or square rule. Movement encodes timeline position, not credit.", reducedMotion: { atMs: 750, description: "Read the current amount and the transformed value at a still frame." } },
    referenceChecks: [],
  };
  return toVisualExperience(scene);
}
