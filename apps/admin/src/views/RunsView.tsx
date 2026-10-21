import { useState, type ReactNode } from "react";
import { FileText, ScanSearch } from "lucide-react";
import type { AdminClient, CourseWorkspace } from "../domain/contracts";
import { useRemote } from "../hooks/useAdmin";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Loading,
  Notice,
  Status,
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
  SyncPanel,
  WorkflowPanel,
} from "./RunInspectorPanels";

const strong = (children: ReactNode, key: string | number) => (
  <strong key={key}>{children}</strong>
);
/** A machine code shown through its catalog label, or as is when the catalog has none. */
function codeLabel(i18n: AdminTranslator, key: MessageKey, code: string) {
  return i18n.has(key) ? i18n.t(key) : code.replaceAll("_", " ");
}

export function RunsView({
  data,
  client,
}: {
  data: CourseWorkspace;
  client: AdminClient;
}) {
  const t = useT();
  const { when } = useFormatters();
  const [runId, setRunId] = useState(data.runs[0]?.id);
  return (
    <div className="page-stack">
      <div className="section-heading">
        <div>
          <h2>{t("runsView.heading")}</h2>
          <p>{t("runsView.intro")}</p>
        </div>
        <span className="large-icon">
          <ScanSearch size={28} aria-hidden="true" />
        </span>
      </div>
      <Notice tone="blue">{t("runsView.privacyNotice")}</Notice>
      {!data.permissions.includes("run.inspect") ? (
        <ErrorState error={new AdminError("permission_denied")} />
      ) : (
        <div className="master-detail">
          <Card title={t("runsView.list.title")}>
            <div className="selector-list">
              {data.runs.map((run) => (
                <button
                  className={`selector-item ${run.id === runId ? "selected" : ""}`}
                  key={run.id}
                  aria-pressed={run.id === runId}
                  onClick={() => setRunId(run.id)}
                >
                  <span>
                    <strong dir="auto">{run.label}</strong>
                    <small>{when(run.startedAt)}</small>
                    <Status value={run.status} />
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
  if (result.loading) return <Loading label={t("runsView.loading")} />;
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
    { id: "replay", label: t("runsView.view.replay") },
    { id: "retry", label: t("runsView.view.retry") },
    { id: "stop", label: t("runsView.view.stop") },
    { id: "payload", label: t("runsView.view.payload") },
  ] as const;
  return (
    <Card title={run.label} eyebrow={t("runsView.eyebrow")}>
      <div className="split-line">
        <Status value={run.status} />
        <small className="mono" dir="ltr">
          {run.id}
        </small>
      </div>
      <p dir="auto">{run.summary}</p>
      <div className="tag-row">
        <Badge>
          <span dir="ltr">{run.contextVersion}</span>
        </Badge>
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
          <Badge tone="blue">
            {t("runsView.retryOf", { run: run.retry.retryOf.slice(0, 8) })}
          </Badge>
        )}
        {run.retry?.retriedBy && (
          <Badge tone="blue">
            {run.retry.retriedBy.runId
              ? t("runsView.retriedAs", {
                  run: run.retry.retriedBy.runId.slice(0, 8),
                })
              : t("runsView.retried")}
          </Badge>
        )}
      </div>
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
                  <h3 dir="auto">{event.label}</h3>
                  <small className="mono" dir="ltr">
                    {event.time}
                  </small>
                </div>
                <Badge>{event.status}</Badge>
                <p dir="auto">{event.detail}</p>
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
          role={run.label.replace(/ run$/, "")}
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
          {run.context.map((item) => (
            <article className="record" key={item.id}>
              <div className="split-line">
                <h3 dir="auto">{item.label}</h3>
                <Badge tone="blue">
                  <span dir="ltr">{item.version}</span>
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
                  <dd dir="auto">{item.source}</dd>
                </div>
                <div>
                  <dt>{t("runsView.context.visibility")}</dt>
                  <dd dir="auto">{item.visibility}</dd>
                </div>
              </dl>
            </article>
          ))}
        </div>
      )}
      {view === "decisions" && (
        <div className="stack">
          {run.decisions.map((decision) => (
            <article className="record" key={decision.id}>
              <div className="split-line">
                <h3 dir="ltr">{decision.tool}</h3>
                <Status value={decision.outcome} />
              </div>
              <p className="mono reason-code" dir="ltr">
                {decision.reasonCode}
              </p>
              <p dir="auto">{decision.explanation}</p>
              <dl className="facts vertical">
                <div>
                  <dt>{t("runsView.decision.inputSummary")}</dt>
                  <dd dir="auto">{decision.inputSummary}</dd>
                </div>
                <div>
                  <dt>{t("runsView.decision.unitsCharged")}</dt>
                  <dd>{i18n.number(decision.budgetUnits)}</dd>
                </div>
              </dl>
            </article>
          ))}
          {!!run.hypothesisChanges?.length && (
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
                    <td className="mono" dir="ltr">
                      {c.templateId ?? c.hypothesisId}
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
                  <Status
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
                <table className="data-table">
                  <caption>{t("runsView.attempts.caption")}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{t("runsView.attempts.attempt")}</th>
                      <th scope="col">{t("runsView.attempts.http")}</th>
                      <th scope="col">{t("runsView.attempts.outcome")}</th>
                      <th scope="col">{t("runsView.attempts.tokens")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {call.attempts.map((a, i) => (
                      <tr key={i}>
                        <td>{a.attempt ?? i + 1}</td>
                        <td>{a.status ?? "—"}</td>
                        <td dir="ltr">{a.outcome ?? "—"}</td>
                        <td dir="ltr">
                          {a.tokens.input ?? "?"} / {a.tokens.output ?? "?"} /{" "}
                          {a.tokens.total ?? "?"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
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
                    <bdi>{artifact.name}</bdi>
                  </h3>
                  <Status value={artifact.status} />
                </div>
                <small dir="auto">{artifact.provenance}</small>
                <pre
                  dir="auto"
                  aria-label={t("runsView.artifact.previewLabel", {
                    name: artifact.name,
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
    <Card title={t("runsView.replayRecent.title")}>
      <p>{t("runsView.replayRecent.intro")}</p>
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
