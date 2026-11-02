import type { AdminClient, CourseWorkspace } from "../domain/contracts";
import { overviewErrorMessage, type CourseOverview } from "../domain/overview";
import { releaseCheckText } from "../domain/releaseChecks";
import { useRemote } from "../hooks/useAdmin";
import {
  Badge,
  Card,
  EmptyState,
  Notice,
  Stat,
  SkeletonRows,
} from "../components/ui";
import { useFormatters, useI18n, useT, type MessageKey } from "../i18n";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ChevronRight } from "lucide-react";
import {
  activeNeedingCheck,
  type AiServicesPort,
  type EvalStatus,
  type QualityStatus,
} from "../domain/aiServices";
import { RoleChecks } from "../components/aiServices/CheckSection";
import "../components/aiServices/aiServices.css";
import "./workspacePages.css";

/** The workspace pages the overview's figures and queues open. */
export type OverviewTarget =
  "course" | "learners" | "reviews" | "media" | "providers" | "runs";
const queueTargets: Record<
  keyof CourseOverview["approvalQueue"],
  OverviewTarget
> = {
  writtenAnswers: "reviews",
  secondOpinions: "reviews",
  gateReviews: "reviews",
  generatedMedia: "media",
  releases: "course",
  providerRequests: "providers",
};

