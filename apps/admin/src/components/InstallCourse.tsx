import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type RefObject,
} from "react";
import type { AdminClient } from "../domain/contracts";
import {
  CoursePackageError,
  packageMessage,
  type Installation,
  type PackagePreview,
} from "../domain/coursePackages";
import { errorMessage } from "../domain/errors";
import { randomId } from "../domain/webCrypto";
import { Badge, Button, Field, Notice, Status } from "./ui";
import { useI18n, type AdminTranslator, type MessageKey } from "../i18n";

/** An idempotency key from the shared helper, which also works on non-secure origins. */
const newKey = () => `package-${randomId()}`;
/** How long a step runs before the form says it is still working. */
export const SLOW_MS = 8000;
const short = (digest: string) => `${digest.slice(0, 12)}…`;
const megabytes = (i18n: AdminTranslator, bytes: number) =>
  bytes < 1024 * 1024
    ? i18n.t("installCourse.size.kib", {
        size: i18n.number(Math.max(1, Math.round(bytes / 1024))),
      })
    : i18n.t("installCourse.size.mib", {
        size: i18n.number(bytes / 1024 / 1024, {
          minimumFractionDigits: 1,
          maximumFractionDigits: 1,
        }),
      });
type Failure = { message: string; assets?: string[] };
function failure(error: unknown, t: AdminTranslator["t"]): Failure {
  if (error instanceof CoursePackageError)
    return {
      message: packageMessage(error.code, t),
      ...(error.details?.assets?.length
        ? { assets: error.details.assets }
        : {}),
    };
  return { message: errorMessage(error, t) };
}
const existingText: Record<PackagePreview["existing"]["status"], MessageKey> = {
  "new-course": "installCourse.existing.newCourse",
  "new-version": "installCourse.existing.newVersion",
  "already-installed": "installCourse.existing.alreadyInstalled",
  "version-conflict": "installCourse.existing.versionConflict",
};
const hostStatusText: Record<
  PackagePreview["hostRequirements"][number]["status"],
  MessageKey
> = {
  identical: "installCourse.host.identical",
  different: "installCourse.host.different",
  missing: "installCourse.host.missing",
  course_supplied: "installCourse.host.courseSupplied",
};
type SuppliedFile = NonNullable<
  PackagePreview["courseSupplied"]
>["files"][number];
const suppliedKindText: Record<SuppliedFile["kind"], MessageKey> = {
  code_fixtures: "installCourse.supplied.kind.code_fixtures",
  sandboxed_web: "installCourse.supplied.kind.sandboxed_web",
};
const suppliedStatusText: Record<SuppliedFile["status"], MessageKey> = {
  installed: "installCourse.supplied.status.installed",
  approvable: "installCourse.supplied.status.approvable",
  unavailable: "installCourse.supplied.status.unavailable",
};
/** Why a course's file cannot be used here, and what to do. Unknown codes get a generic sentence. */
const suppliedReasonText: Record<string, MessageKey> = {
  NO_SANDBOX: "installCourse.supplied.reason.NO_SANDBOX",
  INVALID_CODE_FIXTURE: "installCourse.supplied.reason.INVALID_CODE_FIXTURE",
  INVALID_SCRIPT: "installCourse.supplied.reason.INVALID_SCRIPT",
  EXTENSION_ID_CONFLICT: "installCourse.supplied.reason.EXTENSION_ID_CONFLICT",
};

/**
 * Install a course from a course-package file or a public GitHub release: inspect (nothing is
 * installed), review the preview, install the draft (submitted for review), then approve,
 * publish and approve the packaged recovery registry here with explicit confirmations.
 */
