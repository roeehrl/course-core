import { createHash } from "node:crypto";
import { readdir, readFile, lstat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { TeachingContext } from "../agent-strategies.js";
import { checkCoachingView, fold, gradedCheck, gradedChecks, matchGradedChecks, type CheckMatch } from "../companion-check-integrity.js";

/**
 * Agent evaluation suites (design §18 "Agent evals", requirements J04/N07).
 *
 * A suite is a set of curated dialogues. Each dialogue is one teaching context for one agent
 * role and the deterministic expectations its answer is graded against. Core ships a public
 * suite built from the public example courses; a course repository can keep its own held-out
 * suite in the same format and run it with the CLI's `--fixtures` option.
 */
export const DIALOGUE_SCHEMA = "course-core.agent-eval-dialogue/v1";
export const REPORT_SCHEMA = "course-core.agent-eval-report/v1";
/** Bumped whenever a grader's behavior changes, so earlier results become stale. */
export const GRADER_VERSION = "core.agent-eval-graders/4";
export const EVAL_PERSONAS = ["novice", "expert", "terse", "guessing", "uncertain", "frustrated", "adversarial", "inconsistent"] as const;
/** Every Core strategy this format can drive, and the role it serves (requirement N07: every agent
 * role is evaluated). A strategy not listed here (a host pack's own) is not covered: activating a
 * revision of it needs an owner's explicit override. */
export const EVAL_STRATEGIES = {
  "core.companion.tutor": "companion", "core.supervisor.plan": "supervisor", "core.supervisor.tool-loop": "supervisor",
  "core.research.public-topic": "research", "core.reviewer.rubric-assist": "reviewer", "core.media.image": "media", "core.media.video": "media",
} as const;
export type EvalStrategy = keyof typeof EVAL_STRATEGIES;
export type EvalRole = (typeof EVAL_STRATEGIES)[EvalStrategy];
export const EVAL_ROLES: EvalRole[] = ["companion", "supervisor", "research", "reviewer", "media"];
/** A dialogue that names no strategy drives the role's original one (suites written before v2). */
const DEFAULT_STRATEGY: Partial<Record<EvalRole, EvalStrategy>> = { companion: "core.companion.tutor", supervisor: "core.supervisor.plan" };

/** A case-insensitive regular expression source, checked when the suite loads. */
const pattern = z.string().min(1).max(400).refine((source) => {
  try { new RegExp(source, "iu"); return true; } catch { return false; }
}, "invalid_pattern");
const slug = z.string().regex(/^[a-z0-9][a-z0-9._-]{2,119}$/);
const shortText = (max: number) => z.string().min(1).max(max);
const contextSchema = z.strictObject({
  course: z.strictObject({ title: shortText(200), digest: shortText(200) }),
  episode: z.strictObject({
    id: shortText(200), title: shortText(200), teaching: shortText(20000),
    objectives: z.array(z.strictObject({ id: shortText(200), description: shortText(1000) })).min(1).max(10),
  }),
  learner: z.strictObject({
    profile: z.record(z.string().max(100), z.union([z.string().max(500), z.number(), z.boolean()])),
    recentHistory: z.array(z.strictObject({ role: z.enum(["learner", "assistant"]), content: shortText(4000) })).max(20),
    recentAttempts: z.array(z.strictObject({
      assessmentId: shortText(200), prompt: shortText(2000), passed: z.boolean(), abstained: z.literal(true).optional(),
      assistance: shortText(100), mode: shortText(100), feedback: z.string().max(2000),
    })).max(10).optional(),
  }),
  question: shortText(4000),
  constraints: z.strictObject({ deadline: z.string().max(40).nullable(), expansionAllowed: z.boolean(), independentAssessmentActive: z.literal(false) }),
  /** Research dialogues: the approved public topic and its scope, as the host resolves them. */
  publicResearchTopic: shortText(2000).optional(),
  publicResearchScope: z.strictObject({ requestId: z.uuid(), topicId: shortText(128), queryDigest: z.string().regex(/^[a-f0-9]{64}$/) }).optional(),
  /** Reviewer dialogues: the rubric, question and answer only. */
  rubricReview: z.strictObject({
    requestId: z.uuid(), attemptId: z.uuid(), prompt: shortText(4000),
    criteria: z.array(z.strictObject({ id: shortText(128), description: shortText(1000), required: z.boolean() })).min(1).max(12),
    response: shortText(8000), earlierTurns: z.array(z.strictObject({ speaker: z.enum(["learner", "reviewer"]), text: shortText(4000) })).max(10),
    rubricDigest: z.string().regex(/^[a-f0-9]{64}$/), responseDigest: z.string().regex(/^[a-f0-9]{64}$/),
  }).optional(),
});
export const dialogueSchema = z.strictObject({
  schema: z.literal(DIALOGUE_SCHEMA),
  id: slug,
  role: z.enum(EVAL_ROLES as [EvalRole, ...EvalRole[]]),
  /** The strategy the dialogue drives; omitted means the role's original strategy. */
  strategy: z.enum(Object.keys(EVAL_STRATEGIES) as [EvalStrategy, ...EvalStrategy[]]).optional(),
  persona: z.enum(EVAL_PERSONAS),
  description: shortText(600),
  /** Where the content comes from (for the public suite: an example course pack). */
  source: z.strictObject({ pack: shortText(200), episode: shortText(200) }),
  context: contextSchema,
  expect: z.strictObject({
    /** Companion dialogues with `checks`: whether Core puts the turn in check-coaching mode
     * (`coached`) or tutors it normally (`normal`: an ordinary question, even right after a pasted
     * check, is answered without a refusal). Graded by `check_mode`. */
    checkMode: z.enum(["coached", "normal"]).optional(),
    /** Absent: the dialogue has no answer to protect. */
    hintLeakage: z.strictObject({
      revealAllowed: z.boolean(),
      /** Any match reveals the protected answer. */
      answerPatterns: z.array(pattern).min(1).max(20),
    }).optional(),
    grounding: z.strictObject({
      /** Phrases taken from the supplied context; at least `minAnchors` must appear. */
      anchors: z.array(shortText(200)).min(1).max(30),
      minAnchors: z.number().int().min(1).max(30),
      /** References to material the context does not contain (a chapter, a teacher's remark). */
      unsupportedPatterns: z.array(pattern).max(20).default([]),
    }),
    diagnosisRestraint: z.strictObject({
      extraLabelPatterns: z.array(pattern).max(20).default([]),
      /** Supervisor plans only: the most needs one dialogue warrants. */
      maxNeeds: z.number().int().min(0).max(6).optional(),
    }).default({ extraLabelPatterns: [] }),
    factuality: z.strictObject({
      /** Each fact must be stated by at least one pattern. */
      required: z.array(z.strictObject({ id: slug, anyOf: z.array(pattern).min(1).max(10) })).max(10).default([]),
      /** Known false claims for this context. */
      forbidden: z.array(z.strictObject({ id: slug, pattern, reason: shortText(300) })).max(20).default([]),
    }).default({ required: [], forbidden: [] }),
    /** Tool-loop dialogues: what each tool answers, which tools the run may use, and which it must
     * never call (an injected instruction naming one). */
    tools: z.strictObject({
      results: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), z.unknown()),
      allowed: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/)).max(40),
      forbidden: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/)).max(40).default([]),
    }).optional(),
    /** Research dialogues: the fewest cited sources an answer must carry. */
    citations: z.strictObject({ minSources: z.number().int().min(1).max(20) }).optional(),
    /** Literal strings (learner names, canaries) that must never reach a prompt or an answer. */
    privacy: z.strictObject({ forbidden: z.array(shortText(200)).min(1).max(20) }).optional(),
  }),
  /** Companion dialogues: the course's graded checks as the host holds them, answer keys included
   * (SDK assessments, copied from the pack). Never sent to a model: the runner matches the question
   * against them as Core does and puts the matches (prompt and options only) in the context, and the
   * hint-leakage grader also applies Core's own check verifier (companion-check-integrity.ts). */
  checks: z.array(z.looseObject({ id: shortText(200), type: shortText(40), prompt: shortText(4000) })).min(1).max(20).optional(),
  /** Optional advisory LLM-judge criteria. Never part of a pass/fail decision. */
  judge: z.strictObject({ criteria: z.array(z.strictObject({ id: slug, description: shortText(500) })).min(1).max(8) }).optional(),
}).refine((d) => d.expect.grounding.minAnchors <= d.expect.grounding.anchors.length, "min_anchors_exceeds_anchors")
  .refine((d) => d.strategy ? EVAL_STRATEGIES[d.strategy] === d.role : DEFAULT_STRATEGY[d.role] !== undefined, "strategy_role_mismatch")
  .refine((d) => d.strategy !== "core.research.public-topic" || (d.context.publicResearchTopic && d.context.publicResearchScope), "research_context_required")
  .refine((d) => d.strategy !== "core.reviewer.rubric-assist" || d.context.rubricReview, "rubric_review_required")
  .refine((d) => d.strategy !== "core.supervisor.tool-loop" || d.expect.tools, "tool_expectations_required")
  .refine((d) => !d.checks || (d.role === "companion" && d.checks.every((c) => gradedCheck(c) !== null)), "checks_companion_only")
  .refine((d) => !d.expect.checkMode || d.checks, "check_mode_needs_checks");
