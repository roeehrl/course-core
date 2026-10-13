import React from "react";
import type { CourseApi } from "../client/apiClient";

export interface RetentionPanelProps {
  api: Pick<CourseApi, "request">;
  enrollmentId: string;
  revision: number;
  onStart: (objectiveId: string) => Promise<void>;
}
/** Native delayed checks are not yet qualified; the web app provides them. */
export function RetentionPanel(_props: RetentionPanelProps) {
  return null;
}
