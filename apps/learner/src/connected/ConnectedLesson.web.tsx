import React, { useEffect, useMemo, useRef, useState } from "react";
import type { ContentBlock, Episode } from "@course-core/sdk";
import type { ServerSnapshot } from "../client/apiClient";
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
  Notice,
} from "../components/ui";
import { mediaAvailability } from "./resources";
import type { NextAction } from "@course-core/sdk";
import { CheckCard } from "./checks/CheckCard.web";
import type { CheckCommands } from "./checks/useCheckCommands";
import { lessonNavigator } from "./companion/bridge";
import { highlightBlock } from "./ui/highlight";
import { UnverifiedBadge, type UnverifiedContent } from "./unverified.web";
import { LessonPlaceContext, type LessonPlace } from "./pendingChanges.web";
import { Icon } from "../components/icons/Icon.web";
import { GeneratedComponentPanel, type GeneratedComponent } from "./GeneratedComponent.web";
import { lessonSteps, nowAndNext, stepStatusLabels, type LessonStepView } from "./lessonSteps";
import type { ActivityClient } from "../client/activityClient";
import { ActivityBlock } from "./ActivityBlock.web";
import { PresenceRegion, type PresenceKind, type PresenceState, type ReportPresence } from "./presence.web";
import { useT } from "../i18n";
import { courseContentAttributes } from "../domain/contentLanguage";
import { textDirection } from "../components/ui";

