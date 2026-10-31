import { useId, useRef, useState } from "react";
import { Pause, Play, RotateCcw, Square } from "lucide-react";
import type { AdminClient, CourseWorkspace } from "../domain/contracts";
import {
  supervisionErrorMessage,
  supervisionReasons,
  type SupervisionAction,
  type SupervisionPort,
  type SupervisionState,
} from "../domain/supervision";
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
import { randomId } from "../domain/webCrypto";
import { useFormatters, useI18n, useT, type MessageKey } from "../i18n";
import {
  AuthorityQueueCard,
  LearnerBudgetCard,
  SupervisionSettingsCard,
} from "./SupervisionSettings";

const stateTone: Record<SupervisionState, "green" | "gold" | "red"> = {
  active: "green",
  paused: "gold",
  stopped: "red",
};
/** A server code shown in words: underscores and dots become spaces. */
const humanize = (code: string) => code.toLowerCase().replaceAll(/[._]/g, " ");

/** Staff pause, stop and resume of one learner's AI supervision (companion, planning, research,
 * reviewer drafts and course-made media). Server authorization and the stored control decide;
 * these controls only send the request. */
export function SupervisionView({
  data,
  client,
}: {
  data: CourseWorkspace;
  client: AdminClient;
}) {
  const t = useT();
  const id = useId();
  const [enrollmentId, setEnrollmentId] = useState("");
  if (!client.supervision)
    return (
      <Card title={t("supervisionView.title")}>
        <EmptyState title={t("supervisionView.unavailable.title")}>
          {t("supervisionView.unavailable.body")}
        </EmptyState>
      </Card>
    );
  const learners = data.enrollments.filter((e) => e.status !== "erased");
  // Workspace settings, spending limits and authority decisions: owners and admins only.
  const settings =
    client.supervision.settings &&
    data.course.workspaceId &&
    data.permissions.includes("supervision.settings")
      ? {
          port: client.supervision.settings,
          workspaceId: data.course.workspaceId,
        }
      : null;
  return (
    <div className="page-stack">
      {settings && (
        <>
          <SupervisionSettingsCard
            port={settings.port}
            workspaceId={settings.workspaceId}
          />
          <AuthorityQueueCard
            port={settings.port}
            workspaceId={settings.workspaceId}
          />
        </>
      )}
      <Card title={t("supervisionView.chooseLearner")}>
        <Field label={t("supervisionView.learner")} htmlFor={`${id}-learner`}>
          <select
            id={`${id}-learner`}
            value={enrollmentId}
            onChange={(e) => setEnrollmentId(e.target.value)}
          >
            <option value="">{t("supervisionView.chooseLearner")}</option>
            {learners.map((e) => (
              <option key={e.id} value={e.id} dir="auto">
                {e.profile.displayName}
              </option>
            ))}
          </select>
        </Field>
      </Card>
      {enrollmentId && (
        <SupervisionPanel
          key={enrollmentId}
          port={client.supervision}
          enrollmentId={enrollmentId}
          settings={settings}
        />
      )}
    </div>
  );
}

