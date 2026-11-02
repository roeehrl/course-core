import { useId, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronDown, Copy, Search } from "lucide-react";
import type { AdminClient, CourseWorkspace } from "../domain/contracts";
import {
  assessmentErrorMessage,
  type AssessmentAdminPort,
  type AssessmentItem,
  type AssessmentList,
  type Fixture,
  type FixtureResult,
  type FixtureRuns,
  type KeyImpact,
  type ReviewWindow,
  type SourceFreshness,
  reviewWindows,
} from "../domain/assessmentAdmin";
import { useRemote } from "../hooks/useAdmin";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Notice,
} from "../components/ui";
import { useFormatters, useT, type MessageKey } from "../i18n";
import { ClampedText, SkeletonRows, shortTitle } from "./contentShared";

/**
 * Answer keys and test answers (Q09): for each question of a release, its key or rubric, the
 * answers it must reject or accept, and a test run of all of them. Keys change only on a draft and
 * are checked against the test answers before they are saved.
 *
 * A course can have well over a hundred questions, so they are a searchable one-line list; a
 * question's editors render only while its row is open.
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

type RunState = { releaseId: string; results: FixtureResult[] };

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
  const [ran, setRan] = useState<RunState>();
  const runs = useRemote(
    (signal) => port.runs(data.course.id, signal),
    [port, data.course.id, version, ran],
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
  // The failures of the latest test run of this release: this session's, else the last recorded.
  const shownRelease = shownList?.release.id ?? releaseId;
  const lastResults =
    ran?.releaseId === releaseId
      ? ran.results
      : runs.data?.runs.find((r) => r.releaseId === shownRelease && r.results)
          ?.results;
  if (!releases.length)
    return (
      <Card title={t("assessmentsView.title")}>
        <EmptyState title={t("assessmentsView.noRelease")}>
          {t("assessmentsView.intro")}
        </EmptyState>
      </Card>
    );
  const titleOf = (assessmentId: string) => {
    const item = shownList?.items.find((i) => i.assessmentId === assessmentId);
    return item ? shortTitle(item.prompt, 60) : assessmentId;
  };
  return (
    <div className="page-stack">
      <TestRunCard
        port={port}
        catalogId={data.course.id}
        releaseId={releaseId}
        runs={runs.data?.runs ?? []}
        titleOf={titleOf}
        onRan={(results) => setRan({ releaseId, results })}
      >
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
      </TestRunCard>
      {list.error || fixtures.error ? (
        <Notice tone="red">
          {assessmentErrorMessage(list.error ?? fixtures.error, t)}
        </Notice>
      ) : !shownList || !shownFixtures ? (
        <Card title={t("assessmentsView.questions.title")}>
          <SkeletonRows label={t("assessmentsView.loading")} rows={8} />
        </Card>
      ) : (
        <>
          {!shownList.release.editable && (
            <Notice tone="blue">{t("assessmentsView.readOnly")}</Notice>
          )}
          <QuestionsCard
            key={shownList.release.id}
            port={port}
            catalogId={data.course.id}
            list={shownList}
            fixtures={shownFixtures}
            failures={lastResults}
            onChanged={reload}
          />
          {shownList.rubrics.length > 0 && (
            <Card
              title={t("assessmentsView.rubrics.title", {
                count: shownList.rubrics.length,
              })}
            >
              <ul className="cv-list">
                {shownList.rubrics.map((rubric) => (
                  <RubricRow
                    key={`${shownList.release.id}:${rubric.id}:${shownList.release.digest}`}
                    port={port}
                    catalogId={data.course.id}
                    list={shownList}
                    rubric={rubric}
                    onChanged={reload}
                  />
                ))}
              </ul>
            </Card>
          )}
        </>
      )}
      {releaseId && (
        <SourcesCard
          port={port}
          catalogId={data.course.id}
          releaseId={releaseId}
        />
      )}
    </div>
  );
}

const keyKinds = new Set(["choice", "numeric", "prediction", "trace"]);
/** The question's kind in words: its answer type when it has a key, else how it is graded. */
const kindKey = (item: AssessmentItem) =>
  `assessmentsView.kind.${keyKinds.has(item.type) ? item.type : item.kind}` as MessageKey;
type StatusFilter = "all" | "with" | "without" | "failing" | "notRunnable";

