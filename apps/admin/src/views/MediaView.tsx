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
  Status,
  when,
} from "../components/ui";

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
const stateLabel: Record<MediaJob["state"], string> = {
  requested: "requested",
  admitted: "admitted · budget reserved",
  submitted: "submitted",
  polling: "generating",
  generated: "generated",
  under_review: "pending review",
  approved: "approved",
  rejected: "rejected",
  attached: "attached",
  expired: "expired",
  failed: "failed",
  cancelled: "cancelled",
  uncertain: "outcome uncertain",
};

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
      key = "admin-media-" + crypto.randomUUID();
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
  const published = data.releases.filter((r) => r.state === "published");
  const [releaseId, setReleaseId] = useState(
    (published.find((r) => r.availableForNewLearners) ?? published[0])?.id,
  );
  if (!client.media)
    return (
      <Card title="Generated media">
        <EmptyState title="Generated media is not available here">
          This workspace client does not provide media jobs. Use a connected
          administration session.
        </EmptyState>
      </Card>
    );
  if (!releaseId)
    return (
      <Card title="Generated media">
        <EmptyState title="Publish a release first">
          Generated clips attach to an episode of a published release.
        </EmptyState>
      </Card>
    );
  return (
    <div className="page-stack">
      <Notice tone="blue" title="Nothing generated reaches learners unreviewed">
        A finished render is not a teaching artifact. Staff review each clip
        against the lesson, add captions and a text alternative, and only then
        attach it as optional help. It never counts as progress or mastery.
      </Notice>
      {published.length > 1 && (
        <div className="field">
          <label htmlFor="media-release">Release</label>
          <select
            id="media-release"
            value={releaseId}
            onChange={(e) => setReleaseId(e.target.value)}
          >
            {published.map((r) => (
              <option key={r.id} value={r.id}>
                Version {r.version}
                {r.availableForNewLearners ? " (new learners)" : ""}
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
  const library = useRemote(
    (signal) => port.library(releaseId, signal),
    [port, releaseId],
  );
  const command = useMediaCommand(() => library.reload());
  const [requesting, setRequesting] = useState(false);
  const [open, setOpen] = useState<string>();
  if (library.loading && !library.data)
    return <Loading label="Loading media jobs…" />;
  if (library.error || !library.data)
    return <Notice tone="red">{mediaErrorMessage(library.error)}</Notice>;
  const lib = library.data;
  const episodeTitle = (id: string) =>
    lib.episodes.find((e) => e.id === id)?.title ?? id;
  return (
    <>
      <div aria-live="polite">
        {command.message && <Notice tone="green">{command.message}</Notice>}
        {command.error !== undefined && (
          <Notice tone="red">{mediaErrorMessage(command.error)}</Notice>
        )}
      </div>
      {!lib.liveGenerationVerified && (
        <Notice tone="gold" title="Live generation not verified">
          This deployment has not verified a real provider render end to end.
          Treat cost estimates as the operator rate card, not a provider
          invoice.
        </Notice>
      )}
      <ProviderCard library={lib} />
      <Card
        eyebrow="Generated media"
        title="Media jobs"
        actions={
          <Button
            kind="primary"
            disabled={
              !lib.permissions.request || !lib.provider || command.pending
            }
            onClick={() => setRequesting(true)}
          >
            <Plus size={16} aria-hidden="true" /> Request a clip
          </Button>
        }
      >
        {!lib.permissions.request && (
          <p className="media-hint">
            Requesting paid work needs the publish permission.
          </p>
        )}
        {lib.jobs.length === 0 ? (
          <p className="research-empty">No media jobs for this release yet.</p>
        ) : (
          <ul className="media-jobs" aria-label="Media jobs">
            {lib.jobs.map((job) => (
              <li key={job.id} className="media-job">
                <div className="media-job-head">
                  <strong>{job.title}</strong>
                  <Status value={stateLabel[job.state]} />
                </div>
                <dl className="media-facts">
                  <div>
                    <dt>Learner</dt>
                    <dd>{job.learnerName ?? "Unknown learner"}</dd>
                  </div>
                  <div>
                    <dt>Episode</dt>
                    <dd>{episodeTitle(job.episodeId)}</dd>
                  </div>
                  <div>
                    <dt>Estimate</dt>
                    <dd>{usd(job.estimateMicroUsd)}</dd>
                  </div>
                  <div>
                    <dt>Charged</dt>
                    <dd>{usd(job.chargedMicroUsd)}</dd>
                  </div>
                  <div className="media-wide">
                    <dt>Provider operation</dt>
                    <dd className="mono">
                      {job.providerOperationId ?? "not submitted"}
                    </dd>
                  </div>
                </dl>
                {job.failureCode && (
                  <p className="media-failure">
                    {failureText(job.failureCode)}
                  </p>
                )}
                <div className="tag-row">
                  {job.learnerVisible && (
                    <Badge tone="green">visible to learner</Badge>
                  )}
                  <small className="media-updated">
                    Updated {when(job.updatedAt)}
                  </small>
                  <Button
                    kind="quiet"
                    onClick={() => setOpen(job.id)}
                    aria-label={`Open ${job.title}`}
                  >
                    Open
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
              "Request recorded. Check its state below: a refused request is kept with its reason and nothing is charged.",
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

function ProviderCard({ library }: { library: MediaLibrary }) {
  const p = library.provider;
  if (!p)
    return (
      <Card eyebrow="Provider" title="No media provider">
        <p className="research-empty">
          Assign a video model to the media role under Providers, with a
          reviewed rate card.
        </p>
      </Card>
    );
  return (
    <Card eyebrow="Provider" title="Video generation">
      <dl className="media-facts">
        <div>
          <dt>Model</dt>
          <dd className="mono">{p.modelId}</dd>
        </div>
        <div>
          <dt>Clip</dt>
          <dd>
            {p.settings.durationSeconds}s · {p.settings.aspectRatio} ·{" "}
            {p.settings.resolution}
          </dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>
            <Status value={p.availability.replaceAll("_", " ")} />
          </dd>
        </div>
        <div>
          <dt>Estimate per clip</dt>
          <dd>
            {p.pricing
              ? `${usd(p.estimateMicroUsd)} (${usd(p.pricing.microUsdPerOutputSecond)}/s)`
              : "no rate card"}
          </dd>
        </div>
        <div>
          <dt>Reserved at admission</dt>
          <dd>{usd(p.perJobAllowanceMicroUsd)} (full per-job allowance)</dd>
        </div>
        {p.pricing && (
          <div className="media-wide">
            <dt>Rate card</dt>
            <dd>
              {p.pricing.source}, reviewed {p.pricing.reviewedAt}
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
      title="Request a generated clip"
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
        <p>
          The clip is generated for one learner's episode and charged to their
          paid-work allowance. It stays hidden until staff approve and attach
          it.
        </p>
        <Field label="Learner" htmlFor={id + "-learner"}>
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
        <Field label="Episode" htmlFor={id + "-episode"}>
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
        <Field label="Title" htmlFor={id + "-title"}>
          <input
            id={id + "-title"}
            value={title}
            maxLength={200}
            onChange={(e) => setTitle(e.target.value)}
          />
        </Field>
        <Field
          label="Teaching purpose"
          htmlFor={id + "-objective"}
          hint="What the learner should understand from it."
        >
          <textarea
            id={id + "-objective"}
            value={objective}
            maxLength={2000}
            onChange={(e) => setObjective(e.target.value)}
          />
        </Field>
        <Field
          label="Reviewed script"
          htmlFor={id + "-script"}
          hint="Sent to the provider exactly as written. No learner data."
        >
          <textarea
            id={id + "-script"}
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
            Check cost
          </Button>
          {estimate.value && (
            <p>
              Estimate {usd(estimate.value.estimateMicroUsd)};{" "}
              {usd(estimate.value.reserveMicroUsd)} is reserved at admission (
              {usd(estimate.value.availableMicroUsd)} available).{" "}
              <strong>
                {estimate.value.admissible
                  ? "Would be admitted."
                  : `Would be refused: ${failureText(estimate.value.reason) ?? estimate.value.reason}.`}
              </strong>
            </p>
          )}
          {estimate.error !== undefined && (
            <p className="media-failure">{mediaErrorMessage(estimate.error)}</p>
          )}
        </div>
        <div className="tag-row">
          <Button kind="primary" type="submit" disabled={pending || !valid}>
            <Clapperboard size={16} aria-hidden="true" /> Request clip
          </Button>
          <Button type="button" onClick={onClose} disabled={pending}>
            Cancel
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
  const detail = useRemote(
    (signal) => port.detail(jobId, signal),
    [port, jobId],
  );
  const [revoking, setRevoking] = useState(false);
  const job = detail.data;
  const after = (ok: boolean) => ok && detail.reload();
  return (
    <Dialog
      title={job?.title ?? "Media job"}
      onClose={onClose}
      pending={command.pending}
    >
      {detail.loading && !job ? (
        <Loading label="Loading job…" />
      ) : detail.error || !job ? (
        <Notice tone="red">{mediaErrorMessage(detail.error)}</Notice>
      ) : (
        <div className="stack">
          <div aria-live="polite">
            {command.message && <Notice tone="green">{command.message}</Notice>}
            {command.error !== undefined && (
              <Notice tone="red">{mediaErrorMessage(command.error)}</Notice>
            )}
          </div>
          <div className="tag-row">
            <Status value={stateLabel[job.state]} />
            {job.learnerVisible ? (
              <Badge tone="green">visible to learner</Badge>
            ) : (
              <Badge>hidden from learners</Badge>
            )}
          </div>
          {job.failureCode && (
            <p className="media-failure">{failureText(job.failureCode)}</p>
          )}
          {job.remoteMayContinue && (
            <Notice tone="gold">
              The provider may still finish or bill this operation; cancelling
              here is local only.
            </Notice>
          )}
          <dl className="media-facts">
            <div>
              <dt>Learner</dt>
              <dd>{job.learnerName ?? "Unknown learner"}</dd>
            </div>
            <div>
              <dt>Episode</dt>
              <dd>{episodeTitle(job.episodeId)}</dd>
            </div>
            <div>
              <dt>Estimate</dt>
              <dd>{usd(job.estimateMicroUsd)}</dd>
            </div>
            <div>
              <dt>Charged</dt>
              <dd>{usd(job.chargedMicroUsd)}</dd>
            </div>
            <div className="media-wide">
              <dt>Provider operation</dt>
              <dd className="mono">
                {job.providerOperationId ?? "not submitted"}
              </dd>
            </div>
            <div>
              <dt>Submissions / polls</dt>
              <dd>
                {job.submitAttempts} / {job.pollAttempts}
              </dd>
            </div>
            <div>
              <dt>Deadline</dt>
              <dd>{when(job.deadlineAt)}</dd>
            </div>
          </dl>
          <details className="media-script">
            <summary>Purpose and script</summary>
            <p>{job.objective}</p>
            <p className="research-text">{job.script}</p>
          </details>
          {job.asset && (
            <div className="media-preview">
              <video
                controls
                preload="metadata"
                playsInline
                aria-label={`Generated clip: ${job.title}`}
                src={port.assetUrl(job.id)}
              />
              <small className="mono">
                sha256 {job.asset.sha256} ·{" "}
                {(job.asset.byteLength / 1024).toFixed(1)} KiB ·{" "}
                {job.asset.mimeType}
              </small>
            </div>
          )}
          {job.review && (
            <div className="media-review-summary">
              <strong>Review: {job.review.decision}</strong>
              <p>{job.review.rationale}</p>
              {job.review.transcript && (
                <p>
                  <span className="media-label">Transcript: </span>
                  {job.review.transcript}
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
                        ? "Approved. It is still hidden until attached."
                        : "Rejected. It will never be shown.",
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
                    "Attached as optional help for this learner.",
                  ),
                )
              }
            />
          )}
          {events(job)}
          <div className="tag-row">
            {job.attachment?.state === "active" &&
              library.permissions.review && (
                <Button
                  kind="danger"
                  disabled={command.pending}
                  onClick={() => setRevoking(true)}
                >
                  <CircleSlash size={16} aria-hidden="true" /> Revoke
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
                      "Cancelled. The reserved allowance is not returned.",
                    ),
                  )
                }
              >
                Cancel job
              </Button>
            )}
            <Button onClick={onClose} disabled={command.pending}>
              Close
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
                  "Revoked. Learners no longer see it.",
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
function events(job: MediaJob) {
  if (!job.events?.length) return null;
  return (
    <details className="media-script">
      <summary>History ({job.events.length})</summary>
      <ol className="media-events">
        {job.events.map((e, i) => (
          <li key={i}>
            <span>{stateLabel[e.to as MediaJob["state"]] ?? e.to}</span>
            {e.code && <small className="mono"> {e.code}</small>}
            <small> · {when(e.at)}</small>
          </li>
        ))}
      </ol>
    </details>
  );
}
const CHECKS = [
  ["factualAccuracy", "Facts match the lesson and its reference computation"],
  ["labelsAndEquations", "Labels, values and equations are exact"],
  ["captionsMatchNarration", "Captions match what is said and shown"],
  ["noMisleadingMotion", "Motion does not imply a wrong cause or order"],
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
      aria-label="Review this clip"
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
        <legend>Decision</legend>
        <div className="tag-row">
          {(["approved", "rejected"] as const).map((value) => (
            <label key={value} className="check-label">
              <input
                type="radio"
                name={id + "-decision"}
                checked={decision === value}
                onChange={() => setDecision(value)}
              />
              {value === "approved" ? "Approve" : "Reject"}
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend>Checks</legend>
        {CHECKS.map(([key, label]) => (
          <label className="check-label" key={key}>
            <input
              type="checkbox"
              checked={checks[key]}
              onChange={(e) =>
                setChecks({ ...checks, [key]: e.target.checked })
              }
            />
            {label}
          </label>
        ))}
      </fieldset>
      {approving && (
        <>
          <Field
            label="Captions (WebVTT)"
            htmlFor={id + "-captions"}
            hint="Required. At least one timed cue."
          >
            <textarea
              id={id + "-captions"}
              className="mono"
              value={captions}
              onChange={(e) => setCaptions(e.target.value)}
            />
          </Field>
          <Field
            label="Transcript"
            htmlFor={id + "-transcript"}
            hint="Required text alternative of everything said."
          >
            <textarea
              id={id + "-transcript"}
              value={transcript}
              onChange={(e) => setTranscript(e.target.value)}
            />
          </Field>
          <Field
            label="What the video shows"
            htmlFor={id + "-description"}
            hint="Required for learners who cannot see it."
          >
            <textarea
              id={id + "-description"}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
        </>
      )}
      <Field label="Rationale" htmlFor={id + "-rationale"}>
        <textarea
          id={id + "-rationale"}
          value={rationale}
          onChange={(e) => setRationale(e.target.value)}
        />
      </Field>
      <Button kind="primary" type="submit" disabled={pending || !ready}>
        <ShieldCheck size={16} aria-hidden="true" /> Save review
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
  const id = useId();
  const [days, setDays] = useState(30);
  return (
    <form
      className="stack media-review"
      aria-label="Attach as optional help"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(new Date(Date.now() + days * DAY).toISOString());
      }}
    >
      <Field
        label="Show for (days)"
        htmlFor={id + "-days"}
        hint="1 to 180 days. Publication is re-checked against current course policy."
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
        <BookMarked size={16} aria-hidden="true" /> Attach as optional help
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
  const id = useId();
  const [reason, setReason] = useState("");
  return (
    <form
      className="stack media-review"
      aria-label="Revoke attachment"
      onSubmit={(e) => {
        e.preventDefault();
        if (reason.trim().length >= 10) onSubmit(reason.trim());
      }}
    >
      <Field
        label="Reason"
        htmlFor={id + "-reason"}
        hint="At least 10 characters. Learners stop seeing the clip at once."
      >
        <textarea
          id={id + "-reason"}
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
          Confirm revoke
        </Button>
        <Button type="button" onClick={onCancel} disabled={pending}>
          Keep it
        </Button>
      </div>
    </form>
  );
}
