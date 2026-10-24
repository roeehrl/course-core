import { useId, useRef, useState, type ReactNode } from "react";
import { privacyRuleText } from "../domain/privacyRules";
import "../components/inspector.css";
import type { SupervisorRun } from "../domain/contracts";
import {
  PAYLOAD_REASONS,
  payloadReasonLabel,
  runInspectorErrorMessage,
  type PayloadReason,
  type PayloadReveal,
  type CancelResult,
  type RetryLinks,
  type RetryResult,
  type RunInspectorPort,
  type RunReplay,
  type RunWorkflow,
} from "../domain/runInspector";
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Notice,
  Status,
} from "../components/ui";
import { randomId } from "../domain/webCrypto";
import { useFormatters, useI18n, useT, type MessageKey } from "../i18n";

/** A run, step, decision or artifact state through its catalog label; an unknown code as is. */
export function RunStatus({ value }: { value: string }) {
  const i18n = useI18n();
  const key = `runsView.status.${value}` as MessageKey;
  return (
    <Status
      value={value}
      label={i18n.has(key) ? i18n.t(key) : value.replaceAll("_", " ")}
    />
  );
}

type Amount = { microUsd: number | null; tokens: number | null };
/** Amounts in the active locale; "—" where the server reports none. */
function useAmounts() {
  const i18n = useI18n();
  const show = (value: number | null | undefined) =>
    value === null || value === undefined ? "—" : i18n.number(value);
  const pair = (value: Amount | null | undefined) =>
    value
      ? i18n.t("runInspectorPanels.amount", {
          microUsd: show(value.microUsd),
          tokens: show(value.tokens),
        })
      : "—";
  return { pair };
}
/** Identifiers inside a translated sentence stay left to right. */
const mono = (children: ReactNode[], key: string) => (
  <span className="mono" dir="ltr" key={key}>
    {children}
  </span>
);

/** The run as a tree: input event → run → checkpoints → attempts → tool calls and artifacts → verification → application. */
export function WorkflowPanel({
  workflow,
}: {
  workflow: RunWorkflow | undefined;
}) {
  const i18n = useI18n();
  const t = i18n.t;
  if (!workflow)
    return (
      <EmptyState title={t("runInspectorPanels.workflow.empty.title")}>
        {t("runInspectorPanels.workflow.empty.body")}
      </EmptyState>
    );
  const children = (parentId: string | null) =>
    workflow.nodes.filter((n) => n.parentId === parentId);
  /** A node in the reader's language from its facts; an older server's English label otherwise. */
  const nodeLabel = (node: RunWorkflow["nodes"][number]) => {
    if (!node.facts) return node.label ?? node.id;
    const facts = node.facts;
    const role = String(facts.role ?? "");
    const roleKey = `aiServices.role.${role}.name` as MessageKey;
    return t(`runInspectorPanels.node.${node.kind}` as MessageKey, {
      ...facts,
      role: role && i18n.has(roleKey) ? t(roleKey) : role,
      phase: facts.phase ?? "none",
      providerState: facts.providerState ?? "none",
      artifactKind: facts.artifactKind ?? "none",
    });
  };
  const render = (parentId: string | null, depth: number): ReactNode => {
    const nodes = children(parentId);
    if (!nodes.length) return null;
    return (
      <ol className={depth ? "workflow-graph nested" : "workflow-graph"}>
        {nodes.map((node) => (
          <li key={node.id} className={`workflow-node kind-${node.kind}`}>
            <div className="split-line">
              <span>
                <small className="eyebrow">
                  {t(
                    `runInspectorPanels.workflow.kind.${node.kind}` as MessageKey,
                  )}
                </small>
                <strong dir="auto">{nodeLabel(node)}</strong>
              </span>
              <RunStatus value={node.status} />
            </div>
            {render(node.id, depth + 1)}
          </li>
        ))}
      </ol>
    );
  };
  return (
    <div className="stack">
      <p>
        {workflow.generation !== null
          ? i18n.rich(
              "runInspectorPanels.workflow.idGeneration",
              { id: workflow.workflowId, generation: workflow.generation },
              { mono },
            )
          : i18n.rich(
              "runInspectorPanels.workflow.id",
              { id: workflow.workflowId },
              { mono },
            )}
      </p>
      <nav aria-label={t("runInspectorPanels.workflow.nav")}>
        {render(null, 0)}
      </nav>
      {workflow.truncated && (
        <Notice tone="gold">
          {t("runInspectorPanels.workflow.truncated")}
        </Notice>
      )}
    </div>
  );
}