export function InstallCourse({
  client,
  workspaceId,
  onFinished,
  onPendingChange,
  initialPreview,
}: {
  client: AdminClient;
  workspaceId: string;
  /** Start from an already inspected (staged) package, such as an available update. */
  initialPreview?: PackagePreview;
  /** Close the flow; with the installed course's catalog id when something was installed. */
  onFinished: (catalogId?: string) => void;
  onPendingChange?: (pending: boolean) => void;
}) {
  const i18n = useI18n();
  const t = i18n.t;
  const port = client.coursePackages!;
  const id = useId();
  const [source, setSource] = useState<"file" | "github">("file");
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState("");
  const [assets, setAssets] = useState<string[]>([]);
  const [asset, setAsset] = useState("");
  const [preview, setPreview] = useState<PackagePreview | undefined>(
    initialPreview,
  );
  const [installation, setInstallation] = useState<Installation>();
  const [alreadyReleaseId, setAlreadyReleaseId] = useState<string>();
  const [error, setError] = useState<Failure>();
  const [status, setStatus] = useState("");
  const [pending, setPending] = useState(false);
  const [notes, setNotes] = useState("");
  const [publishNow, setPublishNow] = useState(false);
  const [confirmVersion, setConfirmVersion] = useState("");
  const [approveRegistryNow, setApproveRegistryNow] = useState(false);
  const [approveSupplied, setApproveSupplied] = useState(false);
  // Installing a version older than the newest installed one is an explicit choice.
  const [confirmOlder, setConfirmOlder] = useState(false);
  const installKey = useRef(newKey());
  const previewHeading = useRef<HTMLHeadingElement>(null);
  const stepsHeading = useRef<HTMLHeadingElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  useEffect(() => onPendingChange?.(pending), [pending, onPendingChange]);
  // A slow connection: after a while, say that the step is still running.
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    if (!pending) return;
    const timer = setTimeout(() => setSlow(true), SLOW_MS);
    return () => clearTimeout(timer);
  }, [pending]);
  // After the enclosing dialog has opened (its showModal focuses its first control), move focus.
  useEffect(() => {
    if (!preview || installation) return;
    const frame = requestAnimationFrame(() => previewHeading.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [preview, installation]);
  useEffect(() => {
    if (installation) stepsHeading.current?.focus();
  }, [installation?.releaseId]);
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  function resetPreview() {
    setPreview(undefined);
    setError(undefined);
    setStatus("");
    setPublishNow(false);
    setConfirmVersion("");
    setApproveRegistryNow(false);
    setApproveSupplied(false);
    setConfirmOlder(false);
    installKey.current = newKey();
  }
  async function inspect(event: FormEvent) {
    event.preventDefault();
    resetPreview();
    if (source === "file" && !file)
      return setError({ message: t("installCourse.validate.noFile") });
    if (source === "github" && !url.trim())
      return setError({ message: t("installCourse.validate.noUrl") });
    setPending(true);
    setStatus(
      source === "file"
        ? t("installCourse.status.checkingFile")
        : t("installCourse.status.downloading"),
    );
    try {
      const result =
        source === "file"
          ? await port.inspectFile(workspaceId, file!)
          : await port.inspectUrl(workspaceId, url.trim(), asset || undefined);
      setPreview(result);
      setAssets([]);
      const blocking = result.problems.filter(
        (p) => p.severity === "blocking",
      ).length;
      setStatus(
        t("installCourse.status.checked", {
          title: result.course.title,
          version: result.course.version,
          blocking,
        }),
      );
    } catch (cause) {
      const failed = failure(cause, t);
      if (failed.assets) {
        setAssets(failed.assets);
        setAsset("");
      }
      setError(failed);
      setStatus(t("installCourse.status.checkFailed"));
    } finally {
      setPending(false);
    }
  }
  async function install(event: FormEvent) {
    event.preventDefault();
    if (!preview) return;
    setPending(true);
    setError(undefined);
    setStatus(t("installCourse.status.installing"));
    try {
      const result = await port.install(preview.sha256, {
        workspaceId,
        idempotencyKey: installKey.current,
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        ...(publishNow ? { approveAndPublish: { confirmVersion } } : {}),
        ...(older && confirmOlder
          ? { confirmOlderVersion: true as const }
          : {}),
        ...(approveSupplied && suppliedApproval.length
          ? { approveCourseSupplied: { integrities: suppliedApproval } }
          : {}),
        ...(approveRegistryNow && preview.registry.present
          ? {
              approveRegistry: { configurationDigest: preview.registry.digest },
            }
          : {}),
      });
      if (result.installation) {
        setInstallation(result.installation);
        // Each part is a complete sentence of its own.
        const sentences = [
          result.alreadyInstalled
            ? t("installCourse.status.packageAlreadyInstalled")
            : t("installCourse.status.versionInstalled", {
                version: result.installation.course.version,
              }),
          t("installCourse.status.state", {
            state: result.installation.state,
          }),
        ];
        if (result.registryApproval)
          sentences.push(
            result.registryApproval.approved
              ? t("installCourse.status.registryApproved")
              : t("installCourse.status.registryNotApproved", {
                  reason: packageMessage(result.registryApproval.code, t),
                }),
          );
        setStatus(sentences.join(" "));
      } else {
        setAlreadyReleaseId(result.releaseId);
        setStatus(t("installCourse.status.versionAlreadyInWorkspace"));
      }
    } catch (cause) {
      setError(failure(cause, t));
      setStatus(t("installCourse.status.notInstalled"));
    } finally {
      setPending(false);
    }
  }
  async function step(run: () => Promise<unknown>, done: string) {
    if (!installation) return;
    setPending(true);
    setError(undefined);
    try {
      await run();
      const next = await port.installation(installation.releaseId);
      setInstallation(next);
      setStatus(done);
    } catch (cause) {
      setError(failure(cause, t));
      setStatus(t("installCourse.status.stepFailed"));
    } finally {
      setPending(false);
    }
  }
  const transition = (action: "approve" | "publish") => {
    const context = {
      expectedRevision: installation!.catalogRevision,
      idempotencyKey: newKey(),
    };
    const { catalogId, releaseId } = installation!;
    // The older version was already confirmed at install; publishing it says so again.
    return action === "publish" && confirmOlder
      ? client.transitionRelease(catalogId, releaseId, action, context, {
          confirmOlderVersion: true,
        })
      : client.transitionRelease(catalogId, releaseId, action, context);
  };

  const blocking =
    preview?.problems.filter((p) => p.severity === "blocking") ?? [];
  const warnings =
    preview?.problems.filter((p) => p.severity === "warning") ?? [];
  const older =
    preview?.problems.some((p) => p.code === "OLDER_THAN_INSTALLED") ?? false;
  const confirmMatches = preview
    ? confirmVersion === preview.course.version
    : false;
  const supplied = preview?.courseSupplied?.files ?? [];
  const suppliedApproval = preview?.courseSupplied?.approvalRequired ?? [];
  return (
    <div className="stack install-course">
      <p className="sr-only" role="status" aria-live="polite">
        {status}
      </p>
      {pending && slow && <Notice>{t("installCourse.status.slow")}</Notice>}
      {!installation && !alreadyReleaseId && !initialPreview && (
        <form
          className="stack"
          onSubmit={(e) => void inspect(e)}
          aria-describedby={`${id}-help`}
        >
          <p id={`${id}-help`}>{t("installCourse.help")}</p>
          <fieldset className="segmented">
            <legend>{t("installCourse.source.legend")}</legend>
            <label>
              <input
                type="radio"
                name={`${id}-source`}
                checked={source === "file"}
                disabled={pending}
                onChange={() => {
                  setSource("file");
                  resetPreview();
                }}
              />
              {t("installCourse.source.upload")}
            </label>
            <label>
              <input
                type="radio"
                name={`${id}-source`}
                checked={source === "github"}
                disabled={pending}
                onChange={() => {
                  setSource("github");
                  resetPreview();
                }}
              />
              {t("installCourse.source.github")}
            </label>
          </fieldset>
          {source === "file" ? (
            <Field
              label={t("installCourse.file.label")}
              htmlFor={`${id}-file`}
              hint={t("installCourse.file.hint")}
            >
              <input
                id={`${id}-file`}
                aria-describedby={`${id}-file-hint`}
                type="file"
                accept=".tgz,.course.tgz,application/gzip"
                disabled={pending}
                onChange={(e) => {
                  setFile(e.target.files?.[0] ?? null);
                  resetPreview();
                }}
              />
            </Field>
          ) : (
            <>
              <Field
                label={t("installCourse.url.label")}
                htmlFor={`${id}-url`}
                hint={t("installCourse.url.hint")}
              >
                <input
                  id={`${id}-url`}
                  aria-describedby={`${id}-url-hint`}
                  type="url"
                  dir="ltr"
                  inputMode="url"
                  autoComplete="off"
                  spellCheck={false}
                  value={url}
                  disabled={pending}
                  placeholder="https://github.com/owner/course"
                  onChange={(e) => {
                    setUrl(e.target.value);
                    setAssets([]);
                    setAsset("");
                    resetPreview();
                  }}
                />
              </Field>
              {assets.length > 0 && (
                <Field
                  label={t("installCourse.asset.label")}
                  htmlFor={`${id}-asset`}
                  hint={t("installCourse.asset.hint")}
                >
                  <select
                    id={`${id}-asset`}
                    value={asset}
                    disabled={pending}
                    onChange={(e) => setAsset(e.target.value)}
                  >
                    <option value="">{t("installCourse.asset.choose")}</option>
                    {assets.map((name) => (
                      <option key={name} value={name} dir="ltr">
                        {name}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
            </>
          )}
          <Button
            kind="primary"
            type="submit"
            disabled={pending || (assets.length > 0 && !asset)}
          >
            {pending && !preview
              ? t("installCourse.inspect.pending")
              : t("installCourse.inspect.submit")}
          </Button>
        </form>
      )}
      {error && (
        <div ref={errorRef} tabIndex={-1}>
          <Notice tone="red" title={t("installCourse.error.title")}>
            {error.message}
          </Notice>
        </div>
      )}
      {preview && !installation && !alreadyReleaseId && (
        <section className="stack" aria-labelledby={`${id}-preview`}>
          <h3 id={`${id}-preview`} ref={previewHeading} tabIndex={-1}>
            {i18n.rich(
              "installCourse.preview.heading",
              { title: preview.course.title, version: preview.course.version },
              {
                title: (children, key) => (
                  <bdi key={key} dir="auto">
                    {children}
                  </bdi>
                ),
                version: (children, key) => (
                  <bdi key={key} dir="ltr">
                    {children}
                  </bdi>
                ),
              },
            )}
          </h3>
          {blocking.length > 0 && (
            <Notice
              tone="red"
              title={t("installCourse.blocking.title", {
                count: blocking.length,
              })}
            >
              <ul className="plain-list">
                {blocking.map((p) => (
                  <li key={p.code}>
                    <ProblemText problem={p} />
                  </li>
                ))}
              </ul>
            </Notice>
          )}
          {warnings.length > 0 && (
            <Notice
              tone="gold"
              title={t("installCourse.warnings.title", {
                count: warnings.length,
              })}
            >
              <ul className="plain-list">
                {warnings.map((p, i) => (
                  <li key={`${p.code}-${i}`}>
                    <ProblemText problem={p} />
                  </li>
                ))}
              </ul>
            </Notice>
          )}
          <dl className="facts vertical">
            <div>
              <dt>{t("installCourse.fact.course")}</dt>
              <dd dir="ltr">{preview.course.id}</dd>
            </div>
            <div>
              <dt>{t("installCourse.fact.courseDigest")}</dt>
              <dd>
                <code dir="ltr">{preview.course.digest}</code>
              </dd>
            </div>
            <div>
              <dt>{t("installCourse.fact.package")}</dt>
              <dd>
                <code dir="ltr">{short(preview.sha256)}</code> ·{" "}
                <bdi dir="ltr">{megabytes(i18n, preview.compressedBytes)}</bdi>
              </dd>
            </div>
            <div>
              <dt>{t("installCourse.fact.source")}</dt>
              <dd>
                {preview.packageSource.kind === "github"
                  ? t(
                      preview.packageSource.checksumVerified
                        ? "installCourse.sourceFact.githubVerified"
                        : "installCourse.sourceFact.githubUnverified",
                      {
                        repository: `${preview.packageSource.owner}/${preview.packageSource.repo}`,
                        tag: preview.packageSource.tag,
                        asset: preview.packageSource.asset,
                      },
                    )
                  : preview.packageSource.kind === "path"
                    ? t("installCourse.sourceFact.hostFolder", {
                        path: [
                          preview.packageSource.directory,
                          preview.packageSource.subpath,
                          preview.packageSource.file,
                        ]
                          .filter(Boolean)
                          .join("/"),
                      })
                    : t("installCourse.sourceFact.upload")}
              </dd>
            </div>
            <div>
              <dt>{t("installCourse.fact.inWorkspace")}</dt>
              <dd>
                {t(existingText[preview.existing.status])}
                {preview.existing.newestVersion && (
                  <>
                    {" "}
                    {t("installCourse.existing.newest", {
                      version: preview.existing.newestVersion,
                    })}
                  </>
                )}
              </dd>
            </div>
            <div>
              <dt>{t("installCourse.fact.sdk")}</dt>
              <dd>
                {t("installCourse.sdk.detail", {
                  version: preview.sdk.packageVersion,
                  min: preview.sdk.supported.min,
                  max: preview.sdk.supported.maxExclusive,
                })}{" "}
                <Status
                  value={
                    preview.sdk.status === "supported"
                      ? "supported"
                      : preview.sdk.status === "unsupported" ||
                          preview.sdk.status === "below_minimum"
                        ? "blocked"
                        : "warning"
                  }
                />
              </dd>
            </div>
            <div>
              <dt>{t("installCourse.fact.coreVersion")}</dt>
              <dd>
                {t("installCourse.core.detail", {
                  minimum: preview.core.minimumVersion,
                  version: preview.core.version,
                })}{" "}
                <Status
                  value={preview.core.satisfied ? "eligible" : "blocked"}
                />
              </dd>
            </div>
            <div>
              <dt>{t("installCourse.fact.runtime")}</dt>
              <dd>
                {preview.runtime.runnable
                  ? t("installCourse.runtime.runnable")
                  : t("installCourse.runtime.notRunnable", {
                      code: preview.runtime.code ?? "",
                    })}
              </dd>
            </div>
            <div>
              <dt>{t("installCourse.fact.registry")}</dt>
              <dd>
                {preview.registry.present
                  ? preview.registry.approvable
                    ? t("installCourse.registry.summary", {
                        count: preview.registry.profileCount,
                        digest: short(preview.registry.digest),
                      })
                    : t("installCourse.registry.summaryNotApprovable", {
                        count: preview.registry.profileCount,
                        digest: short(preview.registry.digest),
                        code: preview.registry.code ?? "",
                      })
                  : t("installCourse.registry.none")}
              </dd>
            </div>
          </dl>
          <div>
            <h4>{t("installCourse.host.heading")}</h4>
            {preview.hostRequirements.length ? (
              <ul className="plain-list host-requirements">
                {preview.hostRequirements.map((r) => (
                  <li key={r.name}>
                    <span>
                      <strong dir="ltr">{r.name}</strong>{" "}
                      <code dir="ltr">{short(r.sha256)}</code>
                    </span>
                    <Badge
                      tone={
                        r.status === "identical"
                          ? "green"
                          : r.status === "different"
                            ? "gold"
                            : "red"
                      }
                    >
                      {t(hostStatusText[r.status])}
                    </Badge>
                  </li>
                ))}
              </ul>
            ) : (
              <p>{t("installCourse.host.none")}</p>
            )}
          </div>
          {supplied.length > 0 && (
            <div className="stack">
              <h4>{t("installCourse.supplied.heading")}</h4>
              <p>{t("installCourse.supplied.explain")}</p>
              <ul className="plain-list host-requirements">
                {supplied.map((file) => (
                  <li key={file.integrity}>
                    <span>
                      <strong>{t(suppliedKindText[file.kind])}</strong>{" "}
                      <bdi dir="ltr">{file.member}</bdi>{" "}
                      <code dir="ltr">{short(file.integrity.slice(7))}</code>
                      {file.status === "unavailable" && (
                        <span className="muted">
                          {" "}
                          {t(
                            (file.code && suppliedReasonText[file.code]) ||
                              "installCourse.supplied.reason.other",
                          )}
                        </span>
                      )}
                    </span>
                    <Badge
                      tone={
                        file.status === "installed"
                          ? "green"
                          : file.status === "approvable"
                            ? "gold"
                            : "red"
                      }
                    >
                      {t(suppliedStatusText[file.status])}
                    </Badge>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <details>
            <summary>
              {t("installCourse.files.summary", {
                count: preview.members.length + 1,
              })}
            </summary>
            <ul className="plain-list">
              {preview.members.map((m) => (
                <li key={m.name}>
                  {t("installCourse.files.member", {
                    name: m.name,
                    role: m.role,
                    bytes: m.bytes,
                  })}
                </li>
              ))}
            </ul>
          </details>
          {preview.existing.status !== "already-installed" && (
            <form className="stack" onSubmit={(e) => void install(e)}>
              <Field
                label={t("installCourse.notes.label")}
                htmlFor={`${id}-notes`}
                hint={t("installCourse.notes.hint")}
              >
                <textarea
                  id={`${id}-notes`}
                  dir="auto"
                  maxLength={1200}
                  value={notes}
                  disabled={pending}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </Field>
              {older && (
                <Notice tone="gold" title={t("installCourse.older.title")}>
                  <p>
                    {t("installCourse.older.body", {
                      version: preview.course.version,
                      newest: preview.existing.newestVersion ?? "",
                    })}
                  </p>
                  <label className="check-label">
                    <input
                      type="checkbox"
                      checked={confirmOlder}
                      disabled={pending || !preview.installable}
                      onChange={(e) => setConfirmOlder(e.target.checked)}
                    />
                    {t("installCourse.older.label", {
                      version: preview.course.version,
                    })}
                  </label>
                </Notice>
              )}
              {preview.permissions.approveAndPublish && (
                <div className="stack">
                  <label className="check-label">
                    <input
                      type="checkbox"
                      checked={publishNow}
                      disabled={pending || !preview.installable}
                      onChange={(e) => {
                        setPublishNow(e.target.checked);
                        setConfirmVersion("");
                      }}
                    />
                    {t("installCourse.publishNow.label")}
                  </label>
                  {publishNow && (
                    <Field
                      label={t("installCourse.confirm.label", {
                        version: preview.course.version,
                      })}
                      htmlFor={`${id}-confirm`}
                      hint={t("installCourse.confirm.hint")}
                    >
                      <input
                        id={`${id}-confirm`}
                        dir="ltr"
                        aria-describedby={`${id}-confirm-hint`}
                        autoComplete="off"
                        spellCheck={false}
                        value={confirmVersion}
                        disabled={pending}
                        onChange={(e) => setConfirmVersion(e.target.value)}
                      />
                    </Field>
                  )}
                </div>
              )}
              {suppliedApproval.length > 0 && (
                <label className="check-label">
                  <input
                    type="checkbox"
                    checked={approveSupplied}
                    disabled={pending || !preview.installable}
                    onChange={(e) => setApproveSupplied(e.target.checked)}
                  />
                  {t("installCourse.supplied.approve", {
                    count: suppliedApproval.length,
                  })}
                </label>
              )}
              {preview.registry.present &&
                preview.registry.approvable &&
                preview.permissions.approveRegistry && (
                  <label className="check-label">
                    <input
                      type="checkbox"
                      checked={approveRegistryNow}
                      disabled={pending || !preview.installable}
                      onChange={(e) => setApproveRegistryNow(e.target.checked)}
                    />
                    {t("installCourse.approveRegistryNow.label", {
                      digest: short(preview.registry.digest),
                    })}
                  </label>
                )}
              <div className="button-row">
                <Button
                  kind="primary"
                  type="submit"
                  disabled={
                    pending ||
                    !preview.installable ||
                    (older && !confirmOlder) ||
                    (suppliedApproval.length > 0 && !approveSupplied) ||
                    (publishNow && !confirmMatches)
                  }
                >
                  {pending
                    ? t("installCourse.submit.installing")
                    : publishNow
                      ? t("installCourse.submit.installAndPublish")
                      : t("installCourse.submit.install")}
                </Button>
                {!initialPreview && (
                  <Button
                    type="button"
                    disabled={pending}
                    onClick={() => resetPreview()}
                  >
                    {t("installCourse.chooseAnother")}
                  </Button>
                )}
              </div>
              {!preview.installable && (
                <small>{t("installCourse.resolveBlocking")}</small>
              )}
            </form>
          )}
          {preview.existing.status === "already-installed" && (
            <Notice tone="green" title={t("installCourse.already.title")}>
              {t("installCourse.already.nothingToInstall")}
            </Notice>
          )}
        </section>
      )}
      {alreadyReleaseId && (
        <Notice tone="green" title={t("installCourse.already.title")}>
          {t("installCourse.already.body")}
        </Notice>
      )}
      {installation && (
        <InstallationSteps
          installation={installation}
          pending={pending}
          headingRef={stepsHeading}
          onApprove={() =>
            void step(
              () => transition("approve"),
              t("installCourse.status.approved"),
            )
          }
          onPublish={() =>
            void step(
              () => transition("publish"),
              t("installCourse.status.published", {
                version: installation.course.version,
              }),
            )
          }
          onApproveRegistry={() =>
            installation.registry.present &&
            void step(
              () =>
                port.approveRegistry(installation.releaseId, {
                  configurationDigest: installation.registry.present
                    ? installation.registry.digest
                    : "",
                  expectedRegistryRevision: installation.registry.present
                    ? installation.registry.registryRevision
                    : 0,
                }),
              t("installCourse.status.registryApprovedForRelease"),
            )
          }
        />
      )}
      {(installation || alreadyReleaseId) && (
        <Button
          kind="primary"
          disabled={pending}
          onClick={() => onFinished(installation?.catalogId)}
        >
          {installation
            ? t("installCourse.done.open")
            : t("installCourse.done.close")}
        </Button>
      )}
    </div>
  );
}

function InstallationSteps({
  installation,
  pending,
  headingRef,
  onApprove,
  onPublish,
  onApproveRegistry,
}: {
  installation: Installation;
  pending: boolean;
  headingRef: RefObject<HTMLHeadingElement | null>;
  onApprove: () => void;
  onPublish: () => void;
  onApproveRegistry: () => void;
}) {
  const t = useI18n().t;
  const id = useId();
  const [publishConsent, setPublishConsent] = useState(false);
  const [registryConsent, setRegistryConsent] = useState(false);
  const { state, course, registry, permissions } = installation;
  return (
    <section className="stack" aria-labelledby={`${id}-steps`}>
      <h3 id={`${id}-steps`} ref={headingRef} tabIndex={-1}>
        {t("installCourse.steps.heading", { version: course.version })}
      </h3>
      <p>
        <Status value={state} />{" "}
        {installation.availableForNewLearners && (
          <Badge tone="green">{t("installCourse.steps.availableToNew")}</Badge>
        )}
      </p>
      <ol className="install-steps">
        <li>
          <strong>{t("installCourse.steps.review")}</strong>
          {state === "pending_review" ? (
            permissions.approve ? (
              <Button kind="primary" disabled={pending} onClick={onApprove}>
                {pending
                  ? t("installCourse.steps.recording")
                  : t("installCourse.steps.approve")}
              </Button>
            ) : (
              <small>{t("installCourse.steps.reviewerMustApprove")}</small>
            )
          ) : (
            <small>
              {state === "draft"
                ? t("installCourse.steps.notSubmitted")
                : t("installCourse.steps.approvedDigest")}
            </small>
          )}
        </li>
        <li>
          <strong>{t("installCourse.steps.publish")}</strong>
          {state === "approved" ? (
            permissions.publish ? (
              <form
                className="stack"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (publishConsent) onPublish();
                }}
              >
                <label className="check-label">
                  <input
                    type="checkbox"
                    checked={publishConsent}
                    disabled={pending}
                    onChange={(e) => setPublishConsent(e.target.checked)}
                  />
                  {t("installCourse.steps.confirmPublish", {
                    version: course.version,
                  })}
                </label>
                <Button
                  kind="primary"
                  type="submit"
                  disabled={!publishConsent || pending}
                >
                  {pending
                    ? t("installCourse.steps.recording")
                    : t("installCourse.steps.confirmPublication")}
                </Button>
              </form>
            ) : (
              <small>{t("installCourse.steps.adminMustPublish")}</small>
            )
          ) : (
            <small>
              {state === "published"
                ? t("installCourse.steps.published")
                : t("installCourse.steps.afterApproval")}
            </small>
          )}
        </li>
        <li>
          <strong>{t("installCourse.steps.registry")}</strong>
          {!registry.present ? (
            <small>{t("installCourse.steps.noRegistry")}</small>
          ) : registry.approved ? (
            <small>
              {t("installCourse.steps.registryApproved", {
                digest: short(registry.digest),
              })}
            </small>
          ) : permissions.approveRegistry ? (
            <form
              className="stack"
              onSubmit={(e) => {
                e.preventDefault();
                if (registryConsent) onApproveRegistry();
              }}
            >
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={registryConsent}
                  disabled={pending}
                  onChange={(e) => setRegistryConsent(e.target.checked)}
                />
                {t("installCourse.steps.registryConsent", {
                  count: registry.profileCount,
                  digest: short(registry.digest),
                  version: course.version,
                })}
              </label>
              <Button type="submit" disabled={!registryConsent || pending}>
                {t("installCourse.steps.approveRegistry")}
              </Button>
            </form>
          ) : (
            <small>{t("installCourse.steps.ownerMustApprove")}</small>
          )}
        </li>
      </ol>
    </section>
  );
}

/**
 * A package problem in the reader's language, with its code for support. A code the app has no
 * message for shows the server's older free text, isolated so its direction does not leak.
 */
function ProblemText({
  problem,
}: {
  problem: { code: string; params?: Record<string, string>; detail?: string };
}) {
  const i18n = useI18n();
  const key = `installCourse.problem.${problem.code}` as MessageKey;
  const text = i18n.has(key)
    ? i18n.t(key, problem.params)
    : problem.params?.check === "runtime"
      ? i18n.t("installCourse.problem.runtime")
      : problem.detail;
  return (
    <>
      {text ? <bdi dir="auto">{text}</bdi> : null}{" "}
      <small className="mono" dir="ltr">
        {problem.code}
      </small>
    </>
  );
}