function SupervisionPanel({
  port,
  enrollmentId,
  settings,
}: {
  port: SupervisionPort;
  enrollmentId: string;
  settings: {
    port: NonNullable<SupervisionPort["settings"]>;
    workspaceId: string;
  } | null;
}) {
  const i18n = useI18n();
  const t = i18n.t;
  const { when } = useFormatters();
  /** A server code through its catalog label; unknown codes are shown in words. */
  const label = (key: string, code: string) =>
    i18n.has(key as MessageKey) ? t(key as MessageKey) : humanize(code);
  const reasonLabel = (code: string) =>
    label(`supervisionView.reason.${code}`, code);
  const id = useId();
  const view = useRemote(
    (signal) => port.overview(enrollmentId, signal),
    [port, enrollmentId],
  );
  const [reason, setReason] = useState("");
  const [confirmStop, setConfirmStop] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const [message, setMessage] = useState("");
  // One key per intended change: a retry of the same change replays it.
  const keys = useRef(new Map<string, string>());
  const [requeueing, setRequeueing] = useState<{
    eventId: string;
    label: string;
  } | null>(null);
  const [requeueReason, setRequeueReason] = useState("");
  if (view.loading && !view.data)
    return <Loading label={t("supervisionView.loading")} />;
  if (view.error || !view.data)
    return <Notice tone="red">{supervisionErrorMessage(view.error, t)}</Notice>;
  const o = view.data,
    state = o.control.state;
  async function send(action: SupervisionAction) {
    const fingerprint = `${action}:${o.control.revision}:${reason}`;
    let key = keys.current.get(fingerprint);
    if (!key)
      keys.current.set(fingerprint, (key = "supervision-" + randomId()));
    setPending(true);
    setError(undefined);
    setMessage("");
    try {
      const result = await port.control(enrollmentId, action, {
        idempotencyKey: key,
        expectedRevision: o.control.revision,
        ...(reason ? { reasonCode: reason } : {}),
      });
      keys.current.delete(fingerprint);
      setConfirmStop(false);
      setMessage(
        !result.changed
          ? t("supervisionView.result.unchanged")
          : result.state === "stopped"
            ? t("supervisionView.result.stopped", {
                count: result.cancelledJobs,
              })
            : result.state === "paused"
              ? t("supervisionView.result.paused")
              : t("supervisionView.result.resumed"),
      );
      view.reload();
    } catch (caught) {
      setError(caught);
    } finally {
      setPending(false);
    }
  }
  async function requeue(eventId: string) {
    const reasonText = requeueReason.trim();
    if (!port.requeue || reasonText.length < 10) return;
    const fingerprint = `requeue:${eventId}:${reasonText}`;
    let key = keys.current.get(fingerprint);
    if (!key) keys.current.set(fingerprint, (key = "requeue-" + randomId()));
    setPending(true);
    setError(undefined);
    setMessage("");
    try {
      await port.requeue(enrollmentId, eventId, {
        idempotencyKey: key,
        reason: reasonText,
      });
      keys.current.delete(fingerprint);
      setRequeueing(null);
      setRequeueReason("");
      setMessage(t("supervisionView.requeue.done"));
      view.reload();
    } catch (caught) {
      setError(caught);
    } finally {
      setPending(false);
    }
  }
  const showRequeue = o.canRequeue && !!port.requeue;
  /** A supervised event type in words; a type this app does not know shows its code. */
  const eventLabel = (eventType: string) => {
    const key =
      `supervisionView.eventType.${eventType.replaceAll(".", "_")}` as MessageKey;
    return i18n.has(key)
      ? t(key)
      : t("supervisionView.eventType.other", { code: eventType });
  };
  return (
    <Card
      title={t("supervisionView.title")}
      actions={
        <Badge tone={stateTone[state]}>
          {t(`supervisionView.state.${state}` as MessageKey)}
        </Badge>
      }
    >
      <div className="stack">
        <p>{t(`supervisionView.stateText.${state}` as MessageKey)}</p>
        {o.control.changedAt && (
          <p className="muted">
            {o.control.reasonCode
              ? t("supervisionView.changedWithReason", {
                  when: when(o.control.changedAt),
                  reason: reasonLabel(o.control.reasonCode),
                  revision: o.control.revision,
                })
              : t("supervisionView.changed", {
                  when: when(o.control.changedAt),
                  revision: o.control.revision,
                })}
          </p>
        )}
        <div aria-live="polite">
          {message && <Notice tone="green">{message}</Notice>}
          {error !== undefined && (
            <Notice tone="red">{supervisionErrorMessage(error, t)}</Notice>
          )}
        </div>
        {o.pendingSignals > 0 && (
          <Notice tone="blue">
            {t("supervisionView.pendingSignals", { count: o.pendingSignals })}
          </Notice>
        )}
        {o.canControl ? (
          <>
            <Field
              label={t("supervisionView.reasonField")}
              htmlFor={`${id}-reason`}
            >
              <select
                id={`${id}-reason`}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              >
                <option value="">{t("supervisionView.noReason")}</option>
                {supervisionReasons.map((r) => (
                  <option key={r} value={r}>
                    {reasonLabel(r)}
                  </option>
                ))}
              </select>
            </Field>
            <div className="tag-row">
              {state === "active" && (
                <Button disabled={pending} onClick={() => void send("pause")}>
                  <Pause size={16} aria-hidden="true" />{" "}
                  {t("supervisionView.pause")}
                </Button>
              )}
              {state !== "active" && (
                <Button
                  kind="primary"
                  disabled={pending}
                  onClick={() => void send("resume")}
                >
                  <Play size={16} aria-hidden="true" className="flip-rtl" />{" "}
                  {t("supervisionView.resume")}
                </Button>
              )}
              {state !== "stopped" && !confirmStop && (
                <Button
                  kind="danger"
                  disabled={pending}
                  onClick={() => setConfirmStop(true)}
                >
                  <Square size={16} aria-hidden="true" />{" "}
                  {t("supervisionView.stop")}
                </Button>
              )}
            </div>
            {confirmStop && (
              <Notice
                tone="gold"
                title={t("supervisionView.confirmStop.title")}
              >
                {t("supervisionView.confirmStop.body")}
                <div className="tag-row">
                  <Button kind="quiet" onClick={() => setConfirmStop(false)}>
                    {t("supervisionView.confirmStop.keep")}
                  </Button>
                  <Button
                    kind="danger"
                    disabled={pending}
                    onClick={() => void send("stop")}
                  >
                    {t("supervisionView.confirmStop.confirm")}
                  </Button>
                </div>
              </Notice>
            )}
          </>
        ) : (
          <p className="muted">{t("supervisionView.readOnly")}</p>
        )}
        <h3 className="section-title">{t("supervisionView.jobs.title")}</h3>
        {o.jobs.length === 0 ? (
          <p className="muted">{t("supervisionView.jobs.empty")}</p>
        ) : (
          <div
            className="table-wrap"
            tabIndex={0}
            role="region"
            aria-label={t("supervisionView.jobs.table")}
          >
            <table className="people-table">
              <caption className="sr-only">
                {t("supervisionView.jobs.table")}
              </caption>
              <thead>
                <tr>
                  <th scope="col">{t("supervisionView.jobs.role")}</th>
                  <th scope="col">{t("supervisionView.jobs.state")}</th>
                  <th scope="col">{t("supervisionView.jobs.started")}</th>
                </tr>
              </thead>
              <tbody>
                {o.jobs.map((j) => (
                  <tr key={j.id}>
                    <th scope="row">
                      {label(`supervisionView.jobRole.${j.role}`, j.role)}
                    </th>
                    <td data-label={t("supervisionView.jobs.state")}>
                      <Badge>
                        {label(`supervisionView.jobState.${j.state}`, j.state)}
                      </Badge>{" "}
                      {j.held && (
                        <Badge tone="gold">
                          {t("supervisionView.jobs.held")}
                        </Badge>
                      )}{" "}
                      {j.cancellationRequested && (
                        <Badge tone="red">
                          {t("supervisionView.jobs.cancelling")}
                        </Badge>
                      )}
                    </td>
                    <td data-label={t("supervisionView.jobs.started")}>
                      {when(j.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <h3 className="section-title">
          {t("supervisionView.undelivered.title")}
        </h3>
        {o.undeliveredEvents.length === 0 ? (
          <p className="muted">{t("supervisionView.undelivered.empty")}</p>
        ) : (
          <>
            <p className="muted">
              {showRequeue
                ? t("supervisionView.undelivered.explainRequeue")
                : t("supervisionView.undelivered.explain")}
            </p>
            <div
              className="table-wrap"
              tabIndex={0}
              role="region"
              aria-label={t("supervisionView.undelivered.title")}
            >
              <table className="people-table">
                <caption className="sr-only">
                  {t("supervisionView.undelivered.title")}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">
                      {t("supervisionView.undelivered.request")}
                    </th>
                    <th scope="col">
                      {t("supervisionView.undelivered.outcome")}
                    </th>
                    <th scope="col">
                      {t("supervisionView.undelivered.reason")}
                    </th>
                    <th scope="col">{t("supervisionView.undelivered.when")}</th>
                    {showRequeue && (
                      <th scope="col">
                        {t("supervisionView.undelivered.action")}
                      </th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {o.undeliveredEvents.map((u) => (
                    <tr key={u.eventId}>
                      <th scope="row">{eventLabel(u.eventType)}</th>
                      <td data-label={t("supervisionView.undelivered.outcome")}>
                        <Badge tone={u.outcome === "refused" ? "gold" : "red"}>
                          {t(
                            `supervisionView.outcome.${u.outcome}` as MessageKey,
                          )}
                        </Badge>{" "}
                        {u.requeued && (
                          <Badge>
                            {t("supervisionView.undelivered.requeuedOnce")}
                          </Badge>
                        )}
                      </td>
                      <td data-label={t("supervisionView.undelivered.reason")}>
                        {i18n.has(
                          `supervisionView.deliveryReason.${u.reason}` as MessageKey,
                        )
                          ? t(
                              `supervisionView.deliveryReason.${u.reason}` as MessageKey,
                            )
                          : t("supervisionView.deliveryReason.other", {
                              code: u.reason,
                            })}
                      </td>
                      <td data-label={t("supervisionView.undelivered.when")}>
                        {when(u.at)}
                      </td>
                      {showRequeue && (
                        <td
                          data-label={t("supervisionView.undelivered.action")}
                        >
                          {u.requeueable ? (
                            <Button
                              kind="quiet"
                              disabled={pending}
                              aria-label={t(
                                "supervisionView.requeue.buttonLabel",
                                {
                                  request: eventLabel(u.eventType),
                                  when: when(u.at),
                                },
                              )}
                              onClick={() => {
                                setRequeueing({
                                  eventId: u.eventId,
                                  label: eventLabel(u.eventType),
                                });
                                setRequeueReason("");
                              }}
                            >
                              <RotateCcw size={16} aria-hidden="true" />{" "}
                              {t("supervisionView.requeue.button")}
                            </Button>
                          ) : (
                            <span className="muted">
                              {u.requeued
                                ? t("supervisionView.requeue.already")
                                : t("supervisionView.requeue.notRequeueable")}
                            </span>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {showRequeue && requeueing && (
              <Notice
                tone="gold"
                title={t("supervisionView.requeue.title", {
                  request: requeueing.label,
                })}
              >
                <p>{t("supervisionView.requeue.body")}</p>
                <Field
                  label={t("supervisionView.requeue.reasonLabel")}
                  hint={t("supervisionView.requeue.reasonHint")}
                  htmlFor={`${id}-requeue-reason`}
                >
                  <textarea
                    id={`${id}-requeue-reason`}
                    rows={3}
                    minLength={10}
                    maxLength={500}
                    required
                    value={requeueReason}
                    onChange={(e) => setRequeueReason(e.target.value)}
                  />
                </Field>
                <div className="tag-row">
                  <Button kind="quiet" onClick={() => setRequeueing(null)}>
                    {t("supervisionView.requeue.cancel")}
                  </Button>
                  <Button
                    kind="primary"
                    disabled={pending || requeueReason.trim().length < 10}
                    onClick={() => void requeue(requeueing.eventId)}
                  >
                    {t("supervisionView.requeue.confirm")}
                  </Button>
                </div>
              </Notice>
            )}
          </>
        )}
        {settings && (
          <LearnerBudgetCard
            port={settings.port}
            workspaceId={settings.workspaceId}
            enrollmentId={enrollmentId}
          />
        )}
      </div>
    </Card>
  );
}
