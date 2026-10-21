import { useId, useState } from "react";
import {
  Download,
  FlaskConical,
  Play,
  ShieldCheck,
  Square,
} from "lucide-react";
import type { AdminClient, CourseWorkspace } from "../domain/contracts";
import {
  behaviourLabel,
  defaultArms,
  instrumentSets,
  setLabel,
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
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Loading,
  Notice,
  Stat,
} from "../components/ui";
import { isolate } from "@course-core/i18n";
import { useFormatters, useI18n, useT } from "../i18n";

const stateTone = {
  draft: "gold",
  recruiting: "green",
  closed: "neutral",
} as const;

/** Educational evaluation studies: setup, arm balance, consent counts and the pseudonymous
 * research export. The server authorizes every action and records every export. */
export function StudyView({
  data,
  client,
}: {
  data: CourseWorkspace;
  client: AdminClient;
}) {
  const t = useT();
  if (!client.studies)
    return (
      <Card title={t("studyView.title")}>
        <EmptyState title={t("studyView.unavailable.title")}>
          {t("studyView.unavailable.body")}
        </EmptyState>
      </Card>
    );
  return <StudyAdmin port={client.studies} catalogId={data.course.id} />;
}

function StudyAdmin({
  port,
  catalogId,
}: {
  port: StudiesPort;
  catalogId: string;
}) {
  const t = useT();
  const list = useRemote(
    (signal) => port.list(catalogId, signal),
    [port, catalogId],
  );
  const [message, setMessage] = useState("");
  const [creating, setCreating] = useState(false);
  if (list.loading && !list.data)
    return <Loading label={t("studyView.loading")} />;
  if (list.error || !list.data)
    return <Notice tone="red">{studyErrorMessage(list.error, t)}</Notice>;
  const s = list.data;
  const openRelease = new Set(
    s.studies.filter((x) => x.state !== "closed").map((x) => x.releaseId),
  );
  const free = s.releases.filter((r) => !openRelease.has(r.id));
  const done = (text: string) => {
    setMessage(text);
    setCreating(false);
    list.reload();
  };
  return (
    <div className="page-stack">
      <div aria-live="polite">
        {message && <Notice tone="green">{message}</Notice>}
      </div>
      <Card title={t("studyView.about.title")}>
        <p className="muted">{t("studyView.about.body")}</p>
      </Card>
      {s.studies.length === 0 && !creating && (
        <Card title={t("studyView.title")}>
          <EmptyState title={t("studyView.empty.title")}>
            {s.canManage
              ? t("studyView.empty.manage")
              : t("studyView.empty.readOnly")}
          </EmptyState>
        </Card>
      )}
      {s.studies.map((study) => (
        <StudyCard
          key={study.id}
          study={study}
          studies={s}
          port={port}
          onChanged={done}
        />
      ))}
      {s.canManage &&
        (creating ? (
          <StudyForm
            releases={free}
            onCancel={() => setCreating(false)}
            onSubmit={async (input, releaseId) => {
              const result = await port.create(catalogId, {
                ...input,
                releaseId: releaseId!,
              });
              done(
                t(
                  result.warnings?.length
                    ? "studyView.createdWithWarnings"
                    : "studyView.created",
                  { title: result.study.title },
                ),
              );
            }}
          />
        ) : (
          free.length > 0 && (
            <div className="tag-row">
              <Button kind="primary" onClick={() => setCreating(true)}>
                <FlaskConical size={16} aria-hidden="true" />{" "}
                {t("studyView.new")}
              </Button>
            </div>
          )
        ))}
    </div>
  );
}

