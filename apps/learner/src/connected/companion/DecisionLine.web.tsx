import React, { useEffect } from "react";
import { isAbortError, type CourseApi, type ServerSnapshot } from "../../client/apiClient";
import type { AuthorityRequest } from "../../components/SupervisorRequests.web";
import { MetaLine } from "../ui/MetaLine.web";
import { companionBridge, useCompanionActivity } from "./bridge";
import { companionOpen } from "./openState";
import { useT } from "../../i18n";

/** The path both the decisions panel and this line read. */
export const requestsPath = (enrollmentId: string) => `/api/enrollments/${encodeURIComponent(enrollmentId)}/supervision/requests`;

/** How many decisions wait on the learner, for the companion's line and the trigger's dot. The
 * bridge's `suggestions` is written only by the profile part: here and by the decisions panel
 * (SupervisorRequests.web.tsx) whenever it reads or decides. */
export function publishWaitingDecisions(requests: readonly Pick<AuthorityRequest, "approver" | "state">[]) {
  companionBridge.updateActivity({ suggestions: requests.filter((r) => r.approver === "learner" && r.state === "pending").length });
}

/**
 * At the end of the thread: one system line while a decision from the companion waits on the
 * profile ("Your companion suggests a new goal." + "Review", final design §4.10). It reads the
 * decisions when it mounts and when the course changes, and shows the line while the bridge says one
 * waits. "Review" opens the decisions section of My profile.
 */
export function DecisionLine({ api, server }: { api?: CourseApi; server?: ServerSnapshot }) {
  const t = useT();
  const waiting = useCompanionActivity().suggestions;
  const enrollmentId = server?.enrollmentId;
  useEffect(() => {
    if (!api || !enrollmentId) return;
    const controller = new AbortController();
    api
      .request<{ requests?: AuthorityRequest[] }>(requestsPath(enrollmentId), "GET", undefined, { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) publishWaitingDecisions(value.requests ?? []);
      })
      .catch((error) => {
        // Nothing is suggested when the list cannot be read; the profile still shows it.
        if (!controller.signal.aborted && !isAbortError(error)) publishWaitingDecisions([]);
      });
    return () => controller.abort();
  }, [api, enrollmentId, server?.revision]);
  // Another enrollment starts from nothing until its own list is read.
  useEffect(() => () => publishWaitingDecisions([]), [enrollmentId]);
  if (!waiting) return null;
  return (
    <div className="cc-prof-decision-line" role="note">
      <MetaLine
        icon="sparkle"
        action={{
          label: t("decisionLine.review"),
          onPress: () => {
            // A modal sheet would cover the section and keep focus from it: it closes first.
            if (document.getElementById("connected-companion")?.getAttribute("aria-modal") === "true") companionOpen.close();
            companionBridge.navigate({ to: "profile", section: "decisions" });
          },
        }}
      >
        {t("decisionLine.text")}
      </MetaLine>
    </div>
  );
}
