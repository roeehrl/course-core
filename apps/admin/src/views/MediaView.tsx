import { useId, useRef, useState } from "react";
import {
  BookMarked,
  CircleSlash,
  Clapperboard,
  Plus,
  ShieldCheck,
} from "lucide-react";
import type { AdminClient, CourseWorkspace } from "../domain/contracts";
import {
  MEDIA_STATES,
  MediaActionError,
  failureText,
  findingText,
  mediaErrorMessage,
  usd,
  type MediaAdminPort,
  type MediaCheck,
  type MediaEstimate,
  type MediaJob,
  type MediaKind,
  type MediaLibrary,
  type MediaReviewInput,
} from "../domain/media";
import {
  ReferenceSelect,
  StoryboardsCard,
  type ShotRequest,
} from "./MediaStoryboards";
import { useRemote } from "../hooks/useAdmin";
import {
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  Field,
  Loading,
  Notice,
} from "../components/ui";
import { randomId } from "../domain/webCrypto";
import { useFormatters, useI18n, useT, type MessageKey } from "../i18n";

const DAY = 86_400_000;
const CANCELLABLE = [
  "requested",
  "admitted",
  "submitted",
  "polling",
  "uncertain",
  "generated",
  "under_review",
  "approved",
];
const stateTone: Partial<Record<MediaJob["state"], "gold" | "green" | "red">> =
  {
    under_review: "gold",
    approved: "green",
    rejected: "red",
    failed: "red",
  };
/** A job state badge; the label comes from `mediaView.state.<state>`. */
function StateBadge({ state }: { state: MediaJob["state"] }) {
  const t = useT();
  return (
    <Badge tone={stateTone[state] ?? "neutral"}>
      {t(`mediaView.state.${state}`)}
    </Badge>
  );
}

/** One retry key per logical command until it succeeds, so a lost response replays. */
function useMediaCommand(onDone: () => void) {
  const keys = useRef(new Map<string, string>());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const [message, setMessage] = useState<string>();
  const [done, setDone] = useState(0);
  async function run(
    fingerprint: string,
    command: (key: string) => Promise<unknown>,
    success: string,
  ) {
    if (pending) return false;
    let key = keys.current.get(fingerprint);
    if (!key) {
      key = "admin-media-" + randomId();
      keys.current.set(fingerprint, key);
    }
    setPending(true);
    setError(undefined);
    setMessage(undefined);
    try {
      await command(key);
      keys.current.delete(fingerprint);
      setMessage(success);
      setDone((n) => n + 1);
      onDone();
      return true;
    } catch (caught) {
      setError(caught);
      return false;
    } finally {
      setPending(false);
    }
  }
  return {
    run,
    pending,
    error,
    message,
    done,
    clear: () => {
      setError(undefined);
      setMessage(undefined);
    },
  };
}
type Command = ReturnType<typeof useMediaCommand>;
/** A refused command, with the automated check's findings when it refused an approval. */
function CommandError({ error }: { error: unknown }) {
  const t = useT();
  return (
    <Notice tone="red">
      {mediaErrorMessage(error, t)}
      {error instanceof MediaActionError && error.findings.length > 0 && (
        <ul className="media-findings">
          {error.findings.map((f, i) => (
            <li key={i}>
              <bdi>{findingText(f, t)}</bdi>
            </li>
          ))}
        </ul>
      )}
    </Notice>
  );
}
/** A job kind label; generated media is paid, exact clips and joined clips are not. */
function KindBadge({ kind }: { kind: MediaKind }) {
  const t = useT();
  return <Badge tone="blue">{t(`mediaView.kind.${kind}`)}</Badge>;
}

export function MediaView({
  data,
  client,
}: {
  data: CourseWorkspace;
  client: AdminClient;
}) {
  const t = useT();
  const published = data.releases.filter((r) => r.state === "published");
  const [releaseId, setReleaseId] = useState(
    (published.find((r) => r.availableForNewLearners) ?? published[0])?.id,
  );
  if (!client.media)
    return (
      <Card title={t("mediaView.title")}>
        <EmptyState title={t("mediaView.unavailable.title")}>
          {t("mediaView.unavailable.body")}
        </EmptyState>
      </Card>
    );
  if (!releaseId)
    return (
      <Card title={t("mediaView.title")}>
        <EmptyState title={t("mediaView.noRelease.title")}>
          {t("mediaView.noRelease.body")}
        </EmptyState>
      </Card>
    );
  return (
    <div className="page-stack">
      <Notice tone="blue" title={t("mediaView.reviewed.title")}>
        {t("mediaView.reviewed.body")}
      </Notice>
      {published.length > 1 && (
        <div className="field">
          <label htmlFor="media-release">{t("mediaView.release.label")}</label>
          <select
            id="media-release"
            value={releaseId}
            onChange={(e) => setReleaseId(e.target.value)}
          >
            {published.map((r) => (
              <option key={r.id} value={r.id}>
                {t(
                  r.availableForNewLearners
                    ? "mediaView.release.optionNew"
                    : "mediaView.release.option",
                  { version: r.version },
                )}
              </option>
            ))}
          </select>
        </div>
      )}
      <ReleaseMedia key={releaseId} port={client.media} releaseId={releaseId} />
    </div>
  );
}

