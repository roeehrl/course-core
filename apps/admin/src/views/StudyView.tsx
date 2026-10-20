import { useId, useState } from "react";
import { Download, FlaskConical, Play, ShieldCheck, Square } from "lucide-react";
import type { AdminClient, CourseWorkspace } from "../domain/contracts";
import {
  behaviourLabels,
  defaultArms,
  instrumentSets,
  setLabels,
  studyErrorMessage,
  type InstrumentSet,
  type Instruments,
  type StudiesPort,
  type Studies,
  type Study,
  type StudyArm,
  type StudyDefinitionInput,
} from "../domain/studies";
import { useRemote } from "../hooks/useAdmin";
import { Badge, Button, Card, EmptyState, Field, Loading, Notice, Stat, when } from "../components/ui";

const stateTone = { draft: "gold", recruiting: "green", closed: "neutral" } as const;

/** Educational evaluation studies: setup, arm balance, consent counts and the pseudonymous
 * research export. The server authorizes every action and records every export. */
export function StudyView({ data, client }: { data: CourseWorkspace; client: AdminClient }) {
  if (!client.studies)
    return (
      <Card title="Studies">
        <EmptyState title="Studies are not available here">Use a connected administration session.</EmptyState>
      </Card>
    );
  return <StudyAdmin port={client.studies} catalogId={data.course.id} />;
}

function StudyAdmin({ port, catalogId }: { port: StudiesPort; catalogId: string }) {
  const list = useRemote((signal) => port.list(catalogId, signal), [port, catalogId]);
  const [message, setMessage] = useState("");
  const [creating, setCreating] = useState(false);
  if (list.loading && !list.data) return <Loading label="Loading studies…" />;
  if (list.error || !list.data) return <Notice tone="red">{studyErrorMessage(list.error)}</Notice>;
  const s = list.data;
  const openRelease = new Set(s.studies.filter((x) => x.state !== "closed").map((x) => x.releaseId));
  const free = s.releases.filter((r) => !openRelease.has(r.id));
  const done = (text: string) => {
    setMessage(text);
    setCreating(false);
    list.reload();
  };
  return (
    <div className="page-stack">
      <div aria-live="polite">{message && <Notice tone="green">{message}</Notice>}</div>
      <Card title="About studies">
        <p className="muted">
          A study compares versions of one release: the fixed lesson path, the lessons with the chat companion, and full AI supervision. Learners join only
          by agreeing in their own app; each is assigned a version by a seeded, balanced draw that never changes. Exports are pseudonymous and every download
          is recorded.
        </p>
      </Card>
      {s.studies.length === 0 && !creating && (
        <Card title="Studies">
          <EmptyState title="No studies yet">{s.canManage ? "Set one up for a published release." : "Owners and admins set up studies."}</EmptyState>
        </Card>
      )}
      {s.studies.map((study) => (
        <StudyCard key={study.id} study={study} studies={s} port={port} onChanged={done} />
      ))}
      {s.canManage &&
        (creating ? (
          <StudyForm
            releases={free}
            onCancel={() => setCreating(false)}
            onSubmit={async (input, releaseId) => {
              const result = await port.create(catalogId, { ...input, releaseId: releaseId! });
              done(`Study “${result.study.title}” saved as a draft.${result.warnings?.length ? " Review its warnings before opening it." : ""}`);
            }}
          />
        ) : (
          free.length > 0 && (
            <div className="tag-row">
              <Button kind="primary" onClick={() => setCreating(true)}>
                <FlaskConical size={16} aria-hidden="true" /> New study
              </Button>
            </div>
          )
        ))}
    </div>
  );
}

