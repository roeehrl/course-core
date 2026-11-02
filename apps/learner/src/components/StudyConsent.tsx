import type { CourseApi, ServerSnapshot } from "../client/apiClient";

export interface StudyConsentProps {
  api: Pick<CourseApi, "request" | "command">;
  server: ServerSnapshot;
  /** "prompt": shown on the course page only while the learner has not decided.
   * "settings": always shown in My profile, with join, the study code and leave. */
  mode: "prompt" | "settings";
  /** The choice was saved: reload the course. The prompt waits for a promise returned here. */
  onChanged: () => void | Promise<unknown>;
}
/** Native view is not yet qualified; the web app shows and changes this choice. */
export function StudyConsent(_props: StudyConsentProps) {
  return null;
}
