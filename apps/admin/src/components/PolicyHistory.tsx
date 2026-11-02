import { platformErrorMessage, type PlatformPort } from "../domain/platform";
import { useRemote } from "../hooks/useAdmin";
import { Badge, Button, Card, Loading, Notice } from "./ui";
import {
  useFormatters,
  useI18n,
  useT,
  type AdminTranslator,
  type MessageKey,
} from "../i18n";

/** A setting's path ("policy.window.pauseRule") in words, part by part ("Learning policy ›
 * Calendar window › Pausing"). A part without a name in the catalog is spelled out from its
 * code ("maxSomething" → "max something") and kept in its own direction. */
function SettingName({ path }: { path: string }) {
  const i18n = useI18n();
  const parts = path.split(".");
  return (
    <span className="setting-path" title={path}>
      {parts.map((part, index) => {
        const key = `policyHistory.segment.${part}` as MessageKey;
        return (
          <span key={index}>
            {index > 0 && (
              <span className="setting-path-sep" aria-hidden="true">
                {" › "}
              </span>
            )}
            {i18n.has(key) ? (
              i18n.t(key)
            ) : (
              <bdi>
                {part
                  .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
                  .replace(/_/g, " ")
                  .toLowerCase()}
              </bdi>
            )}
          </span>
        );
      })}
    </span>
  );
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
/** One recorded value (JSON text, cut at 200 characters by the server) as a reader sees it. */
function SettingValue({ value }: { value: string | null | undefined }) {
  const i18n = useI18n();
  const t = i18n.t;
  const { when } = useFormatters();
  if (value === undefined || value === null)
    return (
      <span className="muted" title={t("policyHistory.unset")}>
        <span aria-hidden="true">—</span>
        <span className="sr-only">{t("policyHistory.unsetLabel")}</span>
      </span>
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    // Cut short when it was recorded. A list keeps the items that were recorded whole.
    if (value.startsWith("[")) {
      const items = [...value.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(
        (match) => match[1]!,
      );
      if (items.length)
        return (
          <details className="setting-list">
            <summary>
              {t("policyHistory.showSome", { count: items.length })}
            </summary>
            <ul>
              {items.map((item, index) => (
                <li key={index}>
                  <bdi className="mono">{item}</bdi>
                </li>
              ))}
            </ul>
            <small className="muted">{t("policyHistory.cut")}</small>
          </details>
        );
    }
    return (
      <span className="setting-value-cut" title={t("policyHistory.cut")}>
        <bdi className="mono">{value}…</bdi>
      </span>
    );
  }
  return <Parsed value={parsed} i18n={i18n} when={when} />;
}

function Parsed({
  value,
  i18n,
  when,
}: {
  value: unknown;
  i18n: AdminTranslator;
  when: (iso: string) => string;
}) {
  const t = i18n.t;
  if (value === null)
    return (
      <span className="muted" title={t("policyHistory.unset")}>
        <span aria-hidden="true">—</span>
        <span className="sr-only">{t("policyHistory.unsetLabel")}</span>
      </span>
    );
  if (typeof value === "boolean")
    return <>{value ? t("policyHistory.yes") : t("policyHistory.no")}</>;
  if (typeof value === "number") return <>{i18n.number(value)}</>;
  if (typeof value === "string") {
    if (ISO.test(value)) return <>{when(value)}</>;
    const named = `policyHistory.value.${value}` as MessageKey;
    return i18n.has(named) ? <>{t(named)}</> : <bdi>{value}</bdi>;
  }
  if (Array.isArray(value)) {
    const items = value.map((item) =>
      typeof item === "string" ? item : JSON.stringify(item),
    );
    if (items.length <= 3)
      return items.length ? (
        <bdi className="mono">{items.join(", ")}</bdi>
      ) : (
        <span className="muted">{t("policyHistory.items", { count: 0 })}</span>
      );
    // A long list is a count first; the items are one click away.
    return (
      <details className="setting-list">
        <summary>{t("policyHistory.showAll", { count: items.length })}</summary>
        <ul>
          {items.map((item, index) => (
            <li key={index}>
              <bdi className="mono">{item}</bdi>
            </li>
          ))}
        </ul>
      </details>
    );
  }
  return <bdi className="mono">{JSON.stringify(value)}</bdi>;
}

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
    <Card title={t("policyHistory.title")}>
      <p className="muted">{t("policyHistory.intro")}</p>
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
                  <table className="data-table policy-changes">
                    <caption className="sr-only">
                      {t("policyHistory.changes")}
                    </caption>
                    <colgroup>
                      <col className="policy-col-setting" />
                      <col />
                      <col />
                    </colgroup>
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
                          <th scope="row">
                            <SettingName path={change.path} />
                          </th>
                          <td data-label={t("policyHistory.col.before")}>
                            <SettingValue value={change.before} />
                          </td>
                          <td data-label={t("policyHistory.col.after")}>
                            <SettingValue value={change.after} />
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
