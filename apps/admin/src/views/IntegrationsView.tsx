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
  Loading,
  Notice,
} from "../components/ui";
import { useFormatters, useT, type MessageKey } from "../i18n";

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
}: {
  data: CourseWorkspace;
  client: AdminClient;
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
      <Overview port={client.platform} workspaceId={workspaceId} />
      <BilledCosts port={client.platform} workspaceId={workspaceId} />
    </div>
  );
}

function Overview({
  port,
  workspaceId,
}: {
  port: PlatformPort;
  workspaceId: string;
}) {
  const t = useT();
  const remote = useRemote(
    (signal) => port.integrations(workspaceId, signal),
    [port, workspaceId],
  );
  if (remote.loading) return <Loading label={t("integrationsView.loading")} />;
  if (remote.error || !remote.data)
    return (
      <div className="stack">
        <Notice tone="red">{platformErrorMessage(remote.error, t)}</Notice>
        <Button onClick={remote.reload}>{t("integrationsView.retry")}</Button>
      </div>
    );
  return <Details value={remote.data} />;
}

function Details({ value }: { value: Integrations }) {
  const t = useT();
  const { when } = useFormatters();
  const unknown = t("integrationsView.unknown");
  return (
    <>
      <Card title={t("integrationsView.runtime.title")}>
        <dl className="facts">
          <div>
            <dt>{t("integrationsView.runtime.core")}</dt>
            <dd dir="ltr">{value.runtime.coreVersion ?? unknown}</dd>
          </div>
          <div>
            <dt>{t("integrationsView.runtime.sdk")}</dt>
            <dd dir="ltr">{value.runtime.sdkVersion ?? unknown}</dd>
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
      <Card
        title={t("integrationsView.courses.title")}
        eyebrow={t("integrationsView.courses.eyebrow")}
      >
        {value.courses.length === 0 ? (
          <p>{t("integrationsView.courses.empty")}</p>
        ) : (
          value.courses.map((course) => (
            <article className="record" key={course.catalogId}>
              <h3 dir="auto">{course.title}</h3>
              <p>
                {course.liveVersion
                  ? t("integrationsView.courses.live", {
                      version: course.liveVersion,
                    })
                  : t("integrationsView.courses.noLive")}
              </p>
              {course.extensions.length === 0 ? (
                <small>{t("integrationsView.courses.noExtensions")}</small>
              ) : (
                <ul>
                  {course.extensions.map((ext) => (
                    <li key={`${ext.id}@${ext.version}`}>
                      <span dir="ltr">
                        {ext.id} {ext.version}
                      </span>{" "}
                      <Badge tone={COMPATIBILITY_TONE[ext.status]}>
                        {t(
                          `integrationsView.compat.${ext.status}` as MessageKey,
                        )}
                      </Badge>
                    </li>
                  ))}
                </ul>
              )}
              {course.extensions.some(
                (ext) =>
                  ext.status === "missing" || ext.status === "version_mismatch",
              ) && (
                <Notice tone="red">{t("integrationsView.courses.fix")}</Notice>
              )}
            </article>
          ))
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
      <Card
        title={t("integrationsView.receipts.title")}
        eyebrow={t("integrationsView.receipts.eyebrow")}
      >
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
                    <span dir="ltr">{c.errorCode ?? c.result ?? unknown}</span>
                  </Badge>
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>
      <Card title={t("integrationsView.providers.title")}>
        {value.providers.length === 0 ? (
          <p>{t("integrationsView.providers.empty")}</p>
        ) : (
          <ul className="stack">
            {value.providers.map((p) => (
              <li key={p.adapterId}>
                <bdi>{p.name || p.adapterId}</bdi>{" "}
                <Badge
                  tone={
                    p.keyStatus === "working"
                      ? "green"
                      : p.keyStatus === "untested"
                        ? "gold"
                        : "red"
                  }
                >
                  {t(
                    `integrationsView.key.${["working", "rejected", "untested", "unreachable"].includes(p.keyStatus) ? p.keyStatus : "other"}` as MessageKey,
                  )}
                </Badge>{" "}
                {p.testedAt && (
                  <small>
                    {t("integrationsView.providers.tested", {
                      at: when(p.testedAt),
                    })}
                  </small>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
