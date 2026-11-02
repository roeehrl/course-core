import type {
  AdminClient,
  AdminSession,
  CourseWorkspace,
} from "../domain/contracts";
import type { CourseOverview } from "../domain/overview";
import { useRemote } from "../hooks/useAdmin";
import { Badge, Button, Card, Notice, SkeletonRows } from "../components/ui";
import { useI18n } from "../i18n";
import { CoursesView } from "./CoursesView";
import { AiChecks, queueKeys, SupervisorHealthCard } from "./OverviewView";
import "./workspacePages.css";

type CourseSummary = AdminSession["courses"][number];
/** At most this many courses are counted for the queue (one overview read each). */
const QUEUE_COURSES = 50;

/**
 * The workspace home: every course, what is waiting for staff in each of them, and how the AI
 * services and supervision are doing (both are about every course, not one).
 */
export function CoursesHome({
  client,
  data,
  courses,
  lastCourseId,
  titleOf,
  addReason,
  pending,
  onAdd,
  onOpen,
  onOpenAiServices,
}: {
  client: AdminClient;
  /** The course the workspace pages read the workspace through (the last one opened). */
  data: CourseWorkspace;
  courses: CourseSummary[];
  lastCourseId: string | null;
  titleOf: (course: CourseSummary) => string;
  addReason?: string | undefined;
  pending: boolean;
  onAdd: () => void;
  onOpen: (courseId: string, page?: "overview") => void;
  onOpenAiServices: () => void;
}) {
  const aiServices =
    client.mode === "connected" &&
    data.permissions.includes("provider.configure") &&
    data.course.workspaceId &&
    client.aiServices
      ? { port: client.aiServices, workspaceId: data.course.workspaceId }
      : null;
  return (
    <div className="page-stack">
      <CoursesView
        courses={courses}
        currentCourseId={lastCourseId ?? ""}
        titleOf={titleOf}
        addReason={addReason}
        pending={pending}
        onAdd={onAdd}
        onOpen={(id) => onOpen(id)}
      />
      {client.overview && (
        <WaitingForStaff
          port={client.overview}
          courses={courses.slice(0, QUEUE_COURSES)}
          healthFrom={data.course.id}
          titleOf={titleOf}
          pending={pending}
          onOpen={(id) => onOpen(id, "overview")}
        />
      )}
      {aiServices && (
        <AiChecks
          port={aiServices.port}
          workspaceId={aiServices.workspaceId}
          onOpen={onOpenAiServices}
        />
      )}
    </div>
  );
}

function WaitingForStaff({
  port,
  courses,
  healthFrom,
  titleOf,
  pending,
  onOpen,
}: {
  port: NonNullable<AdminClient["overview"]>;
  courses: CourseSummary[];
  healthFrom: string;
  titleOf: (course: CourseSummary) => string;
  pending: boolean;
  onOpen: (courseId: string) => void;
}) {
  const i18n = useI18n();
  const t = i18n.t;
  const ids = courses.map((course) => course.id).join(" ");
  const read = useRemote(
    (signal) =>
      Promise.allSettled(courses.map((course) => port.load(course.id, signal))),
    [port, ids],
  );
  const results = read.data ?? [];
  const overviews = new Map<string, CourseOverview>();
  results.forEach((result, index) => {
    if (result.status === "fulfilled")
      overviews.set(courses[index]!.id, result.value);
  });
  const unread = results.length - overviews.size;
  const rows = courses
    .map((course) => {
      const queue = overviews.get(course.id)?.approvalQueue;
      if (!queue) return null;
      const items = (Object.keys(queueKeys) as (keyof typeof queueKeys)[])
        .filter((key) => queue[key] > 0)
        .map((key) => ({ key, label: t(queueKeys[key]), count: queue[key] }));
      const total = items.reduce((sum, item) => sum + item.count, 0);
      return total ? { course, items, total } : null;
    })
    .filter((row) => row !== null);
  // Supervision health is the same for every course of the workspace: read with the last one.
  const health =
    overviews.get(healthFrom)?.supervisorHealth ??
    [...overviews.values()].find((o) => o.supervisorHealth)?.supervisorHealth;
  return (
    <>
      <Card title={t("coursesView.queue.title")}>
        <p className="muted">{t("coursesView.queue.intro")}</p>
        {read.loading ? (
          <SkeletonRows label={t("coursesView.queue.loading")} rows={3} />
        ) : rows.length === 0 ? (
          <p className="courses-queue-empty">{t("coursesView.queue.empty")}</p>
        ) : (
          <div
            className="table-wrap"
            tabIndex={0}
            role="region"
            aria-label={t("coursesView.queue.title")}
          >
            <table className="data-table courses-queue-table">
              <caption className="sr-only">
                {t("coursesView.queue.title")}
              </caption>
              <thead>
                <tr>
                  <th scope="col">{t("coursesView.queue.col.course")}</th>
                  <th scope="col" className="num">
                    {t("coursesView.queue.col.total")}
                  </th>
                  <th scope="col">{t("coursesView.queue.col.items")}</th>
                  <th scope="col">
                    <span className="sr-only">
                      {t("coursesView.col.actions")}
                    </span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ course, items, total }) => {
                  const title = titleOf(course);
                  return (
                    <tr key={course.id}>
                      <th scope="row">
                        <bdi>{title}</bdi>
                      </th>
                      <td className="num">
                        <Badge tone="gold">{i18n.number(total)}</Badge>
                      </td>
                      <td>
                        <ul className="courses-queue-items">
                          {items.map((item) => (
                            <li key={item.key}>
                              {t("coursesView.queue.item", {
                                label: item.label,
                                count: i18n.number(item.count),
                              })}
                            </li>
                          ))}
                        </ul>
                      </td>
                      <td className="courses-actions" data-label="">
                        <Button
                          aria-label={t("coursesView.queue.openCourse", {
                            title,
                          })}
                          disabled={pending}
                          onClick={() => onOpen(course.id)}
                        >
                          {t("coursesView.queue.open")}
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {!read.loading && unread > 0 && (
          <Notice tone="gold">
            {t("coursesView.queue.partial", { count: unread })}
          </Notice>
        )}
      </Card>
      {health && <SupervisorHealthCard health={health} />}
    </>
  );
}
