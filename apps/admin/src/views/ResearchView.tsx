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
} from "../components/ui";
import { randomId } from "../domain/webCrypto";
import { isolate } from "@course-core/i18n";
import { useFormatters, useI18n, useT } from "../i18n";

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
type Decision = ReviewInput["decision"];
const decisionTone = {
  approved: "green",
  rejected: "red",
  needs_review: "gold",
} as const;
/** A source's state as a machine code (`researchView.state.<code>`) and its badge tone. */
function sourceState(source: ResearchSource) {
  if (source.expired) return { code: "expired", tone: "neutral" } as const;
  const latest = source.reviews[0];
  if (latest)
    return {
      code: latest.decision,
      tone:
        latest.decision === "needs_review"
          ? "neutral"
          : decisionTone[latest.decision],
    } as const;
  if (source.inspections.length)
    return { code: "inspected", tone: "neutral" } as const;
  return source.failures.length
    ? ({ code: "failed", tone: "red" } as const)
    : ({ code: "notInspected", tone: "neutral" } as const);
}

export function ResearchView({
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
  if (!client.research)
    return (
      <Card title={t("researchView.title")}>
        <EmptyState title={t("researchView.unavailable.title")}>
          {t("researchView.unavailable.body")}
        </EmptyState>
      </Card>
    );
  if (!releaseId)
    return (
      <Card title={t("researchView.title")}>
        <EmptyState title={t("researchView.noRelease.title")}>
          {t("researchView.noRelease.body")}
        </EmptyState>
      </Card>
    );
  return (
    <div className="page-stack">
      <Notice tone="blue" title={t("researchView.untrusted.title")}>
        {t("researchView.untrusted.body")}
      </Notice>
      {published.length > 1 && (
        <div className="field">
          <label htmlFor="research-release">
            {t("researchView.release.label")}
          </label>
          <select
            id="research-release"
            value={releaseId}
            onChange={(e) => setReleaseId(e.target.value)}
          >
            {published.map((r) => (
              <option key={r.id} value={r.id}>
                {t(
                  r.availableForNewLearners
                    ? "researchView.release.optionNew"
                    : "researchView.release.option",
                  { version: r.version },
                )}
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
        workspaceId={data.course.workspaceId}
      />
    </div>
  );
}

/** Today's YouTube quota and a one-unit key check, so a live search never fails by surprise. */
function YouTubeStatusCard({
  port,
  workspaceId,
  canCheck,
  refresh,
}: {
  port: Port;
  workspaceId: string;
  canCheck: boolean;
  /** Changes after each saved search, so the counts follow it. */
  refresh: unknown;
}) {
  const t = useT();
  const { when } = useFormatters();
  const status = useRemote(
    (signal) => port.youtubeStatus!(workspaceId, signal),
    [port, workspaceId, refresh],
  );
  const [check, setCheck] = useState<{
    ok?: boolean;
    error?: unknown;
    pending?: boolean;
  }>({});
  if (!status.data) return null;
  const s = status.data;
  return (
    <Card eyebrow={t("researchView.youtube.status.title")}>
      {!s.configured ? (
        <p>{t("researchView.youtube.status.notConfigured")}</p>
      ) : (
        <>
          <p>
            {t("researchView.youtube.status.usage", {
              searches: s.searches.used,
              searchLimit: s.searches.limit,
              units: s.units.used,
              unitLimit: s.units.limit,
              when: when(s.resetsAt),
            })}
          </p>
          {s.exhaustedByProvider && (
            <Notice tone="gold">
              {t("researchView.youtube.status.exhausted", {
                when: when(s.resetsAt),
              })}
            </Notice>
          )}
          {canCheck && (
            <div className="media-estimate" aria-live="polite">
              <Button
                disabled={check.pending}
                onClick={async () => {
                  setCheck({ pending: true });
                  try {
                    await port.youtubeCheck!(workspaceId);
                    setCheck({ ok: true });
                  } catch (error) {
                    setCheck({ error });
                  }
                  status.reload();
                }}
              >
                {t("researchView.youtube.status.check")}
              </Button>
              <p className="media-hint">
                {t("researchView.youtube.status.checkHint")}
              </p>
              {check.ok && (
                <Notice tone="green">
                  {t("researchView.youtube.status.ok")}
                </Notice>
              )}
              {check.error !== undefined && (
                <Notice tone="red">
                  {researchErrorMessage(check.error, t, when)}
                </Notice>
              )}
            </div>
          )}
        </>
      )}
    </Card>
  );
}

function ReleaseResearch({
  port,
  releaseId,
  permissions,
  workspaceId,
}: {
  port: Port;
  releaseId: string;
  permissions: CourseWorkspace["permissions"];
  workspaceId?: string | undefined;
}) {
  const t = useT();
  const { when } = useFormatters();
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
  if (library.loading) return <Loading label={t("researchView.loading")} />;
  if (library.error || !library.data)
    return <Notice tone="red">{researchErrorMessage(library.error, t)}</Notice>;
  const lib = library.data;
  const canWrite = permissions.includes("course.write"),
    canReview = permissions.includes("release.review"),
    canPublish = permissions.includes("release.publish");
  const episodeTitle = (id: string) =>
    lib.topics.flatMap((x) => x.episodes).find((e) => e.id === id)?.title ?? id;
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
          <Notice tone="red">
            {researchErrorMessage(command.error, t, when)}
          </Notice>
        )}
      </div>
      {port.youtubeStatus && workspaceId && (
        <YouTubeStatusCard
          port={port}
          workspaceId={workspaceId}
          canCheck={permissions.includes("provider.configure")}
          refresh={command.message ?? command.error}
        />
      )}
      {lib.topics.length === 0 && (
        <Card title={t("researchView.topics.title")}>
          <EmptyState title={t("researchView.topics.empty.title")}>
            {t("researchView.topics.empty.body")}
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
            eyebrow={t("researchView.topic.eyebrow")}
            title={isolate(topic.queryText)}
            actions={
              <>
                {port.youtubeSearch && (
                  <Button
                    disabled={!canWrite || command.pending}
                    onClick={() =>
                      void command.run(
                        "youtube-search:" + topic.id + ":" + Date.now(),
                        () => port.youtubeSearch!(releaseId, topic.id),
                        t("researchView.youtube.saved"),
                      )
                    }
                  >
                    <Search size={16} aria-hidden="true" />{" "}
                    {t("researchView.youtube.search")}
                  </Button>
                )}
                <Button
                  disabled={!canWrite || command.pending}
                  onClick={() => setAdding({ topic })}
                >
                  <Plus size={16} aria-hidden="true" />{" "}
                  {t("researchView.source.add")}
                </Button>
              </>
            }
          >
            <PermissionHint permissions={permissions} required="course.write" />
            <p className="research-meta">
              <span>
                {topic.episodes.length
                  ? t("researchView.topic.episodes", {
                      episodes: topic.episodes.map((e) => e.title).join(", "),
                    })
                  : t("researchView.topic.episodesNone")}
              </span>
              <span>
                {topic.allowedDomains.length
                  ? t("researchView.topic.domains", {
                      domains: topic.allowedDomains.join(", "),
                    })
                  : t("researchView.topic.domainsAny")}
              </span>
            </p>
            {topicSuggestions.length > 0 && (
              <details className="research-suggestions">
                <summary>
                  {t("researchView.suggestions.summary", {
                    count: topicSuggestions.length,
                  })}
                </summary>
                <ul>
                  {topicSuggestions.slice(0, 10).map((s) => (
                    <li key={s.uri}>
                      <span className="grow">
                        <strong dir="auto">
                          {s.title || t("researchView.suggestion.untitled")}
                        </strong>
                        <small className="mono" dir="ltr">
                          {s.uri}
                        </small>
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
                        {t("researchView.suggestion.use")}
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
                    {t("researchView.youtube.summary", {
                      count: latest.hits.length,
                    })}
                  </summary>
                  <p className="research-meta">
                    <span>
                      {t("researchView.youtube.searched", {
                        when: when(latest.createdAt),
                        query: latest.sent.q,
                      })}
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
                            <strong dir="auto">{hit.title}</strong>
                            <small>
                              <bdi>{hit.channelTitle}</bdi>
                              {hit.durationSeconds !== null && (
                                <>
                                  {" · "}
                                  <span dir="ltr">
                                    {clock(hit.durationSeconds)}
                                  </span>
                                </>
                              )}
                              {" · "}
                              {hit.captions === "creator_captions"
                                ? t("researchView.captions")
                                : t("researchView.captionsUnknown")}
                              {hit.embeddable === false &&
                                ` · ${t("researchView.hit.noEmbed")}`}
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
                            {added
                              ? t("researchView.hit.added")
                              : t("researchView.suggestion.use")}
                          </Button>
                        </li>
                      );
                    })}
                  </ul>
                </details>
              );
            })()}
            {sources.length === 0 ? (
              <p className="research-empty">
                {t("researchView.sources.empty")}
              </p>
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
                        t("researchView.inspect.saved"),
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
              t("researchView.source.added"),
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
              t("researchView.review.recorded", {
                decision: t(`researchView.decision.${input.decision}`),
              }),
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
              t("researchView.attach.done"),
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
              t("researchView.revoke.done"),
            );
            if (ok) setRevoking(undefined);
          }}
        />
      )}
      <Card
        title={t("researchView.delivered.title")}
        eyebrow={t("researchView.delivered.eyebrow")}
      >
        <PermissionHint permissions={permissions} required="release.review" />
        {lib.attachments.length === 0 ? (
          <p className="research-empty">{t("researchView.delivered.empty")}</p>
        ) : (
          <div
            className="table-wrap"
            // Contains the visually hidden caption and header text; without a positioned
            // ancestor they escape the scroll box and widen the page on phones.
            style={{ position: "relative" }}
          >
            <table>
              <caption className="sr-only">
                {t("researchView.delivered.caption")}
              </caption>
              <thead>
                <tr>
                  <th scope="col">{t("researchView.col.source")}</th>
                  <th scope="col">{t("researchView.col.episode")}</th>
                  <th scope="col">{t("researchView.col.state")}</th>
                  <th scope="col">{t("researchView.col.expires")}</th>
                  <th scope="col">
                    <span className="sr-only">
                      {t("researchView.col.actions")}
                    </span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {lib.attachments.map((a) => {
                  const source = lib.sources.find((s) => s.id === a.sourceId);
                  return (
                    <tr key={a.id}>
                      <td
                        className="research-url"
                        dir={source?.inspections[0]?.title ? "auto" : "ltr"}
                      >
                        {source?.inspections[0]?.title ??
                          source?.url ??
                          a.sourceId}
                      </td>
                      <td dir="auto">{episodeTitle(a.episodeId)}</td>
                      <td>
                        <Badge>{t(`researchView.attachment.${a.state}`)}</Badge>
                        {a.revokeReason && (
                          <small>
                            {" "}
                            <bdi>{a.revokeReason}</bdi>
                          </small>
                        )}
                      </td>
                      <td>{when(a.expiresAt)}</td>
                      <td>
                        {a.state === "active" && (
                          <Button
                            kind="danger"
                            disabled={!canReview || command.pending}
                            onClick={() => setRevoking(a.id)}
                          >
                            <CircleSlash size={16} aria-hidden="true" />{" "}
                            {t("researchView.revoke.button")}
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
  const t = useT();
  const { when } = useFormatters();
  const state = sourceState(source);
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
            {inspection
              ? t("researchView.source.heading", {
                  kind: source.kind,
                  title: inspection.title,
                })
              : t("researchView.source.headingUninspected", {
                  kind: source.kind,
                })}
          </strong>
          <a
            className="mono research-url"
            dir="ltr"
            href={source.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            {source.url}
            <ExternalLink size={13} aria-hidden="true" />
            <span className="sr-only"> {t("researchView.newTab")}</span>
          </a>
        </span>
        <Badge tone={state.tone}>{t(`researchView.state.${state.code}`)}</Badge>
      </div>
      <small>
        {source.kind === "youtube" && source.durationSeconds != null && (
          <>
            <span dir="ltr">{clock(source.durationSeconds)}</span>
            {" · "}
          </>
        )}
        {source.kind === "youtube" &&
          source.captions &&
          `${
            source.captions === "creator_captions"
              ? t("researchView.captions")
              : t("researchView.captionsUnknown")
          } · `}
        {t("researchView.source.expires", { when: when(source.expiresAt) })}
        {live.length > 0 &&
          ` · ${t("researchView.source.delivered", { count: live.length })}`}
      </small>
      {source.failures[0] && !inspection && (
        <p className="research-failure">
          {t("researchView.source.failed", {
            reason: source.failures[0].code.replaceAll("_", " ").toLowerCase(),
            when: when(source.failures[0].createdAt),
          })}
        </p>
      )}
      {inspection && (
        <details className="research-inspection">
          <summary>
            {t(
              inspection.truncated
                ? "researchView.inspection.summaryTruncated"
                : "researchView.inspection.summary",
              {
                when: when(inspection.createdAt),
                basis: t(`researchView.inspectionBasis.${inspection.basis}`),
              },
            )}
          </summary>
          <dl className="facts vertical">
            <div>
              <dt>{t("researchView.inspection.finalAddress")}</dt>
              <dd className="mono" dir="ltr">
                {inspection.finalUrl}
              </dd>
            </div>
            <div>
              <dt>{t("researchView.inspection.attribution")}</dt>
              <dd dir="auto">
                {inspection.attributions
                  .map((a) =>
                    [a.providerName, a.authorName].filter(Boolean).join(" — "),
                  )
                  .join("; ") || t("researchView.inspection.attributionNone")}
              </dd>
            </div>
            <div>
              <dt>{t("researchView.inspection.digest")}</dt>
              <dd className="mono" dir="ltr">
                {inspection.contentDigest.slice(0, 16)}…
              </dd>
            </div>
          </dl>
          <div
            className="research-text"
            tabIndex={0}
            role="region"
            aria-label={t("researchView.inspection.textRegion")}
            dir={inspection.text ? "auto" : undefined}
          >
            {inspection.text || t("researchView.inspection.noText")}
          </div>
        </details>
      )}
      {latestReview && (
        <p className="research-review">
          <Badge tone={decisionTone[latestReview.decision]}>
            {t(`researchView.decision.${latestReview.decision}`)}
          </Badge>{" "}
          <bdi>{latestReview.rationale}</bdi>
          {latestReview.segment &&
            ` ${t("researchView.latest.segment", {
              start: clock(latestReview.segment.startSeconds),
              end: clock(latestReview.segment.endSeconds),
            })}`}
          {!reviewedLatest && ` ${t("researchView.latest.earlier")}`}
        </p>
      )}
      <div className="tag-row">
        <Button
          disabled={!canWrite || pending || source.expired}
          onClick={onInspect}
        >
          <ScanText size={16} aria-hidden="true" />
          {inspection
            ? t("researchView.inspect.again")
            : t("researchView.inspect.now")}
        </Button>
        {inspection && (
          <Button
            disabled={!canReview || pending || source.expired}
            onClick={() => onReview(inspection)}
          >
            <FileSearch size={16} aria-hidden="true" />{" "}
            {t("researchView.review.open")}
          </Button>
        )}
        {latestReview?.decision === "approved" && (
          <Button
            kind="primary"
            disabled={!canPublish || pending || source.expired}
            onClick={() => onAttach(latestReview.id)}
          >
            <Link2 size={16} aria-hidden="true" />{" "}
            {t("researchView.attach.open")}
          </Button>
        )}
        {live.map((a) => (
          <Button
            key={a.id}
            kind="quiet"
            disabled={!canReview || pending}
            onClick={() => onRevoke(a.id)}
          >
            {t("researchView.revoke.from", {
              episode: episodeTitle(a.episodeId),
            })}
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
  const t = useT();
  const i18n = useI18n();
  const id = useId();
  const [kind, setKind] = useState<"web" | "youtube">(
    initialUrl && /youtu\.?be/.test(initialUrl) ? "youtube" : "web",
  );
  const [url, setUrl] = useState(initialUrl ?? "");
  const [fallback, setFallback] = useState("");
  const [days, setDays] = useState(90);
  return (
    <Dialog
      title={t("researchView.add.title")}
      onClose={onClose}
      pending={pending}
    >
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
          {i18n.rich(
            "researchView.add.intro",
            { topic: topic.queryText },
            {
              strong: (children, key) => (
                <strong key={key} dir="auto">
                  {children}
                </strong>
              ),
            },
          )}
        </p>
        <fieldset className="segmented">
          <legend>{t("researchView.add.kind")}</legend>
          {(["web", "youtube"] as const).map((value) => (
            <label key={value}>
              <input
                type="radio"
                name={id + "-kind"}
                checked={kind === value}
                onChange={() => setKind(value)}
              />
              {value === "web"
                ? t("researchView.add.kindWeb")
                : t("researchView.add.kindYoutube")}
            </label>
          ))}
        </fieldset>
        <Field
          label={t("researchView.add.url")}
          htmlFor={id + "-url"}
          hint={
            topic.allowedDomains.length
              ? t("researchView.add.urlDomains", {
                  domains: topic.allowedDomains.join(", "),
                })
              : t("researchView.add.urlHint")
          }
        >
          <input
            id={id + "-url"}
            dir="ltr"
            type="url"
            required
            maxLength={2048}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </Field>
        {kind === "youtube" && (
          <Field
            label={t("researchView.add.fallback")}
            htmlFor={id + "-fallback"}
            hint={t("researchView.add.fallbackHint")}
          >
            <textarea
              id={id + "-fallback"}
              dir="auto"
              rows={4}
              maxLength={10000}
              value={fallback}
              onChange={(e) => setFallback(e.target.value)}
            />
          </Field>
        )}
        <Field
          label={t("researchView.add.days")}
          htmlFor={id + "-days"}
          hint={t("researchView.add.daysHint")}
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
            {t("researchView.source.add")}
          </Button>
          <Button type="button" onClick={onClose} disabled={pending}>
            {t("researchView.cancel")}
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
  const t = useT();
  const id = useId();
  const [decision, setDecision] = useState<Decision>("approved");
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
      ? t("researchView.review.referenceEmbed")
      : t("researchView.review.referenceLink"),
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
      title={t("researchView.review.title")}
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
          aria-label={t("researchView.review.textRegion")}
          dir={inspection.text ? "auto" : undefined}
        >
          {inspection.text || t("researchView.inspection.noText")}
        </div>
        <fieldset className="segmented">
          <legend>{t("researchView.review.decision")}</legend>
          {(["approved", "needs_review", "rejected"] as const).map((value) => (
            <label key={value}>
              <input
                type="radio"
                name={id + "-decision"}
                checked={decision === value}
                onChange={() => setDecision(value)}
              />
              {t(`researchView.decision.${value}`)}
            </label>
          ))}
        </fieldset>
        <Field
          label={t("researchView.review.rationale")}
          htmlFor={id + "-rationale"}
          hint={t("researchView.review.rationaleHint")}
        >
          <textarea
            ref={first}
            id={id + "-rationale"}
            dir="auto"
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
              label={t("researchView.review.quote", { n: index + 1 })}
              htmlFor={`${id}-quote-${index}`}
              hint={t("researchView.review.quoteHint")}
            >
              <textarea
                id={`${id}-quote-${index}`}
                dir="auto"
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
              label={t("researchView.review.relevance", { n: index + 1 })}
              htmlFor={`${id}-relevance-${index}`}
            >
              <textarea
                id={`${id}-relevance-${index}`}
                dir="auto"
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
            {t("researchView.review.missing", { count: missing })}
          </Notice>
        )}
        {quotes.length < 5 && (
          <Button
            type="button"
            kind="quiet"
            onClick={() => setQuotes([...quotes, { quote: "", relevance: "" }])}
          >
            <Plus size={16} aria-hidden="true" />{" "}
            {t("researchView.review.addQuote")}
          </Button>
        )}
        <fieldset className="stack">
          <legend>{t("researchView.review.suitability")}</legend>
          {(
            [
              "topicRelevant",
              "accurateEnoughForUse",
              "safeForAudience",
            ] as const
          ).map((key) => (
            <label className="check-label" key={key}>
              <input
                type="checkbox"
                checked={checks[key]}
                onChange={(e) =>
                  setChecks({ ...checks, [key]: e.target.checked })
                }
              />
              {t(`researchView.check.${key}`)}
            </label>
          ))}
        </fieldset>
        <div className="input-grid">
          <Field label={t("researchView.review.use")} htmlFor={id + "-use"}>
            <select
              id={id + "-use"}
              value={use}
              onChange={(e) => setUse(e.target.value as typeof use)}
            >
              <option value="link_only">
                {t("researchView.use.link_only")}
              </option>
              <option value="excerpt">{t("researchView.use.excerpt")}</option>
              {inspection.youtube && (
                <option value="embed">{t("researchView.use.embed")}</option>
              )}
            </select>
          </Field>
          <Field label={t("researchView.review.basis")} htmlFor={id + "-basis"}>
            <select
              id={id + "-basis"}
              value={basis}
              onChange={(e) => setBasis(e.target.value as typeof basis)}
            >
              {(
                [
                  "link_only",
                  "provider_embed",
                  "owned",
                  "licensed",
                  "public_domain",
                ] as const
              ).map((value) => (
                <option key={value} value={value}>
                  {t(`researchView.rights.${value}`)}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field
          label={t("researchView.review.reference")}
          htmlFor={id + "-reference"}
        >
          <input
            id={id + "-reference"}
            dir="auto"
            maxLength={1000}
            required
            value={reference}
            onChange={(e) => setReference(e.target.value)}
          />
        </Field>
        {inspection.kind === "youtube" && (
          <fieldset className="stack">
            <legend>{t("researchView.segment.legend")}</legend>
            <p className="research-meta">
              <span>{t("researchView.segment.help")}</span>
            </p>
            <div className="input-grid">
              <Field
                label={t("researchView.segment.start")}
                htmlFor={id + "-start"}
              >
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
              <Field
                label={t("researchView.segment.end")}
                htmlFor={id + "-end"}
              >
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
                <Notice tone="gold">{t("researchView.segment.order")}</Notice>
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
            {t("researchView.review.truncation")}
          </label>
        )}
        <div className="tag-row">
          <Button kind="primary" type="submit" disabled={pending}>
            {t("researchView.review.submit")}
          </Button>
          <Button type="button" onClick={onClose} disabled={pending}>
            {t("researchView.cancel")}
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
  const t = useT();
  const id = useId();
  const maxDays = Math.max(
    1,
    Math.floor((Date.parse(maxExpiry) - Date.now()) / DAY),
  );
  const [episodeId, setEpisodeId] = useState(episodes[0]?.id ?? "");
  const [days, setDays] = useState(Math.min(30, maxDays));
  return (
    <Dialog
      title={t("researchView.attach.title")}
      onClose={onClose}
      pending={pending}
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit({ episodeId, expiresAt: isoAfterDays(days) });
        }}
      >
        <p>{t("researchView.attach.intro")}</p>
        <Field
          label={t("researchView.attach.episode")}
          htmlFor={id + "-episode"}
        >
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
          label={t("researchView.attach.days")}
          htmlFor={id + "-days"}
          hint={t("researchView.attach.daysHint", { max: maxDays })}
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
            <BookMarked size={16} aria-hidden="true" />{" "}
            {t("researchView.attach.submit")}
          </Button>
          <Button type="button" onClick={onClose} disabled={pending}>
            {t("researchView.cancel")}
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
  const t = useT();
  const id = useId();
  const [reason, setReason] = useState("");
  return (
    <Dialog
      title={t("researchView.revoke.title")}
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
          label={t("researchView.revoke.reason")}
          htmlFor={id + "-reason"}
          hint={t("researchView.revoke.reasonHint")}
        >
          <textarea
            id={id + "-reason"}
            dir="auto"
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
            {t("researchView.revoke.button")}
          </Button>
          <Button type="button" onClick={onClose} disabled={pending}>
            {t("researchView.cancel")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
