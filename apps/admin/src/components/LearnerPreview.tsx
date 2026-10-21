import { useState } from "react";
import { Eye } from "lucide-react";
import {
  PREVIEW_PROFILES,
  releaseEditingErrorMessage,
  type LearnerPreview as Preview,
  type ReleaseEditingPort,
} from "../domain/releaseEditing";
import { Badge, Button, Loading, Notice } from "./ui";
import { useI18n, useT, type MessageKey } from "../i18n";

const STATUS_TONE = {
  completed: "green",
  placed: "green",
  available: "blue",
  locked: "neutral",
} as const;

/** A release (or an unsaved draft) as made-up representative learners would meet it: their
 * roadmap, worked out by the same rules as for a real learner, and what they see next. */
export function LearnerPreview({
  port,
  courseId,
  releaseId,
  manifest,
}: {
  port: ReleaseEditingPort;
  courseId: string;
  releaseId: string;
  /** An unsaved draft to preview instead of the saved release. */
  manifest?: unknown;
}) {
  const t = useT();
  const [state, setState] = useState<{
    data?: Preview;
    error?: unknown;
    loading: boolean;
  }>({ loading: false });
  const [profile, setProfile] =
    useState<(typeof PREVIEW_PROFILES)[number]>("new_learner");
  const load = () => {
    setState({ loading: true });
    port.preview(courseId, releaseId, manifest).then(
      (data) => setState({ data, loading: false }),
      (error: unknown) => setState({ error, loading: false }),
    );
  };
  const shown = state.data?.profiles.find((p) => p.profile === profile);
  return (
    <div className="stack learner-preview">
      <Notice tone="blue" title={t("learnerPreview.synthetic.title")}>
        {t("learnerPreview.synthetic.body")}
      </Notice>
      <Button type="button" onClick={load} disabled={state.loading}>
        <Eye size={16} aria-hidden="true" />
        {state.data ? t("learnerPreview.refresh") : t("learnerPreview.show")}
      </Button>
      {state.loading && <Loading label={t("learnerPreview.loading")} />}
      {state.error !== undefined && (
        <Notice tone="red">{releaseEditingErrorMessage(state.error, t)}</Notice>
      )}
      {state.data && (
        <>
          {state.data.source === "unsaved" && (
            <Notice tone="gold">{t("learnerPreview.unsaved")}</Notice>
          )}
          <nav aria-label={t("learnerPreview.profiles")} className="segmented">
            {PREVIEW_PROFILES.map((id) => (
              <Button
                key={id}
                type="button"
                kind={profile === id ? "primary" : "quiet"}
                aria-pressed={profile === id}
                onClick={() => setProfile(id)}
              >
                {t(`learnerPreview.profile.${id}` as MessageKey)}
              </Button>
            ))}
          </nav>
          {shown && <ProfileView preview={state.data} profile={shown} />}
        </>
      )}
    </div>
  );
}

function ProfileView({
  preview,
  profile,
}: {
  preview: Preview;
  profile: Preview["profiles"][number];
}) {
  const i18n = useI18n();
  const t = i18n.t;
  const titles = new Map(
    preview.outline.flatMap((c) =>
      c.episodes.map((e) => [e.id, e.title] as const),
    ),
  );
  return (
    <div className="stack">
      <p>{t(`learnerPreview.profileHelp.${profile.profile}` as MessageKey)}</p>
      <p>
        {t("learnerPreview.counts", {
          completed: profile.counts.completed,
          placed: profile.counts.placed,
          available: profile.counts.available,
          locked: profile.counts.locked,
        })}
      </p>
      <div
        className="preview-roadmap"
        role="region"
        tabIndex={0}
        aria-label={t("learnerPreview.roadmap")}
      >
        {preview.outline.map((chapter) => (
          <section key={chapter.id}>
            <h3 dir="auto">{chapter.title}</h3>
            <ol>
              {profile.lessons
                .filter((lesson) => lesson.chapterId === chapter.id)
                .map((lesson) => (
                  <li key={lesson.episodeId}>
                    <bdi>
                      {titles.get(lesson.episodeId) ?? lesson.episodeId}
                    </bdi>{" "}
                    <Badge tone={STATUS_TONE[lesson.status]}>
                      {t(
                        `learnerPreview.status.${lesson.status}` as MessageKey,
                      )}
                    </Badge>
                    {lesson.requirement === "optional" && (
                      <Badge>{t("learnerPreview.optional")}</Badge>
                    )}
                  </li>
                ))}
            </ol>
          </section>
        ))}
      </div>
      {profile.complete || !profile.next ? (
        <Notice tone="green">{t("learnerPreview.finished")}</Notice>
      ) : (
        <article className="record preview-next">
          <p className="eyebrow">{t("learnerPreview.next")}</p>
          <h3 dir="auto">{profile.next.title}</h3>
          <ol className="stack">
            {profile.next.blocks.map((block) => (
              <li key={block.id}>
                <strong>
                  {t(`learnerPreview.block.${block.type}` as MessageKey)}
                </strong>{" "}
                {block.excerpt && (
                  <span dir="auto" className="preview-excerpt">
                    {block.excerpt}
                    {block.truncated ? "…" : ""}
                  </span>
                )}
              </li>
            ))}
          </ol>
        </article>
      )}
    </div>
  );
}
