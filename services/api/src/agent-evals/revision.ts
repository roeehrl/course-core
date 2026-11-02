import type { ProviderRouter } from "@course-core/providers";
import { AGENT_ROLES, builtInStrategies, type AgentRole, type RoleBinding, type RuntimeStrategy, type StrategyRegistry, type TeachingContext } from "../agent-strategies.js";
import { checkCoachingView, type GradedCheck } from "../companion-check-integrity.js";
import { ANSWER_GUARD_VERSION, type CompanionAnswerGuard } from "../companion-answer-guard.js";
import { canonicalJson, sha256 } from "./suite.js";

/**
 * The revision of one role: everything that decides what the role's model is asked and who
 * answers it. Two configurations with equal digests for a role run that role identically:
 * the binding and its limits, the model registry entry, the adapter kind, the strategy
 * contract and the request the strategy assembles for a fixed probe context, in each prompt mode
 * the role has (PROBE_VARIANTS), so a prompt change in Core's code, in any mode, is a new
 * revision. Credentials are not part of it: rotating a key
 * does not change what is evaluated.
 */
export interface RoleRevision {
  role: AgentRole;
  strategy: string | null;
  digest: string;
  /** Whether the probe captured the assembled request (false for strategies that need tools or special inputs). */
  probed: boolean;
}
export interface ConfigurationShape {
  registry: unknown;
  adapters: { id: string; kind: string; subscriptionRef?: string | undefined }[];
  /** Validated role bindings (provider-composition.ts). */
  roles: unknown;
}

/** A fixed, public, learner-free context. Changing it changes every digest, so it is versioned. */
const PROBE_VERSION = "core.role-revision-probe/1";
const PROBE: TeachingContext = {
  course: { title: "Revision probe", digest: "revision-probe" },
  episode: { id: "probe-episode", title: "Probe", teaching: "Probe teaching text.", objectives: [{ id: "probe-objective", description: "Probe objective." }] },
  learner: { profile: {}, recentHistory: [{ role: "learner", content: "Probe question?" }], recentAttempts: [] },
  question: "Probe question?",
  constraints: { deadline: null, expansionAllowed: false, independentAssessmentActive: false },
};
/** Role inputs some strategies need before they build a request (v2: research, reviewer and the
 * tool loop are probed too, so a prompt change in any of them is a new revision). */
const PROBE_INPUTS: Partial<Record<AgentRole, Partial<TeachingContext>>> = {
  research: { publicResearchTopic: "Probe public topic", publicResearchScope: { requestId: "00000000-0000-4000-8000-000000000000", topicId: "probe-topic", queryDigest: "0".repeat(64) } },
  reviewer: { rubricReview: { requestId: "00000000-0000-4000-8000-000000000000", attemptId: "00000000-0000-4000-8000-000000000001", prompt: "Probe question?",
    criteria: [{ id: "probe-criterion", description: "Probe criterion.", required: true }], response: "Probe answer text.", earlierTurns: [],
    rubricDigest: "0".repeat(64), responseDigest: "0".repeat(64) } },
};
/** A fixed course check the check-coaching probes match, with options so a choice item's shaping shows. */
const PROBE_CHECK: GradedCheck = { id: "probe-check", type: "multiple_choice", prompt: "Probe check question?", options: ["Probe option one", "Probe option two"], steps: [], keys: [] };
/**
 * Prompt modes a strategy switches on from its context, each probed beside the plain request so a
 * change to any mode's text is a new revision. The companion adds the check-coaching rule when the
 * learner's message is about a graded check (a matched check, and one that is not certain, which
 * has its own note) and the Hebrew rule when the question is in Hebrew. Its reply style (`replyStyle`,
 * concise or detailed) comes from the binding, so the plain request already has the style that binding
 * is asked in. The pacing rule's strictest mode (`pacingClose`) is probed too. Only roles listed here get a
 * `variants` entry, so every other role keeps its digest.
 * v2 adds the answer guard's regeneration (GUARDED_VARIANTS).
 */
