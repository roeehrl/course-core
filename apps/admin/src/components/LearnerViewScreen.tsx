import { useMemo, useRef, useState, type ReactNode } from "react";
import {
  fromVisualExperience,
  VisualRuntime,
} from "@course-core/visuals/headless";
import { VisualRuntimePlayer } from "@course-core/visuals/react";
import "@course-core/visuals/styles.css";
import { CheckCircle2, Circle, EyeOff, Lock, MapPin } from "lucide-react";
import type {
  LearnerBlock,
  LearnerEpisode,
  LearnerView,
  LearnerViewMedia,
} from "../domain/learnerView";
import { Badge, Button, Card, EmptyState, Notice, Status, when } from "./ui";
import { InspectorContext, InspectorPane, useInspector, useRegisterRuntime, type InspectedBlock, type InspectorAccess } from "./LearnerInspector";

const GATE_STATUS = {
  ready: "ready to continue",
  needs_evidence: "more evidence needed",
  needs_help: "help suggested",
  under_review: "under review",
  closed_with_gaps: "closed with gaps",
} as const;
const REVIEW_STATE = { open: "open", upheld: "upheld", exception_granted: "exception granted" } as const;

type Snapshot = LearnerView["snapshot"];

/** Read-only rendering of one learner's space, from the learner app's own
 * snapshot. Everything here is display or local navigation; it holds no
 * command, form submission or learner credential. */
export function LearnerViewScreen({ view, inspector }: { view: LearnerView; inspector?: InspectorAccess }) {
  const { snapshot } = view;
  // The debug inspector (owner/admin learner view with run.inspect): a side pane, full screen on phones.
  const [inspected, setInspected] = useState<InspectedBlock>();
  const opener = useRef<HTMLElement | null>(null);
  const inspectorState = useMemo(
    () => inspector ? { access: inspector, runtimes: new Map(), experiences: new Map(),
      open: (target: InspectedBlock, from: HTMLElement | null) => { opener.current = from; setInspected(target); } } : null,
    [inspector],
  );
  const closeInspector = () => { setInspected(undefined); opener.current?.focus(); };
  const episodes = snapshot.course.chapters.flatMap(
    (chapter) => chapter.episodes,
  );
  const [episodeId, setEpisodeId] = useState(
    snapshot.nextEpisodeId ?? episodes[0]?.id,
  );
  const episode = episodes.find((row) => row.id === episodeId);
  const required = snapshot.lessons.filter((l) => l.requirement === "required");
  const done = required.filter(
    (l) => l.status === "completed" || l.status === "placed",
  ).length;
  const next = episodes.find((row) => row.id === snapshot.nextEpisodeId);
  return (
    <InspectorContext.Provider value={inspectorState}>
    <div className="learner-view" data-read-only="true">
      <Notice
        tone="gold"
        title={`Read-only view of ${view.learner.displayName}'s learning space`}
      >
        <p>
          Opened {when(view.view.viewedAt)} by {view.view.viewer.name} (
          {view.view.viewer.role}). This view is recorded and the learner can
          see that you opened it. Nothing here changes their learning: reading,
          answers and messages come only from the learner.
        </p>
      </Notice>
      <Notice tone="blue" title="Not shown to staff">
        <ul className="learner-view-withheld">
          {view.withheld.map((item) => (
            <li key={item.id}>
              <strong>{item.label}.</strong> {item.reason}
            </li>
          ))}
        </ul>
      </Notice>
      <dl className="facts learner-view-facts">
        <div className="learner-view-goal">
          <dt>Learning goal</dt>
          <dd>{view.learner.goal || "No learning goal provided."}</dd>
        </div>
        <div>
          <dt>Required lessons</dt>
          <dd>
            {done} of {required.length}
            {snapshot.complete ? " · course complete" : ""}
          </dd>
        </div>
        <div>
          <dt>Next lesson</dt>
          <dd>
            {next?.title ??
              (snapshot.complete
                ? "None, the path is complete"
                : "None available")}
          </dd>
        </div>
        <div>
          <dt>Personal plan</dt>
          <dd>
            {snapshot.planRevision
              ? `Revision ${snapshot.planRevision}`
              : "Course as published"}
          </dd>
        </div>
        <div>
          <dt>Enrollment</dt>
          <dd>
            {snapshot.status} · revision {snapshot.revision}
          </dd>
        </div>
      </dl>
      <div className={`learner-view-layout${inspected ? " inspecting" : ""}`}>
        <nav aria-label="Learner's learning path" className="learner-view-path">
          {snapshot.course.chapters.map((chapter) => (
            <section key={chapter.id}>
              <h3>{chapter.title}</h3>
              <ol>
                {chapter.episodes.map((row) => (
                  <li key={row.id}>
                    <PathItem
                      snapshot={snapshot}
                      episode={row}
                      selected={row.id === episodeId}
                      onSelect={() => setEpisodeId(row.id)}
                    />
                  </li>
                ))}
              </ol>
            </section>
          ))}
        </nav>
        <div className="learner-view-detail">
          {episode ? (
            <EpisodeView key={episode.id} view={view} episode={episode} />
          ) : (
            <EmptyState title="No lessons">
              This course has no lessons.
            </EmptyState>
          )}
        </div>
        {inspected && inspectorState && <InspectorPane key={`${inspected.episode.id}:${inspected.block.id}`} target={inspected} onClose={closeInspector} />}
      </div>
      <PersonalChanges view={view} />
      <Reviews view={view} />
    </div>
    </InspectorContext.Provider>
  );
}

