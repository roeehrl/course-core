import { useId, useMemo, useRef, useState } from "react";
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
import { useEditableSnapshot } from "../hooks/useEditableSnapshot";
import { ChangedElsewhere } from "../components/ChangedElsewhere";
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
import { isolate } from "@course-core/i18n";
import {
  useI18n,
  useT,
  type AdminTranslator,
  type MessageKey,
  type Translate,
} from "../i18n";

/** How a link reads from the first course's objective to the second course's. "requires" is a
 * prerequisite link stored in the other direction. */
type RowRelation = "equivalent" | "overlaps" | "prerequisite_of" | "requires";
const rowRelations: RowRelation[] = [
  "equivalent",
  "overlaps",
  "prerequisite_of",
  "requires",
];
interface Row {
  key: string;
  left: string;
  relation: RowRelation;
  right: string;
}
const ACTIONS = new Set(["created", "revised", "retired", "restored"]);

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
  const t = useT();
  if (!client.conceptMappings)
    return (
      <Card title={t("conceptMappingsView.title")}>
        <EmptyState title={t("conceptMappingsView.unavailable.title")}>
          {t("conceptMappingsView.unavailable.body")}
        </EmptyState>
      </Card>
    );
  return <MappingWorkspace port={client.conceptMappings} />;
}

