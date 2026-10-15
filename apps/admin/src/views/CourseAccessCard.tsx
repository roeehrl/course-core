import { useId, useRef, useState } from "react";
import { CalendarClock } from "lucide-react";
import type { AdminClient } from "../domain/contracts";
import { grantableRoles, peopleErrorMessage, type GrantableRole, type Person } from "../domain/people";
import { useRemote } from "../hooks/useAdmin";
import { Badge, Button, Card, EmptyState, Field, Loading, Notice, when } from "../components/ui";

type Port = NonNullable<AdminClient["people"]>;
const REASON = /^[a-z][a-z0-9_]{0,63}$/;

/** Time-limited access to this one course for people whose workspace role is course_scoped.
 * The server checks the grant on every request: expiry and revocation end access at once. */
export function CourseAccessCard({ port, workspaceId, course, people }: { port: Port; workspaceId: string; course: { id: string; title: string }; people: Person[] }) {
  const id = useId();
  const list = useRemote((signal) => port.grants!(workspaceId, signal), [port, workspaceId]);
  const scoped = people.filter((p) => p.role === "course_scoped" && !p.self);
  const [userId, setUserId] = useState("");
  const [role, setRole] = useState<GrantableRole>("observer");
  const [days, setDays] = useState("30");
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const [message, setMessage] = useState("");
  const keys = useRef(new Map<string, string>());
  const keyFor = (fingerprint: string) => {
    let key = keys.current.get(fingerprint);
    if (!key) keys.current.set(fingerprint, (key = "grant-" + crypto.randomUUID()));
    return key;
  };
  async function run(fingerprint: string, command: (key: string) => Promise<unknown>, success: string) {
    setPending(true);
    setError(undefined);
    setMessage("");
    try {
      await command(keyFor(fingerprint));
      keys.current.delete(fingerprint);
      setMessage(success);
      list.reload();
      return true;
    } catch (caught) {
      setError(caught);
      return false;
    } finally {
      setPending(false);
    }
  }
  const name = (userId: string) => people.find((p) => p.userId === userId)?.displayName ?? "Former member";
  const dayCount = Number(days);
  const valid = userId && REASON.test(reason) && Number.isInteger(dayCount) && dayCount >= 1 && dayCount <= 365;
  const grants = (list.data?.grants ?? []).filter((g) => g.catalogId === course.id);
  return (
    <Card title={`Course access: ${course.title}`} eyebrow="Course-scoped people">
      <p className="muted">
        People whose workspace role is <span className="mono">course_scoped</span> see only the courses granted here, with the role
        given, until the grant expires or is revoked.
      </p>
      <div aria-live="polite">
        {message && <Notice tone="green">{message}</Notice>}
        {error !== undefined && <Notice tone="red">{peopleErrorMessage(error)}</Notice>}
      </div>
      {scoped.length === 0 ? (
        <Notice tone="blue">No course-scoped members yet. Invite someone or change a role to course_scoped first.</Notice>
      ) : (
        <form
          className="input-grid grant-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!valid) return;
            const input = { userId, catalogId: course.id, role, expiresAt: new Date(Date.now() + dayCount * 86_400_000).toISOString(), reasonCode: reason };
            void run(`grant:${userId}:${course.id}:${role}:${days}:${reason}`, (key) => port.grant!(workspaceId, input, key), `${name(userId)} can open ${course.title} as ${role} for ${dayCount} days.`).then(
              (done) => done && setReason(""),
            );
          }}
        >
          <Field label="Person" htmlFor={`${id}-person`}>
            <select id={`${id}-person`} value={userId} onChange={(e) => setUserId(e.target.value)}>
              <option value="">Choose a person</option>
              {scoped.map((p) => (
                <option key={p.userId} value={p.userId}>
                  {p.displayName}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Role on this course" htmlFor={`${id}-role`}>
            <select id={`${id}-role`} value={role} onChange={(e) => setRole(e.target.value as GrantableRole)}>
              {grantableRoles.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Days of access" htmlFor={`${id}-days`} hint="1 to 365 days.">
            <input id={`${id}-days`} type="number" min={1} max={365} value={days} onChange={(e) => setDays(e.target.value)} />
          </Field>
          <Field label="Reason code" htmlFor={`${id}-reason`} hint="Lower case letters, digits and _, e.g. support_case.">
            <input id={`${id}-reason`} value={reason} maxLength={64} onChange={(e) => setReason(e.target.value.trim())} />
          </Field>
          <div className="wide">
            <Button kind="primary" type="submit" disabled={pending || !valid}>
              <CalendarClock size={16} aria-hidden="true" /> Grant course access
            </Button>
          </div>
        </form>
      )}
      {list.loading ? (
        <Loading label="Loading course access…" />
      ) : list.error ? (
        <Notice tone="red">{peopleErrorMessage(list.error)}</Notice>
      ) : grants.length === 0 ? (
        <EmptyState title="No course access granted">Grants for this course appear here, including expired and revoked ones.</EmptyState>
      ) : (
        <div className="table-wrap">
          <table className="people-table">
            <caption className="sr-only">Course access grants</caption>
            <thead>
              <tr>
                <th scope="col">Person</th>
                <th scope="col">Role</th>
                <th scope="col">Access</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {grants.map((g) => (
                <tr key={g.grantId}>
                  <th scope="row">
                    {name(g.userId)}
                    <small className="people-meta mono">{g.reasonCode}</small>
                  </th>
                  <td data-label="Role">
                    <Badge>{g.role}</Badge>
                  </td>
                  <td data-label="Access">
                    <Badge tone={g.state === "active" ? "green" : "neutral"}>{g.state}</Badge>{" "}
                    <small>
                      {g.state === "revoked" ? `revoked ${when(g.revokedAt!)} (${g.revokeReasonCode})` : `${g.state === "active" ? "until" : "ended"} ${when(g.expiresAt)}`}
                    </small>
                  </td>
                  <td className="people-actions">
                    {g.state === "active" && (
                      <Button
                        kind="danger"
                        disabled={pending}
                        onClick={() => void run(`revoke:${g.grantId}`, (key) => port.revokeGrant!(workspaceId, g.grantId, "access_ended", key), `Course access for ${name(g.userId)} was revoked.`)}
                      >
                        Revoke access for {name(g.userId)}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
