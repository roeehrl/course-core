import { useEffect, useId, useRef, useState, type FormEvent, type RefObject } from "react";
import type { AdminClient } from "../domain/contracts";
import {
  CoursePackageError,
  packageMessage,
  type Installation,
  type PackagePreview,
} from "../domain/coursePackages";
import { errorMessage } from "../domain/errors";
import { Badge, Button, Field, Notice, Status } from "./ui";

/** An idempotency key from the platform's random source (no randomUUID: not on every origin). */
function newKey() {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return `package-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
const short = (digest: string) => `${digest.slice(0, 12)}…`;
const megabytes = (bytes: number) => bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KiB` : `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
type Failure = { message: string; assets?: string[] };
function failure(error: unknown): Failure {
  if (error instanceof CoursePackageError)
    return { message: packageMessage(error.code), ...(error.details?.assets?.length ? { assets: error.details.assets } : {}) };
  return { message: errorMessage(error) };
}
const existingText: Record<PackagePreview["existing"]["status"], string> = {
  "new-course": "A new course for this workspace.",
  "new-version": "A new version of a course this workspace has.",
  "already-installed": "Already installed: this exact version and content exist here.",
  "version-conflict": "This version already exists here with different content.",
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
}: {
  client: AdminClient;
  workspaceId: string;
  /** Close the flow; with the installed course's catalog id when something was installed. */
  onFinished: (catalogId?: string) => void;
  onPendingChange?: (pending: boolean) => void;
}) {
  const port = client.coursePackages!;
  const id = useId();
  const [source, setSource] = useState<"file" | "github">("file");
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState("");
  const [assets, setAssets] = useState<string[]>([]);
  const [asset, setAsset] = useState("");
  const [preview, setPreview] = useState<PackagePreview>();
  const [installation, setInstallation] = useState<Installation>();
  const [alreadyReleaseId, setAlreadyReleaseId] = useState<string>();
  const [error, setError] = useState<Failure>();
  const [status, setStatus] = useState("");
  const [pending, setPending] = useState(false);
  const [notes, setNotes] = useState("");
  const [publishNow, setPublishNow] = useState(false);
  const [confirmVersion, setConfirmVersion] = useState("");
  const [approveRegistryNow, setApproveRegistryNow] = useState(false);
  const installKey = useRef(newKey());
  const previewHeading = useRef<HTMLHeadingElement>(null);
  const stepsHeading = useRef<HTMLHeadingElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  useEffect(() => onPendingChange?.(pending), [pending, onPendingChange]);
  useEffect(() => { if (preview && !installation) previewHeading.current?.focus(); }, [preview, installation]);
  useEffect(() => { if (installation) stepsHeading.current?.focus(); }, [installation?.releaseId]);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);

  function resetPreview() {
    setPreview(undefined);
    setError(undefined);
    setStatus("");
    setPublishNow(false);
    setConfirmVersion("");
    setApproveRegistryNow(false);
    installKey.current = newKey();
  }
  async function inspect(event: FormEvent) {
    event.preventDefault();
    resetPreview();
    if (source === "file" && !file) return setError({ message: "Choose a .course.tgz package file." });
    if (source === "github" && !url.trim()) return setError({ message: "Enter a GitHub repository or release link." });
    setPending(true);
    setStatus(source === "file" ? "Checking the package file…" : "Downloading and checking the package…");
    try {
      const result = source === "file" ? await port.inspectFile(workspaceId, file!) : await port.inspectUrl(workspaceId, url.trim(), asset || undefined);
      setPreview(result);
      setAssets([]);
      const blocking = result.problems.filter((p) => p.severity === "blocking").length;
      setStatus(`Package checked: ${result.course.title} ${result.course.version}. ${blocking ? `${blocking} blocking problem${blocking === 1 ? "" : "s"}.` : "No blocking problems."}`);
    } catch (cause) {
      const failed = failure(cause);
      if (failed.assets) { setAssets(failed.assets); setAsset(""); }
      setError(failed);
      setStatus("The package could not be checked.");
    } finally {
      setPending(false);
    }
  }
  async function install(event: FormEvent) {
    event.preventDefault();
    if (!preview) return;
    setPending(true);
    setError(undefined);
    setStatus("Installing the draft…");
    try {
      const result = await port.install(preview.sha256, {
        workspaceId,
        idempotencyKey: installKey.current,
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        ...(publishNow ? { approveAndPublish: { confirmVersion } } : {}),
        ...(approveRegistryNow && preview.registry.present ? { approveRegistry: { configurationDigest: preview.registry.digest } } : {}),
      });
      if (result.installation) {
        setInstallation(result.installation);
        const registryNote = result.registryApproval
          ? result.registryApproval.approved ? " Recovery registry approved." : ` Recovery registry not approved: ${packageMessage(result.registryApproval.code)}`
          : "";
        setStatus(`${result.alreadyInstalled ? "This package was already installed." : `Version ${result.installation.course.version} installed.`} State: ${result.installation.state.replaceAll("_", " ")}.${registryNote}`);
      } else {
        setAlreadyReleaseId(result.releaseId);
        setStatus("This version is already installed in this workspace.");
      }
    } catch (cause) {
      setError(failure(cause));
      setStatus("The draft was not installed.");
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
      setError(failure(cause));
      setStatus("That step was not completed.");
    } finally {
      setPending(false);
    }
  }
  const transition = (action: "approve" | "publish") =>
    client.transitionRelease(installation!.catalogId, installation!.releaseId, action, {
      expectedRevision: installation!.catalogRevision,
      idempotencyKey: newKey(),
    });

  const blocking = preview?.problems.filter((p) => p.severity === "blocking") ?? [];
  const warnings = preview?.problems.filter((p) => p.severity === "warning") ?? [];
  const confirmMatches = preview ? confirmVersion === preview.course.version : false;
  return (
    <div className="stack install-course">
      <p className="sr-only" role="status" aria-live="polite">{status}</p>
      {!installation && !alreadyReleaseId && (
        <form className="stack" onSubmit={(e) => void inspect(e)} aria-describedby={`${id}-help`}>
          <p id={`${id}-help`}>
            Inspecting checks the package and shows what it would install. Nothing is installed or run until you choose
            “Install draft”.
          </p>
          <fieldset className="segmented">
            <legend>Package source</legend>
            <label>
              <input type="radio" name={`${id}-source`} checked={source === "file"} disabled={pending}
                onChange={() => { setSource("file"); resetPreview(); }} />
              Upload package file
            </label>
            <label>
              <input type="radio" name={`${id}-source`} checked={source === "github"} disabled={pending}
                onChange={() => { setSource("github"); resetPreview(); }} />
              From GitHub
            </label>
          </fieldset>
          {source === "file" ? (
            <Field label="Course package file" htmlFor={`${id}-file`} hint="A .course.tgz file, at most 64 MiB.">
              <input id={`${id}-file`} aria-describedby={`${id}-file-hint`} type="file" accept=".tgz,.course.tgz,application/gzip" disabled={pending}
                onChange={(e) => { setFile(e.target.files?.[0] ?? null); resetPreview(); }} />
            </Field>
          ) : (
            <>
              <Field label="GitHub link" htmlFor={`${id}-url`}
                hint="A public repository, its latest release, a release tag or one release file. Examples: https://github.com/owner/course, https://github.com/owner/course/releases/tag/v1.2.0, https://github.com/owner/course/releases/download/v1.2.0/course-1.2.0.course.tgz">
                <input id={`${id}-url`} aria-describedby={`${id}-url-hint`} type="url" inputMode="url" autoComplete="off" spellCheck={false} value={url} disabled={pending}
                  placeholder="https://github.com/owner/course" onChange={(e) => { setUrl(e.target.value); setAssets([]); setAsset(""); resetPreview(); }} />
              </Field>
              {assets.length > 0 && (
                <Field label="Package in this release" htmlFor={`${id}-asset`} hint="The release has several course packages. Choose one, then inspect again.">
                  <select id={`${id}-asset`} value={asset} disabled={pending} onChange={(e) => setAsset(e.target.value)}>
                    <option value="">Choose a package</option>
                    {assets.map((name) => <option key={name} value={name}>{name}</option>)}
                  </select>
                </Field>
              )}
            </>
          )}
          <Button kind="primary" type="submit" disabled={pending || (assets.length > 0 && !asset)}>
            {pending && !preview ? "Checking…" : "Inspect package"}
          </Button>
        </form>
      )}
      {error && (
        <div ref={errorRef} tabIndex={-1}>
          <Notice tone="red" title="Not completed">{error.message}</Notice>
        </div>
      )}
      {preview && !installation && !alreadyReleaseId && (
        <section className="stack" aria-labelledby={`${id}-preview`}>
          <h3 id={`${id}-preview`} ref={previewHeading} tabIndex={-1}>
            {preview.course.title} · version {preview.course.version}
          </h3>
          {blocking.length > 0 && (
            <Notice tone="red" title={`${blocking.length} blocking problem${blocking.length === 1 ? "" : "s"}`}>
              <ul className="plain-list">
                {blocking.map((p) => <li key={p.code}><strong>{p.code}</strong>{p.detail ? ` — ${p.detail}` : ""}</li>)}
              </ul>
            </Notice>
          )}
          {warnings.length > 0 && (
            <Notice tone="gold" title={`${warnings.length} warning${warnings.length === 1 ? "" : "s"}`}>
              <ul className="plain-list">
                {warnings.map((p, i) => <li key={`${p.code}-${i}`}><strong>{p.code}</strong>{p.detail ? ` — ${p.detail}` : ""}</li>)}
              </ul>
            </Notice>
          )}
          <dl className="facts vertical">
            <div><dt>Course</dt><dd>{preview.course.id}</dd></div>
            <div><dt>Course digest</dt><dd><code>{preview.course.digest}</code></dd></div>
            <div><dt>Package</dt><dd><code>{short(preview.sha256)}</code> · {megabytes(preview.compressedBytes)}</dd></div>
            <div><dt>Source</dt><dd>{preview.packageSource.kind === "github"
              ? `GitHub ${preview.packageSource.owner}/${preview.packageSource.repo} · ${preview.packageSource.tag} · ${preview.packageSource.asset}${preview.packageSource.checksumVerified ? " · checksum verified" : " · no checksum file"}`
              : "Uploaded file"}</dd></div>
            <div><dt>In this workspace</dt><dd>{existingText[preview.existing.status]}{preview.existing.newestVersion ? ` Newest installed: ${preview.existing.newestVersion}.` : ""}</dd></div>
            <div><dt>SDK</dt><dd>Compiled with {preview.sdk.packageVersion}; this Core supports {preview.sdk.supported.min} to below {preview.sdk.supported.maxExclusive}. <Status value={preview.sdk.status === "supported" ? "supported" : preview.sdk.status === "unsupported" ? "blocked" : "warning"} /></dd></div>
            <div><dt>Core version</dt><dd>Needs {preview.core.minimumVersion}; this Core is {preview.core.version}. <Status value={preview.core.satisfied ? "eligible" : "blocked"} /></dd></div>
            <div><dt>Runtime check</dt><dd>{preview.runtime.runnable ? "This host can run the course as declared." : `Not runnable here (${preview.runtime.code}).`}</dd></div>
            <div><dt>Recovery registry</dt><dd>{preview.registry.present
              ? `${preview.registry.profileCount} profile${preview.registry.profileCount === 1 ? "" : "s"} · digest ${short(preview.registry.digest)}${preview.registry.approvable ? "" : ` · not approvable here (${preview.registry.code})`}`
              : "None in this package."}</dd></div>
          </dl>
          <div>
            <h4>Host requirements</h4>
            {preview.hostRequirements.length ? (
              <ul className="plain-list host-requirements">
                {preview.hostRequirements.map((r) => (
                  <li key={r.name}>
                    <span><strong>{r.name}</strong> <code>{short(r.sha256)}</code></span>
                    <Badge tone={r.status === "identical" ? "green" : r.status === "different" ? "gold" : "red"}>
                      {r.status === "identical" ? "Present, identical" : r.status === "different" ? "Present, different" : "Missing on this host"}
                    </Badge>
                  </li>
                ))}
              </ul>
            ) : <p>None. The package needs no host-configured files.</p>}
          </div>
          <details>
            <summary>Package files ({preview.members.length + 1})</summary>
            <ul className="plain-list">
              {preview.members.map((m) => <li key={m.name}>{m.name} · {m.role} · {m.bytes} bytes</li>)}
            </ul>
          </details>
          {preview.existing.status !== "already-installed" && (
            <form className="stack" onSubmit={(e) => void install(e)}>
              <Field label="Release notes (optional)" htmlFor={`${id}-notes`} hint="Defaults to the package digest and source.">
                <textarea id={`${id}-notes`} maxLength={1200} value={notes} disabled={pending} onChange={(e) => setNotes(e.target.value)} />
              </Field>
              {preview.permissions.approveAndPublish && (
                <div className="stack">
                  <label className="check-label">
                    <input type="checkbox" checked={publishNow} disabled={pending || !preview.installable}
                      onChange={(e) => { setPublishNow(e.target.checked); setConfirmVersion(""); }} />
                    Also approve the review and publish this version now
                  </label>
                  {publishNow && (
                    <Field label={`Type ${preview.course.version} to confirm publication`} htmlFor={`${id}-confirm`}
                      hint="New enrollments may use this release; existing ones keep their pinned version.">
                      <input id={`${id}-confirm`} aria-describedby={`${id}-confirm-hint`} autoComplete="off" spellCheck={false} value={confirmVersion} disabled={pending}
                        onChange={(e) => setConfirmVersion(e.target.value)} />
                    </Field>
                  )}
                </div>
              )}
              {preview.registry.present && preview.registry.approvable && preview.permissions.approveRegistry && (
                <label className="check-label">
                  <input type="checkbox" checked={approveRegistryNow} disabled={pending || !preview.installable}
                    onChange={(e) => setApproveRegistryNow(e.target.checked)} />
                  Also approve the packaged recovery registry (digest {short(preview.registry.digest)}) for this release
                </label>
              )}
              <div className="button-row">
                <Button kind="primary" type="submit" disabled={pending || !preview.installable || (publishNow && !confirmMatches)}>
                  {pending ? "Installing…" : publishNow ? "Install, approve and publish" : "Install draft"}
                </Button>
                <Button type="button" disabled={pending} onClick={() => resetPreview()}>Choose another package</Button>
              </div>
              {!preview.installable && <small>Resolve the blocking problems before installing.</small>}
            </form>
          )}
          {preview.existing.status === "already-installed" && (
            <Notice tone="green" title="Already installed">This exact version is already in this workspace. Nothing needs to be installed.</Notice>
          )}
        </section>
      )}
      {alreadyReleaseId && (
        <Notice tone="green" title="Already installed">This exact version is already in this workspace.</Notice>
      )}
      {installation && (
        <InstallationSteps
          installation={installation}
          pending={pending}
          headingRef={stepsHeading}
          onApprove={() => void step(() => transition("approve"), "Approval recorded for this exact bundle digest.")}
          onPublish={() => void step(() => transition("publish"), `Version ${installation.course.version} published. Existing enrollments remain pinned.`)}
          onApproveRegistry={() => installation.registry.present && void step(() => port.approveRegistry(installation.releaseId, {
            configurationDigest: installation.registry.present ? installation.registry.digest : "",
            expectedRegistryRevision: installation.registry.present ? installation.registry.registryRevision : 0,
          }), "Recovery registry approved for this release.")}
        />
      )}
      {(installation || alreadyReleaseId) && (
        <Button kind="primary" disabled={pending} onClick={() => onFinished(installation?.catalogId)}>
          {installation ? "Done — open this course" : "Done"}
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
  const id = useId();
  const [publishConsent, setPublishConsent] = useState(false);
  const [registryConsent, setRegistryConsent] = useState(false);
  const { state, course, registry, permissions } = installation;
  return (
    <section className="stack" aria-labelledby={`${id}-steps`}>
      <h3 id={`${id}-steps`} ref={headingRef} tabIndex={-1}>
        Release {course.version} installed
      </h3>
      <p>
        <Status value={state} /> {installation.availableForNewLearners && <Badge tone="green">Available to new learners</Badge>}
      </p>
      <ol className="install-steps">
        <li>
          <strong>Review</strong>
          {state === "pending_review" ? (
            permissions.approve ? (
              <Button kind="primary" disabled={pending} onClick={onApprove}>{pending ? "Recording…" : "Approve review"}</Button>
            ) : <small>A reviewer must approve this release.</small>
          ) : <small>{state === "draft" ? "Not yet submitted." : "Approved for this exact bundle digest."}</small>}
        </li>
        <li>
          <strong>Publish</strong>
          {state === "approved" ? (
            permissions.publish ? (
              <form className="stack" onSubmit={(e) => { e.preventDefault(); if (publishConsent) onPublish(); }}>
                <label className="check-label">
                  <input type="checkbox" checked={publishConsent} disabled={pending} onChange={(e) => setPublishConsent(e.target.checked)} />
                  I confirm publication of version {course.version}.
                </label>
                <Button kind="primary" type="submit" disabled={!publishConsent || pending}>{pending ? "Recording…" : "Confirm publication"}</Button>
              </form>
            ) : <small>An administrator must publish this release.</small>
          ) : <small>{state === "published" ? "Published. Existing enrollments remain pinned." : "Available after approval."}</small>}
        </li>
        <li>
          <strong>Recovery registry</strong>
          {!registry.present ? <small>This package has no recovery registry.</small>
            : registry.approved ? <small>Approved (digest {short(registry.digest)}).</small>
              : permissions.approveRegistry ? (
                <form className="stack" onSubmit={(e) => { e.preventDefault(); if (registryConsent) onApproveRegistry(); }}>
                  <label className="check-label">
                    <input type="checkbox" checked={registryConsent} disabled={pending} onChange={(e) => setRegistryConsent(e.target.checked)} />
                    I approve the packaged recovery registry ({registry.profileCount} profile{registry.profileCount === 1 ? "" : "s"}, digest {short(registry.digest)}) for version {course.version}.
                  </label>
                  <Button type="submit" disabled={!registryConsent || pending}>Approve recovery registry</Button>
                </form>
              ) : <small>An owner or administrator must approve the registry.</small>}
        </li>
      </ol>
    </section>
  );
}
