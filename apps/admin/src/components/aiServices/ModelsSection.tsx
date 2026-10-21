import { useEffect, useId, useMemo, useState } from "react";
import {
  JOBS,
  NEEDED_JOBS,
  activeRoles,
  type Assignment,
  type Job,
  type MediaChoice,
  type ModelList,
  type SectionState,
} from "../../domain/aiServices";
import type { SectionProps } from "./AiServicesPage";
import {
  ErrorSummary,
  Field,
  Ltr,
  Message,
  Section,
  described,
  errorText,
  jobName,
  keyProblemText,
  serviceName,
  useAiText,
  type FieldError,
} from "./shared";
import { AiServicesError } from "../../domain/aiServices";

type Props = SectionProps & { state: SectionState; unsaved: boolean };
type Choice = {
  connectionId: string;
  remoteModel: string;
  media?: MediaChoice;
} | null;
const OPTIONAL_JOBS = JOBS.filter((job) => !NEEDED_JOBS.includes(job));
const encode = (choice: Choice) =>
  choice ? `${choice.connectionId}\u0000${choice.remoteModel}` : "";
/**
 * Previews, experiments and special-purpose models (speech, live audio, embeddings, image-only,
 * lite variants) are listed only under "Show all models", unless the job needs them: the images
 * and video job is offered image and video models.
 */
const SPECIALTY =
  /preview|experimental|(^|[-.])exp([-.]|$)|lite|tts|audio|live|embedding|image|imagen|veo|robotics|transcribe|translate/;
const MEDIA_MODELS = /image|imagen|veo|video/;
export function specialtyModel(job: Job, remoteModel: string) {
  const id = remoteModel.toLowerCase();
  return SPECIALTY.test(id) && !(job === "media" && MEDIA_MODELS.test(id));
}
const same = (a: Choice, b: Choice) =>
  encode(a) === encode(b) &&
  JSON.stringify(a?.media ?? null) === JSON.stringify(b?.media ?? null);

/** The model lists of every usable connection, loaded once per connection set. */
function useModelLists(props: Props) {
  const { port, workspaceId, data } = props;
  const usable = useMemo(
    () =>
      data.connections.connections.filter(
        (c) => c.keyStored && c.keyStatus !== "rejected",
      ),
    [data.connections],
  );
  const ids = usable.map((c) => c.id).join(",");
  const [lists, setLists] = useState<
    Record<string, ModelList | { error: string }>
  >({});
  useEffect(() => {
    const controller = new AbortController();
    for (const id of ids ? ids.split(",") : [])
      port
        .models(workspaceId, id, controller.signal)
        .then((list) => setLists((current) => ({ ...current, [id]: list })))
        .catch((error: unknown) => {
          if (!controller.signal.aborted)
            setLists((current) => ({
              ...current,
              [id]: {
                error:
                  error instanceof AiServicesError ? error.code : "UNAVAILABLE",
              },
            }));
        });
    return () => controller.abort();
  }, [port, workspaceId, ids]);
  return { usable, lists };
}

