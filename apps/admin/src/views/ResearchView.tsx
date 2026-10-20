import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  BookMarked,
  CircleSlash,
  ExternalLink,
  FileSearch,
  Link2,
  Plus,
  ScanText,
  Search,
} from "lucide-react";
import type { AdminClient, CourseWorkspace } from "../domain/contracts";
import {
  researchErrorMessage,
  type InspectionView,
  type ResearchLibrary,
  type ResearchSource,
  type ReviewInput,
} from "../domain/research";
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
  PermissionHint,
  Status,
  when,
} from "../components/ui";
import { randomId } from "../domain/webCrypto";

const DAY = 86400_000;
/** 75 → "1:15", 3725 → "1:02:05". */
const clock = (seconds: number) => {
  const h = Math.floor(seconds / 3600),
    m = Math.floor((seconds % 3600) / 60),
    r = seconds % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
};
const isoAfterDays = (days: number) =>
  new Date(Date.now() + days * DAY).toISOString();
type Port = NonNullable<AdminClient["research"]>;
type Topic = ResearchLibrary["topics"][number];

/** Keeps one retry key per logical command until it succeeds, so a lost
 * response followed by "try again" replays rather than duplicates. */
function useResearchCommand(onDone: () => void) {
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
      key = "admin-" + randomId();
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
  return { run, pending, error, message };
}
function sourceState(source: ResearchSource) {
  if (source.expired) return "approval expired";
  const latest = source.reviews[0];
  if (latest) return latest.decision.replace("needs_review", "needs review");
  if (source.inspections.length) return "inspected unreviewed";
  return source.failures.length ? "inspection failed" : "not inspected";
}