function StudyCard({
  study,
  studies,
  port,
  onChanged,
}: {
  study: Study;
  studies: Studies;
  port: StudiesPort;
  onChanged: (message: string) => void;
}) {
  const t = useT();
  const { when } = useFormatters();
  const [editing, setEditing] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const [note, setNote] = useState("");
  const release = studies.releases.find((r) => r.id === study.releaseId);
  const total = Math.max(
    1,
    study.arms.reduce((n, a) => n + a.consented, 0),
  );
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
          await port.update(study.id, {
            ...input,
            expectedRevision: study.revision,
          });
          setEditing(false);
          onChanged(t("studyView.draftSaved"));
        }}
      />
    );
  return (
    <Card
      title={isolate(study.title)}
      eyebrow={
        release
          ? t("studyView.release", { version: release.version })
          : t("studyView.releaseUnknown")
      }
      actions={
        <Badge tone={stateTone[study.state]}>
          {t(`studyView.state.${study.state}`)}
        </Badge>
      }
    >
      <div className="stack">
        <p dir="auto">{study.purpose}</p>
        <div className="stats-grid">
          <Stat
            label={t("studyView.stat.eligible")}
            value={study.consent.eligible}
            detail={t("studyView.stat.eligibleDetail")}
          />
          <Stat
            label={t("studyView.stat.consented")}
            value={study.consent.consented}
            detail={t("studyView.stat.consentedDetail")}
          />
          <Stat
            label={t("studyView.stat.withdrawn")}
            value={study.consent.withdrawn}
            detail={t("studyView.stat.withdrawnDetail")}
          />
          <Stat
            label={t("studyView.stat.undecided")}
            value={study.consent.undecided}
            detail={t("studyView.stat.undecidedDetail")}
          />
        </div>
        <h3 className="section-title">{t("studyView.arms.title")}</h3>
        <div
          className="table-wrap"
          tabIndex={0}
          role="region"
          aria-label={t("studyView.arms.region", { title: study.title })}
        >
          <table className="people-table">
            <caption className="sr-only">{t("studyView.arms.title")}</caption>
            <thead>
              <tr>
                <th scope="col">{t("studyView.arms.arm")}</th>
                <th scope="col">{t("studyView.arms.switches")}</th>
                <th scope="col">{t("studyView.stat.consented")}</th>
                <th scope="col">{t("studyView.stat.withdrawn")}</th>
              </tr>
            </thead>
            <tbody>
              {study.arms.map((arm) => (
                <tr key={arm.id}>
                  <th scope="row" dir="auto">
                    {arm.label}
                  </th>
                  <td data-label={t("studyView.arms.switches")} dir="auto">
                    {arm.explanation}
                  </td>
                  <td data-label={t("studyView.stat.consented")}>
                    <span className="arm-count">
                      {arm.consented}
                      <span className="arm-bar" aria-hidden="true">
                        <span
                          style={{
                            width: `${Math.round((arm.consented / total) * 100)}%`,
                          }}
                        />
                      </span>
                    </span>
                  </td>
                  <td data-label={t("studyView.stat.withdrawn")}>
                    {arm.withdrawn}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted">
          {t(
            release?.placementEnabled
              ? "studyView.cellSize.placementOn"
              : "studyView.cellSize.placementOff",
            { min: study.minCellSize },
          )}
        </p>
        <h3 className="section-title">{t("studyView.instruments.title")}</h3>
        <ul className="plain-list">
          {instrumentSets.map((set) => (
            <li key={set}>
              <strong>
                {t("studyView.instruments.set", { set: setLabel(set, t) })}
              </strong>{" "}
              {study.instruments[set].length ? (
                <span dir="ltr">{study.instruments[set].join(", ")}</span>
              ) : (
                t("studyView.instruments.none")
              )}
            </li>
          ))}
        </ul>
        {study.warnings.length > 0 && (
          <Notice tone="gold" title={t("studyView.warnings.title")}>
            <ul className="plain-list">
              {study.warnings.map((w) => (
                <li key={w} dir="auto">
                  {w}
                </li>
              ))}
            </ul>
          </Notice>
        )}
        <p className="muted">
          {t("studyView.seed")}{" "}
          <code dir="ltr">{study.seedDigest.slice(0, 16)}…</code>
          {study.openedAt
            ? ` · ${t("studyView.openedAt", { when: when(study.openedAt) })}`
            : ""}
          {study.closedAt
            ? ` · ${t("studyView.closedAt", { when: when(study.closedAt) })}`
            : ""}
        </p>
        <div aria-live="polite">
          {note && <Notice tone="green">{note}</Notice>}
          {error !== undefined && (
            <Notice tone="red">{studyErrorMessage(error, t)}</Notice>
          )}
        </div>
        <div className="tag-row">
          {studies.canManage && study.state === "draft" && (
            <>
              <Button disabled={pending} onClick={() => setEditing(true)}>
                {t("studyView.edit")}
              </Button>
              <Button
                kind="primary"
                disabled={pending}
                onClick={() =>
                  void act(async () => {
                    await port.transition(study.id, "open", study.revision);
                    onChanged(
                      t("studyView.recruiting", { title: study.title }),
                    );
                    return "";
                  })
                }
              >
                <Play size={16} aria-hidden="true" /> {t("studyView.open")}
              </Button>
            </>
          )}
          {studies.canManage &&
            study.state === "recruiting" &&
            !confirmClose && (
              <Button
                kind="danger"
                disabled={pending}
                onClick={() => setConfirmClose(true)}
              >
                <Square size={16} aria-hidden="true" /> {t("studyView.close")}
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
                    ? t("studyView.allocation.ok", {
                        checked: check.checked,
                        allocated: check.allocated,
                      })
                    : t("studyView.allocation.mismatch", {
                        mismatches: check.mismatches,
                        checked: check.checked,
                      });
                })
              }
            >
              <ShieldCheck size={16} aria-hidden="true" />{" "}
              {t("studyView.allocation.check")}
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
                    return t("studyView.downloaded", {
                      filename: file.filename,
                      digest: `${file.digest.slice(0, 12)}…`,
                    });
                  })
                }
              >
                <Download size={16} aria-hidden="true" />{" "}
                {t("studyView.export", { format: format.toUpperCase() })}
              </Button>
            ))}
        </div>
        {confirmClose && (
          <Notice tone="gold" title={t("studyView.confirmClose.title")}>
            {t("studyView.confirmClose.body")}
            <div className="tag-row">
              <Button
                kind="danger"
                disabled={pending}
                onClick={() =>
                  void act(async () => {
                    await port.transition(study.id, "close", study.revision);
                    setConfirmClose(false);
                    onChanged(
                      t("studyView.closedMessage", { title: study.title }),
                    );
                    return "";
                  })
                }
              >
                {t("studyView.confirmClose.confirm")}
              </Button>
              <Button kind="quiet" onClick={() => setConfirmClose(false)}>
                {t("studyView.confirmClose.keep")}
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

const emptyInstruments = (): Instruments => ({
  pre: [],
  post: [],
  transfer: [],
  delayed: [],
});
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
  const t = useT();
  const id = useId();
  const [releaseId, setReleaseId] = useState(
    initial?.releaseId ?? releases[0]?.id ?? "",
  );
  const [title, setTitle] = useState(initial?.title ?? "");
  const [purpose, setPurpose] = useState(initial?.purpose ?? "");
  const [minCellSize, setMinCellSize] = useState(initial?.minCellSize ?? 5);
  const arms0 = defaultArms(t).map((arm) => {
    const existing = initial?.arms.find((a) => a.behaviour === arm.behaviour);
    return {
      arm: existing
        ? {
            id: existing.id,
            label: existing.label,
            behaviour: existing.behaviour,
          }
        : arm,
      on: initial ? Boolean(existing) : true,
    };
  });
  const [arms, setArms] = useState(arms0);
  const [instruments, setInstruments] = useState<Instruments>(
    initial?.instruments ?? emptyInstruments(),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const release = releases.find((r) => r.id === releaseId);
  const setOf = (item: string): InstrumentSet | "" =>
    instrumentSets.find((s) => instruments[s].includes(item)) ?? "";
  const assign = (item: string, set: InstrumentSet | "") =>
    setInstruments((current) => {
      const next = Object.fromEntries(
        instrumentSets.map((s) => [s, current[s].filter((i) => i !== item)]),
      ) as Instruments;
      if (set) next[set] = [...next[set], item];
      return next;
    });
  const chosen: StudyArm[] = arms.filter((a) => a.on).map((a) => a.arm);
  return (
    <Card title={initial ? t("studyView.form.editTitle") : t("studyView.new")}>
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setPending(true);
          setError(undefined);
          try {
            await onSubmit(
              { title, purpose, arms: chosen, instruments, minCellSize },
              releaseId,
            );
          } catch (caught) {
            setError(caught);
          } finally {
            setPending(false);
          }
        }}
      >
        {!initial && (
          <Field
            label={t("studyView.form.release")}
            htmlFor={`${id}-release`}
            hint={t("studyView.form.releaseHint")}
          >
            <select
              id={`${id}-release`}
              value={releaseId}
              onChange={(e) => {
                setReleaseId(e.target.value);
                setInstruments(emptyInstruments());
              }}
            >
              {releases.map((r) => (
                <option key={r.id} value={r.id}>
                  {t("studyView.form.releaseOption", {
                    version: r.version,
                    status: r.status,
                  })}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label={t("studyView.form.title")} htmlFor={`${id}-title`}>
          <input
            id={`${id}-title`}
            dir="auto"
            value={title}
            minLength={3}
            maxLength={120}
            required
            onChange={(e) => setTitle(e.target.value)}
          />
        </Field>
        <Field
          label={t("studyView.form.purpose")}
          htmlFor={`${id}-purpose`}
          hint={t("studyView.form.purposeHint")}
        >
          <textarea
            id={`${id}-purpose`}
            dir="auto"
            rows={4}
            value={purpose}
            minLength={20}
            maxLength={2000}
            required
            aria-describedby={`${id}-purpose-hint`}
            onChange={(e) => setPurpose(e.target.value)}
          />
        </Field>
        <fieldset className="study-fieldset">
          <legend>{t("studyView.form.arms")}</legend>
          {arms.map((entry, i) => (
            <div key={entry.arm.behaviour} className="study-arm-row">
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={entry.on}
                  onChange={(e) =>
                    setArms((all) =>
                      all.map((a, j) =>
                        j === i ? { ...a, on: e.target.checked } : a,
                      ),
                    )
                  }
                />
                {t("studyView.form.include", {
                  arm: behaviourLabel(entry.arm.behaviour, t),
                })}
              </label>
              <Field
                label={t("studyView.form.armName", {
                  arm: behaviourLabel(entry.arm.behaviour, t),
                })}
                htmlFor={`${id}-arm-${i}`}
              >
                <input
                  id={`${id}-arm-${i}`}
                  dir="auto"
                  value={entry.arm.label}
                  maxLength={60}
                  disabled={!entry.on}
                  onChange={(e) =>
                    setArms((all) =>
                      all.map((a, j) =>
                        j === i
                          ? { ...a, arm: { ...a.arm, label: e.target.value } }
                          : a,
                      ),
                    )
                  }
                />
              </Field>
            </div>
          ))}
        </fieldset>
        <fieldset className="study-fieldset">
          <legend>{t("studyView.form.sets")}</legend>
          <p className="muted">{t("studyView.form.setsHelp")}</p>
          {release?.items.length ? (
            <div className="study-items">
              {release.items.map((item) => (
                <Field
                  key={item.id}
                  label={[item.id, item.type, item.role]
                    .filter(Boolean)
                    .join(" · ")}
                  htmlFor={`${id}-item-${item.id}`}
                  hint={item.objectiveIds.join(", ")}
                >
                  <select
                    id={`${id}-item-${item.id}`}
                    value={setOf(item.id)}
                    aria-describedby={`${id}-item-${item.id}-hint`}
                    onChange={(e) =>
                      assign(item.id, e.target.value as InstrumentSet | "")
                    }
                  >
                    <option value="">{t("studyView.form.notUsed")}</option>
                    {instrumentSets.map((set) => (
                      <option
                        key={set}
                        value={set}
                        disabled={set === "delayed" && !item.retention}
                      >
                        {set === "delayed" && !item.retention
                          ? t("studyView.form.notRetention", {
                              set: setLabel(set, t),
                            })
                          : setLabel(set, t)}
                      </option>
                    ))}
                  </select>
                </Field>
              ))}
            </div>
          ) : (
            <p className="muted">{t("studyView.form.noItems")}</p>
          )}
        </fieldset>
        <Field
          label={t("studyView.form.cellSize")}
          htmlFor={`${id}-cell`}
          hint={t("studyView.form.cellSizeHint")}
        >
          <input
            id={`${id}-cell`}
            type="number"
            min={3}
            max={100}
            value={minCellSize}
            aria-describedby={`${id}-cell-hint`}
            onChange={(e) => setMinCellSize(Number(e.target.value))}
          />
        </Field>
        <div aria-live="polite">
          {error !== undefined && (
            <Notice tone="red">{studyErrorMessage(error, t)}</Notice>
          )}
        </div>
        <div className="tag-row">
          <Button
            kind="primary"
            type="submit"
            disabled={pending || chosen.length < 2 || !releaseId}
          >
            {t("studyView.form.save")}
          </Button>
          <Button kind="quiet" type="button" onClick={onCancel}>
            {t("studyView.cancel")}
          </Button>
        </div>
      </form>
    </Card>
  );
}
