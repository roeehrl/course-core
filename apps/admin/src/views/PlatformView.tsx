import type { ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import type { AdminClient, CourseWorkspace } from "../domain/contracts";
import {
  platformErrorMessage,
  type BackupRun,
  type CheckStatus,
  type PlatformPort,
  type Readiness,
  type ReadinessCheck,
} from "../domain/platform";
import { useRemote } from "../hooks/useAdmin";
import { HostInventory } from "../components/HostInventory";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Loading,
  Notice,
} from "../components/ui";
import { useFormatters, useI18n, useT, type MessageKey } from "../i18n";

const TONE = {
  ok: "green",
  warning: "gold",
  failing: "red",
  not_configured: "neutral",
  no_data: "gold",
} as const;

/** Is the platform ready, and can it recover? Database, Temporal worker, grading sandbox,
 * telemetry export, versions and backups, with the recovery targets checked against the latest
 * backup reports. Owners and administrators of the workspace only. */
export function PlatformView({
  data,
  client,
}: {
  data: CourseWorkspace;
  client: AdminClient;
}) {
  const t = useT();
  const workspaceId = data.course.workspaceId;
  if (!client.platform || !workspaceId)
    return (
      <Card title={t("platformView.title")}>
        <EmptyState title={t("platformView.unavailable.title")}>
          {t("platformView.unavailable.body")}
        </EmptyState>
      </Card>
    );
  if (!["owner", "admin"].includes(data.role ?? ""))
    return <Notice tone="gold">{t("platformView.forbidden")}</Notice>;
  return (
    <div className="page-stack">
      <Readiness port={client.platform} workspaceId={workspaceId} />
      <HostInventory port={client.platform} workspaceId={workspaceId} />
    </div>
  );
}

function StatusBadge({ status }: { status: CheckStatus }) {
  const t = useT();
  return (
    <Badge tone={TONE[status]}>
      {t(`platformView.status.${status}` as MessageKey)}
    </Badge>
  );
}

function Readiness({
  port,
  workspaceId,
}: {
  port: PlatformPort;
  workspaceId: string;
}) {
  const t = useT();
  const { when } = useFormatters();
  const remote = useRemote(
    (signal) => port.readiness(workspaceId, signal),
    [port, workspaceId],
  );
  if (remote.loading) return <Loading label={t("platformView.loading")} />;
  if (remote.error || !remote.data)
    return (
      <div className="stack">
        <Notice tone="red">{platformErrorMessage(remote.error, t)}</Notice>
        <Button onClick={remote.reload}>{t("platformView.retry")}</Button>
      </div>
    );
  const report = remote.data;
  return (
    <div className="page-stack">
      <Card
        title={t("platformView.overall.title")}
        actions={
          <Button kind="quiet" onClick={remote.reload}>
            <RefreshCw size={16} aria-hidden="true" />
            {t("platformView.refresh")}
          </Button>
        }
      >
        <p>
          <StatusBadge status={report.overall} />{" "}
          {t(`platformView.overall.${report.overall}` as MessageKey)}
        </p>
        <small>
          {t("platformView.generated", { at: when(report.generatedAt) })}
        </small>
      </Card>
      <Targets report={report} />
      <div className="readiness-grid">
        {report.checks.map((check) => (
          <CheckCard key={check.id} check={check} />
        ))}
      </div>
    </div>
  );
}