export function ResearchView({
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
  if (!client.research)
    return (
      <Card title="Research sources">
        <EmptyState title="Research review is not available here">
          This workspace client does not provide source inspection. Use a
          connected administration session.
        </EmptyState>
      </Card>
    );
  if (!releaseId)
    return (
      <Card title="Research sources">
        <EmptyState title="Publish a release first">
          Reviewed resources attach to an immutable published release.
        </EmptyState>
      </Card>
    );
  return (
    <div className="page-stack">
      <Notice tone="blue" title="Untrusted until reviewed">
        Search results and fetched pages are untrusted external content. An
        approval records an evidence-backed content-use decision, not a truth
        certificate. Attached resources are optional help for learners and never
        count as progress or mastery.
      </Notice>
      {published.length > 1 && (
        <div className="field">
          <label htmlFor="research-release">Release</label>
          <select
            id="research-release"
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
      <ReleaseResearch
        key={releaseId}
        port={client.research}
        releaseId={releaseId}
        permissions={data.permissions}
      />
    </div>
  );
}

function ReleaseResearch({
  port,
  releaseId,
  permissions,
}: {
  port: Port;
  releaseId: string;
  permissions: CourseWorkspace["permissions"];
}) {
  const library = useRemote(
    (signal) => port.library(releaseId, signal),
    [port, releaseId],
  );
  const queue = useRemote(
    (signal) =>
      permissions.includes("release.publish") ||
      permissions.includes("run.inspect")
        ? port.queue(releaseId, signal)
        : Promise.resolve({ requests: [] }),
    [port, releaseId],
  );
  const command = useResearchCommand(() => library.reload());
  const [adding, setAdding] = useState<{
    topic: Topic;
    url?: string;
    candidateId?: string;
    searchId?: string;
  }>();
  const [reviewing, setReviewing] = useState<{
    source: ResearchSource;
    inspection: InspectionView;
  }>();
  const [attaching, setAttaching] = useState<{
    source: ResearchSource;
    reviewId: string;
  }>();
  const [revoking, setRevoking] = useState<string>();
  if (library.loading) return <Loading label="Loading research library…" />;
  if (library.error || !library.data)
    return <Notice tone="red">{researchErrorMessage(library.error)}</Notice>;
  const lib = library.data;
  const canWrite = permissions.includes("course.write"),
    canReview = permissions.includes("release.review"),
    canPublish = permissions.includes("release.publish");
  const episodeTitle = (id: string) =>
    lib.topics.flatMap((t) => t.episodes).find((e) => e.id === id)?.title ?? id;
  const suggestions = (queue.data?.requests ?? []).flatMap((r) =>
    (r.content?.sources ?? []).map((s) => ({
      ...s,
      topicId: r.topicId,
      candidateId: r.candidateId,
    })),
  );
  return (
    <>
      <div aria-live="polite">
        {command.message && <Notice tone="green">{command.message}</Notice>}
        {command.error !== undefined && (
          <Notice tone="red">{researchErrorMessage(command.error)}</Notice>
        )}
      </div>
      {lib.topics.length === 0 && (
        <Card title="Approved research topics">
          <EmptyState title="No public research topics">
            This release declares no author-approved public research topics.
          </EmptyState>
        </Card>
      )}
      {lib.topics.map((topic) => {
        const sources = lib.sources.filter((s) => s.topicId === topic.id);
        const topicSuggestions = suggestions.filter(
          (s) =>
            s.topicId === topic.id && !sources.some((x) => x.url === s.uri),
        );
        return (
          <Card
            key={topic.id}
            eyebrow="Approved public topic"
            title={topic.queryText}
            actions={
              <>
                {port.youtubeSearch && (
                  <Button
                    disabled={!canWrite || command.pending}
                    onClick={() =>
                      void command.run(
                        "youtube-search:" + topic.id + ":" + Date.now(),
                        () => port.youtubeSearch!(releaseId, topic.id),
                        "YouTube results saved as unreviewed leads. Only this topic's approved query was sent.",
                      )
                    }
                  >
                    <Search size={16} aria-hidden="true" /> Search YouTube
                  </Button>
                )}
                <Button
                  disabled={!canWrite || command.pending}
                  onClick={() => setAdding({ topic })}
                >
                  <Plus size={16} aria-hidden="true" /> Add source
                </Button>
              </>
            }
          >
            <PermissionHint permissions={permissions} required="course.write" />
            <p className="research-meta">
              <span>
                Episodes:{" "}
                {topic.episodes.map((e) => e.title).join(", ") || "none"}
              </span>
              <span>
                Domains:{" "}
                {topic.allowedDomains.length
                  ? topic.allowedDomains.join(", ")
                  : "any public HTTPS host chosen by staff"}
              </span>
            </p>
            {topicSuggestions.length > 0 && (
              <details className="research-suggestions">
                <summary>
                  {topicSuggestions.length} unreviewed research suggestion
                  {topicSuggestions.length === 1 ? "" : "s"}
                </summary>
                <ul>
                  {topicSuggestions.slice(0, 10).map((s) => (
                    <li key={s.uri}>
                      <span className="grow">
                        <strong>{s.title || "Untitled result"}</strong>
                        <small className="mono">{s.uri}</small>
                      </span>
                      <Button
                        kind="quiet"
                        disabled={!canWrite || command.pending}
                        onClick={() =>
                          setAdding({
                            topic,
                            url: s.uri,
                            ...(s.candidateId
                              ? { candidateId: s.candidateId }
                              : {}),
                          })
                        }
                      >
                        Use as source
                      </Button>
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {(() => {
              const latest = lib.searches?.find((x) => x.topicId === topic.id);
              if (!latest) return null;
              return (
                <details className="research-suggestions">
                  <summary>
                    {latest.hits.length} YouTube result
                    {latest.hits.length === 1 ? "" : "s"} · metadata only,
                    unreviewed
                  </summary>
                  <p className="research-meta">
                    <span>
                      Searched {when(latest.createdAt)} for “{latest.sent.q}”. A
                      title is not a review: inspect and review before
                      attaching.
                    </span>
                  </p>
                  <ul>
                    {latest.hits.map((hit) => {
                      const added = sources.some(
                        (x) =>
                          x.url ===
                          `https://www.youtube.com/watch?v=${hit.videoId}`,
                      );
                      return (
                        <li key={hit.videoId}>
                          <span className="grow">
                            <strong>{hit.title}</strong>
                            <small>
                              {hit.channelTitle}
                              {hit.durationSeconds !== null &&
                                ` · ${clock(hit.durationSeconds)}`}
                              {hit.captions === "creator_captions"
                                ? " · captions"
                                : " · captions unknown"}
                              {hit.embeddable === false &&
                                " · embedding not allowed"}
                            </small>
                          </span>
                          <Button
                            kind="quiet"
                            disabled={!canWrite || command.pending || added}
                            onClick={() =>
                              setAdding({
                                topic,
                                url: hit.watchUrl,
                                searchId: latest.id,
                              })
                            }
                          >
                            {added ? "Added" : "Use as source"}
                          </Button>
                        </li>
                      );
                    })}
                  </ul>
                </details>
              );
            })()}
            {sources.length === 0 ? (
              <p className="research-empty">No sources added yet.</p>
            ) : (
              <ul className="research-sources">
                {sources.map((source) => (
                  <SourceItem
                    key={source.id}
                    source={source}
                    library={lib}
                    pending={command.pending}
                    canWrite={canWrite}
                    canReview={canReview}
                    canPublish={canPublish}
                    onInspect={() =>
                      void command.run(
                        "inspect:" + source.id,
                        () => port.inspect(source.id),
                        "Inspection saved as unreviewed content.",
                      )
                    }
                    onReview={(inspection) =>
                      setReviewing({ source, inspection })
                    }
                    onAttach={(reviewId) => setAttaching({ source, reviewId })}
                    onRevoke={setRevoking}
                    episodeTitle={episodeTitle}
                  />
                ))}
              </ul>
            )}
          </Card>
        );
      })}
      {adding && (
        <AddSourceDialog
          topic={adding.topic}
          initialUrl={adding.url}
          pending={command.pending}
          onClose={() => setAdding(undefined)}
          onSubmit={async (input) => {
            const ok = await command.run(
              "add:" + JSON.stringify(input),
              (key) =>
                port.addSource(
                  releaseId,
                  {
                    ...input,
                    topicId: adding.topic.id,
                    ...(adding.candidateId
                      ? { candidateId: adding.candidateId }
                      : {}),
                    ...(adding.searchId && input.kind === "youtube"
                      ? { searchId: adding.searchId }
                      : {}),
                  },
                  key,
                ),
              "Source approved for inspection. Its content is not reviewed yet.",
            );
            if (ok) setAdding(undefined);
          }}
        />
      )}
      {reviewing && (
        <ReviewDialog
          inspection={reviewing.inspection}
          pending={command.pending}
          onClose={() => setReviewing(undefined)}
          onSubmit={async (input) => {
            const ok = await command.run(
              "review:" + reviewing.inspection.id + JSON.stringify(input),
              (key) => port.review(reviewing.inspection.id, input, key),
              `Review recorded: ${input.decision.replace("_", " ")}.`,
            );
            if (ok) setReviewing(undefined);
          }}
        />
      )}
      {attaching && (
        <AttachDialog
          episodes={
            lib.topics.find((t) => t.id === attaching.source.topicId)
              ?.episodes ?? []
          }
          maxExpiry={attaching.source.expiresAt}
          pending={command.pending}
          onClose={() => setAttaching(undefined)}
          onSubmit={async (input) => {
            const ok = await command.run(
              "attach:" + attaching.reviewId + JSON.stringify(input),
              (key) => port.attach(attaching.reviewId, input, key),
              "Resource attached as optional help for that episode.",
            );
            if (ok) setAttaching(undefined);
          }}
        />
      )}
      {revoking && (
        <RevokeDialog
          pending={command.pending}
          onClose={() => setRevoking(undefined)}
          onSubmit={async (reason) => {
            const ok = await command.run(
              "revoke:" + revoking + reason,
              (key) => port.revoke(revoking, reason, key),
              "Attachment revoked. Learners no longer see it.",
            );
            if (ok) setRevoking(undefined);
          }}
        />
      )}
      <Card
        title="Delivered to learners"
        eyebrow="Optional, revocable, expiring"
      >
        <PermissionHint permissions={permissions} required="release.review" />
        {lib.attachments.length === 0 ? (
          <p className="research-empty">No reviewed resources are attached.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <caption className="sr-only">Attached research resources</caption>
              <thead>
                <tr>
                  <th scope="col">Source</th>
                  <th scope="col">Episode</th>
                  <th scope="col">State</th>
                  <th scope="col">Expires</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {lib.attachments.map((a) => {
                  const source = lib.sources.find((s) => s.id === a.sourceId);
                  return (
                    <tr key={a.id}>
                      <td className="research-url">
                        {source?.inspections[0]?.title ??
                          source?.url ??
                          a.sourceId}
                      </td>
                      <td>{episodeTitle(a.episodeId)}</td>
                      <td>
                        <Status value={a.state} />
                        {a.revokeReason && <small> {a.revokeReason}</small>}
                      </td>
                      <td>{when(a.expiresAt)}</td>
                      <td>
                        {a.state === "active" && (
                          <Button
                            kind="danger"
                            disabled={!canReview || command.pending}
                            onClick={() => setRevoking(a.id)}
                          >
                            <CircleSlash size={16} aria-hidden="true" /> Revoke
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

function SourceItem({
  source,
  library,
  pending,
  canWrite,
  canReview,
  canPublish,
  onInspect,
  onReview,
  onAttach,
  onRevoke,
  episodeTitle,
}: {
  episodeTitle: (id: string) => string;
  source: ResearchSource;
  library: ResearchLibrary;
  pending: boolean;
  canWrite: boolean;
  canReview: boolean;
  canPublish: boolean;
  onInspect: () => void;
  onReview: (inspection: InspectionView) => void;
  onAttach: (reviewId: string) => void;
  onRevoke: (attachmentId: string) => void;
}) {
  const inspection = source.inspections[0];
  const latestReview = source.reviews[0];
  const reviewedLatest =
    latestReview && inspection && latestReview.inspectionId === inspection.id;
  const live = library.attachments.filter(
    (a) => a.sourceId === source.id && a.state === "active",
  );
  return (
    <li className="research-source">
      <div className="split-line">
        <span className="grow">
          <strong>
            {source.kind === "youtube" ? "Video" : "Web page"} ·{" "}
            {inspection?.title ?? "Not yet inspected"}
          </strong>
          <a
            className="mono research-url"
            href={source.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            {source.url}
            <ExternalLink size={13} aria-hidden="true" />
            <span className="sr-only"> (opens a new tab)</span>
          </a>
        </span>
        <Status value={sourceState(source)} />
      </div>
      <small>
        {source.kind === "youtube" &&
          source.durationSeconds != null &&
          `${clock(source.durationSeconds)} · `}
        {source.kind === "youtube" &&
          source.captions &&
          (source.captions === "creator_captions"
            ? "captions · "
            : "captions unknown · ")}
        Approval expires {when(source.expiresAt)}
        {live.length > 0 && ` · delivered to ${live.length} episode(s)`}
      </small>
      {source.failures[0] && !inspection && (
        <p className="research-failure">
          Last inspection failed:{" "}
          {source.failures[0].code.replaceAll("_", " ").toLowerCase()} (
          {when(source.failures[0].createdAt)}). No content was stored.
        </p>
      )}
      {inspection && (
        <details className="research-inspection">
          <summary>
            Inspected {when(inspection.createdAt)} ·{" "}
            {inspection.basis.replaceAll("_", " ")}
            {inspection.truncated ? " · truncated" : ""}
          </summary>
          <dl className="facts vertical">
            <div>
              <dt>Final address</dt>
              <dd className="mono">{inspection.finalUrl}</dd>
            </div>
            <div>
              <dt>Attribution (unverified)</dt>
              <dd>
                {inspection.attributions
                  .map((a) =>
                    [a.providerName, a.authorName].filter(Boolean).join(" — "),
                  )
                  .join("; ") || "None supplied"}
              </dd>
            </div>
            <div>
              <dt>Content digest</dt>
              <dd className="mono">{inspection.contentDigest.slice(0, 16)}…</dd>
            </div>
          </dl>
          <div
            className="research-text"
            tabIndex={0}
            role="region"
            aria-label="Inspected readable text"
          >
            {inspection.text || "No readable text. Metadata only."}
          </div>
        </details>
      )}
      {latestReview && (
        <p className="research-review">
          <Badge
            tone={
              latestReview.decision === "approved"
                ? "green"
                : latestReview.decision === "rejected"
                  ? "red"
                  : "gold"
            }
          >
            {latestReview.decision.replace("_", " ")}
          </Badge>{" "}
          {latestReview.rationale}
          {latestReview.segment &&
            ` Reviewed part: ${clock(latestReview.segment.startSeconds)}–${clock(latestReview.segment.endSeconds)}.`}
          {!reviewedLatest && " (reviewed an earlier inspection)"}
        </p>
      )}
      <div className="tag-row">
        <Button
          disabled={!canWrite || pending || source.expired}
          onClick={onInspect}
        >
          <ScanText size={16} aria-hidden="true" />
          {inspection ? "Inspect again" : "Inspect now"}
        </Button>
        {inspection && (
          <Button
            disabled={!canReview || pending || source.expired}
            onClick={() => onReview(inspection)}
          >
            <FileSearch size={16} aria-hidden="true" /> Review content
          </Button>
        )}
        {latestReview?.decision === "approved" && (
          <Button
            kind="primary"
            disabled={!canPublish || pending || source.expired}
            onClick={() => onAttach(latestReview.id)}
          >
            <Link2 size={16} aria-hidden="true" /> Attach to episode
          </Button>
        )}
        {live.map((a) => (
          <Button
            key={a.id}
            kind="quiet"
            disabled={!canReview || pending}
            onClick={() => onRevoke(a.id)}
          >
            Revoke from {episodeTitle(a.episodeId)}
          </Button>
        ))}
      </div>
    </li>
  );
}

function AddSourceDialog({
  topic,
  initialUrl,
  pending,
  onClose,
  onSubmit,
}: {
  topic: Topic;
  initialUrl?: string;
  pending: boolean;
  onClose: () => void;
  onSubmit: (input: {
    kind: "web" | "youtube";
    url: string;
    fallbackText?: string;
    expiresAt: string;
  }) => void;
}) {
  const id = useId();
  const [kind, setKind] = useState<"web" | "youtube">(
    initialUrl && /youtu\.?be/.test(initialUrl) ? "youtube" : "web",
  );
  const [url, setUrl] = useState(initialUrl ?? "");
  const [fallback, setFallback] = useState("");
  const [days, setDays] = useState(90);
  return (
    <Dialog title="Add a source to inspect" onClose={onClose} pending={pending}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit({
            kind,
            url: url.trim(),
            ...(fallback.trim() ? { fallbackText: fallback.trim() } : {}),
            expiresAt: isoAfterDays(days),
          });
        }}
      >
        <p>
          Adding a source authorizes only bounded inspection for{" "}
          <strong>{topic.queryText}</strong>. Nothing is shown to learners until
          it is reviewed and attached.
        </p>
        <fieldset className="segmented">
          <legend>Source type</legend>
          {(["web", "youtube"] as const).map((value) => (
            <label key={value}>
              <input
                type="radio"
                name={id + "-kind"}
                checked={kind === value}
                onChange={() => setKind(value)}
              />
              {value === "web" ? "Web page" : "YouTube video"}
            </label>
          ))}
        </fieldset>
        <Field
          label="Public HTTPS address"
          htmlFor={id + "-url"}
          hint={
            topic.allowedDomains.length
              ? `Allowed domains: ${topic.allowedDomains.join(", ")}`
              : "No query text, credentials or custom ports."
          }
        >
          <input
            id={id + "-url"}
            type="url"
            required
            maxLength={2048}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </Field>
        {kind === "youtube" && (
          <Field
            label="Written alternative"
            htmlFor={id + "-fallback"}
            hint="Required to approve a video: describe what it explains so learners who cannot watch get the same help. Transcripts are never scraped."
          >
            <textarea
              id={id + "-fallback"}
              rows={4}
              maxLength={10000}
              value={fallback}
              onChange={(e) => setFallback(e.target.value)}
            />
          </Field>
        )}
        <Field
          label="Approval lasts (days)"
          htmlFor={id + "-days"}
          hint="After expiry the source cannot be inspected, reviewed or delivered."
        >
          <input
            id={id + "-days"}
            type="number"
            min={1}
            max={365}
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
          />
        </Field>
        <div className="tag-row">
          <Button
            kind="primary"
            type="submit"
            disabled={pending || !url.trim()}
          >
            Add source
          </Button>
          <Button type="button" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function ReviewDialog({
  inspection,
  pending,
  onClose,
  onSubmit,
}: {
  inspection: InspectionView;
  pending: boolean;
  onClose: () => void;
  onSubmit: (input: ReviewInput) => void;
}) {
  const id = useId();
  const [decision, setDecision] = useState<ReviewInput["decision"]>("approved");
  const [rationale, setRationale] = useState("");
  const [quotes, setQuotes] = useState([{ quote: "", relevance: "" }]);
  const [checks, setChecks] = useState({
    topicRelevant: false,
    accurateEnoughForUse: false,
    safeForAudience: false,
  });
  const [use, setUse] = useState<ReviewInput["rights"]["use"]>(
    inspection.youtube ? "embed" : "link_only",
  );
  const [basis, setBasis] = useState<ReviewInput["rights"]["basis"]>(
    inspection.youtube ? "provider_embed" : "link_only",
  );
  const [reference, setReference] = useState(
    inspection.youtube
      ? "Provider embedded player; no download or redistribution."
      : "Linked with attribution only; no copying.",
  );
  const [truncation, setTruncation] = useState(false);
  const [segment, setSegment] = useState({ start: "", end: "" });
  const segmentValue =
    inspection.kind === "youtube" && segment.start !== "" && segment.end !== ""
      ? { startSeconds: Number(segment.start), endSeconds: Number(segment.end) }
      : undefined;
  const missing = useMemo(
    () =>
      quotes
        .filter((q) => q.quote.trim())
        .filter((q) => !inspection.text.includes(q.quote.trim())).length,
    [quotes, inspection.text],
  );
  const first = useRef<HTMLTextAreaElement>(null);
  useEffect(() => first.current?.focus(), []);
  return (
    <Dialog
      title="Review inspected content"
      onClose={onClose}
      pending={pending}
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit({
            decision,
            contentDigest: inspection.contentDigest,
            rationale: rationale.trim(),
            evidence: quotes
              .filter((q) => q.quote.trim())
              .map((q) => ({
                quote: q.quote.trim(),
                relevance: q.relevance.trim(),
              })),
            suitability: checks,
            rights: { use, basis, reference: reference.trim() },
            acknowledgesTruncation: truncation,
            ...(segmentValue ? { segment: segmentValue } : {}),
          });
        }}
      >
        <div
          className="research-text"
          tabIndex={0}
          role="region"
          aria-label="Text under review"
        >
          {inspection.text || "No readable text. Metadata only."}
        </div>
        <fieldset className="segmented">
          <legend>Decision</legend>
          {(["approved", "needs_review", "rejected"] as const).map((value) => (
            <label key={value}>
              <input
                type="radio"
                name={id + "-decision"}
                checked={decision === value}
                onChange={() => setDecision(value)}
              />
              {value.replace("_", " ")}
            </label>
          ))}
        </fieldset>
        <Field
          label="Why this decision"
          htmlFor={id + "-rationale"}
          hint="At least 20 characters. Learners see an approval's rationale as “why this helps”."
        >
          <textarea
            ref={first}
            id={id + "-rationale"}
            rows={3}
            minLength={20}
            maxLength={2000}
            required
            value={rationale}
            onChange={(e) => setRationale(e.target.value)}
          />
        </Field>
        {quotes.map((q, index) => (
          <div className="input-grid" key={index}>
            <Field
              label={`Exact quote ${index + 1}`}
              htmlFor={`${id}-quote-${index}`}
              hint="Copy text exactly from the inspected content (20–800 characters)."
            >
              <textarea
                id={`${id}-quote-${index}`}
                rows={2}
                maxLength={800}
                value={q.quote}
                onChange={(e) =>
                  setQuotes(
                    quotes.map((x, i) =>
                      i === index ? { ...x, quote: e.target.value } : x,
                    ),
                  )
                }
              />
            </Field>
            <Field
              label={`Why quote ${index + 1} matters`}
              htmlFor={`${id}-relevance-${index}`}
            >
              <textarea
                id={`${id}-relevance-${index}`}
                rows={2}
                maxLength={1000}
                value={q.relevance}
                onChange={(e) =>
                  setQuotes(
                    quotes.map((x, i) =>
                      i === index ? { ...x, relevance: e.target.value } : x,
                    ),
                  )
                }
              />
            </Field>
          </div>
        ))}
        {missing > 0 && (
          <Notice tone="gold">
            {missing} quote{missing === 1 ? " does" : "s do"} not appear exactly
            in the inspected text. The server will refuse an approval that cites
            it.
          </Notice>
        )}
        {quotes.length < 5 && (
          <Button
            type="button"
            kind="quiet"
            onClick={() => setQuotes([...quotes, { quote: "", relevance: "" }])}
          >
            <Plus size={16} aria-hidden="true" /> Add another quote
          </Button>
        )}
        <fieldset className="stack">
          <legend>Suitability</legend>
          {(
            [
              [
                "topicRelevant",
                "Relevant to the approved topic and episode objectives",
              ],
              [
                "accurateEnoughForUse",
                "Accurate enough to use (checked against the course's own material)",
              ],
              [
                "safeForAudience",
                "Safe and appropriate for the learner audience",
              ],
            ] as const
          ).map(([key, label]) => (
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
        <div className="input-grid">
          <Field label="Use" htmlFor={id + "-use"}>
            <select
              id={id + "-use"}
              value={use}
              onChange={(e) => setUse(e.target.value as typeof use)}
            >
              <option value="link_only">Link only</option>
              <option value="excerpt">Show reviewed excerpts</option>
              {inspection.youtube && (
                <option value="embed">Embedded player</option>
              )}
            </select>
          </Field>
          <Field label="Rights basis" htmlFor={id + "-basis"}>
            <select
              id={id + "-basis"}
              value={basis}
              onChange={(e) => setBasis(e.target.value as typeof basis)}
            >
              <option value="link_only">Link only</option>
              <option value="provider_embed">Provider embed terms</option>
              <option value="owned">Owned</option>
              <option value="licensed">Licensed</option>
              <option value="public_domain">Public domain</option>
            </select>
          </Field>
        </div>
        <Field label="Rights reference" htmlFor={id + "-reference"}>
          <input
            id={id + "-reference"}
            maxLength={1000}
            required
            value={reference}
            onChange={(e) => setReference(e.target.value)}
          />
        </Field>
        {inspection.kind === "youtube" && (
          <fieldset className="stack">
            <legend>Reviewed segment (optional)</legend>
            <p className="research-meta">
              <span>
                Only the part you actually watched. Learners' player starts and
                stops there. Leave empty if you did not watch a specific part; a
                title or description is never a segment.
              </span>
            </p>
            <div className="input-grid">
              <Field label="Start (seconds)" htmlFor={id + "-start"}>
                <input
                  id={id + "-start"}
                  type="number"
                  min={0}
                  max={86399}
                  step={1}
                  inputMode="numeric"
                  value={segment.start}
                  onChange={(e) =>
                    setSegment({ ...segment, start: e.target.value })
                  }
                />
              </Field>
              <Field label="End (seconds)" htmlFor={id + "-end"}>
                <input
                  id={id + "-end"}
                  type="number"
                  min={1}
                  max={86400}
                  step={1}
                  inputMode="numeric"
                  value={segment.end}
                  onChange={(e) =>
                    setSegment({ ...segment, end: e.target.value })
                  }
                />
              </Field>
            </div>
            {segmentValue &&
              !(segmentValue.endSeconds > segmentValue.startSeconds) && (
                <Notice tone="gold">The end must come after the start.</Notice>
              )}
          </fieldset>
        )}
        {inspection.truncated && (
          <label className="check-label">
            <input
              type="checkbox"
              checked={truncation}
              onChange={(e) => setTruncation(e.target.checked)}
            />
            I reviewed knowing the inspected text was truncated.
          </label>
        )}
        <div className="tag-row">
          <Button kind="primary" type="submit" disabled={pending}>
            Record review
          </Button>
          <Button type="button" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function AttachDialog({
  episodes,
  maxExpiry,
  pending,
  onClose,
  onSubmit,
}: {
  episodes: { id: string; title: string }[];
  maxExpiry: string;
  pending: boolean;
  onClose: () => void;
  onSubmit: (input: { episodeId: string; expiresAt: string }) => void;
}) {
  const id = useId();
  const maxDays = Math.max(
    1,
    Math.floor((Date.parse(maxExpiry) - Date.now()) / DAY),
  );
  const [episodeId, setEpisodeId] = useState(episodes[0]?.id ?? "");
  const [days, setDays] = useState(Math.min(30, maxDays));
  return (
    <Dialog title="Attach as optional help" onClose={onClose} pending={pending}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit({ episodeId, expiresAt: isoAfterDays(days) });
        }}
      >
        <p>
          Learners in this release see the resource as optional help in the
          chosen episode. It never unlocks progress or records mastery.
        </p>
        <Field label="Episode" htmlFor={id + "-episode"}>
          <select
            id={id + "-episode"}
            value={episodeId}
            onChange={(e) => setEpisodeId(e.target.value)}
          >
            {episodes.map((e) => (
              <option key={e.id} value={e.id}>
                {e.title}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Show for (days)"
          htmlFor={id + "-days"}
          hint={`At most ${maxDays} day(s), the source approval's remaining life.`}
        >
          <input
            id={id + "-days"}
            type="number"
            min={1}
            max={maxDays}
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
          />
        </Field>
        <div className="tag-row">
          <Button kind="primary" type="submit" disabled={pending || !episodeId}>
            <BookMarked size={16} aria-hidden="true" /> Attach resource
          </Button>
          <Button type="button" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function RevokeDialog({
  pending,
  onClose,
  onSubmit,
}: {
  pending: boolean;
  onClose: () => void;
  onSubmit: (reason: string) => void;
}) {
  const id = useId();
  const [reason, setReason] = useState("");
  return (
    <Dialog
      title="Revoke attached resource"
      onClose={onClose}
      pending={pending}
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(reason.trim());
        }}
      >
        <Field
          label="Reason"
          htmlFor={id + "-reason"}
          hint="10–1000 characters. Kept in the audit history."
        >
          <textarea
            id={id + "-reason"}
            rows={3}
            minLength={10}
            maxLength={1000}
            required
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </Field>
        <div className="tag-row">
          <Button kind="danger" type="submit" disabled={pending}>
            Revoke
          </Button>
          <Button type="button" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
