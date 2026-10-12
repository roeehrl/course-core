import type { LearningPolicy, Quota, ScopePolicy } from "../domain/policy";
import { Badge, Card, EmptyState, Notice, when } from "./ui";
export const metricLabel = {
  additionalMinutes: "Additional planned minutes",
  additionalEpisodes: "Additional episodes",
  remediationCyclesPerConcept: "Remediation cycles / concept",
};
export function ScopeDetails({
  scope,
  constraint,
  policy,
}: {
  scope: ScopePolicy;
  constraint: LearningPolicy["constraints"][number];
  policy: LearningPolicy;
}) {
  return (
    <Card title={scope.label} eyebrow="Calendar policy">
      <div className="split-line">
        <Badge tone={scope.mode === "bounded" ? "blue" : "gold"}>
          {scope.mode.replace("_", "-")} mode
        </Badge>
        <small className="mono">{scope.policyId}</small>
      </div>
      <Notice tone="blue">
        {scope.mode === "open_ended"
          ? "This scope has no local bounded clock. Applicable ancestor deadlines and work caps still bind."
          : "Both local and ancestor constraints apply. The earliest applicable deadline is the effective deadline."}
      </Notice>
      <dl className="facts vertical policy-facts">
        <div>
          <dt>Soft target date</dt>
          <dd>
            {scope.targetDate ? when(scope.targetDate) : "Not set"}
            <small>A planning target; it does not close access.</small>
          </dd>
        </div>
        <div>
          <dt>Hard deadline</dt>
          <dd>
            {scope.hardDeadline
              ? `${when(scope.hardDeadline.at)} · ${scope.hardDeadline.timeZone}`
              : "No local hard deadline"}
          </dd>
        </div>
        <div>
          <dt>Calendar window</dt>
          <dd>
            {scope.window ? (
              <>
                {scope.window.calendarDays} calendar days from{" "}
                {scope.window.anchor.replaceAll("_", " ")}
                <small>Anchor: {when(scope.window.anchorInstant)}</small>
                <small>
                  Resolved end: {when(scope.window.resolvedDeadline)}
                </small>
                <small>
                  Time zone: {scope.window.timeZone} · Pause:{" "}
                  {scope.window.pauseRule.replaceAll("_", " ")}
                </small>
                <small className="mono">
                  Anchor ID: {scope.window.anchorId}
                </small>
              </>
            ) : (
              "No activated local window"
            )}
          </dd>
        </div>
        <div>
          <dt>Ultimate ceiling</dt>
          <dd>
            {scope.ultimateDeadline
              ? when(scope.ultimateDeadline)
              : "No local ultimate ceiling"}
          </dd>
        </div>
        <div>
          <dt>Effective deadline</dt>
          <dd>
            <strong>
              {constraint.effectiveDeadline
                ? when(constraint.effectiveDeadline)
                : "No calendar deadline"}
            </strong>
          </dd>
        </div>
        <div>
          <dt>After cap access</dt>
          <dd>
            {constraint.existingMaterialAccess.replaceAll("_", " ")} for
            existing material
          </dd>
        </div>
        {scope.submissionGraceUntil && (
          <div>
            <dt>Submission grace</dt>
            <dd>
              {when(scope.submissionGraceUntil)}
              <small>
                Submission grace does not extend planning or admission limits.
              </small>
            </dd>
          </div>
        )}
      </dl>
      <h3>Currently binding deadlines</h3>
      {constraint.bindingDeadlines.map((deadline, i) => (
        <div className="cap-row" key={i}>
          <Badge tone="gold">{deadline.kind}</Badge>
          <strong>
            {policy.scopes.find((item) => item.scopeId === deadline.scopeId)
              ?.label ?? deadline.scopeId}
          </strong>
          <small>{when(deadline.at)}</small>
        </div>
      ))}
      {!constraint.bindingDeadlines.length && (
        <small>
          No binding calendar deadline. Work quotas may still constrain
          expansion.
        </small>
      )}
      <h3>Ancestor and ultimate caps</h3>
      {constraint.deadlines
        .filter((d) => d.scopeId !== scope.scopeId || d.kind === "ultimate")
        .map((deadline, i) => (
          <div className="cap-row" key={i}>
            <span>
              {policy.scopes.find((s) => s.scopeId === deadline.scopeId)
                ?.label ?? deadline.scopeId}{" "}
              · {deadline.kind}
            </span>
            <small>{when(deadline.at)}</small>
          </div>
        ))}
    </Card>
  );
}
export function ScopeQuotas({
  quotas,
  scopes,
}: {
  quotas: Quota[];
  scopes: ScopePolicy[];
}) {
  if (!quotas.length)
    return (
      <EmptyState title="No finite work quota in this path">
        Any applicable calendar deadline still governs the scope.
      </EmptyState>
    );
  return (
    <div
      className="table-wrap"
      tabIndex={0}
      role="region"
      aria-label="Work caps by scope"
    >
      <table>
        <caption>Inherited work caps and current usage</caption>
        <thead>
          <tr>
            <th scope="col">Scope / metric</th>
            <th scope="col">Limit</th>
            <th scope="col">Consumed</th>
            <th scope="col">Reserved</th>
            <th scope="col">Remaining</th>
          </tr>
        </thead>
        <tbody>
          {quotas.map((q, i) => (
            <tr key={i}>
              <th scope="row">
                {scopes.find((s) => s.scopeId === q.scopeId)?.label ??
                  q.scopeId}
                <small>
                  {metricLabel[q.metric]}
                  {q.conceptId ? ` · ${q.conceptId}` : ""}
                </small>
              </th>
              <td>{q.limit}</td>
              <td>{q.consumed}</td>
              <td>{q.reserved}</td>
              <td>{q.remaining}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
