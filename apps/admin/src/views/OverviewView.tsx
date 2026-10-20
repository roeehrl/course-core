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
  when,
} from "../components/ui";

const queueLabels: Record<keyof CourseOverview["approvalQueue"], string> = {
  writtenAnswers: "Written answers to review",
  secondOpinions: "Second opinions requested",
  gateReviews: "Gate review requests",
  generatedMedia: "Generated media to review",
  releases: "Releases awaiting review",
  providerRequests: "Provider requests",
};

/** What needs attention on this course: counts only, nothing learner-private. */
export function OverviewView({
  data,
  client,
}: {
  data: CourseWorkspace;
  client: AdminClient;
}) {
  if (!client.overview)
    return (
      <Card title="Overview">
        <EmptyState title="Overview is not available here">
          Use a connected administration session.
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
  if (overview.loading) return <Loading label="Loading the course overview…" />;
  if (overview.error || !overview.data)
    return <Notice tone="red">{overviewErrorMessage(overview.error)}</Notice>;
  const o = overview.data;
  const waiting = Object.values(o.approvalQueue).reduce((a, b) => a + b, 0);
  const defects = o.contentDefects.activeReleaseChecksFailing.length;
  return (
    <div className="page-stack">
      <div className="stats-grid">
        <Stat
          label="Live release"
          value={o.release.active ? o.release.active.version : "None"}
          detail={
            o.release.active
              ? `published ${when(o.release.active.createdAt)}`
              : "No release for new learners"
          }
        />
        <Stat
          label="Waiting for staff"
          value={waiting}
          detail="Reviews, requests and releases"
        />
        <Stat
          label="Deadline risks"
          value={o.deadlineRisks ? o.deadlineRisks.length : "—"}
          detail={
            o.deadlineRisks
              ? "Active learners due within 7 days"
              : "Not visible to your role"
          }
        />
        <Stat
          label="Content defects"
          value={defects}
          detail={`${o.contentDefects.evidenceInvalidatedLast30Days} evidence records invalidated in 30 days`}
        />
      </div>
      <Card title="Approval queue">
        <ul className="overview-list">
          {(Object.keys(queueLabels) as (keyof typeof queueLabels)[]).map(
            (key) => (
              <li key={key}>
                <span>{queueLabels[key]}</span>
                <Badge tone={o.approvalQueue[key] ? "gold" : "neutral"}>
                  {o.approvalQueue[key]}
                </Badge>
              </li>
            ),
          )}
        </ul>
      </Card>
      <Card title="Releases and learners">
        {o.release.update?.availableVersion && (
          <Notice tone="gold" title="Update available">
            Version {o.release.update.availableVersion} is available at this
            course's update source. Review and install it in Course &amp;
            releases.
          </Notice>
        )}
        <p>
          {o.release.counts.published} published · {o.release.counts.draft}{" "}
          draft · {o.release.counts.archived} archived
        </p>
        {o.release.pinnedLearners.length > 0 && (
          <ul className="overview-list">
            {o.release.pinnedLearners.map((p) => (
              <li key={p.releaseId}>
                <span>Learners on version {p.version ?? "unknown"}</span>
                <Badge>{p.learners}</Badge>
              </li>
            ))}
          </ul>
        )}
        {o.lifecycle && (
          <ul className="overview-list" aria-label="Enrollments by state">
            {Object.entries(o.lifecycle).map(([state, n]) => (
              <li key={state}>
                <span>{state}</span>
                <Badge>{n}</Badge>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {o.deadlineRisks && (
        <Card title="Deadline risks">
          {o.deadlineRisks.length === 0 ? (
            <EmptyState title="No learner is close to a deadline">
              Active learners with unfinished lessons due within 7 days appear
              here.
            </EmptyState>
          ) : (
            <ul className="overview-list">
              {o.deadlineRisks.map((r) => (
                <li key={r.enrollmentId}>
                  <span>
                    {r.learner} · {r.remainingEpisodes} lessons left · due{" "}
                    {when(r.deadline)}
                  </span>
                  <Badge tone={r.daysLeft < 0 ? "red" : "gold"}>
                    {r.daysLeft < 0 ? "overdue" : `${r.daysLeft} days`}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
      {defects > 0 && (
        <Card title="Content defects">
          <ul className="reason-list">
            {o.contentDefects.activeReleaseChecksFailing.map((c) => (
              <li key={c.label}>
                {c.label}: {c.detail}
              </li>
            ))}
          </ul>
        </Card>
      )}
      {o.supervisorHealth && (
        <Card title="AI supervision health">
          <p>
            {o.supervisorHealth.failedLast24h} failed in the last 24 hours
            {o.supervisorHealth.oldestOpenJobAgeSeconds !== null &&
              ` · oldest open job ${Math.round(o.supervisorHealth.oldestOpenJobAgeSeconds / 60)} minutes old`}
          </p>
          <ul className="overview-list">
            {Object.entries(o.supervisorHealth.jobsByState).map(
              ([state, n]) => (
                <li key={state}>
                  <span>{state.replaceAll("_", " ")}</span>
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
