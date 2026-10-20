import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { AdminClient } from "../domain/contracts";
import {
  conceptMappingErrorMessage,
  type ConceptMapping,
  type ConceptMappingPort,
  type MappingCandidates,
  type MappingLink,
  type MappingPair,
} from "../domain/conceptMappings";
import { useRemote } from "../hooks/useAdmin";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Loading,
  Notice,
} from "../components/ui";
import { randomId } from "../domain/webCrypto";

/** How a link reads from the first course's objective to the second course's. "requires" is a
 * prerequisite link stored in the other direction. */
type RowRelation = "equivalent" | "overlaps" | "prerequisite_of" | "requires";
const relationText: Record<RowRelation, string> = {
  equivalent: "is equivalent to",
  overlaps: "overlaps with",
  prerequisite_of: "is a prerequisite of",
  requires: "requires (as a prerequisite)",
};
interface Row {
  key: string;
  left: string;
  relation: RowRelation;
  right: string;
}
const actionText: Record<string, string> = {
  created: "Created",
  revised: "Revised",
  retired: "Retired",
  restored: "Restored",
};

/** Rows as seen from the first chosen release to the second. */
function toRows(links: MappingLink[], first: string): Row[] {
  return links.map((link) => {
    const forward = link.from.releaseId === first;
    const left = forward ? link.from.objectiveId : link.to.objectiveId,
      right = forward ? link.to.objectiveId : link.from.objectiveId;
    const relation: RowRelation =
      link.relation === "prerequisite_of"
        ? forward
          ? "prerequisite_of"
          : "requires"
        : link.relation;
    return { key: randomId(), left, relation, right };
  });
}
function toLinks(rows: Row[], first: string, second: string): MappingLink[] {
  return rows.map((row) =>
    row.relation === "requires"
      ? {
          relation: "prerequisite_of",
          from: { releaseId: second, objectiveId: row.right },
          to: { releaseId: first, objectiveId: row.left },
        }
      : {
          relation: row.relation,
          from: { releaseId: first, objectiveId: row.left },
          to: { releaseId: second, objectiveId: row.right },
        },
  );
}

/** Staff-authored concept mappings between two courses. People write them; nothing is inferred.
 * Server authorization decides: only an owner or admin of both courses can save or retire. */
export function ConceptMappingsView({ client }: { client: AdminClient }) {
  if (!client.conceptMappings)
    return (
      <Card title="Concept mappings">
        <EmptyState title="Concept mappings are not available here">
          Use a connected administration session.
        </EmptyState>
      </Card>
    );
  return <MappingWorkspace port={client.conceptMappings} />;
}

