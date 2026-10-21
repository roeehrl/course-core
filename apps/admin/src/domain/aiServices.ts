import { z } from "zod";
import { providerSetupSchema, keyTestSchema, type ProviderSetup } from "./providerSetup";
import {
  costSettingsReceiptSchema,
  pricingViewSchema,
  type SpendView,
  priceReceiptSchema,
  type PriceInput,
  type PricingView,
} from "./providerCosts";
import { evalStatusSchema, overrideReceiptSchema, type EvalStatus } from "./providerEvals";

/**
 * The admin "AI services" page: wire shapes of its API
 * (/api/admin/workspaces/:id/provider-setup/…) and the pure rules that decide what each section
 * and the page status bar say. No key is ever part of any shape here.
 */
export const JOBS = ["companion", "supervisor", "research", "reviewer", "media"] as const;
export type Job = (typeof JOBS)[number];
export const NEEDED_JOBS: readonly Job[] = ["companion", "supervisor"];
const job = z.enum(JOBS);
const keyStatus = z.enum(["working", "rejected", "untested", "unreachable"]);
export const connectionSchema = z.object({
  id: z.string().max(128),
  kind: z.string().max(100),
  label: z.string().max(128),
  name: z.string().max(80),
  keyEnding: z.string().length(4).nullable(),
  keyStored: z.boolean(),
  keyStatus,
  keyReason: z.string().max(100).nullable(),
  testedAt: z.string().nullable(),
  usedByRoles: z.array(job).max(5),
});
export type Connection = z.infer<typeof connectionSchema>;
export const connectionsSchema = z.object({
  revision: z.number().int().nonnegative(),
  connections: z.array(connectionSchema).max(20),
  serviceKeys: z.array(z.object({ id: z.string().max(40), configured: z.boolean() })).max(10),
  keyStorage: z.literal("encrypted_server_vault"),
});
export type Connections = z.infer<typeof connectionsSchema>;
export const connectionReceiptSchema = z.object({
  revision: z.number().int().positive(),
  connection: z.object({
    id: z.string().max(128),
    kind: z.string().max(100),
    keyEnding: z.string().length(4).nullable(),
    keyStatus,
  }),
});
export const connectionTestSchema = z.object({
  id: z.string().max(128),
  outcome: z.string().max(100),
  keyStatus,
});
export const modelListSchema = z.object({
  connectionId: z.string().max(128),
  kind: z.string().max(100),
  models: z
    .array(
      z.object({
        remoteModel: z.string().max(2048),
        displayName: z.string().max(128),
        description: z.string().max(2000),
        inputTokenLimit: z.number().int().positive().nullable(),
        outputTokenLimit: z.number().int().positive().nullable(),
        methods: z.array(z.string().max(128)).max(32),
      }),
    )
    .max(400),
  truncated: z.boolean(),
  roles: z.array(
    z.object({
      role: job,
      needed: z.boolean(),
      method: z.string().max(128).nullable(),
      videoMethod: z.string().max(128).nullable(),
      offered: z.boolean(),
      suggested: z.string().max(2048).nullable(),
    }),
  ),
  generationPerformed: z.literal(false),
});
export type ModelList = z.infer<typeof modelListSchema>;
export const roleCheckSchema = z.enum(["passed", "approved", "unchanged", "not_needed", "needed", "failed"]);
export const draftSchema = z.object({
  id: z.string().uuid(),
  baseRevision: z.number().int().nonnegative(),
  source: z.enum(["models", "json"]),
  stale: z.boolean(),
  roles: z.array(
    z.object({
      role: job,
      modelId: z.string().max(2048),
      connectionId: z.string().max(128).nullable(),
      remoteModel: z.string().max(2048).nullable(),
      mediaKind: z.enum(["image", "video"]).nullable(),
      check: roleCheckSchema,
      priced: z.boolean(),
      changed: z.boolean(),
    }),
  ),
  removedRoles: z.array(z.string().max(40)),
  jobPolicy: z.unknown(),
  waitingForCheck: z.array(job),
  updatedAt: z.string(),
  secretsIncluded: z.literal(false),
});
export type Draft = z.infer<typeof draftSchema>;
export const currentDraftSchema = z.object({ draft: draftSchema.nullable() });
export const activationSchema = z.object({
  revision: z.number().int().positive(),
  configurationSaved: z.literal(true),
  cancelledPendingJobs: z.number().int().nonnegative(),
  evaluation: z.record(z.string(), z.string()),
});
const amount = z.string().regex(/^\d+$/);
const ledger = z.object({
  revision: z.number().int().nonnegative(),
  limit_micro_usd: amount,
  limit_tokens: amount,
  used_micro_usd: amount,
  used_tokens: amount,
});
export const budgetsSchema = z.object({
  workspace: ledger,
  defaultEnrollment: z.object({
    revision: z.number().int().nonnegative(),
    limit_micro_usd: amount.nullable(),
    limit_tokens: amount.nullable(),
  }),
  enrollments: z.array(ledger.extend({ enrollmentId: z.string(), limitSource: z.enum(["default", "own"]) })).max(100),
});
export type Budgets = z.infer<typeof budgetsSchema>;
export const budgetReceiptSchema = z.object({
  revision: z.number().int().positive(),
  scope: z.enum(["workspace", "enrollment", "default_enrollment"]),
  consentRecorded: z.boolean(),
});
export const serviceKeyReceiptSchema = z.object({
  revision: z.number().int().positive(),
  service: z.string(),
  configured: z.boolean(),
});
/** Pricing view with the open draft's models (`draft`), which can be priced before activation. */
export const aiPricingSchema = pricingViewSchema.extend({
  models: z
    .array(
      pricingViewSchema.shape.models.element.extend({
        draft: z.boolean().optional(),
      }),
    )
    .max(50),
});
export type AiPricing = z.infer<typeof aiPricingSchema>;