type Readable = Extract<ContentBlock, { type: "text" | "visual" | "media" }>;
export interface ConnectedLessonProps {
  server: ServerSnapshot;
  episode: Episode;
  placement: boolean;
  pending: boolean;
  now: number;
  answer: string;
  /** What the lesson's check can do (connected/checks/useCheckCommands.ts), handed to it untouched. */
  check: CheckCommands;
  /** The lesson needs another independent question and none is left: tells the course team (the
   * server checks the state and notifies staff once). Resolves true once they were told. */
  onQuestionsExhausted?: (episodeId: string) => Promise<boolean>;
  /** Staff-only tools for this lesson (the debug inspector), shown small in the lesson's header. */
  staffTools?: React.ReactNode;
  /** Reports when the learner starts and stops using an interactive part (E03 safe boundary). */
  onPresence?: (episodeId: string, blockId: string, kind: PresenceKind, state: PresenceState, leaving?: boolean) => void;
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
  /** A next step offered by the server's gate decision. */
  onGateAction?: (action: NextAction) => void;
  /** Ask staff to review the current checkpoint decision. */
  onGateReview?: (reason: string) => Promise<unknown>;
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
/** A text block's container: the course's language when it declares one, else the direction of
 * the block's own first letter. (`dir="auto"` here resolved left to right for Hebrew text, since
 * the paragraphs inside carry their own `dir` and the algorithm skips them: a Hebrew reading sat at
 * the left of a wide card, its lines ending short of the right edge.) */
function proseAttributes(course: unknown, markdown: string) {
  const attributes = courseContentAttributes(course);
  return attributes.dir === "auto" ? { ...attributes, dir: textDirection(markdown) ?? "auto" } : attributes;
}

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
  // (The check moves focus to its own heading once an answer is checked: CheckCard.web.tsx.)
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
  // A part to show from elsewhere (bridge.ts): it becomes the part on screen, comes into view and
  // is highlighted.
  const readingIds = reading.map((block) => block.id).join(" ");
  const completedIds = progress?.completedBlockIds.join(" ") ?? "";
  // A part can be shown when it was read, or when it is the one to read next (the lesson's parts
  // open in order).
  const showable = (blockId: string) => readingIds.split(" ").includes(blockId) && (completedIds.split(" ").includes(blockId) || next?.id === blockId);
  useEffect(
    () =>
      lessonNavigator.register((target) => {
        if (!target.blockId || target.challengeId || (target.episodeId && target.episodeId !== episode.id)) return false;
        if (!showable(target.blockId)) return false;
        const read = completedIds.split(" ").includes(target.blockId);
        setReviewId(read ? target.blockId : undefined);
        requestAnimationFrame(() => {
          const card = document.querySelector<HTMLElement>(".connected-lesson-keeper:not([hidden]) .connected-reading-card[data-reading-part]");
          if (!card) return;
          card.scrollIntoView({ block: "start" });
          highlightBlock(card);
          if (target.focus === "block") card.focus({ preventScroll: true });
        });
        return true;
      }),
    // (`showable` reads only these.)
    [episode.id, readingIds, completedIds, next?.id],
  );
  // What the new-material offer needs to say whether an addition landed and where (pendingChanges.web.tsx).
  const place = useMemo<LessonPlace>(
    () => ({ planRevision: server.planRevision, episodeId: episode.id, blocks: episode.blocks, showable }),
    [server.planRevision, episode.id, episode.blocks, readingIds, completedIds, next?.id],
  );
  const steps = lessonSteps(server, episode, t);
  const detour = returnPoint(server, episode, placement);
  const allEpisodes = server.course.chapters.flatMap((row) => row.episodes);
  const lessonNumber = allEpisodes.findIndex((row) => row.id === episode.id) + 1;
  const chapter = server.course.chapters.find((row) => row.episodes.some((item) => item.id === episode.id));
  // The objective once, whole, in the header (the checkpoint below no longer repeats it).
  const objectiveText = episode.objectiveIds
    .map((id) => server.course.objectives.find((row) => row.id === id)?.description)
    .filter(Boolean)
    .join(" ");
  const gate = progress?.gate;
  // Questions still to answer correctly on your own: the families each objective still needs.
  const questionsLeft = (gate?.objectives ?? []).reduce((sum, objective) => sum + Math.max(0, objective.required - objective.families.length), 0);
  const questionsTotal = (gate?.objectives ?? []).reduce((sum, objective) => sum + objective.required, 0);
  const lastPart = reading.length;
  // The check opens once every part is read (the server issues no check before): until then the
  // section only says how many questions follow and when.
  const waitingForReading = !placement && Boolean(next) && !challenge && !gate?.passed;
  const blockTitle = current
    ? t("connectedLesson.partOf", { number: index + 1, total: reading.length })
    : challenge
      ? t("connectedLesson.independentCheck")
      : undefined;
  useEffect(() => {
    props.onBlockChange(current?.id, blockTitle);
  }, [current?.id, blockTitle, props.onBlockChange]);
  const reportPresence: ReportPresence | undefined = props.onPresence
    ? (blockId, kind, state, leaving) => props.onPresence!(episode.id, blockId, kind, state, leaving)
    : undefined;
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
            <div className="connected-prose" {...proseAttributes(server.course, block.markdown)}>
              <MarkdownContent markdown={block.markdown} />
            </div>
            {/* A generated component runs beside its text alternative, in the sandboxed runner. */}
            {props.components?.has(`${episode.id}/${block.id}`) && (
              <PresenceRegion blockId={block.id} kind="component" report={reportPresence}>
                <GeneratedComponentPanel component={props.components.get(`${episode.id}/${block.id}`)!} />
              </PresenceRegion>
            )}
          </>
        ) : block.type === "visual" ? (
          <PresenceRegion blockId={block.id} kind="simulation" report={reportPresence}>
          <VisualBlock
            source={{ episodeId: episode.id, blockId: block.id, episodeTitle: episode.title }}
            onContextChange={props.onVisualContextChange}
            onComplete={props.onVisualComplete}
            companionAvailable={server.studyArm?.companion !== false}
            experience={server.course.visuals.find(
              (visual) => visual.id === block.visualId,
            )}
          />
          </PresenceRegion>
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
        {/* A detour from the learner's path (§4.18): one row, and the way back to where they were. */}
        {detour && (
          <div className="connected-detour" role="note" data-testid="detour-return">
            <p>{t(detour.kind === "optional" ? "connectedLesson.detour.optional" : "connectedLesson.detour.revisit")}</p>
            {props.onReturn && (
              <button type="button" className="cc-ui-text-button cc-ai-detour-back" onClick={() => props.onReturn!(detour.episodeId)}>
                <span>{t("connectedLesson.detour.return", { title: detour.title })}</span>
                <Icon name="arrow-right" size={16} />
              </button>
            )}
          </div>
        )}
        <div className="connected-lesson-topline">
          <p className="connected-lesson-where">
            {placement
              ? t("connectedLesson.kicker.placement")
              : t("connectedLesson.where", { number: lessonNumber, total: allEpisodes.length })}
            {!placement && chapter && (
              <>
                {" · "}
                <span {...courseContentAttributes(server.course)}>{chapter.title}</span>
              </>
            )}
          </p>
          {props.staffTools && <div className="connected-lesson-staff">{props.staffTools}</div>}
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
        {objectiveText && <p {...courseContentAttributes(server.course)}>{objectiveText}</p>}
        {!placement && !closed && (
          <LessonProgress steps={steps} questionsLeft={questionsLeft} questionsTotal={questionsTotal} completed={completed} />
        )}
      </header>
      {closed ? (
        <Notice error>{t("connectedLesson.accessClosed")}</Notice>
      ) : (
        <>
          {placement ? (
            <Notice>{t("connectedLesson.placementNotice")}</Notice>
          ) : (
            <>
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
                  {!progress?.completedBlockIds.includes(current.id) && next?.id === current.id && (
                    <p className="connected-next-step">
                      {index + 1 < reading.length
                        ? t("connectedLesson.nextPart", { title: steps[index + 1]?.title ?? "" })
                        : episode.gateId && !gate?.passed
                          ? t("connectedLesson.nextCheck", { count: questionsLeft || questionsTotal })
                          : t("connectedLesson.nextFinish")}
                    </p>
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
                <PresenceRegion key={block.id} blockId={block.id} kind="activity" report={reportPresence}
                  done={Boolean(progress?.completedBlockIds.includes(block.id))}>
                <ActivityBlock
                  client={props.activities!}
                  enrollmentId={server.enrollmentId}
                  episodeId={episode.id}
                  blockId={block.id}
                  done={Boolean(progress?.completedBlockIds.includes(block.id))}
                  disabled={pending}
                  onChanged={() => props.onActivityChanged?.()}
                />
                </PresenceRegion>
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
            <CheckCard
              server={server}
              episode={episode}
              challenge={challenge}
              gate={gate}
              placement={placement}
              pending={pending}
              now={now}
              answer={props.answer}
              onAnswerChange={props.onAnswerChange}
              check={props.check}
              waitingForReading={waitingForReading}
              questionsLeft={questionsLeft}
              questionsTotal={questionsTotal}
              lastPart={lastPart}
              blockedMedia={blockedMedia}
              recovery={recovery}
              unverified={props.unverified}
              onReviewChange={props.onReviewChange}
              onGateAction={props.onGateAction}
              onGateReview={props.onGateReview}
              onRefresh={props.onRefresh}
              onQuestionsExhausted={props.onQuestionsExhausted}
            />
          )}
          {/* New material goes at the end of the lesson, so it is offered here (§4.6, 18c). */}
          <LessonPlaceContext.Provider value={place}>{props.pendingChanges}</LessonPlaceContext.Provider>
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
                // Unavailable, it reads as a disabled button with its reason under it, not as a link.
                kind={canComplete ? "primary" : "secondary"}
                {...(!canComplete ? { describedBy: "connected-complete-hint" } : {})}
                {...(canComplete ? { usability: "next" as const } : {})}
                disabled={!canComplete}
                onPress={props.onComplete}
              />
              {!canComplete && (
                <p id="connected-complete-hint">{t(next && !placement ? "connectedLesson.complete.hintReading" : episode.gateId && !gate?.passed && !gate?.exception ? "connectedLesson.complete.hintCheck" : "connectedLesson.complete.hint")}</p>
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

/**
 * The one progress indicator of a lesson, in the same scheme as its parts ("Part 2 of 3 · then 2
 * questions"), and a bar with a segment per part, activity and the check. Each segment's step and
 * status are listed for assistive technology, so the bar is never colour alone.
 */
function LessonProgress({ steps, questionsLeft, questionsTotal, completed }: {
  steps: LessonStepView[]; questionsLeft: number; questionsTotal: number; completed: boolean;
}) {
  const t = useT();
  const shown = steps.filter((step) => step.id !== "finish");
  const parts = shown.filter((step) => step.kind === "part"), activities = shown.filter((step) => step.kind === "activity");
  const check = shown.find((step) => step.kind === "check");
  const { now } = nowAndNext(shown);
  const then = check && check.status !== "completed"
    ? t("connectedLesson.progress.thenQuestions", { count: questionsLeft || questionsTotal })
    : "";
  const summary = completed
    ? t("connectedLesson.progress.complete")
    : !now
      ? t("connectedLesson.progress.ready")
      : now.status === "under_review"
        ? t("connectedLesson.progress.underReview", { title: now.title })
        : now.kind === "part"
          ? t("connectedLesson.progress.part", { number: parts.indexOf(now) + 1, total: parts.length, then })
          : now.kind === "activity"
            ? t("connectedLesson.progress.activity", { number: activities.indexOf(now) + 1, total: activities.length, then })
            : t("connectedLesson.progress.questions", { done: questionsTotal - questionsLeft, total: questionsTotal });
  return (
    <div className="connected-lesson-progress">
      <p id="connected-steps-summary">{summary}</p>
      <ol className="connected-steps" aria-label={t("connectedLesson.place.label")}>
        {shown.map((step) => (
          <li
            key={step.id}
            className={`connected-step is-${step.status.replace(/_/g, "-")}`}
            aria-current={step.status === "current" ? "step" : undefined}
          >
            <span className="connected-visually-hidden">
              {t("connectedLesson.progress.step", { title: step.title, status: t(stepStatusLabels[step.status]) })}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