function MappingWorkspace({ port }: { port: ConceptMappingPort }) {
  const t = useT();
  const id = useId();
  const candidates = useRemote((signal) => port.candidates(signal), [port]);
  const [first, setFirst] = useState("");
  const [second, setSecond] = useState("");
  if (candidates.loading && !candidates.data)
    return <Loading label={t("conceptMappingsView.loadingCourses")} />;
  if (candidates.error || !candidates.data)
    return (
      <Notice tone="red">
        {conceptMappingErrorMessage(candidates.error, t)}
      </Notice>
    );
  const options = releaseOptions(candidates.data, t);
  const sameCourse =
    first &&
    second &&
    options.find((o) => o.releaseId === first)?.catalogId ===
      options.find((o) => o.releaseId === second)?.catalogId;
  return (
    <div className="page-stack">
      <Card
        title={t("conceptMappingsView.choose.title")}
        eyebrow={t("conceptMappingsView.choose.eyebrow")}
      >
        <p className="muted">{t("conceptMappingsView.choose.body")}</p>
        {options.length < 2 ? (
          <EmptyState title={t("conceptMappingsView.choose.empty.title")}>
            {t("conceptMappingsView.choose.empty.body")}
          </EmptyState>
        ) : (
          <div className="mapping-pickers">
            <Field
              label={t("conceptMappingsView.choose.first")}
              htmlFor={`${id}-first`}
            >
              <select
                id={`${id}-first`}
                value={first}
                onChange={(e) => setFirst(e.target.value)}
              >
                <option value="">
                  {t("conceptMappingsView.choose.placeholder")}
                </option>
                {options.map((o) => (
                  <option key={o.releaseId} value={o.releaseId}>
                    {o.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label={t("conceptMappingsView.choose.second")}
              htmlFor={`${id}-second`}
            >
              <select
                id={`${id}-second`}
                value={second}
                onChange={(e) => setSecond(e.target.value)}
              >
                <option value="">
                  {t("conceptMappingsView.choose.placeholder")}
                </option>
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
            {t("conceptMappingsView.choose.sameCourse")}
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
function releaseOptions(data: MappingCandidates, t: Translate) {
  return data.courses.flatMap((course) =>
    course.releases.map((release) => ({
      releaseId: release.releaseId,
      catalogId: course.catalogId,
      label: t(
        release.status === "archived"
          ? "conceptMappingsView.option.archived"
          : "conceptMappingsView.option.active",
        {
          course: course.title,
          version: release.version,
          workspace: course.workspaceTitle,
        },
      ),
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
  const t = useT();
  const i18n = useI18n();
  const id = useId();
  const pair = useRemote(
    (signal) => port.pair(first, second, signal),
    [port, first, second],
  );
  // The mapping this editor saved last, else the loaded one. The links show the saved mapping
  // until edited, derived rather than copied in an effect: a copy still pending when the pair
  // appears would run after a link added at that moment and drop it.
  const [savedHere, setSavedHere] = useState<{
    from: MappingPair;
    mapping: ConceptMapping;
  }>();
  const loaded = pair.data,
    mapping =
      savedHere && savedHere.from === loaded
        ? savedHere.mapping
        : (loaded?.mapping ?? null);
  const savedRows = useMemo(
    () => toRows(mapping?.links ?? [], first),
    [mapping, first],
  );
  // The saved version is its revision and links; row keys are made up per load.
  const edit = useEditableSnapshot(
    savedRows,
    JSON.stringify([
      mapping?.revision ?? 0,
      mapping?.state ?? null,
      toLinks(savedRows, first, second),
    ]),
  );
  const rows = edit.value,
    setRows = edit.set;
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const [message, setMessage] = useState("");
  const keys = useRef(new Map<string, string>());
  const heading = useRef<HTMLHeadingElement>(null);
  const names = useMemo(
    () => (pair.data ? sides(pair.data, first) : null),
    [pair.data, first],
  );
  if (pair.loading && !pair.data)
    return <Loading label={t("conceptMappingsView.loadingMapping")} />;
  if (pair.error || !pair.data || !names)
    return (
      <Notice tone="red">{conceptMappingErrorMessage(pair.error, t)}</Notice>
    );
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
      if (pair.data) setSavedHere({ from: pair.data, mapping: saved });
      edit.discard();
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
    if (edit.changedElsewhere) return;
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
      (saved) => t("conceptMappingsView.saved", { version: saved.revision }),
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
      (saved) => t("conceptMappingsView.retired", { version: saved.revision }),
    );
  return (
    <div className="page-stack">
      <Card
        title={t("conceptMappingsView.links.title")}
        actions={
          mapping ? (
            <Badge tone={mapping.state === "active" ? "green" : "gold"}>
              {t("conceptMappingsView.links.state", {
                state: mapping.state,
                version: mapping.revision,
              })}
            </Badge>
          ) : (
            <Badge>{t("conceptMappingsView.links.unsaved")}</Badge>
          )
        }
      >
        <h3 ref={heading} tabIndex={-1} className="sr-only">
          {t("conceptMappingsView.links.heading", {
            first: names.first.title,
            second: names.second.title,
          })}
        </h3>
        <p className="muted">{t("conceptMappingsView.links.body")}</p>
        {rows.length === 0 && (
          <p className="muted">{t("conceptMappingsView.links.empty")}</p>
        )}
        <ol className="mapping-links">
          {rows.map((row, index) => (
            <li key={row.key} className="mapping-link">
              <fieldset>
                <legend>
                  {t("conceptMappingsView.link.legend", { n: index + 1 })}
                </legend>
                <Field
                  label={t("conceptMappingsView.link.objectiveIn", {
                    course: names.first.title,
                  })}
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
                    <option value="">
                      {t("conceptMappingsView.link.chooseObjective")}
                    </option>
                    {names.first.objectives.map((o) => (
                      <option key={o.id} value={o.id} dir="auto">
                        {o.description}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field
                  label={t("conceptMappingsView.link.relation")}
                  htmlFor={`${id}-${row.key}-relation`}
                >
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
                    {rowRelations.map((relation) => (
                      <option key={relation} value={relation}>
                        {t(`conceptMappingsView.relation.${relation}`)}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field
                  label={t("conceptMappingsView.link.objectiveIn", {
                    course: names.second.title,
                  })}
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
                    <option value="">
                      {t("conceptMappingsView.link.chooseObjective")}
                    </option>
                    {names.second.objectives.map((o) => (
                      <option key={o.id} value={o.id} dir="auto">
                        {o.description}
                      </option>
                    ))}
                  </select>
                </Field>
                <Button
                  kind="quiet"
                  className="mapping-remove"
                  disabled={pending}
                  aria-label={t("conceptMappingsView.link.removeLabel", {
                    n: index + 1,
                  })}
                  onClick={() => {
                    setRows(rows.filter((r) => r.key !== row.key));
                    heading.current?.focus();
                  }}
                >
                  <Trash2 size={16} aria-hidden="true" />{" "}
                  {t("conceptMappingsView.link.remove")}
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
            <Plus size={16} aria-hidden="true" />{" "}
            {t("conceptMappingsView.link.add")}
          </Button>
        </div>
        <Field
          label={t("conceptMappingsView.note")}
          htmlFor={`${id}-note`}
          hint={t("conceptMappingsView.noteHint")}
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
          <Notice tone="gold">{t("conceptMappingsView.incomplete")}</Notice>
        )}
        {message && <Notice tone="green">{message}</Notice>}
        {error !== undefined && (
          <Notice tone="red">{conceptMappingErrorMessage(error, t)}</Notice>
        )}
        {edit.changedElsewhere && (
          <ChangedElsewhere
            disabled={pending}
            onShowSaved={edit.discard}
            onKeep={edit.keep}
          />
        )}
        <div className="mapping-actions">
          <Button
            kind="primary"
            disabled={pending || !complete || edit.changedElsewhere}
            onClick={save}
          >
            {mapping?.state === "retired"
              ? t("conceptMappingsView.restore")
              : t("conceptMappingsView.save")}
          </Button>
          {mapping?.state === "active" && (
            <Button kind="danger" disabled={pending} onClick={retire}>
              {t("conceptMappingsView.retire")}
            </Button>
          )}
        </div>
      </Card>
      {mapping && (
        <Card title={t("conceptMappingsView.history.title")}>
          <div
            className="table-wrap"
            tabIndex={0}
            role="region"
            aria-label={t("conceptMappingsView.history.region")}
          >
            <table className="stacked-table">
              <thead>
                <tr>
                  <th scope="col">
                    {t("conceptMappingsView.history.version")}
                  </th>
                  <th scope="col">{t("conceptMappingsView.history.change")}</th>
                  <th scope="col">{t("conceptMappingsView.history.by")}</th>
                  <th scope="col" className="num">
                    {t("conceptMappingsView.history.links")}
                  </th>
                  <th scope="col">{t("conceptMappingsView.history.when")}</th>
                  <th scope="col">{t("conceptMappingsView.history.note")}</th>
                </tr>
              </thead>
              <tbody>
                {mapping.history.map((h) => (
                  <tr key={h.revision}>
                    <th scope="row">{i18n.number(h.revision)}</th>
                    <td>
                      {ACTIONS.has(h.action)
                        ? t(`conceptMappingsView.action.${h.action}`)
                        : h.action}
                    </td>
                    <td>
                      <bdi>{h.author.displayName}</bdi>{" "}
                      <span className="muted">
                        {t("conceptMappingsView.history.roles", {
                          a: roleText(h.roles.a, i18n),
                          b: roleText(h.roles.b, i18n),
                        })}
                      </span>
                    </td>
                    <td className="num">{i18n.number(h.linkCount)}</td>
                    <td className="cell-date">{i18n.dateTime(h.createdAt)}</td>
                    <td>
                      <bdi>{h.note || "—"}</bdi>
                    </td>
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
/** A member role from the server in the UI locale (the shell's role names); an unknown
 * code is shown as is. */
function roleText(role: string, i18n: AdminTranslator) {
  const key = `adminApp.role.${role}` as MessageKey;
  return i18n.has(key) ? i18n.t(key) : role;
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