export function ModelsSection(props: Props) {
  const text = useAiText();
  const { t } = text;
  const { data, port, workspaceId, reload, activate, onDirty } = props;
  const base = useId().replaceAll(":", "");
  const { usable, lists } = useModelLists(props);
  const active = useMemo(
    () => activeRoles(data.setup.configuration),
    [data.setup.configuration],
  );
  const draft = data.draft;
  // What the form starts from: the open draft, else what is on, else the suggestions.
  const initial = useMemo(() => {
    const result = {} as Record<Job, Choice>;
    for (const job of JOBS) {
      const fromDraft = draft?.roles.find((r) => r.role === job);
      const fromActive = active.find((r) => r.role === job);
      const source = draft ? fromDraft : fromActive;
      result[job] =
        source?.connectionId && source.remoteModel
          ? {
              connectionId: source.connectionId,
              remoteModel: source.remoteModel,
              ...(job === "media"
                ? { media: { kind: source.mediaKind ?? "image" } }
                : {}),
            }
          : null;
      if (!result[job] && NEEDED_JOBS.includes(job) && !source)
        for (const connection of usable) {
          const list = lists[connection.id];
          const suggested =
            list && "roles" in list
              ? list.roles.find((r) => r.role === job)?.suggested
              : null;
          if (suggested) {
            result[job] = {
              connectionId: connection.id,
              remoteModel: suggested,
            };
            break;
          }
        }
    }
    return result;
  }, [draft, active, usable, lists]);
  const [choices, setChoices] = useState(initial);
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (!touched) setChoices(initial);
  }, [initial, touched]);
  const [showAll, setShowAll] = useState(false);
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [message, setMessage] = useState<{
    tone: "ok" | "info" | "error";
    text: string;
  }>();
  const [saving, setSaving] = useState(false);
  // "Waiting for a check" is stale once the draft is gone (approved, activated or discarded).
  useEffect(() => {
    if (!draft)
      setMessage((current) => (current?.tone === "info" ? undefined : current));
  }, [draft]);
  // Unsaved: the form differs from what is saved (draft or active), not from the suggestions.
  const saved = useMemo(() => {
    const result = {} as Record<Job, Choice>;
    for (const job of JOBS) {
      const source = draft
        ? draft.roles.find((r) => r.role === job)
        : active.find((r) => r.role === job);
      result[job] =
        source?.connectionId && source.remoteModel
          ? {
              connectionId: source.connectionId,
              remoteModel: source.remoteModel,
            }
          : null;
    }
    return result;
  }, [draft, active]);
  // Changed: there is something to save (suggestions count). Unsaved: the operator edited it.
  const changed =
    JOBS.some((job) => encode(choices[job]) !== encode(saved[job])) ||
    (touched && JOBS.some((job) => !same(choices[job], initial[job])));
  const dirty = touched && changed;
  useEffect(() => onDirty(dirty), [dirty, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);

  if (!data.connections.connections.length)
    return (
      <Section
        id="models"
        title={t("aiServices.section.models")}
        state={props.state}
        unsaved={props.unsaved}
      >
        <p>{t("aiServices.models.needConnection")}</p>
      </Section>
    );
  const kindOf = (connectionId: string) =>
    data.connections.connections.find((c) => c.id === connectionId)?.kind ?? "";
  const labelOf = (connectionId: string) => {
    const c = data.connections.connections.find((x) => x.id === connectionId);
    if (!c) return connectionId;
    const kind =
      c.kind === "google" || c.kind === "anthropic"
        ? t(`aiServices.kind.${c.kind}`)
        : c.label;
    return c.name ? `${kind} · ${c.name}` : kind;
  };
  async function save() {
    setMessage(undefined);
    const problems: FieldError[] = [];
    for (const job of NEEDED_JOBS)
      if (!choices[job])
        problems.push({
          field: `${base}-${job}`,
          message: t("aiServices.models.errNeeded", { job: jobName(t, job) }),
        });
    const media = choices.media?.media;
    if (
      choices.media &&
      media?.kind === "video" &&
      !(
        media.durationSeconds &&
        media.aspectRatio &&
        media.resolution &&
        media.downloadHosts?.length
      )
    )
      problems.push({
        field: `${base}-media-duration`,
        message: t("aiServices.models.errVideo"),
      });
    setErrors(problems);
    if (problems.length) return;
    setSaving(true);
    try {
      const assignments = {} as Record<Job, Assignment>;
      for (const job of JOBS) {
        const choice = choices[job];
        assignments[job] = choice
          ? {
              connectionId: choice.connectionId,
              remoteModel: choice.remoteModel,
              ...(job === "media" && choice.media
                ? { media: choice.media }
                : {}),
            }
          : null;
      }
      const created = await port.draftFromModels(workspaceId, {
        baseRevision: data.setup.revision,
        assignments,
      });
      if (created.waitingForCheck.length) {
        setMessage({
          tone: "info",
          text: t("aiServices.models.savedWaiting", {
            count: created.waitingForCheck.length,
          }),
        });
      } else if (await activate(created))
        setMessage({ tone: "ok", text: t("aiServices.models.saved") });
      setTouched(false);
      await reload();
    } catch (error) {
      const service = serviceName(t, usable[0]?.kind ?? "");
      setMessage({ tone: "error", text: errorText(text, error, service) });
    } finally {
      setSaving(false);
    }
  }
  async function turnOn() {
    if (!draft) return;
    setSaving(true);
    setMessage(undefined);
    try {
      if (await activate(draft))
        setMessage({ tone: "ok", text: t("aiServices.models.saved") });
      await reload();
    } catch (error) {
      setMessage({ tone: "error", text: errorText(text, error) });
    } finally {
      setSaving(false);
    }
  }
  async function discard() {
    setSaving(true);
    try {
      await port.discardDraft(workspaceId);
      setTouched(false);
      setMessage({ tone: "ok", text: t("aiServices.models.discarded") });
      await reload();
    } catch (error) {
      setMessage({ tone: "error", text: errorText(text, error) });
    } finally {
      setSaving(false);
    }
  }
  const jobRow = (job: Job) => {
    const id = `${base}-${job}`;
    const choice = choices[job];
    const error = errors.find((e) => e.field === id)?.message;
    const options = usable.flatMap((connection) => {
      const list = lists[connection.id];
      if (!list || !("models" in list)) return [];
      const role = list.roles.find((r) => r.role === job);
      if (!role?.offered) return [];
      const methods =
        job === "media" ? [role.method, role.videoMethod] : [role.method];
      return [
        {
          connection,
          suggested: role.suggested,
          models: list.models
            .map((m) => ({
              ...m,
              fits: methods.some(
                (method) => method && m.methods.includes(method),
              ),
            }))
            .filter(
              (m) =>
                showAll ||
                (m.fits && !specialtyModel(job, m.remoteModel)) ||
                m.remoteModel === role.suggested ||
                (choice?.connectionId === connection.id &&
                  choice.remoteModel === m.remoteModel),
            ),
        },
      ];
    });
    const loading = usable.some((c) => !lists[c.id]);
    const failures = usable
      .map((c) => ({ c, list: lists[c.id] }))
      .filter(
        (x): x is { c: typeof x.c; list: { error: string } } =>
          !!x.list && "error" in x.list,
      );
    const suggestion = options.find(
      (o) => o.connection.id === choice?.connectionId,
    )?.suggested;
    const chosenModel = options
      .flatMap((o) => o.models)
      .find((m) => choice && m.remoteModel === choice.remoteModel);
    const select = (
      <select
        id={id}
        value={encode(choice)}
        disabled={saving}
        onChange={(event) => {
          setTouched(true);
          const [connectionId, remoteModel] =
            event.target.value.split("\u0000");
          setChoices((current) => ({
            ...current,
            [job]:
              connectionId && remoteModel
                ? {
                    connectionId,
                    remoteModel,
                    ...(job === "media"
                      ? { media: current.media?.media ?? { kind: "image" } }
                      : {}),
                  }
                : null,
          }));
        }}
        {...described(id, true, error)}
      >
        <option value="">
          {NEEDED_JOBS.includes(job)
            ? t("aiServices.models.chooseModel")
            : t("aiServices.models.off")}
        </option>
        {options.map((group) => {
          const items = group.models.map((m) => (
            <option
              key={m.remoteModel}
              value={encode({
                connectionId: group.connection.id,
                remoteModel: m.remoteModel,
              })}
            >
              {m.displayName && m.displayName !== m.remoteModel
                ? `${m.displayName} (${m.remoteModel})`
                : m.remoteModel}
              {m.remoteModel === group.suggested
                ? ` — ${t("aiServices.models.suggested")}`
                : ""}
              {!m.fits ? ` — ${t("aiServices.models.mayNotWork")}` : ""}
            </option>
          ));
          return usable.length > 1 ? (
            <optgroup
              key={group.connection.id}
              label={labelOf(group.connection.id)}
            >
              {items}
            </optgroup>
          ) : (
            items
          );
        })}
        {choice && !chosenModel && (
          <option value={encode(choice)}>{choice.remoteModel}</option>
        )}
      </select>
    );
    const notOffered =
      !loading &&
      !choice &&
      usable.every((c) => {
        const list = lists[c.id];
        return (
          !list ||
          !("roles" in list) ||
          !list.roles.find((r) => r.role === job)?.offered
        );
      });
    if (notOffered)
      return (
        <div className="ai-job" key={job}>
          <div className="ai-job-heading">
            <h3>{jobName(t, job)}</h3>
          </div>
          <p className="ai-muted">
            {t("aiServices.models.notOffered", {
              service: text.list([
                ...new Set(usable.map((c) => serviceName(t, c.kind, c.label))),
              ]),
            })}
          </p>
        </div>
      );
    return (
      <div className="ai-job" key={job}>
        <div className="ai-job-heading">
          <h3>{jobName(t, job)}</h3>
          {NEEDED_JOBS.includes(job) && (
            <span className="ai-tag">{t("aiServices.models.needed")}</span>
          )}
        </div>
        <p className="ai-muted">{t(`aiServices.role.${job}.purpose`)}</p>
        {job === "media" ? (
          <p className="ai-why">{t("aiServices.models.why.media")}</p>
        ) : (
          (suggestion ?? options[0]?.suggested) && (
            <p className="ai-why">
              {t("aiServices.models.suggestedLabel")}{" "}
              <Ltr className="mono">{suggestion ?? options[0]?.suggested}</Ltr>
              {" — "}
              {t(`aiServices.models.why.${job}`)}
            </p>
          )
        )}
        <Field
          id={id}
          label={t("aiServices.models.modelFor", { job: jobName(t, job) })}
          error={error}
          hint={
            choice ? (
              <>
                {kindOf(choice.connectionId) && usable.length > 1
                  ? `${labelOf(choice.connectionId)} · `
                  : ""}
                <Ltr className="mono">{choice.remoteModel}</Ltr>
                {suggestion && suggestion === choice.remoteModel
                  ? ` · ${t("aiServices.models.suggested")}`
                  : ""}
              </>
            ) : loading ? (
              t("aiServices.models.loading")
            ) : undefined
          }
        >
          {select}
        </Field>
        {failures.map(({ c, list }) => (
          <Message tone="warn" key={c.id}>
            {t("aiServices.models.listFailed")}{" "}
            {keyProblemText(
              text,
              list.error,
              serviceName(t, c.kind, c.label),
            ) ?? ""}
          </Message>
        ))}
        {job === "media" && choice && (
          <MediaFields
            base={base}
            value={choice.media ?? { kind: "image" }}
            disabled={saving}
            onChange={(media) => {
              setTouched(true);
              setChoices((current) => ({
                ...current,
                media: current.media ? { ...current.media, media } : null,
              }));
            }}
          />
        )}
      </div>
    );
  };
  return (
    <Section
      id="models"
      title={t("aiServices.section.models")}
      state={props.state}
      unsaved={props.unsaved}
    >
      <p>{t("aiServices.models.intro")}</p>
      {draft && !changed && (
        <Message tone="warn">
          {t("aiServices.models.pending")}
          <span className="ai-actions">
            {!draft.waitingForCheck.length && (
              <button
                type="button"
                className="button primary"
                disabled={saving}
                onClick={() => void turnOn()}
              >
                {t("aiServices.models.turnOn")}
              </button>
            )}
            <button
              type="button"
              className="button secondary"
              disabled={saving}
              onClick={() => void discard()}
            >
              {t("aiServices.models.discard")}
            </button>
          </span>
        </Message>
      )}
      <form
        className="ai-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <ErrorSummary errors={errors} />
        {NEEDED_JOBS.map(jobRow)}
        <details
          className="ai-optional"
          open={OPTIONAL_JOBS.some((job) => !!choices[job])}
        >
          <summary>
            {t("aiServices.models.optional", { count: OPTIONAL_JOBS.length })}:{" "}
            <span className="ai-muted">
              {text.list(OPTIONAL_JOBS.map((job) => jobName(t, job)))}
            </span>
          </summary>
          {OPTIONAL_JOBS.map(jobRow)}
        </details>
        <label className="ai-check">
          <input
            type="checkbox"
            checked={showAll}
            onChange={(event) => setShowAll(event.target.checked)}
          />
          {t("aiServices.models.showAll")}
        </label>
        <p className="ai-muted">{t("aiServices.models.basis")}</p>
        {message && <Message tone={message.tone}>{message.text}</Message>}
        <div className="ai-actions">
          <button
            type="submit"
            className="button primary"
            disabled={saving || (!changed && !draft?.stale)}
          >
            {saving
              ? t("aiServices.models.saving")
              : t("aiServices.models.save")}
          </button>
        </div>
      </form>
    </Section>
  );
}