function MappingWorkspace({ port }: { port: ConceptMappingPort }) {
  const id = useId();
  const candidates = useRemote((signal) => port.candidates(signal), [port]);
  const [first, setFirst] = useState("");
  const [second, setSecond] = useState("");
  if (candidates.loading && !candidates.data)
    return <Loading label="Loading courses you can map…" />;
  if (candidates.error || !candidates.data)
    return (
      <Notice tone="red">{conceptMappingErrorMessage(candidates.error)}</Notice>
    );
  const options = releaseOptions(candidates.data);
  const sameCourse =
    first &&
    second &&
    options.find((o) => o.releaseId === first)?.catalogId ===
      options.find((o) => o.releaseId === second)?.catalogId;
  return (
    <div className="page-stack">
      <Card title="Choose two courses" eyebrow="Staff-authored mapping">
        <p className="muted">
          Link objectives of two different courses as equivalent, overlapping,
          or one a prerequisite of the other. Only an owner or admin of both
          courses can save a mapping, and every save is kept as a version with
          who saved it. Nothing is inferred automatically.
        </p>
        {options.length < 2 ? (
          <EmptyState title="Two published courses are needed">
            You can map courses where you are an owner or admin.
          </EmptyState>
        ) : (
          <div className="mapping-pickers">
            <Field label="First course" htmlFor={`${id}-first`}>
              <select
                id={`${id}-first`}
                value={first}
                onChange={(e) => setFirst(e.target.value)}
              >
                <option value="">Choose a course version</option>
                {options.map((o) => (
                  <option key={o.releaseId} value={o.releaseId}>
                    {o.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Second course" htmlFor={`${id}-second`}>
              <select
                id={`${id}-second`}
                value={second}
                onChange={(e) => setSecond(e.target.value)}
              >
                <option value="">Choose a course version</option>
                {options
                  .filter((o) => o.releaseId !== first)
                  .map((o) => (
                    <option key={o.releaseId} value={o.releaseId}>
                      {o.label}
                    </option>
                  ))}
              </select>
            </Field>
          </div>
        )}
        {sameCourse && (
          <Notice tone="gold">
            Both choices are versions of the same course. Choose two different
            courses.
          </Notice>
        )}
      </Card>
      {first && second && first !== second && !sameCourse && (
        <PairEditor
          key={`${first}:${second}`}
          port={port}
          first={first}
          second={second}
          maxLinks={candidates.data.maxLinks}
        />
      )}
    </div>
  );
}
function releaseOptions(data: MappingCandidates) {
  return data.courses.flatMap((course) =>
    course.releases.map((release) => ({
      releaseId: release.releaseId,
      catalogId: course.catalogId,
      label: `${course.title} ${release.version}${release.status === "archived" ? " (archived)" : ""} · ${course.workspaceTitle}`,
    })),
  );
}

function PairEditor({
  port,
  first,
  second,
  maxLinks,
}: {
  port: ConceptMappingPort;
  first: string;
  second: string;
  maxLinks: number;
}) {
  const id = useId();
  const pair = useRemote(
    (signal) => port.pair(first, second, signal),
    [port, first, second],
  );
  const [mapping, setMapping] = useState<ConceptMapping | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const [message, setMessage] = useState("");
  const keys = useRef(new Map<string, string>());
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (!pair.data) return;
    setMapping(pair.data.mapping);
    setRows(toRows(pair.data.mapping?.links ?? [], first));
  }, [pair.data, first]);
  const names = useMemo(
    () => (pair.data ? sides(pair.data, first) : null),
    [pair.data, first],
  );
  if (pair.loading && !pair.data)
    return <Loading label="Loading the mapping…" />;
  if (pair.error || !pair.data || !names)
    return <Notice tone="red">{conceptMappingErrorMessage(pair.error)}</Notice>;
  const revision = mapping?.revision ?? 0;
  const complete = rows.every((row) => row.left && row.right);
  const keyFor = (fingerprint: string) => {
    let key = keys.current.get(fingerprint);
    if (!key) keys.current.set(fingerprint, (key = "mapping-" + randomId()));
    return key;
  };
  async function run(
    action: () => Promise<ConceptMapping>,
    done: (saved: ConceptMapping) => string,
  ) {
    setPending(true);
    setError(undefined);
    setMessage("");
    try {
      const saved = await action();
      setMapping(saved);
      setRows(toRows(saved.links, first));
      setNote("");
      setMessage(done(saved));
      keys.current.clear();
    } catch (failure) {
      setError(failure);
    } finally {
      setPending(false);
    }
  }
  const save = () => {
    const links = toLinks(rows, first, second);
    const body = {
      releaseIds: [first, second] as [string, string],
      expectedRevision: revision,
      links,
      ...(note.trim() ? { note: note.trim() } : {}),
    };
    return run(
      () =>
        port.save({ ...body, idempotencyKey: keyFor(JSON.stringify(body)) }),
      (saved) => `Mapping saved as version ${saved.revision}.`,
    );
  };
  const retire = () =>
    run(
      () =>
        port.retire(mapping!.id, {
          expectedRevision: revision,
          idempotencyKey: keyFor(`retire:${revision}:${note}`),
          ...(note.trim() ? { note: note.trim() } : {}),
        }),
      (saved) =>
        `Mapping retired as version ${saved.revision}. Pending learner suggestions from it were withdrawn.`,
    );
  return (
    <div className="page-stack">
      <Card
        title="Links between objectives"
        actions={
          mapping ? (
            <Badge
              tone={mapping.state === "active" ? "green" : "gold"}
            >{`${mapping.state} · version ${mapping.revision}`}</Badge>
          ) : (
            <Badge>not saved yet</Badge>
          )
        }
      >
        <h3 ref={heading} tabIndex={-1} className="sr-only">
          {names.first.title} and {names.second.title}
        </h3>
        <p className="muted">
          Learners decide, for each pair of their own courses, whether anything
          is shared. Suggestions made from a mapping never grant mastery or pass
          a checkpoint: each course still decides from its own checks.
        </p>
        {rows.length === 0 && (
          <p className="muted">No links yet. Add the first one.</p>
        )}
        <ol className="mapping-links">
          {rows.map((row, index) => (
            <li key={row.key} className="mapping-link">
              <fieldset>
                <legend>Link {index + 1}</legend>
                <Field
                  label={`Objective in ${names.first.title}`}
                  htmlFor={`${id}-${row.key}-left`}
                >
                  <select
                    id={`${id}-${row.key}-left`}
                    value={row.left}
                    disabled={pending}
                    onChange={(e) =>
                      setRows(
                        rows.map((r) =>
                          r.key === row.key
                            ? { ...r, left: e.target.value }
                            : r,
                        ),
                      )
                    }
                  >
                    <option value="">Choose an objective</option>
                    {names.first.objectives.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.description}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Relation" htmlFor={`${id}-${row.key}-relation`}>
                  <select
                    id={`${id}-${row.key}-relation`}
                    value={row.relation}
                    disabled={pending}
                    onChange={(e) =>
                      setRows(
                        rows.map((r) =>
                          r.key === row.key
                            ? { ...r, relation: e.target.value as RowRelation }
                            : r,
                        ),
                      )
                    }
                  >
                    {(Object.keys(relationText) as RowRelation[]).map(
                      (relation) => (
                        <option key={relation} value={relation}>
                          {relationText[relation]}
                        </option>
                      ),
                    )}
                  </select>
                </Field>
                <Field
                  label={`Objective in ${names.second.title}`}
                  htmlFor={`${id}-${row.key}-right`}
                >
                  <select
                    id={`${id}-${row.key}-right`}
                    value={row.right}
                    disabled={pending}
                    onChange={(e) =>
                      setRows(
                        rows.map((r) =>
                          r.key === row.key
                            ? { ...r, right: e.target.value }
                            : r,
                        ),
                      )
                    }
                  >
                    <option value="">Choose an objective</option>
                    {names.second.objectives.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.description}
                      </option>
                    ))}
                  </select>
                </Field>
                <Button
                  kind="quiet"
                  className="mapping-remove"
                  disabled={pending}
                  aria-label={`Remove link ${index + 1}`}
                  onClick={() => {
                    setRows(rows.filter((r) => r.key !== row.key));
                    heading.current?.focus();
                  }}
                >
                  <Trash2 size={16} aria-hidden="true" /> Remove
                </Button>
              </fieldset>
            </li>
          ))}
        </ol>
        <div className="mapping-actions">
          <Button
            disabled={pending || rows.length >= maxLinks}
            onClick={() =>
              setRows([
                ...rows,
                {
                  key: randomId(),
                  left: "",
                  relation: "equivalent",
                  right: "",
                },
              ])
            }
          >
            <Plus size={16} aria-hidden="true" /> Add link
          </Button>
        </div>
        <Field
          label="Note for the history (optional)"
          htmlFor={`${id}-note`}
          hint="Who reviewed the mapping, or why it changed. Shown to staff only."
        >
          <textarea
            id={`${id}-note`}
            value={note}
            maxLength={500}
            rows={2}
            disabled={pending}
            aria-describedby={`${id}-note-hint`}
            onChange={(e) => setNote(e.target.value)}
          />
        </Field>
        {!complete && (
          <Notice tone="gold">
            Choose an objective on both sides of every link before saving.
          </Notice>
        )}
        {message && <Notice tone="green">{message}</Notice>}
        {error !== undefined && (
          <Notice tone="red">{conceptMappingErrorMessage(error)}</Notice>
        )}
        <div className="mapping-actions">
          <Button kind="primary" disabled={pending || !complete} onClick={save}>
            {mapping?.state === "retired"
              ? "Restore with these links"
              : "Save mapping"}
          </Button>
          {mapping?.state === "active" && (
            <Button kind="danger" disabled={pending} onClick={retire}>
              Retire mapping
            </Button>
          )}
        </div>
      </Card>
      {mapping && (
        <Card title="History">
          <div
            className="table-wrap"
            tabIndex={0}
            role="region"
            aria-label="Mapping history"
          >
            <table className="people-table">
              <thead>
                <tr>
                  <th scope="col">Version</th>
                  <th scope="col">Change</th>
                  <th scope="col">By</th>
                  <th scope="col">Links</th>
                  <th scope="col">When</th>
                  <th scope="col">Note</th>
                </tr>
              </thead>
              <tbody>
                {mapping.history.map((h) => (
                  <tr key={h.revision}>
                    <th scope="row">{h.revision}</th>
                    <td>{actionText[h.action] ?? h.action}</td>
                    <td>
                      {h.author.displayName}{" "}
                      <span className="muted">
                        ({h.roles.a} / {h.roles.b})
                      </span>
                    </td>
                    <td>{h.linkCount}</td>
                    <td>{new Date(h.createdAt).toLocaleString()}</td>
                    <td>{h.note || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
/** Course names and objectives for the first and second chosen releases. */
function sides(pair: MappingPair, first: string) {
  const [x, y] =
    pair.courses.a.releaseId === first
      ? [pair.courses.a, pair.courses.b]
      : [pair.courses.b, pair.courses.a];
  const named = (c: typeof x) => ({
    title: `${c.title ?? c.courseKey} ${c.version}`,
    objectives: c.objectives,
  });
  return { first: named(x), second: named(y) };
}
