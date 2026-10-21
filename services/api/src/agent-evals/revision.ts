import type { ProviderRouter } from "@course-core/providers";
import { AGENT_ROLES, builtInStrategies, type AgentRole, type RoleBinding, type RuntimeStrategy, type StrategyRegistry, type TeachingContext } from "../agent-strategies.js";
import { canonicalJson, sha256 } from "./suite.js";

/**
 * The revision of one role: everything that decides what the role's model is asked and who
 * answers it. Two configurations with equal digests for a role run that role identically:
 * the binding and its limits, the model registry entry, the adapter kind, the strategy
 * contract and the request the strategy assembles for a fixed probe context (so a prompt
 * change in Core's code is a new revision). Credentials are not part of it: rotating a key
 * does not change what is evaluated.
 */
export interface RoleRevision {
  role: AgentRole;
  strategy: string | null;
  digest: string;
  /** Whether the probe captured the assembled request (false for strategies that need tools or special inputs). */
  probed: boolean;
}
interface ConfigurationShape {
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
class Captured extends Error {}
/** Runs the strategy against a router that records the first request and stops. Nothing is sent. */
async function probe(strategy: RuntimeStrategy, role: AgentRole, binding: RoleBinding): Promise<unknown> {
  let captured: unknown = null;
  const capture = (operation: string) => async (request: Record<string, unknown>) => {
    const { accounting: _accounting, ...rest } = request;
    captured = { operation, ...rest };
    throw new Captured();
  };
  const router = { tutor: capture("tutor"), assess: capture("assess"), research: capture("research"), startImage: capture("startImage"), startVideo: capture("startVideo") } as unknown as ProviderRouter;
  try {
    // A tool loop's first model request comes before any tool call; the probe's tools never answer.
    const tools = { invoke: async () => { throw new Captured(); } };
    await strategy.run({ role, binding, context: { ...structuredClone(PROBE), ...structuredClone(PROBE_INPUTS[role] ?? {}) }, accountingKey: "revision-probe",
      signal: new AbortController().signal, router, tools });
  } catch (error) {
    if (!(error instanceof Captured)) return null;
  }
  return captured;
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
/** Revision digests of every bound role. The configuration must already be validated. */
export async function roleRevisions(configuration: ConfigurationShape, strategies: StrategyRegistry = builtInStrategies()) {
  const models = ((configuration.registry as { models?: { id: string; providerId: string }[] } | null)?.models ?? []);
  const result: Partial<Record<AgentRole, RoleRevision>> = {};
  for (const role of AGENT_ROLES) {
    const binding = (configuration.roles as Partial<Record<AgentRole, RoleBinding>>)[role];
    if (!binding) continue;
    const strategy = strategies.select(role, binding) ?? null;
    const model = models.find((m) => m.id === binding.modelId) ?? null;
    const adapter = configuration.adapters.find((a) => a.id === model?.providerId);
    const prompt = strategy ? await probe(strategy, role, binding) : null;
    // An image model bound beside a video model is part of the media role's revision: its registry
    // entry, adapter, strategy and assembled request. Absent for every other binding, so their digests are unchanged.
    const pictures = binding.imageModel ? await imageCompanion(binding.imageModel, configuration, models, strategies) : undefined;
    result[role] = {
      role, strategy: strategy?.contract.id ?? null, probed: prompt !== null,
      digest: sha256(canonicalJson({
        schema: "course-core.role-revision/v1", probe: PROBE_VERSION, role, binding, model,
        adapter: adapter ? { id: adapter.id, kind: adapter.kind, subscriptionRef: adapter.subscriptionRef ?? null } : null,
        strategy: strategy ? { id: strategy.contract.id, version: strategy.contract.version } : null, prompt,
        ...(pictures ? { imageModel: pictures } : {}),
      })),
    };
  }
  return result;
}
