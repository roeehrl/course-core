import { useMemo, useRef, useState, type ReactNode } from "react";
import { privacyRuleText } from "../domain/privacyRules";
import {
  fromVisualExperience,
  VisualRuntime,
} from "@course-core/visuals/headless";
import { VisualRuntimePlayer } from "@course-core/visuals/react";
import "@course-core/visuals/styles.css";
import { useVisualMessages } from "./visualMessages";
import { CheckCircle2, Circle, EyeOff, Lock, MapPin } from "lucide-react";
import type {
  GateMessage,
  LearnerBlock,
  LearnerEpisode,
  LearnerView,
  LearnerViewMedia,
} from "../domain/learnerView";
import { contentAttributes } from "@course-core/i18n";
import {
  useFormatters,
  useI18n,
  useT,
  type AdminTranslator,
  type MessageKey,
} from "../i18n";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Notice,
  Status,
  focusInPlace,
} from "./ui";
import {
  blockLabel,
  InspectorContext,
  InspectorPane,
  useInspector,
  useRegisterRuntime,
  type InspectedBlock,
  type InspectorAccess,
} from "./LearnerInspector";

/** A server code's label, or the code itself (underscores as spaces) when it is unknown. */
function codeLabel(i18n: AdminTranslator, key: string, code: string) {
  return i18n.has(key as MessageKey)
    ? i18n.t(key as MessageKey)
    : code.replaceAll("_", " ");
}
// Course content keeps its own direction; the released SDK does not declare its language yet.
const content = contentAttributes(undefined);

type Snapshot = LearnerView["snapshot"];

/** Read-only rendering of one learner's space, from the learner app's own
 * snapshot. Everything here is display or local navigation; it holds no
 * command, form submission or learner credential. */
