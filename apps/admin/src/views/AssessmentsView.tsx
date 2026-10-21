import { useId, useMemo, useRef, useState } from "react";
import type { AdminClient, CourseWorkspace } from "../domain/contracts";
import {
  assessmentErrorMessage,
  type AssessmentAdminPort,
  type AssessmentItem,
  type AssessmentList,
  type Fixture,
  type FixtureResult,
  type KeyImpact,
  type ReviewWindow,
  reviewWindows,
} from "../domain/assessmentAdmin";
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
import { useFormatters, useT, type MessageKey } from "../i18n";

/**
 * Answer keys and test answers (Q09): for each question of a release, its key or rubric, the
 * answers it must reject or accept, and a test run of all of them. Keys change only on a draft and
 * are checked against the test answers before they are saved.
 */
export function AssessmentsView({
  data,
  client,
}: {
  data: CourseWorkspace;
  client: AdminClient;
}) {
  const t = useT();
  if (!client.assessments)
    return (
      <Card title={t("assessmentsView.title")}>
        <EmptyState title={t("assessmentsView.unavailable.title")}>
          {t("assessmentsView.unavailable.body")}
        </EmptyState>
      </Card>
    );
  if (!data.permissions.includes("course.write"))
    return (
      <Card title={t("assessmentsView.title")}>
        <EmptyState title={t("assessmentsView.forbidden.title")}>
          {t("assessmentsView.forbidden.body")}
        </EmptyState>
      </Card>
    );
  return <Assessments port={client.assessments} data={data} />;
}

function Assessments({
  port,
  data,
}: {
  port: AssessmentAdminPort;
  data: CourseWorkspace;
}) {
  const t = useT();
  const id = useId();
  const releases = data.releases;
  // The newest draft first: that is where keys can change. Otherwise the newest release.
  const [releaseId, setReleaseId] = useState(
    () => (releases.find((r) => r.state === "draft") ?? releases[0])?.id ?? "",
  );
  const [version, setVersion] = useState(0);
  const reload = () => setVersion((v) => v + 1);
  const list = useRemote(
    (signal) =>
      releaseId
        ? port.list(data.course.id, releaseId, signal)
        : Promise.resolve(null),
    [port, data.course.id, releaseId, version],
  );
  const fixtures = useRemote(
    (signal) => port.fixtures(data.course.id, signal),
    [port, data.course.id, version],
  );
  // Keep showing what was loaded while a change reloads it, so open forms and their notices stay.
  const lastList = useRef<AssessmentList | null>(null),
    lastFixtures = useRef<Fixture[] | null>(null);
  if (list.data) lastList.current = list.data;
  if (fixtures.data) lastFixtures.current = fixtures.data.fixtures;
  const shownList =
    list.data ??
    (lastList.current?.release.id === releaseId ? lastList.current : null);
  const shownFixtures = fixtures.data?.fixtures ?? lastFixtures.current;
  if (!releases.length)
    return (
      <Card title={t("assessmentsView.title")}>
        <EmptyState title={t("assessmentsView.noRelease")}>
          {t("assessmentsView.intro")}
        </EmptyState>
      </Card>
    );
  return (
    <div className="page-stack">
      <Card title={t("assessmentsView.title")}>
        <p>{t("assessmentsView.intro")}</p>
        <Field
          label={t("assessmentsView.release")}
          htmlFor={`${id}-release`}
          hint={t("assessmentsView.releaseHint")}
        >
          <select
            id={`${id}-release`}
            value={releaseId}
            onChange={(e) => setReleaseId(e.target.value)}
          >
            {releases.map((r) => (
              <option key={r.id} value={r.id}>
                {t("assessmentsView.releaseOption", {
                  version: r.version,
                  state: r.state,
                })}
              </option>
            ))}
          </select>
        </Field>
      </Card>
      <TestRunCard
        port={port}
        catalogId={data.course.id}
        releaseId={releaseId}
        version={version}
      />
      {releaseId && (
        <SourcesCard
          port={port}
          catalogId={data.course.id}
          releaseId={releaseId}
        />
      )}
      {list.error || fixtures.error ? (
        <Notice tone="red">
          {assessmentErrorMessage(list.error ?? fixtures.error, t)}
        </Notice>
      ) : !shownList || !shownFixtures ? (
        <Loading label={t("assessmentsView.loading")} />
      ) : (
        <>
          {!shownList.release.editable && (
            <Notice tone="blue">{t("assessmentsView.readOnly")}</Notice>
          )}
          {shownList.items.map((item) => (
            <ItemCard
              key={`${shownList.release.id}:${item.assessmentId}`}
              port={port}
              catalogId={data.course.id}
              list={shownList}
              item={item}
              fixtures={shownFixtures.filter(
                (f) => f.assessmentId === item.assessmentId,
              )}
              onChanged={reload}
            />
          ))}
          {shownList.rubrics.map((rubric) => (
            <RubricCard
              key={`${shownList.release.id}:${rubric.id}:${shownList.release.digest}`}
              port={port}
              catalogId={data.course.id}
              list={shownList}
              rubric={rubric}
              onChanged={reload}
            />
          ))}
        </>
      )}
    </div>
  );
}

