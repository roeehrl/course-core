import { useId, useState } from "react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import type { AdminClient } from "../domain/contracts";
import type { WorkspaceActions } from "../hooks/useAdmin";
import { useRemote } from "../hooks/useAdmin";
import {
  asEditable,
  blockEdits,
  chapterEdits,
  episodeEdits,
  localProblems,
  releaseEditingErrorMessage,
  type EditableEpisode,
  type EditableManifest,
  type ManifestCheck,
  type ReleaseEditingPort,
} from "../domain/releaseEditing";
import { ActionFeedback } from "./ActionFeedback";
import { DraftEditorBody } from "./DraftEditor";
import { LearnerPreview } from "./LearnerPreview";
import {
  Badge,
  Button,
  Dialog,
  ErrorState,
  Field,
  Loading,
  Notice,
} from "./ui";
import { useI18n, useT, type MessageKey } from "../i18n";

type Tab = "structure" | "preview" | "file";

/** The draft editor: chapters and lessons as forms, a learner preview of the unsaved draft, and
 * the whole manifest file for everything else. Saving always checks the draft on the server first. */
export function StructuredDraftEditor({
  client,
  port,
  courseId,
  releaseId,
  actions,
  onClose,
}: {
  client: AdminClient;
  port: ReleaseEditingPort;
  courseId: string;
  releaseId: string;
  actions: WorkspaceActions;
  onClose: () => void;
}) {
  const t = useT();
  const remote = useRemote(
    (signal) => client.getReleaseManifest!(courseId, releaseId, signal),
    [client, courseId, releaseId],
  );
  const save = async (input: { manifest: unknown; notes: string }) => {
    const result = await actions.run(
      JSON.stringify(["draft-bundle", releaseId, input]),
      (context) => client.updateRelease!(courseId, releaseId, input, context),
    );
    if (result) onClose();
  };
  return (
    <Dialog
      title={t("structuredDraftEditor.title")}
      onClose={onClose}
      pending={actions.pending}
      className="structured-editor"
    >
      <ActionFeedback actions={actions} />
      {remote.loading ? (
        <Loading label={t("structuredDraftEditor.loading")} />
      ) : remote.error ? (
        <ErrorState error={remote.error} onRetry={remote.reload} />
      ) : (
        remote.data && (
          <Editor
            key={releaseId}
            port={port}
            courseId={courseId}
            releaseId={releaseId}
            data={remote.data}
            pending={actions.pending}
            onSave={save}
          />
        )
      )}
    </Dialog>
  );
}

