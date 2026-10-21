import type { AdminClient, CourseWorkspace } from "../domain/contracts";
import { overviewErrorMessage, type CourseOverview } from "../domain/overview";
import { useRemote } from "../hooks/useAdmin";
import {
  Badge,
  Card,
  EmptyState,
  Loading,
  Notice,
  Stat,
} from "../components/ui";
import { useFormatters, useI18n, useT, type MessageKey } from "../i18n";

const queueKeys: Record<keyof CourseOverview["approvalQueue"], MessageKey> = {
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
}: {
  data: CourseWorkspace;
  client: AdminClient;
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
  return <Overview port={client.overview} catalogId={data.course.id} />;
}

function Overview({
  port,
  catalogId,
}: {
  port: NonNullable<AdminClient["overview"]>;
  catalogId: string;
}) {
  const overview = useRemote(
    (signal) => port.load(catalogId, signal),
    [port, catalogId],
  );
  const t = useT();
  const i18n = useI18n();
  const { when } = useFormatters();
  if (overview.loading) return <Loading label={t("overviewView.loading")} />;
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
  return (
    <div className="page-stack">
      <div className="stats-grid">
        <Stat
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
        />
        <Stat
          label={t("overviewView.stat.waiting")}
          value={i18n.number(waiting)}
          detail={t("overviewView.stat.waitingDetail")}
        />
        <Stat
          label={t("overviewView.stat.deadlineRisks")}
          value={o.deadlineRisks ? i18n.number(o.deadlineRisks.length) : "—"}
          detail={
            o.deadlineRisks
              ? t("overviewView.stat.deadlineRisksDetail")
              : t("overviewView.stat.notVisible")
          }
        />
        <Stat
          label={t("overviewView.stat.contentDefects")}
          value={i18n.number(defects)}
          detail={t("overviewView.stat.invalidated", {
            count: o.contentDefects.evidenceInvalidatedLast30Days,
          })}
        />
      </div>
      <Card title={t("overviewView.queue.title")}>
        <ul className="overview-list">
          {(Object.keys(queueKeys) as (keyof typeof queueKeys)[]).map((key) => (
            <li key={key}>
              <span>{t(queueKeys[key])}</span>
              <Badge tone={o.approvalQueue[key] ? "gold" : "neutral"}>
                {o.approvalQueue[key]}
              </Badge>
            </li>
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
          <ul className="overview-list">
            {o.release.pinnedLearners.map((p) => (
              <li key={p.releaseId}>
                <span>
                  {p.version
                    ? t("overviewView.releases.pinned", { version: p.version })
                    : t("overviewView.releases.pinnedUnknown")}
                </span>
                <Badge>{p.learners}</Badge>
              </li>
            ))}
          </ul>
        )}
        {o.lifecycle && (
          <ul
            className="overview-list"
            aria-label={t("overviewView.lifecycle.label")}
          >
            {Object.entries(o.lifecycle).map(([state, n]) => (
              <li key={state}>
                <span>
                  {label(`overviewView.lifecycle.state.${state}`, state)}
                </span>
                <Badge>{n}</Badge>
              </li>
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
            {o.contentDefects.activeReleaseChecksFailing.map((c) => (
              <li key={c.label} dir="auto">
                {t("overviewView.defects.item", {
                  label: c.label,
                  detail: c.detail,
                })}
              </li>
            ))}
          </ul>
        </Card>
      )}
      {o.supervisorHealth && (
        <Card title={t("overviewView.health.title")}>
          {!!o.supervisorHealth.uncheckedCallsLast7Days && (
            <Notice tone="gold" title={t("overviewView.health.uncheckedTitle")}>
              {t("overviewView.health.uncheckedBody", {
                count: o.supervisorHealth.uncheckedCallsLast7Days,
              })}
            </Notice>
          )}
          <p>
            {o.supervisorHealth.oldestOpenJobAgeSeconds === null
              ? t("overviewView.health.failed", {
                  count: o.supervisorHealth.failedLast24h,
                })
              : t("overviewView.health.failedWithOldest", {
                  count: o.supervisorHealth.failedLast24h,
                  minutes: Math.round(
                    o.supervisorHealth.oldestOpenJobAgeSeconds / 60,
                  ),
                })}
          </p>
          <ul className="overview-list">
            {Object.entries(o.supervisorHealth.jobsByState).map(
              ([state, n]) => (
                <li key={state}>
                  <span>
                    {label(
                      `overviewView.jobState.${state}`,
                      state.replaceAll("_", " "),
                    )}
                  </span>
                  <Badge tone={state === "failed" ? "red" : "neutral"}>
                    {n}
                  </Badge>
                </li>
              ),
            )}
          </ul>
        </Card>
      )}
    </div>
  );
}
