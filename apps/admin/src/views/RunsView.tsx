import { useState } from "react";
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
  when,
} from "../components/ui";
import { AdminError } from "../domain/errors";

export function RunsView({
  data,
  client,
}: {
  data: CourseWorkspace;
  client: AdminClient;
}) {
  const [runId, setRunId] = useState(data.runs[0]?.id);
  return (
    <div className="page-stack">
      <div className="section-heading">
        <div>
          <h2>Follow the work, not a black box.</h2>
          <p>
            Inspectable inputs, context references, tool decisions and
            reviewable outputs.
          </p>
        </div>
        <span className="large-icon">
          <ScanSearch size={28} aria-hidden="true" />
        </span>
      </div>
      <Notice tone="blue">
        This inspector shows operational records and concise decision
        explanations. Private model reasoning and hidden chain-of-thought are
        not requested or displayed.
      </Notice>
      {!data.permissions.includes("run.inspect") ? (
        <ErrorState error={new AdminError("permission_denied")} />
      ) : (
        <div className="master-detail">
          <Card title="Supervisor runs">
            <div className="selector-list">
              {data.runs.map((run) => (
                <button
                  className={`selector-item ${run.id === runId ? "selected" : ""}`}
                  key={run.id}
                  aria-pressed={run.id === runId}
                  onClick={() => setRunId(run.id)}
                >
                  <span>
                    <strong>{run.label}</strong>
                    <small>{when(run.startedAt)}</small>
                    <Status value={run.status} />
                  </span>
                </button>
              ))}
            </div>
            {!data.runs.length && (
              <EmptyState title="No runs recorded">
                Operational records will appear after the server creates a run.
              </EmptyState>
            )}
          </Card>
          {runId && (
            <RunDetails
              key={runId}
              courseId={data.course.id}
              runId={runId}
              client={client}
            />
          )}
        </div>
      )}
    </div>
  );
}
function RunDetails({
  courseId,
  runId,
  client,
}: {
  courseId: string;
  runId: string;
  client: AdminClient;
}) {
  const result = useRemote(
    (signal) => client.getRun(courseId, runId, signal),
    [client, courseId, runId],
  );
  const [view, setView] = useState<
    "timeline" | "context" | "decisions" | "artifacts"
  >("timeline");
  if (result.loading) return <Loading label="Loading run records…" />;
  if (result.error)
    return <ErrorState error={result.error} onRetry={result.reload} />;
  const run = result.data!;
  const views = [
    { id: "timeline", label: "Timeline" },
    { id: "context", label: "Context" },
    { id: "decisions", label: "Tool decisions" },
    { id: "artifacts", label: "Artifacts" },
  ] as const;
  return (
    <Card title={run.label} eyebrow="Run inspector">
      <div className="split-line">
        <Status value={run.status} />
        <small className="mono">{run.id}</small>
      </div>
      <p>{run.summary}</p>
      <div className="tag-row">
        <Badge>{run.contextVersion}</Badge>
        <Badge>{run.toolCalls} executed tool calls</Badge>
        <Badge>{run.artifactCount} artifacts</Badge>
      </div>
      <nav aria-label="Run record views" className="segmented">
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
                  <h3>{event.label}</h3>
                  <small className="mono">{event.time}</small>
                </div>
                <Badge>{event.status}</Badge>
                <p>{event.detail}</p>
              </div>
            </li>
          ))}
        </ol>
      )}
      {view === "context" && (
        <div className="stack">
          {run.context.map((item) => (
            <article className="record" key={item.id}>
              <div className="split-line">
                <h3>{item.label}</h3>
                <Badge tone="blue">{item.version}</Badge>
              </div>
              <dl className="facts vertical">
                <div>
                  <dt>Reference</dt>
                  <dd className="mono">{item.id}</dd>
                </div>
                <div>
                  <dt>Source</dt>
                  <dd>{item.source}</dd>
                </div>
                <div>
                  <dt>Visibility</dt>
                  <dd>{item.visibility}</dd>
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
                <h3>{decision.tool}</h3>
                <Status value={decision.outcome} />
              </div>
              <p className="mono reason-code">{decision.reasonCode}</p>
              <p>{decision.explanation}</p>
              <dl className="facts vertical">
                <div>
                  <dt>Input summary</dt>
                  <dd>{decision.inputSummary}</dd>
                </div>
                <div>
                  <dt>Units charged</dt>
                  <dd>{decision.budgetUnits}</dd>
                </div>
              </dl>
            </article>
          ))}
        </div>
      )}
      {view === "artifacts" && (
        <div className="stack">
          {run.artifacts.length ? (
            run.artifacts.map((artifact) => (
              <article className="record" key={artifact.id}>
                <div className="split-line">
                  <h3>
                    <FileText size={18} aria-hidden="true" /> {artifact.name}
                  </h3>
                  <Status value={artifact.status} />
                </div>
                <small>{artifact.provenance}</small>
                <pre aria-label={`${artifact.name} plain text preview`}>
                  {artifact.preview}
                </pre>
                <small>
                  {artifact.mediaType} · Displayed as inert text. No artifact
                  code is executed.
                </small>
              </article>
            ))
          ) : (
            <EmptyState title="No artifacts">
              This run produced no reviewable artifacts.
            </EmptyState>
          )}
        </div>
      )}
    </Card>
  );
}
