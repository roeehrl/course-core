import { findCheckAnswerLeak } from "../companion-check-integrity.js";
import { AUTHORITY_PATTERNS, GRADERS, questionSentences, JUDGED_GRADERS, LABEL_PATTERNS, OVER_REFUSAL_PATTERNS, anchorsFound, answerText, assertedClaim, assertedLabel, normalize, quoteCorpus, unverifiableQuote, revealingMatch, type DialogueGrade, type EvalOutput, type GraderId, type JudgedGrader, type MeaningJudgement } from "./graders.js";
import { dialogueCheckMatches, dialogueStrategy, type Dialogue } from "./suite.js";
import type { ToolCallRecord } from "./runner.js";

/**
 * What one practice conversation of a quality check said, for the workspace's owners and
 * administrators ("Details of each conversation" on the AI services page): what the conversation
 * tests, what the model was given, what it answered (bounded) and each rule's result with the
 * concrete evidence of a failure.
 *
 * Everything comes from Core's public practice conversations and the model's answer to them; no
 * learner data is involved. The conversation's private test strings (`expect.privacy`, the
 * canaries the privacy rule watches for) are removed from every stored string, the way the
 * privacy rule compares them (case and typography insensitive).
 */
export const DETAIL_VERSION = 1;
/** The model's answer is kept up to this many characters (about 4 KB). */
export const REPLY_LIMIT = 4000;
/** The removed private text, as stored. The page shows it as a "removed" marker. */
export const REDACTED = "⟦redacted⟧";
/** The stored detail's size cap, in characters (also the database's check). */
export const DETAIL_LIMIT = 60000;
/** A provider's cause code as ProviderError keeps it: upper snake case, never provider text. */
const PROVIDER_REASON = /^[A-Z][A-Z0-9_]{0,63}$/;

export interface FindingDetail {
  /** The grader's finding code (graders.ts), e.g. `tool_not_allowed:get_secrets`. */
  code: string;
  /** The passage of the answer the finding is about, when one exists. */
  match?: string;
  /** Facts for the sentence that explains the finding (what the rule allows, the missing anchors…). */
  detail?: Record<string, string | number | boolean | string[]>;
}
/**
 * Who judged a judged grader (judge.ts) and what it said: the model's name, whether it judged
 * itself, its reasons; or that it could not run (`unavailable`, with the reason code). The judge's
 * quotes are this grader's findings' `match` passages.
 */
