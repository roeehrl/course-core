import { DraftEditor } from "../components/DraftEditor";
import { StructuredDraftEditor } from "../components/StructuredDraftEditor";
import { LearnerPreview } from "../components/LearnerPreview";
import { PublishImpact } from "../components/PublishImpact";
import { InstallCourse } from "../components/InstallCourse";
import { RecoveryRegistry } from "../components/RecoveryRegistry";
import { CourseUpdates } from "../components/CourseUpdates";
import { VersionMoves } from "../components/VersionMoves";
import { useState, type FormEvent, type MouseEvent } from "react";
import { useFormatters, useI18n, useT, type MessageKey } from "../i18n";
import {
  ArrowUpRight,
  Check,
  GitBranch,
  PackagePlus,
  Pencil,
  Plus,
} from "lucide-react";
import "./workspacePages.css";
import type {
  AdminClient,
  CourseWorkspace,
  Release,
} from "../domain/contracts";
import type { WorkspaceActions } from "../hooks/useAdmin";
import { ActionFeedback } from "../components/ActionFeedback";
import { newerVersion } from "../domain/versions";
import { releaseCheckText } from "../domain/releaseChecks";
import { ReleaseSafetyPanel, RollbackDialog } from "./ReleaseSafetyPanel";
import {
  Badge,
  Button,
  Card,
  Dialog,
  Field,
  Notice,
  PermissionHint,
  Stat,
  Status,
} from "../components/ui";

