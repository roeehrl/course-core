import type { AdminClient, CourseWorkspace } from "../domain/contracts";
import {
  platformErrorMessage,
  type Integrations,
  type PlatformPort,
} from "../domain/platform";
import { useRemote } from "../hooks/useAdmin";
import { BilledCosts } from "../components/BilledCosts";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Notice,
  SkeletonRows,
} from "../components/ui";
import { ArrowRight } from "lucide-react";
import { useFormatters, useI18n, useT, type MessageKey } from "../i18n";
import "./workspacePages.css";

const COMPATIBILITY_TONE = {
  compatible: "green",
  built_in: "green",
  version_mismatch: "red",
  missing: "red",
} as const;

/** What this workspace is connected to: the runtime and its installed extensions, whether each
 * course's live version can run on them, course package installs and update checks, AI provider
 * connections, telemetry export, and provider-billed costs next to the estimates. */
export function IntegrationsView({
  data,
  client,
  onOpenAiServices,
}: {
  data: CourseWorkspace;
  client: AdminClient;
  /** Opens the AI services page, where AI connections are managed. */
  onOpenAiServices?: () => void;
}) {
  const t = useT();
  const workspaceId = data.course.workspaceId;
  if (!client.platform || !workspaceId)
    return (
      <Card title={t("integrationsView.title")}>
        <EmptyState title={t("integrationsView.unavailable.title")}>
          {t("integrationsView.unavailable.body")}
        </EmptyState>
      </Card>
    );
  if (!["owner", "admin"].includes(data.role ?? ""))
    return <Notice tone="gold">{t("integrationsView.forbidden")}</Notice>;
  return (
    <div className="page-stack">
      <Overview
        port={client.platform}
        workspaceId={workspaceId}
        onOpenAiServices={onOpenAiServices}
      />
      <BilledCosts port={client.platform} workspaceId={workspaceId} />
    </div>
  );
}

function Overview({
  port,
  workspaceId,
  onOpenAiServices,
}: {
  port: PlatformPort;
  workspaceId: string;
  onOpenAiServices?: (() => void) | undefined;
}) {
  const t = useT();
  const remote = useRemote(
    (signal) => port.integrations(workspaceId, signal),
    [port, workspaceId],
  );
  if (remote.loading)
    return <SkeletonRows label={t("integrationsView.loading")} rows={6} />;
  if (remote.error || !remote.data)
    return (
      <div className="stack">
        <Notice tone="red">{platformErrorMessage(remote.error, t)}</Notice>
        <Button onClick={remote.reload}>{t("integrationsView.retry")}</Button>
      </div>
    );
  return <Details value={remote.data} onOpenAiServices={onOpenAiServices} />;
}

