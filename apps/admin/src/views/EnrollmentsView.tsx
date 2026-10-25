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
import { RegradeDialogBody } from "../components/RegradeDialog";
import {
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  Field,
  Notice,
  PermissionHint,
} from "../components/ui";
import { useI18n, useT, type MessageKey } from "../i18n";
import { learnerName } from "../domain/learnerName";

/** Status badge tones, as the shared status badge colours them. */
const statusTone: Record<string, "green" | "gold" | "red"> = {
  accepted: "green",
  completed: "green",
  pending_review: "gold",
  rejected: "red",
  stale: "red",
};

export function EnrollmentsView({
  data,
  client,
  actions,
}: {
  data: CourseWorkspace;
  client: AdminClient;
  actions: WorkspaceActions;
}) {
  const i18n = useI18n();
  const t = i18n.t;
  /** A server code shown through the catalog; an unknown code is shown as is. */
  const label = (key: string, fallback: string) =>
    i18n.has(key as MessageKey) ? t(key as MessageKey) : fallback;
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState(data.enrollments[0]?.id);
  const [dialog, setDialog] = useState<"enroll" | "profile">();
  const [evidenceId, setEvidenceId] = useState<string>();
  /** The attempt a scoped regrade (U07) is open for. */
  const [regrading, setRegrading] = useState<{
    attemptId: string;
    objective: string;
  }>();
  const canRegrade =
    data.permissions.includes("evidence.regrade") && !!client.regrade;
  const selected = data.enrollments.find((item) => item.id === selectedId);
  const visible = data.enrollments.filter((item) =>
    `${learnerName(t, item)} ${item.learnerRef}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  const canWrite = data.permissions.includes("enrollment.write");
  return (
    <div className="page-stack">
      <ActionFeedback actions={actions} />
      <div className="section-heading">
        <div>
          <h2>{t("enrollmentsView.heading")}</h2>
          <p>{t("enrollmentsView.intro")}</p>
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
          {t("enrollmentsView.newEnrollment")}
        </Button>
      </div>
      <PermissionHint
        permissions={data.permissions}
        required="enrollment.write"
      />
      <div className="master-detail">
        <Card title={t("enrollmentsView.title")}>
          <Field label={t("enrollmentsView.find")} htmlFor="learner-search">
            <div className="search-field">
              <Search size={17} aria-hidden="true" />
              {/* No dir="auto": the field keeps the UI's direction so the room for the icon
                  stays on its side; .search-field shows a typed name in its own direction. */}
              <input
                id="learner-search"
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t("enrollmentsView.find.placeholder")}
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
                  <strong>
                    <bdi>{learnerName(t, item)}</bdi>
                  </strong>
                  <small>
                    {t("enrollmentsView.item.progress", {
                      completed: item.completed,
                      required: item.required,
                      status: label(
                        `enrollmentsView.status.${item.status}`,
                        item.status,
                      ),
                    })}
                  </small>
                </span>
              </button>
            ))}
          </div>
          {!visible.length && (
            <EmptyState title={t("enrollmentsView.noMatch.title")}>
              {t("enrollmentsView.noMatch.body")}
            </EmptyState>
          )}
        </Card>
        {selected ? (
          <div className="stack">
            <Card
              title={learnerName(t, selected)}
              titleDir="auto"
              eyebrow={t("enrollmentsView.profile.eyebrow")}
              actions={
                <Button
                  disabled={!canWrite || actions.pending}
                  onClick={() => {
                    actions.clear();
                    setDialog("profile");
                  }}
                >
                  {t("enrollmentsView.profile.edit")}
                </Button>
              }
            >
              <div className="split-line">
                <Badge tone={statusTone[selected.status] ?? "neutral"}>
                  {label(
                    `enrollmentsView.status.${selected.status}`,
                    selected.status,
                  )}
                </Badge>
                <span className="mono" dir="ltr">
                  {selected.learnerRef}
                </span>
              </div>
              {selected.profile.goal ? (
                <p dir="auto">{selected.profile.goal}</p>
              ) : (
                <p>{t("enrollmentsView.noGoal")}</p>
              )}
              <dl className="facts">
                <div>
                  <dt>{t("enrollmentsView.pinnedRelease")}</dt>
                  <dd dir="ltr">{selected.releaseVersion}</dd>
                </div>
                <div>
                  <dt>{t("enrollmentsView.pace")}</dt>
                  <dd>
                    {label(
                      `enrollmentsView.paceValue.${selected.profile.pace}`,
                      selected.profile.pace,
                    )}
                  </dd>
                </div>
                <div>
                  <dt>{t("enrollmentsView.placement")}</dt>
                  <dd>
                    {!selected.placement
                      ? t("enrollmentsView.placement.notTaken")
                      : selected.placement.state === "accepted"
                        ? t("enrollmentsView.placement.accepted", {
                            count: selected.placement.exemptEpisodeIds.filter(
                              (id) =>
                                selected.lessons?.find((l) => l.id === id)
                                  ?.status === "placed",
                            ).length,
                          })
                        : selected.placement.stopReason
                          ? t("enrollmentsView.placement.stateWithReason", {
                              state: label(
                                `enrollmentsView.placement.state.${selected.placement.state}`,
                                selected.placement.state,
                              ),
                              reason: label(
                                `enrollmentsView.placement.stopReason.${selected.placement.stopReason}`,
                                selected.placement.stopReason.replaceAll(
                                  "_",
                                  " ",
                                ),
                              ),
                            })
                          : label(
                              `enrollmentsView.placement.state.${selected.placement.state}`,
                              selected.placement.state,
                            )}
                  </dd>
                </div>
              </dl>
              <div className="progress-label">
                <span>{t("enrollmentsView.requiredObjectives")}</span>
                <strong>
                  {t("enrollmentsView.progress", {
                    completed: selected.completed,
                    required: selected.required,
                  })}
                </strong>
              </div>
              <progress
                aria-label={t("enrollmentsView.progress.label", {
                  name: learnerName(t, selected),
                })}
                value={selected.completed}
                max={selected.required}
              />
              <small>{t("enrollmentsView.progress.note")}</small>
            </Card>
            <Card
              title={t("enrollmentsView.evidence.title")}
              eyebrow={t("enrollmentsView.evidence.eyebrow")}
            >
              <PermissionHint
                permissions={data.permissions}
                required="evidence.review"
              />
              {selected.evidence.length ? (
                selected.evidence.map((evidence) => (
                  <article key={evidence.id} className="evidence-item">
                    <div className="split-line">
                      <h3 dir="auto">{evidence.objective}</h3>
                      <Badge tone={statusTone[evidence.status] ?? "neutral"}>
                        {label(
                          `enrollmentsView.evidenceStatus.${evidence.status}`,
                          evidence.status.replaceAll("_", " "),
                        )}
                      </Badge>
                    </div>
                    <p dir="auto">{evidence.summary}</p>
                    <small className="mono" dir="ltr">
                      {evidence.version} / {evidence.rubricVersion}
                    </small>
                    {evidence.receiptId && (
                      <small>
                        {t("enrollmentsView.evidence.receipt", {
                          id: evidence.receiptId,
                        })}
                      </small>
                    )}
                    {evidence.status === "stale" && (
                      <Notice tone="gold">
                        {t("enrollmentsView.evidence.stale")}
                      </Notice>
                    )}
                    {(evidence.reviewable ||
                      evidence.status === "pending_review" ||
                      evidence.status === "accepted") && (
                      <Button
                        aria-label={t("enrollmentsView.evidence.reviewLabel", {
                          objective: evidence.objective,
                        })}
                        onClick={() => {
                          actions.clear();
                          setEvidenceId(evidence.id);
                        }}
                        disabled={
                          !data.permissions.includes("evidence.review") ||
                          actions.pending
                        }
                      >
                        {t("enrollmentsView.evidence.review")}
                      </Button>
                    )}
                    {canRegrade &&
                      evidence.regradable &&
                      evidence.attemptId && (
                        <Button
                          kind="quiet"
                          aria-label={t(
                            "enrollmentsView.evidence.regradeLabel",
                            { objective: evidence.objective },
                          )}
                          onClick={() =>
                            setRegrading({
                              attemptId: evidence.attemptId!,
                              objective: evidence.objective,
                            })
                          }
                          disabled={actions.pending}
                        >
                          {t("enrollmentsView.evidence.regrade")}
                        </Button>
                      )}
                  </article>
                ))
              ) : (
                <EmptyState title={t("enrollmentsView.noEvidence.title")}>
                  {t("enrollmentsView.noEvidence.body")}
                </EmptyState>
              )}
            </Card>
            {data.permissions.includes("learner.view") && (
              <LearnerViewCard
                key={`view-${selected.id}`}
                client={client}
                enrollment={selected}
                permissions={data.permissions}
              />
            )}
            <TeachingHypothesesCard
              key={`hypotheses-${selected.id}`}
              client={client}
              enrollment={selected}
            />
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
          <EmptyState title={t("enrollmentsView.select.title")}>
            {t("enrollmentsView.select.body")}
          </EmptyState>
        )}
      </div>
      {dialog && (
        <Dialog
          title={
            dialog === "enroll"
              ? t("enrollmentsView.create")
              : t("enrollmentsView.editProfile")
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
      {regrading && selected && client.regrade && (
        <Dialog
          title={t("enrollmentsView.regrade.title", {
            objective: regrading.objective,
          })}
          eyebrow={t("enrollmentsView.regrade.eyebrow")}
          onClose={() => setRegrading(undefined)}
        >
          <RegradeDialogBody
            port={client.regrade}
            enrollmentId={selected.id}
            attemptId={regrading.attemptId}
            onDone={() => void actions.resync()}
          />
        </Dialog>
      )}
      {evidenceId && selected && (
        <Dialog
          title={t("enrollmentsView.evidence.review")}
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
  const t = useT();
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
        <Field
          label={t("enrollmentsView.pinnedRelease")}
          htmlFor="enrollment-release"
        >
          <select
            id="enrollment-release"
            required
            value={releaseId}
            onChange={(event) => setReleaseId(event.target.value)}
            disabled={pending}
          >
            {!releases.length && (
              <option value="">{t("enrollmentsView.form.noReleases")}</option>
            )}
            {releases.map((release) => (
              <option key={release.id} value={release.id} dir="ltr">
                {release.version}
              </option>
            ))}
          </select>
        </Field>
      )}
      {!enrollment && (
        <Field
          label={t("enrollmentsView.form.learnerRef")}
          htmlFor="learner-ref"
          hint={t("enrollmentsView.form.learnerRef.hint")}
        >
          <input
            id="learner-ref"
            dir="ltr"
            value={ref}
            onChange={(e) => setRef(e.target.value)}
            required
            pattern="[a-zA-Z0-9_-]{3,80}"
            disabled={pending}
          />
        </Field>
      )}
      <Field
        label={t("enrollmentsView.form.displayName")}
        htmlFor="profile-name"
      >
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
      <Field label={t("enrollmentsView.form.goal")} htmlFor="profile-goal">
        <textarea
          id="profile-goal"
          maxLength={2000}
          value={profile.goal}
          onChange={(e) => setProfile({ ...profile, goal: e.target.value })}
          disabled={pending}
        />
      </Field>
      <Field label={t("enrollmentsView.pace")} htmlFor="profile-pace">
        <select
          id="profile-pace"
          value={profile.pace}
          onChange={(e) =>
            setProfile({ ...profile, pace: e.target.value as Profile["pace"] })
          }
          disabled={pending}
        >
          <option value="gentle">
            {t("enrollmentsView.form.pace.gentle")}
          </option>
          <option value="steady">
            {t("enrollmentsView.form.pace.steady")}
          </option>
          <option value="focused">
            {t("enrollmentsView.form.pace.focused")}
          </option>
        </select>
      </Field>
      <div className="dialog-footer">
        <Button kind="primary" type="submit" disabled={pending}>
          {pending
            ? t("enrollmentsView.form.saving")
            : enrollment
              ? t("enrollmentsView.form.save")
              : t("enrollmentsView.create")}
        </Button>
      </div>
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
  const t = useT();
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
      <Notice tone="gold">{t("enrollmentsView.review.notice")}</Notice>
      <Field
        label={t("enrollmentsView.review.decision")}
        htmlFor="review-decision"
      >
        <select
          id="review-decision"
          value={decision}
          onChange={(e) => setDecision(e.target.value as typeof decision)}
          disabled={pending}
        >
          <option value="accept" disabled={rejectOnly}>
            {t("enrollmentsView.review.accept")}
          </option>
          <option value="reject">{t("enrollmentsView.review.reject")}</option>
        </select>
      </Field>
      <Field label={t("enrollmentsView.review.note")} htmlFor="review-note">
        <textarea
          id="review-note"
          required
          maxLength={600}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          disabled={pending}
        />
      </Field>
      <div className="dialog-footer">
        <Button kind="primary" type="submit" disabled={pending}>
          {pending
            ? t("enrollmentsView.review.recording")
            : t("enrollmentsView.review.record")}
        </Button>
      </div>
    </form>
  );
}