const statusLabel: Record<string, string> = {
  completed: "Completed",
  placed: "Placed out",
  available: "Available",
  locked: "Locked",
};
function PathItem({
  snapshot,
  episode,
  selected,
  onSelect,
}: {
  snapshot: Snapshot;
  episode: LearnerEpisode;
  selected: boolean;
  onSelect: () => void;
}) {
  const lesson = snapshot.lessons.find((row) => row.id === episode.id);
  const personal = snapshot.adaptationRequirements.some(
    (r) => r.episodeId === episode.id && r.insertedEpisode,
  );
  const closed = snapshot.inaccessibleEpisodeIds.includes(episode.id);
  const status = lesson?.status ?? "locked";
  const Icon =
    status === "completed" || status === "placed"
      ? CheckCircle2
      : status === "locked"
        ? Lock
        : snapshot.nextEpisodeId === episode.id
          ? MapPin
          : Circle;
  return (
    <button
      type="button"
      className={`learner-view-step ${status} ${selected ? "selected" : ""}`}
      aria-pressed={selected}
      onClick={onSelect}
    >
      <Icon size={18} aria-hidden="true" />
      <span>
        <strong>{episode.title}</strong>
        <small>
          {statusLabel[status] ?? status}
          {snapshot.nextEpisodeId === episode.id ? " · next" : ""}
          {lesson?.requirement === "optional" ? " · optional" : ""}
          {personal ? " · personal" : ""}
          {closed ? " · access closed" : ""}
        </small>
      </span>
    </button>
  );
}