const PROBE_VARIANTS_VERSION = "core.role-revision-variants/2";
const PROBE_VARIANTS: Partial<Record<AgentRole, Record<string, Partial<TeachingContext>>>> = {
  companion: {
    checkCoaching: { checkCoaching: checkCoachingView([{ check: PROBE_CHECK, how: "quoted", score: 1 }])! },
    checkCoachingUnresolved: { checkCoaching: checkCoachingView([{ check: PROBE_CHECK, how: "unresolved", score: 1 }])! },
    hebrew: { question: "מה ההבדל בין שני המושגים בשיעור?" },
    // A `close` turn (companion-pacing.ts): three replies in a row asked the learner something.
    pacingClose: { learner: { profile: {}, recentAttempts: [], recentHistory: [1, 2, 3].flatMap((n) => [
      { role: "learner", content: `Probe answer ${n}.` }, { role: "assistant", content: `Probe reply ${n}. Probe question ${n}?` }]) }, question: "Probe answer 4." },
  },
};
/**
 * Modes the companion enters after its model answered (v2): the answer guard
 * (companion-answer-guard.ts) writes a draft that revealed a check's answer again once, with its
 * corrective note. The probe's guard finds every draft leaking, so the request captured is the
 * regeneration's; the guard's version stands for its rule and fallback.
 */
const GUARDED_VARIANTS: Partial<Record<AgentRole, Record<string, Partial<TeachingContext>>>> = {
  companion: { checkCoachingRegeneration: { checkCoaching: checkCoachingView([{ check: PROBE_CHECK, how: "quoted", score: 1 }])! } },
};
const PROBE_GUARD: CompanionAnswerGuard = { leak: () => ({ reason: "check_answer_stated", checkId: PROBE_CHECK.id }), admitRegeneration: () => true, fallback: "Probe fallback." };
const PROBE_DRAFT_USAGE = { accounting: { accountingKey: "revision-probe" }, providerId: "revision-probe", modelId: "revision-probe", operation: "tutor", attempts: [],
  inputCharacters: 0, requestedMaxOutputTokens: null, requestedVideoSeconds: null, observedImageCount: null, observedVideoCount: null, cost: null };
class Captured extends Error {}
/** Runs the strategy against a router that records the first request and stops. Nothing is sent.
 * `guarded`: the first tutor request is answered with a probe draft that the probe's answer guard
 * rejects, and the regeneration's request is recorded instead. */
async function probe(strategy: RuntimeStrategy, role: AgentRole, binding: RoleBinding, variant: Partial<TeachingContext> = {}, guarded = false): Promise<unknown> {
  let captured: unknown = null, drafts = 0;
  const capture = (operation: string) => async (request: Record<string, unknown>) => {
    if (guarded && operation === "tutor" && drafts++ === 0) return { output: { text: "Probe draft." }, usage: structuredClone(PROBE_DRAFT_USAGE) };
    const { accounting: _accounting, ...rest } = request;
    captured = { operation, ...rest };
    throw new Captured();
  };
  const router = { tutor: capture("tutor"), assess: capture("assess"), research: capture("research"), startImage: capture("startImage"), startVideo: capture("startVideo") } as unknown as ProviderRouter;
  try {
    // A tool loop's first model request comes before any tool call; the probe's tools never answer.
    const tools = { invoke: async () => { throw new Captured(); } };
    await strategy.run({ role, binding, context: { ...structuredClone(PROBE), ...structuredClone(PROBE_INPUTS[role] ?? {}), ...structuredClone(variant) }, accountingKey: "revision-probe",
      signal: new AbortController().signal, router, tools, ...(guarded ? { answerGuard: PROBE_GUARD } : {}) });
  } catch (error) {
    // The answer guard reports an interrupted regeneration as its own failure; the request was recorded all the same.
    if (!(error instanceof Captured) && !(guarded && captured !== null)) return null;
  }
  return captured;
}

/** The request the strategy assembles in each prompt mode of the role (PROBE_VARIANTS, then
 * GUARDED_VARIANTS with the answer guard's version), by mode name. */