/** Every question of the release as one line: search, filter, open one to edit it. */
function QuestionsCard({
  port,
  catalogId,
  list,
  fixtures,
  failures,
  onChanged,
}: {
  port: AssessmentAdminPort;
  catalogId: string;
  list: AssessmentList;
  fixtures: Fixture[];
  failures: FixtureResult[] | undefined;
  onChanged: () => void;
}) {
  const t = useT();
  const id = useId();
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [open, setOpen] = useState<string>();
  const [shown, setShown] = useState(PAGE);
  const counts = useMemo(() => {
    const byItem = new Map<string, number>();
    for (const f of fixtures)
      byItem.set(f.assessmentId, (byItem.get(f.assessmentId) ?? 0) + 1);
    return byItem;
  }, [fixtures]);
  const failing = useMemo(() => {
    const byItem = new Map<string, number>();
    for (const f of failures ?? [])
      if (f.status === "failed")
        byItem.set(f.assessmentId, (byItem.get(f.assessmentId) ?? 0) + 1);
    return byItem;
  }, [failures]);
  const kinds = [...new Set(list.items.map(kindKey))];
  const needle = query.trim().toLocaleLowerCase();
  const matches = list.items.filter((item) => {
    if (kind && kindKey(item) !== kind) return false;
    const n = counts.get(item.assessmentId) ?? 0;
    if (status === "with" && n === 0) return false;
    if (status === "without" && (n > 0 || !keyKinds.has(item.type)))
      return false;
    if (status === "failing" && !failing.has(item.assessmentId)) return false;
    if (status === "notRunnable" && keyKinds.has(item.type)) return false;
    return (
      !needle ||
      item.prompt.toLocaleLowerCase().includes(needle) ||
      item.assessmentId.toLocaleLowerCase().includes(needle)
    );
  });
  const filtered =
    matches.length !== list.items.length || Boolean(needle) || kind !== "";
  return (
    <Card
      title={t("assessmentsView.questions.title")}
      actions={
        <span className="cv-count">
          {t("assessmentsView.questions.total", { count: list.items.length })}
        </span>
      }
    >
      <div className="cv-toolbar" role="search">
        <div className="field cv-search">
          <label htmlFor={`${id}-q`}>
            {t("assessmentsView.filter.search")}
          </label>
          <div className="search-field">
            <Search size={16} aria-hidden="true" />
            <input
              id={`${id}-q`}
              type="search"
              value={query}
              placeholder={t("assessmentsView.filter.searchPlaceholder")}
              onChange={(e) => {
                setQuery(e.target.value);
                setShown(PAGE);
              }}
            />
          </div>
        </div>
        <Field label={t("assessmentsView.filter.kind")} htmlFor={`${id}-k`}>
          <select
            id={`${id}-k`}
            value={kind}
            onChange={(e) => {
              setKind(e.target.value);
              setShown(PAGE);
            }}
          >
            <option value="">{t("assessmentsView.filter.kindAll")}</option>
            {kinds.map((k) => (
              <option key={k} value={k}>
                {t(k as MessageKey)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("assessmentsView.filter.status")} htmlFor={`${id}-s`}>
          <select
            id={`${id}-s`}
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as StatusFilter);
              setShown(PAGE);
            }}
          >
            {(
              ["all", "with", "without", "failing", "notRunnable"] as const
            ).map((value) =>
              value === "failing" && !failures ? null : (
                <option key={value} value={value}>
                  {t(`assessmentsView.filter.status.${value}` as MessageKey)}
                </option>
              ),
            )}
          </select>
        </Field>
      </div>
      <p className="cv-count" aria-live="polite">
        {filtered
          ? t("assessmentsView.questions.showing", {
              shown: matches.length,
              total: list.items.length,
            })
          : t("assessmentsView.questions.hint")}
      </p>
      {matches.length === 0 ? (
        <EmptyState title={t("assessmentsView.questions.none.title")}>
          {t("assessmentsView.questions.none.body")}
        </EmptyState>
      ) : (
        <ul
          className="cv-list"
          aria-label={t("assessmentsView.questions.title")}
        >
          {matches.slice(0, shown).map((item) => (
            <QuestionRow
              key={item.assessmentId}
              port={port}
              catalogId={catalogId}
              list={list}
              item={item}
              fixtures={fixtures.filter(
                (f) => f.assessmentId === item.assessmentId,
              )}
              failing={failing.get(item.assessmentId) ?? 0}
              open={open === item.assessmentId}
              onToggle={() =>
                setOpen(
                  open === item.assessmentId ? undefined : item.assessmentId,
                )
              }
              onChanged={onChanged}
            />
          ))}
        </ul>
      )}
      {matches.length > shown && (
        <Button className="cv-more" onClick={() => setShown(shown + PAGE)}>
          {t("assessmentsView.questions.more", {
            count: Math.min(PAGE, matches.length - shown),
            left: matches.length - shown,
          })}
        </Button>
      )}
    </Card>
  );
}
const PAGE = 40;

