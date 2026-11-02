import { useEffect, useState, type ReactNode } from "react";
import { SkeletonRows } from "../ui";
import { CheckCircle2, ChevronRight, CircleHelp, XCircle } from "lucide-react";
import type {
  AiServicesPort,
  QualityCheck,
  QualityDetails,
  QualityDialogue,
  QualityFinding,
} from "../../domain/aiServices";
import { Ltr, jobName, useAiText, type AiKey, type AiText } from "./shared";
import { useI18n } from "../../i18n";

/** Where the page reads a check's conversation details. */
export interface DetailsSource {
  port: AiServicesPort;
  workspaceId: string;
}
/** The removed private test text, as the server stores it (services/api/src/agent-evals/details.ts). */
const REDACTED = "⟦redacted⟧";
const KNOWN_GRADERS = new Set([
  "hint_leakage",
  "grounding",
  "diagnosis_restraint",
  "factuality",
  "authority",
  "tool_scope",
  "quotes",
  "citations",
  "privacy",
  "check_mode",
]);
const PERSONAS = new Set([
  "novice",
  "expert",
  "terse",
  "guessing",
  "uncertain",
  "frustrated",
  "adversarial",
  "inconsistent",
]);
const REPLY_KINDS = new Set([
  "text",
  "plan",
  "tool_plan",
  "research",
  "review",
  "media_prompt",
]);
/** Finding codes with their own sentence (`aiServices.check.details.finding.<head>`). */
const FINDINGS = new Set([
  "answer_revealed",
  "check_answer",
  "too_few_anchors",
  "unsupported_reference",
  "unverifiable_quote",
  "objective_not_supplied",
  "label",
  "too_many_needs",
  "missing_fact",
  "false_claim",
  "authority",
  "tool_not_allowed",
  "tool_forbidden",
  "not_a_tool_plan",
  "not_a_review",
  "quote_not_learner_text",
  "too_few_sources",
  "private_text",
  "coached_ordinary_question",
  "check_not_coached",
  "over_refusal",
  "no_answer",
  "judge_failed",
  "judge_unavailable",
]);
/** Broken rules named in a closed conversation's row; the rest are counted. */
const SHOWN_RULES = 2;
/** The check's own error when its judge could not run: it kept the conversations to show why. */
export const JUDGE_UNAVAILABLE = "PROVIDER_QUALITY_CHECK_JUDGE_UNAVAILABLE";
type QualityRule = QualityDialogue["graders"][number];
const CHECK_LEAKS = new Set([
  "check_answer_stated",
  "check_option_named",
  "check_answer_confirmed",
]);

const ruleName = (t: AiText["t"], grader: string) =>
  KNOWN_GRADERS.has(grader)
    ? t(`aiServices.check.details.rule.${grader}` as AiKey)
    : grader;
const ratio = (value: string) => {
  const [a, b] = value.split("/");
  return { found: Number(a) || 0, needed: Number(b) || 0 };
};
const listOf = (text: AiText, value: unknown) =>
  Array.isArray(value) ? text.list(value.map(String)) : String(value ?? "");

/** The plain-language sentence for one finding, with what the rule allows where it says so. */
export function findingText(text: AiText, finding: QualityFinding): string {
  const { t } = text;
  const [head = "", ...rest] = finding.code.split(":");
  const arg = rest.join(":"),
    detail = finding.detail ?? {};
  if (!FINDINGS.has(head))
    return t("aiServices.check.details.finding.other", { code: finding.code });
  switch (head) {
    case "check_answer":
      return t(
        `aiServices.check.details.finding.check_answer.${CHECK_LEAKS.has(arg) ? arg : "check_answer_stated"}` as AiKey,
      );
    case "too_few_anchors":
    case "too_few_sources":
      return t(`aiServices.check.details.finding.${head}` as AiKey, ratio(arg));
    case "too_many_needs": {
      const { found, needed } = ratio(arg);
      return t("aiServices.check.details.finding.too_many_needs", {
        count: found,
        max: needed,
      });
    }
    case "objective_not_supplied":
      return t("aiServices.check.details.finding.objective_not_supplied", {
        named: listOf(text, detail.named),
        supplied: listOf(text, detail.supplied),
      });
    case "missing_fact":
      return t("aiServices.check.details.finding.missing_fact", {
        fact: String(detail.fact ?? arg),
      });
    case "false_claim":
      return detail.why
        ? t("aiServices.check.details.finding.false_claim", {
            why: String(detail.why),
          })
        : t("aiServices.check.details.finding.false_claim_generic");
    case "tool_not_allowed":
      return t("aiServices.check.details.finding.tool_not_allowed", {
        tool: arg,
        allowed: listOf(text, detail.allowed),
      });
    case "tool_forbidden":
      return t("aiServices.check.details.finding.tool_forbidden", {
        tool: arg,
      });
    case "quote_not_learner_text":
      return t("aiServices.check.details.finding.quote_not_learner_text", {
        criterion: arg,
      });
    case "no_answer":
      return t("aiServices.check.details.finding.no_answer", {
        reason: arg || "empty",
      });
    default:
      return t(`aiServices.check.details.finding.${head}` as AiKey);
  }
}

