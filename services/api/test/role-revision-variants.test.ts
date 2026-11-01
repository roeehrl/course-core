import { describe, expect, it } from "vitest";
import { BUILT_IN_STRATEGIES, StrategyRegistry, companionStrategy, defineRuntimeStrategy } from "../src/agent-strategies.js";
import { roleRevisions } from "../src/agent-evals/revision.js";
import { scriptedConfiguration } from "../src/agent-evals/scripted-model.js";

// The companion asks its model in several prompt modes (agent-strategies.ts companionInstruction):
// the check-coaching rule and the Hebrew rule are added from the context, and the reply style comes
// from the binding. A change to any mode's text must be a new revision, or earlier quality checks
// would stay valid for a prompt they never saw. Stubs only: the probe's router records the request
// and stops, so no provider is contacted.

interface Request { systemInstruction: string; messages: { role: string; text: string }[] }
const base = scriptedConfiguration("reference", "all");
type Configuration = typeof base;

/** The built-in companion with one edit applied to every request it sends; `applied` counts the requests the edit changed. */
function edited(edit: (request: Request) => Request) {
  const seen = { applied: 0, requests: 0 };
  const strategy = defineRuntimeStrategy({ ...companionStrategy, async run(input) {
    const tutor = (request: Request, ...rest: unknown[]) => {
      const next = edit(request);
      seen.requests += 1;
      if (JSON.stringify(next) !== JSON.stringify(request)) seen.applied += 1;
      return (input.router.tutor as (...a: unknown[]) => unknown)(next, ...rest);
    };
    return companionStrategy.run({ ...input, router: new Proxy(input.router, { get: (t, p) => (p === "tutor" ? tutor : Reflect.get(t, p)) }) });
  } });
  return { seen, registry: new StrategyRegistry([strategy, ...BUILT_IN_STRATEGIES.filter((s) => s !== companionStrategy)]) };
}
/** Rewords one fixed phrase of the system instruction, as an edit of that rule's text in Core's code would. */
const rewordInstruction = (phrase: string) => edited((request) => {
  if (!request.systemInstruction.includes(phrase)) return request;
  return { ...request, systemInstruction: request.systemInstruction.replace(phrase, `${phrase} (reworded)`) };
});
const revisions = (configuration: Configuration, strategies?: StrategyRegistry) => roleRevisions(configuration, strategies);
const detailed: Configuration = { ...base, roles: { ...base.roles, companion: { ...base.roles.companion, replyStyle: "detailed" } } } as Configuration;

describe("companion revision digests cover every prompt mode", () => {
  it("probe the plain, check-coaching (matched and uncertain) and Hebrew requests", async () => {
    const instructions: string[] = [], messages: string[] = [];
    const { registry } = edited((request) => { instructions.push(request.systemInstruction); messages.push(request.messages[0]!.text); return request; });
    expect((await revisions(base, registry)).companion).toMatchObject({ strategy: "core.companion.tutor", probed: true });
    expect(instructions).toHaveLength(4);
    expect(instructions.filter((text) => text.includes("Check coaching:"))).toHaveLength(2);
    expect(instructions.filter((text) => text.includes("Hebrew replies:"))).toHaveLength(1);
    // The uncertain match is told so in its own note.
    expect(messages.filter((text) => text.includes("which one is not certain"))).toHaveLength(1);
  });

  for (const [mode, phrase] of [["check coaching", "Check coaching:"], ["Hebrew", "Hebrew replies:"]] as const) {
    it(`change when only the ${mode} rule's text changes`, async () => {
      const original = await revisions(base), { seen, registry } = rewordInstruction(phrase);
      const changed = await revisions(base, registry);
      // The plain probe never sees the rule, so a digest of the plain request alone would not change.
      expect(seen.applied).toBeGreaterThan(0);
      expect(seen.applied).toBeLessThan(seen.requests);
      expect(changed.companion!.digest).not.toBe(original.companion!.digest);
      // The same edit under a detailed binding is a new revision too.
      expect((await revisions(detailed, registry)).companion!.digest).not.toBe((await revisions(detailed)).companion!.digest);
      // No other role's revision moves.
      for (const role of ["supervisor", "research", "media", "reviewer"] as const) expect(changed[role]!.digest).toBe(original[role]!.digest);
    });
  }

  it("change when the uncertain-match note the model is shown changes", async () => {
    const { seen, registry } = edited((request) => ({ ...request, messages: request.messages.map((m) => ({ ...m, text: m.text.replace("which one is not certain", "which one is unclear") })) }));
    const changed = await revisions(base, registry);
    expect(seen.applied).toBe(1);
    expect(changed.companion!.digest).not.toBe((await revisions(base)).companion!.digest);
  });

  it("follow the binding's reply style: the concise rule counts only for a concise binding", async () => {
    expect((await revisions(detailed)).companion!.digest).not.toBe((await revisions(base)).companion!.digest);
    const { seen, registry } = rewordInstruction("Keep replies short and plain");
    expect((await revisions(base, registry)).companion!.digest).not.toBe((await revisions(base)).companion!.digest);
    // Every concise mode carries the rule.
    expect(seen.applied).toBe(seen.requests);
    // A detailed binding is never asked with it, so its revision is the same.
    expect((await revisions(detailed, registry)).companion!.digest).toBe((await revisions(detailed)).companion!.digest);
  });

  it("stay stable when nothing changes", async () => {
    const { registry } = edited((request) => request);
    expect((await revisions(base, registry)).companion!.digest).toBe((await revisions(structuredClone(base))).companion!.digest);
  });
});