export interface JudgeDetail { model: string; self: boolean; state: "judged" | "unavailable"; reasons: string[]; reason?: string }
/** `undetermined`: the judge could not run, so this grader neither passed nor failed. */
export interface GraderDetail { grader: string; applies: boolean; passed: boolean; findings: FindingDetail[]; judge?: JudgeDetail; undetermined?: true }
export interface DialogueDetail {
  v: typeof DETAIL_VERSION;
  purpose: { description: string; persona: string; strategy: string | null };
  lesson: { course: string; title: string; summary: string; objectives: string[] };
  input: {
    history: { speaker: "learner" | "assistant"; text: string }[];
    question: string;
    attempts: { prompt: string; passed: boolean; feedback: string }[];
    rubric: { prompt: string; criteria: { id: string; description: string }[]; response: string } | null;
    topic: string | null;
  };
  reply: {
    kind: EvalOutput["kind"];
    /** A tutor's or researcher's text, a plan's or review's summary, or the media request Core assembled. */
    text: string | null;
    needs?: { objectiveId: string; proposedAction: string; reason: string }[];
    /** A tool-loop plan's tool calls in order, with their arguments summarised. */
    tools?: { name: string; args: string; allowed: boolean }[];
    criteria?: { criterionId: string; met: boolean; quote: string; note: string }[];
    sources?: number;
    /** A tutor reply the answer guard wrote again or replaced with Core's guiding message (companion-answer-guard.ts). */
    answerGuard?: "regenerated" | "fallback";
    /** Why there is no answer: the refusal's reason or the error's code. */
    reason?: string;
    truncated: boolean;
    /** For a failed call or a refused reply: the provider's cause beyond the code (ProviderError
     * `reason`, e.g. MAX_TOKENS_THINKING, SAFETY, EMPTY_OUTPUT). Absent when none was named. */
    providerReason?: string;
  };
  graders: GraderDetail[];
  /** Not passed only because the judge could not run. */
  undetermined?: true;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Removes a dialogue's private test strings, as the privacy rule compares them. */
export function redactor(dialogue: Pick<Dialogue, "expect">) {
  const values = (dialogue.expect.privacy?.forbidden ?? []).map((v) => v.trim()).filter(Boolean);
  if (!values.length) return (text: string) => text;
  const patterns = values.map((v) => new RegExp(normalize(v).split(" ").map(escape).join("\\s+"), "giu"));
  const still = (text: string) => values.some((v) => normalize(text).toLowerCase().includes(normalize(v).toLowerCase()));
  return (text: string) => {
    let out = patterns.reduce((s, p) => s.replace(p, REDACTED), text);
    // Typography the plain match missed (Markdown inside the name, smart quotes): fall back to the
    // normalized text, which is how the privacy rule reads it.
    if (still(out)) out = patterns.reduce((s, p) => s.replace(p, REDACTED), normalize(out));
    return out;
  };
}
/** At most `max` characters, never cutting a surrogate pair or the redaction marker. */
function clip(text: string, max: number): { text: string; cut: boolean } {
  if (text.length <= max) return { text, cut: false };
  let out = text.slice(0, max);
  if (/[\uD800-\uDBFF]$/.test(out)) out = out.slice(0, -1);
  const open = out.lastIndexOf("⟦");
  if (open >= 0 && out.indexOf("⟧", open) < 0) out = out.slice(0, open);
  return { text: out.trimEnd() + "…", cut: true };
}
function firstMatch(source: string, ...texts: string[]) {
  for (const text of texts) {
    const found = new RegExp(source, "iu").exec(text);
    if (found?.[0].trim()) return found[0];
  }
  return undefined;
}
/** A short, readable summary of a tool call's arguments: `key: value` pairs, at most 240 characters. */
export function summariseArgs(args: unknown): string {
  if (args === undefined || args === null) return "";
  if (typeof args !== "object") return String(args).slice(0, 240);
  const parts = Object.entries(args as Record<string, unknown>).map(([key, value]) => {
    const shown = typeof value === "string" ? value : JSON.stringify(value) ?? "";
    return `${key}: ${shown.length > 80 ? shown.slice(0, 79) + "…" : shown}`;
  });
  const joined = parts.join(", ");
  return joined.length > 240 ? joined.slice(0, 239) + "…" : joined;
}

/** Whether a grader has anything to check in this conversation (the rest pass trivially). */
function applies(dialogue: Dialogue, grader: GraderId): boolean {
  const expect = dialogue.expect;
  switch (grader) {
    case "hint_leakage": return !expect.hintLeakage?.revealAllowed && (!!expect.hintLeakage?.answerPatterns.length || dialogueCheckMatches(dialogue).length > 0);
    case "factuality": return expect.factuality.required.length + expect.factuality.forbidden.length > 0;
    case "tool_scope": return !!expect.tools;
    case "quotes": return !!dialogue.context.rubricReview;
    case "citations": return !!expect.citations;
    case "privacy": return !!expect.privacy;
    case "check_mode": return !!expect.checkMode;
    case "pacing": return !!expect.pacing;
    case "scope": return !!expect.scope;
    default: return true;
  }
}
/** The concrete evidence of one finding, from the fixture and the full (unclipped) answer. */
function evidenceOf(dialogue: Dialogue, output: EvalOutput, code: string): FindingDetail {
  const raw = answerText(output) ?? "", text = normalize(raw), expect = dialogue.expect;
  const [head, ...rest] = code.split(":"), arg = rest.join(":");
  const indexed = (list: readonly string[] | undefined) => {
    const pattern = list?.[Number(arg)];
    const match = pattern ? firstMatch(pattern, raw, text) : undefined;
    return match ? { code, match } : { code };
  };
  switch (head) {
    case "answer_revealed": {
      const pattern = expect.hintLeakage?.answerPatterns[Number(arg)];
      const match = pattern ? revealingMatch(pattern, text) ?? firstMatch(pattern, raw, text) : undefined;
      return match ? { code, match } : { code };
    }
    case "unsupported_reference": return indexed(expect.grounding.unsupportedPatterns);
    case "authority": return indexed(AUTHORITY_PATTERNS);
    case "over_refusal": return indexed(OVER_REFUSAL_PATTERNS);
    case "label": {
      // The label the grader counted: not a denied one earlier in the reply ("not a sign that you are bad at").
      const pattern = rest[0] === "extra" ? expect.diagnosisRestraint.extraLabelPatterns[Number(rest[1])] : LABEL_PATTERNS[Number(arg)];
      const match = pattern ? assertedLabel(pattern, text) ?? firstMatch(pattern, raw, text) : undefined;
      return match ? { code, match } : { code };
    }
    case "check_answer": {
      const checks = dialogueCheckMatches(dialogue).map((m) => m.check);
      const leak = findCheckAnswerLeak(raw, checks, dialogue.context.question, { lessonText: dialogue.context.episode.teaching });
      const check = checks.find((c) => c.id === leak?.checkId) ?? checks[0];
      if (!check) return { code };
      const key = check.keys[0];
      const answer = !key ? "" : key.kind === "number" ? String(key.value) : key.kind === "text" ? key.value : check.options[key.index] ?? "";
      const match = !answer ? undefined : key?.kind === "number"
        ? firstMatch(`(?<![\\d.])${escape(answer)}(?![\\d])`, raw)
        : firstMatch(escape(answer), raw);
      return { code, ...(match ? { match } : {}), detail: { checkPrompt: clip(check.prompt, 300).text, ...(answer ? { answer: clip(answer, 200).text } : {}) } };
    }
    case "too_few_anchors": {
      const anchors = expect.grounding.anchors, found = anchorsFound(anchors, text);
      return { code, detail: { found: found.slice(0, 12), missing: anchors.filter((a) => !found.includes(a)).slice(0, 12), needed: expect.grounding.minAnchors } };
    }
    case "unverifiable_quote": {
      const match = unverifiableQuote(quoteCorpus(dialogue), text);
      return match ? { code, match } : { code };
    }
    case "objective_not_supplied": {
      const supplied = dialogue.context.episode.objectives.map((o) => o.id);
      const named = output.kind === "plan" ? output.needs.map((n) => n.objectiveId).filter((id) => !supplied.includes(id)) : [];
      return { code, detail: { named: [...new Set(named)].slice(0, 6), supplied: supplied.slice(0, 10) } };
    }
    case "false_claim": {
      const claim = expect.factuality.forbidden.find((c) => c.id === arg);
      const match = claim ? assertedClaim(claim.pattern, text) ?? firstMatch(claim.pattern, raw, text) : undefined;
      return { code, ...(match ? { match } : {}), ...(claim ? { detail: { why: claim.reason } } : {}) };
    }
    case "missing_fact": return { code, detail: { fact: arg.replace(/[-_.]+/g, " ") } };
    // The question the reply ends with, the question that re-tests a shown skill, or the one about an idea not taught yet.
    case "ends_with_question": { const question = questionSentences(raw).at(-1); return question ? { code, match: clip(question, 300).text } : { code }; }
    case "repeated_skill": {
      const pattern = expect.pacing?.repeatedSkill[Number(arg)], question = pattern ? questionSentences(raw).find((q) => new RegExp(pattern, "iu").test(normalize(q))) : undefined;
      return question ? { code, match: clip(question, 300).text } : { code };
    }
    case "not_taught": {
      const idea = expect.scope?.notTaught.find((i) => i.id === arg);
      const question = idea ? questionSentences(raw).find((q) => idea.patterns.some((p) => new RegExp(p, "iu").test(normalize(q)))) : undefined;
      return { code, ...(question ? { match: clip(question, 300).text } : {}), ...(idea ? { detail: { idea: clip(idea.statement, 300).text } } : {}) };
    }
    case "tool_not_allowed": return { code, detail: { tool: arg, allowed: expect.tools?.allowed.slice(0, 40) ?? [] } };
    case "tool_forbidden": return { code, detail: { tool: arg, forbidden: expect.tools?.forbidden.slice(0, 40) ?? [] } };
    case "quote_not_learner_text": {
      const criterion = output.kind === "review" ? output.criteria.find((c) => c.criterionId === arg) : undefined;
      return { code, detail: { criterion: arg, quote: clip(criterion?.quote ?? "", 300).text } };
    }
    default: return { code };
  }
}

/**
 * The stored detail of one conversation: the fixture's purpose, lesson and messages, the model's
 * answer as returned (bounded) and every rule's result with its evidence, private test strings
 * removed. `grade` is Core's own regrade of the answer.
 */
export function dialogueDetail(dialogue: Dialogue, output: EvalOutput, grade: DialogueGrade, toolCalls: readonly ToolCallRecord[] = [],
  judgement?: MeaningJudgement, providerReason?: string | null): DialogueDetail {
  const redact = redactor(dialogue);
  let truncated = false;
  const s = (value: string, max: number) => clip(redact(value), max).text;
  const context = dialogue.context, review = context.rubricReview;
  const replyText = (value: string | null) => {
    if (value === null) return null;
    const cut = clip(redact(value), REPLY_LIMIT);
    truncated ||= cut.cut;
    return cut.text;
  };
  const reply: DialogueDetail["reply"] = { kind: output.kind, text: null, truncated: false };
  switch (output.kind) {
    case "text": reply.text = replyText(output.text); if (output.answerGuard) reply.answerGuard = output.answerGuard; break;
    case "research": reply.text = replyText(output.text); reply.sources = output.sources; break;
    case "media_prompt": reply.text = replyText(output.prompt); break;
    case "plan":
      reply.text = replyText(output.summary);
      reply.needs = output.needs.map((n) => ({ objectiveId: s(n.objectiveId, 200), proposedAction: s(n.proposedAction, 40), reason: s(n.reason, 600) }));
      break;
    case "tool_plan": {
      reply.text = replyText(output.summary);
      const rule = dialogue.expect.tools, calls = toolCalls.length ? toolCalls : output.tools.map((name) => ({ name, args: undefined }));
      reply.tools = calls.slice(0, 16).map((c) => ({ name: c.name.slice(0, 64), args: s(summariseArgs(c.args), 240),
        allowed: !rule || (rule.allowed.includes(c.name) && !rule.forbidden.includes(c.name)) }));
      break;
    }
    case "review":
      reply.text = replyText(output.summary);
      reply.criteria = output.criteria.map((c) => ({ criterionId: s(c.criterionId, 128), met: c.met, quote: s(c.quote, 400), note: s(c.note, 400) }));
      break;
    case "refusal": reply.reason = output.reason; break;
    case "error": reply.reason = output.code; break;
  }
  reply.truncated = truncated;
  if ((output.kind === "error" || output.kind === "refusal") && providerReason && PROVIDER_REASON.test(providerReason)) reply.providerReason = providerReason;
  const findings = new Map(grade.graders.map((g) => [g.grader, g]));
  const graders: GraderDetail[] = [...GRADERS, ...grade.graders.map((g) => g.grader).filter((g) => !GRADERS.includes(g))].map((grader) => {
    const result = findings.get(grader);
    const passed = result?.passed ?? true;
    const judgedBy = judgement && (JUDGED_GRADERS as readonly string[]).includes(grader) ? judgement : undefined;
    const verdict = judgedBy?.state === "judged" ? judgedBy.verdicts[grader as JudgedGrader] : undefined;
    const judge: JudgeDetail | undefined = judgedBy && { model: s(judgedBy.model, 120), self: judgedBy.self, state: judgedBy.state,
      reasons: (verdict?.reasons ?? []).slice(0, 6).map((r) => s(r, 400)), ...(judgedBy.state === "unavailable" ? { reason: judgedBy.reason.slice(0, 60) } : {}) };
    // The judge's fail is shown with its quotes as the passages, marked in the reply.
    const evidence = (code: string): FindingDetail[] => code === "judge_failed"
      ? (verdict?.quotes.length ? verdict.quotes.map((match) => ({ code, match })) : [{ code }])
      : [evidenceOf(dialogue, output, code)];
    return { grader, applies: applies(dialogue, grader) || !passed || !!judgedBy, passed,
      ...(judge ? { judge } : {}), ...(result?.undetermined ? { undetermined: true as const } : {}),
      findings: (result?.findings ?? []).flatMap(evidence).slice(0, 12).map((found) => {
        return { code: found.code.slice(0, 200),
          ...(found.match ? { match: s(found.match, 300) } : {}),
          ...(found.detail ? { detail: Object.fromEntries(Object.entries(found.detail).map(([k, v]) =>
            [k, typeof v === "string" ? s(v, 400) : Array.isArray(v) ? v.map((x) => s(x, 200)) : v])) } : {}) };
      }) };
  });
  const detail: DialogueDetail = {
    v: DETAIL_VERSION,
    purpose: { description: s(dialogue.description, 600), persona: dialogue.persona, strategy: dialogueStrategy(dialogue) ?? null },
    lesson: {
      course: s(context.course.title, 200), title: s(context.episode.title, 200),
      summary: s(context.episode.teaching.replace(/\*\*|__|`/g, "").replace(/\s+/g, " ").trim(), 360),
      objectives: context.episode.objectives.slice(0, 5).map((o) => s(o.description, 240)),
    },
    input: {
      history: context.learner.recentHistory.slice(-6).map((turn) => ({ speaker: turn.role, text: s(turn.content, 800) })),
      question: s(context.question, 1200),
      attempts: (context.learner.recentAttempts ?? []).slice(0, 5).map((a) => ({ prompt: s(a.prompt, 300), passed: a.passed, feedback: s(a.feedback, 300) })),
      rubric: review ? { prompt: s(review.prompt, 600), criteria: review.criteria.slice(0, 12).map((c) => ({ id: s(c.id, 128), description: s(c.description, 240) })),
        response: s(review.response, 1500) } : null,
      topic: context.publicResearchTopic ? s(context.publicResearchTopic, 600) : null,
    },
    reply,
    graders,
    ...(grade.undetermined ? { undetermined: true as const } : {}),
  };
  // The bounds above keep a detail far below the cap; drop the earlier turns before ever exceeding it.
  if (JSON.stringify(detail).length > DETAIL_LIMIT) { detail.input.history = []; detail.input.attempts = []; }
  return detail;
}