export function LearnerViewScreen({
  view,
  inspector,
}: {
  view: LearnerView;
  inspector?: InspectorAccess;
}) {
  const t = useT();
  const i18n = useI18n();
  const { when } = useFormatters();
  const { snapshot } = view;
  // The debug inspector (owner/admin learner view with run.inspect): a side pane, full screen on phones.
  const [inspected, setInspected] = useState<InspectedBlock>();
  const opener = useRef<HTMLElement | null>(null);
  const inspectorState = useMemo(
    () =>
      inspector
        ? {
            access: inspector,
            runtimes: new Map(),
            experiences: new Map(),
            renderers: view.visualRenderers,
            open: (target: InspectedBlock, from: HTMLElement | null) => {
              opener.current = from;
              setInspected(target);
            },
          }
        : null,
    [inspector, view.visualRenderers],
  );
  const closeInspector = () => {
    setInspected(undefined);
    focusInPlace(opener.current);
  };
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
          title={t("learnerViewScreen.banner.title", {
            learner: view.learner.displayName,
          })}
        >
          <p>
            {t("learnerViewScreen.banner.body", {
              when: when(view.view.viewedAt),
              viewer: view.view.viewer.name,
              role: t(`learnerViewScreen.role.${view.view.viewer.role}`),
            })}
          </p>
        </Notice>
        <Notice tone="blue" title={t("learnerViewScreen.withheld.title")}>
          <ul className="learner-view-withheld">
            {view.withheld.map((item) => (
              <li key={item.id} dir="auto">
                {i18n.rich(
                  "learnerViewScreen.withheld.item",
                  privacyRuleText(i18n, item),
                  {
                    strong: (children, key) => (
                      <strong key={key}>{children}</strong>
                    ),
                  },
                )}
              </li>
            ))}
          </ul>
        </Notice>
        <dl className="facts learner-view-facts">
          <div className="learner-view-goal">
            <dt>{t("learnerViewScreen.facts.goal")}</dt>
            <dd dir="auto">
              {view.learner.goal || t("learnerViewScreen.facts.noGoal")}
            </dd>
          </div>
          <div>
            <dt>{t("learnerViewScreen.facts.required")}</dt>
            <dd>
              {t(
                snapshot.complete
                  ? "learnerViewScreen.facts.requiredDoneComplete"
                  : "learnerViewScreen.facts.requiredDone",
                { done, total: required.length },
              )}
            </dd>
          </div>
          <div>
            <dt>{t("learnerViewScreen.facts.next")}</dt>
            <dd {...(next ? content : {})}>
              {next?.title ??
                (snapshot.complete
                  ? t("learnerViewScreen.facts.nextComplete")
                  : t("learnerViewScreen.facts.nextNone"))}
            </dd>
          </div>
          <div>
            <dt>{t("learnerViewScreen.facts.plan")}</dt>
            <dd>
              {snapshot.planRevision
                ? t("learnerViewScreen.facts.planRevision", {
                    revision: snapshot.planRevision,
                  })
                : t("learnerViewScreen.facts.planPublished")}
            </dd>
          </div>
          <div>
            <dt>{t("learnerViewScreen.facts.enrollment")}</dt>
            <dd>
              {t("learnerViewScreen.facts.enrollmentState", {
                status: codeLabel(
                  i18n,
                  `learnerViewScreen.enrollmentStatus.${snapshot.status}`,
                  snapshot.status,
                ),
                revision: snapshot.revision,
              })}
            </dd>
          </div>
        </dl>
        <div className={`learner-view-layout${inspected ? " inspecting" : ""}`}>
          <nav
            aria-label={t("learnerViewScreen.path.label")}
            className="learner-view-path"
          >
            {snapshot.course.chapters.map((chapter) => (
              <section key={chapter.id}>
                <h3 {...content}>{chapter.title}</h3>
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
              <EmptyState title={t("learnerViewScreen.empty.lessons.title")}>
                {t("learnerViewScreen.empty.lessons.body")}
              </EmptyState>
            )}
          </div>
          {inspected && inspectorState && (
            <InspectorPane
              key={`${inspected.episode.id}:${inspected.block.id}`}
              target={inspected}
              onClose={closeInspector}
            />
          )}
        </div>
        <PersonalChanges view={view} />
        <Reviews view={view} />
      </div>
    </InspectorContext.Provider>
  );
}

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
  const t = useT();
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
        <strong {...content}>{episode.title}</strong>
        <small>
          {[
            t(`learnerViewScreen.lessonStatus.${status}`),
            snapshot.nextEpisodeId === episode.id &&
              t("learnerViewScreen.step.next"),
            lesson?.requirement === "optional" &&
              t("learnerViewScreen.step.optional"),
            personal && t("learnerViewScreen.step.personal"),
            closed && t("learnerViewScreen.step.closed"),
          ]
            .filter(Boolean)
            .join(" · ")}
        </small>
      </span>
    </button>
  );
}

/**
 * A gate decision sentence in the viewer's language: the server's code translated with its
 * parameters, or the server's English text when this app does not know the code.
 */
export function gateText(
  message: GateMessage | null | undefined,
  fallback: string,
  i18n: Pick<AdminTranslator, "t" | "has" | "list">,
): string {
  if (!message) return fallback;
  const key = `learnerViewScreen.gateMsg.${message.code}` as MessageKey;
  if (!i18n.has(key)) return fallback;
  const params: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(message.params ?? {}))
    params[name] = Array.isArray(value)
      ? i18n.list(
          value.map((text) =>
            i18n.t("learnerViewScreen.gateMsg.quoted", { text }),
          ),
          "unit",
        )
      : value;
  if (message.detail) {
    const detail = gateText(message.detail, "", i18n);
    if (!detail) return fallback;
    params.detail = detail;
  }
  return i18n.t(key, params);
}