function EpisodeView({
  view,
  episode,
}: {
  view: LearnerView;
  episode: LearnerEpisode;
}) {
  const { snapshot } = view;
  const lesson = snapshot.lessons.find((row) => row.id === episode.id);
  const closed = snapshot.inaccessibleEpisodeIds.includes(episode.id);
  const reading = episode.blocks.filter(
    (b) => b.type === "text" || b.type === "visual" || b.type === "media",
  );
  const read = reading.filter((b) =>
    lesson?.completedBlockIds.includes(b.id),
  ).length;
  const challenge = snapshot.activeChallenges.find(
    (row) => row.episodeId === episode.id,
  );
  const recovery = snapshot.recovery?.find(
    (row) => row.episodeId === episode.id,
  );
  const objectives = episode.objectiveIds.map(
    (id) =>
      snapshot.course.objectives.find((o) => o.id === id)?.description ?? id,
  );
  return (
    <article
      className="learner-view-episode"
      aria-labelledby={`lv-${episode.id}`}
    >
      <header className="stack">
        <div className="tag-row">
          <Status value={lesson?.status ?? "locked"} />
          <Badge>
            {lesson?.requirement ?? episode.requirement ?? "required"}
          </Badge>
          {closed && <Badge tone="red">access closed</Badge>}
        </div>
        <h2 id={`lv-${episode.id}`}>{episode.title}</h2>
        <p>{objectives.join(" ")}</p>
      </header>
      {closed ? (
        <Notice tone="red">
          The learner sees: this episode's access window has closed.
        </Notice>
      ) : (
        <>
          {reading.length > 0 && (
            <p className="learner-view-progress">
              {read} of {reading.length} parts read
            </p>
          )}
          {episode.blocks.map((block, index) => (
            <BlockView
              key={block.id}
              view={view}
              episode={episode}
              block={block}
              part={index + 1}
              read={Boolean(lesson?.completedBlockIds.includes(block.id))}
            />
          ))}
          <GeneratedMedia
            items={view.generatedMedia.filter(
              (clip) => clip.episodeId === episode.id,
            )}
          />
        </>
      )}
      {lesson?.gate && (
        <Card title="Gate evidence" eyebrow="What unlocks the next lesson">
          <ul className="learner-view-gate">
            {lesson.gate.objectives.map((objective) => (
              <li key={objective.id}>
                <span>
                  {snapshot.course.objectives.find((o) => o.id === objective.id)
                    ?.description ?? objective.id}
                </span>
                <span>
                  {objective.families.length} of {objective.required}{" "}
                  independent item families
                </span>
                <Status value={objective.passed ? "eligible" : "pending"} />
              </li>
            ))}
          </ul>
          <small>
            {lesson.gate.passed
              ? "Gate passed."
              : "Gate not yet passed. Only verified independent checks count."}
          </small>
          {lesson.gate.status && (
            <div className="learner-view-decision" data-status={lesson.gate.status}>
              <strong>Checkpoint decision: {GATE_STATUS[lesson.gate.status]}</strong>
              {lesson.gate.learnerVisibleReason && <p>{lesson.gate.learnerVisibleReason}</p>}
              {(lesson.gate.criterionResults ?? []).length > 0 && (
                <ul className="learner-view-list" aria-label="Readiness criteria">
                  {lesson.gate.criterionResults!.map((criterion) => (
                    <li key={criterion.criterionId}>
                      <span>
                        {criterion.met === true ? "Done" : criterion.met === "pending" ? "Waiting for review" : "Still needed"}
                        {" · "}
                        {criterion.reason}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {(lesson.gate.nextActions ?? []).length > 0 && (
                <>
                  <small>Next steps the learner is shown (not available here):</small>
                  <ul className="learner-view-list" aria-label="Learner next steps">
                    {lesson.gate.nextActions!.map((action, index) => (
                      <li key={`${action.kind}:${index}`}>{action.label}</li>
                    ))}
                  </ul>
                </>
              )}
              {lesson.gate.review && (
                <p>
                  Review request {when(lesson.gate.review.requestedAt)}: {REVIEW_STATE[lesson.gate.review.state]}
                  {lesson.gate.review.reviewerNote ? ` · “${lesson.gate.review.reviewerNote}”` : ""}
                </p>
              )}
              {(lesson.gate.exception || lesson.exception) && (
                <p>A staff exception lets this learner continue past this checkpoint. It is not a pass; open criteria stay recorded as gaps.</p>
              )}
            </div>
          )}
        </Card>
      )}
      {challenge && (
        <Card
          title="Open check"
          eyebrow={`${challenge.mode} · expires ${when(challenge.expiresAt)}`}
        >
          <Question question={challenge.question} />
          <small>
            {challenge.independentEligible
              ? "Counts as independent evidence if answered without help."
              : "Practice only: will not count as independent evidence."}
          </small>
        </Card>
      )}
      {recovery && (
        <Notice tone="blue">
          The learner is offered a fresh recovery check for this lesson.
        </Notice>
      )}
    </article>
  );
}

/** Course-made videos attached for this learner, as their lesson's optional help
 * shows them: title, what it shows, the player with captions, and the transcript
 * and description. Playback is local; nothing here is recorded as learner activity. */
function GeneratedMedia({ items }: { items: LearnerViewMedia[] }) {
  if (!items.length) return null;
  return (
    <Card
      title="Optional help"
      eyebrow="Course-made videos the learner is shown for this lesson"
    >
      <p className="learner-view-media-note">
        The learner sees these under this lesson's optional help. Watching is
        optional and never counts toward progress or checks.
      </p>
      <ul className="learner-view-list learner-view-media">
        {items.map((clip) => (
          <GeneratedClip key={clip.id} clip={clip} />
        ))}
      </ul>
    </Card>
  );
}

function GeneratedClip({ clip }: { clip: LearnerViewMedia }) {
  const playable = useMemo(
    () => document.createElement("video").canPlayType(clip.mimeType) !== "",
    [clip.mimeType],
  );
  const [failed, setFailed] = useState(false);
  const headingId = `lv-media-${clip.id}`;
  return (
    <li>
      <div className="split-line">
        <h3 id={headingId}>{clip.title}</h3>
        <span className="tag-row">
          <Badge tone="green">shown to learner</Badge>
        </span>
      </div>
      <small>
        Course-made video · reviewed {when(clip.reviewedAt)} · shown until{" "}
        {when(clip.expiresAt)}
      </small>
      <p>
        <strong>What it shows: </strong>
        {clip.objective}
      </p>
      {playable && !failed ? (
        <div className="learner-view-video">
          <video
            controls
            preload="none"
            playsInline
            aria-label={clip.title}
            onError={() => setFailed(true)}
          >
            <source
              src={clip.assetUrl}
              type={clip.mimeType}
              onError={() => setFailed(true)}
            />
            {clip.captionsUrl && (
              <track
                kind="captions"
                src={clip.captionsUrl}
                srcLang="en"
                label="English captions"
                default
              />
            )}
          </video>
        </div>
      ) : (
        <div className="learner-view-media-placeholder" role="note">
          <strong>Video not playable here.</strong> This browser cannot play
          this clip ({clip.mimeType}). The learner gets the same transcript and
          description shown below.
        </div>
      )}
      <dl className="facts learner-view-media-facts">
        <div>
          <dt>Captions</dt>
          <dd>{clip.captions ? "English captions" : "None"}</dd>
        </div>
        <div>
          <dt>Transcript</dt>
          <dd>{clip.transcript ? "Available" : "None"}</dd>
        </div>
      </dl>
      {(clip.transcript || clip.visualDescription) && (
        <div className="learner-view-media-text">
          {clip.transcript && (
            <>
              <h4>Transcript</h4>
              <p>{clip.transcript}</p>
            </>
          )}
          {clip.visualDescription && (
            <>
              <h4>What the video shows</h4>
              <p>{clip.visualDescription}</p>
            </>
          )}
        </div>
      )}
    </li>
  );
}

function Question({
  question,
}: {
  question: LearnerView["snapshot"]["activeChallenges"][number]["question"];
}) {
  return (
    <fieldset className="learner-view-question" disabled>
      <legend>Question as the learner sees it</legend>
      <Markdown markdown={question.prompt} />
      {question.options?.map((option) => (
        <label key={option.id}>
          <input
            type="radio"
            name={`question-${question.id}`}
            value={option.id}
            disabled
          />{" "}
          {option.text}
        </label>
      ))}
      {question.criteria && (
        <ul>
          {question.criteria.map((c) => (
            <li key={c.id}>
              {c.description} {c.required ? "(required)" : "(optional)"}
            </li>
          ))}
        </ul>
      )}
      {!question.options && !question.criteria && (
        <p className="learner-view-answer-slot">
          The learner answers here ({question.type}).
        </p>
      )}
    </fieldset>
  );
}

function BlockView({
  view,
  episode,
  block,
  part,
  read,
}: {
  view: LearnerView;
  episode: LearnerEpisode;
  block: LearnerBlock;
  part: number;
  read: boolean;
}) {
  const { snapshot } = view;
  const inspector = useInspector();
  const personal = snapshot.adaptationRequirements.find(
    (r) => r.episodeId === episode.id && r.blockId === block.id,
  );
  let body: ReactNode;
  let label: string;
  if (block.type === "text") {
    label = "Reading";
    body = (
      <>
        <Markdown markdown={block.markdown} />
        <Sources
          ids={block.sourceRefs ?? []}
          sources={snapshot.course.sources}
        />
      </>
    );
  } else if (block.type === "visual") {
    label = "Illustration";
    body = (
      <Visual
        blockId={block.id}
        experience={snapshot.course.visuals.find(
          (v) => v.id === block.visualId,
        )}
      />
    );
  } else if (block.type === "media") {
    const media = snapshot.course.media.find((m) => m.id === block.mediaId);
    label = `Media${block.required ? "" : " · optional"}`;
    body = media ? (
      <div className="stack">
        <small>
          {media.type} · {media.review}. Playback is not loaded in the staff
          view; the text alternative the learner also receives:
        </small>
        <Markdown markdown={media.alternativeMarkdown} />
      </div>
    ) : (
      <p>This media item is unavailable to the learner.</p>
    );
  } else if (block.type === "assessment") {
    label = "Check";
    body = (
      <p>
        The learner opens an independent check here. Its question appears only
        once issued (see Open check).
      </p>
    );
  } else {
    label = "Activity";
    body = (
      <p>
        Interactive activity ({block.extensionId}). Activities are completed by
        the learner in their app.
      </p>
    );
  }
  return (
    <section
      className="learner-view-block"
      aria-label={`Part ${part}: ${label}`}
    >
      <div className="split-line">
        <span className="eyebrow">
          Part {part} · {label}
        </span>
        <span className="tag-row">
          {personal && (
            <Badge tone="blue">personal · {personal.classification}</Badge>
          )}
          {read && <Badge tone="green">read</Badge>}
          {inspector && (
            <Button kind="quiet" aria-label={`Inspect part ${part}`}
              onClick={(e) => inspector.open({ episode, block, part, label, read }, e.currentTarget)}>
              Inspect
            </Button>
          )}
        </span>
      </div>
      {body}
    </section>
  );
}

function Sources({
  ids,
  sources,
}: {
  ids: string[];
  sources: Snapshot["course"]["sources"];
}) {
  const cited = ids
    .map((id) => sources.find((s) => s.id === id))
    .filter((s): s is NonNullable<typeof s> => Boolean(s));
  if (!cited.length) return null;
  return (
    <p className="learner-view-sources">
      Sources: {cited.map((s) => s.title).join("; ")}
    </p>
  );
}

function Visual({
  blockId,
  experience,
}: {
  blockId: string;
  experience: Snapshot["course"]["visuals"][number] | undefined;
}) {
  const prepared = useMemo(() => {
    try {
      return experience
        ? new VisualRuntime(
            fromVisualExperience(JSON.parse(JSON.stringify(experience))),
          )
        : undefined;
    } catch {
      return undefined;
    }
  }, [experience]);
  useRegisterRuntime(blockId, prepared, experience);
  const description =
    experience?.accessibility?.description?.trim() ||
    "This illustration is unavailable to the learner.";
  const fallback = (
    <div className="stack">
      <strong>Illustration · text equivalent</strong>
      <p>{description}</p>
    </div>
  );
  return (
    <div className="learner-view-visual">
      {prepared ? (
        <VisualRuntimePlayer runtime={prepared} fallback={fallback} />
      ) : (
        fallback
      )}
    </div>
  );
}

/** The learner app's non-executable prose subset: paragraphs, headings, bold,
 * inline code and fenced code. HTML and links stay plain text. */
export function Markdown({ markdown }: { markdown: string }) {
  const parts = markdown.split(/(```[^\n]*\n[\s\S]*?```)/g);
  return (
    <div className="learner-view-prose">
      {parts.map((part, index) => {
        if (part.startsWith("```")) {
          const firstLine = part.indexOf("\n");
          const language = part.slice(3, firstLine).trim();
          return (
            <figure key={index} className="learner-view-code">
              <figcaption>{language || "Example"}</figcaption>
              <pre
                tabIndex={0}
                aria-label={`${language || "Example"} code, scrollable`}
              >
                <code>{part.slice(firstLine + 1, -3).trimEnd()}</code>
              </pre>
            </figure>
          );
        }
        return part
          .trim()
          .split(/\n\s*\n/)
          .filter(Boolean)
          .map((paragraph, i) => {
            const spans = paragraph
              .replace(/^#{1,4}\s/, "")
              .split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]\n]+\]\([^\s)]+\))/)
              .map((span, j) =>
                /^\[[^\]]+\]\([^\s)]+\)$/.test(span) ? (
                  <span key={j}>{span.slice(1, span.indexOf("]("))}</span>
                ) : span.startsWith("`") && span.length > 1 ? (
                  <code key={j}>{span.slice(1, -1)}</code>
                ) : span.startsWith("**") && span.length > 3 ? (
                  <strong key={j}>{span.slice(2, -2)}</strong>
                ) : (
                  span
                ),
              );
            return /^#{1,4}\s/.test(paragraph) ? (
              <h3 key={`${index}-${i}`}>{spans}</h3>
            ) : (
              <p key={`${index}-${i}`}>{spans}</p>
            );
          });
      })}
    </div>
  );
}

