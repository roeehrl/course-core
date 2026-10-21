import { useEffect, useId, useState, type FormEvent } from "react";
import type { AdminClient } from "../domain/contracts";
import { CoursePackageError, packageMessage } from "../domain/coursePackages";
import type {
  CheckResult,
  UpdateLevel,
  UpdatesView,
} from "../domain/courseUpdates";
import { errorMessage } from "../domain/errors";
import { InstallCourse } from "./InstallCourse";
import {
  useFormatters,
  useI18n,
  type MessageKey,
  type Translate,
} from "../i18n";
import { Badge, Button, Card, Dialog, Field, Notice } from "./ui";

const levels: UpdateLevel[] = ["off", "check", "install", "publish"];
const message = (error: unknown, t: Translate) =>
  error instanceof CoursePackageError
    ? packageMessage(error.code, t)
    : errorMessage(error, t);

/** Course & releases → Updates: the course's update source, manual checks and automatic updates. */
export function CourseUpdates({
  client,
  courseId,
  workspaceId,
  onInstalled,
}: {
  client: AdminClient;
  courseId: string;
  workspaceId: string;
  onInstalled: (catalogId?: string) => void;
}) {
  const port = client.courseUpdates!;
  const i18n = useI18n();
  const t = i18n.t;
  const { when } = useFormatters();
  const resultLabel = (result: string | null | undefined) => {
    const key = `courseUpdates.result.${result ?? ""}` as MessageKey;
    return result && i18n.has(key) ? t(key) : "—";
  };
  const id = useId();
  const [view, setView] = useState<UpdatesView>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);
  const [check, setCheck] = useState<CheckResult["outcome"]>();
  const [updating, setUpdating] = useState(false);
  const [installPending, setInstallPending] = useState(false);
  const [kind, setKind] = useState<"github" | "path" | "none">("none");
  const [url, setUrl] = useState("");
  const [directoryId, setDirectoryId] = useState("");
  const [subpath, setSubpath] = useState("");
  const [level, setLevel] = useState<UpdateLevel>("off");
  const [interval, setInterval_] = useState("24");
  const [acknowledge, setAcknowledge] = useState(false);
  const [registry, setRegistry] = useState(false);
  function adopt(next: UpdatesView) {
    setView(next);
    setKind(next.source?.kind ?? "none");
    setUrl(next.source?.kind === "github" ? next.source.url : "");
    setDirectoryId(
      next.source?.kind === "path"
        ? next.source.directoryId
        : (next.directories[0]?.id ?? ""),
    );
    setSubpath(next.source?.kind === "path" ? next.source.subpath : "");
    setLevel(next.settings.level);
    setInterval_(String(next.settings.intervalHours));
    setAcknowledge(false);
    setRegistry(next.settings.autoApproveRegistry);
  }
  useEffect(() => {
    const controller = new AbortController();
    port.get(courseId, controller.signal).then(adopt, (cause) => {
      if (!controller.signal.aborted) setError(message(cause, t));
    });
    return () => controller.abort();
  }, [port, courseId]);
  async function run(action: () => Promise<void>) {
    setPending(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (cause) {
      setError(message(cause, t));
    } finally {
      setPending(false);
    }
  }
  const saveSource = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      adopt(
        await port.saveSource(
          courseId,
          view!.revision,
          kind === "github"
            ? { kind, url: url.trim() }
            : kind === "path"
              ? { kind, directoryId, subpath: subpath.trim() }
              : { kind: "none" },
        ),
      );
      setCheck(undefined);
      setNotice(
        kind === "none"
          ? t("courseUpdates.notice.sourceRemoved")
          : t("courseUpdates.notice.sourceSaved"),
      );
    });
  };
  const saveSettings = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      adopt(
        await port.saveSettings(courseId, {
          expectedRevision: view!.revision,
          level,
          intervalHours: Number(interval),
          ...(level === "publish"
            ? { acknowledgePublish: acknowledge, autoApproveRegistry: registry }
            : {}),
        }),
      );
      setNotice(t("courseUpdates.notice.settingsSaved"));
    });
  };
  const checkNow = () =>
    void run(async () => {
      const result = await port.check(courseId);
      setView(result.updates);
      setCheck(result.outcome);
      setNotice(
        result.outcome.result === "up_to_date"
          ? t("courseUpdates.notice.upToDate", {
              version: result.outcome.version,
            })
          : result.outcome.result === "update_available"
            ? t("courseUpdates.notice.available", {
                version: result.outcome.version,
              })
            : "",
      );
      if (result.outcome.result === "failed")
        setError(packageMessage(result.outcome.code, t));
    });
  if (!view)
    return (
      <Card
        title={t("courseUpdates.title")}
        eyebrow={t("courseUpdates.eyebrow")}
      >
        {error ? (
          <Notice tone="red">{error}</Notice>
        ) : (
          <p>{t("courseUpdates.loading")}</p>
        )}
      </Card>
    );
  const canConfigure = view.permissions.configure;
  const status = view.status;
  function lastCheck() {
    const error = status?.lastErrorCode
      ? packageMessage(status.lastErrorCode, t)
      : undefined;
    if (!status?.lastCheckedAt)
      return error
        ? t("courseUpdates.facts.neverWithError", { error })
        : t("courseUpdates.facts.never");
    const params = {
      when: when(status.lastCheckedAt),
      trigger: status.lastTrigger === "automatic" ? "automatic" : "manual",
      result: resultLabel(status.lastResult),
    };
    return error
      ? t("courseUpdates.facts.lastCheck.valueWithError", { ...params, error })
      : t("courseUpdates.facts.lastCheck.value", params);
  }
  return (
    <Card title={t("courseUpdates.title")} eyebrow={t("courseUpdates.eyebrow")}>
      {notice && <Notice tone="green">{notice}</Notice>}
      {error && (
        <Notice tone="red" title={t("courseUpdates.notCompleted")}>
          {error}
        </Notice>
      )}
      {status?.availableVersion &&
        status.lastResult === "update_available" &&
        !check && (
          <Notice tone="gold" title={t("courseUpdates.banner.title")}>
            {t("courseUpdates.banner.body", {
              version: status.availableVersion,
            })}
          </Notice>
        )}
      <dl className="facts vertical">
        <div>
          <dt>{t("courseUpdates.facts.newestInstalled")}</dt>
          <dd dir={view.newestInstalled ? "ltr" : undefined}>
            {view.newestInstalled ?? t("courseUpdates.facts.none")}
          </dd>
        </div>
        <div>
          <dt>{t("courseUpdates.facts.lastCheck")}</dt>
          <dd>{lastCheck()}</dd>
        </div>
        {status?.nextCheckAt && (
          <div>
            <dt>{t("courseUpdates.facts.nextCheck")}</dt>
            <dd>
              {status.consecutiveFailures
                ? t("courseUpdates.facts.nextCheck.afterFailures", {
                    when: when(status.nextCheckAt),
                    count: status.consecutiveFailures,
                  })
                : when(status.nextCheckAt)}
            </dd>
          </div>
        )}
      </dl>
      <form className="stack" onSubmit={saveSource}>
        <fieldset className="segmented">
          <legend>{t("courseUpdates.source.legend")}</legend>
          {(["github", "path", "none"] as const).map((value) => (
            <label key={value}>
              <input
                type="radio"
                name={`${id}-kind`}
                checked={kind === value}
                disabled={
                  pending ||
                  !canConfigure ||
                  (value === "path" && !view.directories.length) ||
                  (value === "github" && view.remoteFetch === "off")
                }
                onChange={() => setKind(value)}
              />
              {t(`courseUpdates.source.${value}`)}
            </label>
          ))}
        </fieldset>
        {kind === "github" && (
          <Field
            label={t("courseUpdates.github.label")}
            htmlFor={`${id}-url`}
            hint={t("courseUpdates.github.hint")}
          >
            <input
              id={`${id}-url`}
              aria-describedby={`${id}-url-hint`}
              type="url"
              dir="ltr"
              autoComplete="off"
              spellCheck={false}
              value={url}
              disabled={pending || !canConfigure}
              onChange={(e) => setUrl(e.target.value)}
            />
          </Field>
        )}
        {kind === "path" && (
          <>
            <Field
              label={t("courseUpdates.directory.label")}
              htmlFor={`${id}-directory`}
              hint={t("courseUpdates.directory.hint")}
            >
              <select
                id={`${id}-directory`}
                aria-describedby={`${id}-directory-hint`}
                value={directoryId}
                disabled={pending || !canConfigure}
                onChange={(e) => setDirectoryId(e.target.value)}
              >
                {view.directories.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label={t("courseUpdates.subpath.label")}
              htmlFor={`${id}-subpath`}
              hint={t("courseUpdates.subpath.hint")}
            >
              <input
                id={`${id}-subpath`}
                aria-describedby={`${id}-subpath-hint`}
                dir="ltr"
                autoComplete="off"
                spellCheck={false}
                value={subpath}
                disabled={pending || !canConfigure}
                onChange={(e) => setSubpath(e.target.value)}
              />
            </Field>
          </>
        )}
        {kind === "path" && !view.directories.length && (
          <small>{t("courseUpdates.noDirectories")}</small>
        )}
        <div className="button-row">
          <Button type="submit" disabled={pending || !canConfigure}>
            {t("courseUpdates.saveSource")}
          </Button>
          <Button
            kind="primary"
            type="button"
            disabled={pending || !canConfigure || !view.source}
            onClick={checkNow}
          >
            {pending
              ? t("courseUpdates.checking")
              : t("courseUpdates.checkNow")}
          </Button>
        </div>
      </form>
      {check?.result === "update_available" && (
        <section
          className="stack"
          aria-label={t("courseUpdates.available.label", {
            version: check.version,
          })}
        >
          <h3>
            {t("courseUpdates.available.heading", { version: check.version })}
          </h3>
          <p>
            {check.newestInstalled
              ? `${t("courseUpdates.available.newestInstalled", {
                  version: check.newestInstalled,
                })} `
              : ""}
            {check.preview.problems.some((p) => p.severity === "blocking") ? (
              <Badge tone="red">{t("courseUpdates.available.blocking")}</Badge>
            ) : (
              <Badge tone="green">
                {t("courseUpdates.available.installable")}
              </Badge>
            )}
          </p>
          {check.diff && (
            <div>
              <h4>
                {t("courseUpdates.diff.heading", {
                  version: check.diff.from.version,
                })}
              </h4>
              {check.diff.identical ? (
                <p>{t("courseUpdates.diff.identical")}</p>
              ) : (
                <ul className="plain-list">
                  {Object.entries(check.diff.kinds)
                    .filter(
                      ([, k]) =>
                        k.added.length + k.removed.length + k.changed.length,
                    )
                    .map(([name, k]) => (
                      <li key={name}>
                        {i18n.rich(
                          "courseUpdates.diff.kind",
                          {
                            name,
                            added: k.added.length,
                            changed: k.changed.length,
                            removed: k.removed.length,
                          },
                          {
                            name: (children, key) => (
                              <strong key={key}>{children}</strong>
                            ),
                          },
                        )}
                      </li>
                    ))}
                </ul>
              )}
            </div>
          )}
          <Button
            kind="primary"
            disabled={pending || !view.permissions.install}
            onClick={() => setUpdating(true)}
          >
            {t("courseUpdates.updateTo", { version: check.version })}
          </Button>
          {!view.permissions.install && (
            <small>{t("courseUpdates.installRole")}</small>
          )}
        </section>
      )}
      <form className="stack" onSubmit={saveSettings}>
        <h3>{t("courseUpdates.auto.heading")}</h3>
        <Field
          label={t("courseUpdates.auto.level.label")}
          htmlFor={`${id}-level`}
          hint={t("courseUpdates.auto.level.hint")}
        >
          <select
            id={`${id}-level`}
            aria-describedby={`${id}-level-hint`}
            value={level}
            disabled={pending || !canConfigure || !view.source}
            onChange={(e) => {
              setLevel(e.target.value as UpdateLevel);
              setAcknowledge(false);
            }}
          >
            {levels.map((value) => (
              <option
                key={value}
                value={value}
                disabled={
                  (value === "install" && !view.permissions.install) ||
                  (value === "publish" && !view.permissions.publish)
                }
              >
                {t(`courseUpdates.level.${value}`)}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label={t("courseUpdates.auto.interval.label")}
          htmlFor={`${id}-interval`}
          hint={t("courseUpdates.auto.interval.hint")}
        >
          <input
            id={`${id}-interval`}
            aria-describedby={`${id}-interval-hint`}
            type="number"
            min={1}
            max={720}
            step={1}
            value={interval}
            disabled={pending || !canConfigure || !view.source}
            onChange={(e) => setInterval_(e.target.value)}
          />
        </Field>
        {level === "publish" && (
          <div className="stack">
            <label className="check-label">
              <input
                type="checkbox"
                checked={acknowledge}
                disabled={pending}
                onChange={(e) => setAcknowledge(e.target.checked)}
              />
              {t("courseUpdates.auto.acknowledge")}
            </label>
            <label className="check-label">
              <input
                type="checkbox"
                checked={registry}
                disabled={pending}
                onChange={(e) => setRegistry(e.target.checked)}
              />
              {t("courseUpdates.auto.registry")}
            </label>
          </div>
        )}
        <Button
          type="submit"
          disabled={
            pending ||
            !canConfigure ||
            !view.source ||
            (level === "publish" && !acknowledge)
          }
        >
          {t("courseUpdates.auto.save")}
        </Button>
        {view.settings.level === "publish" && view.settings.acknowledgedBy && (
          <small>
            {t("courseUpdates.auto.authorizedBy", {
              name: view.settings.acknowledgedBy,
            })}
          </small>
        )}
      </form>
      {updating && check?.result === "update_available" && (
        <Dialog
          title={t("courseUpdates.updateTo", { version: check.version })}
          eyebrow={t("courseUpdates.dialog.eyebrow")}
          className="install-dialog"
          pending={installPending}
          onClose={() => setUpdating(false)}
        >
          <InstallCourse
            client={client}
            workspaceId={workspaceId}
            initialPreview={check.preview}
            onPendingChange={setInstallPending}
            onFinished={(catalogId) => {
              setUpdating(false);
              setCheck(undefined);
              void port.get(courseId).then(adopt, () => undefined);
              onInstalled(catalogId);
            }}
          />
        </Dialog>
      )}
    </Card>
  );
}
