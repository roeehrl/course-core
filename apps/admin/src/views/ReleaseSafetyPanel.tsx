import { useEffect, useId, useState } from "react";
import { ActionFeedback } from "../components/ActionFeedback";
import { Archive, GitCompare, TriangleAlert } from "lucide-react";
import type {
  AdminClient,
  CourseWorkspace,
  Release,
} from "../domain/contracts";
import type { WorkspaceActions } from "../hooks/useAdmin";
import { errorMessage } from "../domain/errors";
import type {
  DefectPreview,
  ReleaseDiff,
  ReleaseSafetyPort,
  RollbackImpact,
} from "../domain/releaseSafety";
import { Badge, Button, Dialog, Field, Notice } from "../components/ui";
import { useT } from "../i18n";

type Port = ReleaseSafetyPort;

/** Comparison, archive and defective-item controls for one published or archived release. */
export function ReleaseSafetyPanel({
  data,
  client,
  actions,
  release,
  active,
}: {
  data: CourseWorkspace;
  client: AdminClient;
  actions: WorkspaceActions;
  release: Release;
  active: Release | undefined;
}) {
  const port = client.releaseSafety;
  const t = useT();
  const [diff, setDiff] = useState<ReleaseDiff>();
  const [diffError, setDiffError] = useState<unknown>();
  const [defecting, setDefecting] = useState(false);
  const canPublish = data.permissions.includes("release.publish");
  const isActive = release.availableForNewLearners === true;
  if (release.state !== "published" && release.state !== "archived")
    return null;
  return (
    <div className="stack release-safety">
      <div className="tag-row">
        {port && active && !isActive && (
          <Button
            kind="quiet"
            onClick={() => {
              setDiffError(undefined);
              port
                .diff(data.course.id, release.id, active.id)
                .then(setDiff, setDiffError);
            }}
          >
            <GitCompare size={16} aria-hidden="true" />{" "}
            {t("releaseSafetyPanel.compare")}
          </Button>
        )}
        {release.state === "published" && !isActive && canPublish && (
          <Button
            disabled={actions.pending}
            onClick={() =>
              void actions.run(
                JSON.stringify(["release", release.id, "archive"]),
                (context) =>
                  client.transitionRelease(
                    data.course.id,
                    release.id,
                    "archive",
                    context,
                  ),
              )
            }
          >
            <Archive size={16} aria-hidden="true" />{" "}
            {t("releaseSafetyPanel.archive")}
          </Button>
        )}
        {port && canPublish && (
          <Button
            kind="danger"
            disabled={actions.pending}
            onClick={() => {
              actions.clear();
              setDefecting(true);
            }}
          >
            <TriangleAlert size={16} aria-hidden="true" />{" "}
            {t("releaseSafetyPanel.markDefective")}
          </Button>
        )}
      </div>
      {release.state === "archived" && (
        <Notice tone="blue">{t("releaseSafetyPanel.archivedNotice")}</Notice>
      )}
      {diffError !== undefined && (
        <Notice tone="red">{errorMessage(diffError, t)}</Notice>
      )}
      {diff && <DiffSummary diff={diff} />}
      {defecting && port && (
        <DefectDialog
          port={port}
          data={data}
          actions={actions}
          release={release}
          onClose={() => setDefecting(false)}
        />
      )}
    </div>
  );
}

function DiffSummary({ diff }: { diff: ReleaseDiff }) {
  const t = useT();
  return (
    <section
      aria-label={t("releaseSafetyPanel.diff.label", {
        from: diff.from.version,
        to: diff.to.version,
      })}
      className="release-diff"
    >
      <p>
        <strong>
          {t("releaseSafetyPanel.diff.versions", {
            from: diff.from.version,
            to: diff.to.version,
          })}
        </strong>{" "}
        ·{" "}
        {t("releaseSafetyPanel.diff.summary", {
          identical: diff.identical ? "yes" : "no",
          count: diff.changes,
        })}
      </p>
      <ul className="impact-list">
        {Object.entries(diff.kinds)
          .filter(
            ([, k]) => k.added.length + k.removed.length + k.changed.length > 0,
          )
          .map(([kind, k]) => (
            <li key={kind}>
              <span dir="ltr">
                {kind}:{" "}
                {[
                  ...k.added.map((i) => `+${i}`),
                  ...k.removed.map((i) => `−${i}`),
                  ...k.changed.map((i) => `~${i}`),
                ].join(", ")}
              </span>
              <Badge>
                {t("releaseSafetyPanel.diff.unchanged", {
                  count: k.unchanged,
                })}
              </Badge>
            </li>
          ))}
      </ul>
    </section>
  );
}

