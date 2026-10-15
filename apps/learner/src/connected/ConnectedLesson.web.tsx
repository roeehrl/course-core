import React, { useEffect, useState } from "react";
import type { ContentBlock, Episode } from "@course-core/sdk";
import type { Challenge, ServerSnapshot } from "../client/apiClient";
import { MarkdownContent } from "../components/MarkdownContent";
import { VisualBlock } from "../components/VisualBlock";
import type { VisualContextChange } from "../components/VisualBlock";
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
import { codeSubmissionError } from "./code";
import { AssessmentInput, ConfidenceInput, answerPayload, isCode, isWritten } from "./AssessmentInput.web";
import { GateDecisionPanel } from "./GateDecision.web";
import type { NextAction } from "@course-core/sdk";

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
  onSolution: (challenge: Challenge) => void;
  onComplete: () => void;
  onNormal: () => void;
  onRefresh: () => void;
  onBlockChange: (
    blockId: string | undefined,
    title: string | undefined,
  ) => void;
  onVisualContextChange?: (change: VisualContextChange) => void;
}
export function ConnectedLesson(props: ConnectedLessonProps) {
  const { server, episode, placement, pending, now } = props;
  const progress = server.lessons.find((row) => row.id === episode.id);
  const recovery=server.recovery?.find(row=>row.episodeId===episode.id);
  const reading = episode.blocks.filter((block): block is Readable =>
    ["text", "visual", "media"].includes(block.type),
  );
  const next = reading.find(
    (block) => !progress?.completedBlockIds.includes(block.id),
  );
  const [reviewId, setReviewId] = useState<string>();
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
    (!episode.gateId || progress?.gate?.passed) &&
    !completed;
  const blockTitle = current
    ? `Part ${index + 1} of ${reading.length}`
    : challenge
      ? "Independent check"
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
          <MarkdownContent markdown={block.markdown} />
        ) : block.type === "visual" ? (
          <VisualBlock
            source={{ episodeId: episode.id, blockId: block.id, episodeTitle: episode.title }}
            onContextChange={props.onVisualContextChange}
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
          {placement ? "OPTIONAL PLACEMENT" : "YOUR LEARNING PATH"}
          <span>
            {completed
              ? "Saved"
              : next
                ? "Read · explore · check"
                : "Check · reflect · continue"}
          </span>
        </div>
        <h1 tabIndex={-1} data-reading-heading>
          {episode.title}
        </h1>
        <p>
          {episode.objectiveIds
            .map(
              (id) =>
                server.course.objectives.find((row) => row.id === id)
                  ?.description,
            )
            .filter(Boolean)
            .join(" ")}
        </p>
      </header>
      {props.policyPanel}
      {closed ? (
        <Notice error>This episode’s access window has closed.</Notice>
      ) : (
        <>
          {placement ? (
            <Notice>
              Placement uses fresh independent checks to verify what you already
              know. Reading is not marked complete. You can return to the normal
              lesson at any time.
            </Notice>
          ) : (
            <>
              {reading.length > 0 && (
                <div className="connected-reading-progress">
                  <span>
                    {progress?.completedBlockIds.filter((id) =>
                      reading.some((block) => block.id === id),
                    ).length ?? 0}{" "}
                    of {reading.length} parts read
                  </span>
                  <div className="connected-step-marks" aria-hidden="true">
                    {reading.map((block) => (
                      <span
                        key={block.id}
                        className={
                          progress?.completedBlockIds.includes(block.id)
                            ? "done"
                            : current?.id === block.id
                              ? "current"
                              : ""
                        }
                      />
                    ))}
                  </div>
                </div>
              )}
              {current && (
                <article
                  className="connected-reading-card"
                  aria-label={`Reading part ${index + 1}`}
                >
                  <div className="connected-part-top">
                    <span>
                      PART {index + 1} OF {reading.length}
                    </span>
                    {progress?.completedBlockIds.includes(current.id) && (
                      <Badge label="Read" />
                    )}
                  </div>
                  {renderBlock(current)}
                  {!progress?.completedBlockIds.includes(current.id) && (
                    <Button
                      label="Mark this part read"
                      kind="primary"
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
                          ).canAcknowledge)
                      }
                      onPress={() => props.onRead(current.id)}
                    />
                  )}
                  {reviewId && (
                    <Button
                      label="Return to current step"
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
                  <summary>Review your reading</summary>
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
                          Part {reading.indexOf(block) + 1}
                        </button>
                      ))}
                  </div>
                </details>
              )}
            </>
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
            <Notice error>
              A required media step is unavailable or awaiting review. Your
              progress is preserved. Contact your course team before completing
              this lesson.
            </Notice>
          )}
          {episode.gateId && (
            <section
              className="connected-check"
              aria-labelledby="connected-check-title"
            >
              <div>
                <p className="connected-eyebrow">PUT IT INTO PRACTICE</p>
                <h2 id="connected-check-title">Check your understanding</h2>
                <p>
                  Fresh problems show what you can do independently. You can ask
                  for help; that attempt then becomes practice.
                </p>
              </div>
              {progress?.gate?.status && props.onGateAction && (
                <GateDecisionPanel gate={progress.gate} pending={pending} onAction={props.onGateAction} />
              )}
              <ul className="connected-check-progress">
                {progress?.gate?.objectives.map((objective) => (
                  <li key={objective.id}>
                    <span>
                      {
                        server.course.objectives.find(
                          (row) => row.id === objective.id,
                        )?.description
                      }
                    </span>
                    <strong>
                      {objective.families.length}/{objective.required}{" "}
                      independent checks
                    </strong>
                  </li>
                ))}
              </ul>
              {challenge ? (
                expired ? (
                  <Notice error>
                    This check has expired. Refresh to get the current check.
                    Your answer draft is preserved.
                    <Button
                      label="Refresh check"
                      onPress={props.onRefresh}
                      disabled={pending}
                    />
                  </Notice>
                ) : (
                  <View style={{ gap: 18 }}>
                    <Badge
                      label={
                        challenge.independentEligible
                          ? "Independent attempt"
                          : "Practice · no independent credit"
                      }
                      tone={challenge.independentEligible ? "mint" : "sand"}
                    />
                    <MarkdownContent markdown={challenge.question.prompt} />
                    <AssessmentInput
                      key={challenge.challengeId}
                      question={challenge.question}
                      answer={props.answer}
                      pending={pending}
                      onChange={props.onAnswerChange}
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
                            ? "Checking code…"
                            : "Run code & check"
                          : isWritten(challenge.question)
                            ? pending
                              ? "Submitting…"
                              : "Submit for review"
                          : pending
                            ? "Saving…"
                            : "Check answer"
                      }
                      kind="primary"
                      disabled={
                        pending ||
                        "error" in answerPayload(challenge.question, props.answer) ||
                        ((challenge.question.type === "code" || challenge.question.type === "code_repair") &&
                          Boolean(
                            codeSubmissionError(
                              challenge.question.language,
                              props.answer,
                            ),
                          ))
                      }
                      onPress={() => props.onAnswer(challenge)}
                    />
                    {challenge.question.allowAbstain !== false && props.onAbstain && (
                      <Button
                        label="I don't know yet"
                        kind="secondary"
                        disabled={pending}
                        accessibilityLabel="I don't know yet: record no answer and get help"
                        onPress={() => props.onAbstain!(challenge)}
                      />
                    )}
                    </div>
                    {challenge.question.allowAbstain !== false && props.onAbstain && (
                      <p className="connected-input-hint">
                        “I don't know yet” records no wrong answer. You will be offered help and a fresh check.
                      </p>
                    )}
                    {isCode(challenge.question) &&
                      props.checkingAnswer && (
                        <Text
                          accessibilityRole="text"
                          accessibilityLiveRegion="polite"
                          style={styles.small}
                        >
                          Waiting for the server grader. No result has been
                          recorded here yet.
                        </Text>
                      )}
                    {["choice", "numeric", "prediction", "trace"].includes(challenge.question.type) && (
                      <Button
                        label="Show explanation · switch to practice"
                        kind="quiet"
                        disabled={pending}
                        onPress={() => props.onSolution(challenge)}
                      />
                    )}
                  </View>
                )
              ) : progress?.gate?.passed ? (
                <Notice>Your independent checks are complete.</Notice>
              ) : !placement && next ? (
                <p className="connected-next-hint">
                  Next: finish the current reading part, then start your
                  independent checks.
                </p>
              ) : recovery?.required&&!recovery.freshCheck ? (
                <Notice>A fresh independent check is needed. Your saved work remains available; ask your course team to enable a qualified recovery check.</Notice>
              ) : (
                <Button
                  label={recovery?.freshCheck?`Get a fresh check · ${recovery.freshCheck.plannedMinutes} min →`:"Start the next check →"}
                  kind="primary"
                  disabled={pending || blockedMedia}
                  onPress={props.onStart}
                />
              )}
            </section>
          )}
          {completed ? (
            <Notice>
              This lesson is saved. You can revisit its material any time access
              is available.
            </Notice>
          ) : (
            <div className="connected-complete">
              <Button
                label={
                  placement
                    ? "Apply verified placement →"
                    : "Complete episode →"
                }
                kind={canComplete ? "primary" : "quiet"}
                disabled={!canComplete}
                onPress={props.onComplete}
              />
              {!canComplete && (
                <p>Finish the reading and independent checks to continue.</p>
              )}
            </div>
          )}
          {placement && (
            <Button
              label="Read the lesson instead"
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