function MediaFields({
  base,
  value,
  disabled,
  onChange,
}: {
  base: string;
  value: MediaChoice;
  disabled: boolean;
  onChange: (value: MediaChoice) => void;
}) {
  const { t } = useAiText();
  return (
    <div className="ai-media">
      <fieldset className="ai-choice">
        <legend>{t("aiServices.models.mediaKind")}</legend>
        {(["image", "video"] as const).map((kind) => (
          <label key={kind}>
            <input
              type="radio"
              name={`${base}-media-kind`}
              checked={value.kind === kind}
              disabled={disabled}
              onChange={() =>
                onChange(
                  kind === "video"
                    ? {
                        kind,
                        durationSeconds: 8,
                        aspectRatio: "16:9",
                        resolution: "720p",
                        downloadHosts: ["generativelanguage.googleapis.com"],
                      }
                    : { kind },
                )
              }
            />
            {t(
              kind === "image"
                ? "aiServices.models.image"
                : "aiServices.models.video",
            )}
          </label>
        ))}
      </fieldset>
      {value.kind === "video" && (
        <div className="ai-grid">
          <Field
            id={`${base}-media-duration`}
            label={t("aiServices.models.videoDuration")}
          >
            <input
              id={`${base}-media-duration`}
              inputMode="numeric"
              dir="ltr"
              value={value.durationSeconds ?? ""}
              disabled={disabled}
              onChange={(event) =>
                onChange({
                  ...value,
                  durationSeconds: Number(event.target.value) || undefined,
                })
              }
            />
          </Field>
          <Field
            id={`${base}-media-aspect`}
            label={t("aiServices.models.videoAspect")}
          >
            <input
              id={`${base}-media-aspect`}
              dir="ltr"
              value={value.aspectRatio ?? ""}
              disabled={disabled}
              onChange={(event) =>
                onChange({ ...value, aspectRatio: event.target.value })
              }
            />
          </Field>
          <Field
            id={`${base}-media-resolution`}
            label={t("aiServices.models.videoResolution")}
          >
            <input
              id={`${base}-media-resolution`}
              dir="ltr"
              value={value.resolution ?? ""}
              disabled={disabled}
              onChange={(event) =>
                onChange({ ...value, resolution: event.target.value })
              }
            />
          </Field>
          <Field
            id={`${base}-media-hosts`}
            label={t("aiServices.models.videoHosts")}
          >
            <input
              id={`${base}-media-hosts`}
              dir="ltr"
              value={(value.downloadHosts ?? []).join(", ")}
              disabled={disabled}
              onChange={(event) =>
                onChange({
                  ...value,
                  downloadHosts: event.target.value
                    .split(",")
                    .map((h) => h.trim())
                    .filter(Boolean),
                })
              }
            />
          </Field>
          <p className="ai-muted">{t("aiServices.models.videoNote")}</p>
        </div>
      )}
    </div>
  );
}