/** Selecting an older release for new learners: staff read and confirm its exact impact. */
export function RollbackDialog({
  port,
  data,
  actions,
  release,
  client,
  onClose,
}: {
  port: Port;
  data: CourseWorkspace;
  actions: WorkspaceActions;
  release: Release;
  client: AdminClient;
  onClose: () => void;
}) {
  const t = useT();
  const [impact, setImpact] = useState<RollbackImpact>();
  const [error, setError] = useState<unknown>();
  const [loading, setLoading] = useState(false);
  const load = () => {
    setLoading(true);
    setError(undefined);
    port
      .rollbackImpact(data.course.id, release.id)
      .then(setImpact, setError)
      .finally(() => setLoading(false));
  };
  useEffect(() => {
    if (!impact) load();
    // Reload only when the impact was cleared (after a refused confirmation).
  }, [impact === undefined]);
  return (
    <Dialog
      title={t("releaseSafetyPanel.rollback.title", {
        version: release.version,
      })}
      eyebrow={t("releaseSafetyPanel.rollback.eyebrow")}
      onClose={onClose}
      pending={actions.pending}
    >
      <ActionFeedback actions={actions} />
      {loading && <p>{t("releaseSafetyPanel.rollback.loading")}</p>}
      {error !== undefined && (
        <Notice tone="red">{errorMessage(error, t)}</Notice>
      )}
      {impact && (
        <div className="stack">
          <ul className="impact-list">
            <li>
              <span>{t("releaseSafetyPanel.rollback.newStart")}</span>
              <Badge>
                <span dir="ltr">{impact.impact.to.version}</span>
              </Badge>
            </li>
            <li>
              <span>
                {t("releaseSafetyPanel.rollback.pinnedToActive", {
                  version: impact.impact.from.version,
                })}
              </span>
              <Badge>{impact.impact.learnersPinnedToActive}</Badge>
            </li>
            <li>
              <span>
                {t("releaseSafetyPanel.rollback.pinnedToTarget", {
                  version: impact.impact.to.version,
                })}
              </span>
              <Badge>{impact.impact.learnersPinnedToTarget}</Badge>
            </li>
            <li>
              <span>{t("releaseSafetyPanel.rollback.contentChanges")}</span>
              <Badge>{impact.impact.contentChanges}</Badge>
            </li>
            <li>
              <span>
                {t("releaseSafetyPanel.rollback.evidenceOnChanged", {
                  count: impact.impact.learnersWithEvidenceOnChangedItems,
                })}
              </span>
              <Badge
                tone={impact.impact.evidenceOnChangedItems ? "gold" : "neutral"}
              >
                {impact.impact.evidenceOnChangedItems}
              </Badge>
            </li>
          </ul>
          {impact.impact.targetDefectiveItems.length > 0 && (
            <Notice
              tone="gold"
              title={t("releaseSafetyPanel.rollback.defectiveTitle")}
            >
              <span dir="ltr">
                {impact.impact.targetDefectiveItems.join(", ")}
              </span>
            </Notice>
          )}
          <Notice tone="blue">
            {t("releaseSafetyPanel.rollback.nobodyMoved")}
          </Notice>
          <Button
            kind="primary"
            disabled={actions.pending}
            onClick={async () => {
              const result = await actions.run(
                JSON.stringify([
                  "release",
                  release.id,
                  "rollback",
                  impact.impactDigest,
                ]),
                (context) =>
                  client.transitionRelease(
                    data.course.id,
                    release.id,
                    "activate",
                    context,
                    { impactDigest: impact.impactDigest },
                  ),
              );
              if (result) onClose();
              // A changed impact is shown again for a fresh confirmation.
              else setImpact(undefined);
            }}
          >
            {t("releaseSafetyPanel.rollback.confirm")}
          </Button>
        </div>
      )}
    </Dialog>
  );
}

