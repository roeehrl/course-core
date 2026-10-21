import { DraftEditor } from "../components/DraftEditor";
import { InstallCourse } from "../components/InstallCourse";
import { RecoveryRegistry } from "../components/RecoveryRegistry";
import { CourseUpdates } from "../components/CourseUpdates";
import { useState, type FormEvent } from "react";
import { useI18n, useT, type MessageKey } from "../i18n";
import {
  ArrowUpRight,
  Check,
  GitBranch,
  PackagePlus,
  Plus,
} from "lucide-react";
import type {
  AdminClient,
  CourseWorkspace,
  Release,
} from "../domain/contracts";
import type { WorkspaceActions } from "../hooks/useAdmin";
import { ActionFeedback } from "../components/ActionFeedback";
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
  when,
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
  /** A server check with a code, in the reader's language; undefined keeps the server's text. */
  const checkText = (
    check: { code?: string; params?: Record<string, string> },
    part: "label" | "detail",
  ) => {
    const key =
      `courseView.check.code.${check.code ?? ""}.${part}` as MessageKey;
    return check.code && i18n.has(key) ? i18n.t(key, check.params) : undefined;
  };
  const [selectedId, setSelectedId] = useState(data.releases[0]?.id);
  const selected =
    data.releases.find((item) => item.id === selectedId) ?? data.releases[0];
  const [dialog, setDialog] = useState<"details" | "draft" | "publish">();
  const [editingBundle, setEditingBundle] = useState(false);
  const [rollingBack, setRollingBack] = useState(false);
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
  async function transition(
    release: Release,
    action: "submit-review" | "approve" | "publish" | "activate",
  ) {
    const result = await actions.run(
      JSON.stringify(["release", release.id, action]),
      (context) =>
        client.transitionRelease(data.course.id, release.id, action, context),
    );
    if (result) setDialog(undefined);
  }
  const activeRelease = data.releases.find(
    (item) => item.availableForNewLearners,
  );
  return (
    <div className="page-stack">
      <ActionFeedback actions={actions} />
      <div className="hero-card">
        <div>
          <p className="eyebrow">{t("courseView.hero.eyebrow")}</p>
          <h2>
            {i18n.rich("courseView.hero.title", undefined, {
              br: (_children, key) => <br key={key} />,
            })}
          </h2>
          <p>{data.course.description}</p>
          <Button
            kind="primary"
            onClick={() => open("details")}
            disabled={!canWrite || actions.pending}
          >
            {t("courseView.editDetails")}{" "}
            <ArrowUpRight size={16} aria-hidden="true" />
          </Button>
        </div>
        <div className="hero-art" aria-hidden="true">
          <span>01</span>
          <i />
          <span>02</span>
          <i />
          <span className="gold-step">03</span>
          <small>{t("courseView.hero.steps")}</small>
        </div>
      </div>
      <div className="stats-grid">
        <Stat
          label={t("courseView.stat.current")}
          value={activeRelease?.version ?? t("courseView.stat.none")}
          detail={
            client.mode === "demo"
              ? t("courseView.stat.fictional")
              : t("courseView.stat.selected")
          }
        />
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
          value={
            data.releases.filter((item) => item.state === "pending_review")
              .length
          }
          detail={t("courseView.stat.decisions")}
        />
      </div>
      <Card
        title={t("courseView.releases.title")}
        eyebrow={t("courseView.releases.eyebrow")}
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
                <small>{release.notes}</small>
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
      {client.mode === "connected" &&
        client.courseUpdates &&
        data.course.workspaceId && (
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
        )}
      {selected && (
        <Card
          title={t("courseView.inspection.title", {
            version: selected.version,
          })}
          eyebrow={t("courseView.inspection.eyebrow")}
        >
          <div className="split-line">
            <Status value={selected.state} />
            <small>{when(selected.createdAt)}</small>
          </div>
          <p>{selected.notes}</p>
          <ul className="checklist">
            {selected.checks.map((check) => (
              <li key={check.label}>
                <span
                  className={`check-icon ${check.passed && !check.warning ? "passed" : ""}`}
                  aria-hidden="true"
                >
                  {check.passed && !check.warning ? <Check size={16} /> : "!"}
                </span>
                <div>
                  <strong>{checkText(check, "label") ?? check.label}</strong>
                  <small>{checkText(check, "detail") ?? check.detail}</small>
                </div>
                <Badge tone={check.passed && !check.warning ? "green" : "gold"}>
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
          {selected.state === "draft" && (
            <>
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
              {selected.checks.some((item) => !item.passed) && (
                <small>{t("courseView.validationRequired")}</small>
              )}
            </>
          )}
          {selected.state === "pending_review" && (
            <>
              <PermissionHint
                permissions={data.permissions}
                required="release.review"
              />
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
            <>
              <PermissionHint
                permissions={data.permissions}
                required="release.publish"
              />
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
            </>
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
          {selected.state === "published" && (
            <>
              <Notice tone="blue">{t("courseView.immutable")}</Notice>
              {selected.availableForNewLearners ? (
                <Notice>{t("courseView.selectedForNew")}</Notice>
              ) : (
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
            </>
          )}
          <ReleaseSafetyPanel
            data={data}
            client={client}
            actions={actions}
            release={selected}
            active={activeRelease}
          />
        </Card>
      )}
      {/* Release-scoped: moved here from the AI services page. */}
      <RecoveryRegistry data={data} client={client} />
      <Card title={t("courseView.objectives")}>
        <ol className="objectives">
          {data.course.objectives.map((objective) => (
            <li key={objective}>{objective}</li>
          ))}
        </ol>
      </Card>
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
      {editingBundle && selected && (
        <DraftEditor
          client={client}
          courseId={data.course.id}
          releaseId={selected.id}
          actions={actions}
          onClose={() => setEditingBundle(false)}
        />
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
          {dialog === "publish" && selected ? (
            <PublishConfirmation
              version={selected.version}
              demo={client.mode === "demo"}
              pending={actions.pending}
              onSubmit={() => void transition(selected, "publish")}
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
      <Button kind="primary" type="submit" disabled={pending}>
        {pending
          ? t("courseView.saving")
          : kind === "details"
            ? t("courseView.form.saveDetails")
            : t("courseView.form.createDraft")}
      </Button>
    </form>
  );
}
function PublishConfirmation({
  version,
  demo,
  pending,
  onSubmit,
}: {
  version: string;
  demo: boolean;
  pending: boolean;
  onSubmit: () => void;
}) {
  const i18n = useI18n();
  const t = useT();
  const [consent, setConsent] = useState(false);
  return (
    <form
      className="stack"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        if (consent) onSubmit();
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
      <label className="check-label">
        <input
          type="checkbox"
          checked={consent}
          onChange={(e) => setConsent(e.target.checked)}
          disabled={pending}
        />
        {t("courseView.confirmLabel", { version })}
      </label>
      <Button kind="primary" type="submit" disabled={!consent || pending}>
        {pending ? t("courseView.recording") : t("courseView.confirm")}
      </Button>
    </form>
  );
}