async function probeVariants(strategy: RuntimeStrategy, role: AgentRole, binding: RoleBinding, variants: Record<string, Partial<TeachingContext>>) {
  const requests: Record<string, unknown> = {}, guarded = GUARDED_VARIANTS[role];
  for (const [name, variant] of Object.entries(variants)) requests[name] = await probe(strategy, role, binding, variant);
  for (const [name, variant] of Object.entries(guarded ?? {})) requests[name] = await probe(strategy, role, binding, variant, true);
  return { probe: PROBE_VARIANTS_VERSION, requests, ...(guarded ? { answerGuard: ANSWER_GUARD_VERSION } : {}) };
}

async function imageCompanion(picture: NonNullable<RoleBinding["imageModel"]>, configuration: ConfigurationShape,
  models: { id: string; providerId: string }[], strategies: StrategyRegistry) {
  const binding: RoleBinding = { modelId: picture.modelId, maxInputCharacters: picture.maxInputCharacters, maxOutputTokens: picture.maxOutputTokens, mediaKind: "image",
    ...(picture.image ? { image: picture.image } : {}) };
  const strategy = strategies.select("media", binding) ?? null, model = models.find((m) => m.id === picture.modelId) ?? null;
  const adapter = configuration.adapters.find((a) => a.id === model?.providerId);
  return { model, adapter: adapter ? { id: adapter.id, kind: adapter.kind, subscriptionRef: adapter.subscriptionRef ?? null } : null,
    strategy: strategy ? { id: strategy.contract.id, version: strategy.contract.version } : null, prompt: strategy ? await probe(strategy, "media", binding) : null };
}
/**
 * The revision of one role run by one strategy under a configuration's binding, or undefined when
 * the role is not bound. A course-declared strategy (course-strategies.ts) also folds in the digest
 * of its whole declaration, so a course release that changes its narrowing is a new revision; Core's
 * own strategies keep the digest they always had, so recorded evidence stays valid.
 */
export async function strategyRevision(configuration: ConfigurationShape, role: AgentRole, strategy: RuntimeStrategy | null,
  source: "core" | "course" = "core", strategies: StrategyRegistry = builtInStrategies()): Promise<RoleRevision | undefined> {
  const binding = (configuration.roles as Partial<Record<AgentRole, RoleBinding>>)[role];
  if (!binding) return undefined;
  const models = ((configuration.registry as { models?: { id: string; providerId: string }[] } | null)?.models ?? []);
  const model = models.find((m) => m.id === binding.modelId) ?? null;
  const adapter = configuration.adapters.find((a) => a.id === model?.providerId);
  const prompt = strategy ? await probe(strategy, role, binding) : null;
  const variants = strategy && PROBE_VARIANTS[role] ? await probeVariants(strategy, role, binding, PROBE_VARIANTS[role]) : undefined;
  // An image model bound beside a video model is part of the media role's revision: its registry
  // entry, adapter, strategy and assembled request. Absent for every other binding, so their digests are unchanged.
  const pictures = binding.imageModel ? await imageCompanion(binding.imageModel, configuration, models, strategies) : undefined;
  return {
    role, strategy: strategy?.contract.id ?? null, probed: prompt !== null,
    digest: sha256(canonicalJson({
      schema: "course-core.role-revision/v1", probe: PROBE_VERSION, role, binding, model,
      adapter: adapter ? { id: adapter.id, kind: adapter.kind, subscriptionRef: adapter.subscriptionRef ?? null } : null,
      strategy: strategy ? { id: strategy.contract.id, version: strategy.contract.version,
        ...(source === "course" ? { source: "course", declaration: sha256(canonicalJson(strategy.contract)) } : {}) } : null, prompt,
      ...(variants ? { variants } : {}),
      ...(pictures ? { imageModel: pictures } : {}),
    })),
  };
}
/** Revision digests of every bound role. The configuration must already be validated. */
export async function roleRevisions(configuration: ConfigurationShape, strategies: StrategyRegistry = builtInStrategies()) {
  const result: Partial<Record<AgentRole, RoleRevision>> = {};
  for (const role of AGENT_ROLES) {
    const binding = (configuration.roles as Partial<Record<AgentRole, RoleBinding>>)[role];
    if (!binding) continue;
    const revision = await strategyRevision(configuration, role, strategies.select(role, binding) ?? null, "core", strategies);
    if (revision) result[role] = revision;
  }
  return result;
}