function QuestionRow({
  port,
  catalogId,
  list,
  item,
  fixtures,
  failing,
  open,
  onToggle,
  onChanged,
}: {
  port: AssessmentAdminPort;
  catalogId: string;
  list: AssessmentList;
  item: AssessmentItem;
  fixtures: Fixture[];
  failing: number;
  open: boolean;
  onToggle: () => void;
  onChanged: () => void;
}) {
  const t = useT();
  const panel = useId();
  const runnable = keyKinds.has(item.type);
  return (
    <li>
      <button
        type="button"
        className="cv-row-summary"
        aria-expanded={open}
        aria-controls={panel}
        onClick={onToggle}
      >
        <span className="cv-row-title" dir="auto" title={item.prompt}>
          {shortTitle(item.prompt)}
        </span>
        <span className="cv-row-meta">
          <Badge>{t(kindKey(item))}</Badge>
          <KeyStatus item={item} />
          <span>
            {runnable
              ? t("assessmentsView.row.fixtures", { count: fixtures.length })
              : t("assessmentsView.row.notRunnable")}
          </span>
          {failing > 0 && (
            <Badge tone="red">
              {t("assessmentsView.row.failing", { count: failing })}
            </Badge>
          )}
        </span>
        <ChevronDown size={18} aria-hidden="true" className="cv-row-chevron" />
      </button>
      {open && (
        <div id={panel} className="cv-row-panel">
          <ClampedText
            text={item.prompt}
            more={t("assessmentsView.prompt.more")}
            less={t("assessmentsView.prompt.less")}
          />
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
              {t("assessmentsView.courseRubric", {
                rubric:
                  list.rubrics.find((r) => r.id === item.rubricId)?.title ??
                  item.rubricId ??
                  "",
              })}
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
          <p className="cv-id">
            {t("assessmentsView.questionId")}{" "}
            <code dir="ltr">{item.assessmentId}</code>
          </p>
        </div>
      )}
    </li>
  );
}

/** Whether the question has a key, a rubric, or is graded by an extension, in one badge. */
function KeyStatus({ item }: { item: AssessmentItem }) {
  const t = useT();
  if (item.kind === "key")
    return item.key ? (
      <Badge tone="green">{t("assessmentsView.row.key.set")}</Badge>
    ) : (
      <Badge tone="gold">{t("assessmentsView.row.key.missing")}</Badge>
    );
  if (item.kind === "item_rubric")
    return (
      <Badge tone="blue">
        {t("assessmentsView.row.key.rubric", {
          count: item.criteria?.length ?? 0,
        })}
      </Badge>
    );
  if (item.kind === "course_rubric")
    return <Badge tone="blue">{t("assessmentsView.row.key.course")}</Badge>;
  return <Badge>{t("assessmentsView.row.key.extension")}</Badge>;
}

