import { useId, useRef, useState } from "react";
import { KeyRound, UserMinus, UserPlus } from "lucide-react";
import type { AdminClient, CourseWorkspace } from "../domain/contracts";
import {
  peopleErrorMessage,
  roleDescriptions,
  roles,
  type Person,
  type Role,
  type SignInReceipt,
} from "../domain/people";
import { useRemote } from "../hooks/useAdmin";
import {
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  Field,
  Loading,
  Notice,
  when,
} from "../components/ui";

type Port = NonNullable<AdminClient["people"]>;
const assignable = (actorRole: Role) =>
  roles.filter((r) => actorRole === "owner" || !["owner", "admin"].includes(r));

export function PeopleView({
  data,
  client,
}: {
  data: CourseWorkspace;
  client: AdminClient;
}) {
  if (!client.people)
    return (
      <Card title="People">
        <EmptyState title="People administration is not available here">
          This workspace client does not manage memberships. Use a connected
          administration session.
        </EmptyState>
      </Card>
    );
  if (!data.course.workspaceId)
    return (
      <Card title="People">
        <EmptyState title="Workspace unavailable">
          This course record does not identify its workspace.
        </EmptyState>
      </Card>
    );
  return <PeopleAdministration port={client.people} workspaceId={data.course.workspaceId} />;
}