function Details({
  value,
  onOpenAiServices,
}: {
  value: Integrations;
  onOpenAiServices?: (() => void) | undefined;
}) {
  const i18n = useI18n();
  const t = useT();
  const { when } = useFormatters();
  const unknown = t("integrationsView.unknown");
  return (
    <>
      <Card title={t("integrationsView.runtime.title")}>
        <dl className="facts">
          <div>
            <dt>{t("integrationsView.runtime.core")}</dt>
            <dd>
              {value.runtime.coreVersion ? (
                <bdi>{value.runtime.coreVersion}</bdi>
              ) : (
                unknown
              )}
            </dd>
          </div>
          <div>
            <dt>{t("integrationsView.runtime.sdk")}</dt>
            <dd>
              {value.runtime.sdkVersion ? (
                <bdi>{value.runtime.sdkVersion}</bdi>
              ) : (
                unknown
              )}
            </dd>
          </div>
          <div>
            <dt>{t("integrationsView.runtime.telemetry")}</dt>
            <dd>
              {value.telemetry.export === "on"
                ? t("integrationsView.runtime.telemetryOn")
                : t("integrationsView.runtime.telemetryOff")}
            </dd>
          </div>
        </dl>
      </Card>
      <Card title={t("integrationsView.courses.title")}>
        <p>{t("integrationsView.courses.intro")}</p>
        {value.courses.length === 0 ? (
          <p>{t("integrationsView.courses.empty")}</p>
        ) : (
          value.courses.map((course) => {
            const blocked = course.extensions.some(
              (ext) =>
                ext.status === "missing" || ext.status === "version_mismatch",
            );
            return (
              <article className="record" key={course.catalogId}>
                <div className="split-line">
                  <h3 dir="auto">{course.title}</h3>
                  <Badge tone={blocked ? "red" : "green"}>
                    {blocked
                      ? t("integrationsView.courses.blocked")
                      : t("integrationsView.courses.ready")}
                  </Badge>
                </div>
                <p className="muted">
                  {course.liveVersion
                    ? t("integrationsView.courses.live", {
                        version: course.liveVersion,
                      })
                    : t("integrationsView.courses.noLive")}
                </p>
                {course.extensions.length === 0 ? (
                  <small>{t("integrationsView.courses.noExtensions")}</small>
                ) : (
                  <div
                    className="table-wrap"
                    tabIndex={0}
                    role="region"
                    aria-label={t("integrationsView.courses.table", {
                      course: course.title,
                    })}
                  >
                    <table className="data-table requirements-table">
                      <caption className="sr-only">
                        {t("integrationsView.courses.table", {
                          course: course.title,
                        })}
                      </caption>
                      <thead>
                        <tr>
                          <th scope="col">
                            {t("integrationsView.extensions.name")}
                          </th>
                          <th scope="col">
                            {t("integrationsView.courses.needs")}
                          </th>
                          <th scope="col">
                            {t("integrationsView.courses.installed")}
                          </th>
                          <th scope="col">
                            {t("integrationsView.courses.status")}
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {course.extensions.map((ext) => {
                          const installed =
                            ext.status === "built_in"
                              ? null
                              : value.extensions.find(
                                  (item) => item.id === ext.id,
                                )?.version;
                          return (
                            <tr key={`${ext.id}@${ext.version}`}>
                              <th scope="row">
                                <bdi>{ext.id}</bdi>
                              </th>
                              <td>
                                <bdi>{ext.version}</bdi>
                              </td>
                              <td>
                                {ext.status === "built_in" ? (
                                  t("integrationsView.compat.built_in")
                                ) : installed ? (
                                  <bdi>{installed}</bdi>
                                ) : (
                                  <span className="muted">—</span>
                                )}
                              </td>
                              <td>
                                <Badge tone={COMPATIBILITY_TONE[ext.status]}>
                                  {t(
                                    `integrationsView.compat.${ext.status}` as MessageKey,
                                  )}
                                </Badge>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
                {blocked && (
                  <Notice tone="red">
                    {t("integrationsView.courses.fix")}
                  </Notice>
                )}
              </article>
            );
          })
        )}
      </Card>
      <Card title={t("integrationsView.extensions.title")}>
        <div
          className="table-wrap"
          tabIndex={0}
          role="region"
          aria-label={t("integrationsView.extensions.title")}
        >
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">{t("integrationsView.extensions.name")}</th>
                <th scope="col">{t("integrationsView.extensions.version")}</th>
                <th scope="col">
                  {t("integrationsView.extensions.integrity")}
                </th>
              </tr>
            </thead>
            <tbody>
              {value.extensions.map((ext) => (
                <tr key={ext.id}>
                  <th scope="row">
                    <span dir="ltr">{ext.id}</span>
                  </th>
                  <td>
                    <span dir="ltr">{ext.version}</span>
                  </td>
                  <td className="mono">
                    <span dir="ltr">{ext.integrity.slice(0, 24)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <Card title={t("integrationsView.receipts.title")}>
        {value.packageReceipts.length === 0 ? (
          <p>{t("integrationsView.receipts.empty")}</p>
        ) : (
          <ul className="stack">
            {value.packageReceipts.map((r) => (
              <li key={r.id}>
                {t("integrationsView.receipts.item", {
                  course: r.courseKey ?? unknown,
                  version: r.version ?? unknown,
                  at: when(r.at),
                })}{" "}
                {r.repository && (
                  <span dir="ltr">
                    {r.repository} {r.tag}
                  </span>
                )}{" "}
                {r.packageSha256 && (
                  <small className="mono" dir="ltr">
                    {r.packageSha256.slice(0, 16)}
                  </small>
                )}
              </li>
            ))}
          </ul>
        )}
        {value.updateChecks.length > 0 && (
          <>
            <h3>{t("integrationsView.updates.title")}</h3>
            <ul className="stack">
              {value.updateChecks.map((c) => (
                <li key={c.id}>
                  {t("integrationsView.updates.item", {
                    course: c.courseKey ?? unknown,
                    at: when(c.at),
                  })}{" "}
                  <Badge tone={c.errorCode ? "red" : "neutral"}>
                    {c.errorCode ? (
                      <span dir="ltr">{c.errorCode}</span>
                    ) : c.result &&
                      i18n.has(
                        `courseUpdates.result.${c.result}` as MessageKey,
                      ) ? (
                      t(`courseUpdates.result.${c.result}` as MessageKey)
                    ) : (
                      <span dir="ltr">{c.result ?? unknown}</span>
                    )}
                  </Badge>
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>
      <ProvidersSummary
        providers={value.providers}
        onOpenAiServices={onOpenAiServices}
      />
    </>
  );
}

/** AI connections are managed on AI services; this page only says whether they work and links
 * there, instead of repeating the connection list in a second presentation. */
function ProvidersSummary({
  providers,
  onOpenAiServices,
}: {
  providers: Integrations["providers"];
  onOpenAiServices?: (() => void) | undefined;
}) {
  const t = useT();
  const working = providers.filter((p) => p.keyStatus === "working").length;
  return (
    <Card
      title={t("integrationsView.providers.title")}
      actions={
        onOpenAiServices && (
          <Button onClick={onOpenAiServices}>
            {t("integrationsView.providers.open")}
            <ArrowRight size={16} aria-hidden="true" className="flip-rtl" />
          </Button>
        )
      }
    >
      <p>
        {providers.length === 0
          ? t("integrationsView.providers.empty")
          : working === providers.length
            ? t("integrationsView.providers.allWorking", {
                count: providers.length,
              })
            : t("integrationsView.providers.someFailing", {
                count: providers.length,
                failing: providers.length - working,
              })}
      </p>
    </Card>
  );
}
