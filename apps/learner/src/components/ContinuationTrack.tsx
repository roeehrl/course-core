import type { CourseApi, ServerSnapshot } from "../client/apiClient";

export interface ContinuationTrackProps {
  api: Pick<CourseApi, "request" | "command">;
  server: ServerSnapshot;
  onChanged: () => void;
}
/** Native view is not yet qualified; the web app shows and changes this choice. */
export function ContinuationTrack(_props: ContinuationTrackProps) {
  return null;
}
