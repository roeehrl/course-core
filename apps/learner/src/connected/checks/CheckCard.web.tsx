import React, { useEffect, useId, useRef, useState } from "react";
import type { Episode, NextAction } from "@course-core/sdk";
import type { Challenge, GateView, ServerSnapshot } from "../../client/apiClient";
import { companionFocus } from "../../client/companionFocus";
import { MarkdownContent } from "../../components/MarkdownContent";
import { Icon } from "../../components/icons/Icon.web";
import { Button, Notice } from "../../components/ui";
import { courseContentAttributes } from "../../domain/contentLanguage";
import { useT } from "../../i18n";
import { answerResult } from "../answerFeedback";
import { AssessmentInput, ConfidenceInput, answerPayload, isCode, isWritten } from "../AssessmentInput.web";
import { browserRunsAllowed, codeSubmissionError } from "../code";
import { questionOrdinal } from "../checkOrdinal";
import { companionBridge, lessonNavigator } from "../companion/bridge";
import { KindLine } from "../credit/KindLine.web";
import { GateDecisionPanel } from "../GateDecision.web";
import { FreshCheckButton, QuestionsExhausted } from "../lessonRecovery.web";
import { InlineConfirm } from "../ui/InlineConfirm.web";
import { highlightBlock } from "../ui/highlight";
import { UnverifiedBadge, type UnverifiedContent } from "../unverified.web";
import { CheckFeedback } from "./CheckFeedback.web";
import { ExplanationPanel, SolutionViewed } from "./ExplanationPanel.web";
import { HelpRow } from "./HelpRow.web";
import { HintArea, HintButton, NO_HINTS, hintLevels, type HintProgress } from "./HintLadder.web";
import { ReplyNudge } from "./ReplyNudge.web";
import type { CheckCommands } from "./useCheckCommands";

type Recovery = NonNullable<ServerSnapshot["recovery"]>[number];
export interface CheckCardProps {
  server: ServerSnapshot;
  episode: Episode;
  /** The open question of this lesson, if one was issued. */
  challenge?: Challenge;
  gate?: GateView | null;
  placement: boolean;
  pending: boolean;
  now: number;
  answer: string;
  onAnswerChange: (answer: string) => void;
  check: CheckCommands;
  /** The check opens once every part is read: until then it only says what follows. */
  waitingForReading: boolean;
  questionsLeft: number;
  questionsTotal: number;
  /** The number of the lesson's last part. */
  lastPart: number;
  /** Required media the learner cannot play yet. */
  blockedMedia: boolean;
  recovery?: Recovery;
  unverified?: UnverifiedContent;
  onReviewChange?: (proposalId: string) => void;
  onGateAction?: (action: NextAction) => void;
  onGateReview?: (reason: string) => Promise<unknown>;
  onRefresh: () => void;
  onQuestionsExhausted?: (episodeId: string) => Promise<boolean>;
}

/** Item types whose explanation the server can show before an answer (assessment-routes.ts). */
const EXPLAINED = ["choice", "numeric", "prediction", "trace"];
/** The first control of a group, for moving focus into it. */
const firstControl = (root: HTMLElement | null) =>
  root?.querySelector<HTMLElement>("button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [role='radio']") ?? null;

/**
 * The lesson's check (§4.1): the question, its answer and "Check", the help bar, the feedback in
 * place, the help row, hints, the explanation and the decision. Everything the check says about an
 * answer stays in it, under the question, and is announced once by its status region.
 */