/** A figure on the overview; with `onOpen` the whole tile opens the page behind the figure. */
function OverviewStat({
  label,
  value,
  detail,
  onOpen,
  openLabel,
}: {
  label: string;
  value: ReactNode;
  detail: string;
  onOpen?: (() => void) | undefined;
  openLabel: string;
}) {
  if (!onOpen) return <Stat label={label} value={value} detail={detail} />;
  return (
    <button
      type="button"
      className="stat stat-link"
      onClick={onOpen}
      title={openLabel}
    >
      <span className="stat-label">{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
      <ChevronRight
        size={16}
        className="stat-arrow flip-rtl"
        aria-hidden="true"
      />
    </button>
  );
}

/** One count in a list: the row opens its page when it can; a zero is quiet. */
export function CountRow({
  label,
  count,
  tone = "gold",
  onOpen,
}: {
  label: ReactNode;
  count: number;
  tone?: "gold" | "red" | "neutral";
  onOpen?: (() => void) | undefined;
}) {
  const i18n = useI18n();
  const body = (
    <>
      <span className="count-row-label">{label}</span>
      <span className={`count-row-value${count ? "" : " zero"}`}>
        {count ? (
          <Badge tone={tone}>{i18n.number(count)}</Badge>
        ) : (
          i18n.number(count)
        )}
      </span>
    </>
  );
  return (
    <li>
      {onOpen ? (
        <button type="button" className="count-row" onClick={onOpen}>
          {body}
          <ChevronRight size={15} className="flip-rtl" aria-hidden="true" />
        </button>
      ) : (
        <div className="count-row">{body}</div>
      )}
    </li>
  );
}

export const queueKeys: Record<
  keyof CourseOverview["approvalQueue"],
  MessageKey
> = {
  writtenAnswers: "overviewView.queue.writtenAnswers",
  secondOpinions: "overviewView.queue.secondOpinions",
  gateReviews: "overviewView.queue.gateReviews",
  generatedMedia: "overviewView.queue.generatedMedia",
  releases: "overviewView.queue.releases",
  providerRequests: "overviewView.queue.providerRequests",
};

/** What needs attention on this course: counts only, nothing learner-private. */
export function OverviewView({
  data,
  client,
  onOpenView,
}: {
  data: CourseWorkspace;
  client: AdminClient;
  /** Opens another page (the queues and figures link to theirs). */
  onOpenView?: (view: OverviewTarget) => void;
}) {
  const t = useT();
  if (!client.overview)
    return (
      <Card title={t("overviewView.title")}>
        <EmptyState title={t("overviewView.unavailable.title")}>
          {t("overviewView.unavailable.body")}
        </EmptyState>
      </Card>
    );
  return (
    <Overview
      port={client.overview}
      catalogId={data.course.id}
      onOpenView={onOpenView}
    />
  );
}

/**
 * AI jobs that are on but have no passing check or approval for the current checks (for example
 * after an upgrade), each flagged with its own "Run check". They keep working; nothing here turns
 * them off. Shown to people who can set up AI services; hidden when there is nothing to flag or
 * the status can't be read (the AI services page says why).
 */
export function AiChecks({
  port,
  workspaceId,
  onOpen,
}: {
  port: AiServicesPort;
  workspaceId: string;
  onOpen?: (() => void) | undefined;
}) {
  const t = useT();
  const [status, setStatus] = useState<{
    evals: EvalStatus;
    quality: QualityStatus;
  } | null>(null);
  // Whether anything was flagged while the page was open: the card then stays to say it's done.
  const [flagged, setFlagged] = useState(false);
  const live = useRef(true);
  const load = useCallback(async () => {
    try {
      const evals = await port.evals(workspaceId);
      const quality = await port.qualityStatus(workspaceId);
      if (!live.current) return;
      setStatus({ evals, quality });
      if (activeNeedingCheck(evals).length) setFlagged(true);
    } catch {
      // Kept as it was: the AI services page explains a status it can't read.
    }
  }, [port, workspaceId]);
  useEffect(() => {
    live.current = true;
    void load();
    return () => {
      live.current = false;
    };
  }, [load]);
  const needing = activeNeedingCheck(status?.evals ?? null);
  if (!status || !flagged) return null;
  return (
    <Card title={t("overviewView.aiChecks.title")}>
      <div className="page-stack" data-testid="overview-ai-checks">
        {needing.length ? (
          <Notice tone="gold">
            {t("overviewView.aiChecks.body", { count: needing.length })}
          </Notice>
        ) : (
          <Notice tone="green">{t("overviewView.aiChecks.cleared")}</Notice>
        )}
        <RoleChecks
          port={port}
          workspaceId={workspaceId}
          needing={needing}
          quality={status.quality}
          service=""
          onChanged={load}
        />
        {onOpen && (
          <div>
            <button type="button" className="button" onClick={onOpen}>
              {t("overviewView.aiChecks.open")}
            </button>
          </div>
        )}
      </div>
    </Card>
  );
}

function Overview({
  port,
  catalogId,
  onOpenView,
}: {
  port: NonNullable<AdminClient["overview"]>;
  catalogId: string;
  onOpenView?: ((view: OverviewTarget) => void) | undefined;
}) {
  const overview = useRemote(
    (signal) => port.load(catalogId, signal),
    [port, catalogId],
  );
  const t = useT();
  const i18n = useI18n();
  const { when } = useFormatters();
  if (overview.loading)
    return <SkeletonRows label={t("overviewView.loading")} rows={6} />;
  if (overview.error || !overview.data)
    return (
      <Notice tone="red">{overviewErrorMessage(overview.error, t)}</Notice>
    );
  const o = overview.data;
  /** A server state shown by its label; an unknown state shows its code. */
  const label = (key: string, fallback: string) =>
    i18n.has(key as MessageKey) ? t(key as MessageKey) : fallback;
  const waiting = Object.values(o.approvalQueue).reduce((a, b) => a + b, 0);
  const defects = o.contentDefects.activeReleaseChecksFailing.length;
  const opener = (view: OverviewTarget) =>
    onOpenView ? () => onOpenView(view) : undefined;
  const openLabel = (view: OverviewTarget) =>
    t("overviewView.open", { page: t(`adminApp.nav.${view}` as MessageKey) });
  return (
    <div className="page-stack">
      <div className="stats-grid">
        <OverviewStat
          label={t("overviewView.stat.liveRelease")}
          value={
            o.release.active ? (
              <span dir="ltr">{o.release.active.version}</span>
            ) : (
              t("overviewView.stat.noRelease")
            )
          }
          detail={
            o.release.active
              ? t("overviewView.stat.publishedAt", {
                  date: when(o.release.active.createdAt),
                })
              : t("overviewView.stat.noReleaseDetail")
          }
          onOpen={opener("course")}
          openLabel={openLabel("course")}
        />
        <OverviewStat
          label={t("overviewView.stat.waiting")}
          value={i18n.number(waiting)}
          detail={t("overviewView.stat.waitingDetail")}
          onOpen={opener("reviews")}
          openLabel={openLabel("reviews")}
        />
        <OverviewStat
          label={t("overviewView.stat.deadlineRisks")}
          value={o.deadlineRisks ? i18n.number(o.deadlineRisks.length) : "—"}
          detail={
            o.deadlineRisks
              ? t("overviewView.stat.deadlineRisksDetail")
              : t("overviewView.stat.notVisible")
          }
          onOpen={o.deadlineRisks ? opener("learners") : undefined}
          openLabel={openLabel("learners")}
        />
        <OverviewStat
          label={t("overviewView.stat.contentDefects")}
          value={i18n.number(defects)}
          detail={t("overviewView.stat.invalidated", {
            count: o.contentDefects.evidenceInvalidatedLast30Days,
          })}
          onOpen={opener("course")}
          openLabel={openLabel("course")}
        />
      </div>
      <Card title={t("overviewView.queue.title")}>
        <ul className="count-list">
          {(Object.keys(queueKeys) as (keyof typeof queueKeys)[]).map((key) => (
            <CountRow
              key={key}
              label={t(queueKeys[key])}
              count={o.approvalQueue[key]}
              onOpen={opener(queueTargets[key])}
            />
          ))}
        </ul>
      </Card>
      <Card title={t("overviewView.releases.title")}>
        {o.release.update?.availableVersion && (
          <Notice tone="gold" title={t("overviewView.releases.updateTitle")}>
            {t("overviewView.releases.updateBody", {
              version: o.release.update.availableVersion,
            })}
          </Notice>
        )}
        <p>
          {t("overviewView.releases.counts", {
            published: o.release.counts.published,
            draft: o.release.counts.draft,
            archived: o.release.counts.archived,
          })}
        </p>
        {o.release.pinnedLearners.length > 0 && (
          <ul className="count-list">
            {o.release.pinnedLearners.map((p) => (
              <CountRow
                key={p.releaseId}
                tone="neutral"
                label={
                  p.version
                    ? t("overviewView.releases.pinned", { version: p.version })
                    : t("overviewView.releases.pinnedUnknown")
                }
                count={p.learners}
                onOpen={opener("learners")}
              />
            ))}
          </ul>
        )}
        {o.lifecycle && (
          <ul
            className="count-list"
            aria-label={t("overviewView.lifecycle.label")}
          >
            {Object.entries(o.lifecycle).map(([state, n]) => (
              <CountRow
                key={state}
                tone="neutral"
                label={label(`overviewView.lifecycle.state.${state}`, state)}
                count={n}
              />
            ))}
          </ul>
        )}
      </Card>
      {o.deadlineRisks && (
        <Card title={t("overviewView.risks.title")}>
          {o.deadlineRisks.length === 0 ? (
            <EmptyState title={t("overviewView.risks.empty.title")}>
              {t("overviewView.risks.empty.body")}
            </EmptyState>
          ) : (
            <ul className="overview-list">
              {o.deadlineRisks.map((r) => (
                <li key={r.enrollmentId}>
                  <span>
                    {t("overviewView.risks.item", {
                      learner: r.learner,
                      count: r.remainingEpisodes,
                      date: when(r.deadline),
                    })}
                  </span>
                  <Badge tone={r.daysLeft < 0 ? "red" : "gold"}>
                    {r.daysLeft < 0
                      ? t("overviewView.risks.overdue")
                      : t("overviewView.risks.days", { count: r.daysLeft })}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
      {defects > 0 && (
        <Card title={t("overviewView.defects.title")}>
          <ul className="reason-list">
            {o.contentDefects.activeReleaseChecksFailing.map((c, index) => (
              <li key={index} dir="auto">
                {t("overviewView.defects.item", releaseCheckText(i18n, c))}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

/** How the workspace's AI supervision is doing (failed and waiting jobs, unchecked calls): about
 * every course, so the Courses home shows it rather than one course's overview. */
export function SupervisorHealthCard({
  health,
}: {
  health: NonNullable<CourseOverview["supervisorHealth"]>;
}) {
  const t = useT();
  const i18n = useI18n();
  const label = (key: string, fallback: string) =>
    i18n.has(key as MessageKey) ? t(key as MessageKey) : fallback;
  return (
    <Card title={t("overviewView.health.title")}>
      {!!health.uncheckedCallsLast7Days && (
        <Notice tone="gold" title={t("overviewView.health.uncheckedTitle")}>
          {t("overviewView.health.uncheckedBody", {
            count: health.uncheckedCallsLast7Days,
          })}
        </Notice>
      )}
      <p>
        {health.oldestOpenJobAgeSeconds === null
          ? t("overviewView.health.failed", {
              count: health.failedLast24h,
            })
          : t("overviewView.health.failedWithOldest", {
              count: health.failedLast24h,
              minutes: Math.round(health.oldestOpenJobAgeSeconds / 60),
            })}
      </p>
      <ul className="count-list">
        {Object.entries(health.jobsByState).map(([state, n]) => (
          <CountRow
            key={state}
            tone={state === "failed" ? "red" : "neutral"}
            label={label(
              `overviewView.jobState.${state}`,
              state.replaceAll("_", " "),
            )}
            count={n}
          />
        ))}
      </ul>
    </Card>
  );
}