function Targets({ report }: { report: Readiness }) {
  const t = useT();
  const { rpo, rto, encryption } = report.targets;
  return (
    <Card
      title={t("platformView.targets.title")}
      eyebrow={t("platformView.targets.eyebrow")}
    >
      <dl className="facts">
        <div>
          <dt>
            {t("platformView.targets.rpo", { minutes: rpo.targetMinutes })}{" "}
            <StatusBadge status={rpo.status} />
          </dt>
          <dd>
            {rpo.currentMinutes === null
              ? t("platformView.targets.rpoNone")
              : t("platformView.targets.rpoValue", {
                  minutes: rpo.currentMinutes,
                })}
          </dd>
        </div>
        <div>
          <dt>
            {t("platformView.targets.rto", { minutes: rto.targetMinutes })}{" "}
            <StatusBadge status={rto.status} />
          </dt>
          <dd>
            {rto.lastDrillMinutes === null
              ? t("platformView.targets.rtoNone")
              : t("platformView.targets.rtoValue", {
                  minutes: rto.lastDrillMinutes,
                  days: rto.drillAgeDays ?? 0,
                })}
          </dd>
        </div>
        {encryption && (
          <div>
            <dt>
              {t("platformView.targets.encryption")}{" "}
              <StatusBadge status={encryption.status} />
            </dt>
            <dd>
              {encryption.latestEncrypted === null
                ? t("platformView.targets.encryptionNone")
                : encryption.latestEncrypted
                  ? t("platformView.targets.encryptionOn")
                  : t("platformView.targets.encryptionOff")}
            </dd>
          </div>
        )}
      </dl>
      {encryption?.latestEncrypted === false && (
        <p className="info-note">{t("platformView.targets.encryptionHelp")}</p>
      )}
      {rpo.status !== "ok" && (
        <Notice tone={rpo.status === "failing" ? "red" : "gold"}>
          {t("platformView.targets.rpoHelp")}
        </Notice>
      )}
      {rto.status !== "ok" && (
        <Notice tone={rto.status === "failing" ? "red" : "gold"}>
          {t("platformView.targets.rtoHelp", { days: rto.drillMaxAgeDays })}
        </Notice>
      )}
    </Card>
  );
}

