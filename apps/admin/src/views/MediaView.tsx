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
  failureText,
  mediaErrorMessage,
  usd,
  type MediaAdminPort,
  type MediaEstimate,
  type MediaJob,
  type MediaLibrary,
  type MediaReviewInput,
} from "../domain/media";
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
import { isolate } from "@course-core/i18n";
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
    clear: () => {
      setError(undefined);
      setMessage(undefined);
    },
  };
}
type Command = ReturnType<typeof useMediaCommand>;

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
  const [requesting, setRequesting] = useState(false);
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
        {command.error !== undefined && (
          <Notice tone="red">{mediaErrorMessage(command.error, t)}</Notice>
        )}
      </div>
      {!lib.liveGenerationVerified && (
        <Notice tone="gold" title={t("mediaView.unverified.title")}>
          {t("mediaView.unverified.body")}
        </Notice>
      )}
      <ProviderCard library={lib} />
      <Card
        eyebrow={t("mediaView.title")}
        title={t("mediaView.jobs.title")}
        actions={
          <Button
            kind="primary"
            disabled={
              !lib.permissions.request || !lib.provider || command.pending
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
                  <StateBadge state={job.state} />
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
      {requesting && (
        <RequestDialog
          port={port}
          library={lib}
          pending={command.pending}
          onClose={() => setRequesting(false)}
          onSubmit={async (enrollmentId, input) => {
            const ok = await command.run(
              "request:" + enrollmentId + JSON.stringify(input),
              (key) => port.request(enrollmentId, input, key),
              t("mediaView.requested"),
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
  return (
    <Card
      eyebrow={t("mediaView.provider.eyebrow")}
      title={t("mediaView.provider.title")}
    >
      <dl className="media-facts">
        <div>
          <dt>{t("mediaView.provider.model")}</dt>
          <dd className="mono" dir="ltr">
            {p.modelId}
          </dd>
        </div>
        <div>
          <dt>{t("mediaView.provider.clip")}</dt>
          <dd>
            {t("mediaView.provider.clipSettings", {
              seconds: p.settings.durationSeconds,
              aspect: p.settings.aspectRatio,
              resolution: p.settings.resolution,
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
          <dt>{t("mediaView.provider.estimate")}</dt>
          <dd>
            {p.pricing
              ? t("mediaView.provider.estimateValue", {
                  estimate: usd(p.estimateMicroUsd, i18n),
                  rate: usd(p.pricing.microUsdPerOutputSecond, i18n),
                })
              : t("mediaView.provider.noRateCard")}
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

function RequestDialog({
  port,
  library,
  pending,
  onClose,
  onSubmit,
}: {
  port: MediaAdminPort;
  library: MediaLibrary;
  pending: boolean;
  onClose: () => void;
  onSubmit: (
    enrollmentId: string,
    input: {
      episodeId: string;
      title: string;
      objective: string;
      script: string;
    },
  ) => void;
}) {
  const t = useT();
  const i18n = useI18n();
  const id = useId();
  const [enrollmentId, setEnrollmentId] = useState(
    library.enrollments[0]?.id ?? "",
  );
  const [episodeId, setEpisodeId] = useState(library.episodes[0]?.id ?? "");
  const [title, setTitle] = useState("");
  const [objective, setObjective] = useState("");
  const [script, setScript] = useState("");
  const [estimate, setEstimate] = useState<{
    value?: MediaEstimate;
    error?: unknown;
    loading?: boolean;
  }>({});
  const valid =
    enrollmentId &&
    episodeId &&
    title.trim().length >= 3 &&
    objective.trim().length >= 10 &&
    script.trim().length >= 20;
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
          if (valid)
            onSubmit(enrollmentId, {
              episodeId,
              title: title.trim(),
              objective: objective.trim(),
              script: script.trim(),
            });
        }}
      >
        <p>{t("mediaView.request.intro")}</p>
        <Field label={t("mediaView.fact.learner")} htmlFor={id + "-learner"}>
          <select
            id={id + "-learner"}
            value={enrollmentId}
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
        <Field
          label={t("mediaView.request.script")}
          htmlFor={id + "-script"}
          hint={t("mediaView.request.scriptHint")}
        >
          <textarea
            id={id + "-script"}
            dir="auto"
            value={script}
            maxLength={8000}
            onChange={(e) => setScript(e.target.value)}
          />
        </Field>
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
        <div className="tag-row">
          <Button kind="primary" type="submit" disabled={pending || !valid}>
            <Clapperboard size={16} aria-hidden="true" />{" "}
            {t("mediaView.request.submit")}
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
      title={job ? isolate(job.title) : t("mediaView.job.title")}
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
              <Notice tone="red">{mediaErrorMessage(command.error, t)}</Notice>
            )}
          </div>
          <div className="tag-row">
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
          {job.asset && (
            <div className="media-preview">
              <video
                controls
                preload="metadata"
                playsInline
                aria-label={t("mediaView.job.videoLabel", { title: job.title })}
                src={port.assetUrl(job.id)}
              />
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
  pending,
  onSubmit,
}: {
  sha: string;
  pending: boolean;
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
  const [rationale, setRationale] = useState("");
  const [checks, setChecks] = useState({
    factualAccuracy: false,
    labelsAndEquations: false,
    captionsMatchNarration: false,
    noMisleadingMotion: false,
  });
  const approving = decision === "approved";
  const ready =
    rationale.trim().length >= 20 &&
    (!approving ||
      (Object.values(checks).every(Boolean) &&
        transcript.trim().length >= 20 &&
        description.trim().length >= 20 &&
        /-->/.test(captions)));
  return (
    <form
      className="stack media-review"
      aria-label={t("mediaView.review.label")}
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready) return;
        onSubmit({
          decision,
          assetSha256: sha,
          findings: checks,
          rationale: rationale.trim(),
          ...(approving
            ? {
                captionsVtt: captions,
                transcript: transcript.trim(),
                visualDescription: description.trim(),
              }
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
            {t(`mediaView.check.${key}`)}
          </label>
        ))}
      </fieldset>
      {approving && (
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
          <Field
            label={t("mediaView.review.description")}
            htmlFor={id + "-description"}
            hint={t("mediaView.review.descriptionHint")}
          >
            <textarea
              id={id + "-description"}
              dir="auto"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
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
