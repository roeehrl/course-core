import { useEffect, useId, useState } from "react";
import { ActionFeedback } from "../components/ActionFeedback";
import { Archive, GitCompare, TriangleAlert } from "lucide-react";
import type { AdminClient, CourseWorkspace, Release } from "../domain/contracts";
import type { WorkspaceActions } from "../hooks/useAdmin";
import { errorMessage } from "../domain/errors";
import type { DefectPreview, ReleaseDiff, ReleaseSafetyPort, RollbackImpact } from "../domain/releaseSafety";
import { Badge, Button, Dialog, Field, Notice } from "../components/ui";

type Port = ReleaseSafetyPort;

/** Comparison, archive and defective-item controls for one published or archived release. */
export function ReleaseSafetyPanel({ data, client, actions, release, active }: {
  data: CourseWorkspace; client: AdminClient; actions: WorkspaceActions; release: Release; active: Release | undefined;
}) {
  const port = client.releaseSafety;
  const [diff, setDiff] = useState<ReleaseDiff>();
  const [diffError, setDiffError] = useState<unknown>();
  const [defecting, setDefecting] = useState(false);
  const canPublish = data.permissions.includes("release.publish");
  const isActive = release.availableForNewLearners === true;
  if (release.state !== "published" && release.state !== "archived") return null;
  return (
    <div className="stack release-safety">
      <div className="tag-row">
        {port && active && !isActive && (
          <Button
            kind="quiet"
            onClick={() => {
              setDiffError(undefined);
              port.diff(data.course.id, release.id, active.id).then(setDiff, setDiffError);
            }}
          >
            <GitCompare size={16} aria-hidden="true" /> Compare with the live release
          </Button>
        )}
        {release.state === "published" && !isActive && canPublish && (
          <Button
            disabled={actions.pending}
            onClick={() => void actions.run(JSON.stringify(["release", release.id, "archive"]), (context) => client.transitionRelease(data.course.id, release.id, "archive", context))}
          >
            <Archive size={16} aria-hidden="true" /> Archive release
          </Button>
        )}
        {port && canPublish && (
          <Button kind="danger" disabled={actions.pending} onClick={() => { actions.clear(); setDefecting(true); }}>
            <TriangleAlert size={16} aria-hidden="true" /> Mark an item defective
          </Button>
        )}
      </div>
      {release.state === "archived" && (
        <Notice tone="blue">Archived: no new learner starts on it. Learners already on it keep their release, evidence and support.</Notice>
      )}
      {diffError !== undefined && <Notice tone="red">{errorMessage(diffError)}</Notice>}
      {diff && <DiffSummary diff={diff} />}
      {defecting && port && (
        <DefectDialog port={port} data={data} actions={actions} release={release} onClose={() => setDefecting(false)} />
      )}
    </div>
  );
}

function DiffSummary({ diff }: { diff: ReleaseDiff }) {
  return (
    <section aria-label={`Changes from version ${diff.from.version} to ${diff.to.version}`} className="release-diff">
      <p>
        <strong>
          Version {diff.from.version} → {diff.to.version}
        </strong>{" "}
        · {diff.identical ? "identical content" : `${diff.changes} change${diff.changes === 1 ? "" : "s"}`}
      </p>
      <ul className="impact-list">
        {Object.entries(diff.kinds)
          .filter(([, k]) => k.added.length + k.removed.length + k.changed.length > 0)
          .map(([kind, k]) => (
            <li key={kind}>
              <span>
                {kind}: {[...k.added.map((i) => `+${i}`), ...k.removed.map((i) => `−${i}`), ...k.changed.map((i) => `~${i}`)].join(", ")}
              </span>
              <Badge>{k.unchanged} unchanged</Badge>
            </li>
          ))}
      </ul>
    </section>
  );
}

