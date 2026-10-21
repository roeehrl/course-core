import React, { useEffect, useRef, useState } from "react";
import type { ContentBlock, Episode } from "@course-core/sdk";
import type { Challenge, ServerSnapshot } from "../client/apiClient";
import { MarkdownContent } from "../components/MarkdownContent";
import { VisualBlock } from "../components/VisualBlock";
import type { VisualCompletionReport, VisualContextChange } from "../components/VisualBlock";
import { ReviewedMedia } from "../components/ReviewedMedia";
import { SourceLinks } from "../components/SourceLinks";
import { EpisodeResources } from "../components/EpisodeResources";
import type { ResourcesClient } from "../client/resourcesClient";
import { ReviewStatus, type ReviewAppeal, type ReviewReply, type ReviewsLoader } from "../components/ReviewStatus";
import {
  Badge,
  Button,
  ChoiceList,
  Field,
  Notice,
  styles,
} from "../components/ui";
import { Text, View } from "react-native";
import { mediaAvailability } from "./resources";
import { CodeEditor } from "../components/CodeEditor";
import { browserRunsAllowed, codeSubmissionError } from "./code";
import { AssessmentInput, ConfidenceInput, answerPayload, isCode, isWritten } from "./AssessmentInput.web";
import { GateDecisionPanel } from "./GateDecision.web";
import type { NextAction } from "@course-core/sdk";
import { UnverifiedBadge, type UnverifiedContent } from "./unverified.web";
import { GeneratedComponentPanel, type GeneratedComponent } from "./GeneratedComponent.web";
import { lessonSteps, nowAndNext, stepStatusLabels, stepStatusMarks, type LessonStepView } from "./lessonSteps";
import type { ActivityClient } from "../client/activityClient";
import { ActivityBlock } from "./ActivityBlock.web";
import { useT } from "../i18n";
import { courseContentAttributes } from "../domain/contentLanguage";

type Readable = Extract<ContentBlock, { type: "text" | "visual" | "media" }>;
export interface ConnectedLessonProps {
  server: ServerSnapshot;
  episode: Episode;
  placement: boolean;
  pending: boolean;
  now: number;
  answer: string;
  checkingAnswer?: boolean;
  policyPanel?: React.ReactNode;
  /** Generated interactive components by `${episodeId}/${blockId}` (see GeneratedComponent.web.tsx). */
  components?: Map<string, GeneratedComponent>;
  /** Generated additions waiting for a safe point in this lesson (see pendingChanges.web.tsx). */
  pendingChanges?: React.ReactNode;
  resources?: ResourcesClient;
  reviews?: ReviewsLoader;
  onReviewReply?: ReviewReply;
  onReviewAppeal?: ReviewAppeal;
  onAnswerChange: (answer: string) => void;
  onRead: (blockId: string) => void;
  onStart: () => void;
  onAnswer: (challenge: Challenge) => void;
  /** "I don't know yet": an explicit abstention that records no evidence. */
  onAbstain?: (challenge: Challenge) => void;
  confidence?: number | null;
  onConfidenceChange?: (value: number | null) => void;
  /** A next step offered by the server's gate decision. */
  onGateAction?: (action: NextAction) => void;
  /** Ask staff to review the current checkpoint decision. */
  onGateReview?: (reason: string) => Promise<unknown>;
  onSolution: (challenge: Challenge) => void;
  onComplete: () => void;
  onNormal: () => void;
  onRefresh: () => void;
  onBlockChange: (
    blockId: string | undefined,
    title: string | undefined,
  ) => void;
  onVisualContextChange?: (change: VisualContextChange) => void;
  /** A visual block was watched to its end: an observation for the host to record. */
  onVisualComplete?: (completion: VisualCompletionReport) => void;
  /** Generated, not person-reviewed parts of this learner's course. */
  unverified?: UnverifiedContent;
  /** Opens the personal change that added generated content. */
  onReviewChange?: (proposalId: string) => void;
  /** Runs the lesson's interactive activities through the server's capability broker. */
  activities?: ActivityClient;
  /** An activity step was completed on the server; reload the lesson state. */
  onActivityChanged?: () => void;
  /** Opens the learner's current step on the path, after an optional detour or a revisit. */
  onReturn?: (episodeId: string) => void;
}
/**
 * Where the learner goes back to when this lesson is a detour from their path: an optional lesson
 * (authored or added for them) or a finished one they are revisiting, while their current step is
 * elsewhere. Names the current lesson and the part they stopped at. Null when this is the path.
 */
