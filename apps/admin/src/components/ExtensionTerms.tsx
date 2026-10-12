import type {
  ExtensionPreview,
  ScopePolicy,
  LearningPolicy,
} from "../domain/policy";
import { metricLabel } from "./PolicyDetails";
import { when } from "./ui";
type Terms = Pick<
  ExtensionPreview,
  | "currentEffectiveDeadline"
  | "proposedEffectiveDeadline"
  | "currentWorkQuotas"
  | "proposedWorkQuotas"
  | "balanceBefore"
  | "balanceAfter"
  | "poolDebits"
  | "bindingAncestorCaps"
  | "requiredApprovals"
>;
export function ExtensionTerms({
  terms,
  scopes,
  pools,
}: {
  terms: Terms;
  scopes: ScopePolicy[];
  pools: LearningPolicy["pools"];
}) {
  const unit = (poolId: string) =>
    pools.find((pool) => pool.poolId === poolId)?.unit.replaceAll("_", " ") ??
    "units";
  return (
    <div className="stack">
      <div
        className="table-wrap"
        tabIndex={0}
        role="region"
        aria-label="Exact before and after terms"
      >
        <table>
          <caption>Exact before / after terms if later granted</caption>
          <thead>
            <tr>
              <th scope="col">Term</th>
              <th scope="col">Current</th>
              <th scope="col">Proposed</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">Effective deadline</th>
              <td>
                {terms.currentEffectiveDeadline
                  ? when(terms.currentEffectiveDeadline)
                  : "None"}
              </td>
              <td>
                {terms.proposedEffectiveDeadline
                  ? when(terms.proposedEffectiveDeadline)
                  : "None"}
              </td>
            </tr>
            {terms.currentWorkQuotas.map((q, i) => {
              const next = terms.proposedWorkQuotas.find(
                (n) =>
                  n.scopeId === q.scopeId &&
                  n.metric === q.metric &&
                  n.conceptId === q.conceptId,
              );
              return (
                <tr key={`quota-${i}`}>
                  <th scope="row">
                    {scopes.find((s) => s.scopeId === q.scopeId)?.label ??
                      q.scopeId}
                    <small>
                      {metricLabel[q.metric]}
                      {q.conceptId ? ` · ${q.conceptId}` : ""}
                    </small>
                  </th>
                  <td>
                    {q.limit} cap · {q.consumed} consumed · {q.reserved}{" "}
                    reserved · {q.remaining} remaining
                  </td>
                  <td>
                    {next
                      ? `${next.limit} cap · ${next.consumed} consumed · ${next.reserved} reserved · ${next.remaining} remaining`
                      : "Not supplied"}
                  </td>
                </tr>
              );
            })}
            {terms.balanceBefore.map((before) => {
              const after = terms.balanceAfter.find(
                (b) => b.poolId === before.poolId,
              );
              return (
                <tr key={before.poolId}>
                  <th scope="row">
                    Allowance balance
                    <small className="mono">{before.poolId}</small>
                  </th>
                  <td>
                    {before.remaining} {unit(before.poolId)} /{" "}
                    {before.grantsRemaining} grants
                  </td>
                  <td>
                    {after
                      ? `${after.remaining} ${unit(before.poolId)} / ${after.grantsRemaining} grants`
                      : "Not supplied"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div>
        <h3>Exact pool cost if granted</h3>
        {terms.poolDebits.map((debit) => (
          <p key={debit.poolId}>
            {debit.amount} {unit(debit.poolId)} from{" "}
            <span className="mono">{debit.poolId}</span>
          </p>
        ))}
      </div>
      <div>
        <h3>Ancestor caps remain binding</h3>
        {terms.bindingAncestorCaps.map((cap, i) => (
          <p key={i}>
            {scopes.find((s) => s.scopeId === cap.scopeId)?.label ??
              cap.scopeId}{" "}
            · {cap.kind} · {when(cap.at)}
          </p>
        ))}
      </div>
      <small>
        Required authority approvals:{" "}
        {terms.requiredApprovals.join(", ") ||
          "None beyond exact learner acceptance"}
        .
      </small>
    </div>
  );
}
