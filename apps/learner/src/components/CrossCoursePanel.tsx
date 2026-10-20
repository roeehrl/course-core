import type { CourseApi } from "../client/apiClient";

export interface CrossCoursePanelProps {
  api: Pick<CourseApi, "request">;
  enrollmentId: string;
  courseTitle: string;
}
/** Native view is not yet qualified; the web app shows the sharing choices and suggestions. */
export function CrossCoursePanel(_props: CrossCoursePanelProps) {
  return null;
}