function DefectDialog({
  port,
  data,
  actions,
  release,
  onClose,
}: {
  port: Port;
  data: CourseWorkspace;
  actions: WorkspaceActions;
  release: Release;
  onClose: () => void;
}) {
  const t = useT();
  const id = useId();
  const [item, setItem] = useState("");
  const [preview, setPreview] = useState<DefectPreview>();
  const [reason, setReason] = useState("");
  const [acknowledge, setAcknowledge] = useState(false);
  const [error, setError] = useState<unknown>();
  const p = preview?.preview;
  return (
    <Dialog
      title={t("releaseSafetyPanel.defect.title", {
        version: release.version,
      })}
      eyebrow={t("releaseSafetyPanel.defect.eyebrow")}
      onClose={onClose}
      pending={actions.pending}
    >
      <ActionFeedback actions={actions} />
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          setError(undefined);
          port
            .previewDefect(data.course.id, release.id, item.trim())
            .then(setPreview, setError);
        }}
      >
        <Field
          label={t("releaseSafetyPanel.defect.item.label")}
          htmlFor={`${id}-item`}
          hint={t("releaseSafetyPanel.defect.item.hint")}
        >
          <input
            id={`${id}-item`}
            dir="ltr"
            value={item}
            maxLength={200}
            onChange={(e) => {
              setItem(e.target.value);
              setPreview(undefined);
            }}
          />
        </Field>
        <Button type="submit" disabled={!item.trim()}>
          {t("releaseSafetyPanel.defect.preview")}
        </Button>
      </form>
      {error !== undefined && (
        <Notice tone="red">{errorMessage(error, t)}</Notice>
      )}
      {p && preview && (
        <form
          className="stack"
          onSubmit={async (e) => {
            e.preventDefault();
            const input = {
              assessmentId: p.assessmentId,
              reason: reason.trim(),
              previewDigest: preview.previewDigest,
              acknowledgeNoReplacement: acknowledge,
            };
            const result = await actions.run(
              JSON.stringify(["defect", release.id, input]),
              (context) =>
                port.markDefective(data.course.id, release.id, input, context),
            );
            if (result) onClose();
          }}
        >
          {p.alreadyDefective ? (
            <Notice tone="gold">
              {t("releaseSafetyPanel.defect.already")}
            </Notice>
          ) : (
            <ul
              className="impact-list"
              aria-label={t("releaseSafetyPanel.defect.impactLabel")}
            >
              <li>
                <span>{t("releaseSafetyPanel.defect.evidence")}</span>
                <Badge tone="gold">{p.evidenceToInvalidate}</Badge>
              </li>
              <li>
                <span>{t("releaseSafetyPanel.defect.learners")}</span>
                <Badge>{p.affectedEnrollments}</Badge>
              </li>
              <li>
                <span>{t("releaseSafetyPanel.defect.questions")}</span>
                <Badge>{p.openChallengesToClose}</Badge>
              </li>
              <li>
                <span>{t("releaseSafetyPanel.defect.replacements")}</span>
                <Badge tone={p.replacement.available ? "green" : "red"}>
                  {p.replacement.available ? (
                    <span dir="ltr">{p.replacement.itemIds.join(", ")}</span>
                  ) : (
                    t("releaseSafetyPanel.defect.noReplacement")
                  )}
                </Badge>
              </li>
            </ul>
          )}
          <Field
            label={t("releaseSafetyPanel.defect.reason.label")}
            htmlFor={`${id}-reason`}
            hint={t("releaseSafetyPanel.defect.reason.hint")}
          >
            <textarea
              id={`${id}-reason`}
              rows={3}
              dir="auto"
              maxLength={2000}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
          {!p.replacement.available && !p.alreadyDefective && (
            <label className="check-label">
              <input
                type="checkbox"
                checked={acknowledge}
                onChange={(e) => setAcknowledge(e.target.checked)}
              />
              {t("releaseSafetyPanel.defect.acknowledge")}
            </label>
          )}
          <Button
            kind="danger"
            type="submit"
            disabled={
              actions.pending ||
              p.alreadyDefective ||
              reason.trim().length < 10 ||
              (!p.replacement.available && !acknowledge)
            }
          >
            {t("releaseSafetyPanel.defect.submit")}
          </Button>
        </form>
      )}
    </Dialog>
  );
}
