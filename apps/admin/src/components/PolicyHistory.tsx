import { platformErrorMessage, type PlatformPort } from "../domain/platform";
import { useRemote } from "../hooks/useAdmin";
import { Badge, Button, Card, Loading, Notice } from "./ui";
import { useFormatters, useT, type MessageKey } from "../i18n";

/** Every change to this course's rules, newest first, each as a setting-by-setting comparison
 * with the version before: course policy settings, placement settings, and the learning policy
 * each published version carried. */
export function PolicyHistory({
  port,
  courseId,
}: {
  port: PlatformPort;
  courseId: string;
}) {
  const t = useT();
  const { when } = useFormatters();
  const remote = useRemote(
    (signal) => port.policyHistory(courseId, signal),
    [port, courseId],
  );
  return (
    <Card title={t("policyHistory.title")} eyebrow={t("policyHistory.eyebrow")}>
      {remote.loading ? (
        <Loading label={t("policyHistory.loading")} />
      ) : remote.error || !remote.data ? (
        <div className="stack">
          <Notice tone="red">{platformErrorMessage(remote.error, t)}</Notice>
          <Button onClick={remote.reload}>{t("policyHistory.retry")}</Button>
        </div>
      ) : remote.data.entries.length === 0 ? (
        <p>{t("policyHistory.empty")}</p>
      ) : (
        <ol className="stack policy-history">
          {remote.data.entries.map((entry) => (
            <li key={entry.id} className="record">
              <div className="split-line">
                <h3>
                  <Badge tone="blue">
                    {t(`policyHistory.source.${entry.source}` as MessageKey)}
                  </Badge>{" "}
                  {entry.version
                    ? t("policyHistory.version", { version: entry.version })
                    : entry.revision !== null
                      ? t("policyHistory.revision", {
                          revision: entry.revision,
                        })
                      : null}
                </h3>
                <small>
                  {entry.actor
                    ? t("policyHistory.by", {
                        who: entry.actor,
                        at: when(entry.at),
                      })
                    : when(entry.at)}
                </small>
              </div>
              {entry.reason && (
                <p>
                  {t("policyHistory.reason")} <bdi>{entry.reason}</bdi>
                </p>
              )}
              {entry.changes.length === 0 ? (
                <small>{t("policyHistory.noChanges")}</small>
              ) : (
                <div
                  className="table-wrap"
                  tabIndex={0}
                  role="region"
                  aria-label={t("policyHistory.changes")}
                >
                  <table className="data-table">
                    <caption className="sr-only">
                      {t("policyHistory.changes")}
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">{t("policyHistory.col.setting")}</th>
                        <th scope="col">{t("policyHistory.col.before")}</th>
                        <th scope="col">{t("policyHistory.col.after")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {entry.changes.map((change) => (
                        <tr key={change.path}>
                          <th scope="row" className="mono">
                            <span dir="ltr">{change.path}</span>
                          </th>
                          <td>
                            {change.before === undefined ||
                            change.before === null ? (
                              <span className="muted">
                                {t("policyHistory.unset")}
                              </span>
                            ) : (
                              <span className="mono" dir="ltr">
                                {change.before}
                              </span>
                            )}
                          </td>
                          <td>
                            {change.after === undefined ||
                            change.after === null ? (
                              <span className="muted">
                                {t("policyHistory.unset")}
                              </span>
                            ) : (
                              <span className="mono" dir="ltr">
                                {change.after}
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
