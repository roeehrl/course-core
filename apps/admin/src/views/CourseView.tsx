import { DraftEditor } from "../components/DraftEditor";
import { useState, type FormEvent } from "react";
import { ArrowUpRight, Check, GitBranch, Plus } from "lucide-react";
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
}: {
  data: CourseWorkspace;
  client: AdminClient;
  actions: WorkspaceActions;
}) {
  const [selectedId, setSelectedId] = useState(data.releases[0]?.id);
  const selected =
    data.releases.find((item) => item.id === selectedId) ?? data.releases[0];
  const [dialog, setDialog] = useState<"details" | "draft" | "publish">();
  const [editingBundle, setEditingBundle] = useState(false);
  const [rollingBack, setRollingBack] = useState(false);
  const canWrite = data.permissions.includes("course.write");
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
          <p className="eyebrow">A considered learning experience</p>
          <h2>
            A clear path.
            <br />A release you can stand behind.
          </h2>
          <p>{data.course.description}</p>
          <Button
            kind="primary"
            onClick={() => open("details")}
            disabled={!canWrite || actions.pending}
          >
            Edit course details <ArrowUpRight size={16} aria-hidden="true" />
          </Button>
        </div>
        <div className="hero-art" aria-hidden="true">
          <span>01</span>
          <i />
          <span>02</span>
          <i />
          <span className="gold-step">03</span>
          <small>DESIGN → REVIEW → RELEASE</small>
        </div>
      </div>
      <div className="stats-grid">
        <Stat
          label="Current release"
          value={activeRelease?.version ?? "None"}
          detail={
            client.mode === "demo"
              ? "Fictional release record"
              : "Selected for new learners"
          }
        />
        <Stat
          label="Enrolled learners"
          value={data.enrollments.length}
          detail="Pinned to a course release"
        />
        <Stat
          label="Required objectives"
          value={data.course.objectives.length}
          detail="Evidence governs progression"
        />
        <Stat
          label="Awaiting review"
          value={
            data.releases.filter((item) => item.state === "pending_review")
              .length
          }
          detail="Release decisions to make"
        />
      </div>
      <Card
        title="Course releases"
        eyebrow="Versioned, reviewable changes"
        actions={
          <Button
            onClick={() => open("draft")}
            disabled={!canWrite || actions.pending}
          >
            <Plus size={16} aria-hidden="true" />
            New draft
          </Button>
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
                <strong>Version {release.version}</strong>
                <small>{release.notes}</small>
                {release.availableForNewLearners && (
                  <small>Available to new learners</small>
                )}
              </span>
              <Status value={release.state} />
              <ArrowUpRight size={18} aria-hidden="true" />
            </button>
          ))}
        </div>
      </Card>
      {selected && (
        <Card
          title={`Release ${selected.version}`}
          eyebrow="Release inspection"
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
                  className={`check-icon ${check.passed ? "passed" : ""}`}
                  aria-hidden="true"
                >
                  {check.passed ? <Check size={16} /> : "!"}
                </span>
                <div>
                  <strong>{check.label}</strong>
                  <small>{check.detail}</small>
                </div>
                <Badge tone={check.passed ? "green" : "gold"}>
                  {check.passed ? "Recorded" : "Required"}
                </Badge>
              </li>
            ))}
          </ul>
          {selected.state === "pending_review" && (
            <Notice tone="gold">
              This release is pending review. Publication remains unavailable
              until an authorized reviewer approves it.
            </Notice>
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
                {actions.pending ? "Saving…" : "Submit for review"}
              </Button>
              {selected.checks.some((item) => !item.passed) && (
                <small>
                  Server-side bundle validation is required before this draft
                  can enter review.
                </small>
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
                {actions.pending ? "Recording…" : "Approve review"}
              </Button>
              <Button disabled>Publish after approval</Button>
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
                Publish release
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
                Edit draft bundle
              </Button>
            )}
          {selected.state === "published" && (
            <>
              <Notice tone="blue">
                This release is immutable. Make changes in a new draft. Existing
                enrollments keep their pinned version.
              </Notice>
              {selected.availableForNewLearners ? (
                <Notice>This version is selected for new learners.</Notice>
              ) : (
                <Button
                  disabled={
                    !data.permissions.includes("release.publish") ||
                    actions.pending ||
                    selected.checks.some((item) => !item.passed)
                  }
                  onClick={() => {
                    // An older release than the live one is a rollback: review its impact first.
                    if (client.releaseSafety && activeRelease && Date.parse(selected.createdAt) < Date.parse(activeRelease.createdAt)) {
                      actions.clear();
                      setRollingBack(true);
                    } else void transition(selected, "activate");
                  }}
                >
                  Use for new learners
                </Button>
              )}
            </>
          )}
          <ReleaseSafetyPanel data={data} client={client} actions={actions} release={selected} active={activeRelease} />
        </Card>
      )}
      <Card title="Learning objectives">
        <ol className="objectives">
          {data.course.objectives.map((objective) => (
            <li key={objective}>{objective}</li>
          ))}
        </ol>
      </Card>
      {rollingBack && selected && client.releaseSafety && (
        <RollbackDialog port={client.releaseSafety} data={data} actions={actions} release={selected} client={client} onClose={() => setRollingBack(false)} />
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
              ? "Edit course details"
              : dialog === "draft"
                ? "Create a release draft"
                : "Publish reviewed release"
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
        label={kind === "details" ? "Course title" : "Version"}
        htmlFor="course-first"
        hint={
          kind === "draft"
            ? "Use a unique semantic version, for example 1.2.0."
            : undefined
        }
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
        label={kind === "details" ? "Course description" : "Release notes"}
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
          ? "Saving…"
          : kind === "details"
            ? "Save course details"
            : "Create draft"}
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
        Version <strong>{version}</strong> has an approved review. New
        enrollments may use this release; existing ones keep their pinned
        version.
      </p>
      {demo && (
        <Notice tone="gold">
          Demo only. This changes an in-memory release record and does not
          deploy anything.
        </Notice>
      )}
      <label className="check-label">
        <input
          type="checkbox"
          checked={consent}
          onChange={(e) => setConsent(e.target.checked)}
          disabled={pending}
        />
        I confirm publication of version {version}.
      </label>
      <Button kind="primary" type="submit" disabled={!consent || pending}>
        {pending ? "Recording…" : "Confirm publication"}
      </Button>
    </form>
  );
}
