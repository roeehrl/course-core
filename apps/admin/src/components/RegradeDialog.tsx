import { useId, useRef, useState } from "react";
import {
  regradeErrorMessage,
  type RegradePort,
  type RegradeResult,
  type RegradeView,
} from "../domain/corrections";
import { randomId } from "../domain/webCrypto";
import { useRemote } from "../hooks/useAdmin";
import { Badge, Button, Field, Loading, Notice, when } from "./ui";
import {
  emptyFindings,
  findingsPayload,
  requiredMet,
  RubricFindings,
  type Finding,
} from "./RubricFindings";

const DECISION_KIND: Record<string, string> = {
  attempt: "the original automated result",
  review: "the review",
  appeal: "the second opinion on appeal",
  regrade: "an earlier regrade",
};

/**
 * Scoped regrade of one attempt (U07). An automated attempt is graded again by the course's own
 * evaluator; a written (rubric) answer gets a second person's findings under the quoting rules.
 * Either way a new decision is recorded and linked to the one it replaces; nothing earlier is
 * edited. The idempotency key is kept for the dialog's life, so a retried submit cannot regrade twice.
 */
export function RegradeDialogBody({
  port,
  enrollmentId,
  attemptId,
  onDone,
}: {
  port: RegradePort;
  enrollmentId: string;
  attemptId: string;
  onDone: (result: RegradeResult) => void;
}) {
  const view = useRemote(
    (signal) => port.view(enrollmentId, attemptId, signal),
    [port, enrollmentId, attemptId],
  );
  if (view.loading)
    return <Loading label="Loading this attempt's decisions…" />;
  if (view.error || !view.data)
    return <Notice tone="red">{regradeErrorMessage(view.error)}</Notice>;
  return (
    <RegradeForm
      view={view.data}
      port={port}
      enrollmentId={enrollmentId}
      onDone={onDone}
    />
  );
}

function RegradeForm({
  view,
  port,
  enrollmentId,
  onDone,
}: {
  view: RegradeView;
  port: RegradePort;
  enrollmentId: string;
  onDone: (result: RegradeResult) => void;
}) {
  const id = useId();
  const key = useRef("regrade-" + randomId());
  const [reason, setReason] = useState("");
  const [findings, setFindings] = useState<Record<string, Finding>>(() =>
    emptyFindings(view.rubric?.criteria ?? []),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const [result, setResult] = useState<RegradeResult>();
  const rubric = view.rubric,
    met = rubric ? requiredMet(rubric.criteria, findings) : false;
  const current = view.current;
  return (
    <div className="stack">
      <dl className="facts vertical">
        <div>
          <dt>Attempt</dt>
          <dd>
            <span className="mono">{view.attemptId}</span> · {view.assessmentId}{" "}
            · {view.kind === "rubric" ? "written answer" : "automated"}
          </dd>
        </div>
        <div>
          <dt>Decision in force</dt>
          <dd>
            {current
              ? `${current.passed ? "passed" : "not passed"} — ${DECISION_KIND[current.kind]}`
              : "none yet"}
          </dd>
        </div>
      </dl>
      {!!view.history.length && (
        <table className="data-table">
          <caption>
            Earlier regrades (each linked to the decision it replaced)
          </caption>
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">By</th>
              <th scope="col">Outcome</th>
              <th scope="col">Replaced</th>
            </tr>
          </thead>
          <tbody>
            {view.history.map((h) => (
              <tr key={h.regradeId}>
                <td>{when(h.at)}</td>
                <td>{h.actor}</td>
                <td>
                  {h.outcome} · {h.passed ? "passed" : "not passed"}
                </td>
                <td>{DECISION_KIND[h.supersedes.kind]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Notice tone="gold">
        {view.kind === "rubric"
          ? "Your findings become a new decision linked to the one in force. Each criterion you mark as shown needs an exact quotation from the learner's words."
          : "The course's own evaluator grades the stored answer again. The result becomes a new decision linked to the one in force."}{" "}
        Earlier decisions and the answer are never edited. If the outcome
        changes, the old evidence is withdrawn with a reason and the learner's
        checkpoints are recomputed.
      </Notice>
      {result ? (
        <Notice
          tone={result.outcome === "changed" ? "green" : "blue"}
          title={
            result.outcome === "changed" ? "Decision changed" : "Decision kept"
          }
        >
          {result.passed ? "Passed" : "Not passed"} (was{" "}
          {result.previousPassed ? "passed" : "not passed"}). Regrade{" "}
          <span className="mono">{result.regradeId}</span> replaces{" "}
          {DECISION_KIND[result.supersedes.kind]}. Evidence withdrawn:{" "}
          {result.evidence.invalidated}; added: {result.evidence.created}.
        </Notice>
      ) : (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            setPending(true);
            setError(undefined);
            port
              .submit(enrollmentId, view.attemptId, {
                idempotencyKey: key.current,
                reason: reason.trim(),
                ...(rubric
                  ? {
                      decision: met ? ("met" as const) : ("not_met" as const),
                      criteria: findingsPayload(rubric.criteria, findings),
                    }
                  : {}),
              })
              .then((done) => {
                setResult(done);
                onDone(done);
              }, setError)
              .finally(() => setPending(false));
          }}
        >
          {rubric && (
            <>
              <p>{rubric.prompt}</p>
              {rubric.answers.map((text, i) => (
                <div
                  key={i}
                  className="review-response"
                  tabIndex={0}
                  role="region"
                  aria-label={`Learner answer ${i + 1}`}
                >
                  {text}
                </div>
              ))}
              <RubricFindings
                idPrefix={id}
                rubric={rubric.criteria}
                findings={findings}
                words={rubric.answers}
                disabled={pending}
                onChange={setFindings}
              />
              <p>
                Your decision:{" "}
                <strong>{met ? "Criteria met" : "Not yet"}</strong>{" "}
                {current && (
                  <Badge tone={met === current.passed ? "blue" : "gold"}>
                    {met === current.passed
                      ? "keeps the decision"
                      : "changes the decision"}
                  </Badge>
                )}
              </p>
            </>
          )}
          <Field
            label="Reason for the regrade"
            htmlFor={`${id}-reason`}
            hint="Required, at least 10 characters. Kept in the staff audit record; the learner sees the outcome."
          >
            <textarea
              id={`${id}-reason`}
              rows={2}
              maxLength={2000}
              value={reason}
              disabled={pending}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
          <div aria-live="polite">
            {error !== undefined && (
              <Notice tone="red">{regradeErrorMessage(error)}</Notice>
            )}
          </div>
          <Button
            kind="primary"
            type="submit"
            disabled={pending || reason.trim().length < 10}
          >
            {pending
              ? "Regrading…"
              : view.kind === "rubric"
                ? "Record the new decision"
                : "Grade again"}
          </Button>
        </form>
      )}
    </div>
  );
}
