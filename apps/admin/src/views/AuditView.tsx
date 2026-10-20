import { useId, useState } from "react";
import type { AdminClient, CourseWorkspace } from "../domain/contracts";
import {
  overviewErrorMessage,
  type AuditPage,
  type AuditQuery,
} from "../domain/overview";
import { useRemote } from "../hooks/useAdmin";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Loading,
  Notice,
  when,
} from "../components/ui";

/** Workspace audit log. Staff and system actions show what changed; learner and agent
 * events show only that they happened (learner privacy). */
export function AuditView({
  data,
  client,
}: {
  data: CourseWorkspace;
  client: AdminClient;
}) {
  if (!client.audit || !data.course.workspaceId)
    return (
      <Card title="Audit log">
        <EmptyState title="The audit log is not available here">
          Use a connected administration session.
        </EmptyState>
      </Card>
    );
  if (!data.permissions.includes("audit.read"))
    return (
      <Notice tone="gold">
        Your role cannot read the audit log. Owners, admins and support
        observers can.
      </Notice>
    );
  return <AuditLog port={client.audit} workspaceId={data.course.workspaceId} />;
}

function AuditLog({
  port,
  workspaceId,
}: {
  port: NonNullable<AdminClient["audit"]>;
  workspaceId: string;
}) {
  const id = useId();
  const [actorKind, setActorKind] = useState<AuditQuery["actorKind"] | "">("");
  const [pages, setPages] = useState<string[]>([]);
  const before = pages.at(-1);
  const page = useRemote(
    (signal) =>
      port.list(
        workspaceId,
        {
          ...(before ? { before } : {}),
          ...(actorKind ? { actorKind } : {}),
          limit: 50,
        },
        signal,
      ),
    [port, workspaceId, actorKind, before],
  );
  return (
    <div className="page-stack">
      <Notice tone="blue" title="Learner privacy">
        Staff and system actions show their details. Learner and AI events show
        only that they happened; their content stays with the learner.
      </Notice>
      <Card title="Workspace activity">
        <div className="tag-row audit-controls">
          <Field label="Who acted" htmlFor={`${id}-kind`}>
            <select
              id={`${id}-kind`}
              value={actorKind}
              onChange={(e) => {
                setActorKind(e.target.value as AuditQuery["actorKind"] | "");
                setPages([]);
              }}
            >
              <option value="">Everyone</option>
              <option value="staff">Staff</option>
              <option value="system">System</option>
              <option value="learner">Learners</option>
              <option value="agent">AI agents</option>
            </select>
          </Field>
        </div>
        {page.loading ? (
          <Loading label="Loading the audit log…" />
        ) : page.error || !page.data ? (
          <Notice tone="red">{overviewErrorMessage(page.error)}</Notice>
        ) : page.data.events.length === 0 ? (
          <EmptyState title="No activity">
            Nothing matches this filter.
          </EmptyState>
        ) : (
          <AuditTable page={page.data} />
        )}
        <div className="tag-row">
          {pages.length > 0 && (
            <Button onClick={() => setPages(pages.slice(0, -1))}>Newer</Button>
          )}
          {page.data?.nextBefore && (
            <Button
              onClick={() => setPages([...pages, page.data!.nextBefore!])}
            >
              Older
            </Button>
          )}
        </div>
      </Card>
    </div>
  );
}

function AuditTable({ page }: { page: AuditPage }) {
  return (
    <div
      className="table-wrap"
      tabIndex={0}
      role="region"
      aria-label="Audit events"
    >
      <table className="people-table audit-table">
        <caption className="sr-only">Audit events, newest first</caption>
        <thead>
          <tr>
            <th scope="col">Event</th>
            <th scope="col">Who</th>
            <th scope="col">When</th>
            <th scope="col">Details</th>
          </tr>
        </thead>
        <tbody>
          {page.events.map((e) => (
            <tr key={e.id}>
              <th scope="row" className="mono">
                {e.type}
              </th>
              <td data-label="Who">
                <Badge tone={e.actorKind === "staff" ? "blue" : "neutral"}>
                  {e.actorKind}
                </Badge>{" "}
                {e.actor ?? ""}
              </td>
              <td data-label="When">{when(e.at)}</td>
              <td data-label="Details">
                {e.payloadWithheld ? (
                  <span className="muted">
                    Details withheld{e.enrollmentId ? " · learner record" : ""}
                  </span>
                ) : (
                  <code className="audit-payload">
                    {JSON.stringify(e.payload)}
                  </code>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