function ReleaseMedia({
  port,
  releaseId,
}: {
  port: MediaAdminPort;
  releaseId: string;
}) {
  const t = useT();
  const i18n = useI18n();
  const { when } = useFormatters();
  const library = useRemote(
    (signal) => port.library(releaseId, signal),
    [port, releaseId],
  );
  const command = useMediaCommand(() => library.reload());
  const [requesting, setRequesting] = useState<ShotRequest | true | false>(
    false,
  );
  const [open, setOpen] = useState<string>();
  if (library.loading && !library.data)
    return <Loading label={t("mediaView.loading")} />;
  if (library.error || !library.data)
    return <Notice tone="red">{mediaErrorMessage(library.error, t)}</Notice>;
  const lib = library.data;
  const episodeTitle = (id: string) =>
    lib.episodes.find((e) => e.id === id)?.title ?? id;
  return (
    <>
      <div aria-live="polite">
        {command.message && <Notice tone="green">{command.message}</Notice>}
        {command.error !== undefined && <CommandError error={command.error} />}
      </div>
      {!lib.liveGenerationVerified && (
        <Notice tone="gold" title={t("mediaView.unverified.title")}>
          {t("mediaView.unverified.body")}
        </Notice>
      )}
      <ProviderCard library={lib} />
      <ClipCard library={lib} />
      <Card
        eyebrow={t("mediaView.title")}
        title={t("mediaView.jobs.title")}
        actions={
          <Button
            kind="primary"
            disabled={
              !lib.permissions.request ||
              (!lib.provider && !clipsReady(lib)) ||
              command.pending
            }
            onClick={() => setRequesting(true)}
          >
            <Plus size={16} aria-hidden="true" /> {t("mediaView.jobs.request")}
          </Button>
        }
      >
        {!lib.permissions.request && (
          <p className="media-hint">{t("mediaView.jobs.needsPermission")}</p>
        )}
        {lib.jobs.length === 0 ? (
          <p className="research-empty">{t("mediaView.jobs.empty")}</p>
        ) : (
          <ul className="media-jobs" aria-label={t("mediaView.jobs.title")}>
            {lib.jobs.map((job) => (
              <li key={job.id} className="media-job">
                <div className="media-job-head">
                  <strong dir="auto">{job.title}</strong>
                  <span className="tag-row">
                    <KindBadge kind={job.kind} />
                    <StateBadge state={job.state} />
                  </span>
                </div>
                <dl className="media-facts">
                  <div>
                    <dt>{t("mediaView.fact.learner")}</dt>
                    <dd dir="auto">
                      {job.learnerName ?? t("mediaView.fact.unknownLearner")}
                    </dd>
                  </div>
                  <div>
                    <dt>{t("mediaView.fact.episode")}</dt>
                    <dd dir="auto">{episodeTitle(job.episodeId)}</dd>
                  </div>
                  <div>
                    <dt>{t("mediaView.fact.estimate")}</dt>
                    <dd>{usd(job.estimateMicroUsd, i18n)}</dd>
                  </div>
                  <div>
                    <dt>{t("mediaView.fact.charged")}</dt>
                    <dd>{usd(job.chargedMicroUsd, i18n)}</dd>
                  </div>
                  <div className="media-wide">
                    <dt>{t("mediaView.fact.operation")}</dt>
                    <dd
                      className="mono"
                      dir={job.providerOperationId ? "ltr" : undefined}
                    >
                      {job.providerOperationId ??
                        t("mediaView.fact.notSubmitted")}
                    </dd>
                  </div>
                </dl>
                {job.failureCode && (
                  <p className="media-failure">
                    {failureText(job.failureCode, t)}
                  </p>
                )}
                <div className="tag-row">
                  {job.learnerVisible && (
                    <Badge tone="green">{t("mediaView.visible")}</Badge>
                  )}
                  <small className="media-updated">
                    {t("mediaView.updated", { when: when(job.updatedAt) })}
                  </small>
                  <Button
                    kind="quiet"
                    onClick={() => setOpen(job.id)}
                    aria-label={t("mediaView.openLabel", { title: job.title })}
                  >
                    {t("mediaView.open")}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <StoryboardsCard
        port={port}
        library={lib}
        releaseId={releaseId}
        run={command.run}
        pending={command.pending}
        refreshKey={command.done}
        onMakeShot={(request) => setRequesting(request)}
      />
      {requesting && (
        <RequestDialog
          port={port}
          library={lib}
          pending={command.pending}
          shot={requesting === true ? undefined : requesting}
          onClose={() => setRequesting(false)}
          onSubmit={async (enrollmentId, request) => {
            const ok = await command.run(
              "request:" + enrollmentId + JSON.stringify(request),
              (key) =>
                request.mode === "image"
                  ? port.requestImage(enrollmentId, request.input, key)
                  : request.mode === "clip"
                    ? port.requestClip(enrollmentId, request.input, key)
                    : port.request(enrollmentId, request.input, key),
              request.mode === "clip"
                ? t("mediaView.requestedClip")
                : t("mediaView.requested"),
            );
            if (ok) setRequesting(false);
          }}
        />
      )}
      {open && (
        <JobDialog
          key={open}
          port={port}
          jobId={open}
          library={lib}
          command={command}
          episodeTitle={episodeTitle}
          onClose={() => {
            setOpen(undefined);
            command.clear();
          }}
        />
      )}
    </>
  );
}

const AVAILABILITY = new Set([
  "ready",
  "configuration_missing",
  "capability_missing",
]);
const clipsReady = (library: MediaLibrary) =>
  library.clipRendering === "ready" && library.visuals.length > 0;
const BILLING = new Set(["per_output_second", "per_image", "per_request"]);
function ProviderCard({ library }: { library: MediaLibrary }) {
  const t = useT();
  const i18n = useI18n();
  const p = library.provider;
  if (!p)
    return (
      <Card
        eyebrow={t("mediaView.provider.eyebrow")}
        title={t("mediaView.provider.none.title")}
      >
        <p className="research-empty">{t("mediaView.provider.none.body")}</p>
      </Card>
    );
  const video = p.kind === "video";
  const hours = p.capabilities?.retention.outputHours ?? null;
  return (
    <Card
      eyebrow={t("mediaView.provider.eyebrow")}
      title={
        video
          ? t("mediaView.provider.title")
          : t("mediaView.provider.titleImage")
      }
    >
      <dl className="media-facts">
        <div>
          <dt>{t("mediaView.provider.model")}</dt>
          <dd className="mono" dir="ltr">
            {p.modelId}
          </dd>
        </div>
        <div>
          <dt>
            {video
              ? t("mediaView.provider.clip")
              : t("mediaView.provider.image")}
          </dt>
          <dd>
            {video
              ? t("mediaView.provider.clipSettings", {
                  seconds: Number(p.settings.durationSeconds ?? 0),
                  aspect: String(p.settings.aspectRatio ?? ""),
                  resolution: String(p.settings.resolution ?? ""),
                })
              : t("mediaView.provider.imageSettings", {
                  aspect: String(
                    p.settings.aspectRatio ??
                      t("mediaView.provider.defaultSetting"),
                  ),
                })}
          </dd>
        </div>
        <div>
          <dt>{t("mediaView.provider.status")}</dt>
          <dd>
            <Badge tone={p.availability === "ready" ? "neutral" : "red"}>
              {AVAILABILITY.has(p.availability)
                ? t(`mediaView.availability.${p.availability}` as MessageKey)
                : p.availability.replaceAll("_", " ")}
            </Badge>
          </dd>
        </div>
        <div>
          <dt>
            {video
              ? t("mediaView.provider.estimate")
              : t("mediaView.provider.estimateImage")}
          </dt>
          <dd>
            {p.estimateMicroUsd === null
              ? t("mediaView.provider.noRateCard")
              : video && p.pricing
                ? t("mediaView.provider.estimateValue", {
                    estimate: usd(p.estimateMicroUsd, i18n),
                    rate: usd(p.pricing.microUsdPerOutputSecond, i18n),
                  })
                : usd(p.estimateMicroUsd, i18n)}
          </dd>
        </div>
        <div>
          <dt>{t("mediaView.provider.reserved")}</dt>
          <dd>
            {t("mediaView.provider.reservedValue", {
              amount: usd(p.perJobAllowanceMicroUsd, i18n),
            })}
          </dd>
        </div>
        {p.capabilities && (
          <div>
            <dt>{t("mediaView.provider.billing")}</dt>
            <dd>
              {BILLING.has(p.capabilities.billing)
                ? t(`mediaView.billing.${p.capabilities.billing}` as MessageKey)
                : p.capabilities.billing.replaceAll("_", " ")}
            </dd>
          </div>
        )}
        {p.capabilities && (
          <div className="media-wide">
            <dt>{t("mediaView.provider.retention")}</dt>
            <dd>
              {hours === null
                ? t("mediaView.provider.retentionNone")
                : t("mediaView.provider.retentionHours", { hours })}
            </dd>
          </div>
        )}
        {p.pricing && (
          <div className="media-wide">
            <dt>{t("mediaView.provider.rateCard")}</dt>
            <dd>
              {t("mediaView.provider.rateCardValue", {
                source: p.pricing.source,
                reviewed: p.pricing.reviewedAt,
              })}
            </dd>
          </div>
        )}
      </dl>
    </Card>
  );
}
/** Exact clips are rendered on this server from verified course visuals: no provider, no cost. */
function ClipCard({ library }: { library: MediaLibrary }) {
  const t = useT();
  return (
    <Card
      eyebrow={t("mediaView.clips.eyebrow")}
      title={t("mediaView.clips.title")}
    >
      <p>
        {library.clipRendering === "ready"
          ? library.visuals.length > 0
            ? t("mediaView.clips.ready", { count: library.visuals.length })
            : t("mediaView.clips.noVisuals")
          : t("mediaView.clips.toolchainMissing")}
      </p>
    </Card>
  );
}

type Mode = "video" | "image" | "clip";
type RequestPayload =
  | { mode: "video"; input: Parameters<MediaAdminPort["request"]>[1] }
  | { mode: "image"; input: Parameters<MediaAdminPort["requestImage"]>[1] }
  | { mode: "clip"; input: Parameters<MediaAdminPort["requestClip"]>[1] };
function RequestDialog({
  port,
  library,
  pending,
  shot,
  onClose,
  onSubmit,
}: {
  port: MediaAdminPort;
  library: MediaLibrary;
  pending: boolean;
  shot?: ShotRequest;
  onClose: () => void;
  onSubmit: (enrollmentId: string, request: RequestPayload) => void;
}) {
  const t = useT();
  const i18n = useI18n();
  const id = useId();
  const board = shot?.storyboard;
  const modes: Mode[] = [
    ...(library.provider ? [library.provider.kind] : []),
    ...(clipsReady(library) ? (["clip"] as const) : []),
  ];
  const [mode, setMode] = useState<Mode>(
    shot
      ? shot.shot.kind === "scene"
        ? "clip"
        : (library.provider?.kind ?? "video")
      : (modes[0] ?? "video"),
  );
  const [enrollmentId, setEnrollmentId] = useState(
    board?.enrollmentId ?? library.enrollments[0]?.id ?? "",
  );
  const [episodeId, setEpisodeId] = useState(
    board?.episodeId ?? library.episodes[0]?.id ?? "",
  );
  const [title, setTitle] = useState(board ? board.title.slice(0, 180) : "");
  const [objective, setObjective] = useState(board?.objective ?? "");
  const [script, setScript] = useState(
    shot
      ? [shot.shot.description, shot.shot.narration].filter(Boolean).join("\n")
      : "",
  );
  const [reference, setReference] = useState(board?.referenceVisualId ?? "");
  const [visualId, setVisualId] = useState(
    shot?.shot.visualId ?? library.visuals[0]?.id ?? "",
  );
  const [from, setFrom] = useState((shot?.shot.fromMs ?? 0) / 1000);
  const [to, setTo] = useState(
    (shot?.shot.toMs ??
      Math.min(library.visuals[0]?.durationMs ?? 1000, 4000)) / 1000,
  );
  const [format, setFormat] = useState<"mp4" | "webm">("mp4");
  const [estimate, setEstimate] = useState<{
    value?: MediaEstimate;
    error?: unknown;
    loading?: boolean;
  }>({});
  const visual = library.visuals.find((v) => v.id === visualId);
  const rangeValid =
    mode !== "clip" ||
    (visual !== undefined &&
      from >= 0 &&
      to > from &&
      to * 1000 <= visual.durationMs);
  const valid =
    enrollmentId &&
    episodeId &&
    title.trim().length >= 3 &&
    objective.trim().length >= 10 &&
    script.trim().length >= 20 &&
    rangeValid;
  const link = shot
    ? { storyboardId: shot.storyboard.id, shotId: shot.shot.id }
    : {};
  const common = {
    episodeId,
    title: title.trim(),
    objective: objective.trim(),
    ...link,
  };
  return (
    <Dialog
      title={t("mediaView.request.title")}
      onClose={onClose}
      pending={pending}
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid) return;
          const ref = reference ? { referenceVisualId: reference } : {};
          onSubmit(
            enrollmentId,
            mode === "clip"
              ? {
                  mode,
                  input: {
                    ...common,
                    script: script.trim(),
                    visualId,
                    fromMs: Math.round(from * 1000),
                    toMs: Math.round(to * 1000),
                    format,
                  },
                }
              : mode === "image"
                ? { mode, input: { ...common, ...ref, prompt: script.trim() } }
                : { mode, input: { ...common, ...ref, script: script.trim() } },
          );
        }}
      >
        <p>
          {mode === "clip"
            ? t("mediaView.request.introClip")
            : t("mediaView.request.intro")}
        </p>
        {shot && (
          <Notice tone="blue">
            {t("mediaView.request.fromShot", { title: shot.storyboard.title })}
          </Notice>
        )}
        {!shot && modes.length > 1 && (
          <fieldset>
            <legend>{t("mediaView.request.what")}</legend>
            {modes.map((value) => (
              <label key={value} className="check-label">
                <input
                  type="radio"
                  name={id + "-mode"}
                  checked={mode === value}
                  onChange={() => {
                    setMode(value);
                    setEstimate({});
                  }}
                />
                {t(`mediaView.request.mode.${value}`)}
              </label>
            ))}
          </fieldset>
        )}
        <Field label={t("mediaView.fact.learner")} htmlFor={id + "-learner"}>
          <select
            id={id + "-learner"}
            value={enrollmentId}
            disabled={Boolean(board)}
            onChange={(e) => {
              setEnrollmentId(e.target.value);
              setEstimate({});
            }}
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
            disabled={Boolean(board)}
            onChange={(e) => {
              setEpisodeId(e.target.value);
              setEstimate({});
            }}
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
            dir="auto"
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
            dir="auto"
            value={objective}
            maxLength={2000}
            onChange={(e) => setObjective(e.target.value)}
          />
        </Field>
        {mode === "clip" && (
          <>
            <Field label={t("mediaView.clip.visual")} htmlFor={id + "-visual"}>
              <select
                id={id + "-visual"}
                value={visualId}
                disabled={Boolean(shot)}
                onChange={(e) => setVisualId(e.target.value)}
              >
                {library.visuals.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.title}
                  </option>
                ))}
              </select>
            </Field>
            <div className="media-range">
              <Field label={t("mediaView.clip.from")} htmlFor={id + "-from"}>
                <input
                  id={id + "-from"}
                  type="number"
                  min={0}
                  step={0.1}
                  value={from}
                  onChange={(e) => setFrom(Number(e.target.value))}
                />
              </Field>
              <Field
                label={t("mediaView.clip.to")}
                htmlFor={id + "-to"}
                hint={
                  visual
                    ? t("mediaView.clip.length", {
                        seconds: visual.durationMs / 1000,
                      })
                    : undefined
                }
              >
                <input
                  id={id + "-to"}
                  type="number"
                  min={0.1}
                  step={0.1}
                  value={to}
                  onChange={(e) => setTo(Number(e.target.value))}
                />
              </Field>
              <Field
                label={t("mediaView.clip.format")}
                htmlFor={id + "-format"}
              >
                <select
                  id={id + "-format"}
                  value={format}
                  onChange={(e) => setFormat(e.target.value as "mp4" | "webm")}
                >
                  <option value="mp4">{t("mediaView.clip.formatMp4")}</option>
                  <option value="webm">{t("mediaView.clip.formatWebm")}</option>
                </select>
              </Field>
            </div>
            {!rangeValid && (
              <p className="media-failure">
                {t("mediaView.clip.rangeInvalid")}
              </p>
            )}
          </>
        )}
        <Field
          label={
            mode === "image"
              ? t("mediaView.request.prompt")
              : mode === "clip"
                ? t("mediaView.request.clipShows")
                : t("mediaView.request.script")
          }
          htmlFor={id + "-script"}
          hint={
            mode === "image"
              ? t("mediaView.request.promptHint")
              : mode === "clip"
                ? t("mediaView.request.clipShowsHint")
                : t("mediaView.request.scriptHint")
          }
        >
          <textarea
            id={id + "-script"}
            dir="auto"
            value={script}
            maxLength={mode === "image" ? 4000 : 8000}
            onChange={(e) => setScript(e.target.value)}
          />
        </Field>
        {mode !== "clip" && (
          <ReferenceSelect
            library={library}
            value={reference}
            onChange={setReference}
          />
        )}
        {mode === "clip" ? (
          <p className="media-hint">{t("mediaView.request.clipFree")}</p>
        ) : (
          <div className="media-estimate" aria-live="polite">
            <Button
              type="button"
              disabled={!enrollmentId || !episodeId || estimate.loading}
              onClick={() => {
                setEstimate({ loading: true });
                port.estimate(enrollmentId, episodeId).then(
                  (value) => setEstimate({ value }),
                  (error) => setEstimate({ error }),
                );
              }}
            >
              {t("mediaView.request.checkCost")}
            </Button>
            {estimate.value && (
              <p>
                {t("mediaView.request.estimate", {
                  estimate: usd(estimate.value.estimateMicroUsd, i18n),
                  reserve: usd(estimate.value.reserveMicroUsd, i18n),
                  available: usd(estimate.value.availableMicroUsd, i18n),
                })}{" "}
                <strong>
                  {estimate.value.admissible
                    ? t("mediaView.request.admissible")
                    : t("mediaView.request.refused", {
                        reason:
                          failureText(estimate.value.reason, t) ??
                          String(estimate.value.reason),
                      })}
                </strong>
              </p>
            )}
            {estimate.error !== undefined && (
              <p className="media-failure">
                {mediaErrorMessage(estimate.error, t)}
              </p>
            )}
          </div>
        )}
        <div className="tag-row">
          <Button kind="primary" type="submit" disabled={pending || !valid}>
            <Clapperboard size={16} aria-hidden="true" />{" "}
            {mode === "clip"
              ? t("mediaView.request.submitClip")
              : mode === "image"
                ? t("mediaView.request.submitImage")
                : t("mediaView.request.submit")}
          </Button>
          <Button type="button" onClick={onClose} disabled={pending}>
            {t("mediaView.cancel")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function JobDialog({
  port,
  jobId,
  library,
  command,
  episodeTitle,
  onClose,
}: {
  port: MediaAdminPort;
  jobId: string;
  library: MediaLibrary;
  command: Command;
  episodeTitle: (id: string) => string;
  onClose: () => void;
}) {
  const t = useT();
  const i18n = useI18n();
  const { when } = useFormatters();
  const detail = useRemote(
    (signal) => port.detail(jobId, signal),
    [port, jobId],
  );
  const [revoking, setRevoking] = useState(false);
  const job = detail.data;
  const after = (ok: boolean) => ok && detail.reload();
  return (
    <Dialog
      title={job ? job.title : t("mediaView.job.title")}
      titleDir={job ? "auto" : undefined}
      onClose={onClose}
      pending={command.pending}
    >
      {detail.loading && !job ? (
        <Loading label={t("mediaView.job.loading")} />
      ) : detail.error || !job ? (
        <Notice tone="red">{mediaErrorMessage(detail.error, t)}</Notice>
      ) : (
        <div className="stack">
          <div aria-live="polite">
            {command.message && <Notice tone="green">{command.message}</Notice>}
            {command.error !== undefined && (
              <CommandError error={command.error} />
            )}
          </div>
          <div className="tag-row">
            <KindBadge kind={job.kind} />
            <StateBadge state={job.state} />
            {job.learnerVisible ? (
              <Badge tone="green">{t("mediaView.visible")}</Badge>
            ) : (
              <Badge>{t("mediaView.hidden")}</Badge>
            )}
          </div>
          {job.failureCode && (
            <p className="media-failure">{failureText(job.failureCode, t)}</p>
          )}
          {job.remoteMayContinue && (
            <Notice tone="gold">{t("mediaView.job.remoteMayContinue")}</Notice>
          )}
          <dl className="media-facts">
            <div>
              <dt>{t("mediaView.fact.learner")}</dt>
              <dd dir="auto">
                {job.learnerName ?? t("mediaView.fact.unknownLearner")}
              </dd>
            </div>
            <div>
              <dt>{t("mediaView.fact.episode")}</dt>
              <dd dir="auto">{episodeTitle(job.episodeId)}</dd>
            </div>
            <div>
              <dt>{t("mediaView.fact.estimate")}</dt>
              <dd>{usd(job.estimateMicroUsd, i18n)}</dd>
            </div>
            <div>
              <dt>{t("mediaView.fact.charged")}</dt>
              <dd>{usd(job.chargedMicroUsd, i18n)}</dd>
            </div>
            <div className="media-wide">
              <dt>{t("mediaView.fact.operation")}</dt>
              <dd
                className="mono"
                dir={job.providerOperationId ? "ltr" : undefined}
              >
                {job.providerOperationId ?? t("mediaView.fact.notSubmitted")}
              </dd>
            </div>
            <div>
              <dt>{t("mediaView.job.attempts")}</dt>
              <dd>
                {t("mediaView.job.attemptsValue", {
                  submits: job.submitAttempts,
                  polls: job.pollAttempts,
                })}
              </dd>
            </div>
            <div>
              <dt>{t("mediaView.job.deadline")}</dt>
              <dd>{when(job.deadlineAt)}</dd>
            </div>
          </dl>
          <details className="media-script">
            <summary>{t("mediaView.job.script")}</summary>
            <p dir="auto">{job.objective}</p>
            <p className="research-text" dir="auto">
              {job.script}
            </p>
          </details>
          {job.kind === "scene_clip" && job.source && (
            <p className="media-hint">
              {t("mediaView.job.sceneSource", {
                visual:
                  library.visuals.find((v) => v.id === job.source!.visualId)
                    ?.title ?? String(job.source.visualId),
                from: Number(job.source.fromMs) / 1000,
                to: Number(job.source.toMs) / 1000,
              })}
            </p>
          )}
          {job.referenceVisualId && job.kind !== "scene_clip" && (
            <p className="media-hint">
              {t("mediaView.job.reference", {
                visual:
                  library.visuals.find((v) => v.id === job.referenceVisualId)
                    ?.title ?? job.referenceVisualId,
              })}
            </p>
          )}
          {job.asset && (
            <div className="media-preview">
              {job.asset.mimeType.startsWith("image/") ? (
                <img
                  src={port.assetUrl(job.id)}
                  alt={
                    job.review?.visualDescription ??
                    t("mediaView.job.imageLabel", { title: job.title })
                  }
                />
              ) : (
                <video
                  controls
                  preload="metadata"
                  playsInline
                  aria-label={t("mediaView.job.videoLabel", {
                    title: job.title,
                  })}
                  src={port.assetUrl(job.id)}
                />
              )}
              <small className="mono" dir="ltr">
                {t("mediaView.job.asset", {
                  sha: job.asset.sha256,
                  size: i18n.number(job.asset.byteLength / 1024, {
                    minimumFractionDigits: 1,
                    maximumFractionDigits: 1,
                  }),
                  mime: job.asset.mimeType,
                })}
              </small>
            </div>
          )}
          {job.review && (
            <div className="media-review-summary">
              <strong>
                {t("mediaView.job.review", {
                  decision: job.review.decision,
                })}
              </strong>
              <p dir="auto">{job.review.rationale}</p>
              {job.review.transcript && (
                <p>
                  <span className="media-label">
                    {t("mediaView.job.transcript")}{" "}
                  </span>
                  <bdi>{job.review.transcript}</bdi>
                </p>
              )}
            </div>
          )}
          {job.state === "under_review" &&
            job.asset &&
            library.permissions.review && (
              <ReviewForm
                sha={job.asset.sha256}
                image={job.kind === "generated_image"}
                onCheck={(input, key) => port.check(job.id, input, key)}
                pending={command.pending}
                onSubmit={async (input) =>
                  after(
                    await command.run(
                      "review:" + job.id + JSON.stringify(input),
                      (key) => port.review(job.id, input, key),
                      input.decision === "approved"
                        ? t("mediaView.review.approved")
                        : t("mediaView.review.rejected"),
                    ),
                  )
                }
              />
            )}
          {job.state === "approved" && library.permissions.attach && (
            <AttachForm
              pending={command.pending}
              onSubmit={async (expiresAt) =>
                after(
                  await command.run(
                    "attach:" + job.id,
                    (key) => port.attach(job.id, expiresAt, key),
                    t("mediaView.attach.done"),
                  ),
                )
              }
            />
          )}
          <Events job={job} />
          <div className="tag-row">
            {job.attachment?.state === "active" &&
              library.permissions.review && (
                <Button
                  kind="danger"
                  disabled={command.pending}
                  onClick={() => setRevoking(true)}
                >
                  <CircleSlash size={16} aria-hidden="true" />{" "}
                  {t("mediaView.revoke.button")}
                </Button>
              )}
            {CANCELLABLE.includes(job.state) && library.permissions.request && (
              <Button
                kind="danger"
                disabled={command.pending}
                onClick={async () =>
                  after(
                    await command.run(
                      "cancel:" + job.id,
                      (key) => port.cancel(job.id, key),
                      t("mediaView.job.cancelled"),
                    ),
                  )
                }
              >
                {t("mediaView.job.cancel")}
              </Button>
            )}
            <Button onClick={onClose} disabled={command.pending}>
              {t("mediaView.close")}
            </Button>
          </div>
          {revoking && job.attachment && (
            <RevokeForm
              pending={command.pending}
              onCancel={() => setRevoking(false)}
              onSubmit={async (reason) => {
                const ok = await command.run(
                  "revoke:" + job.attachment!.id,
                  (key) => port.revoke(job.attachment!.id, reason, key),
                  t("mediaView.revoke.done"),
                );
                if (ok) setRevoking(false);
                after(ok);
              }}
            />
          )}
        </div>
      )}
    </Dialog>
  );
}
function Events({ job }: { job: MediaJob }) {
  const t = useT();
  const { when } = useFormatters();
  if (!job.events?.length) return null;
  return (
    <details className="media-script">
      <summary>{t("mediaView.history", { count: job.events.length })}</summary>
      <ol className="media-events">
        {job.events.map((e, i) => (
          <li key={i}>
            <span>
              {(MEDIA_STATES as readonly string[]).includes(e.to)
                ? t(`mediaView.state.${e.to as MediaJob["state"]}`)
                : e.to}
            </span>
            {e.code && (
              <small className="mono" dir="ltr">
                {" "}
                {e.code}
              </small>
            )}
            <small> · {when(e.at)}</small>
          </li>
        ))}
      </ol>
    </details>
  );
}
const CHECKS = [
  "factualAccuracy",
  "labelsAndEquations",
  "captionsMatchNarration",
  "noMisleadingMotion",
] as const;
function ReviewForm({
  sha,
  image,
  pending,
  onCheck,
  onSubmit,
}: {
  sha: string;
  image: boolean;
  pending: boolean;
  onCheck: (
    input: Parameters<MediaAdminPort["check"]>[1],
    idempotencyKey: string,
  ) => Promise<MediaCheck>;
  onSubmit: (input: MediaReviewInput) => void;
}) {
  const t = useT();
  const id = useId();
  const [decision, setDecision] = useState<"approved" | "rejected">("approved");
  const [captions, setCaptions] = useState(
    "WEBVTT\n\n00:00.000 --> 00:04.000\n",
  );
  const [transcript, setTranscript] = useState("");
  const [description, setDescription] = useState("");
  // The captions are usually in the language the reviewer works in; they can say otherwise.
  const { locale } = useI18n();
  const [captionsLanguage, setCaptionsLanguage] = useState(
    locale === "he" ? "he" : "en",
  );
  const [rationale, setRationale] = useState("");
  const [checks, setChecks] = useState({
    factualAccuracy: false,
    labelsAndEquations: false,
    captionsMatchNarration: false,
    noMisleadingMotion: false,
  });
  const approving = decision === "approved";
  const textReady = image
    ? description.trim().length >= 20
    : transcript.trim().length >= 20 &&
      description.trim().length >= 20 &&
      /-->/.test(captions);
  const ready =
    rationale.trim().length >= 20 &&
    (!approving || (Object.values(checks).every(Boolean) && textReady));
  const text = image
    ? { visualDescription: description.trim() }
    : {
        transcript: transcript.trim(),
        visualDescription: description.trim(),
        captionsVtt: captions,
      };
  return (
    <form
      className="stack media-review"
      aria-label={t(
        image ? "mediaView.review.labelImage" : "mediaView.review.label",
      )}
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready) return;
        onSubmit({
          decision,
          assetSha256: sha,
          findings: checks,
          rationale: rationale.trim(),
          // The caption language is recorded with the review; the check compares text only.
          ...(approving
            ? { ...text, ...(image ? {} : { captionsLanguage }) }
            : {}),
        });
      }}
    >
      <fieldset>
        <legend>{t("mediaView.review.decision")}</legend>
        <div className="tag-row">
          {(["approved", "rejected"] as const).map((value) => (
            <label key={value} className="check-label">
              <input
                type="radio"
                name={id + "-decision"}
                checked={decision === value}
                onChange={() => setDecision(value)}
              />
              {value === "approved"
                ? t("mediaView.review.approve")
                : t("mediaView.review.reject")}
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend>{t("mediaView.review.checks")}</legend>
        {CHECKS.map((key) => (
          <label className="check-label" key={key}>
            <input
              type="checkbox"
              checked={checks[key]}
              onChange={(e) =>
                setChecks({ ...checks, [key]: e.target.checked })
              }
            />
            {image
              ? t(`mediaView.checkImage.${key}`)
              : t(`mediaView.check.${key}`)}
          </label>
        ))}
      </fieldset>
      {approving && (
        <>
          {!image && (
            <>
              <Field
                label={t("mediaView.review.captions")}
                htmlFor={id + "-captions"}
                hint={t("mediaView.review.captionsHint")}
              >
                <textarea
                  id={id + "-captions"}
                  dir="ltr"
                  className="mono"
                  value={captions}
                  onChange={(e) => setCaptions(e.target.value)}
                />
              </Field>
              <Field
                label={t("mediaView.review.captionsLanguage")}
                htmlFor={id + "-captions-language"}
                hint={t("mediaView.review.captionsLanguageHint")}
              >
                <select
                  id={id + "-captions-language"}
                  value={captionsLanguage}
                  onChange={(e) => setCaptionsLanguage(e.target.value)}
                >
                  <option value="en">
                    {t("mediaView.review.language.en")}
                  </option>
                  <option value="he">
                    {t("mediaView.review.language.he")}
                  </option>
                </select>
              </Field>
              <Field
                label={t("mediaView.review.transcriptLabel")}
                htmlFor={id + "-transcript"}
                hint={t("mediaView.review.transcriptHint")}
              >
                <textarea
                  id={id + "-transcript"}
                  dir="auto"
                  value={transcript}
                  onChange={(e) => setTranscript(e.target.value)}
                />
              </Field>
            </>
          )}
          <Field
            label={
              image
                ? t("mediaView.review.altText")
                : t("mediaView.review.description")
            }
            htmlFor={id + "-description"}
            hint={
              image
                ? t("mediaView.review.altTextHint")
                : t("mediaView.review.descriptionHint")
            }
          >
            <textarea
              id={id + "-description"}
              dir="auto"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
          <CheckPanel ready={textReady} input={text} onCheck={onCheck} />
        </>
      )}
      <Field
        label={t("mediaView.review.rationale")}
        htmlFor={id + "-rationale"}
      >
        <textarea
          id={id + "-rationale"}
          dir="auto"
          value={rationale}
          onChange={(e) => setRationale(e.target.value)}
        />
      </Field>
      <Button kind="primary" type="submit" disabled={pending || !ready}>
        <ShieldCheck size={16} aria-hidden="true" />{" "}
        {t("mediaView.review.submit")}
      </Button>
    </form>
  );
}
/** Test before saving: compares the text above with the script, storyboard shot and reference.
 * The rules check is free; the AI reviewer's check is paid and optional. Approval runs the
 * rules check again and refuses a contradiction either way. */
function CheckPanel({
  ready,
  input,
  onCheck,
}: {
  ready: boolean;
  input: {
    transcript?: string;
    visualDescription: string;
    captionsVtt?: string;
  };
  onCheck: (
    input: Parameters<MediaAdminPort["check"]>[1],
    idempotencyKey: string,
  ) => Promise<MediaCheck>;
}) {
  const t = useT();
  const keys = useRef(new Map<string, string>());
  const [useModel, setUseModel] = useState(false);
  const [state, setState] = useState<{
    result?: MediaCheck;
    error?: unknown;
    loading?: boolean;
  }>({});
  const run = async () => {
    const payload = { ...input, useModel };
    const fingerprint = JSON.stringify(payload);
    let key = keys.current.get(fingerprint);
    if (!key) {
      key = "admin-media-check-" + randomId();
      keys.current.set(fingerprint, key);
    }
    setState({ loading: true });
    try {
      setState({ result: await onCheck(payload, key) });
      keys.current.delete(fingerprint);
    } catch (error) {
      setState({ error });
    }
  };
  const verdict = (v: MediaCheck["rules"]) => (
    <div>
      <strong>
        {t(`mediaView.checkPanel.verifier.${v.verifier}`)}:{" "}
        {t(`mediaView.checkPanel.verdict.${v.verdict}`)}
      </strong>
      {v.findings.length > 0 && (
        <ul className="media-findings">
          {v.findings.map((f, i) => (
            <li key={i}>
              <bdi>{findingText(f, t)}</bdi>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
  return (
    <div className="media-estimate" aria-live="polite">
      <p className="media-hint">{t("mediaView.checkPanel.intro")}</p>
      <label className="check-label">
        <input
          type="checkbox"
          checked={useModel}
          onChange={(e) => setUseModel(e.target.checked)}
        />
        {t("mediaView.checkPanel.useModel")}
      </label>
      <Button type="button" disabled={!ready || state.loading} onClick={run}>
        {t("mediaView.checkPanel.run")}
      </Button>
      {state.result && (
        <div className="stack">
          {verdict(state.result.rules)}
          {state.result.model && verdict(state.result.model)}
          {state.result.rules.verdict === "contradicted" ||
          state.result.model?.verdict === "contradicted" ? (
            <Notice tone="red">{t("mediaView.checkPanel.contradicted")}</Notice>
          ) : (
            <Notice tone="green">{t("mediaView.checkPanel.consistent")}</Notice>
          )}
        </div>
      )}
      {state.error !== undefined && (
        <p className="media-failure">{mediaErrorMessage(state.error, t)}</p>
      )}
    </div>
  );
}
function AttachForm({
  pending,
  onSubmit,
}: {
  pending: boolean;
  onSubmit: (expiresAt: string) => void;
}) {
  const t = useT();
  const id = useId();
  const [days, setDays] = useState(30);
  return (
    <form
      className="stack media-review"
      aria-label={t("mediaView.attach.label")}
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(new Date(Date.now() + days * DAY).toISOString());
      }}
    >
      <Field
        label={t("mediaView.attach.days")}
        htmlFor={id + "-days"}
        hint={t("mediaView.attach.daysHint")}
      >
        <input
          id={id + "-days"}
          type="number"
          min={1}
          max={180}
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
        />
      </Field>
      <Button
        kind="primary"
        type="submit"
        disabled={pending || !(days >= 1 && days <= 180)}
      >
        <BookMarked size={16} aria-hidden="true" />{" "}
        {t("mediaView.attach.label")}
      </Button>
    </form>
  );
}
function RevokeForm({
  pending,
  onCancel,
  onSubmit,
}: {
  pending: boolean;
  onCancel: () => void;
  onSubmit: (reason: string) => void;
}) {
  const t = useT();
  const id = useId();
  const [reason, setReason] = useState("");
  return (
    <form
      className="stack media-review"
      aria-label={t("mediaView.revoke.label")}
      onSubmit={(e) => {
        e.preventDefault();
        if (reason.trim().length >= 10) onSubmit(reason.trim());
      }}
    >
      <Field
        label={t("mediaView.revoke.reason")}
        htmlFor={id + "-reason"}
        hint={t("mediaView.revoke.reasonHint")}
      >
        <textarea
          id={id + "-reason"}
          dir="auto"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </Field>
      <div className="tag-row">
        <Button
          kind="danger"
          type="submit"
          disabled={pending || reason.trim().length < 10}
        >
          {t("mediaView.revoke.confirm")}
        </Button>
        <Button type="button" onClick={onCancel} disabled={pending}>
          {t("mediaView.revoke.keep")}
        </Button>
      </div>
    </form>
  );
}
