import { useId, useState, type ReactNode } from "react";
import { FileText } from "lucide-react";
import type { AdminClient, CourseWorkspace } from "../domain/contracts";
import { useRemote } from "../hooks/useAdmin";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Notice,
  TechnicalDetails,
  SkeletonRows,
  PageIntro,
  When,
} from "../components/ui";
import {
  useFormatters,
  useI18n,
  useT,
  type AdminTranslator,
  type MessageKey,
} from "../i18n";
import { AdminError } from "../domain/errors";
import {
  runInspectorErrorMessage,
  type ReplayBatch,
  type RunInspectorPort,
} from "../domain/runInspector";
import type { Permission } from "../domain/contracts";
import {
  CancelPanel,
  PayloadPanel,
  PoliciesPanel,
  ReplayPanel,
  RetryPanel,
  RunStatus,
  SyncPanel,
  WorkflowPanel,
} from "./RunInspectorPanels";
import {
  artifactName,
  contextText,
  decisionText,
  roleName,
  runName,
  runOutcomeSentences,
} from "../domain/runText";
import { sentenceCase } from "./contentShared";

const strong = (children: ReactNode, key: string | number) => (
  <strong key={key}>{children}</strong>
);
/** A machine code shown through its catalog label, or as is when the catalog has none. */
function codeLabel(i18n: AdminTranslator, key: MessageKey, code: string) {
  return i18n.has(key) ? i18n.t(key) : code.replaceAll("_", " ");
}

/** A learning event as the server names it ("session.ended"), in words; older servers and the
 * demo send words already. */
function eventLabel(i18n: AdminTranslator, label: string) {
  if (!/^[a-z0-9_]+(\.[a-z0-9_]+)+$/.test(label)) return label;
  const key =
    `supervisionView.eventType.${label.replaceAll(".", "_")}` as MessageKey;
  // Workspace events the audit log names (a learner run can carry some of them).
  const audit = `auditView.event.${label}` as MessageKey;
  return i18n.has(key)
    ? i18n.t(key)
    : i18n.has(audit)
      ? i18n.t(audit)
      : i18n.t("runsView.event.other", {
          name: sentenceCase(label.replace(/[._]+/g, " ")),
        });
}
/** An event time: an ISO timestamp as a date and time; an older server's clock time as is. */
function eventTime(time: string) {
  return /^\d{4}-\d{2}-\d{2}T/.test(time) && !Number.isNaN(Date.parse(time)) ? (
    <When iso={time} exact />
  ) : (
    time
  );
}