export function CheckCard({
  server,
  episode,
  challenge,
  gate,
  placement,
  pending,
  now,
  answer,
  onAnswerChange,
  check,
  waitingForReading,
  questionsLeft,
  questionsTotal,
  lastPart,
  blockedMedia,
  recovery,
  unverified,
  onReviewChange,
  onGateAction,
  onGateReview,
  onRefresh,
  onQuestionsExhausted,
}: CheckCardProps) {
  const t = useT();
  const ids = useId();
  const progress = server.lessons.find((row) => row.id === episode.id);
  // The learner answered (or chose "I don't know yet") in this lesson while on the page: the
  // checkpoint's suggestions are then relevant even before the server has any evidence.
  const [answeredHere, setAnsweredHere] = useState(false);
  // The check just answered: once the server has its result, focus moves to the check's heading
  // (or, after "I don't know yet", into the help that opens), and the result is brought into view.
  const answered = useRef<{ id: string; abstain: boolean } | null>(null);
  const checkHead = useRef<HTMLDivElement>(null);
  const section = useRef<HTMLElement>(null);
  const feedbackSlot = useRef<HTMLDivElement>(null);
  const helpRow = useRef<HTMLDivElement>(null);
  const questionBlock = useRef<HTMLDivElement>(null);
  /** Focus goes into the help row once it shows (after "I don't know yet"). */
  const focusHelp = useRef(false);
  // The help row of a question (by challenge id): "Get help" toggles it; a wrong answer and "I
  // don't know yet" open it.
  const [helpOpen, setHelpOpen] = useState<Record<string, boolean>>({});
  // Help rows the learner opened ("Get help"): those fade in (M17). A row that opens with the
  // server's answer appears with it, at once.
  const [helpAsked, setHelpAsked] = useState<Record<string, boolean>>({});
  // What waits for "Show hint as practice" / "Show as practice" on a counted question.
  const [confirming, setConfirming] = useState<{ id: string; what: "hint" | "explanation" } | null>(null);
  // Explanations folded open per question, and hints shown per question (by question id).
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [hintProgress, setHintProgress] = useState<Record<string, HintProgress>>({});
  useEffect(() => {
    setAnsweredHere(false);
  }, [episode.id]);
  const expired = Boolean(
    challenge?.expiresAt &&
    (!Number.isFinite(Date.parse(challenge.expiresAt)) ||
      Date.parse(challenge.expiresAt) <= now),
  );
  // The question in view: the open one, or the one just answered (kept until the next arrives).
  const attempt = check.attempts?.[episode.id];
  const kept = attempt && (!challenge || challenge.challengeId === attempt.challenge.challengeId) ? attempt : undefined;
  const shown = challenge ?? kept?.challenge;
  const settled = kept && kept.status === "answered" ? kept : undefined;
  const result = settled ? answerResult(settled.receipt, settled.code, t) : undefined;
  /** The question can still be answered here. */
  const open = Boolean(challenge) && !settled;
  const checking = kept?.status === "checking";
  const challengeId = challenge?.challengeId;
  const shownId = shown?.challengeId;
  const ordinal = questionOrdinal(server, episode.id);
  const reveal = (target: HTMLElement | null) =>
    requestAnimationFrame(() => target?.scrollIntoView?.({ block: "nearest", inline: "nearest" }));
  /** "Check" and the help bar are disabled or gone while the answer is saved, so the focus they
   * had falls to the page: it is put back in the check rather than left there. */
  const focusLost = () => {
    const active = document.activeElement;
    return !active || active === document.body || !active.isConnected;
  };
  const keptStatus = kept?.status;
  useEffect(() => {
    const done = answered.current;
    if (!done || !kept || kept.challenge.challengeId !== done.id || kept.status === "checking") return;
    answered.current = null;
    // The grader could not check it: the question stays open, and its feedback with the retry
    // comes into view under the answer bar, with focus on the retry when it had none.
    if (kept.status === "failed") {
      if (focusLost()) feedbackSlot.current?.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
      reveal(feedbackSlot.current);
      return;
    }
    // After "I don't know yet" the help row opens with focus on its first control (§4.2), once it
    // is on the page (the effect below).
    if (done.abstain) {
      focusHelp.current = true;
      return;
    }
    const active = document.activeElement;
    if (!active || active === document.body || !active.isConnected || section.current?.contains(active))
      document.querySelector<HTMLElement>(".connected-lesson-keeper:not([hidden]) #connected-check-title")?.focus({ preventScroll: true });
    reveal(checkHead.current);
    reveal(feedbackSlot.current);
  }, [keptStatus, kept?.challenge.challengeId]);
  useEffect(() => {
    if (!focusHelp.current || !helpRow.current) return;
    focusHelp.current = false;
    firstControl(helpRow.current)?.focus({ preventScroll: true });
    reveal(helpRow.current);
  });
  // A wrong answer and "I don't know yet" open the help row; on a practice question with hints,
  // "I don't know yet" also opens the first hint (§4.2).
  const settledId = settled?.challenge.challengeId;
  useEffect(() => {
    if (!settled || !result) return;
    const id = settled.challenge.challengeId, questionId = settled.challenge.question.id;
    if (result.verdict === "revisit" || result.verdict === "codeFailed" || result.verdict === "abstained")
      setHelpOpen((all) => ({ ...all, [id]: true }));
    if (result.verdict !== "abstained") {
      // One more try counts toward the third hint.
      setHintProgress((all) => {
        const current = all[questionId];
        return current && current.shown >= 2 ? { ...all, [questionId]: { ...current, triesAfterSecond: current.triesAfterSecond + 1 } } : all;
      });
    } else if (!settled.challenge.independentEligible && hintLevels(settled.challenge.question.hints).length)
      setHintProgress((all) => (all[questionId]?.shown ? all : { ...all, [questionId]: { shown: 1, triesAfterSecond: 0 } }));
  }, [settledId]);
  // "Show me the question" from elsewhere (bridge.ts): the check comes into view, highlighted, and
  // its first answer control takes focus when asked.
  useEffect(
    () =>
      lessonNavigator.register((target) => {
        if (!target.challengeId || target.challengeId !== challengeId || (target.episodeId && target.episodeId !== episode.id)) return false;
        const node = section.current;
        if (!node) return false;
        node.scrollIntoView({ block: "start" });
        highlightBlock(node);
        if (target.focus === "answer")
          node.querySelector<HTMLElement>("input:not([disabled]), textarea:not([disabled]), [role='radio'], [role='checkbox']")?.focus({ preventScroll: true });
        return true;
      }),
    [challengeId, episode.id],
  );
  // A checkpoint the learner has not engaged with yet reads neutral: no decision, no suggestions.
  const engaged = answeredHere || Boolean(gate && (
    (gate.status && gate.status !== "needs_evidence") || gate.passed || gate.review || gate.exception ||
    gate.objectives.some((objective) => objective.families.length > 0) ||
    (gate.criterionResults ?? []).some((criterion) => criterion.met !== false)));
  // Why "Check" is not available yet, said next to it.
  const answerHint = (() => {
    if (!challenge || pending || !open) return undefined;
    const payload = answerPayload(challenge.question, answer, t);
    if (!("error" in payload)) return undefined;
    if (challenge.question.type === "choice" && !answer.trim()) return t("checkCard.answer.chooseFirst");
    if (!answer.trim()) return t("checkCard.answer.enterFirst");
    return challenge.question.type === "trace" ? payload.error : undefined;
  })();
  const canSubmit = Boolean(
    challenge && open && !pending &&
    !("error" in answerPayload(challenge.question, answer, t)) &&
    !((challenge.question.type === "code" || challenge.question.type === "code_repair") && codeSubmissionError(challenge.question.language, answer, t)),
  );
  const submit = () => {
    if (!challenge || !canSubmit) return;
    answered.current = { id: challenge.challengeId, abstain: false };
    setAnsweredHere(true);
    setConfirming(null);
    check.onAnswer(challenge);
  };
  // A new question can be started from here (the lesson is not finished and has questions left).
  const canStart = !challenge && !progress?.gate?.passed && !(recovery?.required && !recovery.freshCheck);
  const fieldError = challenge ? check.fieldErrors?.[challenge.challengeId] : undefined;
  const fieldErrorId = `${ids}-field-error`;
  // A refusal under the field (nothing was recorded): the learner answers again there, so the
  // field takes back the focus the saving request took.
  useEffect(() => {
    if (!fieldError) return;
    answered.current = null;
    if (focusLost()) firstControl(questionBlock.current?.querySelector<HTMLElement>(".cc-check-answer") ?? null)?.focus({ preventScroll: true });
  }, [fieldError, challengeId]);
  const explanationId = `${ids}-explanation`;
  const helpId = `${ids}-help`;

  /** The question block: the open question, or the one just answered with what follows it. */
  const question = (() => {
    if (!shown) return null;
    if (challenge && expired && !kept)
      return (
        <Notice error>
          {t("checkCard.check.expired")}
          <Button label={t("checkCard.check.refresh")} onPress={onRefresh} disabled={pending} />
        </Notice>
      );
    const shownAnswer = challenge && !settled ? answer : kept?.answer ?? "";
    const locked = !open || (check.savingAnswer ?? pending);
    const code = isCode(shown.question), written = isWritten(shown.question);
    // The explanation the server returned for this question (it is practice from then on), or, after
    // "I don't know yet", the author's explanation that came with the receipt.
    const served = check.explanations?.[shown.challengeId];
    const abstainedWith = result?.verdict === "abstained" && !result.coded ? result.explanation : undefined;
    // After an answer the explanation is already in the feedback: it is not offered twice.
    const explanation = settled && result?.verdict !== "abstained" ? undefined : served ?? abstainedWith;
    const canExplain = open && EXPLAINED.includes(shown.question.type);
    const isExpanded = Boolean(expanded[shown.challengeId] && explanation);
    const counted = open && shown.independentEligible;
    const hints = hintLevels(shown.question.hints);
    // Hints on a counted question would need the server to record them (onHint); without that
    // route the ladder is offered on practice questions and on questions already answered only.
    const hintsOffered = hints.length > 0 && (!counted || Boolean(check.onHint));
    const progressOfHints = hintProgress[shown.question.id] ?? NO_HINTS;
    const showHint = (level: number) =>
      setHintProgress((all) => {
        const current = all[shown.question.id] ?? NO_HINTS;
        return { ...all, [shown.question.id]: { ...current, shown: level, ...(level === 2 ? { secondShownAt: Date.now() } : {}) } };
      });
    const openHint = () => {
      const level = progressOfHints.shown + 1;
      if (counted && progressOfHints.shown === 0) setConfirming({ id: shown.challengeId, what: "hint" });
      else showHint(level);
    };
    const toggleExplanation = () => {
      if (explanation) {
        setExpanded((all) => ({ ...all, [shown.challengeId]: !all[shown.challengeId] }));
        return;
      }
      if (counted) {
        setConfirming({ id: shown.challengeId, what: "explanation" });
        return;
      }
      setExpanded((all) => ({ ...all, [shown.challengeId]: true }));
      check.onSolution(shown);
    };
    const keepCounted = () => {
      setConfirming(null);
      firstControl(questionBlock.current?.querySelector<HTMLElement>(".cc-check-answer") ?? null)?.focus({ preventScroll: true });
    };
    const wrong = result?.verdict === "revisit" || result?.verdict === "codeFailed";
    const helpShown = Boolean(helpOpen[shown.challengeId]) && (open || Boolean(settled));
    const confirm = confirming?.id === shown.challengeId ? confirming.what : null;
    const ask = () => {
      // An open question goes with the next message as its chip ("Question 1"); nothing is sent.
      if (open) companionFocus.setCheck({ challengeId: shown.challengeId, ordinal });
      companionBridge.compose({ source: "check" });
    };
    const checkLabel = written
      ? check.savingAnswer ?? pending ? t("checkCard.answer.submitting") : t("checkCard.answer.submitForReview")
      : t("checkCard.answer.check");
    return (
      <div className="cc-check-question" ref={questionBlock}>
        <KindLine challenge={shown} server={server} episodeId={episode.id} onFreshCheck={() => check.onStart()} />
        {unverified?.questions.has(shown.question.id) && (
          <UnverifiedBadge
            what="question"
            {...(onReviewChange
              ? { onReview: () => onReviewChange!(unverified!.questions.get(shown.question.id)!) }
              : {})}
          />
        )}
        <div className="cc-check-prompt" {...courseContentAttributes(server.course)}>
          <MarkdownContent markdown={shown.question.prompt} />
        </div>
        <div className={`cc-check-answer${settled ? " is-answered" : ""}`}>
          <AssessmentInput
            key={shown.challengeId}
            question={shown.question}
            answer={shownAnswer}
            pending={locked}
            onChange={onAnswerChange}
            practiceRuns={open && browserRunsAllowed(shown.mode)}
            onSubmit={submit}
            {...(fieldError ? { describedBy: fieldErrorId } : {})}
            actions={
              open || checking ? (
                <button
                  type="button"
                  className={`cc-check-submit${checking && !written ? " is-checking" : ""}`}
                  data-usability="next"
                  aria-describedby={answerHint ? "connected-answer-hint" : undefined}
                  disabled={!canSubmit || checking}
                  onClick={submit}
                >
                  {/* Both labels take the same cell, so the button keeps its width while it checks. */}
                  <span className="cc-check-submit-label" aria-hidden={checking && !written ? true : undefined}>{checkLabel}</span>
                  {!written && (
                    <span className="cc-check-submit-busy" aria-hidden={checking ? undefined : true}>
                      <span className="cc-check-spinner" />
                      {t("checkCard.answer.checking")}
                    </span>
                  )}
                </button>
              ) : null
            }
          />
        </div>
        {open && (
          <ConfidenceInput
            question={shown.question}
            value={check.confidence ?? null}
            pending={locked}
            onChange={(value) => check.onConfidenceChange?.(value)}
          />
        )}
        {answerHint && (
          <p className="connected-input-hint" id="connected-answer-hint">{answerHint}</p>
        )}
        {fieldError && open && (
          <p className="cc-check-field-error" id={fieldErrorId} role="alert">
            <Icon name="alert-circle" size={16} />
            <span>{t(fieldError === "copied" ? "checkCard.error.copied" : "checkCard.error.attemptRequired")}</span>
          </p>
        )}
        {/* Before an attempt: "I don't know yet" and "Get help", after "Check" in the Tab order. */}
        {open && !checking && (
          <div className="cc-check-help-bar">
            {shown.question.allowAbstain !== false && check.onAbstain && (
              <button
                type="button"
                className="cc-check-quiet"
                aria-label={t("checkCard.abstain.accessibilityLabel")}
                disabled={check.savingAnswer ?? pending}
                onClick={() => {
                  answered.current = { id: shown.challengeId, abstain: true };
                  setAnsweredHere(true);
                  setConfirming(null);
                  check.onAbstain!(shown);
                }}
              >
                {t("checkCard.abstain.label")}
              </button>
            )}
            <button
              type="button"
              className="cc-check-quiet"
              aria-expanded={helpShown}
              aria-controls={helpShown ? helpId : undefined}
              onClick={() => {
                setHelpOpen((all) => ({ ...all, [shown.challengeId]: !all[shown.challengeId] }));
                setHelpAsked((all) => ({ ...all, [shown.challengeId]: true }));
                if (helpShown) setConfirming(null);
              }}
            >
              {t("checkCard.help.getHelp")}
              <Icon name={helpShown ? "chevron-up" : "chevron-down"} size={16} />
            </button>
          </div>
        )}
        {/* Always mounted with the question, so a screen reader announces each result as it arrives. */}
        <div
          ref={feedbackSlot}
          className={`connected-answer-feedback${kept ? " is-filled" : ""}${checking ? " is-checking" : ""}`}
          role="status"
          aria-atomic="true"
        >
          {kept && <CheckFeedback attempt={kept} course={server.course} onRetry={() => check.onRetry?.(kept.challenge)} />}
        </div>
        {helpShown && (
          <HelpRow
            ref={helpRow}
            id={helpId}
            reveal={Boolean(helpAsked[shown.challengeId])}
            ordinal={ordinal}
            counted={counted}
            {...(wrong && canStart ? { onTryAgain: () => check.onStart() } : {})}
            hint={hintsOffered ? <HintButton hints={hints} progress={progressOfHints} onOpen={openHint} /> : undefined}
            onAsk={ask}
            {...(canExplain || explanation
              ? { explanation: { expanded: isExpanded || (expanded[shown.challengeId] === true && check.explaining === shown.challengeId), controls: explanationId, disabled: check.explaining === shown.challengeId, onToggle: toggleExplanation } }
              : {})}
          />
        )}
        {confirm === "hint" && (
          <InlineConfirm
            className="cc-check-confirm"
            sentence={t("hintLadder.confirm", { ordinal })}
            confirmLabel={t("hintLadder.showAsPractice")}
            cancelLabel={t("hintLadder.keepCounted")}
            onConfirm={() => {
              setConfirming(null);
              void check.onHint?.(shown).then(() => showHint(1), () => {});
            }}
            onCancel={keepCounted}
          />
        )}
        {confirm === "explanation" && (
          <InlineConfirm
            className="cc-check-confirm"
            sentence={t("helpRow.confirm.explanation", { ordinal })}
            confirmLabel={t("helpRow.confirm.showAsPractice")}
            cancelLabel={t("helpRow.confirm.keepCounted")}
            onConfirm={() => {
              setConfirming(null);
              setExpanded((all) => ({ ...all, [shown.challengeId]: true }));
              check.onSolution(shown);
              requestAnimationFrame(() => helpRow.current?.querySelector<HTMLElement>(".cc-check-explain")?.focus({ preventScroll: true }));
            }}
            onCancel={keepCounted}
          />
        )}
        {hintsOffered && <HintArea hints={hints} shown={progressOfHints.shown} course={server.course} />}
        {isExpanded && explanation && <ExplanationPanel id={explanationId} explanation={explanation} course={server.course} />}
        {(served !== undefined || shown.practiceReason === "solution") && <SolutionViewed />}
        <ReplyNudge challengeId={shownId} />
      </div>
    );
  })();

  return (
    <section
      ref={section}
      className={`connected-check ${waitingForReading ? "is-waiting" : ""}`}
      data-state={waitingForReading ? "after-reading" : "open"}
      aria-labelledby="connected-check-title"
    >
      <div className="connected-check-head" ref={checkHead}>
        <h2 id="connected-check-title" tabIndex={-1}>{t("checkCard.check.title")}</h2>
        <p>
          {waitingForReading
            ? t("checkCard.check.opensAfter", { count: questionsTotal, part: lastPart })
            : gate?.passed
              ? t("checkCard.check.doneIntro")
              : t("checkCard.check.introCount", { count: questionsLeft || questionsTotal })}
        </p>
      </div>
      {question}
      {!waitingForReading && engaged && gate?.status && onGateAction && (
        <GateDecisionPanel gate={gate} pending={pending} onAction={onGateAction} omitFreshCheck {...(onGateReview ? { onRequestReview: onGateReview } : {})} />
      )}
      {/* One objective: its count is already in the decision above. */}
      {!waitingForReading && engaged && !gate?.passed && (gate?.objectives.length ?? 0) > 1 && (
        <ul className="connected-check-progress">
          {gate!.objectives.map((objective) => (
            <li key={objective.id}>
              <span {...courseContentAttributes(server.course)}>
                {server.course.objectives.find((row) => row.id === objective.id)?.description}
              </span>
              <strong>
                {t("checkCard.check.objectiveProgress", { done: objective.families.length, required: objective.required })}
              </strong>
            </li>
          ))}
        </ul>
      )}
      {challenge ? null : progress?.gate?.passed ? (
        <Notice>{t("checkCard.check.complete")}</Notice>
      ) : waitingForReading ? null : recovery?.required && !recovery.freshCheck ? (
        <QuestionsExhausted episodeId={episode.id} onReport={onQuestionsExhausted} />
      ) : (
        recovery?.freshCheck ? (
          <FreshCheckButton minutes={recovery.freshCheck.plannedMinutes} disabled={pending || blockedMedia} onPress={() => check.onStart()} />
        ) : (
          <Button label={t("checkCard.check.start")} kind="primary" usability="next" disabled={pending || blockedMedia} onPress={() => check.onStart()} />
        )
      )}
    </section>
  );
}
