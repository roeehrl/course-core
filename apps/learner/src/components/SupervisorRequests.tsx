import type { CourseApi, ServerSnapshot } from "../client/apiClient";

export interface SupervisorRequestsProps {
  api: Pick<CourseApi, "request" | "command">;
  server: ServerSnapshot;
  onChanged: () => void;
}
/** Native view is not yet qualified; the web app lists decisions and teaching actions. */
export function SupervisorRequests(_props: SupervisorRequestsProps) {
  return null;
}