function StudyCard({ study, studies, port, onChanged }: { study: Study; studies: Studies; port: StudiesPort; onChanged: (message: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const [note, setNote] = useState("");
  const release = studies.releases.find((r) => r.id === study.releaseId);
  const total = Math.max(1, study.arms.reduce((n, a) => n + a.consented, 0));
  async function act(work: () => Promise<string>) {
    setPending(true);
    setError(undefined);
    setNote("");
    try {
      const text = await work();
      if (text) setNote(text);
    } catch (caught) {
      setError(caught);
    } finally {
      setPending(false);
    }
  }
  if (editing)
    return (
      <StudyForm
        initial={study}
        releases={release ? [release] : []}
        onCancel={() => setEditing(false)}
        onSubmit={async (input) => {
          await port.update(study.id, { ...input, expectedRevision: study.revision });
          setEditing(false);
          onChanged("Study draft saved.");
        }}
      />
    );
  return (
    <Card title={study.title} eyebrow={release ? `Release ${release.version}` : "Release"} actions={<Badge tone={stateTone[study.state]}>{study.state}</Badge>}>
      <div className="stack">
        <p>{study.purpose}</p>
        <div className="stats-grid">
          <Stat label="Enrolled on this release" value={study.consent.eligible} detail="Learners who may be asked" />
          <Stat label="Consented" value={study.consent.consented} detail="Included in exports" />
          <Stat label="Withdrawn" value={study.consent.withdrawn} detail="Left out of exports" />
          <Stat label="Not decided" value={study.consent.undecided} detail="Have not joined" />
        </div>
        <h3 className="section-title">Arm balance</h3>
        <div className="table-wrap" tabIndex={0} role="region" aria-label={`Arm balance of ${study.title}`}>
          <table className="people-table">
            <caption className="sr-only">Arm balance</caption>
            <thead>
              <tr>
                <th scope="col">Arm</th>
                <th scope="col">What it switches</th>
                <th scope="col">Consented</th>
                <th scope="col">Withdrawn</th>
              </tr>
            </thead>
            <tbody>
              {study.arms.map((arm) => (
                <tr key={arm.id}>
                  <th scope="row">{arm.label}</th>
                  <td data-label="What it switches">{arm.explanation}</td>
                  <td data-label="Consented">
                    <span className="arm-count">
                      {arm.consented}
                      <span className="arm-bar" aria-hidden="true">
                        <span style={{ width: `${Math.round((arm.consented / total) * 100)}%` }} />
                      </span>
                    </span>
                  </td>
                  <td data-label="Withdrawn">{arm.withdrawn}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted">
          Arms smaller than {study.minCellSize} are left out of exports. Placement is {release?.placementEnabled ? "on" : "off"} for this course, the same in every arm.
        </p>
        <h3 className="section-title">Instruments</h3>
        <ul className="plain-list">
          {instrumentSets.map((set) => (
            <li key={set}>
              <strong>{setLabels[set]}:</strong> {study.instruments[set].length ? study.instruments[set].join(", ") : "none"}
            </li>
          ))}
        </ul>
        {study.warnings.length > 0 && (
          <Notice tone="gold" title="Check before relying on the results">
            <ul className="plain-list">
              {study.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </Notice>
        )}
        <p className="muted">
          Allocation seed digest <code>{study.seedDigest.slice(0, 16)}…</code>
          {study.openedAt ? ` · opened ${when(study.openedAt)}` : ""}
          {study.closedAt ? ` · closed ${when(study.closedAt)}` : ""}
        </p>
        <div aria-live="polite">
          {note && <Notice tone="green">{note}</Notice>}
          {error !== undefined && <Notice tone="red">{studyErrorMessage(error)}</Notice>}
        </div>
        <div className="tag-row">
          {studies.canManage && study.state === "draft" && (
            <>
              <Button disabled={pending} onClick={() => setEditing(true)}>
                Edit draft
              </Button>
              <Button
                kind="primary"
                disabled={pending}
                onClick={() =>
                  void act(async () => {
                    await port.transition(study.id, "open", study.revision);
                    onChanged(`“${study.title}” is recruiting. Learners on this release now see the consent prompt.`);
                    return "";
                  })
                }
              >
                <Play size={16} aria-hidden="true" /> Open recruiting
              </Button>
            </>
          )}
          {studies.canManage && study.state === "recruiting" && !confirmClose && (
            <Button kind="danger" disabled={pending} onClick={() => setConfirmClose(true)}>
              <Square size={16} aria-hidden="true" /> Close study
            </Button>
          )}
          {studies.canManage && study.state !== "draft" && (
            <Button
              kind="quiet"
              disabled={pending}
              onClick={() =>
                void act(async () => {
                  const check = await port.allocationCheck(study.id);
                  return check.mismatches === 0
                    ? `All ${check.checked} assignment(s) match the seeded draw (${check.allocated} made in total).`
                    : `${check.mismatches} of ${check.checked} assignment(s) do not match the seeded draw.`;
                })
              }
            >
              <ShieldCheck size={16} aria-hidden="true" /> Check allocation
            </Button>
          )}
          {studies.canExport &&
            study.state !== "draft" &&
            (["csv", "json"] as const).map((format) => (
              <Button
                key={format}
                disabled={pending}
                onClick={() =>
                  void act(async () => {
                    const file = await port.download(study.id, format);
                    save(file.body, file.filename, file.contentType);
                    return `Downloaded ${file.filename} (digest ${file.digest.slice(0, 12)}…). The download is recorded in the audit log.`;
                  })
                }
              >
                <Download size={16} aria-hidden="true" /> Export {format.toUpperCase()}
              </Button>
            ))}
        </div>
        {confirmClose && (
          <Notice tone="gold" title="Close this study?">
            Recruiting ends and every learner returns to the course as everyone else has it. Collected data stays exportable. A closed study cannot reopen.
            <div className="tag-row">
              <Button
                kind="danger"
                disabled={pending}
                onClick={() =>
                  void act(async () => {
                    await port.transition(study.id, "close", study.revision);
                    setConfirmClose(false);
                    onChanged(`“${study.title}” is closed.`);
                    return "";
                  })
                }
              >
                Confirm close
              </Button>
              <Button kind="quiet" onClick={() => setConfirmClose(false)}>
                Keep recruiting
              </Button>
            </div>
          </Notice>
        )}
      </div>
    </Card>
  );
}

function save(body: string, filename: string, type: string) {
  const url = URL.createObjectURL(new Blob([body], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const emptyInstruments = (): Instruments => ({ pre: [], post: [], transfer: [], delayed: [] });
function StudyForm({
  initial,
  releases,
  onSubmit,
  onCancel,
}: {
  initial?: Study;
  releases: Studies["releases"];
  onSubmit: (input: StudyDefinitionInput, releaseId?: string) => Promise<void>;
  onCancel: () => void;
}) {
  const id = useId();
  const [releaseId, setReleaseId] = useState(initial?.releaseId ?? releases[0]?.id ?? "");
  const [title, setTitle] = useState(initial?.title ?? "");
  const [purpose, setPurpose] = useState(initial?.purpose ?? "");
  const [minCellSize, setMinCellSize] = useState(initial?.minCellSize ?? 5);
  const arms0 = defaultArms().map((arm) => {
    const existing = initial?.arms.find((a) => a.behaviour === arm.behaviour);
    return { arm: existing ? { id: existing.id, label: existing.label, behaviour: existing.behaviour } : arm, on: initial ? Boolean(existing) : true };
  });
  const [arms, setArms] = useState(arms0);
  const [instruments, setInstruments] = useState<Instruments>(initial?.instruments ?? emptyInstruments());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const release = releases.find((r) => r.id === releaseId);
  const setOf = (item: string): InstrumentSet | "" => instrumentSets.find((s) => instruments[s].includes(item)) ?? "";
  const assign = (item: string, set: InstrumentSet | "") =>
    setInstruments((current) => {
      const next = Object.fromEntries(instrumentSets.map((s) => [s, current[s].filter((i) => i !== item)])) as Instruments;
      if (set) next[set] = [...next[set], item];
      return next;
    });
  const chosen: StudyArm[] = arms.filter((a) => a.on).map((a) => a.arm);
  return (
    <Card title={initial ? "Edit study draft" : "New study"}>
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setPending(true);
          setError(undefined);
          try {
            await onSubmit({ title, purpose, arms: chosen, instruments, minCellSize }, releaseId);
          } catch (caught) {
            setError(caught);
          } finally {
            setPending(false);
          }
        }}
      >
        {!initial && (
          <Field label="Release" htmlFor={`${id}-release`} hint="Learners pinned to this release can join.">
            <select id={`${id}-release`} value={releaseId} onChange={(e) => {
              setReleaseId(e.target.value);
              setInstruments(emptyInstruments());
            }}>
              {releases.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.version} ({r.status})
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Title" htmlFor={`${id}-title`}>
          <input id={`${id}-title`} value={title} minLength={3} maxLength={120} required onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="Purpose shown to learners" htmlFor={`${id}-purpose`} hint="Plain language, 20 to 2000 characters. Learners read this before deciding.">
          <textarea id={`${id}-purpose`} rows={4} value={purpose} minLength={20} maxLength={2000} required aria-describedby={`${id}-purpose-hint`}
            onChange={(e) => setPurpose(e.target.value)} />
        </Field>
        <fieldset className="study-fieldset">
          <legend>Arms (at least two)</legend>
          {arms.map((entry, i) => (
            <div key={entry.arm.behaviour} className="study-arm-row">
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={entry.on}
                  onChange={(e) => setArms((all) => all.map((a, j) => (j === i ? { ...a, on: e.target.checked } : a)))}
                />
                Include {behaviourLabels[entry.arm.behaviour]}
              </label>
              <Field label={`Name of the ${behaviourLabels[entry.arm.behaviour]} arm`} htmlFor={`${id}-arm-${i}`}>
                <input id={`${id}-arm-${i}`} value={entry.arm.label} maxLength={60} disabled={!entry.on}
                  onChange={(e) => setArms((all) => all.map((a, j) => (j === i ? { ...a, arm: { ...a.arm, label: e.target.value } } : a)))} />
              </Field>
            </div>
          ))}
        </fieldset>
        <fieldset className="study-fieldset">
          <legend>Instrument sets</legend>
          <p className="muted">
            Choose the existing assessment items that form each set. Delayed checks are the course's held-out retention items; the retention schedule
            offers them after an objective is demonstrated.
          </p>
          {release?.items.length ? (
            <div className="study-items">
              {release.items.map((item) => (
                <Field
                  key={item.id}
                  label={`${item.id} · ${item.type}${item.role ? ` · ${item.role}` : ""}`}
                  htmlFor={`${id}-item-${item.id}`}
                  hint={item.objectiveIds.join(", ")}
                >
                  <select id={`${id}-item-${item.id}`} value={setOf(item.id)} aria-describedby={`${id}-item-${item.id}-hint`}
                    onChange={(e) => assign(item.id, e.target.value as InstrumentSet | "")}>
                    <option value="">Not used</option>
                    {instrumentSets.map((set) => (
                      <option key={set} value={set} disabled={set === "delayed" && !item.retention}>
                        {setLabels[set]}
                        {set === "delayed" && !item.retention ? " (not a retention item)" : ""}
                      </option>
                    ))}
                  </select>
                </Field>
              ))}
            </div>
          ) : (
            <p className="muted">This release has no assessment items.</p>
          )}
        </fieldset>
        <Field label="Minimum cell size" htmlFor={`${id}-cell`} hint="Arms with fewer consenting learners than this are left out of exports (3 to 100).">
          <input id={`${id}-cell`} type="number" min={3} max={100} value={minCellSize} aria-describedby={`${id}-cell-hint`}
            onChange={(e) => setMinCellSize(Number(e.target.value))} />
        </Field>
        <div aria-live="polite">{error !== undefined && <Notice tone="red">{studyErrorMessage(error)}</Notice>}</div>
        <div className="tag-row">
          <Button kind="primary" type="submit" disabled={pending || chosen.length < 2 || !releaseId}>
            Save draft
          </Button>
          <Button kind="quiet" type="button" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}