export type MediaChoice = {
  kind: "image" | "video";
  durationSeconds?: number;
  aspectRatio?: string;
  resolution?: string;
  downloadHosts?: string[];
};
export type Assignment = { connectionId: string; remoteModel: string; media?: MediaChoice } | null;

/** A refusal from the AI services API: the service's code, its HTTP status and allowlisted facts. */
export class AiServicesError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly details?: { roles?: Job[]; count?: number },
  ) {
    super(code);
    this.name = "AiServicesError";
  }
}
export interface AiServicesPort {
  setup(workspace: string, signal?: AbortSignal): Promise<ProviderSetup>;
  connections(workspace: string, signal?: AbortSignal): Promise<Connections>;
  testKey(workspace: string, input: { kind: string; key: string }): Promise<z.infer<typeof keyTestSchema>>;
  addConnection(
    workspace: string,
    input: { expectedRevision: number; idempotencyKey: string; kind: string; key: string; name?: string; skipTest?: boolean },
  ): Promise<z.infer<typeof connectionReceiptSchema>>;
  replaceKey(
    workspace: string,
    id: string,
    input: { expectedRevision: number; idempotencyKey: string; key: string; skipTest?: boolean },
  ): Promise<z.infer<typeof connectionReceiptSchema>>;
  testConnection(workspace: string, id: string): Promise<z.infer<typeof connectionTestSchema>>;
  removeConnection(workspace: string, id: string, input: { expectedRevision: number; idempotencyKey: string }): Promise<unknown>;
  models(workspace: string, id: string, signal?: AbortSignal): Promise<ModelList>;
  currentDraft(workspace: string, signal?: AbortSignal): Promise<Draft | null>;
  draftFromModels(
    workspace: string,
    input: { baseRevision: number; assignments: Partial<Record<Job, Assignment>>; jobPolicy?: unknown },
  ): Promise<Draft>;
  draftFromJson(workspace: string, input: { baseRevision: number; configuration: unknown; jobPolicy: unknown }): Promise<Draft>;
  discardDraft(workspace: string): Promise<unknown>;
  activate(
    workspace: string,
    id: string,
    input: { expectedRevision: number; idempotencyKey: string; confirmCancelRunning: boolean },
  ): Promise<z.infer<typeof activationSchema>>;
  approve(workspace: string, input: { idempotencyKey: string; draftId: string; role: Job; reason: string }): Promise<z.infer<typeof overrideReceiptSchema>>;
  pricing(workspace: string, signal?: AbortSignal): Promise<AiPricing>;
  savePrice(workspace: string, input: PriceInput): Promise<z.infer<typeof priceReceiptSchema>>;
  saveCostSettings(
    workspace: string,
    input: { idempotencyKey: string; expectedRevision: number; requirePricing: boolean; acknowledgeConservativeCharge?: boolean },
  ): Promise<z.infer<typeof costSettingsReceiptSchema>>;
  budgets(workspace: string, signal?: AbortSignal): Promise<Budgets>;
  saveBudget(
    workspace: string,
    input: {
      expectedRevision: number;
      idempotencyKey: string;
      scope: "workspace" | "default_enrollment";
      limits: { microUsd: number; tokens?: number };
      paidWorkApproved: boolean;
    },
  ): Promise<z.infer<typeof budgetReceiptSchema>>;
  evals(workspace: string, signal?: AbortSignal): Promise<EvalStatus>;
  spend(workspace: string, period: "day" | "month", signal?: AbortSignal): Promise<SpendView>;
  setServiceKey(
    workspace: string,
    id: string,
    input: { expectedRevision: number; idempotencyKey: string; key: string | null },
  ): Promise<z.infer<typeof serviceKeyReceiptSchema>>;
}