export function CourseView({
  data,
  client,
  actions,
  onOpenCourse,
}: {
  data: CourseWorkspace;
  client: AdminClient;
  actions: WorkspaceActions;
  /** Switch administration to another course (after installing a new one). */
  onOpenCourse?: (courseId: string) => void;
}) {
  const i18n = useI18n();
  const t = useT();
  const { when } = useFormatters();
  const [selectedId, setSelectedId] = useState(data.releases[0]?.id);
  const selected =
    data.releases.find((item) => item.id === selectedId) ?? data.releases[0];
  const [dialog, setDialog] = useState<"details" | "draft" | "publish">();
  const [editingBundle, setEditingBundle] = useState(false);
  const [rollingBack, setRollingBack] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const canWrite = data.permissions.includes("course.write");
  const [installing, setInstalling] = useState(false);
  const [installPending, setInstallPending] = useState(false);
  // Installing packages is an owner/administrator action on this course's workspace.
  const canInstall =
    client.mode === "connected" &&
    Boolean(client.coursePackages && data.course.workspaceId) &&
    canWrite &&
    ["owner", "admin"].includes(data.role ?? "");
  function open(value: typeof dialog) {
    actions.clear();
    setDialog(value);
  }
  /** A newer version already published or archived than this one, if any. */
  const newerPublishedThan = (release: Release) =>
    newerVersion(
      release.version,
      data.releases
        .filter(
          (r) =>
            r.id !== release.id &&
            (r.state === "published" || r.state === "archived"),
        )
        .map((r) => r.version),
    );
  async function transition(
    release: Release,
    action: "submit-review" | "approve" | "publish" | "activate",
    confirmation?: { impactDigest?: string; confirmOlderVersion?: true },
  ) {
    const result = await actions.run(
      JSON.stringify(["release", release.id, action, confirmation ?? null]),
      (context) =>
        client.transitionRelease(
          data.course.id,
          release.id,
          action,
          context,
          confirmation,
        ),
    );
    if (result) setDialog(undefined);
  }
  const activeRelease = data.releases.find(
    (item) => item.availableForNewLearners,
  );
  const awaitingReview = data.releases.filter(
    (item) => item.state === "pending_review",
  ).length;
  const showUpdates =
    client.mode === "connected" && Boolean(client.courseUpdates);
  /** The page's parts, for the link bar under the course header. */
  const sections = [
    { id: "course-releases", label: t("courseView.releases.title") },
    ...(showUpdates && data.course.workspaceId
      ? [{ id: "course-updates", label: t("courseView.sections.updates") }]
      : []),
    ...(client.versionMoves
      ? [{ id: "course-moves", label: t("courseView.sections.moves") }]
      : []),
    ...(selected
      ? [
          {
            id: "course-release",
            label: t("courseView.inspection.title", {
              version: selected.version,
            }),
          },
        ]
      : []),
    { id: "course-recovery", label: t("courseView.sections.recovery") },
    { id: "course-objectives", label: t("courseView.objectives") },
  ];
  const jump = (id: string) => (event: MouseEvent) => {
    event.preventDefault();
    const target = document.getElementById(id);
    target?.scrollIntoView({ block: "start" });
    target?.focus({ preventScroll: true });
  };
  return (
    <div className="page-stack">
      <ActionFeedback actions={actions} />
      {/* The course itself first: its name, what it is, the version new learners start on. */}
      <section
        className="card course-header"
        aria-labelledby="course-header-title"
      >
        <div className="course-header-row">
          <div className="course-header-main">
            <h2 id="course-header-title" dir="auto">
              {data.course.title}
            </h2>
            {data.course.description && (
              <p className="course-header-description" dir="auto">
                {data.course.description}
              </p>
            )}
            <div className="tag-row">
              {activeRelease ? (
                <Badge tone="green">
                  {t("courseView.header.live", {
                    version: activeRelease.version,
                  })}
                </Badge>
              ) : (
                <Badge tone="gold">{t("courseView.header.noLive")}</Badge>
              )}
              {awaitingReview > 0 && (
                <Badge tone="gold">
                  {t("courseView.header.awaiting", { count: awaitingReview })}
                </Badge>
              )}
            </div>
          </div>
          <Button
            onClick={() => open("details")}
            disabled={!canWrite || actions.pending}
          >
            <Pencil size={16} aria-hidden="true" />
            {t("courseView.editDetails")}
          </Button>
        </div>
      </section>
      <nav className="section-nav" aria-label={t("courseView.sections.label")}>
        <ol>
          {sections.map((section) => (
            <li key={section.id}>
              <a href={`#${section.id}`} onClick={jump(section.id)}>
                {section.label}
              </a>
            </li>
          ))}
        </ol>
      </nav>
      {/* The live version is in the header above; these are the figures to watch. */}
      <div className="stats-grid three">
        <Stat
          label={t("courseView.stat.enrolled")}
          value={data.enrollments.length}
          detail={t("courseView.stat.pinned")}
        />
        <Stat
          label={t("courseView.stat.objectives")}
          value={data.course.objectives.length}
          detail={t("courseView.stat.evidence")}
        />
        <Stat
          label={t("courseView.stat.awaiting")}
          value={awaitingReview}
          detail={t("courseView.stat.decisions")}
        />
      </div>
      <div id="course-releases" className="page-section" tabIndex={-1}>
        <Card
          title={t("courseView.releases.title")}
          actions={
            <div className="button-row">
              {canInstall && (
                <Button
                  onClick={() => {
                    actions.clear();
                    setInstalling(true);
                  }}
                  disabled={actions.pending}
                >
                  <PackagePlus size={16} aria-hidden="true" />
                  {t("courseView.install")}
                </Button>
              )}
              <Button
                onClick={() => open("draft")}
                disabled={!canWrite || actions.pending}
              >
                <Plus size={16} aria-hidden="true" />
                {t("courseView.newDraft")}
              </Button>
            </div>
          }
        >
          <PermissionHint
            permissions={data.permissions}
            required="course.write"
          />
          <div className="release-list">
            {data.releases.map((release) => (
              <button
                key={release.id}
                className={`release-row ${release.id === selected?.id ? "selected" : ""}`}
                onClick={() => setSelectedId(release.id)}
                aria-pressed={release.id === selected?.id}
                disabled={actions.pending}
              >
                <span className="round-icon">
                  <GitBranch size={20} aria-hidden="true" />
                </span>
                <span className="grow">
                  <strong>
                    {t("courseView.release.version", {
                      version: release.version,
                    })}
                  </strong>
                  <small dir="auto">{release.notes}</small>
                  {release.availableForNewLearners && (
                    <small>{t("courseView.release.available")}</small>
                  )}
                </span>
                <Status value={release.state} />
                <ArrowUpRight size={18} aria-hidden="true" />
              </button>
            ))}
          </div>
        </Card>
      </div>
      {showUpdates && data.course.workspaceId && (
        <div id="course-updates" className="page-section" tabIndex={-1}>
          <CourseUpdates
            client={client}
            courseId={data.course.id}
            workspaceId={data.course.workspaceId}
            onInstalled={(catalogId) => {
              if (catalogId && catalogId !== data.course.id && onOpenCourse)
                onOpenCourse(catalogId);
              else void actions.resync();
            }}
          />
        </div>
      )}
      {client.versionMoves && (
        <div id="course-moves" className="page-section" tabIndex={-1}>
          <VersionMoves
            client={client}
            courseId={data.course.id}
            onMoved={() => void actions.resync()}
          />
        </div>
      )}
      {selected && (
        <div id="course-release" className="page-section" tabIndex={-1}>
          <Card
            title={t("courseView.inspection.title", {
              version: selected.version,
            })}
          >
            <div className="split-line">
              <Status value={selected.state} />
              <small>{when(selected.createdAt)}</small>
            </div>
            <p dir="auto">{selected.notes}</p>
            <ul className="checklist">
              {selected.checks.map((check) => (
                <li key={check.code ?? check.label}>
                  <span
                    className={`check-icon ${check.passed && !check.warning ? "passed" : ""}`}
                    aria-hidden="true"
                  >
                    {check.passed && !check.warning ? <Check size={16} /> : "!"}
                  </span>
                  <div>
                    <strong>{releaseCheckText(i18n, check).label}</strong>
                    <small>{releaseCheckText(i18n, check).detail}</small>
                  </div>
                  <Badge
                    tone={check.passed && !check.warning ? "green" : "gold"}
                  >
                    {check.warning
                      ? t("courseView.check.warning")
                      : check.passed
                        ? t("courseView.check.recorded")
                        : t("courseView.check.required")}
                  </Badge>
                </li>
              ))}
            </ul>
            {selected.state === "pending_review" && (
              <Notice tone="gold">{t("courseView.pendingReview")}</Notice>
            )}
            {selected.state === "published" && (
              <Notice tone="blue">{t("courseView.immutable")}</Notice>
            )}
            {selected.state === "published" &&
              selected.availableForNewLearners && (
                <Notice>{t("courseView.selectedForNew")}</Notice>
              )}
            {selected.state === "pending_review" && (
              <PermissionHint
                permissions={data.permissions}
                required="release.review"
              />
            )}
            {selected.state === "approved" && (
              <PermissionHint
                permissions={data.permissions}
                required="release.publish"
              />
            )}
            {/* One row of actions for this version: the next step first, then the rest. */}
            <div className="button-row">
              {selected.state === "draft" && (
                <Button
                  kind="primary"
                  disabled={
                    !canWrite ||
                    actions.pending ||
                    selected.checks.some((item) => !item.passed)
                  }
                  onClick={() => void transition(selected, "submit-review")}
                >
                  {actions.pending
                    ? t("courseView.saving")
                    : t("courseView.submitReview")}
                </Button>
              )}
              {selected.state === "pending_review" && (
                <>
                  <Button
                    kind="primary"
                    disabled={
                      !data.permissions.includes("release.review") ||
                      actions.pending
                    }
                    onClick={() => void transition(selected, "approve")}
                  >
                    {actions.pending
                      ? t("courseView.recording")
                      : t("courseView.approveReview")}
                  </Button>
                  <Button disabled>{t("courseView.publishAfter")}</Button>
                </>
              )}
              {selected.state === "approved" && (
                <Button
                  kind="primary"
                  disabled={
                    !data.permissions.includes("release.publish") ||
                    actions.pending
                  }
                  onClick={() => open("publish")}
                >
                  {t("courseView.publish")}
                </Button>
              )}
              {selected.state === "published" &&
                !selected.availableForNewLearners && (
                  <Button
                    disabled={
                      !data.permissions.includes("release.publish") ||
                      actions.pending ||
                      selected.checks.some((item) => !item.passed)
                    }
                    onClick={() => {
                      // An older release than the live one is a rollback: review its impact first.
                      if (
                        client.releaseSafety &&
                        activeRelease &&
                        Date.parse(selected.createdAt) <
                          Date.parse(activeRelease.createdAt)
                      ) {
                        actions.clear();
                        setRollingBack(true);
                      } else void transition(selected, "activate");
                    }}
                  >
                    {t("courseView.useForNew")}
                  </Button>
                )}
              {selected.state !== "published" &&
                selected.state !== "archived" &&
                client.getReleaseManifest &&
                client.updateRelease && (
                  <Button
                    disabled={!canWrite || actions.pending}
                    onClick={() => {
                      actions.clear();
                      setEditingBundle(true);
                    }}
                  >
                    {t("courseView.editBundle")}
                  </Button>
                )}
              {client.releaseEditing &&
                (selected.state === "published" ||
                  selected.state === "archived" ||
                  canWrite ||
                  data.permissions.includes("release.review")) && (
                  <Button
                    disabled={actions.pending}
                    onClick={() => setPreviewing(true)}
                  >
                    {t("courseView.previewAsLearners")}
                  </Button>
                )}
            </div>
            {selected.state === "draft" &&
              selected.checks.some((item) => !item.passed) && (
                <small className="button-reason">
                  {t("courseView.validationRequired")}
                </small>
              )}
            <ReleaseSafetyPanel
              data={data}
              client={client}
              actions={actions}
              release={selected}
              active={activeRelease}
            />
          </Card>
        </div>
      )}
      {/* Release-scoped: moved here from the AI services page. */}
      <div id="course-recovery" className="page-section" tabIndex={-1}>
        <RecoveryRegistry data={data} client={client} />
      </div>
      <div id="course-objectives" className="page-section" tabIndex={-1}>
        <Card title={t("courseView.objectives")}>
          {data.course.objectives.length === 0 ? (
            <p className="muted">{t("courseView.objectives.none")}</p>
          ) : (
            // Long lists stay folded: the page stays short enough to find the rest.
            <details className="objectives-disclosure">
              <summary>
                {t("courseView.objectives.show", {
                  count: data.course.objectives.length,
                })}
              </summary>
              <ol className="objectives">
                {data.course.objectives.map((objective) => (
                  <li key={objective} dir="auto">
                    {objective}
                  </li>
                ))}
              </ol>
            </details>
          )}
        </Card>
      </div>
      {rollingBack && selected && client.releaseSafety && (
        <RollbackDialog
          port={client.releaseSafety}
          data={data}
          actions={actions}
          release={selected}
          client={client}
          onClose={() => setRollingBack(false)}
        />
      )}
      {installing && data.course.workspaceId && (
        <Dialog
          title={t("courseView.install")}
          eyebrow={t("courseView.installDialog.eyebrow")}
          className="install-dialog"
          pending={installPending}
          onClose={() => setInstalling(false)}
        >
          <InstallCourse
            client={client}
            workspaceId={data.course.workspaceId}
            onPendingChange={setInstallPending}
            onFinished={(catalogId) => {
              setInstalling(false);
              if (catalogId && catalogId !== data.course.id && onOpenCourse)
                onOpenCourse(catalogId);
              else void actions.resync();
            }}
          />
        </Dialog>
      )}
      {editingBundle &&
        selected &&
        (client.releaseEditing ? (
          <StructuredDraftEditor
            client={client}
            port={client.releaseEditing}
            courseId={data.course.id}
            releaseId={selected.id}
            actions={actions}
            onClose={() => setEditingBundle(false)}
          />
        ) : (
          <DraftEditor
            client={client}
            courseId={data.course.id}
            releaseId={selected.id}
            actions={actions}
            onClose={() => setEditingBundle(false)}
          />
        ))}
      {previewing && selected && client.releaseEditing && (
        <Dialog
          title={t("courseView.previewDialog", { version: selected.version })}
          onClose={() => setPreviewing(false)}
          className="structured-editor"
        >
          <LearnerPreview
            port={client.releaseEditing}
            courseId={data.course.id}
            releaseId={selected.id}
          />
        </Dialog>
      )}
      {dialog && (
        <Dialog
          title={
            dialog === "details"
              ? t("courseView.editDetails")
              : dialog === "draft"
                ? t("courseView.dialog.draft")
                : t("courseView.dialog.publish")
          }
          onClose={() => setDialog(undefined)}
          pending={actions.pending}
        >
          <ActionFeedback actions={actions} />
          {dialog === "publish" && selected && client.releaseEditing ? (
            <PublishImpact
              port={client.releaseEditing}
              courseId={data.course.id}
              releaseId={selected.id}
              version={selected.version}
              newerPublished={newerPublishedThan(selected)}
              pending={actions.pending}
              onConfirm={(impactDigest, older) =>
                void transition(selected, "publish", {
                  impactDigest,
                  ...(older ? { confirmOlderVersion: true as const } : {}),
                })
              }
            />
          ) : dialog === "publish" && selected ? (
            <PublishConfirmation
              version={selected.version}
              newerPublished={newerPublishedThan(selected)}
              demo={client.mode === "demo"}
              pending={actions.pending}
              onSubmit={(older) =>
                void transition(
                  selected,
                  "publish",
                  older ? { confirmOlderVersion: true } : undefined,
                )
              }
            />
          ) : (
            <CourseForm
              kind={dialog as "details" | "draft"}
              data={data}
              pending={actions.pending}
              onSave={async (input) => {
                const result =
                  dialog === "details"
                    ? await actions.run(
                        JSON.stringify(["details", input]),
                        (ctx) =>
                          client.updateCourse(
                            data.course.id,
                            { title: input.first, description: input.second },
                            ctx,
                          ),
                      )
                    : await actions.run(
                        JSON.stringify(["draft", input]),
                        (ctx) =>
                          client.createRelease(
                            data.course.id,
                            { version: input.first, notes: input.second },
                            ctx,
                          ),
                      );
                if (result) {
                  if (dialog === "draft")
                    setSelectedId(result.workspace.releases[0]?.id);
                  setDialog(undefined);
                }
              }}
            />
          )}
        </Dialog>
      )}
    </div>
  );
}
function CourseForm({
  kind,
  data,
  pending,
  onSave,
}: {
  kind: "details" | "draft";
  data: CourseWorkspace;
  pending: boolean;
  onSave: (input: { first: string; second: string }) => void;
}) {
  const t = useT();
  const [first, setFirst] = useState(
    kind === "details" ? data.course.title : "",
  );
  const [second, setSecond] = useState(
    kind === "details" ? data.course.description : "",
  );
  return (
    <form
      className="stack"
      onSubmit={(event) => {
        event.preventDefault();
        onSave({ first, second });
      }}
    >
      <Field
        label={
          kind === "details"
            ? t("courseView.form.title")
            : t("courseView.form.version")
        }
        htmlFor="course-first"
        hint={kind === "draft" ? t("courseView.form.versionHint") : undefined}
      >
        <input
          id="course-first"
          required
          value={first}
          onChange={(e) => setFirst(e.target.value)}
          maxLength={100}
          pattern={kind === "draft" ? "[0-9]+\.[0-9]+\.[0-9]+" : undefined}
          disabled={pending}
        />
      </Field>
      <Field
        label={
          kind === "details"
            ? t("courseView.form.description")
            : t("courseView.form.notes")
        }
        htmlFor="course-second"
      >
        <textarea
          id="course-second"
          required
          value={second}
          onChange={(e) => setSecond(e.target.value)}
          maxLength={kind === "details" ? 600 : 1200}
          disabled={pending}
        />
      </Field>
      <div className="dialog-footer">
        <Button kind="primary" type="submit" disabled={pending}>
          {pending
            ? t("courseView.saving")
            : kind === "details"
              ? t("courseView.form.saveDetails")
              : t("courseView.form.createDraft")}
        </Button>
      </div>
    </form>
  );
}
function PublishConfirmation({
  version,
  newerPublished,
  demo,
  pending,
  onSubmit,
}: {
  version: string;
  /** A newer version already published: publishing this one goes back and needs confirming. */
  newerPublished: string | null;
  demo: boolean;
  pending: boolean;
  onSubmit: (olderConfirmed: boolean) => void;
}) {
  const i18n = useI18n();
  const t = useT();
  const [consent, setConsent] = useState(false);
  const [older, setOlder] = useState(false);
  const ready = consent && (!newerPublished || older);
  return (
    <form
      className="stack"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        if (ready) onSubmit(Boolean(newerPublished) && older);
      }}
    >
      <p>
        {i18n.rich(
          "courseView.publishBody",
          { version },
          {
            strong: (children, key) => (
              <strong key={key} dir="ltr">
                {children}
              </strong>
            ),
          },
        )}
      </p>
      {demo && <Notice tone="gold">{t("courseView.demoOnly")}</Notice>}
      {newerPublished && (
        <Notice tone="gold">
          <p>
            {t("courseView.olderNotice", { version, newest: newerPublished })}
          </p>
          <label className="check-label">
            <input
              type="checkbox"
              checked={older}
              onChange={(e) => setOlder(e.target.checked)}
              disabled={pending}
            />
            {t("courseView.olderLabel", { version })}
          </label>
        </Notice>
      )}
      <label className="check-label">
        <input
          type="checkbox"
          checked={consent}
          onChange={(e) => setConsent(e.target.checked)}
          disabled={pending}
        />
        {t("courseView.confirmLabel", { version })}
      </label>
      <div className="dialog-footer">
        <Button kind="primary" type="submit" disabled={!ready || pending}>
          {pending ? t("courseView.recording") : t("courseView.confirm")}
        </Button>
      </div>
    </form>
  );
}
