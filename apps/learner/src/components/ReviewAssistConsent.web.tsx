import React, { useEffect, useState } from "react";
import type { CourseApi, ServerSnapshot } from "../client/apiClient";
import type { ReviewAssistConsentProps } from "./ReviewAssistConsent";
import { rememberShown, wasShown } from "./reservedHeight";
import { useT } from "../i18n";

/** The learner's own choice whether an AI may draft notes for the human who
 * reviews their written answers, or for a checkpoint's fixed automatic check
 * of their quoted words. Off by default; the AI never grades anything. */
export function ReviewAssistConsent({ api, server, onChanged }: ReviewAssistConsentProps) {
  const t = useT();
  const [granted, setGranted] = useState<boolean>();
  const [applies, setApplies] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [failed, setFailed] = useState(false);
  // Written items are listed; checkpoints judged in conversation are known only to the server, which says whether the choice applies.
  const written = server.course.assessments.some((a) => ["rubric", "teach_back", "counterexample", "experiment_design"].includes(a.type));
  const key = `review-assist:${server.enrollmentId}`;
  useEffect(() => {
    const controller = new AbortController();
    (api as CourseApi)
      .request<{ granted: boolean; applies?: boolean }>(`/api/enrollments/${encodeURIComponent(server.enrollmentId)}/review-assist`, "GET", undefined, { signal: controller.signal })
      .then((v) => {
        if (controller.signal.aborted) return;
        const shown = v.applies ?? written;
        setGranted(v.granted);
        setApplies(shown);
        rememberShown(key, shown);
      })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [api, server.enrollmentId, server.revision, written]);
  const loading = granted === undefined && !failed;
  // While the choice loads, the section is laid out but invisible and inert when
  // it is expected to appear (as it last did, or from the course's written
  // items), so the panels below do not move when it arrives.
  const placeholder = loading && (wasShown(key) ?? written);
  if (!placeholder && (!applies || granted === undefined)) return null;
  return (
    <section
      className="connected-reading-card"
      aria-labelledby="review-assist-title"
      {...(placeholder ? { "aria-hidden": true, inert: true, style: { visibility: "hidden" as const } } : {})}
    >
      <h2 id="review-assist-title">{t("reviewAssistConsent.title")}</h2>
      <p className="connected-muted">{t("reviewAssistConsent.body")}</p>
      <label className="connected-check">
        <input
          type="checkbox"
          checked={granted ?? false}
          disabled={busy || placeholder}
          onChange={async (e) => {
            const next = e.target.checked;
            setBusy(true);
            setError("");
            try {
              await (api as CourseApi).command(server as ServerSnapshot, "review-assist", { granted: next });
              setGranted(next);
              onChanged();
            } catch {
              setError(t("reviewAssistConsent.saveFailed"));
            } finally {
              setBusy(false);
            }
          }}
        />
        {t("reviewAssistConsent.label")}
      </label>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