function PersonalChanges({ view }: { view: LearnerView }) {
  return (
    <Card
      title="Personal changes"
      eyebrow="Applied adaptations the learner sees"
    >
      {view.personalChanges.length ? (
        <ul className="learner-view-list">
          {view.personalChanges.map((change) => (
            <li key={`${change.proposalId}-${change.blockId}`}>
              <div className="split-line">
                <strong>
                  {change.kind.replaceAll("_", " ")} · {change.episodeTitle}
                </strong>
                <span className="tag-row">
                  <Badge>{change.classification}</Badge>
                  {change.hidden && (
                    <Badge tone="gold">
                      <EyeOff size={12} aria-hidden="true" /> hidden by learner
                    </Badge>
                  )}
                </span>
              </div>
              {change.why && <p>{change.why}</p>}
              <small>
                Applied {when(change.appliedAt)} · plan revision{" "}
                {change.planRevision}. Evidence is unaffected.
              </small>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState title="No personal changes">
          The learner follows the course as published.
        </EmptyState>
      )}
    </Card>
  );
}

function Reviews({ view }: { view: LearnerView }) {
  const titles = Object.fromEntries(
    view.snapshot.course.chapters
      .flatMap((c) => c.episodes)
      .map((e) => [e.id, e.title]),
  );
  return (
    <Card
      title="Written answers and reviews"
      eyebrow="Pending and decided reviews the learner sees"
    >
      {view.reviews.length ? (
        <ul className="learner-view-list">
          {view.reviews.map((review) => (
            <li key={review.attemptId}>
              <div className="split-line">
                <strong>{titles[review.episodeId] ?? review.episodeId}</strong>
                <Status value={review.status} />
              </div>
              <small>
                Submitted {when(review.submittedAt)}
                {review.reviewedAt
                  ? ` · reviewed ${when(review.reviewedAt)}`
                  : ""}
                {review.appeal
                  ? ` · second opinion ${review.appeal.state.replaceAll("_", " ")}`
                  : ""}
              </small>
              {review.learnerNote && (
                <p>Reviewer's note: {review.learnerNote}</p>
              )}
              {review.appeal && (
                <small>
                  The learner's reason for a second opinion is not shown here;
                  reviewers read it where they decide the appeal.
                  {review.appeal.note
                    ? ` Second reviewer's note: “${review.appeal.note}”`
                    : ""}
                </small>
              )}
              <ul>
                {review.criteria.map((c) => (
                  <li key={c.id}>
                    {c.description}{" "}
                    {c.met === null
                      ? "(awaiting review)"
                      : c.met
                        ? "(met)"
                        : "(not met)"}
                    {c.quote ? ` · quoted: "${c.quote}"` : ""}
                  </li>
                ))}
              </ul>
              {(review.canReply || review.canAppeal) && (
                <small>
                  {review.canReply
                    ? "The learner can reply to the reviewer."
                    : "The learner can ask for a second opinion."}
                </small>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState title="No written answers">
          Nothing is waiting for review.
        </EmptyState>
      )}
    </Card>
  );
}
