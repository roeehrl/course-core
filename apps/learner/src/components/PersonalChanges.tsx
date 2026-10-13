import type { CourseApi, ServerSnapshot } from "../client/apiClient";

export interface PersonalChangesProps {
  api: Pick<CourseApi, "request" | "command">;
  server: ServerSnapshot;
  onChanged: () => void;
}
/** Native view is not yet qualified; the web app lists and controls changes. */
export function PersonalChanges(_props: PersonalChangesProps) {
  return null;
}