export type Dialogue = z.infer<typeof dialogueSchema>;
/** The graded checks a dialogue's question matches, as Core matches them for a companion turn
 * (every listed check counts as this lesson's; the lesson text is the episode's). */
export function dialogueCheckMatches(dialogue: Pick<Dialogue, "checks" | "context">): CheckMatch[] {
  if (!dialogue.checks?.length) return [];
  const checks = gradedChecks({ assessments: dialogue.checks }), ids = checks.map((check) => check.id);
  return matchGradedChecks({ question: dialogue.context.question, earlier: dialogue.context.learner.recentHistory.filter((turn) => turn.role === "learner").map((turn) => turn.content),
    checks, current: ids, nearby: new Set(ids), courseText: fold(dialogue.context.episode.teaching).replace(/\s+/g, " ") });
}
/** The dialogue's teaching context in the runtime's own type: with the matched checks (no keys) in
 * check-coaching mode, as the host builds it. */
export const teachingContext = (dialogue: Dialogue): TeachingContext => {
  const context = structuredClone(dialogue.context) as TeachingContext, coaching = checkCoachingView(dialogueCheckMatches(dialogue));
  return coaching ? { ...context, checkCoaching: coaching } : context;
};

export interface EvalSuite {
  id: string;
  version: string;
  /** sha256 over the grader version and every dialogue's canonical JSON. */
  digest: string;
  dialogues: readonly Dialogue[];
}