export function RunsView({
  data,
  client,
}: {
  data: CourseWorkspace;
  client: AdminClient;
}) {
  const t = useT();
  const i18n = useI18n();
  const { when } = useFormatters();
  const [runId, setRunId] = useState(data.runs[0]?.id);
  const pickerId = useId();
  return (
    <div className="page-stack">
      <PageIntro>{t("runsView.intro")}</PageIntro>
      <Notice tone="blue">{t("runsView.privacyNotice")}</Notice>
      {!data.permissions.includes("run.inspect") ? (
        <ErrorState error={new AdminError("permission_denied")} />
      ) : (
        // Two columns: the runs, and everything about the chosen run. Below 850px they stack and
        // the list becomes a picker, so the detail is never thousands of pixels down.
        <div className="master-detail cv-runs">
          <Card
            title={t("runsView.list.title")}
            className="cv-runs-list"
            actions={
              data.runs.length > 0 && (
                <span className="cv-count">
                  {t("runsView.list.count", { count: data.runs.length })}
                </span>
              )
            }
          >
            {data.runs.length > 0 && (
              <div className="field cv-runs-picker">
                <label htmlFor={pickerId}>{t("runsView.list.pick")}</label>
                <select
                  id={pickerId}
                  value={runId}
                  onChange={(e) => setRunId(e.target.value)}
                >
                  {data.runs.map((run) => (
                    <option key={run.id} value={run.id}>
                      {t("runsView.list.option", {
                        run: runName(i18n, run),
                        when: when(run.startedAt),
                        status: codeLabel(
                          i18n,
                          `runsView.status.${run.status}` as MessageKey,
                          run.status,
                        ),
                      })}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="selector-list cv-runs-buttons">
              {data.runs.map((run) => (
                <button
                  className={`selector-item ${run.id === runId ? "selected" : ""}`}
                  key={run.id}
                  aria-pressed={run.id === runId}
                  onClick={() => setRunId(run.id)}
                >
                  <span>
                    <strong dir="auto">{runName(i18n, run)}</strong>
                    <small>
                      <When iso={run.startedAt} />
                    </small>
                    <RunStatus value={run.status} />
                  </span>
                </button>
              ))}
            </div>
            {!data.runs.length && (
              <EmptyState title={t("runsView.list.empty.title")}>
                {t("runsView.list.empty.body")}
              </EmptyState>
            )}
          </Card>
          <div className="stack cv-runs-detail">
            {client.runInspector?.replayRecent && (
              <ReplayRecent
                port={client.runInspector}
                courseId={data.course.id}
              />
            )}
            {runId && (
              <RunDetails
                key={runId}
                courseId={data.course.id}
                runId={runId}
                client={client}
                permissions={data.permissions}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
/** One run's inspector. Also opened beside the read-only learner view. */
export function RunDetails({
  courseId,
  runId,
  client,
  permissions,
}: {
  courseId: string;
  runId: string;
  client: AdminClient;
  permissions: readonly Permission[];
}) {
  const t = useT();
  const i18n = useI18n();
  const { when } = useFormatters();
  const result = useRemote(
    (signal) => client.getRun(courseId, runId, signal),
    [client, courseId, runId],
  );
  const [view, setView] = useState<
    | "timeline"
    | "workflow"
    | "context"
    | "decisions"
    | "calls"
    | "policies"
    | "sync"
    | "artifacts"
    | "replay"
    | "retry"
    | "stop"
    | "payload"
  >("timeline");
  if (result.loading)
    return <SkeletonRows label={t("runsView.loading")} rows={6} />;
  if (result.error)
    return <ErrorState error={result.error} onRetry={result.reload} />;
  const run = result.data!;
  const views = [
    { id: "timeline", label: t("runsView.view.timeline") },
    { id: "workflow", label: t("runsView.view.workflow") },
    { id: "context", label: t("runsView.view.context") },
    { id: "decisions", label: t("runsView.view.decisions") },
    { id: "calls", label: t("runsView.view.calls") },
    { id: "policies", label: t("runsView.view.policies") },
    { id: "sync", label: t("runsView.view.sync") },
    { id: "artifacts", label: t("runsView.view.artifacts") },
    { id: "payload", label: t("runsView.view.payload") },
  ] as const;
  // Replay, retry and stop act on the run; they open their panel from the card's header.
  const actions = [
    { id: "replay", label: t("runsView.view.replay") },
    { id: "retry", label: t("runsView.view.retry") },
    { id: "stop", label: t("runsView.view.stop") },
  ] as const;
  // The server words a run's outcome; the line about what the inspector withholds is said once,
  // at the top of the page.
  const metadataOnly = i18n.t("runText.outcome.metadataOnly");
  const sentences = runOutcomeSentences(i18n, run).filter(
    (sentence) => sentence !== metadataOnly,
  );
  return (
    <Card
      title={runName(i18n, run)}
      // An older server's (or the demo's) English label is data, in its own direction.
      titleDir={run.role ? undefined : "auto"}
      eyebrow={t("runsView.eyebrow")}
      actions={
        <div className="cv-actions" aria-label={t("runsView.actionsNav")}>
          {actions.map((item) => (
            <Button
              key={item.id}
              onClick={() => setView(view === item.id ? "timeline" : item.id)}
              aria-pressed={view === item.id}
              kind={view === item.id ? "primary" : "secondary"}
            >
              {item.label}
            </Button>
          ))}
        </div>
      }
    >
      <div className="tag-row">
        <RunStatus value={run.status} />
        <small className="muted">
          {t("runsView.started", { when: when(run.startedAt) })}
        </small>
      </div>
      {sentences.length > 0 && (
        <p>
          {sentences.map((sentence, index) => (
            <span key={index} dir="auto">
              {index > 0 && " "}
              {sentence}
            </span>
          ))}
        </p>
      )}
      <div className="tag-row">
        <Badge>{t("runsView.toolCalls", { count: run.toolCalls })}</Badge>
        {run.providerAttempts !== undefined && (
          <Badge>
            {run.providerAttempts === null
              ? t("runsView.providerAttempts.unavailable")
              : t("runsView.providerAttempts", {
                  count: run.providerAttempts,
                })}
          </Badge>
        )}
        <Badge>{t("runsView.artifacts", { count: run.artifactCount })}</Badge>
        {run.retry?.retryOf && (
          <Badge tone="blue">{t("runsView.retryOfRun")}</Badge>
        )}
        {run.retry?.retriedBy && (
          <Badge tone="blue">{t("runsView.retried")}</Badge>
        )}
      </div>
      <TechnicalDetails>
        <dl>
          <dt>{t("runsView.technical.runId")}</dt>
          <dd className="mono" dir="ltr">
            {run.id}
          </dd>
          <dt>{t("runsView.technical.context")}</dt>
          <dd className="mono" dir="ltr">
            {run.contextVersion}
          </dd>
          {run.retry?.retryOf && (
            <>
              <dt>{t("runsView.technical.retryOf")}</dt>
              <dd className="mono" dir="ltr">
                {run.retry.retryOf}
              </dd>
            </>
          )}
          {run.retry?.retriedBy?.runId && (
            <>
              <dt>{t("runsView.technical.retriedAs")}</dt>
              <dd className="mono" dir="ltr">
                {run.retry.retriedBy.runId}
              </dd>
            </>
          )}
        </dl>
      </TechnicalDetails>
      <nav aria-label={t("runsView.viewsNav")} className="segmented">
        {views.map((item) => (
          <Button
            key={item.id}
            onClick={() => setView(item.id)}
            aria-pressed={view === item.id}
            kind={view === item.id ? "primary" : "quiet"}
          >
            {item.label}
          </Button>
        ))}
      </nav>
      {view === "timeline" && (
        <ol className="timeline">
          {run.events.map((event) => (
            <li key={event.id}>
              <span className="timeline-dot" />
              <div>
                <div className="split-line">
                  <h3 dir="auto" title={event.label}>
                    {eventLabel(i18n, event.label)}
                  </h3>
                  <small>{eventTime(event.time)}</small>
                </div>
                {event.status !== "recorded" && (
                  <Badge>
                    <span dir="auto">{event.status}</span>
                  </Badge>
                )}
                {event.detail && <p dir="auto">{event.detail}</p>}
              </div>
            </li>
          ))}
        </ol>
      )}
      {view === "workflow" && <WorkflowPanel workflow={run.workflow} />}
      {view === "policies" && <PoliciesPanel run={run} />}
      {view === "sync" && <SyncPanel run={run} />}
      {view === "replay" && (
        <ReplayPanel
          port={client.runInspector}
          courseId={courseId}
          runId={runId}
        />
      )}
      {view === "retry" && (
        <RetryPanel
          port={client.runInspector}
          courseId={courseId}
          runId={runId}
          status={run.status}
          role={
            run.role
              ? roleName(i18n, run.role)
              : (run.label ?? "").replace(/ run$/, "")
          }
          links={run.retry}
          allowed={permissions.includes("run.retry")}
        />
      )}
      {view === "stop" && (
        <CancelPanel
          port={client.runInspector}
          courseId={courseId}
          runId={runId}
          status={run.status}
          cancelRequested={run.sync?.run.cancellationRequested ?? false}
          allowed={permissions.includes("supervision.control")}
        />
      )}
      {view === "payload" && (
        <PayloadPanel
          port={client.runInspector}
          courseId={courseId}
          runId={runId}
          allowed={permissions.includes("run.payload")}
        />
      )}
      {view === "context" && (
        <div className="stack">
          {run.context.map((item) => {
            const text = contextText(i18n, item);
            return (
              <article className="record" key={item.id}>
                <div className="split-line">
                  <h3 dir="auto">{text.label}</h3>
                  <Badge tone="blue">
                    <span dir="auto">{text.version}</span>
                  </Badge>
                </div>
                <dl className="facts vertical">
                  <div>
                    <dt>{t("runsView.context.reference")}</dt>
                    <dd className="mono" dir="ltr">
                      {item.id}
                    </dd>
                  </div>
                  <div>
                    <dt>{t("runsView.context.source")}</dt>
                    <dd dir="auto">{text.source}</dd>
                  </div>
                  <div>
                    <dt>{t("runsView.context.visibility")}</dt>
                    <dd dir="auto">{text.visibility}</dd>
                  </div>
                </dl>
              </article>
            );
          })}
        </div>
      )}
      {view === "decisions" && (
        <div className="stack">
          {run.decisions.map((decision) => (
            <article className="record" key={decision.id}>
              <div className="split-line">
                <h3 dir="ltr">{decision.tool}</h3>
                <RunStatus value={decision.outcome} />
              </div>
              <p className="mono reason-code" dir="ltr">
                {decision.reasonCode}
              </p>
              <p dir="auto">{decisionText(i18n, decision.explanation)}</p>
              <dl className="facts vertical">
                <div>
                  <dt>{t("runsView.decision.inputSummary")}</dt>
                  <dd dir="auto">
                    {decisionText(i18n, decision.inputSummary)}
                  </dd>
                </div>
                <div>
                  <dt>{t("runsView.decision.unitsCharged")}</dt>
                  <dd>{i18n.number(decision.budgetUnits)}</dd>
                </div>
              </dl>
            </article>
          ))}
          {!!run.hypothesisChanges?.length && (
            <div className="table-wrap">
              <table className="data-table">
                <caption>{t("runsView.hypotheses.caption")}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t("runsView.hypotheses.hypothesis")}</th>
                    <th scope="col">{t("runsView.hypotheses.change")}</th>
                    <th scope="col">{t("runsView.hypotheses.state")}</th>
                  </tr>
                </thead>
                <tbody>
                  {run.hypothesisChanges.map((c, i) => (
                    <tr key={i}>
                      <td
                        className="mono cell-truncate"
                        title={c.templateId ?? c.hypothesisId}
                      >
                        <span dir="ltr">{c.templateId ?? c.hypothesisId}</span>
                      </td>
                      <td>
                        {codeLabel(
                          i18n,
                          `runsView.hypotheses.action.${c.action}` as MessageKey,
                          c.action,
                        )}{" "}
                        ·{" "}
                        {t("runsView.hypotheses.revision", {
                          revision: c.revision,
                        })}
                      </td>
                      <td>
                        {codeLabel(
                          i18n,
                          `runsView.hypotheses.kind.${c.kind}` as MessageKey,
                          c.kind,
                        )}{" "}
                        ·{" "}
                        {codeLabel(
                          i18n,
                          `runsView.hypotheses.status.${c.status}` as MessageKey,
                          c.status,
                        )}
                        {c.pinnedByLearner &&
                          ` · ${t("runsView.hypotheses.pinnedByLearner")}`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
      {view === "calls" && (
        <div className="stack">
          {run.verification && (
            <p>
              {run.verification.applied
                ? i18n.rich(
                    "runsView.verification.applied",
                    {
                      verifier: run.verification.verifier,
                      verdict: run.verification.verdict,
                      kind: run.verification.applied.kind,
                    },
                    { strong },
                  )
                : i18n.rich(
                    "runsView.verification.notApplied",
                    {
                      verifier: run.verification.verifier,
                      verdict: run.verification.verdict,
                    },
                    { strong },
                  )}
            </p>
          )}
          {run.providerCalls?.length ? (
            run.providerCalls.map((call) => (
              <article className="record" key={call.operationId}>
                <div className="split-line">
                  {call.modelId ? (
                    <h3 dir="ltr">{call.modelId}</h3>
                  ) : (
                    <h3>{t("runsView.calls.unknownModel")}</h3>
                  )}
                  <RunStatus
                    value={
                      call.state === "completed"
                        ? "completed"
                        : call.state === "in_flight"
                          ? "running"
                          : "failed"
                    }
                  />
                </div>
                {call.failureCode && (
                  <p className="mono reason-code" dir="ltr">
                    {call.failureCode}
                  </p>
                )}
                <dl className="facts vertical">
                  <div>
                    <dt>{t("runsView.calls.providerOperation")}</dt>
                    <dd dir="ltr">
                      {call.providerId ?? "—"} · {call.operation ?? "—"}
                    </dd>
                  </div>
                  <div>
                    <dt>{t("runsView.calls.inputCharacters")}</dt>
                    <dd>
                      {call.inputCharacters === null
                        ? "—"
                        : i18n.number(call.inputCharacters)}
                    </dd>
                  </div>
                  <div>
                    <dt>{t("runsView.calls.duration")}</dt>
                    <dd>
                      {call.durationMs === null
                        ? "—"
                        : t("runsView.calls.durationMs", {
                            ms: call.durationMs,
                          })}
                    </dd>
                  </div>
                </dl>
                <div className="table-wrap">
                  <table className="data-table">
                    <caption>{t("runsView.attempts.caption")}</caption>
                    <thead>
                      <tr>
                        <th scope="col" className="num">
                          {t("runsView.attempts.attempt")}
                        </th>
                        <th scope="col">{t("runsView.attempts.http")}</th>
                        <th scope="col">{t("runsView.attempts.outcome")}</th>
                        <th scope="col" className="num">
                          {t("runsView.attempts.tokens")}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {call.attempts.map((a, i) => (
                        <tr key={i}>
                          <td className="num">{a.attempt ?? i + 1}</td>
                          <td>{a.status ?? "—"}</td>
                          <td>
                            <span dir="ltr">{a.outcome ?? "—"}</span>
                          </td>
                          <td className="num">
                            <span dir="ltr">
                              {a.tokens.input ?? "?"} / {a.tokens.output ?? "?"}{" "}
                              / {a.tokens.total ?? "?"}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <small>{t("runsView.calls.privacy")}</small>
              </article>
            ))
          ) : (
            <EmptyState title={t("runsView.calls.empty.title")}>
              {t("runsView.calls.empty.body")}
            </EmptyState>
          )}
        </div>
      )}
      {view === "artifacts" && (
        <div className="stack">
          {run.artifacts.length ? (
            run.artifacts.map((artifact) => (
              <article className="record" key={artifact.id}>
                <div className="split-line">
                  <h3>
                    <FileText size={18} aria-hidden="true" />{" "}
                    <bdi>{artifactName(i18n, artifact)}</bdi>
                  </h3>
                  <RunStatus value={artifact.status} />
                </div>
                <small dir="auto">
                  {artifact.provenance ?? t("runText.artifact.provenance")}
                </small>
                <pre
                  dir="auto"
                  aria-label={t("runsView.artifact.previewLabel", {
                    name: artifactName(i18n, artifact),
                  })}
                >
                  {artifact.preview}
                </pre>
                <small>
                  {t("runsView.artifact.inert", {
                    mediaType: artifact.mediaType,
                  })}
                </small>
              </article>
            ))
          ) : (
            <EmptyState title={t("runsView.artifact.empty.title")}>
              {t("runsView.artifact.empty.body")}
            </EmptyState>
          )}
        </div>
      )}
    </Card>
  );
}

/** Replays the course's latest finished runs in one go, read-only, to see whether today's rules
 * still produce the plans they recorded (for example after an upgrade). */
function ReplayRecent({
  port,
  courseId,
}: {
  port: RunInspectorPort;
  courseId: string;
}) {
  const t = useT();
  const [state, setState] = useState<{
    pending: boolean;
    result?: ReplayBatch;
    error?: unknown;
  }>({ pending: false });
  return (
    <Card
      title={t("runsView.replayRecent.title")}
      className="cv-replay"
      actions={
        <Button
          disabled={state.pending}
          onClick={() => {
            setState({ pending: true });
            port.replayRecent!(courseId, 10).then(
              (result) => setState({ pending: false, result }),
              (error: unknown) => setState({ pending: false, error }),
            );
          }}
        >
          {state.pending
            ? t("runsView.replayRecent.pending")
            : t("runsView.replayRecent.submit")}
        </Button>
      }
    >
      <p className="muted">{t("runsView.replayRecent.intro")}</p>
      <div aria-live="polite">
        {state.error !== undefined && (
          <Notice tone="red">{runInspectorErrorMessage(state.error, t)}</Notice>
        )}
        {state.result && (
          <Notice tone={state.result.summary.diverged ? "gold" : "green"}>
            {state.result.runs.length === 0
              ? t("runsView.replayRecent.none")
              : t("runsView.replayRecent.summary", {
                  matches: state.result.summary.matches,
                  diverged: state.result.summary.diverged,
                  notReplayable: state.result.summary.notReplayable,
                })}
          </Notice>
        )}
      </div>
    </Card>
  );
}
