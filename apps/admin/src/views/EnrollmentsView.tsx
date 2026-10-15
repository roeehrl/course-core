import { useState } from "react";
import { Plus, Search, UserRound } from "lucide-react";
import type {
  AdminClient,
  CourseWorkspace,
  Enrollment,
  Profile,
} from "../domain/contracts";
import type { WorkspaceActions } from "../hooks/useAdmin";
import { ActionFeedback } from "../components/ActionFeedback";
import { LearnerDataCard } from "../components/LearnerDataCard";
import { LearnerViewCard } from "../components/LearnerViewCard";
import { TeachingHypothesesCard } from "../components/TeachingHypothesesCard";
import {
  Button,
  Card,
  Dialog,
  EmptyState,
  Field,
  Notice,
  PermissionHint,
  Status,
} from "../components/ui";

export function EnrollmentsView({
  data,
  client,
  actions,
}: {
  data: CourseWorkspace;
  client: AdminClient;
  actions: WorkspaceActions;
}) {
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState(data.enrollments[0]?.id);
  const [dialog, setDialog] = useState<"enroll" | "profile">();
  const [evidenceId, setEvidenceId] = useState<string>();
  const selected = data.enrollments.find((item) => item.id === selectedId);
  const visible = data.enrollments.filter((item) =>
    `${item.profile.displayName} ${item.learnerRef}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  const canWrite = data.permissions.includes("enrollment.write");
  return (
    <div className="page-stack">
      <ActionFeedback actions={actions} />
      <div className="section-heading">
        <div>
          <h2>Every learner, in context.</h2>
          <p>Profile, pinned release, progress and the evidence behind it.</p>
        </div>
        <Button
          kind="primary"
          onClick={() => {
            actions.clear();
            setDialog("enroll");
          }}
          disabled={!canWrite || actions.pending}
        >
          <Plus size={16} aria-hidden="true" />
          New enrollment
        </Button>
      </div>
      <PermissionHint
        permissions={data.permissions}
        required="enrollment.write"
      />
      <div className="master-detail">
        <Card title="Enrollments">
          <Field label="Find a learner" htmlFor="learner-search">
            <div className="search-field">
              <Search size={17} aria-hidden="true" />
              <input
                id="learner-search"
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Name or reference"
              />
            </div>
          </Field>
          <div className="selector-list">
            {visible.map((item) => (
              <button
                key={item.id}
                className={`selector-item ${selectedId === item.id ? "selected" : ""}`}
                aria-pressed={selectedId === item.id}
                disabled={actions.pending}
                onClick={() => {
                  setSelectedId(item.id);
                  actions.clear();
                }}
              >
                <span className="avatar">
                  <UserRound size={20} aria-hidden="true" />
                </span>
                <span>
                  <strong>{item.profile.displayName}</strong>
                  <small>
                    {item.completed} of {item.required} objectives ·{" "}
                    {item.status}
                  </small>
                </span>
              </button>
            ))}
          </div>
          {!visible.length && (
            <EmptyState title="No matching learners">
              Try another name or learner reference.
            </EmptyState>
          )}
        </Card>
        {selected ? (
          <div className="stack">
            <Card
              title={selected.profile.displayName}
              eyebrow="Enrollment profile"
              actions={
                <Button
                  disabled={!canWrite || actions.pending}
                  onClick={() => {
                    actions.clear();
                    setDialog("profile");
                  }}
                >
                  Edit profile
                </Button>
              }
            >
              <div className="split-line">
                <Status value={selected.status} />
                <span className="mono">{selected.learnerRef}</span>
              </div>
              <p>{selected.profile.goal || "No learning goal provided."}</p>
              <dl className="facts">
                <div>
                  <dt>Pinned release</dt>
                  <dd>{selected.releaseVersion}</dd>
                </div>
                <div>
                  <dt>Preferred pace</dt>
                  <dd>{selected.profile.pace}</dd>
                </div>
                <div>
                  <dt>Placement</dt>
                  <dd>
                    {!selected.placement
                      ? "Not taken"
                      : selected.placement.state === "accepted"
                        ? `Accepted · placed out of ${selected.placement.exemptEpisodeIds.filter((id) => selected.lessons?.find((l) => l.id === id)?.status === "placed").length} episode(s)`
                        : `${selected.placement.state.replace("_", " ")}${selected.placement.stopReason ? ` · ${selected.placement.stopReason.replaceAll("_", " ")}` : ""}`}
                  </dd>
                </div>
              </dl>
              <div className="progress-label">
                <span>Required objectives</span>
                <strong>
                  {selected.completed} / {selected.required}
                </strong>
              </div>
              <progress
                aria-label={`${selected.profile.displayName} objective progress`}
                value={selected.completed}
                max={selected.required}
              />
              <small>
                Progress reflects accepted evidence. Editing a profile does not
                award credit.
              </small>
            </Card>
            <Card title="Evidence & decisions" eyebrow="Versioned records">
              <PermissionHint
                permissions={data.permissions}
                required="evidence.review"
              />
              {selected.evidence.length ? (
                selected.evidence.map((evidence) => (
                  <article key={evidence.id} className="evidence-item">
                    <div className="split-line">
                      <h3>{evidence.objective}</h3>
                      <Status value={evidence.status} />
                    </div>
                    <p>{evidence.summary}</p>
                    <small className="mono">
                      {evidence.version} / {evidence.rubricVersion}
                    </small>
                    {evidence.receiptId && (
                      <small>Receipt: {evidence.receiptId}</small>
                    )}
                    {evidence.status === "stale" && (
                      <Notice tone="gold">
                        This evidence cannot be approved under the current
                        rubric. A new submission is required.
                      </Notice>
                    )}
                    {(evidence.reviewable ||
                      evidence.status === "pending_review" ||
                      evidence.status === "accepted") && (
                      <Button
                        aria-label={`Review evidence: ${evidence.objective}`}
                        onClick={() => {
                          actions.clear();
                          setEvidenceId(evidence.id);
                        }}
                        disabled={
                          !data.permissions.includes("evidence.review") ||
                          actions.pending
                        }
                      >
                        Review evidence
                      </Button>
                    )}
                  </article>
                ))
              ) : (
                <EmptyState title="No evidence yet">
                  New submissions will appear here with their versions and
                  receipt references.
                </EmptyState>
              )}
            </Card>
            {data.permissions.includes("learner.view") && (
              <LearnerViewCard key={`view-${selected.id}`} client={client} enrollment={selected} />
            )}
            <TeachingHypothesesCard key={`hypotheses-${selected.id}`} client={client} enrollment={selected} />
            {["owner", "admin"].includes(data.role ?? "") && (
              <LearnerDataCard
                key={selected.id}
                client={client}
                enrollment={selected}
                onErased={actions.refresh}
              />
            )}
          </div>
        ) : (
          <EmptyState title="Select an enrollment">
            Choose a learner to inspect their profile and evidence.
          </EmptyState>
        )}
      </div>
      {dialog && (
        <Dialog
          title={
            dialog === "enroll" ? "Create enrollment" : "Edit learner profile"
          }
          onClose={() => setDialog(undefined)}
          pending={actions.pending}
        >
          <ActionFeedback actions={actions} />
          <ProfileForm
            releases={data.releases.filter(
              (release) => release.state === "published",
            )}
            enrollment={dialog === "profile" ? selected : undefined}
            pending={actions.pending}
            onSave={async (profile, learnerRef, releaseId) => {
              const result =
                dialog === "enroll"
                  ? await actions.run(
                      JSON.stringify(["enroll", learnerRef, profile]),
                      (ctx) =>
                        client.enroll(
                          data.course.id,
                          { learnerRef, profile, releaseId },
                          ctx,
                        ),
                    )
                  : selected &&
                    (await actions.run(
                      JSON.stringify(["profile", selected.id, profile]),
                      (ctx) =>
                        client.updateProfile(
                          data.course.id,
                          selected.id,
                          profile,
                          { ...ctx, targetRevision: selected.revision },
                        ),
                    ));
              if (result) setDialog(undefined);
            }}
          />
        </Dialog>
      )}
      {evidenceId && selected && (
        <Dialog
          title="Review evidence"
          onClose={() => setEvidenceId(undefined)}
          pending={actions.pending}
        >
          <ActionFeedback actions={actions} />
          <EvidenceReview
            rejectOnly={
              selected.evidence.find((item) => item.id === evidenceId)
                ?.passed === false ||
              selected.evidence.find((item) => item.id === evidenceId)
                ?.independent === false
            }
            pending={actions.pending}
            onSubmit={async (input) => {
              const result = await actions.run(
                JSON.stringify(["evidence", selected.id, evidenceId, input]),
                (ctx) =>
                  client.reviewEvidence(
                    data.course.id,
                    selected.id,
                    evidenceId,
                    input,
                    { ...ctx, targetRevision: selected.revision },
                  ),
              );
              if (result) setEvidenceId(undefined);
            }}
          />
        </Dialog>
      )}
    </div>
  );
}
function ProfileForm({
  enrollment,
  releases,
  pending,
  onSave,
}: {
  enrollment?: Enrollment;
  releases: { id: string; version: string }[];
  pending: boolean;
  onSave: (profile: Profile, learnerRef: string, releaseId: string) => void;
}) {
  const [profile, setProfile] = useState<Profile>(
    enrollment?.profile ?? { displayName: "", goal: "", pace: "steady" },
  );
  const [ref, setRef] = useState("");
  const [releaseId, setReleaseId] = useState(releases[0]?.id ?? "");
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(profile, ref, releaseId);
      }}
    >
      {!enrollment && (
        <Field label="Pinned release" htmlFor="enrollment-release">
          <select
            id="enrollment-release"
            required
            value={releaseId}
            onChange={(event) => setReleaseId(event.target.value)}
            disabled={pending}
          >
            {!releases.length && (
              <option value="">No published releases</option>
            )}
            {releases.map((release) => (
              <option key={release.id} value={release.id}>
                {release.version}
              </option>
            ))}
          </select>
        </Field>
      )}
      {!enrollment && (
        <Field
          label="Learner reference"
          htmlFor="learner-ref"
          hint="An existing account reference, not a password or access token."
        >
          <input
            id="learner-ref"
            value={ref}
            onChange={(e) => setRef(e.target.value)}
            required
            pattern="[a-zA-Z0-9_-]{3,80}"
            disabled={pending}
          />
        </Field>
      )}
      <Field label="Display name" htmlFor="profile-name">
        <input
          id="profile-name"
          required
          maxLength={100}
          value={profile.displayName}
          onChange={(e) =>
            setProfile({ ...profile, displayName: e.target.value })
          }
          disabled={pending}
        />
      </Field>
      <Field label="Learning goal" htmlFor="profile-goal">
        <textarea
          id="profile-goal"
          maxLength={2000}
          value={profile.goal}
          onChange={(e) => setProfile({ ...profile, goal: e.target.value })}
          disabled={pending}
        />
      </Field>
      <Field label="Preferred pace" htmlFor="profile-pace">
        <select
          id="profile-pace"
          value={profile.pace}
          onChange={(e) =>
            setProfile({ ...profile, pace: e.target.value as Profile["pace"] })
          }
          disabled={pending}
        >
          <option value="gentle">Gentle</option>
          <option value="steady">Steady</option>
          <option value="focused">Focused</option>
        </select>
      </Field>
      <Button kind="primary" type="submit" disabled={pending}>
        {pending
          ? "Saving…"
          : enrollment
            ? "Save profile"
            : "Create enrollment"}
      </Button>
    </form>
  );
}
function EvidenceReview({
  rejectOnly = false,
  pending,
  onSubmit,
}: {
  pending: boolean;
  rejectOnly?: boolean;
  onSubmit: (input: { decision: "accept" | "reject"; note: string }) => void;
}) {
  const [decision, setDecision] = useState<"accept" | "reject">(
    rejectOnly ? "reject" : "accept",
  );
  const [note, setNote] = useState("");
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ decision, note });
      }}
    >
      <Notice tone="gold">
        Review cannot turn an incorrect or assisted result into mastery.
        Acceptance only acknowledges valid existing evidence; rejection
        invalidates it with an audit record.
      </Notice>
      <Field label="Decision" htmlFor="review-decision">
        <select
          id="review-decision"
          value={decision}
          onChange={(e) => setDecision(e.target.value as typeof decision)}
          disabled={pending}
        >
          <option value="accept" disabled={rejectOnly}>
            Acknowledge valid evidence (no grade change)
          </option>
          <option value="reject">Reject evidence</option>
        </select>
      </Field>
      <Field label="Review note" htmlFor="review-note">
        <textarea
          id="review-note"
          required
          maxLength={600}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          disabled={pending}
        />
      </Field>
      <Button kind="primary" type="submit" disabled={pending}>
        {pending ? "Recording…" : "Record review"}
      </Button>
    </form>
  );
}