/** JSON with sorted object keys, so equal values always hash the same. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value).sort().filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(value ?? null);
}
export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

export class SuiteError extends Error {
  constructor(readonly code: string, readonly detail?: string) { super(detail ? `${code}: ${detail}` : code); }
}

/** Validates dialogues and builds a suite. Duplicate ids are refused. */
export function buildSuite(id: string, version: string, raw: readonly unknown[]): EvalSuite {
  if (!/^[a-z0-9][a-z0-9._-]{2,119}$/.test(id) || !/^\d+\.\d+\.\d+$/.test(version)) throw new SuiteError("SUITE_INVALID", "id/version");
  if (raw.length < 1 || raw.length > 500) throw new SuiteError("SUITE_INVALID", "dialogue count");
  const dialogues = raw.map((value, index) => {
    const parsed = dialogueSchema.safeParse(value);
    if (!parsed.success) throw new SuiteError("DIALOGUE_INVALID", `#${index} ${parsed.error.issues[0]?.path.join(".")}: ${parsed.error.issues[0]?.message}`);
    return parsed.data;
  }).sort((a, b) => a.id.localeCompare(b.id));
  const ids = new Set(dialogues.map((d) => d.id));
  if (ids.size !== dialogues.length) throw new SuiteError("DIALOGUE_DUPLICATE");
  const digest = sha256(canonicalJson({ id, version, graders: GRADER_VERSION, dialogues }));
  return Object.freeze({ id, version, digest, dialogues: Object.freeze(dialogues) });
}

/** The strategy a dialogue drives. */
export const dialogueStrategy = (dialogue: Pick<Dialogue, "role" | "strategy">) => dialogue.strategy ?? DEFAULT_STRATEGY[dialogue.role];
/** Dialogues for one role bound to one strategy. */
export const dialoguesFor = (suite: EvalSuite, role: string, strategy: string | null | undefined) =>
  suite.dialogues.filter((d) => d.role === role && dialogueStrategy(d) === strategy);
/** Whether the suite covers this role under this strategy. */
export const covers = (suite: EvalSuite, role: string, strategy: string | null | undefined) => dialoguesFor(suite, role, strategy).length > 0;

/**
 * Loads an external suite (for example a private held-out set) from a directory:
 * `suite.json` ({ "id", "version" }) and `dialogues/*.json`. Only regular files are read;
 * symbolic links and files over 256 KiB are refused.
 */
export async function loadSuiteDirectory(directory: string): Promise<EvalSuite> {
  const readJson = async (file: string) => {
    const info = await lstat(file);
    if (!info.isFile() || info.size > 262144) throw new SuiteError("SUITE_FILE_REFUSED", path.basename(file));
    try { return JSON.parse(await readFile(file, "utf8")) as unknown; } catch { throw new SuiteError("SUITE_FILE_INVALID", path.basename(file)); }
  };
  const manifest = z.strictObject({ id: slug, version: z.string() }).safeParse(await readJson(path.join(directory, "suite.json")));
  if (!manifest.success) throw new SuiteError("SUITE_INVALID", "suite.json");
  const folder = path.join(directory, "dialogues");
  const names = (await readdir(folder)).filter((name) => name.endsWith(".json")).sort();
  if (names.length > 500) throw new SuiteError("SUITE_INVALID", "too many dialogues");
  return buildSuite(manifest.data.id, manifest.data.version, await Promise.all(names.map((name) => readJson(path.join(folder, name)))));
}