const statusTone = {
  undated: "red",
  overdue: "red",
  due_soon: "gold",
  current: "green",
} as const;
/** Source freshness (Q09): when the course author last reviewed each source this release cites,
 * against a review window staff choose. Core does not re-read the sources. */
function SourcesCard({
  port,
  catalogId,
  releaseId,
}: {
  port: AssessmentAdminPort;
  catalogId: string;
  releaseId: string;
}) {
  const t = useT();
  const id = useId();
  const [windowDays, setWindowDays] = useState<ReviewWindow>(365);
  const view = useRemote(
    (signal) => port.sources(catalogId, releaseId, windowDays, signal),
    [port, catalogId, releaseId, windowDays],
  );
  return (
    <Card title={t("assessmentsView.sources.title")}>
      <p className="muted">{t("assessmentsView.sources.body")}</p>
      <Field
        label={t("assessmentsView.sources.window")}
        htmlFor={`${id}-window`}
      >
        <select
          id={`${id}-window`}
          value={windowDays}
          onChange={(e) =>
            setWindowDays(Number(e.target.value) as ReviewWindow)
          }
        >
          {reviewWindows.map((days) => (
            <option key={days} value={days}>
              {t(`assessmentsView.sources.window.d${days}` as MessageKey)}
            </option>
          ))}
        </select>
      </Field>
      {view.error ? (
        <Notice tone="red">{assessmentErrorMessage(view.error, t)}</Notice>
      ) : !view.data ? (
        <Loading label={t("assessmentsView.sources.loading")} />
      ) : !view.data.sources.length ? (
        <p className="muted">{t("assessmentsView.sources.none")}</p>
      ) : (
        <>
          <p>
            {t("assessmentsView.sources.summary", {
              total: view.data.summary.total,
              overdue: view.data.summary.overdue + view.data.summary.undated,
              dueSoon: view.data.summary.dueSoon,
            })}
          </p>
          <ul
            className="plain-list"
            aria-label={t("assessmentsView.sources.listLabel")}
          >
            {view.data.sources.map((source) => (
              <li key={source.id}>
                <Badge tone={statusTone[source.status]}>
                  {t(
                    `assessmentsView.sources.status.${source.status}` as MessageKey,
                  )}
                </Badge>{" "}
                <a
                  href={source.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  dir="auto"
                >
                  {source.title}
                </a>{" "}
                <span className="muted" dir="ltr">
                  {source.host}
                </span>
                <br />
                <span className="muted">
                  {source.reviewedAt === null
                    ? t("assessmentsView.sources.noDate")
                    : t("assessmentsView.sources.reviewed", {
                        date: source.reviewedAt,
                        days: source.ageDays ?? 0,
                      })}{" "}
                  ·{" "}
                  {t("assessmentsView.sources.cited", {
                    count: source.citedBy.blocks,
                  })}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}

/** The validation report: run every test answer against this release and see recent runs. */
function TestRunCard({
  port,
  catalogId,
  releaseId,
  version,
}: {
  port: AssessmentAdminPort;
  catalogId: string;
  releaseId: string;
  version: number;
}) {
  const t = useT();
  const { when } = useFormatters();
  const [ran, setRan] = useState(0);
  const runs = useRemote(
    (signal) => port.runs(catalogId, signal),
    [port, catalogId, version, ran],
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const [failures, setFailures] = useState<FixtureResult[]>();
  return (
    <Card title={t("assessmentsView.run.title")}>
      <p className="muted">{t("assessmentsView.run.body")}</p>
      <Button
        kind="primary"
        disabled={pending || !releaseId}
        onClick={() => {
          setPending(true);
          setError(undefined);
          port
            .run(catalogId, releaseId)
            .then((r) => {
              setFailures(r.results.filter((x) => x.status === "failed"));
              setRan((n) => n + 1);
            }, setError)
            .finally(() => setPending(false));
        }}
      >
        {t("assessmentsView.run.start")}
      </Button>
      {error !== undefined && (
        <Notice tone="red">{assessmentErrorMessage(error, t)}</Notice>
      )}
      {failures && failures.length > 0 && (
        <Notice
          tone="red"
          title={t("assessmentsView.run.failedTitle", {
            count: failures.length,
          })}
        >
          <ul className="plain-list">
            {failures.map((f) => (
              <li key={f.fixtureId}>
                {t("assessmentsView.run.failedLine", {
                  item: f.assessmentId,
                  label: f.label || "—",
                  expected: f.expected,
                  outcome: f.outcome,
                })}
              </li>
            ))}
          </ul>
        </Notice>
      )}
      {failures && failures.length === 0 && (
        <Notice tone="green">{t("assessmentsView.run.allPassed")}</Notice>
      )}
      {!!runs.data?.runs.length && (
        <div
          className="table-wrap"
          tabIndex={0}
          role="region"
          aria-label={t("assessmentsView.run.history")}
        >
          <table className="data-table">
            <caption>{t("assessmentsView.run.history")}</caption>
            <thead>
              <tr>
                <th scope="col">{t("assessmentsView.run.when")}</th>
                <th scope="col">{t("assessmentsView.run.version")}</th>
                <th scope="col">{t("assessmentsView.run.result")}</th>
              </tr>
            </thead>
            <tbody>
              {runs.data.runs.map((r) => (
                <tr key={r.runId}>
                  <td>
                    {when(r.at)}{" "}
                    <span className="muted" dir="auto">
                      · {r.by}
                    </span>
                  </td>
                  <td dir="ltr">{r.releaseVersion}</td>
                  <td>
                    {t("assessmentsView.run.counts", {
                      passed: r.passed,
                      failed: r.failed,
                      notRunnable: r.notRunnable,
                    })}
                    {r.stale && (
                      <Badge tone="gold">
                        {t("assessmentsView.run.stale")}
                      </Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

const keyKinds = new Set(["choice", "numeric", "prediction", "trace"]);
/** A learner answer for this question, from the form's text inputs. */
function answerFrom(
  item: AssessmentItem,
  value: string,
  steps: Record<string, string>,
  unit: string,
): unknown {
  if (item.type === "choice") return value;
  if (item.type === "numeric" || item.type === "prediction")
    return unit.trim()
      ? { value: Number(value), unit: unit.trim() }
      : Number(value);
  if (item.type === "trace") return steps;
  return value;
}
const shown = (answer: unknown) =>
  typeof answer === "string" || typeof answer === "number"
    ? String(answer)
    : JSON.stringify(answer);

function ItemCard({
  port,
  catalogId,
  list,
  item,
  fixtures,
  onChanged,
}: {
  port: AssessmentAdminPort;
  catalogId: string;
  list: AssessmentList;
  item: AssessmentItem;
  fixtures: Fixture[];
  onChanged: () => void;
}) {
  const t = useT();
  const runnable = keyKinds.has(item.type);
  return (
    <Card
      eyebrow={t(
        `assessmentsView.kind.${keyKinds.has(item.type) ? item.type : item.kind}` as MessageKey,
      )}
      title={<span dir="auto">{item.prompt}</span>}
      actions={
        <span className="mono muted" dir="ltr">
          {item.assessmentId}
        </span>
      }
    >
      {item.kind === "key" && (
        <KeyEditor
          port={port}
          catalogId={catalogId}
          list={list}
          item={item}
          onChanged={onChanged}
        />
      )}
      {item.kind === "item_rubric" && item.criteria && (
        <CriteriaEditor
          port={port}
          catalogId={catalogId}
          list={list}
          rubricId={item.assessmentId}
          criteria={item.criteria}
          versioned={false}
          onChanged={onChanged}
        />
      )}
      {item.kind === "course_rubric" && (
        <p className="muted">
          {t("assessmentsView.courseRubric", { rubric: item.rubricId ?? "" })}
        </p>
      )}
      {item.kind === "not_editable" && (
        <p className="muted">{t("assessmentsView.notEditable")}</p>
      )}
      {runnable ? (
        <FixturesEditor
          port={port}
          catalogId={catalogId}
          releaseId={list.release.id}
          item={item}
          fixtures={fixtures}
          onChanged={onChanged}
        />
      ) : (
        <p className="muted">{t("assessmentsView.fixtures.notRunnable")}</p>
      )}
    </Card>
  );
}

/** The current key in words, and a form to change it on a draft (check first, then save). */
function KeyEditor({
  port,
  catalogId,
  list,
  item,
  onChanged,
}: {
  port: AssessmentAdminPort;
  catalogId: string;
  list: AssessmentList;
  item: AssessmentItem;
  onChanged: () => void;
}) {
  const t = useT();
  const id = useId();
  const key = (item.key ?? {}) as Record<string, unknown>;
  const [correct, setCorrect] = useState(String(key.correctOptionId ?? ""));
  const [expected, setExpected] = useState(
    key.expected === undefined || Array.isArray(key.expected)
      ? ""
      : String(key.expected),
  );
  const [tolerance, setTolerance] = useState(
    String(key.absoluteTolerance ?? 0),
  );
  const [unit, setUnit] = useState(String(key.unit ?? ""));
  const [steps, setSteps] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      (
        (Array.isArray(key.expected) ? key.expected : []) as {
          stepId: string;
          answer: string;
        }[]
      ).map((s) => [s.stepId, s.answer]),
    ),
  );
  const [explanation, setExplanation] = useState(String(key.explanation ?? ""));
  const [impact, setImpact] = useState<{ draft: string; result: KeyImpact }>();
  const [accept, setAccept] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const [saved, setSaved] = useState(false);
  const grading = useMemo(() => {
    if (item.type === "choice")
      return { correctOptionId: correct, explanation };
    if (item.type === "trace")
      return {
        expected: (item.steps ?? []).map((s) => ({
          stepId: s.id,
          answer: steps[s.id] ?? "",
        })),
        match: key.match ?? "normalized_whitespace",
        explanation,
      };
    return {
      expected: Number(expected),
      absoluteTolerance: Number(tolerance),
      ...(key.relativeTolerance !== undefined
        ? { relativeTolerance: key.relativeTolerance }
        : {}),
      ...(unit.trim() ? { unit: unit.trim() } : {}),
      explanation,
    };
  }, [
    item,
    correct,
    expected,
    tolerance,
    unit,
    steps,
    explanation,
    key.match,
    key.relativeTolerance,
  ]);
  const draft = JSON.stringify(grading);
  const checked = impact?.draft === draft;
  const run = (save: boolean) => {
    setPending(true);
    setError(undefined);
    setSaved(false);
    const action = save
      ? port
          .saveKey(catalogId, list.release.id, item.assessmentId, {
            grading,
            expectedDigest: list.release.digest,
            acceptFailingFixtures: accept,
          })
          .then(() => {
            setSaved(true);
            onChanged();
          })
      : port
          .previewKey(catalogId, list.release.id, item.assessmentId, grading)
          .then((result) => setImpact({ draft, result }));
    action.catch(setError).finally(() => setPending(false));
  };
  return (
    <div className="stack">
      <p>
        <strong>{t("assessmentsView.key.current")}</strong>{" "}
        <span dir="auto">
          {item.type === "choice"
            ? (item.options?.find((o) => o.id === key.correctOptionId)?.text ??
              String(key.correctOptionId))
            : item.type === "trace"
              ? ((key.expected as { stepId: string; answer: string }[]) ?? [])
                  .map((s) => s.answer)
                  .join(" → ")
              : t("assessmentsView.key.numeric", {
                  expected: String(key.expected),
                  tolerance: String(key.absoluteTolerance ?? 0),
                  unit: String(key.unit ?? ""),
                })}
        </span>
      </p>
      {list.release.editable && (
        <form
          className="input-grid"
          onSubmit={(e) => {
            e.preventDefault();
            run(true);
          }}
        >
          {item.type === "choice" && (
            <Field
              label={t("assessmentsView.key.correctOption")}
              htmlFor={`${id}-correct`}
            >
              <select
                id={`${id}-correct`}
                value={correct}
                onChange={(e) => setCorrect(e.target.value)}
              >
                {(item.options ?? []).map((o) => (
                  <option key={o.id} value={o.id} dir="auto">
                    {o.text}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {(item.type === "numeric" || item.type === "prediction") && (
            <>
              <Field
                label={t("assessmentsView.key.expected")}
                htmlFor={`${id}-expected`}
              >
                <input
                  id={`${id}-expected`}
                  type="number"
                  step="any"
                  value={expected}
                  onChange={(e) => setExpected(e.target.value)}
                  dir="ltr"
                />
              </Field>
              <Field
                label={t("assessmentsView.key.tolerance")}
                htmlFor={`${id}-tolerance`}
                hint={t("assessmentsView.key.toleranceHint")}
              >
                <input
                  id={`${id}-tolerance`}
                  type="number"
                  step="any"
                  min={0}
                  value={tolerance}
                  onChange={(e) => setTolerance(e.target.value)}
                  dir="ltr"
                />
              </Field>
              <Field
                label={t("assessmentsView.key.unit")}
                htmlFor={`${id}-unit`}
                hint={t("assessmentsView.key.unitHint")}
              >
                <input
                  id={`${id}-unit`}
                  value={unit}
                  onChange={(e) => setUnit(e.target.value)}
                  dir="auto"
                />
              </Field>
            </>
          )}
          {item.type === "trace" &&
            (item.steps ?? []).map((s) => (
              <Field
                key={s.id}
                label={s.prompt}
                labelDir="auto"
                htmlFor={`${id}-step-${s.id}`}
              >
                <input
                  id={`${id}-step-${s.id}`}
                  value={steps[s.id] ?? ""}
                  onChange={(e) =>
                    setSteps({ ...steps, [s.id]: e.target.value })
                  }
                  dir="auto"
                />
              </Field>
            ))}
          <Field
            label={t("assessmentsView.key.explanation")}
            htmlFor={`${id}-explanation`}
            hint={t("assessmentsView.key.explanationHint")}
          >
            <textarea
              id={`${id}-explanation`}
              rows={2}
              value={explanation}
              onChange={(e) => setExplanation(e.target.value)}
              dir="auto"
            />
          </Field>
          {checked && impact && <ImpactList impact={impact.result} />}
          {checked && impact && impact.result.failing > 0 && (
            <label className="check-label wide">
              <input
                type="checkbox"
                checked={accept}
                onChange={(e) => setAccept(e.target.checked)}
              />
              {t("assessmentsView.key.acceptFailing", {
                count: impact.result.failing,
              })}
            </label>
          )}
          <div className="wide stack">
            {error !== undefined && (
              <Notice tone="red">{assessmentErrorMessage(error, t)}</Notice>
            )}
            {saved && (
              <Notice tone="green">{t("assessmentsView.key.saved")}</Notice>
            )}
            {!checked && (
              <p className="muted">{t("assessmentsView.key.checkFirst")}</p>
            )}
            <div className="button-row">
              <Button
                disabled={pending || !explanation.trim()}
                onClick={() => run(false)}
              >
                {t("assessmentsView.key.check")}
              </Button>
              <Button
                kind="primary"
                type="submit"
                disabled={
                  pending || !checked || (impact!.result.failing > 0 && !accept)
                }
              >
                {t("assessmentsView.key.save")}
              </Button>
            </div>
          </div>
        </form>
      )}
    </div>
  );
}

function ImpactList({ impact }: { impact: KeyImpact }) {
  const t = useT();
  if (!impact.results.length)
    return <p className="muted wide">{t("assessmentsView.impact.none")}</p>;
  return (
    <div className="wide">
      <p>
        {t("assessmentsView.impact.summary", {
          failing: impact.failing,
          changed: impact.changed,
        })}
      </p>
      <ul className="plain-list">
        {impact.results.map((r) => (
          <li key={r.fixtureId}>
            <Badge
              tone={
                r.status === "passed"
                  ? "green"
                  : r.status === "failed"
                    ? "red"
                    : "neutral"
              }
            >
              {t(`assessmentsView.status.${r.status}` as MessageKey)}
            </Badge>{" "}
            <span dir="auto">{r.label || "—"}</span>{" "}
            <span className="muted">
              {t("assessmentsView.impact.line", {
                expected: r.expected,
                outcome: r.outcome,
              })}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The answers a question must reject or accept, and a form to add one. */
function FixturesEditor({
  port,
  catalogId,
  releaseId,
  item,
  fixtures,
  onChanged,
}: {
  port: AssessmentAdminPort;
  catalogId: string;
  releaseId: string;
  item: AssessmentItem;
  fixtures: Fixture[];
  onChanged: () => void;
}) {
  const t = useT();
  const id = useId();
  const [value, setValue] = useState(
    item.type === "choice" ? (item.options?.[0]?.id ?? "") : "",
  );
  const [unit, setUnit] = useState("");
  const [steps, setSteps] = useState<Record<string, string>>({});
  const [expected, setExpected] = useState<"correct" | "incorrect">(
    "incorrect",
  );
  const [label, setLabel] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const [added, setAdded] = useState<FixtureResult>();
  const filled =
    item.type === "trace"
      ? (item.steps ?? []).every((s) => (steps[s.id] ?? "").trim())
      : value.trim() !== "";
  return (
    <section className="stack" aria-label={t("assessmentsView.fixtures.label")}>
      <h3 className="section-title">
        {t("assessmentsView.fixtures.title", { count: fixtures.length })}
      </h3>
      <p className="muted">{t("assessmentsView.fixtures.hint")}</p>
      {fixtures.length > 0 && (
        <ul className="plain-list">
          {fixtures.map((f) => (
            <li key={f.fixtureId} className="button-row">
              <span>
                <Badge tone={f.expected === "incorrect" ? "gold" : "green"}>
                  {t(
                    `assessmentsView.fixtures.expected.${f.expected}` as MessageKey,
                  )}
                </Badge>{" "}
                <span className="mono" dir="ltr">
                  {item.type === "choice"
                    ? (item.options?.find((o) => o.id === f.answer)?.text ??
                      shown(f.answer))
                    : shown(f.answer)}
                </span>{" "}
                {f.label && (
                  <span className="muted" dir="auto">
                    · {f.label}
                  </span>
                )}
              </span>
              <Button
                kind="quiet"
                disabled={pending}
                onClick={() => {
                  setPending(true);
                  port
                    .removeFixture(catalogId, f.fixtureId)
                    .then(onChanged, setError)
                    .finally(() => setPending(false));
                }}
              >
                {t("assessmentsView.fixtures.remove")}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="input-grid"
        onSubmit={(e) => {
          e.preventDefault();
          setPending(true);
          setError(undefined);
          port
            .addFixture(catalogId, {
              releaseId,
              assessmentId: item.assessmentId,
              answer: answerFrom(item, value, steps, unit),
              expected,
              label: label.trim(),
            })
            .then((r) => {
              setAdded(r);
              setLabel("");
              onChanged();
            }, setError)
            .finally(() => setPending(false));
        }}
      >
        {item.type === "choice" ? (
          <Field
            label={t("assessmentsView.fixtures.answer")}
            htmlFor={`${id}-answer`}
          >
            <select
              id={`${id}-answer`}
              value={value}
              onChange={(e) => setValue(e.target.value)}
            >
              {(item.options ?? []).map((o) => (
                <option key={o.id} value={o.id} dir="auto">
                  {o.text}
                </option>
              ))}
            </select>
          </Field>
        ) : item.type === "trace" ? (
          (item.steps ?? []).map((s) => (
            <Field
              key={s.id}
              label={s.prompt}
              labelDir="auto"
              htmlFor={`${id}-fx-${s.id}`}
            >
              <input
                id={`${id}-fx-${s.id}`}
                value={steps[s.id] ?? ""}
                onChange={(e) => setSteps({ ...steps, [s.id]: e.target.value })}
                dir="auto"
              />
            </Field>
          ))
        ) : (
          <>
            <Field
              label={t("assessmentsView.fixtures.answer")}
              htmlFor={`${id}-answer`}
            >
              <input
                id={`${id}-answer`}
                type="number"
                step="any"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                dir="ltr"
              />
            </Field>
            <Field
              label={t("assessmentsView.fixtures.unit")}
              htmlFor={`${id}-unit`}
              hint={t("assessmentsView.fixtures.unitHint")}
            >
              <input
                id={`${id}-unit`}
                value={unit}
                onChange={(e) => setUnit(e.target.value)}
                dir="auto"
              />
            </Field>
          </>
        )}
        <fieldset className="wide placement-choices">
          <legend>{t("assessmentsView.fixtures.should")}</legend>
          {(["incorrect", "correct"] as const).map((v) => (
            <label key={v} className="check-label">
              <input
                type="radio"
                name={`${id}-expected`}
                checked={expected === v}
                onChange={() => setExpected(v)}
              />
              {t(`assessmentsView.fixtures.should.${v}` as MessageKey)}
            </label>
          ))}
        </fieldset>
        <Field
          label={t("assessmentsView.fixtures.labelField")}
          htmlFor={`${id}-label`}
          hint={t("assessmentsView.fixtures.labelHint")}
        >
          <input
            id={`${id}-label`}
            value={label}
            maxLength={200}
            onChange={(e) => setLabel(e.target.value)}
            dir="auto"
          />
        </Field>
        <div className="wide stack">
          {error !== undefined && (
            <Notice tone="red">{assessmentErrorMessage(error, t)}</Notice>
          )}
          {added && (
            <Notice tone={added.status === "passed" ? "green" : "gold"}>
              {t(
                added.status === "passed"
                  ? "assessmentsView.fixtures.addedPassed"
                  : "assessmentsView.fixtures.addedFailed",
                { outcome: added.outcome },
              )}
            </Notice>
          )}
          <div className="button-row">
            <Button kind="primary" type="submit" disabled={pending || !filled}>
              {t("assessmentsView.fixtures.add")}
            </Button>
          </div>
        </div>
      </form>
    </section>
  );
}

function RubricCard({
  port,
  catalogId,
  list,
  rubric,
  onChanged,
}: {
  port: AssessmentAdminPort;
  catalogId: string;
  list: AssessmentList;
  rubric: AssessmentList["rubrics"][number];
  onChanged: () => void;
}) {
  const t = useT();
  return (
    <Card
      eyebrow={t("assessmentsView.rubric.eyebrow", {
        version: rubric.version,
        count: rubric.usedBy.length,
      })}
      title={<span dir="auto">{rubric.title}</span>}
    >
      <CriteriaEditor
        port={port}
        catalogId={catalogId}
        list={list}
        rubricId={rubric.id}
        criteria={rubric.criteria}
        versioned
        version={rubric.version}
        onChanged={onChanged}
      />
    </Card>
  );
}

/** Rubric criteria: shown, and on a draft edited (a course rubric under a new version). */
function CriteriaEditor({
  port,
  catalogId,
  list,
  rubricId,
  criteria,
  versioned,
  version,
  onChanged,
}: {
  port: AssessmentAdminPort;
  catalogId: string;
  list: AssessmentList;
  rubricId: string;
  criteria: { id: string; description: string; required: boolean }[];
  versioned: boolean;
  version?: string;
  onChanged: () => void;
}) {
  const t = useT();
  const id = useId();
  const [rows, setRows] = useState(criteria);
  const [nextVersion, setNextVersion] = useState(version ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  if (!list.release.editable)
    return (
      <ul className="plain-list">
        {criteria.map((c) => (
          <li key={c.id}>
            <span dir="auto">{c.description}</span>{" "}
            {c.required && (
              <Badge tone="blue">{t("assessmentsView.rubric.required")}</Badge>
            )}
          </li>
        ))}
      </ul>
    );
  const changed = JSON.stringify(rows) !== JSON.stringify(criteria);
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        setPending(true);
        setError(undefined);
        port
          .saveRubric(catalogId, list.release.id, rubricId, {
            criteria: rows,
            ...(versioned ? { version: nextVersion.trim() } : {}),
            expectedDigest: list.release.digest,
          })
          .then(onChanged, setError)
          .finally(() => setPending(false));
      }}
    >
      {rows.map((c, i) => (
        <div key={c.id} className="input-grid">
          <Field
            label={t("assessmentsView.rubric.criterion", { n: i + 1 })}
            htmlFor={`${id}-${c.id}`}
          >
            <textarea
              id={`${id}-${c.id}`}
              rows={2}
              value={c.description}
              dir="auto"
              onChange={(e) =>
                setRows(
                  rows.map((r) =>
                    r.id === c.id ? { ...r, description: e.target.value } : r,
                  ),
                )
              }
            />
          </Field>
          <label className="check-label">
            <input
              type="checkbox"
              checked={c.required}
              onChange={(e) =>
                setRows(
                  rows.map((r) =>
                    r.id === c.id ? { ...r, required: e.target.checked } : r,
                  ),
                )
              }
            />
            {t("assessmentsView.rubric.required")}
          </label>
        </div>
      ))}
      {versioned && (
        <Field
          label={t("assessmentsView.rubric.version")}
          htmlFor={`${id}-version`}
          hint={t("assessmentsView.rubric.versionHint")}
        >
          <input
            id={`${id}-version`}
            value={nextVersion}
            onChange={(e) => setNextVersion(e.target.value)}
            dir="ltr"
          />
        </Field>
      )}
      {error !== undefined && (
        <Notice tone="red">{assessmentErrorMessage(error, t)}</Notice>
      )}
      <div className="button-row">
        <Button
          kind="primary"
          type="submit"
          disabled={
            pending || !changed || rows.some((r) => !r.description.trim())
          }
        >
          {t("assessmentsView.rubric.save")}
        </Button>
      </div>
    </form>
  );
}