export function returnPoint(server: ServerSnapshot, episode: Episode, placement: boolean) {
  const currentId = server.nextEpisodeId;
  if (placement || !currentId || currentId === episode.id) return null;
  const lesson = server.lessons.find((row) => row.id === episode.id);
  const optional = episode.requirement === "optional" || server.adaptationRequirements?.some((r) => r.episodeId === episode.id && r.insertedEpisode && r.classification === "optional");
  const revisit = lesson?.status === "completed" || lesson?.status === "placed";
  if (!optional && !revisit) return null;
  const target = server.course.chapters.flatMap((chapter) => chapter.episodes).find((row) => row.id === currentId);
  if (!target) return null;
  const read = server.lessons.find((row) => row.id === currentId)?.completedBlockIds ?? [];
  const parts = target.blocks.filter((block) => ["text", "visual", "media"].includes(block.type));
  const unread = parts.findIndex((block) => !read.includes(block.id));
  return { kind: optional ? ("optional" as const) : ("revisit" as const), episodeId: target.id, title: target.title,
    where: unread >= 0 ? ("part" as const) : ("check" as const), part: unread + 1, total: parts.length };
}
export function ConnectedLesson(props: ConnectedLessonProps) {
  const t = useT();
  const { server, episode, placement, pending, now } = props;
  const progress = server.lessons.find((row) => row.id === episode.id);
  const recovery=server.recovery?.find(row=>row.episodeId===episode.id);
  const reading = episode.blocks.filter((block): block is Readable =>
    ["text", "visual", "media"].includes(block.type),
  );
  const next = reading.find(
    (block) => !progress?.completedBlockIds.includes(block.id),
  );
  // Interactive activity steps: each is done only when the server says so (an evaluator's pass,
  // or an accepted observation for practice activities).
  const activityBlocks = episode.blocks.filter((block) => block.type === "activity");
  const activitiesLeft = activityBlocks.filter((block) => !progress?.completedBlockIds.includes(block.id)).length;
  const [reviewId, setReviewId] = useState<string>();
  // The part the learner just marked read. Its button goes away once the server confirms, so
  // focus moves to what comes next (the next part, else the check) instead of falling to the page.
  const markedRead = useRef<string | null>(null);
  // Likewise the check just answered: its form goes away with the server's result, so focus moves
  // to the check's heading, right above the result and what to do next.
  const answered = useRef<string | null>(null);
  useEffect(() => {
    setReviewId(undefined);
  }, [episode.id]);
  const current = reading.find((block) => block.id === reviewId) ?? next;
  const index = current ? reading.indexOf(current) : -1;
  const closed = server.inaccessibleEpisodeIds.includes(episode.id);
  const blockedMedia = reading.some(
    (block) =>
      block.type === "media" &&
      !mediaAvailability(
        server.course.media.find((m) => m.id === block.mediaId),
        closed,
        now,
        block.required,
        t,
      ).canAcknowledge,
  );
  const challenge = server.activeChallenges.find(
    (row) => row.episodeId === episode.id,
  );
  const expired = Boolean(
    challenge?.expiresAt &&
    (!Number.isFinite(Date.parse(challenge.expiresAt)) ||
      Date.parse(challenge.expiresAt) <= now),
  );
  const completed =
    progress?.status === "completed" || progress?.status === "placed";
  const canComplete =
    !pending &&
    !blockedMedia &&
    (!next || placement) &&
    (placement || activitiesLeft === 0) &&
    (!episode.gateId || progress?.gate?.passed || Boolean(progress?.gate?.exception)) &&
    !completed;
  useEffect(() => {
    const id = markedRead.current;
    if (!id || !progress?.completedBlockIds.includes(id)) return;
    markedRead.current = null;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    const target =
      document.querySelector<HTMLElement>(".connected-lesson-keeper:not([hidden]) .connected-reading-card[data-reading-part]") ??
      document.querySelector<HTMLElement>(".connected-lesson-keeper:not([hidden]) #connected-check-title");
    target?.focus({ preventScroll: false });
  }, [progress?.completedBlockIds]);
  const challengeId = server.activeChallenges.find((row) => row.episodeId === episode.id)?.challengeId;
  useEffect(() => {
    const id = answered.current;
    if (!id || challengeId === id) return;
    answered.current = null;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    document.querySelector<HTMLElement>(".connected-lesson-keeper:not([hidden]) #connected-check-title")?.focus();
  }, [challengeId]);
  const steps = lessonSteps(server, episode, t);
  const detour = returnPoint(server, episode, placement);
  const place = nowAndNext(steps);
  const blockTitle = current
    ? t("connectedLesson.partOf", { number: index + 1, total: reading.length })
    : challenge
      ? t("connectedLesson.independentCheck")
      : undefined;
  useEffect(() => {
    props.onBlockChange(current?.id, blockTitle);
  }, [current?.id, blockTitle, props.onBlockChange]);
  function renderBlock(block: Readable) {
    const media =
      block.type === "media"
        ? server.course.media.find((row) => row.id === block.mediaId)
        : undefined;
    const ids =
      block.type === "text" ? block.sourceRefs : media ? [media.sourceRef] : [];
    return (
      <>
        {block.type === "text" ? (
          <>
            <div className="connected-prose" {...courseContentAttributes(server.course)}>
              <MarkdownContent markdown={block.markdown} />
            </div>
            {/* A generated component runs beside its text alternative, in the sandboxed runner. */}
            {props.components?.has(`${episode.id}/${block.id}`) && (
              <GeneratedComponentPanel component={props.components.get(`${episode.id}/${block.id}`)!} />
            )}
          </>
        ) : block.type === "visual" ? (
          <VisualBlock
            source={{ episodeId: episode.id, blockId: block.id, episodeTitle: episode.title }}
            onContextChange={props.onVisualContextChange}
            onComplete={props.onVisualComplete}
            companionAvailable={server.studyArm?.companion !== false}
            experience={server.course.visuals.find(
              (visual) => visual.id === block.visualId,
            )}
          />
        ) : (
          <ReviewedMedia
            media={media}
            accessClosed={closed}
            now={now}
            required={block.type === "media" ? block.required : true}
            companionAvailable={server.studyArm?.companion !== false}
          />
        )}
        <SourceLinks sources={server.course.sources} sourceIds={ids ?? []} />
      </>
    );
  }
  return (
    <div className="connected-lesson">
      <header className="connected-lesson-heading">
        <div className="connected-kicker">
          {placement ? t("connectedLesson.kicker.placement") : t("connectedLesson.kicker.path")}
          <span>
            {completed
              ? t("connectedLesson.kicker.saved")
              : next
                ? t("connectedLesson.kicker.reading")
                : t("connectedLesson.kicker.checking")}
          </span>
        </div>
        <h1 tabIndex={-1} data-reading-heading {...courseContentAttributes(server.course)}>
          {episode.title}
        </h1>
        {props.unverified?.episodes.has(episode.id) && (
          <UnverifiedBadge
            what="lesson"
            {...(props.onReviewChange ? { onReview: () => props.onReviewChange!(props.unverified!.episodes.get(episode.id)!) } : {})}
          />
        )}
        <p {...courseContentAttributes(server.course)}>
          {episode.objectiveIds
            .map(
              (id) =>
                server.course.objectives.find((row) => row.id === id)
                  ?.description,
            )
            .filter(Boolean)
            .join(" ")}
        </p>
        {!placement && !closed && (
          <dl className="connected-now-next" aria-label={t("connectedLesson.place.label")}>
            <div>
              <dt>{t("connectedLesson.place.now")}</dt>
              <dd>
                {place.now
                  ? place.now.status === "under_review"
                    ? t("connectedLesson.place.underReview", { title: place.now.title })
                    : place.now.title
                  : t("connectedLesson.place.allComplete")}
              </dd>
            </div>
            <div>
              <dt>{t("connectedLesson.place.next")}</dt>
              <dd>{place.next?.title ?? (place.now ? t("connectedLesson.place.lastStep") : t("connectedLesson.place.continuePath"))}</dd>
            </div>
          </dl>
        )}
      </header>
      {detour && (
        <div className="connected-detour" role="note" data-testid="detour-return">
          <p>
            {t(detour.kind === "optional" ? "connectedLesson.detour.optional" : "connectedLesson.detour.revisit", {
              title: detour.title,
              where: detour.where,
              part: detour.part,
              total: detour.total,
            })}
          </p>
          {props.onReturn && (
            <Button label={t("connectedLesson.detour.return", { title: detour.title })} kind="quiet" onPress={() => props.onReturn!(detour.episodeId)} />
          )}
        </div>
      )}
      {props.policyPanel}
      {props.pendingChanges}
      {closed ? (
        <Notice error>{t("connectedLesson.accessClosed")}</Notice>
      ) : (
        <>
          {placement ? (
            <Notice>{t("connectedLesson.placementNotice")}</Notice>
          ) : (
            <>
              <LessonStepList
                steps={steps}
                parts={reading.length}
                partsRead={reading.filter((block) => progress?.completedBlockIds.includes(block.id)).length}
              />
              {current && (
                <article
                  className="connected-reading-card"
                  aria-label={t("connectedLesson.readingPart", { number: index + 1 })}
                  data-reading-part
                  tabIndex={-1}
                >
                  <div className="connected-part-top">
                    <span>{t("connectedLesson.partOfEyebrow", { number: index + 1, total: reading.length })}</span>
                    {progress?.completedBlockIds.includes(current.id) && (
                      <Badge label={t("connectedLesson.read")} />
                    )}
                    {props.unverified?.blocks.has(`${episode.id}/${current.id}`) && (
                      <UnverifiedBadge
                        what="part"
                        {...(props.onReviewChange
                          ? { onReview: () => props.onReviewChange!(props.unverified!.blocks.get(`${episode.id}/${current.id}`)!) }
                          : {})}
                      />
                    )}
                  </div>
                  {renderBlock(current)}
                  {!progress?.completedBlockIds.includes(current.id) && (
                    <Button
                      label={t("connectedLesson.markRead")}
                      kind="primary"
                      usability="next"
                      disabled={
                        pending ||
                        next?.id !== current.id ||
                        (current.type === "media" &&
                          !mediaAvailability(
                            server.course.media.find(
                              (m) => m.id === current.mediaId,
                            ),
                            closed,
                            now,
                            current.required,
                            t,
                          ).canAcknowledge)
                      }
                      onPress={() => {
                        markedRead.current = current.id;
                        props.onRead(current.id);
                      }}
                    />
                  )}
                  {reviewId && (
                    <Button
                      label={t("connectedLesson.returnToCurrent")}
                      kind="quiet"
                      onPress={() => setReviewId(undefined)}
                    />
                  )}
                </article>
              )}
              {progress?.completedBlockIds.some((id) =>
                reading.some((block) => block.id === id),
              ) && (
                <details className="connected-review">
                  <summary>{t("connectedLesson.reviewReading")}</summary>
                  <div>
                    {reading
                      .filter((block) =>
                        progress.completedBlockIds.includes(block.id),
                      )
                      .map((block) => (
                        <button
                          className="connected-link-button"
                          type="button"
                          key={block.id}
                          onClick={() => setReviewId(block.id)}
                        >
                          {t("connectedLesson.part", { number: reading.indexOf(block) + 1 })}
                        </button>
                      ))}
                  </div>
                </details>
              )}
            </>
          )}
          {!placement && props.activities && activityBlocks.length > 0 && (
            <div className="connected-activities">
              {activityBlocks.map((block) => (
                <ActivityBlock
                  key={block.id}
                  client={props.activities!}
                  enrollmentId={server.enrollmentId}
                  episodeId={episode.id}
                  blockId={block.id}
                  done={Boolean(progress?.completedBlockIds.includes(block.id))}
                  disabled={pending}
                  onChanged={() => props.onActivityChanged?.()}
                />
              ))}
            </div>
          )}
          {props.reviews && (
            <ReviewStatus loader={props.reviews} enrollmentId={server.enrollmentId} episodeId={episode.id} revision={server.revision} {...(props.onReviewReply ? { onReply: props.onReviewReply } : {})} {...(props.onReviewAppeal ? { onAppeal: props.onReviewAppeal } : {})} />
          )}
          {!placement && (
            <EpisodeResources
              client={props.resources}
              enrollmentId={server.enrollmentId}
              episodeId={episode.id}
            />
          )}
          {blockedMedia && (
            <Notice error>{t("connectedLesson.mediaBlocked")}</Notice>
          )}
          {episode.gateId && (
            <section
              className="connected-check"
              aria-labelledby="connected-check-title"
            >
              <div>
                <p className="connected-eyebrow">{t("connectedLesson.check.eyebrow")}</p>
                <h2 id="connected-check-title" tabIndex={-1}>{t("connectedLesson.check.title")}</h2>
                <p>{t("connectedLesson.check.intro")}</p>
              </div>
              {progress?.gate?.status && props.onGateAction && (
                <GateDecisionPanel gate={progress.gate} pending={pending} onAction={props.onGateAction} {...(props.onGateReview ? { onRequestReview: props.onGateReview } : {})} />
              )}
              <ul className="connected-check-progress">
                {progress?.gate?.objectives.map((objective) => (
                  <li key={objective.id}>
                    <span {...courseContentAttributes(server.course)}>
                      {
                        server.course.objectives.find(
                          (row) => row.id === objective.id,
                        )?.description
                      }
                    </span>
                    <strong>
                      {t("connectedLesson.check.objectiveProgress", { done: objective.families.length, required: objective.required })}
                    </strong>
                  </li>
                ))}
              </ul>
              {challenge ? (
                expired ? (
                  <Notice error>
                    {t("connectedLesson.check.expired")}
                    <Button
                      label={t("connectedLesson.check.refresh")}
                      onPress={props.onRefresh}
                      disabled={pending}
                    />
                  </Notice>
                ) : (
                  <View style={{ gap: 18 }}>
                    <Badge
                      label={
                        challenge.independentEligible
                          ? t("connectedLesson.check.independent")
                          : t("connectedLesson.check.practice")
                      }
                      tone={challenge.independentEligible ? "mint" : "sand"}
                    />
                    {props.unverified?.questions.has(challenge.question.id) && (
                      <UnverifiedBadge
                        what="question"
                        {...(props.onReviewChange
                          ? { onReview: () => props.onReviewChange!(props.unverified!.questions.get(challenge.question.id)!) }
                          : {})}
                      />
                    )}
                    <div {...courseContentAttributes(server.course)}>
                      <MarkdownContent markdown={challenge.question.prompt} />
                    </div>
                    <AssessmentInput
                      key={challenge.challengeId}
                      question={challenge.question}
                      answer={props.answer}
                      pending={pending}
                      onChange={props.onAnswerChange}
                      practiceRuns={browserRunsAllowed(challenge.mode)}
                    />
                    <ConfidenceInput
                      question={challenge.question}
                      value={props.confidence ?? null}
                      pending={pending}
                      onChange={(value) => props.onConfidenceChange?.(value)}
                    />
                    <div className="connected-answer-actions">
                    <Button
                      label={
                        isCode(challenge.question)
                          ? props.checkingAnswer
                            ? t("connectedLesson.answer.checkingCode")
                            : t("connectedLesson.answer.runCode")
                          : isWritten(challenge.question)
                            ? pending
                              ? t("connectedLesson.answer.submitting")
                              : t("connectedLesson.answer.submitForReview")
                          : pending
                            ? t("connectedLesson.answer.saving")
                            : t("connectedLesson.answer.check")
                      }
                      kind="primary"
                      usability="next"
                      disabled={
                        pending ||
                        "error" in answerPayload(challenge.question, props.answer, t) ||
                        ((challenge.question.type === "code" || challenge.question.type === "code_repair") &&
                          Boolean(
                            codeSubmissionError(
                              challenge.question.language,
                              props.answer,
                              t,
                            ),
                          ))
                      }
                      onPress={() => {
                        answered.current = challenge.challengeId;
                        props.onAnswer(challenge);
                      }}
                    />
                    {challenge.question.allowAbstain !== false && props.onAbstain && (
                      <Button
                        label={t("connectedLesson.abstain.label")}
                        kind="secondary"
                        disabled={pending}
                        accessibilityLabel={t("connectedLesson.abstain.accessibilityLabel")}
                        onPress={() => {
                          answered.current = challenge.challengeId;
                          props.onAbstain!(challenge);
                        }}
                      />
                    )}
                    </div>
                    {challenge.question.allowAbstain !== false && props.onAbstain && (
                      <p className="connected-input-hint">
                        {t("connectedLesson.abstain.hint")}
                      </p>
                    )}
                    {isCode(challenge.question) &&
                      props.checkingAnswer && (
                        <Text
                          accessibilityRole="text"
                          accessibilityLiveRegion="polite"
                          style={styles.small}
                        >
                          {t("connectedLesson.answer.waitingForGrader")}
                        </Text>
                      )}
                    {["choice", "numeric", "prediction", "trace"].includes(challenge.question.type) && (
                      <Button
                        label={t("connectedLesson.answer.showExplanation")}
                        kind="quiet"
                        disabled={pending}
                        onPress={() => props.onSolution(challenge)}
                      />
                    )}
                  </View>
                )
              ) : progress?.gate?.passed ? (
                <Notice>{t("connectedLesson.check.complete")}</Notice>
              ) : !placement && next ? (
                <p className="connected-next-hint">
                  {t("connectedLesson.check.nextHint")}
                </p>
              ) : recovery?.required&&!recovery.freshCheck ? (
                <Notice>{t("connectedLesson.check.recoveryNeeded")}</Notice>
              ) : (
                <Button
                  label={recovery?.freshCheck ? t("connectedLesson.check.fresh", { minutes: recovery.freshCheck.plannedMinutes }) : t("connectedLesson.check.start")}
                  kind="primary"
                  usability="next"
                  disabled={pending || blockedMedia}
                  onPress={props.onStart}
                />
              )}
            </section>
          )}
          {completed ? (
            <Notice>{t("connectedLesson.saved")}</Notice>
          ) : (
            <div className="connected-complete">
              <Button
                label={
                  placement
                    ? t("connectedLesson.complete.placement")
                    : t("connectedLesson.complete.episode")
                }
                kind={canComplete ? "primary" : "quiet"}
                {...(canComplete ? { usability: "next" as const } : {})}
                disabled={!canComplete}
                onPress={props.onComplete}
              />
              {!canComplete && (
                <p>{t("connectedLesson.complete.hint")}</p>
              )}
            </div>
          )}
          {placement && (
            <Button
              label={t("connectedLesson.readInstead")}
              kind="quiet"
              onPress={props.onNormal}
              disabled={pending}
            />
          )}
        </>
      )}
    </div>
  );
}

/** Every step of the lesson in words and a shape, never colour alone. */
function LessonStepList({ steps, parts, partsRead }: { steps: LessonStepView[]; parts: number; partsRead: number }) {
  const t = useT();
  const done = steps.filter((step) => step.status === "completed").length;
  return (
    <div className="connected-reading-progress">
      <p id="connected-steps-summary">
        {parts > 0
          ? t("connectedLesson.steps.summaryWithParts", { partsRead, parts, done, steps: steps.length })
          : t("connectedLesson.steps.summary", { done, steps: steps.length })}
      </p>
      <ol className="connected-steps" aria-labelledby="connected-steps-summary">
        {steps.map((step) => (
          <li
            key={step.id}
            className={`connected-step is-${step.status.replace(/_/g, "-")}`}
            aria-current={step.status === "current" ? "step" : undefined}
          >
            <span className="connected-step-mark" aria-hidden="true">
              {stepStatusMarks[step.status]}
            </span>
            <span className="connected-step-title">{step.title}</span>
            <span className="connected-step-status">{t(stepStatusLabels[step.status])}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
