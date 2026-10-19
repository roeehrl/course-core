import { useId, useRef, useState } from "react";
import type { AdminClient, CourseWorkspace } from "../domain/contracts";
import { placementAuthorLimit, placementErrorMessage, type CoursePlacement, type EnrollmentPlacement, type PlacementAdminPort } from "../domain/placementAdmin";
import { useRemote } from "../hooks/useAdmin";
import { Badge, Button, Card, EmptyState, Field, Loading, Notice, Stat, when } from "../components/ui";
import { randomId } from "../domain/webCrypto";

/** Placement administration: the staff switch and limits (which only tighten the author's), the
 * quality counters, and each learner's exemptions with the evidence behind them. */
export function PlacementView({ data, client }: { data: CourseWorkspace; client: AdminClient }) {
  if (!client.placement)
    return (
      <Card title="Placement">
        <EmptyState title="Placement administration is not available here">Use a connected administration session.</EmptyState>
      </Card>
    );
  return <Placement port={client.placement} data={data} />;
}

function Placement({ port, data }: { port: PlacementAdminPort; data: CourseWorkspace }) {
  const course = useRemote((signal) => port.course(data.course.id, signal), [port, data.course.id]);
  const [enrollmentId, setEnrollmentId] = useState("");
  const [saved, setSaved] = useState("");
  const id = useId();
  if (course.loading) return <Loading label="Loading placement…" />;
  if (course.error || !course.data) return <Notice tone="red">{placementErrorMessage(course.error)}</Notice>;
  const c = course.data;
  const learners = data.enrollments.filter((e) => e.status !== "erased");
  return (
    <div className="page-stack">
      <div aria-live="polite">{saved && <Notice tone="green">{saved}</Notice>}</div>
      {!c.author?.enabled && <Notice tone="gold">This course's live release offers no placement. Staff settings cannot turn it on.</Notice>}
      <div className="stats-grid">
        <Stat label="Placement" value={c.effective?.enabled ? "On" : "Off"} detail={c.settings.enabled ? "Enabled by staff" : "Off until staff enable it"} />
        <Stat label="Exemptions" value={c.counters?.exemptions ?? "—"} detail="Episodes placed out of" />
        <Stat label="False skips" value={c.counters?.falseSkips.total ?? "—"} detail={c.counters ? `${c.counters.falseSkips.revokedByStaff} revoked · ${c.counters.falseSkips.laterFailed} later failed` : "Not visible to your role"} />
        <Stat label="Unnecessary repetitions" value={c.counters?.unnecessaryRepetitions ?? "—"} detail="Studied although already shown" />
      </div>
      {data.permissions.includes("policy.write") ? (
        <SettingsForm port={port} catalogId={data.course.id} placement={c} onSaved={() => { setSaved("Placement settings saved."); course.reload(); }} />
      ) : (
        <Card title="Settings">
          <p>
            {c.settings.enabled ? "Enabled" : "Off"} · up to {c.effective?.maxItems ?? 0} questions · {c.settings.maxRuns} run(s) · {c.settings.retestCooldownHours} h between runs
          </p>
        </Card>
      )}
      <Card title="A learner's placement">
        <Field label="Learner" htmlFor={`${id}-learner`}>
          <select id={`${id}-learner`} value={enrollmentId} onChange={(e) => setEnrollmentId(e.target.value)}>
            <option value="">Choose a learner</option>
            {learners.map((e) => (
              <option key={e.id} value={e.id}>
                {e.profile.displayName}
              </option>
            ))}
          </select>
        </Field>
        {enrollmentId && (
          <EnrollmentPlacementPanel
            key={enrollmentId}
            port={port}
            enrollmentId={enrollmentId}
            revision={learners.find((e) => e.id === enrollmentId)?.revision}
            canRevoke={data.permissions.includes("enrollment.write")}
          />
        )}
      </Card>
    </div>
  );
}

function SettingsForm({ port, catalogId, placement, onSaved }: { port: PlacementAdminPort; catalogId: string; placement: CoursePlacement; onSaved: () => void }) {
  const id = useId();
  const s = placement.settings, authorMax = placementAuthorLimit(placement);
  const [enabled, setEnabled] = useState(s.enabled);
  const [cooldown, setCooldown] = useState(String(s.retestCooldownHours));
  const [runs, setRuns] = useState(String(s.maxRuns));
  const [items, setItems] = useState(s.maxItems === null ? "" : String(s.maxItems));
  const [families, setFamilies] = useState(s.minFamiliesPerEpisode === null ? "" : String(s.minFamiliesPerEpisode));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const num = (v: string) => (v.trim() === "" ? null : Number(v));
  const itemsValue = num(items), familiesValue = num(families);
  const valid = Number.isInteger(Number(cooldown)) && Number(cooldown) >= 0 && Number(cooldown) <= 8760 && Number.isInteger(Number(runs)) && Number(runs) >= 1 && Number(runs) <= 10
    && (itemsValue === null || (Number.isInteger(itemsValue) && authorMax !== null && itemsValue >= 1 && itemsValue <= authorMax))
    && (familiesValue === null || (Number.isInteger(familiesValue) && familiesValue >= 1 && familiesValue <= 10));
  return (
    <Card title="Settings">
      <form
        className="input-grid"
        onSubmit={(e) => {
          e.preventDefault();
          setPending(true);
          setError(undefined);
          port
            .save(catalogId, { expectedRevision: s.revision, enabled, retestCooldownHours: Number(cooldown), maxRuns: Number(runs), maxItems: itemsValue, minFamiliesPerEpisode: familiesValue })
            .then(onSaved, setError)
            .finally(() => setPending(false));
        }}
      >
        <label className="check-label wide">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Offer placement to learners (also requires the course release to offer it)
        </label>
        <Field label="Hours before a retest" htmlFor={`${id}-cooldown`} hint="0 to 8760.">
          <input id={`${id}-cooldown`} type="number" min={0} max={8760} value={cooldown} onChange={(e) => setCooldown(e.target.value)} />
        </Field>
        <Field label="Runs per learner" htmlFor={`${id}-runs`} hint="1 means no retest.">
          <input id={`${id}-runs`} type="number" min={1} max={10} value={runs} onChange={(e) => setRuns(e.target.value)} />
        </Field>
        <Field
          label="Question limit"
          htmlFor={`${id}-items`}
          hint={authorMax === null
            ? "No published release offers placement; leave this empty."
            : `Empty keeps each release's author limit. At most ${authorMax}, the lowest limit among the published releases that offer placement.`}
        >
          <input id={`${id}-items`} type="number" min={1} max={authorMax ?? undefined} value={items} onChange={(e) => setItems(e.target.value)} />
        </Field>
        <Field label="Item families per episode" htmlFor={`${id}-families`} hint="Empty uses each gate's rule; a number adds a stricter requirement.">
          <input id={`${id}-families`} type="number" min={1} max={10} value={families} onChange={(e) => setFamilies(e.target.value)} />
        </Field>
        <div className="wide stack">
          {error !== undefined && <Notice tone="red">{placementErrorMessage(error)}</Notice>}
          <Button kind="primary" type="submit" disabled={pending || !valid}>
            Save placement settings
          </Button>
        </div>
      </form>
    </Card>
  );
}

function EnrollmentPlacementPanel({ port, enrollmentId, revision, canRevoke }: { port: PlacementAdminPort; enrollmentId: string; revision: number | undefined; canRevoke: boolean }) {
  const view = useRemote((signal) => port.enrollment(enrollmentId, signal), [port, enrollmentId]);
  const [currentRevision, setCurrentRevision] = useState(revision);
  if (view.loading) return <Loading label="Loading this learner's placement…" />;
  if (view.error || !view.data) return <Notice tone="red">{placementErrorMessage(view.error)}</Notice>;
  const v: EnrollmentPlacement = view.data;
  return (
    <div className="stack">
      {v.runs.length === 0 ? (
        <p className="muted">No placement run.</p>
      ) : (
        <ul className="placement-runs" aria-label="Placement runs">
          {v.runs.map((r) => (
            <li key={r.runNumber}>
              Run {r.runNumber}: <Badge>{r.state}</Badge> {r.itemsUsed !== null && `${r.itemsUsed} questions`} {r.stopReason && `· ${r.stopReason.replaceAll("_", " ")}`}
            </li>
          ))}
        </ul>
      )}
      {v.exemptions.map((x) => (
        <ExemptionCard
          key={x.episodeId}
          exemption={x}
          version={v.release.version}
          canRevoke={canRevoke && currentRevision !== undefined}
          onRevoke={async (reason, key) => {
            const result = (await port.revoke(enrollmentId, x.episodeId, { reason, expectedRevision: currentRevision! }, key)) as { revision?: number };
            if (typeof result.revision === "number") setCurrentRevision(result.revision);
            view.reload();
          }}
        />
      ))}
      {v.overrides.map((o) => (
        <Notice key={o.episodeId + o.at} tone="gold" title={`Exemption revoked: ${o.title}`}>
          {o.revokedBy} · {when(o.at)} · {o.reason}
        </Notice>
      ))}
    </div>
  );
}

function ExemptionCard({ exemption, version, canRevoke, onRevoke }: {
  exemption: EnrollmentPlacement["exemptions"][number]; version: string; canRevoke: boolean; onRevoke: (reason: string, key: string) => Promise<void>;
}) {
  const id = useId();
  const key = useRef("placement-revoke-" + randomId());
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  return (
    <section className="placement-exemption" aria-label={`Exemption: ${exemption.title}`}>
      <p>
        <strong>{exemption.title}</strong> · placed out in run {exemption.runNumber ?? "?"} on version {version}
        {exemption.placedAt && ` · ${when(exemption.placedAt)}`}
      </p>
      <ul className="placement-runs">
        {exemption.evidence.map((e) => (
          <li key={e.evidenceId}>
            {e.assessmentId} ({e.familyId}) · {e.passed ? "correct" : "not correct"} · {e.independent ? "independent" : "assisted"}
            {e.invalidated && <Badge tone="red">invalidated</Badge>}
            {!e.sameCourseVersion && <Badge tone="gold">other version</Badge>}
          </li>
        ))}
      </ul>
      {canRevoke && (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            setPending(true);
            setError(undefined);
            onRevoke(reason.trim(), key.current)
              .catch(setError)
              .finally(() => setPending(false));
          }}
        >
          <Field label="Reason to put it back on the path" htmlFor={`${id}-reason`} hint="At least 10 characters. The evidence is kept.">
            <textarea id={`${id}-reason`} rows={2} maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          {error !== undefined && <Notice tone="red">{placementErrorMessage(error)}</Notice>}
          <Button kind="danger" type="submit" disabled={pending || reason.trim().length < 10}>
            Revoke exemption
          </Button>
        </form>
      )}
    </section>
  );
}
