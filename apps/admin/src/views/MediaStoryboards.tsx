import { useId, useState } from "react";
import { Check, Film, ListOrdered, Plus, Trash2, X } from "lucide-react";
import {
  mediaErrorMessage,
  type MediaAdminPort,
  type MediaLibrary,
  type Storyboard,
  type StoryboardShot,
} from "../domain/media";
import { useRemote } from "../hooks/useAdmin";
import {
  Badge,
  Button,
  Card,
  Dialog,
  Field,
  Loading,
  Notice,
} from "../components/ui";
import { isolate } from "@course-core/i18n";
import { useT } from "../i18n";

/** What a shot asks for, used to start a request from it. */
export interface ShotRequest {
  storyboard: Storyboard;
  shot: StoryboardShot;
}
type Run = (
  fingerprint: string,
  command: (key: string) => Promise<unknown>,
  success: string,
) => Promise<boolean>;

const seconds = (ms: number | undefined) => (ms ?? 0) / 1000;

/** Storyboards: the shots of one teaching clip, drafted by a model or by staff, approved by a
 * reviewer before any shot is made, then joined into one clip. */
export function StoryboardsCard({
  port,
  library,
  releaseId,
  run,
  pending,
  onMakeShot,
  refreshKey,
}: {
  port: MediaAdminPort;
  library: MediaLibrary;
  releaseId: string;
  run: Run;
  pending: boolean;
  onMakeShot: (request: ShotRequest) => void;
  refreshKey: number;
}) {
  const t = useT();
  const boards = useRemote(
    (signal) => port.storyboards(releaseId, signal),
    [port, releaseId, refreshKey],
  );
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Storyboard>();
  const visualTitle = (id: string | undefined) =>
    library.visuals.find((v) => v.id === id)?.title ?? id ?? "";
  const after = (ok: boolean) => {
    if (ok) boards.reload();
    return ok;
  };
  return (
    <Card
      eyebrow={t("mediaView.storyboards.eyebrow")}
      title={t("mediaView.storyboards.title")}
      actions={
        <Button
          disabled={!library.permissions.request || pending}
          onClick={() => setCreating(true)}
        >
          <ListOrdered size={16} aria-hidden="true" />{" "}
          {t("mediaView.storyboards.create")}
        </Button>
      }
    >
      <p className="media-hint">{t("mediaView.storyboards.intro")}</p>
      {boards.loading && !boards.data ? (
        <Loading label={t("mediaView.storyboards.loading")} />
      ) : boards.error || !boards.data ? (
        <Notice tone="red">{mediaErrorMessage(boards.error, t)}</Notice>
      ) : boards.data.length === 0 ? (
        <p className="research-empty">{t("mediaView.storyboards.empty")}</p>
      ) : (
        <ul
          className="media-jobs"
          aria-label={t("mediaView.storyboards.title")}
        >
          {boards.data.map((board) => {
            const made = (shotId: string) =>
              board.jobs?.filter((j) => j.shotId === shotId) ?? [];
            const allApproved = board.shots.every((shot) =>
              made(shot.id).some(
                (j) => j.state === "approved" || j.state === "attached",
              ),
            );
            return (
              <li key={board.id} className="media-job">
                <div className="media-job-head">
                  <strong dir="auto">{board.title}</strong>
                  <Badge
                    tone={
                      board.state === "approved"
                        ? "green"
                        : board.state === "rejected"
                          ? "red"
                          : "gold"
                    }
                  >
                    {t(`mediaView.storyboards.state.${board.state}`)}
                  </Badge>
                </div>
                {board.draftStatus === "pending" && (
                  <Notice tone="gold">
                    {t("mediaView.storyboards.drafting")}
                  </Notice>
                )}
                {board.draftStatus === "failed" && (
                  <Notice tone="gold">
                    {t("mediaView.storyboards.draftFailed")}
                  </Notice>
                )}
                <p className="media-hint">
                  {t(
                    board.draftedBy === "model"
                      ? "mediaView.storyboards.byModel"
                      : "mediaView.storyboards.byStaff",
                  )}
                  {board.referenceVisualId &&
                    " " +
                      t("mediaView.storyboards.reference", {
                        visual: visualTitle(board.referenceVisualId),
                      })}
                </p>
                <ol className="media-shots">
                  {board.shots.map((shot) => (
                    <li key={shot.id}>
                      <span className="media-label">
                        {shot.kind === "scene"
                          ? t("mediaView.shot.sceneLabel", {
                              visual: visualTitle(shot.visualId),
                              from: seconds(shot.fromMs),
                              to: seconds(shot.toMs),
                            })
                          : t("mediaView.shot.generatedLabel", {
                              seconds: shot.durationSeconds ?? 0,
                            })}
                      </span>{" "}
                      <bdi>{shot.description}</bdi>
                      {made(shot.id).length > 0 && (
                        <small className="media-updated">
                          {" "}
                          {t("mediaView.shot.made", {
                            states: made(shot.id)
                              .map((j) => t(`mediaView.state.${j.state}`))
                              .join(", "),
                          })}
                        </small>
                      )}
                      {board.state === "approved" &&
                        library.permissions.request && (
                          <Button
                            kind="quiet"
                            disabled={pending}
                            aria-label={t("mediaView.shot.makeLabel", {
                              shot: shot.description,
                            })}
                            onClick={() =>
                              onMakeShot({ storyboard: board, shot })
                            }
                          >
                            {t("mediaView.shot.make")}
                          </Button>
                        )}
                    </li>
                  ))}
                </ol>
                <div className="tag-row">
                  {board.state === "draft" && library.permissions.request && (
                    <Button
                      kind="quiet"
                      disabled={pending || board.draftStatus === "pending"}
                      onClick={() => setEditing(board)}
                    >
                      {t("mediaView.storyboards.edit")}
                    </Button>
                  )}
                  {board.state === "draft" && library.permissions.review && (
                    <>
                      <Button
                        disabled={pending || board.draftStatus !== "ready"}
                        onClick={async () =>
                          after(
                            await run(
                              "storyboard-approve:" + board.id + board.revision,
                              (key) =>
                                port.reviewStoryboard(
                                  board.id,
                                  board.revision,
                                  "approved",
                                  key,
                                ),
                              t("mediaView.storyboards.approved"),
                            ),
                          )
                        }
                      >
                        <Check size={16} aria-hidden="true" />{" "}
                        {t("mediaView.storyboards.approve")}
                      </Button>
                      <Button
                        kind="danger"
                        disabled={pending}
                        onClick={async () =>
                          after(
                            await run(
                              "storyboard-reject:" + board.id + board.revision,
                              (key) =>
                                port.reviewStoryboard(
                                  board.id,
                                  board.revision,
                                  "rejected",
                                  key,
                                ),
                              t("mediaView.storyboards.rejected"),
                            ),
                          )
                        }
                      >
                        <X size={16} aria-hidden="true" />{" "}
                        {t("mediaView.storyboards.reject")}
                      </Button>
                    </>
                  )}
                  {board.state === "approved" &&
                    library.permissions.request && (
                      <Button
                        kind="primary"
                        disabled={
                          pending ||
                          !allApproved ||
                          library.clipRendering !== "ready"
                        }
                        onClick={async () =>
                          after(
                            await run(
                              "compose:" + board.id,
                              (key) => port.compose(board.id, key),
                              t("mediaView.storyboards.composed"),
                            ),
                          )
                        }
                      >
                        <Film size={16} aria-hidden="true" />{" "}
                        {t("mediaView.storyboards.compose")}
                      </Button>
                    )}
                </div>
                {board.state === "approved" && !allApproved && (
                  <p className="media-hint">
                    {t("mediaView.storyboards.composeNeeds")}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {creating && (
        <CreateStoryboardDialog
          library={library}
          pending={pending}
          onClose={() => setCreating(false)}
          onSubmit={async (enrollmentId, input) => {
            const ok = await run(
              "storyboard:" + enrollmentId + JSON.stringify(input),
              (key) => port.createStoryboard(enrollmentId, input, key),
              input.draftWith === "model"
                ? t("mediaView.storyboards.createdModel")
                : t("mediaView.storyboards.created"),
            );
            if (after(ok)) setCreating(false);
          }}
        />
      )}
      {editing && (
        <Dialog
          title={t("mediaView.storyboards.editTitle", {
            title: isolate(editing.title),
          })}
          onClose={() => setEditing(undefined)}
          pending={pending}
        >
          <ShotsEditor
            library={library}
            initial={editing.shots}
            pending={pending}
            submitLabel={t("mediaView.storyboards.saveShots")}
            onCancel={() => setEditing(undefined)}
            onSubmit={async (shots) => {
              const ok = await run(
                "storyboard-edit:" +
                  editing.id +
                  editing.revision +
                  JSON.stringify(shots),
                (key) =>
                  port.editStoryboard(editing.id, editing.revision, shots, key),
                t("mediaView.storyboards.saved"),
              );
              if (after(ok)) setEditing(undefined);
            }}
          />
        </Dialog>
      )}
    </Card>
  );
}

function CreateStoryboardDialog({
  library,
  pending,
  onClose,
  onSubmit,
}: {
  library: MediaLibrary;
  pending: boolean;
  onClose: () => void;
  onSubmit: (
    enrollmentId: string,
    input: Parameters<MediaAdminPort["createStoryboard"]>[1],
  ) => void;
}) {
  const t = useT();
  const id = useId();
  const [enrollmentId, setEnrollmentId] = useState(
    library.enrollments[0]?.id ?? "",
  );
  const [episodeId, setEpisodeId] = useState(library.episodes[0]?.id ?? "");
  const [title, setTitle] = useState("");
  const [objective, setObjective] = useState("");
  const [script, setScript] = useState("");
  const [reference, setReference] = useState("");
  const [draftWith, setDraftWith] = useState<"model" | "staff">("model");
  const valid =
    enrollmentId &&
    episodeId &&
    title.trim().length >= 3 &&
    objective.trim().length >= 10 &&
    script.trim().length >= 20;
  const input = {
    episodeId,
    title: title.trim(),
    objective: objective.trim(),
    script: script.trim(),
    ...(reference ? { referenceVisualId: reference } : {}),
  };
  return (
    <Dialog
      title={t("mediaView.storyboards.createTitle")}
      onClose={onClose}
      pending={pending}
    >
      <div className="stack">
        <p>{t("mediaView.storyboards.createIntro")}</p>
        <Field label={t("mediaView.fact.learner")} htmlFor={id + "-learner"}>
          <select
            id={id + "-learner"}
            value={enrollmentId}
            onChange={(e) => setEnrollmentId(e.target.value)}
          >
            {library.enrollments.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("mediaView.fact.episode")} htmlFor={id + "-episode"}>
          <select
            id={id + "-episode"}
            value={episodeId}
            onChange={(e) => setEpisodeId(e.target.value)}
          >
            {library.episodes.map((e) => (
              <option key={e.id} value={e.id}>
                {e.title}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("mediaView.request.clipTitle")} htmlFor={id + "-title"}>
          <input
            id={id + "-title"}
            value={title}
            maxLength={200}
            onChange={(e) => setTitle(e.target.value)}
          />
        </Field>
        <Field
          label={t("mediaView.request.purpose")}
          htmlFor={id + "-objective"}
          hint={t("mediaView.request.purposeHint")}
        >
          <textarea
            id={id + "-objective"}
            value={objective}
            maxLength={2000}
            onChange={(e) => setObjective(e.target.value)}
          />
        </Field>
        <Field
          label={t("mediaView.storyboards.script")}
          htmlFor={id + "-script"}
          hint={t("mediaView.storyboards.scriptHint")}
        >
          <textarea
            id={id + "-script"}
            value={script}
            maxLength={8000}
            onChange={(e) => setScript(e.target.value)}
          />
        </Field>
        <ReferenceSelect
          library={library}
          value={reference}
          onChange={setReference}
        />
        <fieldset>
          <legend>{t("mediaView.storyboards.howTitle")}</legend>
          {(["model", "staff"] as const).map((value) => (
            <label key={value} className="check-label">
              <input
                type="radio"
                name={id + "-how"}
                checked={draftWith === value}
                onChange={() => setDraftWith(value)}
              />
              {value === "model"
                ? t("mediaView.storyboards.howModel")
                : t("mediaView.storyboards.howStaff")}
            </label>
          ))}
        </fieldset>
        {draftWith === "model" ? (
          <div className="tag-row">
            <Button onClick={onClose} disabled={pending}>
              {t("mediaView.cancel")}
            </Button>
            <Button
              kind="primary"
              disabled={pending || !valid}
              onClick={() =>
                valid && onSubmit(enrollmentId, { ...input, draftWith })
              }
            >
              {t("mediaView.storyboards.draftButton")}
            </Button>
          </div>
        ) : (
          <ShotsEditor
            library={library}
            initial={[
              {
                id: "shot-1",
                kind: "generated",
                description: "",
                narration: "",
                durationSeconds: 4,
              },
            ]}
            pending={pending || !valid}
            submitLabel={t("mediaView.storyboards.createButton")}
            onCancel={onClose}
            onSubmit={(shots) =>
              onSubmit(enrollmentId, { ...input, draftWith, shots })
            }
          />
        )}
      </div>
    </Dialog>
  );
}

/** Optional: a verified course visual the automated check compares the media with. */
export function ReferenceSelect({
  library,
  value,
  onChange,
}: {
  library: MediaLibrary;
  value: string;
  onChange: (value: string) => void;
}) {
  const t = useT();
  const id = useId();
  if (library.visuals.length === 0) return null;
  return (
    <Field
      label={t("mediaView.reference.label")}
      htmlFor={id}
      hint={t("mediaView.reference.hint")}
    >
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{t("mediaView.reference.none")}</option>
        {library.visuals.map((v) => (
          <option key={v.id} value={v.id}>
            {v.title}
          </option>
        ))}
      </select>
    </Field>
  );
}

function ShotsEditor({
  library,
  initial,
  pending,
  submitLabel,
  onCancel,
  onSubmit,
}: {
  library: MediaLibrary;
  initial: StoryboardShot[];
  pending: boolean;
  submitLabel: string;
  onCancel: () => void;
  onSubmit: (shots: StoryboardShot[]) => void;
}) {
  const t = useT();
  const id = useId();
  const [shots, setShots] = useState(initial);
  const set = (index: number, patch: Partial<StoryboardShot>) =>
    setShots(shots.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  const firstVisual = library.visuals[0];
  const valid = shots.every(
    (s) =>
      s.description.trim().length >= 10 &&
      (s.kind === "generated"
        ? (s.durationSeconds ?? 0) >= 1
        : s.visualId && (s.toMs ?? 0) > (s.fromMs ?? 0)),
  );
  const clean = (): StoryboardShot[] =>
    shots.map((s, i) => {
      const base = {
        id: `shot-${i + 1}`,
        kind: s.kind,
        description: s.description.trim(),
        narration: s.narration.trim(),
      };
      return s.kind === "generated"
        ? { ...base, durationSeconds: s.durationSeconds ?? 4 }
        : {
            ...base,
            visualId: s.visualId!,
            fromMs: s.fromMs ?? 0,
            toMs: s.toMs ?? 1000,
          };
    });
  return (
    <form
      className="stack media-review"
      aria-label={t("mediaView.shots.label")}
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) onSubmit(clean());
      }}
    >
      {shots.map((shot, index) => (
        <fieldset key={index} className="media-shot-edit">
          <legend>{t("mediaView.shots.legend", { number: index + 1 })}</legend>
          <Field
            label={t("mediaView.shots.kind")}
            htmlFor={`${id}-${index}-kind`}
          >
            <select
              id={`${id}-${index}-kind`}
              value={shot.kind}
              onChange={(e) =>
                set(
                  index,
                  e.target.value === "scene"
                    ? {
                        kind: "scene",
                        visualId: firstVisual?.id,
                        fromMs: 0,
                        toMs: Math.min(firstVisual?.durationMs ?? 1000, 4000),
                        durationSeconds: undefined,
                      }
                    : {
                        kind: "generated",
                        durationSeconds: 4,
                        visualId: undefined,
                        fromMs: undefined,
                        toMs: undefined,
                      },
                )
              }
            >
              <option value="generated">
                {t("mediaView.shots.kindGenerated")}
              </option>
              {firstVisual && (
                <option value="scene">{t("mediaView.shots.kindScene")}</option>
              )}
            </select>
          </Field>
          <Field
            label={t("mediaView.shots.description")}
            htmlFor={`${id}-${index}-description`}
            hint={t("mediaView.shots.descriptionHint")}
          >
            <textarea
              id={`${id}-${index}-description`}
              value={shot.description}
              maxLength={1000}
              onChange={(e) => set(index, { description: e.target.value })}
            />
          </Field>
          <Field
            label={t("mediaView.shots.narration")}
            htmlFor={`${id}-${index}-narration`}
          >
            <textarea
              id={`${id}-${index}-narration`}
              value={shot.narration}
              maxLength={2000}
              onChange={(e) => set(index, { narration: e.target.value })}
            />
          </Field>
          {shot.kind === "generated" ? (
            <Field
              label={t("mediaView.shots.duration")}
              htmlFor={`${id}-${index}-duration`}
            >
              <input
                id={`${id}-${index}-duration`}
                type="number"
                min={1}
                max={20}
                value={shot.durationSeconds ?? 4}
                onChange={(e) =>
                  set(index, { durationSeconds: Number(e.target.value) })
                }
              />
            </Field>
          ) : (
            <>
              <Field
                label={t("mediaView.clip.visual")}
                htmlFor={`${id}-${index}-visual`}
              >
                <select
                  id={`${id}-${index}-visual`}
                  value={shot.visualId}
                  onChange={(e) => set(index, { visualId: e.target.value })}
                >
                  {library.visuals.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.title}
                    </option>
                  ))}
                </select>
              </Field>
              <div className="media-range">
                <Field
                  label={t("mediaView.clip.from")}
                  htmlFor={`${id}-${index}-from`}
                >
                  <input
                    id={`${id}-${index}-from`}
                    type="number"
                    min={0}
                    step={0.1}
                    value={seconds(shot.fromMs)}
                    onChange={(e) =>
                      set(index, {
                        fromMs: Math.round(Number(e.target.value) * 1000),
                      })
                    }
                  />
                </Field>
                <Field
                  label={t("mediaView.clip.to")}
                  htmlFor={`${id}-${index}-to`}
                >
                  <input
                    id={`${id}-${index}-to`}
                    type="number"
                    min={0.1}
                    step={0.1}
                    value={seconds(shot.toMs)}
                    onChange={(e) =>
                      set(index, {
                        toMs: Math.round(Number(e.target.value) * 1000),
                      })
                    }
                  />
                </Field>
              </div>
            </>
          )}
          {shots.length > 1 && (
            <Button
              kind="quiet"
              type="button"
              onClick={() => setShots(shots.filter((_, i) => i !== index))}
              aria-label={t("mediaView.shots.removeLabel", {
                number: index + 1,
              })}
            >
              <Trash2 size={16} aria-hidden="true" />{" "}
              {t("mediaView.shots.remove")}
            </Button>
          )}
        </fieldset>
      ))}
      <div className="tag-row dialog-footer">
        <Button
          type="button"
          disabled={shots.length >= 8}
          onClick={() =>
            setShots([
              ...shots,
              {
                id: `shot-${shots.length + 1}`,
                kind: "generated",
                description: "",
                narration: "",
                durationSeconds: 4,
              },
            ])
          }
        >
          <Plus size={16} aria-hidden="true" /> {t("mediaView.shots.add")}
        </Button>
        <Button type="button" onClick={onCancel}>
          {t("mediaView.cancel")}
        </Button>
        <Button kind="primary" type="submit" disabled={pending || !valid}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