function Editor({
  port,
  courseId,
  releaseId,
  data,
  pending,
  onSave,
}: {
  port: ReleaseEditingPort;
  courseId: string;
  releaseId: string;
  data: { manifest: unknown; notes: string; editable: boolean };
  pending: boolean;
  onSave: (input: { manifest: unknown; notes: string }) => Promise<void>;
}) {
  const t = useT();
  const id = useId();
  const initial = asEditable(data.manifest);
  const [manifest, setManifest] = useState<EditableManifest | null>(initial);
  const [notes, setNotes] = useState(data.notes);
  const [tab, setTab] = useState<Tab>(initial ? "structure" : "file");
  const [check, setCheck] = useState<{
    result?: ManifestCheck;
    error?: unknown;
    checking: boolean;
  }>({ checking: false });
  const locked = pending || !data.editable;
  const change = (next: EditableManifest) => {
    setManifest(next);
    setCheck({ checking: false });
  };
  const problems = manifest ? localProblems(manifest) : [];
  async function runCheck() {
    if (!manifest) return null;
    setCheck({ checking: true });
    try {
      const result = await port.check(courseId, releaseId, manifest);
      setCheck({ result, checking: false });
      return result;
    } catch (error) {
      setCheck({ error, checking: false });
      return null;
    }
  }
  const tabs: { id: Tab; label: string }[] = [
    { id: "structure", label: t("structuredDraftEditor.tab.structure") },
    { id: "preview", label: t("structuredDraftEditor.tab.preview") },
    { id: "file", label: t("structuredDraftEditor.tab.file") },
  ];
  return (
    <div className="stack">
      {!data.editable && (
        <Notice tone="gold">{t("structuredDraftEditor.readOnly")}</Notice>
      )}
      <nav aria-label={t("structuredDraftEditor.tabs")} className="segmented">
        {tabs.map((item) => (
          <Button
            key={item.id}
            kind={tab === item.id ? "primary" : "quiet"}
            aria-pressed={tab === item.id}
            disabled={item.id !== "file" && !manifest}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </Button>
        ))}
      </nav>
      {!manifest && (
        <Notice tone="gold">{t("structuredDraftEditor.unsupported")}</Notice>
      )}
      {tab === "file" && (
        <DraftEditorBody
          data={{ ...data, manifest: manifest ?? data.manifest, notes }}
          pending={pending}
          onSave={(input) => void onSave(input)}
        />
      )}
      {tab === "preview" && manifest && (
        <LearnerPreview
          port={port}
          courseId={courseId}
          releaseId={releaseId}
          manifest={manifest}
        />
      )}
      {tab === "structure" && manifest && (
        <form
          className="stack"
          onSubmit={async (event) => {
            event.preventDefault();
            if (problems.length) return;
            // Test before save: the server checks the exact draft; only a clean one is saved.
            const result = await runCheck();
            if (result?.valid && result.identityMatches !== false)
              await onSave({ manifest, notes });
          }}
        >
          <p>{t("structuredDraftEditor.intro")}</p>
          {manifest.chapters.map((chapter, index) => (
            <ChapterEditor
              key={chapter.id}
              manifest={manifest}
              chapterId={chapter.id}
              index={index}
              locked={locked}
              onChange={change}
            />
          ))}
          <AddChapter manifest={manifest} locked={locked} onChange={change} />
          <Field
            label={t("structuredDraftEditor.notes")}
            htmlFor={`${id}-notes`}
          >
            <textarea
              id={`${id}-notes`}
              dir="auto"
              value={notes}
              maxLength={1200}
              disabled={locked}
              onChange={(e) => setNotes(e.target.value)}
            />
          </Field>
          {problems.length > 0 && (
            <Notice
              tone="gold"
              title={t("structuredDraftEditor.problems.title")}
            >
              <ul>
                {problems.map((problem) => (
                  <li key={`${problem.code}:${problem.id}`}>
                    {t(
                      `structuredDraftEditor.problem.${problem.code}` as MessageKey,
                      {
                        name: titleOf(manifest, problem.id),
                      },
                    )}
                  </li>
                ))}
              </ul>
            </Notice>
          )}
          <CheckResult manifest={manifest} check={check} />
          <div className="button-row">
            <Button
              type="button"
              disabled={locked || check.checking || problems.length > 0}
              onClick={() => void runCheck()}
            >
              {check.checking
                ? t("structuredDraftEditor.checking")
                : t("structuredDraftEditor.check")}
            </Button>
            <Button
              type="submit"
              kind="primary"
              disabled={locked || check.checking || problems.length > 0}
            >
              {pending
                ? t("structuredDraftEditor.saving")
                : t("structuredDraftEditor.save")}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

/** A chapter or lesson title for messages, or its id when it has none. */
function titleOf(manifest: EditableManifest, id: string) {
  for (const chapter of manifest.chapters) {
    if (chapter.id === id) return chapter.title || id;
    const episode = chapter.episodes.find((e) => e.id === id);
    if (episode) return episode.title || id;
  }
  return id;
}
/** "/chapters/0/episodes/1/title" as the chapter and lesson names staff see. */
export function describePath(manifest: EditableManifest, path: string) {
  const parts = path.split("/").filter(Boolean);
  const names: string[] = [];
  if (parts[0] === "chapters" && parts[1] !== undefined) {
    const chapter = manifest.chapters[Number(parts[1])];
    if (chapter) names.push(chapter.title || chapter.id);
    if (parts[2] === "episodes" && parts[3] !== undefined) {
      const episode = chapter?.episodes[Number(parts[3])];
      if (episode) names.push(episode.title || episode.id);
    }
  }
  return names;
}

function CheckResult({
  manifest,
  check,
}: {
  manifest: EditableManifest;
  check: { result?: ManifestCheck; error?: unknown };
}) {
  const i18n = useI18n();
  const t = i18n.t;
  if (check.error)
    return (
      <Notice tone="red">{releaseEditingErrorMessage(check.error, t)}</Notice>
    );
  const result = check.result;
  if (!result) return null;
  if (!result.valid)
    return (
      <Notice tone="red" title={t("structuredDraftEditor.result.invalid")}>
        <ul>
          {result.issues.map((issue, index) => {
            const where = describePath(manifest, issue.path);
            const key =
              `structuredDraftEditor.issue.${issue.code}` as MessageKey;
            return (
              <li key={index}>
                {where.length > 0 && <bdi>{where.join(" › ")}</bdi>}
                {where.length > 0 && ": "}
                {i18n.has(key)
                  ? t(key)
                  : t("structuredDraftEditor.issue.other", {
                      code: issue.code,
                    })}{" "}
                <small className="mono" dir="ltr">
                  {issue.path}
                </small>
              </li>
            );
          })}
        </ul>
      </Notice>
    );
  if (result.identityMatches === false)
    return (
      <Notice tone="red">{t("structuredDraftEditor.result.identity")}</Notice>
    );
  return (
    <div className="stack">
      <Notice tone="green" title={t("structuredDraftEditor.result.valid")}>
        {t("structuredDraftEditor.result.summary", {
          chapters: result.summary?.chapters ?? 0,
          lessons: result.summary?.episodes ?? 0,
          checks: result.summary?.assessments ?? 0,
        })}{" "}
        {result.changes
          ? result.changes.identical
            ? t("structuredDraftEditor.result.identical")
            : t("structuredDraftEditor.result.changes", {
                count: result.changes.changes,
              })
          : t("structuredDraftEditor.result.noLive")}
      </Notice>
      {result.runtime && !result.runtime.ready && (
        <Notice tone="gold" title={t("structuredDraftEditor.result.runtime")}>
          {t("structuredDraftEditor.result.runtimeBody")}{" "}
          <small className="mono" dir="ltr">
            {result.runtime.code}
          </small>
        </Notice>
      )}
    </div>
  );
}

function ChapterEditor({
  manifest,
  chapterId,
  index,
  locked,
  onChange,
}: {
  manifest: EditableManifest;
  chapterId: string;
  index: number;
  locked: boolean;
  onChange: (next: EditableManifest) => void;
}) {
  const t = useT();
  const id = useId();
  const chapter = manifest.chapters.find((c) => c.id === chapterId)!;
  const [newLesson, setNewLesson] = useState("");
  return (
    <fieldset className="editor-chapter">
      <legend>
        {t("structuredDraftEditor.chapter.legend", { number: index + 1 })}
      </legend>
      <Field
        label={t("structuredDraftEditor.chapter.title")}
        htmlFor={`${id}-title`}
      >
        <input
          id={`${id}-title`}
          dir="auto"
          value={chapter.title}
          maxLength={200}
          required
          disabled={locked}
          onChange={(e) =>
            onChange(chapterEdits.rename(manifest, chapterId, e.target.value))
          }
        />
      </Field>
      <Field
        label={t("structuredDraftEditor.chapter.summary")}
        htmlFor={`${id}-summary`}
      >
        <textarea
          id={`${id}-summary`}
          dir="auto"
          value={chapter.summary ?? ""}
          maxLength={2000}
          disabled={locked}
          onChange={(e) =>
            onChange(chapterEdits.summary(manifest, chapterId, e.target.value))
          }
        />
      </Field>
      <div className="button-row">
        <Button
          type="button"
          kind="quiet"
          disabled={locked || index === 0}
          onClick={() => onChange(chapterEdits.move(manifest, chapterId, -1))}
        >
          <ArrowUp size={16} aria-hidden="true" />
          {t("structuredDraftEditor.chapter.up")}
        </Button>
        <Button
          type="button"
          kind="quiet"
          disabled={locked || index === manifest.chapters.length - 1}
          onClick={() => onChange(chapterEdits.move(manifest, chapterId, 1))}
        >
          <ArrowDown size={16} aria-hidden="true" />
          {t("structuredDraftEditor.chapter.down")}
        </Button>
        <Button
          type="button"
          kind="danger"
          disabled={locked || manifest.chapters.length === 1}
          onClick={() => onChange(chapterEdits.remove(manifest, chapterId))}
        >
          <Trash2 size={16} aria-hidden="true" />
          {t("structuredDraftEditor.chapter.remove", { name: chapter.title })}
        </Button>
      </div>
      <ol className="editor-lessons">
        {chapter.episodes.map((episode, position) => (
          <li key={episode.id}>
            <LessonEditor
              manifest={manifest}
              episode={episode}
              chapterId={chapterId}
              first={position === 0}
              last={position === chapter.episodes.length - 1}
              locked={locked}
              onChange={onChange}
            />
          </li>
        ))}
      </ol>
      <div className="inline-add">
        <Field
          label={t("structuredDraftEditor.lesson.newTitle")}
          htmlFor={`${id}-new`}
        >
          <input
            id={`${id}-new`}
            dir="auto"
            value={newLesson}
            maxLength={200}
            disabled={locked}
            onChange={(e) => setNewLesson(e.target.value)}
          />
        </Field>
        <Button
          type="button"
          disabled={locked || !newLesson.trim()}
          onClick={() => {
            onChange(episodeEdits.add(manifest, chapterId, newLesson.trim()));
            setNewLesson("");
          }}
        >
          <Plus size={16} aria-hidden="true" />
          {t("structuredDraftEditor.lesson.add")}
        </Button>
      </div>
    </fieldset>
  );
}

function LessonEditor({
  manifest,
  episode,
  chapterId,
  first,
  last,
  locked,
  onChange,
}: {
  manifest: EditableManifest;
  episode: EditableEpisode;
  chapterId: string;
  first: boolean;
  last: boolean;
  locked: boolean;
  onChange: (next: EditableManifest) => void;
}) {
  const t = useT();
  const id = useId();
  const chapter = manifest.chapters.find((c) => c.id === chapterId)!;
  return (
    <details className="editor-lesson">
      <summary>
        <bdi>{episode.title || episode.id}</bdi>{" "}
        {episode.requirement === "optional" && (
          <Badge>{t("structuredDraftEditor.lesson.optional")}</Badge>
        )}
        {episode.gateId && (
          <Badge tone="blue">{t("structuredDraftEditor.lesson.gated")}</Badge>
        )}
      </summary>
      <div className="stack">
        <Field
          label={t("structuredDraftEditor.lesson.title")}
          htmlFor={`${id}-title`}
        >
          <input
            id={`${id}-title`}
            dir="auto"
            value={episode.title}
            maxLength={200}
            required
            disabled={locked}
            onChange={(e) =>
              onChange(
                episodeEdits.rename(manifest, episode.id, e.target.value),
              )
            }
          />
        </Field>
        <Field
          label={t("structuredDraftEditor.lesson.requirement")}
          htmlFor={`${id}-req`}
        >
          <select
            id={`${id}-req`}
            value={episode.requirement ?? "required"}
            disabled={locked}
            onChange={(e) =>
              onChange(
                episodeEdits.requirement(
                  manifest,
                  episode.id,
                  e.target.value as "required" | "optional",
                ),
              )
            }
          >
            <option value="required">
              {t("structuredDraftEditor.lesson.required")}
            </option>
            <option value="optional">
              {t("structuredDraftEditor.lesson.optional")}
            </option>
          </select>
        </Field>
        <fieldset className="editor-objectives">
          <legend>{t("structuredDraftEditor.lesson.objectives")}</legend>
          {manifest.objectives.map((objective) => (
            <label key={objective.id} className="check-label">
              <input
                type="checkbox"
                checked={episode.objectiveIds.includes(objective.id)}
                disabled={locked}
                onChange={(e) =>
                  onChange(
                    episodeEdits.objectives(
                      manifest,
                      episode.id,
                      e.target.checked
                        ? [...episode.objectiveIds, objective.id]
                        : episode.objectiveIds.filter(
                            (o) => o !== objective.id,
                          ),
                    ),
                  )
                }
              />
              <bdi>{objective.description}</bdi>
            </label>
          ))}
        </fieldset>
        <ol className="editor-blocks">
          {episode.blocks.map((block, position) => (
            <li key={block.id}>
              {block.type === "text" ? (
                <Field
                  label={t("structuredDraftEditor.block.text", {
                    number: position + 1,
                  })}
                  htmlFor={`${id}-${block.id}`}
                >
                  <textarea
                    id={`${id}-${block.id}`}
                    dir="auto"
                    value={block.markdown ?? ""}
                    maxLength={20000}
                    disabled={locked}
                    onChange={(e) =>
                      onChange(
                        blockEdits.text(
                          manifest,
                          episode.id,
                          block.id,
                          e.target.value,
                        ),
                      )
                    }
                  />
                </Field>
              ) : (
                <p className="editor-fixed-block">
                  {t(
                    `structuredDraftEditor.block.kind.${["assessment", "visual", "media", "activity"].includes(block.type) ? block.type : "other"}` as MessageKey,
                  )}{" "}
                  <small className="mono" dir="ltr">
                    {String(
                      block.assessmentId ??
                        block.visualId ??
                        block.mediaId ??
                        block.id,
                    )}
                  </small>
                </p>
              )}
              <div className="button-row">
                <Button
                  type="button"
                  kind="quiet"
                  aria-label={t("structuredDraftEditor.block.up", {
                    number: position + 1,
                  })}
                  disabled={locked || position === 0}
                  onClick={() =>
                    onChange(
                      blockEdits.move(manifest, episode.id, block.id, -1),
                    )
                  }
                >
                  <ArrowUp size={16} aria-hidden="true" />
                </Button>
                <Button
                  type="button"
                  kind="quiet"
                  aria-label={t("structuredDraftEditor.block.down", {
                    number: position + 1,
                  })}
                  disabled={locked || position === episode.blocks.length - 1}
                  onClick={() =>
                    onChange(blockEdits.move(manifest, episode.id, block.id, 1))
                  }
                >
                  <ArrowDown size={16} aria-hidden="true" />
                </Button>
                {block.type === "text" && (
                  <Button
                    type="button"
                    kind="quiet"
                    aria-label={t("structuredDraftEditor.block.remove", {
                      number: position + 1,
                    })}
                    disabled={locked || episode.blocks.length === 1}
                    onClick={() =>
                      onChange(
                        blockEdits.remove(manifest, episode.id, block.id),
                      )
                    }
                  >
                    <Trash2 size={16} aria-hidden="true" />
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ol>
        <Button
          type="button"
          disabled={locked}
          onClick={() => onChange(blockEdits.addText(manifest, episode.id))}
        >
          <Plus size={16} aria-hidden="true" />
          {t("structuredDraftEditor.block.add")}
        </Button>
        <div className="button-row">
          <Button
            type="button"
            kind="quiet"
            disabled={locked || first}
            onClick={() =>
              onChange(episodeEdits.move(manifest, episode.id, -1))
            }
          >
            <ArrowUp size={16} aria-hidden="true" />
            {t("structuredDraftEditor.lesson.up")}
          </Button>
          <Button
            type="button"
            kind="quiet"
            disabled={locked || last}
            onClick={() => onChange(episodeEdits.move(manifest, episode.id, 1))}
          >
            <ArrowDown size={16} aria-hidden="true" />
            {t("structuredDraftEditor.lesson.down")}
          </Button>
          {manifest.chapters.length > 1 && (
            <Field
              label={t("structuredDraftEditor.lesson.moveTo")}
              htmlFor={`${id}-move`}
            >
              <select
                id={`${id}-move`}
                value={chapterId}
                disabled={locked || chapter.episodes.length === 1}
                onChange={(e) =>
                  onChange(
                    episodeEdits.toChapter(
                      manifest,
                      episode.id,
                      e.target.value,
                    ),
                  )
                }
              >
                {manifest.chapters.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title || c.id}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Button
            type="button"
            kind="danger"
            disabled={locked || chapter.episodes.length === 1}
            onClick={() => onChange(episodeEdits.remove(manifest, episode.id))}
          >
            <Trash2 size={16} aria-hidden="true" />
            {t("structuredDraftEditor.lesson.remove", { name: episode.title })}
          </Button>
        </div>
      </div>
    </details>
  );
}

function AddChapter({
  manifest,
  locked,
  onChange,
}: {
  manifest: EditableManifest;
  locked: boolean;
  onChange: (next: EditableManifest) => void;
}) {
  const t = useT();
  const id = useId();
  const [title, setTitle] = useState("");
  const [lesson, setLesson] = useState("");
  return (
    <fieldset className="editor-chapter new">
      <legend>{t("structuredDraftEditor.chapter.new")}</legend>
      <Field
        label={t("structuredDraftEditor.chapter.title")}
        htmlFor={`${id}-title`}
      >
        <input
          id={`${id}-title`}
          dir="auto"
          value={title}
          maxLength={200}
          disabled={locked}
          onChange={(e) => setTitle(e.target.value)}
        />
      </Field>
      <Field
        label={t("structuredDraftEditor.chapter.firstLesson")}
        htmlFor={`${id}-lesson`}
        hint={t("structuredDraftEditor.chapter.firstLessonHint")}
      >
        <input
          id={`${id}-lesson`}
          dir="auto"
          value={lesson}
          maxLength={200}
          disabled={locked}
          onChange={(e) => setLesson(e.target.value)}
        />
      </Field>
      <Button
        type="button"
        disabled={locked || !title.trim() || !lesson.trim()}
        onClick={() => {
          onChange(chapterEdits.add(manifest, title.trim(), lesson.trim()));
          setTitle("");
          setLesson("");
        }}
      >
        <Plus size={16} aria-hidden="true" />
        {t("structuredDraftEditor.chapter.add")}
      </Button>
    </fieldset>
  );
}