const RTL_LETTER = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;
const STRONG =
  /[A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;
/** Whether a line reads right to left: its first strong letter is Hebrew or Arabic. */
function rtlLine(line: string) {
  const first = STRONG.exec(line);
  return !!first && RTL_LETTER.test(first[0]);
}
/** Inline math as the model wrote it ($-5$, $3 + 5 = 8$): an opening $ before a non-space, a
 * closing $ after a non-space and not before a digit, so prices ($5 and $10) stay text. */
const MATH = /\$(?=\S)([^$\n]*?\S)\$(?!\d)/g;
const TEX: [RegExp, string][] = [
  [/\\(?:left|right)\b/g, ""],
  [/\\text\{([^{}]*)\}/g, "$1"],
  [/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, "$1/$2"],
  [/\\sqrt\{([^{}]*)\}/g, "√$1"],
  [/\\times\b/g, "×"],
  [/\\cdot\b/g, "·"],
  [/\\div\b/g, "÷"],
  [/\\pm\b/g, "±"],
  [/\\(?:leq|le)\b/g, "≤"],
  [/\\(?:geq|ge)\b/g, "≥"],
  [/\\(?:neq|ne)\b/g, "≠"],
  [/\\approx\b/g, "≈"],
  [/\\to\b/g, "→"],
  [/\\[,;! ]/g, " "],
];
const tex = (source: string) =>
  TEX.reduce((value, [pattern, to]) => value.replace(pattern, to), source);
/** A run of left-to-right words inside a right-to-left line, with its own punctuation. */
const LATIN_RUN =
  /[A-Za-z][^\n\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]*[^\s\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]|[A-Za-z]/g;

/**
 * A piece of a model's or learner's text, readable in either direction: inline math without its $
 * delimiters, kept left to right; and in a line that reads right to left (Hebrew with an English
 * sentence in it), each English run isolated, so its own punctuation stays with it ("…position?").
 * `line` is the whole line the piece is part of, which decides its direction.
 */
function readable(piece: string, line: (at: number) => string, at: number) {
  const parts: ReactNode[] = [];
  let index = 0;
  const plain = (value: string, start: number) => {
    if (!value) return;
    if (!rtlLine(line(start))) {
      parts.push(value);
      return;
    }
    let last = 0;
    for (const run of value.matchAll(LATIN_RUN)) {
      if (run.index > last) parts.push(value.slice(last, run.index));
      parts.push(
        <bdi key={`l${start + run.index}`} dir="ltr">
          {run[0]}
        </bdi>,
      );
      last = run.index + run[0].length;
    }
    if (last < value.length) parts.push(value.slice(last));
  };
  for (const math of piece.matchAll(MATH)) {
    plain(piece.slice(index, math.index), at + index);
    parts.push(
      <bdi key={`m${at + math.index}`} dir="ltr" className="ai-math">
        {tex(math[1]!)}
      </bdi>,
    );
    index = math.index + math[0].length;
  }
  plain(piece.slice(index), at + index);
  return parts;
}

/** Text with the failing passages marked and removed private text shown as a marker. */
function Highlighted({ value, marks }: { value: string; marks: string[] }) {
  const { t } = useAiText();
  const needles = [
    REDACTED,
    ...new Set(marks.map((m) => m.trim()).filter((m) => m.length >= 2)),
  ];
  const ranges: [number, number][] = [];
  for (const needle of needles) {
    const pattern = new RegExp(
      needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"),
      "giu",
    );
    for (const found of value.matchAll(pattern))
      ranges.push([found.index, found.index + found[0].length]);
  }
  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const line = (offset: number) => {
    const from = value.lastIndexOf("\n", offset - 1) + 1,
      to = value.indexOf("\n", offset);
    return value.slice(from, to < 0 ? undefined : to);
  };
  const parts: ReactNode[] = [];
  let at = 0;
  for (const [start, end] of ranges) {
    if (start < at) continue;
    if (start > at) parts.push(...readable(value.slice(at, start), line, at));
    const piece = value.slice(start, end);
    parts.push(
      piece === REDACTED ? (
        <span key={start} className="ai-redacted">
          {t("aiServices.check.details.redacted")}
        </span>
      ) : (
        <mark key={start} className="ai-flagged">
          {readable(piece, line, start)}
        </mark>
      ),
    );
    at = end;
  }
  parts.push(...readable(value.slice(at), line, at));
  return <>{parts}</>;
}

/** A quoted passage: the model's words or a fixture's, in their own direction. */
function Quote({ children }: { children: string }) {
  return (
    <bdi className="ai-quote" dir="auto">
      <Highlighted value={children} marks={[]} />
    </bdi>
  );
}

/** Passed, failed, or (`undetermined`) neither, because the judge could not run. */
function Pill({
  passed,
  undetermined,
}: {
  passed: boolean;
  undetermined?: boolean | undefined;
}) {
  const { t } = useAiText();
  if (!passed && undetermined)
    return (
      <span className="ai-pill muted">
        <CircleHelp size={15} aria-hidden="true" />
        {t("aiServices.check.details.notJudged")}
      </span>
    );
  return (
    <span className={`ai-pill ${passed ? "ok" : "bad"}`}>
      {passed ? (
        <CheckCircle2 size={15} aria-hidden="true" />
      ) : (
        <XCircle size={15} aria-hidden="true" />
      )}
      {passed
        ? t("aiServices.check.details.pass")
        : t("aiServices.check.details.fail")}
    </span>
  );
}

/**
 * "Details of each conversation" under a finished quality check: closed until opened, then every
 * practice conversation by job (failures first), with what it tests, what the model was given and
 * answered, and each rule's result with the reason and evidence of a failure.
 */
export function CheckDetails({
  check,
  source,
}: {
  check: QualityCheck;
  source: DetailsSource;
}) {
  const text = useAiText();
  const { t } = text;
  const [open, setOpen] = useState(false);
  const [details, setDetails] = useState<QualityDetails | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [onlyFailed, setOnlyFailed] = useState(false);
  const load = source.port.qualityCheckDetails?.bind(source.port);
  useEffect(() => {
    if (!open || !load || details?.checkId === check.id) return;
    const controller = new AbortController();
    setFailed(false);
    load(source.workspaceId, check.id, controller.signal)
      .then(setDetails)
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [open, load, check.id, source.workspaceId, details, attempt]);
  if (
    !load ||
    (check.state !== "passed" &&
      check.state !== "failed" &&
      check.reason !== JUDGE_UNAVAILABLE)
  )
    return null;
  const ready = details?.checkId === check.id ? details : null;
  const all = ready?.roles.flatMap((r) => r.dialogues) ?? [];
  const failedCount = all.filter((d) => !d.passed).length;
  return (
    <details
      className="ai-sub ai-dialogues"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>{t("aiServices.check.details.title")}</summary>
      {!open ? null : failed ? (
        <div role="alert" className="ai-dialogues-state">
          <p>{t("aiServices.check.details.loadFailed")}</p>
          <button
            type="button"
            className="button secondary"
            onClick={() => setAttempt((n) => n + 1)}
          >
            {t("aiServices.check.details.retry")}
          </button>
        </div>
      ) : !ready ? (
        <SkeletonRows label={t("aiServices.check.details.loading")} rows={3} />
      ) : !ready.recorded ? (
        <p className="ai-dialogues-state">
          {t("aiServices.check.details.notRecorded")}
        </p>
      ) : (
        <>
          <p className="ai-muted">{t("aiServices.check.details.intro")}</p>
          {failedCount > 0 && failedCount < all.length && (
            <label className="ai-check ai-dialogue-filter">
              <input
                type="checkbox"
                checked={onlyFailed}
                onChange={(event) => setOnlyFailed(event.target.checked)}
              />
              {t("aiServices.check.details.onlyFailed", {
                count: failedCount,
              })}
            </label>
          )}
          {ready.roles.map((role) => (
            <JobDialogues
              key={role.role}
              {...role}
              onlyFailed={onlyFailed && failedCount > 0}
            />
          ))}
        </>
      )}
    </details>
  );
}

function JobDialogues({
  role,
  dialogues,
  onlyFailed,
}: {
  role: string;
  dialogues: QualityDialogue[];
  /** Show only the conversations that did not pass (the others stay in the list, hidden). */
  onlyFailed: boolean;
}) {
  const { t } = useAiText();
  const failed = dialogues.filter((d) => !d.passed).length;
  const ordered = [
    ...dialogues.filter((d) => !d.passed),
    ...dialogues.filter((d) => d.passed),
  ];
  return (
    <section className="ai-dialogue-job" aria-label={jobName(t, role)}>
      <h4>
        {jobName(t, role)}
        <span className="ai-muted">
          {failed
            ? t("aiServices.check.details.jobFailed", {
                failed,
                count: dialogues.length,
              })
            : t("aiServices.check.details.jobPassed", {
                count: dialogues.length,
              })}
        </span>
      </h4>
      <ol className="ai-dialogue-list">
        {ordered.map((d) => (
          <li key={d.position} hidden={onlyFailed && d.passed}>
            <Dialogue dialogue={d} />
          </li>
        ))}
      </ol>
    </section>
  );
}

function Dialogue({ dialogue }: { dialogue: QualityDialogue }) {
  const text = useAiText();
  const { t } = text;
  const broken = dialogue.graders.filter((g) => !g.passed && !g.undetermined);
  const unjudged = dialogue.graders.filter((g) => g.undetermined);
  const noAnswer =
    broken.length > 0 &&
    broken.every((g) =>
      g.findings.every((f) => f.code.startsWith("no_answer")),
    );
  const marks = broken.flatMap((g) =>
    g.findings.flatMap((f) => (f.match ? [f.match] : [])),
  );
  const shownRules = dialogue.graders.filter((g) => g.applies);
  const persona = PERSONAS.has(dialogue.purpose.persona)
    ? t(`aiServices.check.details.persona.${dialogue.purpose.persona}` as AiKey)
    : dialogue.purpose.persona;
  return (
    <details
      className={`ai-dialogue ${dialogue.passed ? "passed" : dialogue.undetermined ? "undetermined" : "failed"}`}
      data-dialogue={dialogue.dialogueId}
    >
      <summary>
        <span className="ai-dialogue-row">
          <Pill passed={dialogue.passed} undetermined={dialogue.undetermined} />
          <span className="ai-tag">{persona}</span>
          <span className="ai-dialogue-purpose" dir="auto">
            {dialogue.purpose.description}
          </span>
          {!dialogue.passed && broken.length > 0 && (
            <span className="ai-dialogue-broken">
              <span>
                {noAnswer
                  ? t("aiServices.check.details.noAnswerShort")
                  : t("aiServices.check.details.broke")}
              </span>
              {/* Two rules by name, then how many more: the row stays one line. */}
              {!noAnswer &&
                broken.slice(0, SHOWN_RULES).map((g) => (
                  <span key={g.grader} className="ai-pill bad">
                    {ruleName(t, g.grader)}
                  </span>
                ))}
              {!noAnswer && broken.length > SHOWN_RULES && (
                <span
                  className="ai-pill bad"
                  title={text.list(
                    broken.slice(SHOWN_RULES).map((g) => ruleName(t, g.grader)),
                  )}
                >
                  {t("aiServices.check.details.moreRules", {
                    count: broken.length - SHOWN_RULES,
                  })}
                </span>
              )}
            </span>
          )}
          {!noAnswer && unjudged.length > 0 && (
            <span className="ai-dialogue-broken">
              <span>{t("aiServices.check.details.notJudgedList")}</span>
              {unjudged.map((g) => (
                <span key={g.grader} className="ai-pill muted">
                  {ruleName(t, g.grader)}
                </span>
              ))}
            </span>
          )}
          <ChevronRight
            size={18}
            aria-hidden="true"
            className="ai-chevron flip-rtl"
          />
        </span>
      </summary>
      <div className="ai-dialogue-body">
        <div className="ai-dialogue-block">
          <h5>{t("aiServices.check.details.purpose")}</h5>
          <p dir="auto">{dialogue.purpose.description}</p>
          <p className="ai-muted">
            {t("aiServices.check.details.personaLine", {
              explain: PERSONAS.has(dialogue.purpose.persona)
                ? t(
                    `aiServices.check.details.personaExplain.${dialogue.purpose.persona}` as AiKey,
                  )
                : persona,
            })}
          </p>
          <p className="ai-muted">
            {t("aiServices.check.details.lesson")}{" "}
            <bdi dir="auto">{dialogue.lesson.title}</bdi>
          </p>
          <p className="ai-muted">
            {t("aiServices.check.details.course")}{" "}
            <bdi dir="auto">{dialogue.lesson.course}</bdi>
          </p>
          <p className="ai-lesson-summary ai-muted" dir="auto">
            {dialogue.lesson.summary}
          </p>
        </div>
        {/* What the model was given beside what it answered, on a wide page. */}
        <div className="ai-dialogue-io">
          <Received dialogue={dialogue} />
          <Reply dialogue={dialogue} marks={marks} />
        </div>
        <div className="ai-dialogue-block">
          <h5>{t("aiServices.check.details.rules")}</h5>
          {noAnswer ? (
            <p>{findingText(text, broken[0]!.findings[0]!)}</p>
          ) : (
            <ul className="ai-rule-results">
              {shownRules.map((g) => (
                <li
                  key={g.grader}
                  className={
                    g.passed
                      ? "passed"
                      : g.undetermined
                        ? "undetermined"
                        : "failed"
                  }
                >
                  <div className="ai-rule-result-head">
                    <Pill passed={g.passed} undetermined={g.undetermined} />
                    <span>{ruleName(t, g.grader)}</span>
                  </div>
                  {g.judge && <JudgedBy rule={g} />}
                  {!g.passed && !g.undetermined && (
                    <ul className="ai-findings">
                      {groupFindings(
                        text,
                        g.findings.filter(
                          (f) =>
                            !f.code.startsWith("judge_failed") &&
                            !f.code.startsWith("judge_unavailable"),
                        ),
                      ).map((group) => (
                        <Finding key={group.sentence} {...group} />
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )}
          {!noAnswer && shownRules.length < dialogue.graders.length && (
            <p className="ai-muted">
              {t("aiServices.check.details.notApplicable", {
                count: dialogue.graders.length - shownRules.length,
              })}
            </p>
          )}
        </div>
      </div>
    </details>
  );
}

/**
 * A rule a reviewer model judged by meaning: which model judged (labelled when it judged its own
 * reply), and for a fail its reasons and the passages it quoted, which are marked in the reply.
 * When it could not run, says so: the rule has no result.
 */
function JudgedBy({ rule }: { rule: QualityRule }) {
  const { t } = useAiText();
  const i18n = useI18n();
  const judge = rule.judge!;
  const model = {
    model: (children: ReactNode, key: string | number) => (
      <Ltr key={key} className="mono">
        {children}
      </Ltr>
    ),
  };
  if (judge.state === "unavailable")
    return (
      <p className="ai-judged ai-judged-by">
        {i18n.rich(
          "aiServices.check.details.judgeUnavailable",
          { model: judge.model, reason: judge.reason ?? "" },
          model,
        )}
      </p>
    );
  const quotes = rule.findings.flatMap((f) =>
    f.code === "judge_failed" && f.match ? [f.match] : [],
  );
  return (
    <div className="ai-judged">
      <p className="ai-judged-by ai-muted">
        {i18n.rich(
          judge.self
            ? "aiServices.check.details.judgedBySelf"
            : "aiServices.check.details.judgedBy",
          { model: judge.model },
          model,
        )}
      </p>
      {!rule.passed && judge.reasons.length > 0 && (
        <div className="ai-evidence">
          <span>{t("aiServices.check.details.judgeReasons")}</span>
          <ul className="ai-judge-reasons">
            {judge.reasons.map((reason, i) => (
              <li key={i} dir="auto">
                {reason}
              </li>
            ))}
          </ul>
        </div>
      )}
      {!rule.passed && (
        <Evidence label={t("aiServices.check.details.wrote")} quotes={quotes} />
      )}
    </div>
  );
}

/** Findings that read the same, together: one sentence, then every passage it is about. */
function groupFindings(text: AiText, findings: QualityFinding[]) {
  const groups = new Map<
    string,
    { sentence: string; finding: QualityFinding; matches: string[] }
  >();
  for (const finding of findings) {
    const sentence = findingText(text, finding);
    const group = groups.get(sentence) ?? { sentence, finding, matches: [] };
    if (finding.match && !group.matches.includes(finding.match))
      group.matches.push(finding.match);
    groups.set(sentence, group);
  }
  return [...groups.values()];
}

function Finding({
  sentence,
  finding,
  matches,
}: {
  sentence: string;
  finding: QualityFinding;
  matches: string[];
}) {
  const { t } = useAiText();
  const detail = finding.detail ?? {};
  const missing = Array.isArray(detail.missing) ? detail.missing : [];
  return (
    <li>
      <p>{sentence}</p>
      <Evidence label={t("aiServices.check.details.wrote")} quotes={matches} />
      {typeof detail.checkPrompt === "string" && (
        <Evidence
          label={t("aiServices.check.details.theCheck")}
          quotes={[detail.checkPrompt]}
        />
      )}
      {typeof detail.answer === "string" && (
        <Evidence
          label={t("aiServices.check.details.checkAnswer")}
          quotes={[detail.answer]}
        />
      )}
      <Evidence
        label={t("aiServices.check.details.missingTerms")}
        quotes={missing}
      />
      {typeof detail.quote === "string" && detail.quote && (
        <Evidence
          label={t("aiServices.check.details.itsQuote")}
          quotes={[detail.quote]}
        />
      )}
    </li>
  );
}

/** A label and the quoted passages it names, each kept whole in its own direction. */
function Evidence({ label, quotes }: { label: string; quotes: string[] }) {
  if (!quotes.length) return null;
  return (
    <div className="ai-evidence">
      <span>{label}</span>
      {quotes.map((quote, i) => (
        <Quote key={i}>{quote}</Quote>
      ))}
    </div>
  );
}

/** What the model was given: the learner's messages, earlier answers, a rubric or a topic. */
function Received({ dialogue }: { dialogue: QualityDialogue }) {
  const { t } = useAiText();
  const { input } = dialogue;
  return (
    <div className="ai-dialogue-block">
      <h5>{t("aiServices.check.details.received")}</h5>
      {input.topic && (
        <p>
          {t("aiServices.check.details.topic")} <Quote>{input.topic}</Quote>
        </p>
      )}
      {input.attempts.length > 0 && (
        <>
          <p className="ai-muted">{t("aiServices.check.details.attempts")}</p>
          <ul className="ai-attempts">
            {input.attempts.map((a, i) => (
              <li key={i}>
                <span className={`ai-pill ${a.passed ? "ok" : "bad"}`}>
                  {a.passed
                    ? t("aiServices.check.details.attemptRight")
                    : t("aiServices.check.details.attemptWrong")}
                </span>{" "}
                <span dir="auto">{a.prompt}</span>
                {a.feedback && (
                  <span className="ai-muted ai-rule-explain" dir="auto">
                    {a.feedback}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {input.rubric && (
        <div className="ai-rubric">
          <p>
            {t("aiServices.check.details.rubricPrompt")}{" "}
            <Quote>{input.rubric.prompt}</Quote>
          </p>
          <p className="ai-muted">
            {t("aiServices.check.details.rubricCriteria")}
          </p>
          <ul className="ai-list">
            {input.rubric.criteria.map((c) => (
              <li key={c.id} dir="auto">
                <Ltr className="mono">{c.id}</Ltr> {c.description}
              </li>
            ))}
          </ul>
        </div>
      )}
      <ol
        className="ai-chat"
        aria-label={t("aiServices.check.details.received")}
      >
        {input.history.map((turn, i) => (
          <li key={i} className={`ai-bubble ${turn.speaker}`}>
            <span className="ai-bubble-who">
              {turn.speaker === "learner"
                ? t("aiServices.check.details.learner")
                : t("aiServices.check.details.earlierReply")}
            </span>
            <p dir="auto">
              <Highlighted value={turn.text} marks={[]} />
            </p>
          </li>
        ))}
        {input.rubric ? (
          <li className="ai-bubble learner">
            <span className="ai-bubble-who">
              {t("aiServices.check.details.learnerAnswer")}
            </span>
            <p dir="auto">
              <Highlighted value={input.rubric.response} marks={[]} />
            </p>
          </li>
        ) : (
          <li className="ai-bubble learner">
            <span className="ai-bubble-who">
              {dialogue.purpose.strategy?.startsWith("core.supervisor")
                ? t("aiServices.check.details.request")
                : t("aiServices.check.details.learner")}
            </span>
            <p dir="auto">
              <Highlighted value={input.question} marks={[]} />
            </p>
          </li>
        )}
      </ol>
    </div>
  );
}

/** Provider causes the page explains in words; any other code is shown as it is. */
const PROVIDER_CAUSES = new Set([
  "MAX_TOKENS_THINKING",
  "MAX_TOKENS",
  "THOUGHTS_ONLY",
  "EMPTY_OUTPUT",
  "NO_CANDIDATE",
  "NO_FINISH_REASON",
  "SAFETY",
]);
/** The model's answer as returned, with the failing passages marked. */
function Reply({
  dialogue,
  marks,
}: {
  dialogue: QualityDialogue;
  marks: string[];
}) {
  const { t } = useAiText();
  const { reply } = dialogue;
  const kind = REPLY_KINDS.has(reply.kind) ? reply.kind : "other";
  return (
    <div className="ai-dialogue-block">
      <h5>{t(`aiServices.check.details.reply.${kind}` as AiKey)}</h5>
      {reply.text !== null ? (
        <div className="ai-reply" dir="auto">
          <Highlighted value={reply.text} marks={marks} />
        </div>
      ) : (
        <p className="ai-reply ai-reply-none">
          {t("aiServices.check.details.noReply")}
          {reply.reason && (
            <>
              {" "}
              <Ltr className="mono">{reply.reason}</Ltr>
            </>
          )}
        </p>
      )}
      {reply.text === null && reply.providerReason && (
        <p className="ai-reply-cause">
          {PROVIDER_CAUSES.has(reply.providerReason)
            ? t(
                `aiServices.check.details.cause.${reply.providerReason}` as AiKey,
              )
            : t("aiServices.check.details.cause.other")}{" "}
          <Ltr className="mono">{reply.providerReason}</Ltr>
        </p>
      )}
      {reply.truncated && (
        <p className="ai-muted">{t("aiServices.check.details.truncated")}</p>
      )}
      {reply.tools && (
        <>
          <p className="ai-muted">
            {reply.tools.length
              ? t("aiServices.check.details.tools", {
                  count: reply.tools.length,
                })
              : t("aiServices.check.details.noTools")}
          </p>
          <ol className="ai-tool-calls">
            {reply.tools.map((tool, i) => (
              <li key={i} className={tool.allowed ? "" : "failed"}>
                <Ltr className="mono ai-tool-name">{tool.name}</Ltr>
                {!tool.allowed && (
                  <span className="ai-pill bad">
                    {t("aiServices.check.details.toolNotAllowed")}
                  </span>
                )}
                {tool.args && (
                  <Ltr className="mono ai-tool-args">{tool.args}</Ltr>
                )}
              </li>
            ))}
          </ol>
        </>
      )}
      {reply.needs && reply.needs.length > 0 && (
        <>
          <p className="ai-muted">{t("aiServices.check.details.needs")}</p>
          <ul className="ai-list">
            {reply.needs.map((n, i) => (
              <li key={i}>
                <Ltr className="mono">{n.objectiveId}</Ltr> ·{" "}
                <Ltr className="mono">{n.proposedAction}</Ltr>{" "}
                <span dir="auto">
                  <Highlighted value={n.reason} marks={marks} />
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      {reply.criteria && reply.criteria.length > 0 && (
        <>
          <p className="ai-muted">{t("aiServices.check.details.criteria")}</p>
          <ul className="ai-list">
            {reply.criteria.map((c, i) => (
              <li key={i}>
                <Ltr className="mono">{c.criterionId}</Ltr>{" "}
                <span className={`ai-pill ${c.met ? "ok" : "warn"}`}>
                  {c.met
                    ? t("aiServices.check.details.met")
                    : t("aiServices.check.details.notMet")}
                </span>
                {c.quote && (
                  <>
                    {" "}
                    <Quote>{c.quote}</Quote>
                  </>
                )}
                {c.note && (
                  <span className="ai-muted ai-rule-explain" dir="auto">
                    {c.note}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {reply.sources !== undefined && (
        <p className="ai-muted">
          {t("aiServices.check.details.sources", { count: reply.sources })}
        </p>
      )}
    </div>
  );
}
