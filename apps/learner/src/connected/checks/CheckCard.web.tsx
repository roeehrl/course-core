import React, { useEffect, useRef, useState } from "react";
import type { Episode, NextAction } from "@course-core/sdk";
import { Text, View } from "react-native";
import type { Challenge, GateView, ServerSnapshot } from "../../client/apiClient";
import { MarkdownContent } from "../../components/MarkdownContent";
import { Button, Notice, styles } from "../../components/ui";
import { courseContentAttributes } from "../../domain/contentLanguage";
import { useT } from "../../i18n";
import { AssessmentInput, ConfidenceInput, answerPayload, isCode, isWritten } from "../AssessmentInput.web";
import { browserRunsAllowed, codeSubmissionError } from "../code";
import { GateDecisionPanel } from "../GateDecision.web";
import { FreshCheckButton, QuestionsExhausted } from "../lessonRecovery.web";
import { UnverifiedBadge, type UnverifiedContent } from "../unverified.web";
import { KindLine } from "../credit/KindLine.web";
import { lessonNavigator } from "../companion/bridge";
import { highlightBlock } from "../ui/highlight";
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

/** The lesson's check: the question, its answer and actions, the feedback, and the decision. */
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
  const progress = server.lessons.find((row) => row.id === episode.id);
  // The learner answered (or chose "I don't know yet") in this lesson while on the page: the
  // checkpoint's suggestions are then relevant even before the server has any evidence.
  const [answeredHere, setAnsweredHere] = useState(false);
  // The check just answered: its form goes away with the server's result, so focus moves to the
  // check's heading, right above the result and what to do next.
  const answered = useRef<string | null>(null);
  // Set when an answer is sent: its result is brought into view once it arrives. On a phone the
  // answer actions sit far below the check's heading, so the result would otherwise appear out of
  // sight. The heading and the result scroll only as far as needed to be seen (block "nearest"),
  // never to the top of the page.
  const revealResult = useRef(false);
  const checkHead = useRef<HTMLDivElement>(null);
  const section = useRef<HTMLElement>(null);
  const reveal = () =>
    requestAnimationFrame(() => checkHead.current?.scrollIntoView({ block: "nearest", inline: "nearest" }));
  useEffect(() => {
    setAnsweredHere(false);
  }, [episode.id]);
  const expired = Boolean(
    challenge?.expiresAt &&
    (!Number.isFinite(Date.parse(challenge.expiresAt)) ||
      Date.parse(challenge.expiresAt) <= now),
  );
  const challengeId = challenge?.challengeId;
  useEffect(() => {
    const id = answered.current;
    if (!id || challengeId === id) return;
    answered.current = null;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    document.querySelector<HTMLElement>(".connected-lesson-keeper:not([hidden]) #connected-check-title")?.focus({ preventScroll: true });
    reveal();
  }, [challengeId]);
  useEffect(() => {
    if (!check.answerFeedback || !revealResult.current) return;
    revealResult.current = false;
    reveal();
  }, [check.answerFeedback?.text]);
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
    if (!challenge || pending) return undefined;
    const payload = answerPayload(challenge.question, answer, t);
    if (!("error" in payload)) return undefined;
    if (challenge.question.type === "choice" && !answer.trim()) return t("checkCard.answer.chooseFirst");
    if (!answer.trim()) return t("checkCard.answer.enterFirst");
    return challenge.question.type === "trace" ? payload.error : undefined;
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
        {/* Always mounted, so a screen reader announces each result as it arrives. */}
        <div className="connected-answer-feedback" role="status" aria-atomic="true">
          {check.answerFeedback && <p data-tone={check.answerFeedback.tone}>{check.answerFeedback.text}</p>}
        </div>
      </div>
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
      {challenge ? (
        expired ? (
          <Notice error>
            {t("checkCard.check.expired")}
            <Button
              label={t("checkCard.check.refresh")}
              onPress={onRefresh}
              disabled={pending}
            />
          </Notice>
        ) : (
          <View style={{ gap: 18 }}>
            <KindLine challenge={challenge} server={server} episodeId={episode.id} pending={pending} onFreshCheck={() => check.onStart()} />
            {unverified?.questions.has(challenge.question.id) && (
              <UnverifiedBadge
                what="question"
                {...(onReviewChange
                  ? { onReview: () => onReviewChange!(unverified!.questions.get(challenge.question.id)!) }
                  : {})}
              />
            )}
            <div {...courseContentAttributes(server.course)}>
              <MarkdownContent markdown={challenge.question.prompt} />
            </div>
            <AssessmentInput
              key={challenge.challengeId}
              question={challenge.question}
              answer={answer}
              pending={check.savingAnswer ?? pending}
              onChange={onAnswerChange}
              practiceRuns={browserRunsAllowed(challenge.mode)}
            />
            <ConfidenceInput
              question={challenge.question}
              value={check.confidence ?? null}
              pending={check.savingAnswer ?? pending}
              onChange={(value) => check.onConfidenceChange?.(value)}
            />
            <div className="connected-answer-actions">
            <Button
              label={
                isCode(challenge.question)
                  ? check.checkingAnswer
                    ? t("checkCard.answer.checkingCode")
                    : t("checkCard.answer.runCode")
                  : isWritten(challenge.question)
                    ? pending
                      ? t("checkCard.answer.submitting")
                      : t("checkCard.answer.submitForReview")
                  : pending
                    ? t("checkCard.answer.saving")
                    : t("checkCard.answer.check")
              }
              kind="primary"
              usability="next"
              {...(answerHint ? { describedBy: "connected-answer-hint" } : {})}
              disabled={
                pending ||
                "error" in answerPayload(challenge.question, answer, t) ||
                ((challenge.question.type === "code" || challenge.question.type === "code_repair") &&
                  Boolean(
                    codeSubmissionError(
                      challenge.question.language,
                      answer,
                      t,
                    ),
                  ))
              }
              onPress={() => {
                answered.current = challenge.challengeId;
                revealResult.current = true;
                setAnsweredHere(true);
                check.onAnswer(challenge);
              }}
            />
            {challenge.question.allowAbstain !== false && check.onAbstain && (
              <Button
                label={t("checkCard.abstain.label")}
                kind="secondary"
                disabled={pending}
                accessibilityLabel={t("checkCard.abstain.accessibilityLabel")}
                onPress={() => {
                  answered.current = challenge.challengeId;
                  revealResult.current = true;
                  setAnsweredHere(true);
                  check.onAbstain!(challenge);
                }}
              />
            )}
            </div>
            {answerHint && (
              <p className="connected-input-hint" id="connected-answer-hint">{answerHint}</p>
            )}
            {challenge.question.allowAbstain !== false && check.onAbstain && (
              <p className="connected-input-hint">
                {t("checkCard.abstain.hint")}
              </p>
            )}
            {isCode(challenge.question) &&
              check.checkingAnswer && (
                <Text
                  accessibilityRole="text"
                  accessibilityLiveRegion="polite"
                  style={styles.small}
                >
                  {t("checkCard.answer.waitingForGrader")}
                </Text>
              )}
            {["choice", "numeric", "prediction", "trace"].includes(challenge.question.type) && (
              <Button
                label={challenge.independentEligible ? t("checkCard.answer.showExplanationCounted") : t("checkCard.answer.showExplanation")}
                kind="quiet"
                disabled={pending}
                onPress={() => check.onSolution(challenge)}
              />
            )}
          </View>
        )
      ) : progress?.gate?.passed ? (
        <Notice>{t("checkCard.check.complete")}</Notice>
      ) : waitingForReading ? null : recovery?.required&&!recovery.freshCheck ? (
        <QuestionsExhausted episodeId={episode.id} onReport={onQuestionsExhausted} />
      ) : (
        recovery?.freshCheck ? (
          <FreshCheckButton minutes={recovery.freshCheck.plannedMinutes} disabled={pending || blockedMedia} onPress={() => check.onStart()} />
        ) : (
          <Button label={t("checkCard.check.start")} kind="primary" usability="next" disabled={pending || blockedMedia} onPress={() => check.onStart()} />
        )
      )}
    </section>  );
}
