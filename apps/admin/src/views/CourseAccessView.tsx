import type { AdminClient, CourseWorkspace } from "../domain/contracts";
import { peopleErrorMessage } from "../domain/people";
import { useRemote } from "../hooks/useAdmin";
import { Card, EmptyState, Notice, SkeletonRows } from "../components/ui";
import { useT } from "../i18n";
import { CourseAccessCard } from "./CourseAccessCard";

type Port = NonNullable<AdminClient["people"]>;

/**
 * Time-limited access to this course for people whose workspace role is course-only: a course
 * page. Workspace members, invitations and roles stay on the workspace's People & roles page.
 */
export function CourseAccessView({
  data,
  client,
}: {
  data: CourseWorkspace;
  client: AdminClient;
}) {
  const t = useT();
  const port = client.people;
  if (
    !port?.grants ||
    !port.grant ||
    !port.revokeGrant ||
    !data.course.workspaceId
  )
    return (
      <Card title={t("peopleView.title")}>
        <EmptyState title={t("peopleView.unavailable.title")}>
          {t("peopleView.unavailable.body")}
        </EmptyState>
      </Card>
    );
  return (
    <CourseAccess
      port={port}
      workspaceId={data.course.workspaceId}
      course={{ id: data.course.id, title: data.course.title }}
    />
  );
}

function CourseAccess({
  port,
  workspaceId,
  course,
}: {
  port: Port;
  workspaceId: string;
  course: { id: string; title: string };
}) {
  const t = useT();
  const list = useRemote(
    (signal) => port.list(workspaceId, signal),
    [port, workspaceId],
  );
  if (list.loading)
    return <SkeletonRows label={t("peopleView.loading")} rows={6} />;
  if (list.error || !list.data)
    return <Notice tone="red">{peopleErrorMessage(list.error, t)}</Notice>;
  return (
    <div className="page-stack">
      <CourseAccessCard
        port={port}
        workspaceId={workspaceId}
        course={course}
        people={list.data.people}
      />
    </div>
  );
}