function EpisodeView({
  view,
  episode,
}: {
  view: LearnerView;
  episode: LearnerEpisode;
}) {
  const t = useT();
  const i18n = useI18n();
  const { when } = useFormatters();
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
          <Status
            value={lesson?.status ?? "locked"}
            label={t(
              `learnerViewScreen.statusBadge.${lesson?.status ?? "locked"}`,
            )}
          />
          <Badge>
            {t(
              `learnerViewScreen.requirement.${lesson?.requirement ?? episode.requirement ?? "required"}`,
            )}
          </Badge>
          {closed && (
            <Badge tone="red">{t("learnerViewScreen.badge.closed")}</Badge>
          )}
        </div>
        <h2 id={`lv-${episode.id}`} {...content}>
          {episode.title}
        </h2>
        <p {...content}>{objectives.join(" ")}</p>
      </header>
      {closed ? (
        <Notice tone="red">{t("learnerViewScreen.episode.closed")}</Notice>
      ) : (
        <>
          {reading.length > 0 && (
            <p className="learner-view-progress">
              {t("learnerViewScreen.episode.progress", {
                read,
                total: reading.length,
              })}
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
        <Card
          title={t("learnerViewScreen.gate.title")}
          eyebrow={t("learnerViewScreen.gate.eyebrow")}
        >
          <ul className="learner-view-gate">
            {lesson.gate.objectives.map((objective) => (
              <li key={objective.id}>
                <span {...content}>
                  {snapshot.course.objectives.find((o) => o.id === objective.id)
                    ?.description ?? objective.id}
                </span>
                <span>
                  {t("learnerViewScreen.gate.families", {
                    count: objective.families.length,
                    required: objective.required,
                  })}
                </span>
                <Status
                  value={objective.passed ? "eligible" : "pending"}
                  label={t(
                    objective.passed
                      ? "learnerViewScreen.statusBadge.eligible"
                      : "learnerViewScreen.statusBadge.pending",
                  )}
                />
              </li>
            ))}
          </ul>
          <small>
            {lesson.gate.passed
              ? t("learnerViewScreen.gate.passed")
              : t("learnerViewScreen.gate.notPassed")}
          </small>
          {lesson.gate.status && (
            <div
              className="learner-view-decision"
              data-status={lesson.gate.status}
            >
              <strong>
                {t("learnerViewScreen.gate.decision", {
                  status: t(
                    `learnerViewScreen.gateStatus.${lesson.gate.status}`,
                  ),
                })}
              </strong>
              {lesson.gate.learnerVisibleReason && (
                <p dir="auto">
                  {gateText(
                    lesson.gate.messages?.reason,
                    lesson.gate.learnerVisibleReason,
                    i18n,
                  )}
                </p>
              )}
              {(lesson.gate.criterionResults ?? []).length > 0 && (
                <ul
                  className="learner-view-list"
                  aria-label={t("learnerViewScreen.gate.criteria")}
                >
                  {lesson.gate.criterionResults!.map((criterion) => (
                    <li key={criterion.criterionId}>
                      <span>
                        {t("learnerViewScreen.gate.criterion", {
                          met:
                            criterion.met === true
                              ? t("learnerViewScreen.gate.met")
                              : criterion.met === "pending"
                                ? t("learnerViewScreen.gate.metPending")
                                : t("learnerViewScreen.gate.metNo"),
                          reason: gateText(
                            lesson.gate!.messages?.criteria[
                              criterion.criterionId
                            ],
                            criterion.reason,
                            i18n,
                          ),
                        })}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {(lesson.gate.nextActions ?? []).length > 0 && (
                <>
                  <small>{t("learnerViewScreen.gate.nextSteps")}</small>
                  <ul
                    className="learner-view-list"
                    aria-label={t("learnerViewScreen.gate.nextStepsLabel")}
                  >
                    {lesson.gate.nextActions!.map((action, index) => (
                      <li key={`${action.kind}:${index}`} dir="auto">
                        {gateText(
                          lesson.gate!.messages?.actions[index],
                          action.label,
                          i18n,
                        )}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {lesson.gate.review && (
                <p>
                  {t(
                    lesson.gate.review.reviewerNote
                      ? "learnerViewScreen.gate.reviewNote"
                      : "learnerViewScreen.gate.review",
                    {
                      when: when(lesson.gate.review.requestedAt),
                      state: t(
                        `learnerViewScreen.reviewState.${lesson.gate.review.state}`,
                      ),
                      note: lesson.gate.review.reviewerNote ?? "",
                    },
                  )}
                </p>
              )}
              {(lesson.gate.exception || lesson.exception) && (
                <p>{t("learnerViewScreen.gate.exception")}</p>
              )}
            </div>
          )}
        </Card>
      )}
      {challenge && (
        <Card
          title={t("learnerViewScreen.check.title")}
          eyebrow={t("learnerViewScreen.check.eyebrow", {
            mode: codeLabel(
              i18n,
              `learnerViewScreen.checkMode.${challenge.mode}`,
              challenge.mode,
            ),
            expires: when(challenge.expiresAt),
          })}
        >
          <Question question={challenge.question} />
          <small>
            {challenge.independentEligible
              ? t("learnerViewScreen.check.independent")
              : t("learnerViewScreen.check.practice")}
          </small>
        </Card>
      )}
      {recovery && (
        <Notice tone="blue">{t("learnerViewScreen.recovery")}</Notice>
      )}
    </article>
  );
}

/** Course-made videos attached for this learner, as their lesson's optional help
 * shows them: title, what it shows, the player with captions, and the transcript
 * and description. Playback is local; nothing here is recorded as learner activity. */
function GeneratedMedia({ items }: { items: LearnerViewMedia[] }) {
  const t = useT();
  if (!items.length) return null;
  return (
    <Card
      title={t("learnerViewScreen.media.title")}
      eyebrow={t("learnerViewScreen.media.eyebrow")}
    >
      <p className="learner-view-media-note">
        {t("learnerViewScreen.media.note")}
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
  const t = useT();
  const { rich } = useI18n();
  const { when } = useFormatters();
  const [failed, setFailed] = useState(false);
  const headingId = `lv-media-${clip.id}`;
  return (
    <li>
      <div className="split-line">
        <h3 id={headingId} {...content}>
          {clip.title}
        </h3>
        <span className="tag-row">
          <Badge tone="green">{t("learnerViewScreen.media.shown")}</Badge>
        </span>
      </div>
      <small>
        {t("learnerViewScreen.media.meta", {
          reviewed: when(clip.reviewedAt),
          until: when(clip.expiresAt),
        })}
      </small>
      <p>
        <strong>{t("learnerViewScreen.media.objective")} </strong>
        <span {...content}>{clip.objective}</span>
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
                srcLang={clip.captionsLanguage ?? undefined}
                label={t("learnerViewScreen.media.captionsTrack", {
                  language: clip.captionsLanguage ?? "unknown",
                })}
                default
              />
            )}
          </video>
        </div>
      ) : (
        <div className="learner-view-media-placeholder" role="note">
          {rich(
            "learnerViewScreen.media.unplayable",
            {
              type: clip.mimeType,
            },
            {
              strong: (children, key) => <strong key={key}>{children}</strong>,
            },
          )}
        </div>
      )}
      <dl className="facts learner-view-media-facts">
        <div>
          <dt>{t("learnerViewScreen.media.captions")}</dt>
          <dd>
            {clip.captions
              ? t("learnerViewScreen.media.captionsTrack", {
                  language: clip.captionsLanguage ?? "unknown",
                })
              : t("learnerViewScreen.media.none")}
          </dd>
        </div>
        <div>
          <dt>{t("learnerViewScreen.media.transcript")}</dt>
          <dd>
            {clip.transcript
              ? t("learnerViewScreen.media.available")
              : t("learnerViewScreen.media.none")}
          </dd>
        </div>
      </dl>
      {(clip.transcript || clip.visualDescription) && (
        <div className="learner-view-media-text">
          {clip.transcript && (
            <>
              <h4>{t("learnerViewScreen.media.transcript")}</h4>
              <p {...content}>{clip.transcript}</p>
            </>
          )}
          {clip.visualDescription && (
            <>
              <h4>{t("learnerViewScreen.media.description")}</h4>
              <p {...content}>{clip.visualDescription}</p>
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
  const t = useT();
  return (
    <fieldset className="learner-view-question" disabled {...content}>
      <legend>{t("learnerViewScreen.question.legend")}</legend>
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
              {t(
                c.required
                  ? "learnerViewScreen.question.required"
                  : "learnerViewScreen.question.optional",
                { criterion: c.description },
              )}
            </li>
          ))}
        </ul>
      )}
      {!question.options && !question.criteria && (
        <p className="learner-view-answer-slot">
          {t("learnerViewScreen.question.answerSlot", {
            type: question.type,
          })}
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
  const t = useT();
  const { snapshot } = view;
  const inspector = useInspector();
  const personal = snapshot.adaptationRequirements.find(
    (r) => r.episodeId === episode.id && r.blockId === block.id,
  );
  let body: ReactNode;
  const label = blockLabel(block);
  if (block.type === "text") {
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
    body = media ? (
      <div className="stack">
        <small>
          {t("learnerViewScreen.block.media", {
            type: media.type,
            review: media.review,
          })}
        </small>
        <Markdown markdown={media.alternativeMarkdown} />
      </div>
    ) : (
      <p>{t("learnerViewScreen.block.mediaMissing")}</p>
    );
  } else if (block.type === "assessment") {
    body = <p>{t("learnerViewScreen.block.assessment")}</p>;
  } else {
    body = (
      <p>
        {t("learnerViewScreen.block.activity", {
          extension: block.extensionId,
        })}
      </p>
    );
  }
  return (
    <section
      className="learner-view-block"
      aria-label={t("learnerViewScreen.block.label", { part, label })}
    >
      <div className="split-line">
        <span className="eyebrow">
          {t("learnerViewScreen.block.eyebrow", { part, label })}
        </span>
        <span className="tag-row">
          {personal && (
            <Badge tone="blue">
              {t("learnerViewScreen.block.personal", {
                classification: t(
                  `learnerViewScreen.classification.${personal.classification}`,
                ),
              })}
            </Badge>
          )}
          {read && (
            <Badge tone="green">{t("learnerViewScreen.block.read")}</Badge>
          )}
          {inspector && (
            <Button
              kind="quiet"
              aria-label={t("learnerViewScreen.block.inspectLabel", { part })}
              onClick={(e) =>
                inspector.open(
                  { episode, block, part, label, read },
                  e.currentTarget,
                )
              }
            >
              {t("learnerViewScreen.block.inspect")}
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
  const t = useT();
  if (!cited.length) return null;
  return (
    <p className="learner-view-sources">
      {t("learnerViewScreen.sources", {
        sources: cited.map((s) => s.title).join("; "),
      })}
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
  const t = useT();
  const visualText = useVisualMessages();
  useRegisterRuntime(blockId, prepared, experience);
  const authored = experience?.accessibility?.description?.trim();
  const fallback = (
    <div className="stack">
      <strong>{t("learnerViewScreen.visual.fallback")}</strong>
      <p {...(authored ? content : {})}>
        {authored || t("learnerViewScreen.visual.unavailable")}
      </p>
    </div>
  );
  return (
    <div className="learner-view-visual">
      {prepared ? (
        <VisualRuntimePlayer
          runtime={prepared}
          fallback={fallback}
          messages={visualText.messages}
          locale={visualText.locale}
        />
      ) : (
        fallback
      )}
    </div>
  );
}

/** The learner app's non-executable prose subset: paragraphs, headings, bold,
 * inline code and fenced code. HTML and links stay plain text. */
export function Markdown({ markdown }: { markdown: string }) {
  const t = useT();
  const parts = markdown.split(/(```[^\n]*\n[\s\S]*?```)/g);
  return (
    <div className="learner-view-prose" {...content}>
      {parts.map((part, index) => {
        if (part.startsWith("```")) {
          const firstLine = part.indexOf("\n");
          const language = part.slice(3, firstLine).trim();
          return (
            <figure key={index} className="learner-view-code">
              <figcaption dir="ltr">
                {language || t("learnerViewScreen.code.example")}
              </figcaption>
              <pre
                tabIndex={0}
                dir="ltr"
                aria-label={t("learnerViewScreen.code.label", {
                  language: language || t("learnerViewScreen.code.example"),
                })}
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
  const t = useT();
  const i18n = useI18n();
  const { when } = useFormatters();
  return (
    <Card
      title={t("learnerViewScreen.changes.title")}
      eyebrow={t("learnerViewScreen.changes.eyebrow")}
    >
      {view.personalChanges.length ? (
        <ul className="learner-view-list">
          {view.personalChanges.map((change) => (
            <li key={`${change.proposalId}-${change.blockId}`}>
              <div className="split-line">
                <strong>
                  {t("learnerViewScreen.changes.heading", {
                    kind: codeLabel(
                      i18n,
                      `learnerViewScreen.changeKind.${change.kind}`,
                      change.kind,
                    ),
                    episode: change.episodeTitle,
                  })}
                </strong>
                <span className="tag-row">
                  <Badge>
                    {t(
                      `learnerViewScreen.classification.${change.classification}`,
                    )}
                  </Badge>
                  {change.hidden && (
                    <Badge tone="gold">
                      <EyeOff size={12} aria-hidden="true" />{" "}
                      {t("learnerViewScreen.changes.hidden")}
                    </Badge>
                  )}
                </span>
              </div>
              {change.whyCode &&
              i18n.has(
                `learnerViewScreen.changes.why.${change.whyCode}` as MessageKey,
              ) ? (
                <p>
                  {t(
                    `learnerViewScreen.changes.why.${change.whyCode}` as MessageKey,
                  )}
                </p>
              ) : (
                change.why && <p dir="auto">{change.why}</p>
              )}
              <small>
                {t("learnerViewScreen.changes.applied", {
                  when: when(change.appliedAt),
                  revision: change.planRevision,
                })}
              </small>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState title={t("learnerViewScreen.changes.empty.title")}>
          {t("learnerViewScreen.changes.empty.body")}
        </EmptyState>
      )}
    </Card>
  );
}

function Reviews({ view }: { view: LearnerView }) {
  const t = useT();
  const i18n = useI18n();
  const { when } = useFormatters();
  const titles = Object.fromEntries(
    view.snapshot.course.chapters
      .flatMap((c) => c.episodes)
      .map((e) => [e.id, e.title]),
  );
  return (
    <Card
      title={t("learnerViewScreen.reviews.title")}
      eyebrow={t("learnerViewScreen.reviews.eyebrow")}
    >
      {view.reviews.length ? (
        <ul className="learner-view-list">
          {view.reviews.map((review) => (
            <li key={review.attemptId}>
              <div className="split-line">
                <strong {...content}>
                  {titles[review.episodeId] ?? review.episodeId}
                </strong>
                <Status
                  value={review.status}
                  label={
                    i18n.has(
                      `learnerViewScreen.statusBadge.${review.status}` as MessageKey,
                    )
                      ? t(
                          `learnerViewScreen.statusBadge.${review.status}` as MessageKey,
                        )
                      : undefined
                  }
                />
              </div>
              <small>
                {[
                  t("learnerViewScreen.reviews.submitted", {
                    when: when(review.submittedAt),
                  }),
                  review.reviewedAt &&
                    t("learnerViewScreen.reviews.reviewed", {
                      when: when(review.reviewedAt),
                    }),
                  review.appeal &&
                    t("learnerViewScreen.reviews.appeal", {
                      state: codeLabel(
                        i18n,
                        `learnerViewScreen.appealState.${review.appeal.state}`,
                        review.appeal.state,
                      ),
                    }),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </small>
              {review.learnerNote && (
                <p>
                  {t("learnerViewScreen.reviews.note", {
                    note: review.learnerNote,
                  })}
                </p>
              )}
              {review.appeal && (
                <small>
                  {t(
                    review.appeal.note
                      ? "learnerViewScreen.reviews.appealHiddenNote"
                      : "learnerViewScreen.reviews.appealHidden",
                    { note: review.appeal.note ?? "" },
                  )}
                </small>
              )}
              <ul>
                {review.criteria.map((c) => (
                  <li key={c.id}>
                    {t(
                      c.quote
                        ? "learnerViewScreen.reviews.criterionQuote"
                        : "learnerViewScreen.reviews.criterion",
                      {
                        criterion: c.description,
                        met:
                          c.met === null ? "pending" : c.met ? "met" : "unmet",
                        quote: c.quote ?? "",
                      },
                    )}
                  </li>
                ))}
              </ul>
              {(review.canReply || review.canAppeal) && (
                <small>
                  {review.canReply
                    ? t("learnerViewScreen.reviews.canReply")
                    : t("learnerViewScreen.reviews.canAppeal")}
                </small>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState title={t("learnerViewScreen.reviews.empty.title")}>
          {t("learnerViewScreen.reviews.empty.body")}
        </EmptyState>
      )}
    </Card>
  );
}