const statusTone = {
  undated: "red",
  overdue: "red",
  due_soon: "gold",
  current: "green",
} as const;
type Source = SourceFreshness["sources"][number];
/** A 64-character digest some source titles carry: shown short, copied whole. */
const DIGEST = /\b[0-9a-f]{64}\b/i;

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
  const [needsCheck, setNeedsCheck] = useState(false);
  const [all, setAll] = useState(false);
  const view = useRemote(
    (signal) => port.sources(catalogId, releaseId, windowDays, signal),
    [port, catalogId, releaseId, windowDays],
  );
  const sources = (view.data?.sources ?? []).filter(
    (s) => !needsCheck || s.status !== "current",
  );
  const shown = all ? sources : sources.slice(0, SOURCES_PAGE);
  return (
    <Card title={t("assessmentsView.sources.title")}>
      <p className="muted">{t("assessmentsView.sources.body")}</p>
      <div className="cv-toolbar">
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
        <label className="check-label">
          <input
            type="checkbox"
            checked={needsCheck}
            onChange={(e) => setNeedsCheck(e.target.checked)}
          />
          {t("assessmentsView.sources.needsCheck")}
        </label>
      </div>
      {view.error ? (
        <Notice tone="red">{assessmentErrorMessage(view.error, t)}</Notice>
      ) : !view.data ? (
        <SkeletonRows label={t("assessmentsView.sources.loading")} rows={4} />
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
          {sources.length === 0 ? (
            <p className="muted">{t("assessmentsView.sources.allCurrent")}</p>
          ) : (
            <div
              className="table-wrap"
              tabIndex={0}
              role="region"
              aria-label={t("assessmentsView.sources.listLabel")}
            >
              <table className="data-table">
                <caption className="sr-only">
                  {t("assessmentsView.sources.listLabel")}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">
                      {t("assessmentsView.sources.col.source")}
                    </th>
                    <th scope="col">
                      {t("assessmentsView.sources.col.checked")}
                    </th>
                    <th scope="col">
                      {t("assessmentsView.sources.col.cited")}
                    </th>
                    <th scope="col">
                      {t("assessmentsView.sources.col.status")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((source) => (
                    <SourceRow key={source.id} source={source} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {sources.length > SOURCES_PAGE && (
            <Button className="cv-more" onClick={() => setAll(!all)}>
              {all
                ? t("assessmentsView.sources.fewer")
                : t("assessmentsView.sources.all", { count: sources.length })}
            </Button>
          )}
        </>
      )}
    </Card>
  );
}
const SOURCES_PAGE = 15;

function SourceRow({ source }: { source: Source }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const digest = DIGEST.exec(source.title)?.[0];
  const title = digest
    ? source.title
        .replace(DIGEST, "")
        .replace(/\s{2,}/g, " ")
        .trim() || source.host
    : source.title;
  return (
    <tr>
      <td>
        <a href={source.url} target="_blank" rel="noreferrer noopener">
          <bdi>{title}</bdi>
        </a>{" "}
        <span className="muted" dir="ltr">
          {source.host}
        </span>
        {digest && (
          <>
            {" "}
            <button
              type="button"
              className="cv-link-button"
              onClick={() =>
                void navigator.clipboard
                  ?.writeText(digest)
                  .then(() => setCopied(true))
              }
            >
              <Copy size={14} aria-hidden="true" />{" "}
              {copied
                ? t("assessmentsView.sources.copied")
                : t("assessmentsView.sources.copyDigest", {
                    short: digest.slice(0, 8),
                  })}
            </button>
          </>
        )}
      </td>
      <td>
        {source.reviewedAt === null
          ? t("assessmentsView.sources.noDate")
          : t("assessmentsView.sources.reviewed", {
              date: source.reviewedAt,
              days: source.ageDays ?? 0,
            })}
      </td>
      <td>
        {t("assessmentsView.sources.cited", {
          count: source.citedBy.blocks,
        })}
      </td>
      <td>
        <Badge tone={statusTone[source.status]}>
          {t(`assessmentsView.sources.status.${source.status}` as MessageKey)}
        </Badge>
      </td>
    </tr>
  );
}

/** The release picker and the test run: every test answer against this release, and recent runs. */
function TestRunCard({
  port,
  catalogId,
  releaseId,
  runs,
  titleOf,
  onRan,
  children,
}: {
  port: AssessmentAdminPort;
  catalogId: string;
  releaseId: string;
  runs: FixtureRuns["runs"];
  titleOf: (assessmentId: string) => string;
  onRan: (results: FixtureResult[]) => void;
  children: ReactNode;
}) {
  const t = useT();
  const { when } = useFormatters();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const [failures, setFailures] = useState<FixtureResult[]>();
  return (
    <Card
      title={t("assessmentsView.title")}
      actions={
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
                onRan(r.results);
              }, setError)
              .finally(() => setPending(false));
          }}
        >
          {t("assessmentsView.run.start")}
        </Button>
      }
    >
      <p className="muted">{t("assessmentsView.intro")}</p>
      <div className="cv-release">{children}</div>
      <p className="button-reason">{t("assessmentsView.run.body")}</p>
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
                  item: titleOf(f.assessmentId),
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
      {runs.length > 0 && (
        <details className="cv-tech">
          <summary>
            {t("assessmentsView.run.historyCount", { count: runs.length })}
          </summary>
          <div
            className="table-wrap"
            tabIndex={0}
            role="region"
            aria-label={t("assessmentsView.run.history")}
          >
            <table className="data-table">
              <caption className="sr-only">
                {t("assessmentsView.run.history")}
              </caption>
              <thead>
                <tr>
                  <th scope="col">{t("assessmentsView.run.when")}</th>
                  <th scope="col">{t("assessmentsView.run.by")}</th>
                  <th scope="col">{t("assessmentsView.run.version")}</th>
                  <th scope="col">{t("assessmentsView.run.result")}</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.runId}>
                    <td>{when(r.at)}</td>
                    <td>
                      <bdi>{r.by}</bdi>
                    </td>
                    <td>
                      <span dir="ltr">{r.releaseVersion}</span>
                    </td>
                    <td>
                      {t("assessmentsView.run.counts", {
                        passed: r.passed,
                        failed: r.failed,
                        notRunnable: r.notRunnable,
                      })}{" "}
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
        </details>
      )}
    </Card>
  );
}

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
/** A stored test answer in words: a choice's text, a number and its unit, a trace's steps. */
function answerText(item: AssessmentItem, answer: unknown): string {
  if (typeof answer === "string" || typeof answer === "number")
    return item.type === "choice"
      ? (item.options?.find((o) => o.id === answer)?.text ?? String(answer))
      : String(answer);
  if (answer && typeof answer === "object") {
    const record = answer as Record<string, unknown>;
    if ("value" in record)
      return `${String(record.value)} ${String(record.unit ?? "")}`.trim();
    if (item.type === "trace")
      return (item.steps ?? [])
        .map((s) => String(record[s.id] ?? "—"))
        .join(" → ");
  }
  return JSON.stringify(answer);
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
    <section className="stack" aria-label={t("assessmentsView.key.section")}>
      <h3 className="cv-subtitle">{t("assessmentsView.key.section")}</h3>
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
                />
              </Field>
            ))}
          <div className="wide">
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
              />
            </Field>
          </div>
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
            <div className="button-row">
              <Button
                kind="primary"
                type="submit"
                disabled={
                  pending || !checked || (impact!.result.failing > 0 && !accept)
                }
                reason={
                  checked
                    ? ""
                    : explanation.trim()
                      ? t("assessmentsView.key.checkFirst")
                      : t("assessmentsView.key.explainFirst")
                }
              >
                {t("assessmentsView.key.save")}
              </Button>
              <Button
                disabled={pending || !explanation.trim()}
                onClick={() => run(false)}
              >
                {t("assessmentsView.key.check")}
              </Button>
            </div>
          </div>
        </form>
      )}
    </section>
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
      <h3 className="cv-subtitle">
        {t("assessmentsView.fixtures.title", { count: fixtures.length })}
      </h3>
      <p className="muted">{t("assessmentsView.fixtures.hint")}</p>
      {fixtures.length > 0 && (
        <ul className="cv-list">
          {fixtures.map((f) => (
            <li key={f.fixtureId} className="cv-fixture">
              <span className="cv-fixture-text">
                <Badge tone={f.expected === "incorrect" ? "gold" : "green"}>
                  {t(
                    `assessmentsView.fixtures.expected.${f.expected}` as MessageKey,
                  )}
                </Badge>
                <span className="cv-fixture-answer" dir="auto">
                  {answerText(item, f.answer)}
                </span>
                {f.label && (
                  <small className="muted" dir="auto">
                    {f.label}
                  </small>
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
        className="input-grid cv-fixture-form"
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
              />
            </Field>
          </>
        )}
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
          />
        </Field>
        <fieldset className="wide segmented cv-segmented">
          <legend>{t("assessmentsView.fixtures.should")}</legend>
          {(["incorrect", "correct"] as const).map((v) => (
            <label key={v}>
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
            <Button
              kind="primary"
              type="submit"
              disabled={pending || !filled}
              reason={filled ? "" : t("assessmentsView.fixtures.fillFirst")}
            >
              {t("assessmentsView.fixtures.add")}
            </Button>
          </div>
        </div>
      </form>
    </section>
  );
}

/** A course rubric as one line; open it to see or edit its criteria. */
function RubricRow({
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
  const panel = useId();
  const [open, setOpen] = useState(false);
  return (
    <li>
      <button
        type="button"
        className="cv-row-summary"
        aria-expanded={open}
        aria-controls={panel}
        onClick={() => setOpen(!open)}
      >
        <span className="cv-row-title" dir="auto">
          {rubric.title}
        </span>
        <span className="cv-row-meta">
          {t("assessmentsView.rubric.eyebrow", {
            version: rubric.version,
            count: rubric.usedBy.length,
          })}
        </span>
        <ChevronDown size={18} aria-hidden="true" className="cv-row-chevron" />
      </button>
      {open && (
        <div id={panel} className="cv-row-panel">
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
        </div>
      )}
    </li>
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
        <div key={c.id} className="cv-criterion">
          <Field
            label={t("assessmentsView.rubric.criterion", { n: i + 1 })}
            htmlFor={`${id}-${c.id}`}
          >
            <textarea
              id={`${id}-${c.id}`}
              rows={2}
              value={c.description}
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
          reason={changed ? "" : t("assessmentsView.rubric.noChanges")}
        >
          {t("assessmentsView.rubric.save")}
        </Button>
      </div>
    </form>
  );
}