type StrategyRow = NonNullable<
  NonNullable<SupervisorRun["policies"]>["strategies"]
>[number];
/** Which AI setup answered each call, and whether that exact setup was checked or approved. */
function StrategiesUsed({ strategies }: { strategies: StrategyRow[] }) {
  const t = useT();
  if (!strategies.length)
    return <p className="muted">{t("runInspectorPanels.strategies.none")}</p>;
  const unchecked = strategies.some(
    (s) => s.evalStanding === "not_checked" || s.evalStanding === "unknown",
  );
  return (
    <section aria-labelledby="run-strategies" className="stack">
      <h4 id="run-strategies">{t("runInspectorPanels.strategies.title")}</h4>
      {unchecked && (
        <Notice tone="gold">
          {t("runInspectorPanels.strategies.unchecked")}
        </Notice>
      )}
      <ul className="plain-list">
        {strategies.map((s) => (
          <li key={s.operationId}>
            {t(`runInspectorPanels.strategies.source.${s.source}`, {
              strategy: s.strategyId,
              version: s.version ?? "—",
            })}{" "}
            <Badge
              tone={
                s.evalStanding === "passed"
                  ? "green"
                  : s.evalStanding === "approved"
                    ? "blue"
                    : "gold"
              }
            >
              {t(`runInspectorPanels.strategies.standing.${s.evalStanding}`)}
            </Badge>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function PoliciesPanel({ run }: { run: SupervisorRun }) {
  const t = useT();
  const { when } = useFormatters();
  const { pair } = useAmounts();
  const p = run.policies;
  if (!p)
    return (
      <EmptyState title={t("runInspectorPanels.policies.empty.title")}>
        {t("runInspectorPanels.policies.empty.body")}
      </EmptyState>
    );
  const drift =
    p.fence &&
    p.fence.enrollmentRevisionNow !== null &&
    p.fence.enrollmentRevisionNow !== p.fence.enrollmentRevision;
  return (
    <div className="stack">
      <Notice tone="blue">{t("runInspectorPanels.policies.estimates")}</Notice>
      <dl className="facts vertical">
        <div>
          <dt>{t("runInspectorPanels.policies.fence")}</dt>
          <dd>
            {p.fence
              ? t("runInspectorPanels.policies.fenceValue", {
                  enrollment: p.fence.enrollmentRevision,
                  profile: p.fence.profileRevision,
                  policy: p.fence.policyRevision,
                  ledger: p.fence.ledgerRevision,
                })
              : t("runInspectorPanels.unavailable")}
          </dd>
        </div>
        <div>
          <dt>{t("runInspectorPanels.policies.enrollmentNow")}</dt>
          <dd>
            {p.fence?.enrollmentRevisionNow !== null &&
            p.fence?.enrollmentRevisionNow !== undefined
              ? t("runInspectorPanels.revision", {
                  revision: p.fence.enrollmentRevisionNow,
                })
              : "—"}
            {drift && (
              <>
                {" "}
                <Badge tone="gold">
                  {t("runInspectorPanels.policies.changedSinceRun")}
                </Badge>
              </>
            )}
          </dd>
        </div>
        <div>
          <dt>{t("runInspectorPanels.policies.courseDigest")}</dt>
          <dd className="mono" dir="ltr">
            {p.fence?.courseDigest ?? "—"}
          </dd>
        </div>
        <div>
          <dt>{t("runInspectorPanels.policies.deadline")}</dt>
          <dd>{p.deadline ? when(p.deadline) : "—"}</dd>
        </div>
        <div>
          <dt>{t("runInspectorPanels.policies.runBudget")}</dt>
          <dd>{pair(p.jobBudget)}</dd>
        </div>
        <div>
          <dt>{t("runInspectorPanels.policies.charged")}</dt>
          <dd>{pair(p.charged)}</dd>
        </div>
        <div>
          <dt>{t("runInspectorPanels.policies.providerConfiguration")}</dt>
          <dd>
            {p.providerSource ? (
              t(
                `runInspectorPanels.policies.providerSource.${p.providerSource}`,
              )
            ) : (
              <span dir="ltr">{p.providerConfiguration}</span>
            )}
          </dd>
        </div>
        <div>
          <dt>{t("runInspectorPanels.policies.supervision")}</dt>
          <dd>
            {t("runInspectorPanels.policies.supervisionValue", {
              state: p.supervision.state,
              revision: p.supervision.revision,
            })}
          </dd>
        </div>
        {p.reason && (
          <div>
            <dt>{t("runInspectorPanels.policies.runtimeReason")}</dt>
            <dd className="mono" dir="ltr">
              {p.reason}
            </dd>
          </div>
        )}
      </dl>
      {p.strategies && <StrategiesUsed strategies={p.strategies} />}
      <table className="data-table">
        <caption>{t("runInspectorPanels.operations.caption")}</caption>
        <thead>
          <tr>
            <th scope="col">{t("runInspectorPanels.operations.operation")}</th>
            <th scope="col">{t("runInspectorPanels.operations.status")}</th>
            <th scope="col">{t("runInspectorPanels.operations.reserved")}</th>
            <th scope="col">{t("runInspectorPanels.operations.used")}</th>
          </tr>
        </thead>
        <tbody>
          {p.operations.map((o) => (
            <tr key={o.id + o.attempt}>
              <td className="mono" dir="ltr">
                {o.id.split("/").at(-1)} #{o.attempt}
              </td>
              <td dir="ltr">{o.status}</td>
              <td>{pair(o.reservation)}</td>
              <td>
                {o.usage
                  ? `${pair(o.usage)}${o.usageBasis ? ` (${o.usageBasis.microUsd})` : ""}`
                  : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <table className="data-table">
        <caption>{t("runInspectorPanels.budgets.caption")}</caption>
        <thead>
          <tr>
            <th scope="col">{t("runInspectorPanels.budgets.budget")}</th>
            <th scope="col">{t("runInspectorPanels.budgets.limit")}</th>
            <th scope="col">{t("runInspectorPanels.budgets.used")}</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">{t("runInspectorPanels.budgets.learner")}</th>
            <td>
              {p.enrollmentBudget?.limitSource === "unlimited"
                ? t("runInspectorPanels.budgets.noLearnerLimit")
                : pair(p.enrollmentBudget?.limit)}
            </td>
            <td>{pair(p.enrollmentBudget?.used)}</td>
          </tr>
          <tr>
            <th scope="row">{t("runInspectorPanels.budgets.learnerDaily")}</th>
            <td>{pair(p.enrollmentBudget?.daily)}</td>
            <td>—</td>
          </tr>
          <tr>
            <th scope="row">{t("runInspectorPanels.budgets.perArtifact")}</th>
            <td>{pair(p.enrollmentBudget?.perArtifact)}</td>
            <td>—</td>
          </tr>
          <tr>
            <th scope="row">{t("runInspectorPanels.budgets.workspace")}</th>
            <td>{pair(p.workspaceBudget?.limit)}</td>
            <td>{pair(p.workspaceBudget?.used)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

export function SyncPanel({ run }: { run: SupervisorRun }) {
  const t = useT();
  const { when } = useFormatters();
  const s = run.sync;
  if (!s)
    return (
      <EmptyState title={t("runInspectorPanels.sync.empty.title")}>
        {t("runInspectorPanels.sync.empty.body")}
      </EmptyState>
    );
  const e = s.inputEvent;
  const client = e?.platform
    ? e.appVersion
      ? `${e.platform} ${e.appVersion}`
      : e.platform
    : undefined;
  const delivery = s.delivery && [
    s.delivery.deliveredAt
      ? t("runInspectorPanels.sync.delivered", {
          at: when(s.delivery.deliveredAt),
        })
      : t("runInspectorPanels.sync.notDelivered"),
    t("runInspectorPanels.sync.attempts", { count: s.delivery.attempts }),
    ...(s.delivery.quarantined
      ? [t("runInspectorPanels.sync.quarantined")]
      : []),
    ...(s.delivery.lastErrorCode ? [s.delivery.lastErrorCode] : []),
  ];
  const runState = [
    s.run.state,
    ...(s.run.generation !== null
      ? [
          t("runInspectorPanels.sync.generation", {
            generation: s.run.generation,
          }),
        ]
      : []),
    ...(s.run.snapshotVersion !== null
      ? [
          t("runInspectorPanels.sync.snapshot", {
            version: s.run.snapshotVersion,
          }),
        ]
      : []),
    ...(s.run.cancellationRequested
      ? [t("runInspectorPanels.sync.cancellationRequested")]
      : []),
  ];
  return (
    <dl className="facts vertical">
      <div>
        <dt>{t("runInspectorPanels.sync.inputEvent")}</dt>
        <dd>
          {e
            ? e.recordedAt
              ? t("runInspectorPanels.sync.inputEventRecorded", {
                  sequence: e.sequence,
                  actor: e.actorKind,
                  recorded: when(e.recordedAt),
                })
              : t("runInspectorPanels.sync.inputEventValue", {
                  sequence: e.sequence,
                  actor: e.actorKind,
                })
            : t("runInspectorPanels.none")}
        </dd>
      </div>
      <div>
        <dt>{t("runInspectorPanels.sync.client")}</dt>
        <dd>
          {client ? (
            e?.clientSequence ? (
              t("runInspectorPanels.sync.clientSequence", {
                client,
                sequence: e.clientSequence,
              })
            ) : (
              <bdi dir="ltr">{client}</bdi>
            )
          ) : (
            t("runInspectorPanels.notReported")
          )}
        </dd>
      </div>
      <div>
        <dt>{t("runInspectorPanels.sync.clientClock")}</dt>
        <dd>
          {e?.clockSkewMs !== null && e?.clockSkewMs !== undefined
            ? t("runInspectorPanels.sync.clockSkew", {
                ms: String(e.clockSkewMs),
              })
            : t("runInspectorPanels.notReported")}
        </dd>
      </div>
      <div>
        <dt>{t("runInspectorPanels.sync.courseOnClient")}</dt>
        <dd className="mono" dir="ltr">
          {e?.courseDigest ?? "—"}
        </dd>
      </div>
      <div>
        <dt>{t("runInspectorPanels.sync.eventsSince")}</dt>
        <dd>
          {t("runInspectorPanels.sync.eventsSinceValue", {
            count: s.eventsSince,
            latest: s.latestSequence ?? "—",
          })}
        </dd>
      </div>
      <div>
        <dt>{t("runInspectorPanels.sync.enrollmentRevision")}</dt>
        <dd>
          {t("runInspectorPanels.sync.enrollmentRevisionValue", {
            atRun: s.enrollmentRevisionAtRun,
            now: s.enrollmentRevisionNow ?? "—",
          })}
        </dd>
      </div>
      <div>
        <dt>{t("runInspectorPanels.sync.delivery")}</dt>
        <dd>
          {delivery
            ? delivery.join(" · ")
            : t("runInspectorPanels.sync.noDelivery")}
        </dd>
      </div>
      <div>
        <dt>{t("runInspectorPanels.sync.runState")}</dt>
        <dd>{runState.join(" · ")}</dd>
      </div>
      <div>
        <dt>{t("runInspectorPanels.sync.lastChange")}</dt>
        <dd>{s.run.updatedAt ? when(s.run.updatedAt) : "—"}</dd>
      </div>
    </dl>
  );
}

export function ReplayPanel({
  port,
  courseId,
  runId,
}: {
  port: RunInspectorPort | undefined;
  courseId: string;
  runId: string;
}) {
  const i18n = useI18n();
  const t = i18n.t;
  const [result, setResult] = useState<RunReplay>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  if (!port)
    return (
      <EmptyState title={t("runInspectorPanels.replay.unavailable")}>
        {t("runInspectorPanels.connectedOnly")}
      </EmptyState>
    );
  return (
    <div className="stack">
      <p>{t("runInspectorPanels.replay.intro")}</p>
      <Button
        kind="primary"
        disabled={pending}
        onClick={() => {
          setPending(true);
          setError(undefined);
          port
            .replay(courseId, runId)
            .then(setResult, setError)
            .finally(() => setPending(false));
        }}
      >
        {pending
          ? t("runInspectorPanels.replay.pending")
          : t("runInspectorPanels.replay.submit")}
      </Button>
      <div aria-live="polite">
        {error !== undefined && (
          <Notice tone="red">{runInspectorErrorMessage(error, t)}</Notice>
        )}
        {result && (
          <div className="stack">
            <Notice
              tone={result.outcome === "matches" ? "green" : "gold"}
              title={t(
                `runInspectorPanels.replay.outcome.${result.outcome}` as MessageKey,
              )}
            >
              {result.reason
                ? i18n.rich(
                    "runInspectorPanels.replay.summaryReason",
                    {
                      id: result.replayRunId,
                      providerCalls: result.providerCalls,
                      reason: result.reason,
                    },
                    { mono },
                  )
                : i18n.rich(
                    "runInspectorPanels.replay.summary",
                    {
                      id: result.replayRunId,
                      providerCalls: result.providerCalls,
                    },
                    { mono },
                  )}
            </Notice>
            {!!result.steps.length && (
              <table className="data-table">
                <caption>
                  {t("runInspectorPanels.replay.steps.caption")}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">
                      {t("runInspectorPanels.replay.steps.step")}
                    </th>
                    <th scope="col">
                      {t("runInspectorPanels.replay.steps.tool")}
                    </th>
                    <th scope="col">
                      {t("runInspectorPanels.replay.steps.receipt")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {result.steps.map((s) => (
                    <tr key={s.step}>
                      <td>{i18n.number(s.step)}</td>
                      <td dir="ltr">{s.tool}</td>
                      <td className="mono" dir="ltr">
                        {s.recordedReceiptId}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <dl className="facts vertical">
              <div>
                <dt>{t("runInspectorPanels.replay.recordedPlan")}</dt>
                <dd className="mono" dir="ltr">
                  {result.recordedPlanDigest ?? "—"}
                </dd>
              </div>
              <div>
                <dt>{t("runInspectorPanels.replay.replayedPlan")}</dt>
                <dd className="mono" dir="ltr">
                  {result.replayedPlanDigest ?? "—"}
                </dd>
              </div>
            </dl>
          </div>
        )}
      </div>
    </div>
  );
}

export function PayloadPanel({
  port,
  courseId,
  runId,
  allowed,
}: {
  port: RunInspectorPort | undefined;
  courseId: string;
  runId: string;
  allowed: boolean;
}) {
  const i18n = useI18n();
  const t = i18n.t;
  const id = useId();
  const [reason, setReason] = useState<PayloadReason | "">("");
  const [revealed, setRevealed] = useState<PayloadReveal>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  if (!port)
    return (
      <EmptyState title={t("runInspectorPanels.payload.unavailable")}>
        {t("runInspectorPanels.connectedOnly")}
      </EmptyState>
    );
  if (!allowed)
    return (
      <Notice tone="gold">{t("runInspectorPanels.payload.withheld")}</Notice>
    );
  /** Why a part stays hidden, by the server's category code (run-inspector.ts). */
  const withheldCategory = (category: string | undefined) => {
    const key =
      `runInspectorPanels.payload.category.${(category ?? "").replaceAll("-", "_")}` as MessageKey;
    return category && i18n.has(key)
      ? t(key)
      : t("runInspectorPanels.payload.private");
  };
  const notRevealed = (ref: string) =>
    t("runInspectorPanels.payload.notRevealed", {
      category: withheldCategory(
        revealed?.withheld.find((w) => w.ref === ref)?.category,
      ),
    });
  if (revealed)
    return (
      <div className="stack">
        <Notice tone="blue" title={t("runInspectorPanels.payload.revealed")}>
          {i18n.rich(
            "runInspectorPanels.payload.receipt",
            { id: revealed.receipt.id },
            { mono },
          )}{" "}
          <span>{privacyRuleText(i18n, revealed.rule).reason}</span>
        </Notice>
        {revealed.payload.inputs.map((input) => (
          <article className="record" key={input.id}>
            <h3>
              {t("runInspectorPanels.payload.frozenInput", {
                checkpoint: input.checkpointId,
              })}
            </h3>
            <pre
              dir="ltr"
              aria-label={t("runInspectorPanels.payload.frozenInputLabel", {
                checkpoint: input.checkpointId,
              })}
            >
              {JSON.stringify(input.context, null, 2)}
            </pre>
          </article>
        ))}
        {revealed.payload.toolCalls.map((call) => (
          <article className="record" key={call.id}>
            <div className="split-line">
              <h3>
                {t("runInspectorPanels.payload.step", {
                  step: call.step,
                  tool: call.tool,
                })}
              </h3>
              {call.withheld && (
                <Badge tone="gold">
                  {t("runInspectorPanels.payload.withheldBadge")}
                </Badge>
              )}
            </div>
            {call.withheld ? (
              <p>{notRevealed(`tool:${call.id}`)}</p>
            ) : (
              <pre
                dir="ltr"
                aria-label={t("runInspectorPanels.payload.stepLabel", {
                  step: call.step,
                })}
              >
                {JSON.stringify(
                  { arguments: call.arguments, result: call.result },
                  null,
                  2,
                )}
              </pre>
            )}
          </article>
        ))}
        {revealed.payload.artifacts.map((artifact) => (
          <article className="record" key={artifact.id}>
            <div className="split-line">
              <h3 dir={artifact.kind ? "ltr" : undefined}>
                {artifact.kind ?? t("runInspectorPanels.payload.artifact")}
              </h3>
              {artifact.withheld && (
                <Badge tone="gold">
                  {t("runInspectorPanels.payload.withheldBadge")}
                </Badge>
              )}
            </div>
            {artifact.sha256 && (
              <small className="mono" dir="ltr">
                {t("runInspectorPanels.payload.sha256", {
                  digest: artifact.sha256,
                })}
              </small>
            )}
            {artifact.withheld ? (
              <p>{notRevealed(`artifact:${artifact.id}`)}</p>
            ) : (
              <pre
                dir="ltr"
                aria-label={t("runInspectorPanels.payload.artifactContent", {
                  kind:
                    artifact.kind ?? t("runInspectorPanels.payload.artifact"),
                })}
              >
                {JSON.stringify(artifact.content, null, 2)}
              </pre>
            )}
          </article>
        ))}
        <small>{t("runInspectorPanels.payload.inert")}</small>
      </div>
    );
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        if (!reason) return;
        setPending(true);
        setError(undefined);
        port
          .revealPayload(courseId, runId, reason)
          .then(setRevealed, setError)
          .finally(() => setPending(false));
      }}
    >
      <p>{t("runInspectorPanels.payload.intro")}</p>
      <Field
        label={t("runInspectorPanels.payload.reason")}
        htmlFor={`${id}-reason`}
      >
        <select
          id={`${id}-reason`}
          value={reason}
          onChange={(e) => setReason(e.target.value as PayloadReason | "")}
        >
          <option value="">
            {t("runInspectorPanels.payload.chooseReason")}
          </option>
          {PAYLOAD_REASONS.map((r) => (
            <option key={r.id} value={r.id}>
              {payloadReasonLabel(r.id, t)}
            </option>
          ))}
        </select>
      </Field>
      {error !== undefined && (
        <Notice tone="red">{runInspectorErrorMessage(error, t)}</Notice>
      )}
      <Button kind="danger" type="submit" disabled={pending || !reason}>
        {pending
          ? t("runInspectorPanels.payload.pending")
          : t("runInspectorPanels.payload.submit")}
      </Button>
    </form>
  );
}

/** Run states a retry may act on. The server decides; this only hides the form where it would refuse. */
const RETRYABLE_STATES = new Set(["failed", "cancelled"]);

/**
 * Scoped retry of one run (U07): the run is never resumed or changed; a new run is started from a
 * new staff learning event through the normal dispatcher, supervision control, consent, budget and
 * verification path. Once per run, with a reason, idempotent under one key per form.
 */
export function RetryPanel({
  port,
  courseId,
  runId,
  status,
  role,
  links,
  allowed,
  onRetried,
}: {
  port: RunInspectorPort | undefined;
  courseId: string;
  runId: string;
  status: string;
  role: string;
  links: RetryLinks | undefined;
  allowed: boolean;
  onRetried?: (result: RetryResult) => void;
}) {
  const i18n = useI18n();
  const t = i18n.t;
  const id = useId();
  const key = useRef("retry-" + randomId());
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const [result, setResult] = useState<RetryResult>();
  const retried = result ?? links?.retriedBy;
  return (
    <div className="stack">
      <p>{t("runInspectorPanels.retry.intro", { role })}</p>
      {links?.retryOf && (
        <Notice tone="blue">
          {i18n.rich(
            "runInspectorPanels.retry.retryOf",
            { id: links.retryOf },
            { mono },
          )}
        </Notice>
      )}
      <div aria-live="polite">
        {retried && (
          <Notice tone="green" title={t("runInspectorPanels.retry.done")}>
            {result
              ? i18n.rich(
                  result.replayed
                    ? "runInspectorPanels.retry.queuedReplayed"
                    : "runInspectorPanels.retry.queued",
                  { id: result.retryEventId },
                  { mono },
                )
              : links?.retriedBy?.runId
                ? i18n.rich(
                    "runInspectorPanels.retry.newRun",
                    { id: links.retriedBy.runId },
                    { mono },
                  )
                : t("runInspectorPanels.retry.waiting")}
          </Notice>
        )}
        {error !== undefined && (
          <Notice tone="red">{runInspectorErrorMessage(error, t)}</Notice>
        )}
      </div>
      {!port?.retry ? (
        <EmptyState title={t("runInspectorPanels.retry.unavailable")}>
          {t("runInspectorPanels.connectedOnly")}
        </EmptyState>
      ) : !allowed ? (
        <p className="muted">{t("runInspectorPanels.retry.forbidden")}</p>
      ) : retried ? null : !RETRYABLE_STATES.has(status) ? (
        <p className="muted">{t("runInspectorPanels.retry.notRetryable")}</p>
      ) : (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            setPending(true);
            setError(undefined);
            port.retry!(courseId, runId, {
              idempotencyKey: key.current,
              reason: reason.trim(),
            })
              .then((done) => {
                setResult(done);
                onRetried?.(done);
              }, setError)
              .finally(() => setPending(false));
          }}
        >
          <Field
            label={t("runInspectorPanels.retry.reason")}
            htmlFor={`${id}-reason`}
            hint={t("runInspectorPanels.retry.reasonHint")}
          >
            <textarea
              id={`${id}-reason`}
              dir="auto"
              rows={2}
              maxLength={500}
              value={reason}
              disabled={pending}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
          <Button
            kind="primary"
            type="submit"
            disabled={pending || reason.trim().length < 10}
          >
            {pending
              ? t("runInspectorPanels.retry.pending")
              : t("runInspectorPanels.retry.submit")}
          </Button>
        </form>
      )}
    </div>
  );
}

/** Run states that have not ended: a cancel still stops them before anything is applied. */
export const LIVE_STATES = new Set([
  "queued",
  "running",
  "waiting",
  "verifying",
  "ready",
  "budget_wait",
]);
/** Stops this one run. Supervision for the learner and their other runs stay as they are. */
export function CancelPanel({
  port,
  courseId,
  runId,
  status,
  cancelRequested,
  allowed,
}: {
  port: RunInspectorPort | undefined;
  courseId: string;
  runId: string;
  status: string;
  cancelRequested: boolean;
  allowed: boolean;
}) {
  const i18n = useI18n();
  const t = i18n.t;
  const id = useId();
  const key = useRef("cancel-" + randomId());
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const [result, setResult] = useState<CancelResult>();
  return (
    <div className="stack">
      <p>{t("runInspectorPanels.cancel.intro")}</p>
      <div aria-live="polite">
        {(result || cancelRequested) && (
          <Notice tone="green" title={t("runInspectorPanels.cancel.done")}>
            {result
              ? i18n.rich(
                  "runInspectorPanels.cancel.receipt",
                  { id: result.eventId },
                  { mono },
                )
              : t("runInspectorPanels.cancel.already")}
          </Notice>
        )}
        {error !== undefined && (
          <Notice tone="red">{runInspectorErrorMessage(error, t)}</Notice>
        )}
      </div>
      {!port?.cancel ? (
        <EmptyState title={t("runInspectorPanels.cancel.unavailable")}>
          {t("runInspectorPanels.connectedOnly")}
        </EmptyState>
      ) : !allowed ? (
        <p className="muted">{t("runInspectorPanels.cancel.forbidden")}</p>
      ) : result || cancelRequested ? null : !LIVE_STATES.has(status) ? (
        <p className="muted">{t("runInspectorPanels.cancel.ended")}</p>
      ) : (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            setPending(true);
            setError(undefined);
            port.cancel!(courseId, runId, {
              idempotencyKey: key.current,
              reason: reason.trim(),
            })
              .then(setResult, setError)
              .finally(() => setPending(false));
          }}
        >
          <Field
            label={t("runInspectorPanels.cancel.reason")}
            htmlFor={`${id}-reason`}
            hint={t("runInspectorPanels.cancel.reasonHint")}
          >
            <textarea
              id={`${id}-reason`}
              dir="auto"
              rows={2}
              maxLength={500}
              value={reason}
              disabled={pending}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
          <Button
            kind="danger"
            type="submit"
            disabled={pending || reason.trim().length < 10}
          >
            {pending
              ? t("runInspectorPanels.cancel.pending")
              : t("runInspectorPanels.cancel.submit")}
          </Button>
        </form>
      )}
    </div>
  );
}