function CheckCard({ check }: { check: ReadinessCheck }) {
  const t = useT();
  return (
    <Card title={t(`platformView.check.${check.id}` as MessageKey)}>
      <p>
        <StatusBadge status={check.status} />
      </p>
      <p>{t(`platformView.about.${check.id}` as MessageKey)}</p>
      <Facts check={check} />
      {(check.status === "failing" || check.status === "warning") && (
        <Notice
          tone={check.status === "failing" ? "red" : "gold"}
          title={t("platformView.whatToDo")}
        >
          {t(`platformView.fix.${check.id}` as MessageKey)}
        </Notice>
      )}
    </Card>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function Facts({ check }: { check: ReadinessCheck }) {
  const i18n = useI18n();
  const t = i18n.t;
  const unknown = t("platformView.unknown");
  const yesNo = (value: boolean | null) =>
    value === null
      ? unknown
      : value
        ? t("platformView.yes")
        : t("platformView.no");
  const ltr = (value: string | null) =>
    value === null ? unknown : <span dir="ltr">{value}</span>;
  switch (check.id) {
    case "database":
      return (
        <dl className="facts">
          <Fact label={t("platformView.fact.postgres")}>
            {check.facts.postgresMajor}
          </Fact>
          <Fact label={t("platformView.fact.latency")}>
            {t("platformView.ms", { ms: check.facts.latencyMs })}
          </Fact>
          <Fact label={t("platformView.fact.migrations")}>
            {check.facts.migrationsExpected === null
              ? t("platformView.migrationsApplied", {
                  applied: check.facts.migrationsApplied,
                })
              : t("platformView.migrationsOf", {
                  applied: check.facts.migrationsApplied,
                  expected: check.facts.migrationsExpected,
                })}
          </Fact>
          <Fact label={t("platformView.fact.latestMigration")}>
            {ltr(check.facts.latestMigration)}
          </Fact>
        </dl>
      );
    case "temporal":
      return (
        <dl className="facts">
          <Fact label={t("platformView.fact.lastContact")}>
            {check.facts.lastWorkerContactSeconds === null
              ? t("platformView.never")
              : t("platformView.secondsAgo", {
                  seconds: check.facts.lastWorkerContactSeconds,
                })}
          </Fact>
          <Fact label={t("platformView.fact.pending")}>
            {check.facts.pendingEvents}
          </Fact>
          <Fact label={t("platformView.fact.oldestPending")}>
            {check.facts.oldestPendingSeconds === null
              ? t("platformView.none")
              : t("platformView.seconds", {
                  seconds: check.facts.oldestPendingSeconds,
                })}
          </Fact>
          <Fact label={t("platformView.fact.quarantined")}>
            {check.facts.quarantinedEvents}
          </Fact>
        </dl>
      );
    case "sandbox":
      return (
        <dl className="facts">
          <Fact label={t("platformView.fact.ready")}>
            {yesNo(check.facts.ready)}
          </Fact>
          {check.facts.reason && (
            <Fact label={t("platformView.fact.reason")}>
              {ltr(check.facts.reason)}
            </Fact>
          )}
        </dl>
      );
    case "collector":
      return (
        <dl className="facts">
          <Fact label={t("platformView.fact.export")}>
            {yesNo(check.facts.enabled)}
          </Fact>
          <Fact label={t("platformView.fact.exported")}>
            {check.facts.exportedSpans ?? unknown}
          </Fact>
          <Fact label={t("platformView.fact.dropped")}>
            {check.facts.droppedQueueFull === null
              ? unknown
              : t("platformView.dropped", {
                  full: check.facts.droppedQueueFull,
                  failed: check.facts.droppedExportFailed ?? 0,
                })}
          </Fact>
        </dl>
      );
    case "version":
      return (
        <dl className="facts">
          <Fact label={t("platformView.fact.core")}>
            {ltr(check.facts.coreVersion)}
          </Fact>
          <Fact label={t("platformView.fact.sdk")}>
            {ltr(check.facts.sdkVersion)}
          </Fact>
          <Fact label={t("platformView.fact.node")}>
            {ltr(check.facts.nodeVersion)}{" "}
            {!check.facts.nodeSupported && (
              <Badge tone="gold">{t("platformView.unsupported")}</Badge>
            )}
          </Fact>
          <Fact label={t("platformView.fact.schema")}>
            {check.facts.courseSchemaVersion}
          </Fact>
          <Fact label={t("platformView.fact.extensions")}>
            {check.facts.installedExtensions}
          </Fact>
        </dl>
      );
    case "backups":
      return (
        <dl className="facts">
          <Fact label={t("platformView.fact.lastSnapshot")}>
            <Run run={check.facts.lastSnapshot} />
          </Fact>
          <Fact label={t("platformView.fact.lastBackup")}>
            <Run run={check.facts.lastBackup} />
          </Fact>
          <Fact label={t("platformView.fact.lastDrill")}>
            <Run run={check.facts.lastRestoreDrill} />
          </Fact>
          {check.facts.lastFailure && (
            <Fact label={t("platformView.fact.lastFailure")}>
              <Run run={check.facts.lastFailure} />
            </Fact>
          )}
        </dl>
      );
  }
}

function Run({ run }: { run: BackupRun | null }) {
  const i18n = useI18n();
  const t = i18n.t;
  const { when } = useFormatters();
  if (!run) return <>{t("platformView.never")}</>;
  return (
    <>
      {run.outcome === "failed" ? (
        <>
          {t("platformView.run.failed", { at: when(run.finishedAt) })}{" "}
          <small className="mono" dir="ltr">
            {run.code}
          </small>
        </>
      ) : (
        t("platformView.run.succeeded", {
          at: when(run.finishedAt),
          seconds: run.durationSeconds,
          size: i18n.number((run.bytes ?? 0) / 1_048_576, {
            maximumFractionDigits: 1,
          }),
        })
      )}{" "}
      {run.outcome === "succeeded" && (
        <Badge tone={run.encrypted ? "green" : "neutral"}>
          {run.encrypted
            ? t("platformView.run.encrypted")
            : t("platformView.run.plain")}
        </Badge>
      )}
    </>
  );
}