// ---- Money ----
/** Exact decimal USD (up to six places) to integer micro-USD; null when not a valid amount. */
export function parseUsd(value: string, max = 1_000_000_000): number | null {
  const text = value.trim().replace(/^\$/, "");
  if (!/^\d{1,7}(?:\.\d{1,6})?$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  const micro = Number(BigInt(whole!) * 1000000n + BigInt(fraction.padEnd(6, "0")));
  return micro <= max ? micro : null;
}
/** Micro-USD as an editable decimal: two places, more only when needed. */
export function usdInput(micro: number | string | null | undefined) {
  if (micro === null || micro === undefined || micro === "") return "";
  const value = BigInt(micro),
    whole = value / 1000000n,
    fraction = String(value % 1000000n).padStart(6, "0").replace(/0+$/, "");
  return `${whole}.${fraction.padEnd(2, "0")}`;
}

// ---- What is on ----
export interface ActiveRole {
  role: Job;
  modelId: string;
  connectionId: string | null;
  remoteModel: string | null;
  mediaKind: "image" | "video" | null;
}
/** Jobs of the active configuration with their connection and model. */
export function activeRoles(configuration: unknown): ActiveRole[] {
  const value = configuration as {
    registry?: { models?: { id?: unknown; providerId?: unknown; remoteModel?: unknown }[] };
    roles?: Record<string, { modelId?: unknown; mediaKind?: unknown } | undefined>;
  } | null;
  const models = Array.isArray(value?.registry?.models) ? value!.registry!.models! : [];
  const result: ActiveRole[] = [];
  for (const role of JOBS) {
    const binding = value?.roles?.[role];
    if (!binding || typeof binding.modelId !== "string") continue;
    const model = models.find((m) => m.id === binding.modelId);
    result.push({
      role,
      modelId: binding.modelId,
      connectionId: typeof model?.providerId === "string" ? model.providerId : null,
      remoteModel: typeof model?.remoteModel === "string" ? model.remoteModel : null,
      mediaKind: binding.mediaKind === "image" || binding.mediaKind === "video" ? binding.mediaKind : null,
    });
  }
  return result;
}
/** A price block: one model of one connection, priced once for every job that uses it. */
export interface PriceGroup {
  key: string;
  connectionId: string | null;
  remoteModel: string;
  roles: Job[];
  modelIds: string[];
  priced: boolean;
}
export function priceGroups(active: ActiveRole[], draft: Draft | null, pricing: AiPricing | null): PriceGroup[] {
  const rows: { role: Job; modelId: string; connectionId: string | null; remoteModel: string | null }[] = draft
    ? draft.roles.map((r) => ({ role: r.role, modelId: r.modelId, connectionId: r.connectionId, remoteModel: r.remoteModel }))
    : active;
  const groups = new Map<string, PriceGroup>();
  for (const row of rows) {
    const remote = row.remoteModel ?? row.modelId,
      key = `${row.connectionId ?? ""}\u0000${remote}`;
    const model = pricing?.models.find((m) => m.modelId === row.modelId);
    const priced = !!model?.coverage.find((c) => c.role === row.role)?.priced || (draft?.roles.find((r) => r.role === row.role)?.priced ?? false);
    const group = groups.get(key) ?? { key, connectionId: row.connectionId, remoteModel: remote, roles: [], modelIds: [], priced: true };
    group.roles.push(row.role);
    if (!group.modelIds.includes(row.modelId)) group.modelIds.push(row.modelId);
    group.priced = group.priced && priced;
    groups.set(key, group);
  }
  return [...groups.values()];
}

export type SectionId = "connections" | "models" | "prices" | "spending" | "check";
export type SectionState =
  | { tone: "ok"; pill: "working" | "done" }
  | { tone: "warn"; pill: "notConnected" | "notTested" | "modelNeeded" | "waitingCheck" | "notOn" | "priceNeeded" | "spendingOff" | "learnerLimitNeeded"; count?: number }
  | { tone: "bad"; pill: "keyProblem"; count: number }
  | { tone: "idle"; pill: "nothingYet" };
export type Issue =
  | { section: "connections"; kind: "connect" }
  | { section: "connections"; kind: "keyProblem"; count: number }
  | { section: "models"; kind: "models"; count: number }
  | { section: "models"; kind: "notOn" }
  | { section: "check"; kind: "check"; count: number }
  | { section: "prices"; kind: "prices"; count: number }
  | { section: "spending"; kind: "spending" }
  | { section: "spending"; kind: "learnerLimit" };
export interface PageStatus {
  on: boolean;
  sections: Record<SectionId, SectionState>;
  issues: Issue[];
}
/**
 * What the page says: per section a status, and for the page the list of what is still missing
 * before AI services are on (each with the section that fixes it).
 */
export function pageStatus(input: {
  connections: Connections;
  setup: ProviderSetup;
  draft: Draft | null;
  pricing: AiPricing | null;
  budgets: Budgets | null;
}): PageStatus {
  const issues: Issue[] = [];
  const list = input.connections.connections;
  const problems = list.filter((c) => c.keyStatus === "rejected" || c.keyStatus === "unreachable" || !c.keyStored).length;
  let connections: SectionState;
  if (!list.length) {
    connections = { tone: "warn", pill: "notConnected" };
    issues.push({ section: "connections", kind: "connect" });
  } else if (problems) {
    connections = { tone: "bad", pill: "keyProblem", count: problems };
    issues.push({ section: "connections", kind: "keyProblem", count: problems });
  } else if (list.every((c) => c.keyStatus === "untested")) connections = { tone: "warn", pill: "notTested" };
  else connections = { tone: "ok", pill: "working" };

  const active = activeRoles(input.setup.configuration);
  const draft = input.draft;
  const missing = NEEDED_JOBS.filter((role) => !active.some((a) => a.role === role) && !draft?.roles.some((d) => d.role === role));
  let models: SectionState;
  if (missing.length) {
    models = { tone: "warn", pill: "modelNeeded", count: missing.length };
    issues.push({ section: "models", kind: "models", count: missing.length });
  } else if (draft && draft.waitingForCheck.length) models = { tone: "warn", pill: "waitingCheck" };
  else if (draft) {
    models = { tone: "warn", pill: "notOn" };
    issues.push({ section: "models", kind: "notOn" });
  } else models = { tone: "ok", pill: "done" };

  let check: SectionState;
  if (draft && draft.waitingForCheck.length) {
    check = { tone: "warn", pill: "waitingCheck", count: draft.waitingForCheck.length };
    issues.push({ section: "check", kind: "check", count: draft.waitingForCheck.length });
  } else if (!active.length && !draft) check = { tone: "idle", pill: "nothingYet" };
  else check = { tone: "ok", pill: "done" };

  const groups = priceGroups(active, draft, input.pricing).filter((g) => g.roles.some((r) => r !== "media"));
  const unpriced = groups.filter((g) => !g.priced).length;
  let prices: SectionState;
  if (!groups.length) prices = { tone: "idle", pill: "nothingYet" };
  else if (unpriced) {
    prices = { tone: "warn", pill: "priceNeeded", count: unpriced };
    issues.push({ section: "prices", kind: "prices", count: unpriced });
  } else prices = { tone: "ok", pill: "done" };

  const total = Number(input.budgets?.workspace.limit_micro_usd ?? 0),
    perLearner = Number(input.budgets?.defaultEnrollment.limit_micro_usd ?? 0);
  let spending: SectionState;
  if (!total) {
    spending = { tone: "warn", pill: "spendingOff" };
    issues.push({ section: "spending", kind: "spending" });
  } else if (!perLearner) {
    spending = { tone: "warn", pill: "learnerLimitNeeded" };
    issues.push({ section: "spending", kind: "learnerLimit" });
  } else spending = { tone: "ok", pill: "done" };
  return { on: issues.length === 0, sections: { connections, models, prices, spending, check }, issues };
}
export { evalStatusSchema, overrideReceiptSchema, providerSetupSchema, keyTestSchema, priceReceiptSchema, costSettingsReceiptSchema };
export type { EvalStatus, PricingView, ProviderSetup, PriceInput };
