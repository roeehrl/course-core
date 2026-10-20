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
import { Badge, Button, Card, Dialog, Field, Notice, when } from "./ui";

const levels: { value: UpdateLevel; label: string }[] = [
  { value: "off", label: "Off — only manual checks" },
  { value: "check", label: "Check — show “Update available”, install nothing" },
  {
    value: "install",
    label: "Install — install new versions as drafts in review",
  },
  {
    value: "publish",
    label: "Publish — also approve and publish new versions",
  },
];
const resultText: Record<string, string> = {
  up_to_date: "Up to date",
  update_available: "Update available",
  installed: "Installed as a draft in review",
  published: "Installed and published",
  failed: "Check failed",
};
const message = (error: unknown) =>
  error instanceof CoursePackageError
    ? packageMessage(error.code)
    : errorMessage(error);

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
      if (!controller.signal.aborted) setError(message(cause));
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
      setError(message(cause));
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
          ? "Update source removed."
          : "Update source saved. Automatic updates are off until you choose a level.",
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
      setNotice("Automatic update setting saved.");
    });
  };
  const checkNow = () =>
    void run(async () => {
      const result = await port.check(courseId);
      setView(result.updates);
      setCheck(result.outcome);
      setNotice(
        result.outcome.result === "up_to_date"
          ? `Up to date: the newest version at the source is ${result.outcome.version}.`
          : result.outcome.result === "update_available"
            ? `Version ${result.outcome.version} is available.`
            : "",
      );
      if (result.outcome.result === "failed")
        setError(packageMessage(result.outcome.code));
    });
  if (!view)
    return (
      <Card title="Updates" eyebrow="Course updater">
        {error ? (
          <Notice tone="red">{error}</Notice>
        ) : (
          <p>Loading update settings…</p>
        )}
      </Card>
    );
  const canConfigure = view.permissions.configure;
  const status = view.status;
  return (
    <Card title="Updates" eyebrow="Course updater">
      {notice && <Notice tone="green">{notice}</Notice>}
      {error && (
        <Notice tone="red" title="Not completed">
          {error}
        </Notice>
      )}
      {status?.availableVersion &&
        status.lastResult === "update_available" &&
        !check && (
          <Notice tone="gold" title="Update available">
            Version {status.availableVersion} is available at this course's
            update source.
          </Notice>
        )}
      <dl className="facts vertical">
        <div>
          <dt>Newest installed</dt>
          <dd>{view.newestInstalled ?? "None"}</dd>
        </div>
        <div>
          <dt>Last check</dt>
          <dd>
            {status?.lastCheckedAt
              ? `${when(status.lastCheckedAt)} · ${status.lastTrigger === "automatic" ? "automatic" : "manual"} · ${resultText[status.lastResult ?? ""] ?? "—"}`
              : "Never"}
            {status?.lastErrorCode
              ? ` (${packageMessage(status.lastErrorCode)})`
              : ""}
          </dd>
        </div>
        {status?.nextCheckAt && (
          <div>
            <dt>Next automatic check</dt>
            <dd>
              {when(status.nextCheckAt)}
              {status.consecutiveFailures
                ? ` · after ${status.consecutiveFailures} failed attempt${status.consecutiveFailures === 1 ? "" : "s"}`
                : ""}
            </dd>
          </div>
        )}
      </dl>
      <form className="stack" onSubmit={saveSource}>
        <fieldset className="segmented">
          <legend>Update source</legend>
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
              {value === "github"
                ? "GitHub release"
                : value === "path"
                  ? "Host folder"
                  : "None"}
            </label>
          ))}
        </fieldset>
        {kind === "github" && (
          <Field
            label="GitHub link"
            htmlFor={`${id}-url`}
            hint="A public repository (its latest release) or a release tag, for example https://github.com/owner/course."
          >
            <input
              id={`${id}-url`}
              aria-describedby={`${id}-url-hint`}
              type="url"
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
              label="Package directory"
              htmlFor={`${id}-directory`}
              hint="Directories the host operator allowed (pilot coursePackageDirectories)."
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
              label="Folder or file inside it"
              htmlFor={`${id}-subpath`}
              hint="A relative path such as my-course/dist or my-course/dist/my-course-1.2.0.course.tgz. Leave empty for the directory itself."
            >
              <input
                id={`${id}-subpath`}
                aria-describedby={`${id}-subpath-hint`}
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
          <small>No package directories are configured on this host.</small>
        )}
        <div className="button-row">
          <Button type="submit" disabled={pending || !canConfigure}>
            Save update source
          </Button>
          <Button
            kind="primary"
            type="button"
            disabled={pending || !canConfigure || !view.source}
            onClick={checkNow}
          >
            {pending ? "Checking…" : "Check for updates"}
          </Button>
        </div>
      </form>
      {check?.result === "update_available" && (
        <section
          className="stack"
          aria-label={`Update to version ${check.version}`}
        >
          <h3>Version {check.version} is available</h3>
          <p>
            {check.newestInstalled
              ? `Newest installed: ${check.newestInstalled}. `
              : ""}
            {check.preview.problems.some((p) => p.severity === "blocking") ? (
              <Badge tone="red">Blocking problems</Badge>
            ) : (
              <Badge tone="green">Installable</Badge>
            )}
          </p>
          {check.diff && (
            <div>
              <h4>Changes from the live release ({check.diff.from.version})</h4>
              {check.diff.identical ? (
                <p>No content changes.</p>
              ) : (
                <ul className="plain-list">
                  {Object.entries(check.diff.kinds)
                    .filter(
                      ([, k]) =>
                        k.added.length + k.removed.length + k.changed.length,
                    )
                    .map(([name, k]) => (
                      <li key={name}>
                        <strong>{name}</strong>: {k.added.length} added,{" "}
                        {k.changed.length} changed, {k.removed.length} removed
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
            Update to {check.version}
          </Button>
          {!view.permissions.install && (
            <small>An owner or administrator installs updates.</small>
          )}
        </section>
      )}
      <form className="stack" onSubmit={saveSettings}>
        <h3>Automatic updates</h3>
        <Field
          label="Automatic level"
          htmlFor={`${id}-level`}
          hint="Off by default. Existing enrollments always stay on the release they started."
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
            {levels.map((l) => (
              <option
                key={l.value}
                value={l.value}
                disabled={
                  (l.value === "install" && !view.permissions.install) ||
                  (l.value === "publish" && !view.permissions.publish)
                }
              >
                {l.label}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Check every (hours)"
          htmlFor={`${id}-interval`}
          hint="At least 1 hour; 24 by default. Failed checks wait longer each time (up to 7 days)."
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
              I authorize automatic review approval and publication of new
              versions from this source for new learners, as me. It is refused,
              and the version is left as a draft in review, when the check finds
              a blocking problem, a host requirement that is not identical, a
              failing runtime check, a newer required Core or an SDK outside the
              supported range.
            </label>
            <label className="check-label">
              <input
                type="checkbox"
                checked={registry}
                disabled={pending}
                onChange={(e) => setRegistry(e.target.checked)}
              />
              Also approve a packaged recovery registry whose digest differs
              from the registry approved for the live release. Without this,
              only an unchanged registry is approved automatically; a changed
              one waits for an owner or administrator.
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
          Save automatic updates
        </Button>
        {view.settings.level === "publish" && view.settings.acknowledgedBy && (
          <small>
            Automatic publication authorized by {view.settings.acknowledgedBy}.
          </small>
        )}
      </form>
      {updating && check?.result === "update_available" && (
        <Dialog
          title={`Update to ${check.version}`}
          eyebrow="Course update"
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
