import { PackagePlus } from "lucide-react";
import type { AdminSession } from "../domain/contracts";
import { Badge, Button, Card, EmptyState, PageIntro } from "../components/ui";
import { useFormatters, useI18n } from "../i18n";
import "./workspacePages.css";

type CourseSummary = AdminSession["courses"][number];

/**
 * Every course this person can administer, in one list: the workspace-level page the course
 * switcher's "Manage courses" opens. Each row opens its course; "Add a course" installs another.
 */
export function CoursesView({
  courses,
  currentCourseId,
  titleOf,
  addReason,
  pending = false,
  onAdd,
  onOpen,
}: {
  courses: CourseSummary[];
  currentCourseId: string;
  /** The title to show (the open course's may be newer than the session's). */
  titleOf: (course: CourseSummary) => string;
  /** Why adding a course is not possible here; undefined when it is. */
  addReason?: string | undefined;
  pending?: boolean;
  onAdd: () => void;
  onOpen: (courseId: string) => void;
}) {
  const i18n = useI18n();
  const t = i18n.t;
  const { day } = useFormatters();
  // Several workspaces (course-scoped access elsewhere) name each course's workspace.
  const manyWorkspaces =
    new Set(courses.map((course) => course.workspaceId ?? "")).size > 1;
  const add = (
    <Button
      kind="primary"
      onClick={onAdd}
      disabled={pending || addReason !== undefined}
      reason={addReason ?? ""}
    >
      <PackagePlus size={16} aria-hidden="true" />
      {t("coursesView.add")}
    </Button>
  );
  return (
    <div className="page-stack">
      <PageIntro action={add}>{t("coursesView.intro")}</PageIntro>
      <Card>
        {courses.length === 0 ? (
          <EmptyState title={t("coursesView.empty.title")}>
            {t("coursesView.empty.body")}
          </EmptyState>
        ) : (
          <div
            className="table-wrap"
            tabIndex={0}
            role="region"
            aria-label={t("coursesView.listLabel")}
          >
            <table className="data-table courses-table">
              <caption className="sr-only">
                {t("coursesView.listLabel")}
              </caption>
              <thead>
                <tr>
                  <th scope="col">{t("coursesView.col.course")}</th>
                  <th scope="col">{t("coursesView.col.live")}</th>
                  <th scope="col" className="num">
                    {t("coursesView.col.learners")}
                  </th>
                  <th scope="col">{t("coursesView.col.updated")}</th>
                  <th scope="col">
                    <span className="sr-only">
                      {t("coursesView.col.actions")}
                    </span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {courses.map((course) => {
                  const title = titleOf(course);
                  const current = course.id === currentCourseId;
                  return (
                    <tr key={course.id}>
                      <th scope="row">
                        <bdi>{title}</bdi>
                        {current && (
                          <>
                            {" "}
                            <Badge tone="blue">
                              {t("coursesView.current")}
                            </Badge>
                          </>
                        )}
                        {manyWorkspaces && course.workspaceTitle && (
                          <small className="muted courses-workspace" dir="auto">
                            {course.workspaceTitle}
                          </small>
                        )}
                      </th>
                      <td>
                        {course.liveVersion ? (
                          <bdi>{course.liveVersion}</bdi>
                        ) : course.liveVersion === null ? (
                          <span className="muted">
                            {t("coursesView.live.none")}
                          </span>
                        ) : (
                          <span className="muted">
                            {t("coursesView.unknown")}
                          </span>
                        )}
                      </td>
                      <td className="num">
                        {course.learners !== undefined ? (
                          i18n.number(course.learners)
                        ) : (
                          <span className="muted">
                            {t("coursesView.unknown")}
                          </span>
                        )}
                      </td>
                      <td className="cell-date">
                        {course.updatedAt ? (
                          day(course.updatedAt)
                        ) : (
                          <span className="muted">
                            {t("coursesView.unknown")}
                          </span>
                        )}
                      </td>
                      <td className="courses-actions" data-label="">
                        <Button
                          aria-label={t("coursesView.openCourse", { title })}
                          disabled={pending}
                          onClick={() => onOpen(course.id)}
                        >
                          {t("coursesView.open")}
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
