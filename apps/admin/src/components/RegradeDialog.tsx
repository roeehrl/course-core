import { useId, useRef, useState, type ReactNode } from "react";
import {
  regradeErrorMessage,
  type RegradePort,
  type RegradeResult,
  type RegradeView,
} from "../domain/corrections";
import { randomId } from "../domain/webCrypto";
import { useRemote } from "../hooks/useAdmin";
import { useFormatters, useI18n, useT } from "../i18n";
import { Badge, Button, Field, Loading, Notice } from "./ui";
import {
  emptyFindings,
  findingsPayload,
  requiredMet,
  RubricFindings,
  type Finding,
} from "./RubricFindings";

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
  const t = useT();
  const view = useRemote(
    (signal) => port.view(enrollmentId, attemptId, signal),
    [port, enrollmentId, attemptId],
  );
  if (view.loading) return <Loading label={t("regradeDialog.loading")} />;
  if (view.error || !view.data)
    return <Notice tone="red">{regradeErrorMessage(view.error, t)}</Notice>;
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
  const i18n = useI18n();
  const t = i18n.t;
  const { when } = useFormatters();
  const mono = (children: ReactNode, key: string | number) => (
    <span key={key} className="mono" dir="ltr">
      {children}
    </span>
  );
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
          <dt>{t("regradeDialog.attempt")}</dt>
          <dd>
            {i18n.rich(
              "regradeDialog.attemptValue",
              {
                attemptId: view.attemptId,
                assessmentId: view.assessmentId,
                kind: view.kind,
              },
              { code: mono },
            )}
          </dd>
        </div>
        <div>
          <dt>{t("regradeDialog.current")}</dt>
          <dd>
            {current
              ? t("regradeDialog.currentValue", {
                  passed: current.passed ? "yes" : "no",
                  kind: current.kind,
                })
              : t("regradeDialog.currentNone")}
          </dd>
        </div>
      </dl>
      {!!view.history.length && (
        <table className="data-table">
          <caption>{t("regradeDialog.history.caption")}</caption>
          <thead>
            <tr>
              <th scope="col">{t("regradeDialog.history.when")}</th>
              <th scope="col">{t("regradeDialog.history.by")}</th>
              <th scope="col">{t("regradeDialog.history.outcome")}</th>
              <th scope="col">{t("regradeDialog.history.replaced")}</th>
            </tr>
          </thead>
          <tbody>
            {view.history.map((h) => (
              <tr key={h.regradeId}>
                <td>{when(h.at)}</td>
                <td dir="auto">{h.actor}</td>
                <td>
                  {t("regradeDialog.history.outcomeValue", {
                    outcome: h.outcome,
                    passed: h.passed ? "yes" : "no",
                  })}
                </td>
                <td>
                  {t("regradeDialog.decisionKind", {
                    kind: h.supersedes.kind,
                  })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Notice tone="gold">
        {view.kind === "rubric"
          ? t("regradeDialog.explain.rubric")
          : t("regradeDialog.explain.automated")}
      </Notice>
      {result ? (
        <Notice
          tone={result.outcome === "changed" ? "green" : "blue"}
          title={
            result.outcome === "changed"
              ? t("regradeDialog.result.changed")
              : t("regradeDialog.result.kept")
          }
        >
          {i18n.rich(
            "regradeDialog.result.body",
            {
              passed: result.passed ? "yes" : "no",
              previous: result.previousPassed ? "yes" : "no",
              regradeId: result.regradeId,
              kind: result.supersedes.kind,
              withdrawn: result.evidence.invalidated,
              added: result.evidence.created,
            },
            { code: mono },
          )}
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
              <p dir="auto">{rubric.prompt}</p>
              {rubric.answers.map((text, i) => (
                <div
                  key={i}
                  className="review-response"
                  tabIndex={0}
                  role="region"
                  aria-label={t("regradeDialog.answerLabel", { n: i + 1 })}
                  dir="auto"
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
                {i18n.rich(
                  "regradeDialog.decision",
                  { met: met ? "yes" : "no" },
                  {
                    strong: (children, key) => (
                      <strong key={key}>{children}</strong>
                    ),
                  },
                )}{" "}
                {current && (
                  <Badge tone={met === current.passed ? "blue" : "gold"}>
                    {met === current.passed
                      ? t("regradeDialog.keeps")
                      : t("regradeDialog.changes")}
                  </Badge>
                )}
              </p>
            </>
          )}
          <Field
            label={t("regradeDialog.reason.label")}
            htmlFor={`${id}-reason`}
            hint={t("regradeDialog.reason.hint")}
          >
            <textarea
              id={`${id}-reason`}
              rows={2}
              maxLength={2000}
              value={reason}
              disabled={pending}
              dir="auto"
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
          <div aria-live="polite">
            {error !== undefined && (
              <Notice tone="red">{regradeErrorMessage(error, t)}</Notice>
            )}
          </div>
          <Button
            kind="primary"
            type="submit"
            disabled={pending || reason.trim().length < 10}
          >
            {pending
              ? t("regradeDialog.submit.pending")
              : view.kind === "rubric"
                ? t("regradeDialog.submit.rubric")
                : t("regradeDialog.submit.automated")}
          </Button>
        </form>
      )}
    </div>
  );
}
