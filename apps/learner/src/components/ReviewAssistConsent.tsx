import type { CourseApi, ServerSnapshot } from "../client/apiClient";

export interface ReviewAssistConsentProps {
  api: Pick<CourseApi, "request" | "command">;
  server: ServerSnapshot;
  onChanged: () => void;
}
/** Native view is not yet qualified; the web app shows and changes this choice. */
export function ReviewAssistConsent(_props: ReviewAssistConsentProps) {
  return null;
}