/** Selecting an older release for new learners: staff read and confirm its exact impact. */
export function RollbackDialog({ port, data, actions, release, client, onClose }: {
  port: Port; data: CourseWorkspace; actions: WorkspaceActions; release: Release; client: AdminClient; onClose: () => void;
}) {
  const [impact, setImpact] = useState<RollbackImpact>();
  const [error, setError] = useState<unknown>();
  const [loading, setLoading] = useState(false);
  const load = () => {
    setLoading(true);
    setError(undefined);
    port.rollbackImpact(data.course.id, release.id).then(setImpact, setError).finally(() => setLoading(false));
  };
  useEffect(() => {
    if (!impact) load();
    // Reload only when the impact was cleared (after a refused confirmation).
  }, [impact === undefined]);
  return (
    <Dialog title={`Roll back new learners to version ${release.version}`} eyebrow="Rollback impact" onClose={onClose} pending={actions.pending}>
      <ActionFeedback actions={actions} />
      {loading && <p>Working out the impact…</p>}
      {error !== undefined && <Notice tone="red">{errorMessage(error)}</Notice>}
      {impact && (
        <div className="stack">
          <ul className="impact-list">
            <li><span>New learners will start on</span><Badge>{impact.impact.to.version}</Badge></li>
            <li><span>Learners on {impact.impact.from.version} (they stay on it)</span><Badge>{impact.impact.learnersPinnedToActive}</Badge></li>
            <li><span>Learners already on {impact.impact.to.version}</span><Badge>{impact.impact.learnersPinnedToTarget}</Badge></li>
            <li><span>Content changes between the versions</span><Badge>{impact.impact.contentChanges}</Badge></li>
            <li>
              <span>Evidence on items that differ ({impact.impact.learnersWithEvidenceOnChangedItems} learners)</span>
              <Badge tone={impact.impact.evidenceOnChangedItems ? "gold" : "neutral"}>{impact.impact.evidenceOnChangedItems}</Badge>
            </li>
          </ul>
          {impact.impact.targetDefectiveItems.length > 0 && (
            <Notice tone="gold" title="Items marked defective on this version">{impact.impact.targetDefectiveItems.join(", ")}</Notice>
          )}
          <Notice tone="blue">Nobody is moved: existing learners keep the version they started on.</Notice>
          <Button
            kind="primary"
            disabled={actions.pending}
            onClick={async () => {
              const result = await actions.run(JSON.stringify(["release", release.id, "rollback", impact.impactDigest]), (context) =>
                client.transitionRelease(data.course.id, release.id, "activate", context, { impactDigest: impact.impactDigest }),
              );
              if (result) onClose();
              // A changed impact is shown again for a fresh confirmation.
              else setImpact(undefined);
            }}
          >
            Confirm rollback
          </Button>
        </div>
      )}
    </Dialog>
  );
}

function DefectDialog({ port, data, actions, release, onClose }: { port: Port; data: CourseWorkspace; actions: WorkspaceActions; release: Release; onClose: () => void }) {
  const id = useId();
  const [item, setItem] = useState("");
  const [preview, setPreview] = useState<DefectPreview>();
  const [reason, setReason] = useState("");
  const [acknowledge, setAcknowledge] = useState(false);
  const [error, setError] = useState<unknown>();
  const p = preview?.preview;
  return (
    <Dialog title={`Mark an item defective in version ${release.version}`} eyebrow="Defective item" onClose={onClose} pending={actions.pending}>
      <ActionFeedback actions={actions} />
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          setError(undefined);
          port.previewDefect(data.course.id, release.id, item.trim()).then(setPreview, setError);
        }}
      >
        <Field label="Item ID" htmlFor={`${id}-item`} hint="The assessment's ID in the course bundle.">
          <input id={`${id}-item`} value={item} maxLength={200} onChange={(e) => { setItem(e.target.value); setPreview(undefined); }} />
        </Field>
        <Button type="submit" disabled={!item.trim()}>Preview the impact</Button>
      </form>
      {error !== undefined && <Notice tone="red">{errorMessage(error)}</Notice>}
      {p && preview && (
        <form
          className="stack"
          onSubmit={async (e) => {
            e.preventDefault();
            const input = { assessmentId: p.assessmentId, reason: reason.trim(), previewDigest: preview.previewDigest, acknowledgeNoReplacement: acknowledge };
            const result = await actions.run(JSON.stringify(["defect", release.id, input]), (context) => port.markDefective(data.course.id, release.id, input, context));
            if (result) onClose();
          }}
        >
          {p.alreadyDefective ? (
            <Notice tone="gold">This item is already marked defective on this release.</Notice>
          ) : (
            <ul className="impact-list" aria-label="What marking it defective does">
              <li><span>Evidence records invalidated (with your reason)</span><Badge tone="gold">{p.evidenceToInvalidate}</Badge></li>
              <li><span>Learners affected</span><Badge>{p.affectedEnrollments}</Badge></li>
              <li><span>Open questions closed</span><Badge>{p.openChallengesToClose}</Badge></li>
              <li><span>Replacement items</span><Badge tone={p.replacement.available ? "green" : "red"}>{p.replacement.available ? p.replacement.itemIds.join(", ") : "none"}</Badge></li>
            </ul>
          )}
          <Field label="Reason (learners' records keep it)" htmlFor={`${id}-reason`} hint="At least 10 characters.">
            <textarea id={`${id}-reason`} rows={3} maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          {!p.replacement.available && !p.alreadyDefective && (
            <label className="check-label">
              <input type="checkbox" checked={acknowledge} onChange={(e) => setAcknowledge(e.target.checked)} />
              No other item replaces it: learners lose this route to the checkpoint until a new release adds one
            </label>
          )}
          <Button kind="danger" type="submit" disabled={actions.pending || p.alreadyDefective || reason.trim().length < 10 || (!p.replacement.available && !acknowledge)}>
            Mark defective and invalidate evidence
          </Button>
        </form>
      )}
    </Dialog>
  );
}