function PeopleAdministration({ port, workspaceId }: { port: Port; workspaceId: string }) {
  const list = useRemote((signal) => port.list(workspaceId, signal), [port, workspaceId]);
  const keys = useRef(new Map<string, string>());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const [message, setMessage] = useState<string>();
  const [issued, setIssued] = useState<{ name: string; receipt: SignInReceipt }>();
  const [inviting, setInviting] = useState(false);
  const [removing, setRemoving] = useState<Person>();
  const [roleDraft, setRoleDraft] = useState<Record<string, Role>>({});
  async function run<T>(fingerprint: string, command: (key: string) => Promise<T>, success: string) {
    if (pending) return;
    let key = keys.current.get(fingerprint);
    if (!key) {
      key = "admin-" + crypto.randomUUID();
      keys.current.set(fingerprint, key);
    }
    setPending(true);
    setError(undefined);
    setMessage(undefined);
    try {
      const result = await command(key);
      keys.current.delete(fingerprint);
      setMessage(success);
      list.reload();
      return result;
    } catch (caught) {
      setError(caught);
    } finally {
      setPending(false);
    }
  }
  if (list.loading) return <Loading label="Loading people…" />;
  if (list.error || !list.data)
    return <Notice tone="red">{peopleErrorMessage(list.error)}</Notice>;
  const { actorRole, people } = list.data;
  return (
    <div className="page-stack">
      <Notice tone="blue" title="Access follows workspace membership">
        Roles apply to every course in this workspace. Removing someone ends
        their access but keeps their learning records. Sign-in codes are shown
        once, expire after 10 minutes and work only once.
      </Notice>
      <div aria-live="polite">
        {message && <Notice tone="green">{message}</Notice>}
        {error !== undefined && <Notice tone="red">{peopleErrorMessage(error)}</Notice>}
      </div>
      {issued?.receipt.signIn && (
        <Card title={`Sign-in code for ${issued.name}`} eyebrow="Shown once">
          <p>
            Share this privately. It expires in{" "}
            {issued.receipt.signIn.expiresInMinutes} minutes and works once.
            Learners open the link; staff can paste the code at{" "}
            <span className="mono">{issued.receipt.signIn.adminPath}</span>.
          </p>
          <Field label="Learner sign-in link" htmlFor="issued-link">
            <input id="issued-link" readOnly value={issued.receipt.signIn.learnerUrl} onFocus={(e) => e.currentTarget.select()} />
          </Field>
          <Field label="One-time code" htmlFor="issued-code">
            <input id="issued-code" readOnly className="mono" value={issued.receipt.signIn.code} onFocus={(e) => e.currentTarget.select()} />
          </Field>
          <Button onClick={() => setIssued(undefined)}>I have shared it — hide the code</Button>
        </Card>
      )}
      {issued && !issued.receipt.signIn && (
        <Notice tone="gold">
          This invitation was already created by an earlier request. Its code
          is not shown again; issue a new sign-in code instead.
        </Notice>
      )}
      <Card
        title="Workspace members"
        eyebrow={`${people.length} ${people.length === 1 ? "person" : "people"}`}
        actions={
          <Button kind="primary" disabled={pending} onClick={() => setInviting(true)}>
            <UserPlus size={16} aria-hidden="true" /> Invite person
          </Button>
        }
      >
        <div className="table-wrap">
          <table className="people-table">
            <caption className="sr-only">Workspace members and roles</caption>
            <thead>
              <tr>
                <th scope="col">Person</th>
                <th scope="col">Role</th>
                <th scope="col">Enrollments</th>
                <th scope="col">Last sign-in</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {people.map((person) => {
                const draft = roleDraft[person.userId] ?? person.role;
                return (
                  <tr key={person.userId}>
                    <th scope="row">
                      {person.displayName}
                      {person.self && <Badge tone="blue">you</Badge>}
                      <small className="people-meta">
                        Joined {when(person.joinedAt)}
                        {person.addedBy ? ` · added by ${person.addedBy}` : ""}
                      </small>
                    </th>
                    <td data-label="Role">
                      {person.canChangeRole ? (
                        <div className="people-role">
                          <label className="sr-only" htmlFor={`role-${person.userId}`}>
                            Role for {person.displayName}
                          </label>
                          <select
                            id={`role-${person.userId}`}
                            value={draft}
                            disabled={pending}
                            onChange={(e) =>
                              setRoleDraft({ ...roleDraft, [person.userId]: e.target.value as Role })
                            }
                          >
                            {assignable(actorRole)
                              .concat(assignable(actorRole).includes(person.role) ? [] : [person.role])
                              .map((r) => (
                                <option key={r} value={r}>
                                  {r}
                                </option>
                              ))}
                          </select>
                          {draft !== person.role && (
                            <Button
                              disabled={pending}
                              onClick={() =>
                                void run(
                                  `role:${person.userId}:${person.role}:${draft}`,
                                  (key) =>
                                    port.changeRole(workspaceId, person.userId, { role: draft, expectedRole: person.role }, key),
                                  `${person.displayName} is now ${draft}.`,
                                ).then(() => setRoleDraft(({ [person.userId]: _, ...rest }) => rest))
                              }
                            >
                              Save role
                            </Button>
                          )}
                        </div>
                      ) : (
                        <Badge>{person.role}</Badge>
                      )}
                    </td>
                    <td data-label="Enrollments">{person.enrollments}</td>
                    <td data-label="Last sign-in">{person.lastSignInAt ? when(person.lastSignInAt) : "Never"}</td>
                    <td className="people-actions">
                      <div className="tag-row">
                        {person.canIssueSignIn && (
                          <Button
                            kind="quiet"
                            disabled={pending}
                            onClick={() =>
                              void run(`signin:${person.userId}:${Date.now()}`, (key) => port.issueSignIn(workspaceId, person.userId, key), "New sign-in code issued.").then(
                                (receipt) => receipt && setIssued({ name: person.displayName, receipt }),
                              )
                            }
                          >
                            <KeyRound size={16} aria-hidden="true" /> New sign-in code
                          </Button>
                        )}
                        {person.canRevoke && (
                          <Button kind="danger" disabled={pending} onClick={() => setRemoving(person)}>
                            <UserMinus size={16} aria-hidden="true" /> Remove
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
      {inviting && (
        <InviteDialog
          actorRole={actorRole}
          pending={pending}
          onClose={() => setInviting(false)}
          onSubmit={async (input) => {
            const receipt = await run(`invite:${input.displayName}:${input.role}`, (key) => port.invite(workspaceId, input, key), `${input.displayName} was invited as ${input.role}.`);
            if (receipt) {
              setIssued({ name: input.displayName, receipt });
              setInviting(false);
            }
          }}
        />
      )}
      {removing && (
        <RemoveDialog
          person={removing}
          pending={pending}
          onClose={() => setRemoving(undefined)}
          onSubmit={async (reason) => {
            const done = await run(
              `remove:${removing.userId}:${reason}`,
              (key) => port.revoke(workspaceId, removing.userId, { expectedRole: removing.role, reason }, key),
              `${removing.displayName} no longer has access. Their learning records were kept.`,
            );
            if (done) setRemoving(undefined);
          }}
        />
      )}
    </div>
  );
}

function InviteDialog({
  actorRole,
  pending,
  onClose,
  onSubmit,
}: {
  actorRole: Role;
  pending: boolean;
  onClose: () => void;
  onSubmit: (input: { displayName: string; role: Role }) => void;
}) {
  const id = useId();
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>("learner");
  return (
    <Dialog title="Invite a person" onClose={onClose} pending={pending}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit({ displayName: name.trim(), role });
        }}
      >
        <Field label="Display name" htmlFor={id + "-name"} hint="Shown to staff and in the learner's header.">
          <input id={id + "-name"} required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <fieldset className="stack">
          <legend>Role</legend>
          {assignable(actorRole).map((r) => (
            <label className="check-label" key={r}>
              <input type="radio" name={id + "-role"} checked={role === r} onChange={() => setRole(r)} />
              <span>
                <strong>{r}</strong> — {roleDescriptions[r]}
              </span>
            </label>
          ))}
        </fieldset>
        <div className="tag-row">
          <Button kind="primary" type="submit" disabled={pending || !name.trim()}>
            Invite and create sign-in code
          </Button>
          <Button type="button" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function RemoveDialog({
  person,
  pending,
  onClose,
  onSubmit,
}: {
  person: Person;
  pending: boolean;
  onClose: () => void;
  onSubmit: (reason: string) => void;
}) {
  const id = useId();
  const [reason, setReason] = useState("");
  return (
    <Dialog title={`Remove ${person.displayName}`} onClose={onClose} pending={pending}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(reason.trim());
        }}
      >
        <p>
          They lose access to this workspace immediately. Enrollments, evidence
          and history are kept for audit and can be exported or deleted
          separately.
        </p>
        <Field label="Reason" htmlFor={id + "-reason"} hint="10–1000 characters. Kept in the audit history.">
          <textarea id={id + "-reason"} rows={3} minLength={10} maxLength={1000} required value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <div className="tag-row">
          <Button kind="danger" type="submit" disabled={pending}>
            Remove access
          </Button>
          <Button type="button" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
