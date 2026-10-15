import { useId, useRef, useState } from "react";
import { Pause, Play, Square } from "lucide-react";
import type { AdminClient, CourseWorkspace } from "../domain/contracts";
import {
  supervisionErrorMessage,
  supervisionReasons,
  type SupervisionAction,
  type SupervisionPort,
  type SupervisionState,
} from "../domain/supervision";
import { useRemote } from "../hooks/useAdmin";
import { Badge, Button, Card, EmptyState, Field, Loading, Notice, when } from "../components/ui";

const stateTone: Record<SupervisionState, "green" | "gold" | "red"> = { active: "green", paused: "gold", stopped: "red" };
const stateText: Record<SupervisionState, string> = {
  active: "AI supervision is running for this learner.",
  paused: "Paused: no new AI calls or changes. Work already started finishes its current call, then waits.",
  stopped: "Stopped: every unfinished AI job was cancelled and nothing more is published until you resume.",
};

/** Staff pause, stop and resume of one learner's AI supervision (companion, planning, research,
 * reviewer drafts and course-made media). Server authorization and the stored control decide;
 * these controls only send the request. */
export function SupervisionView({ data, client }: { data: CourseWorkspace; client: AdminClient }) {
  const id = useId();
  const [enrollmentId, setEnrollmentId] = useState("");
  if (!client.supervision)
    return (
      <Card title="AI supervision">
        <EmptyState title="Supervision controls are not available here">Use a connected administration session.</EmptyState>
      </Card>
    );
  const learners = data.enrollments.filter((e) => e.status !== "erased");
  return (
    <div className="page-stack">
      <Card title="Choose a learner">
        <Field label="Learner" htmlFor={`${id}-learner`}>
          <select id={`${id}-learner`} value={enrollmentId} onChange={(e) => setEnrollmentId(e.target.value)}>
            <option value="">Choose a learner</option>
            {learners.map((e) => (
              <option key={e.id} value={e.id}>
                {e.profile.displayName}
              </option>
            ))}
          </select>
        </Field>
      </Card>
      {enrollmentId && <SupervisionPanel key={enrollmentId} port={client.supervision} enrollmentId={enrollmentId} />}
    </div>
  );
}

function SupervisionPanel({ port, enrollmentId }: { port: SupervisionPort; enrollmentId: string }) {
  const id = useId();
  const view = useRemote((signal) => port.overview(enrollmentId, signal), [port, enrollmentId]);
  const [reason, setReason] = useState("");
  const [confirmStop, setConfirmStop] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const [message, setMessage] = useState("");
  // One key per intended change: a retry of the same change replays it.
  const keys = useRef(new Map<string, string>());
  if (view.loading && !view.data) return <Loading label="Loading AI supervision…" />;
  if (view.error || !view.data) return <Notice tone="red">{supervisionErrorMessage(view.error)}</Notice>;
  const o = view.data, state = o.control.state;
  async function send(action: SupervisionAction) {
    const fingerprint = `${action}:${o.control.revision}:${reason}`;
    let key = keys.current.get(fingerprint);
    if (!key) keys.current.set(fingerprint, (key = "supervision-" + crypto.randomUUID()));
    setPending(true);
    setError(undefined);
    setMessage("");
    try {
      const result = await port.control(enrollmentId, action, { idempotencyKey: key, expectedRevision: o.control.revision, ...(reason ? { reasonCode: reason } : {}) });
      keys.current.delete(fingerprint);
      setConfirmStop(false);
      setMessage(
        !result.changed
          ? "Nothing changed: that was already in force."
          : result.state === "stopped"
            ? `Supervision stopped. ${result.cancelledJobs} unfinished job(s) are being cancelled.`
            : result.state === "paused"
              ? "Supervision paused."
              : "Supervision resumed.",
      );
      view.reload();
    } catch (caught) {
      setError(caught);
    } finally {
      setPending(false);
    }
  }
  return (
    <Card title="AI supervision" actions={<Badge tone={stateTone[state]}>{state}</Badge>}>
      <div className="stack">
        <p>{stateText[state]}</p>
        {o.control.changedAt && (
          <p className="muted">
            Changed {when(o.control.changedAt)}
            {o.control.reasonCode ? ` · ${o.control.reasonCode.replaceAll("_", " ")}` : ""} · revision {o.control.revision}
          </p>
        )}
        <div aria-live="polite">
          {message && <Notice tone="green">{message}</Notice>}
          {error !== undefined && <Notice tone="red">{supervisionErrorMessage(error)}</Notice>}
        </div>
        {o.pendingSignals > 0 && (
          <Notice tone="blue">{o.pendingSignals} wake-up signal(s) still on their way to running jobs. The stored state already applies.</Notice>
        )}
        {o.canControl ? (
          <>
            <Field label="Reason (optional)" htmlFor={`${id}-reason`}>
              <select id={`${id}-reason`} value={reason} onChange={(e) => setReason(e.target.value)}>
                <option value="">No reason given</option>
                {supervisionReasons.map((r) => (
                  <option key={r} value={r}>
                    {r.replaceAll("_", " ")}
                  </option>
                ))}
              </select>
            </Field>
            <div className="tag-row">
              {state === "active" && (
                <Button disabled={pending} onClick={() => void send("pause")}>
                  <Pause size={16} aria-hidden="true" /> Pause supervision
                </Button>
              )}
              {state !== "active" && (
                <Button kind="primary" disabled={pending} onClick={() => void send("resume")}>
                  <Play size={16} aria-hidden="true" /> Resume supervision
                </Button>
              )}
              {state !== "stopped" && !confirmStop && (
                <Button kind="danger" disabled={pending} onClick={() => setConfirmStop(true)}>
                  <Square size={16} aria-hidden="true" /> Stop supervision
                </Button>
              )}
            </div>
            {confirmStop && (
              <Notice tone="gold" title="Stop cancels unfinished work">
                Every unfinished AI job for this learner is cancelled and will not resume; new events start fresh only after you
                resume.
                <div className="tag-row">
                  <Button kind="danger" disabled={pending} onClick={() => void send("stop")}>
                    Confirm stop
                  </Button>
                  <Button kind="quiet" onClick={() => setConfirmStop(false)}>
                    Keep running
                  </Button>
                </div>
              </Notice>
            )}
          </>
        ) : (
          <p className="muted">Your role can see supervision but not change it.</p>
        )}
        <h3 className="section-title">Unfinished jobs</h3>
        {o.jobs.length === 0 ? (
          <p className="muted">No unfinished AI jobs for this learner.</p>
        ) : (
          <div className="table-wrap">
            <table className="people-table">
              <caption className="sr-only">Unfinished AI jobs</caption>
              <thead>
                <tr>
                  <th scope="col">Role</th>
                  <th scope="col">State</th>
                  <th scope="col">Started</th>
                </tr>
              </thead>
              <tbody>
                {o.jobs.map((j) => (
                  <tr key={j.id}>
                    <th scope="row">{j.role}</th>
                    <td data-label="State">
                      <Badge>{j.state.replaceAll("_", " ")}</Badge> {j.held && <Badge tone="gold">held</Badge>}{" "}
                      {j.cancellationRequested && <Badge tone="red">cancelling</Badge>}
                    </td>
                    <td data-label="Started">{when(j.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Card>
  );
}
