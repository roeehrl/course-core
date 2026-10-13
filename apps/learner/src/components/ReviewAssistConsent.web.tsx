import React, { useEffect, useState } from "react";
import type { CourseApi, ServerSnapshot } from "../client/apiClient";
import type { ReviewAssistConsentProps } from "./ReviewAssistConsent";

/** The learner's own choice whether an AI may draft notes for the human who
 * reviews their written answers. Off by default; it never grades anything. */
export function ReviewAssistConsent({ api, server, onChanged }: ReviewAssistConsentProps) {
  const [granted, setGranted] = useState<boolean>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const written = server.course.assessments.some((a) => a.type === "rubric");
  useEffect(() => {
    if (!written) return;
    const controller = new AbortController();
    (api as CourseApi)
      .request<{ granted: boolean }>(`/api/enrollments/${encodeURIComponent(server.enrollmentId)}/review-assist`, "GET", undefined, { signal: controller.signal })
      .then((v) => !controller.signal.aborted && setGranted(v.granted))
      .catch(() => undefined);
    return () => controller.abort();
  }, [api, server.enrollmentId, server.revision, written]);
  if (!written || granted === undefined) return null;
  return (
    <section className="connected-reading-card" aria-labelledby="review-assist-title">
      <h2 id="review-assist-title">Reviews of your written answers</h2>
      <p className="connected-muted">
        A person reviews your written answers. You can let an AI draft notes for that reviewer to check. The AI sees
        the question, the rubric and your answer only — not your name, profile or history. It never grades you; the
        reviewer decides.
      </p>
      <label className="connected-check">
        <input
          type="checkbox"
          checked={granted}
          disabled={busy}
          onChange={async (e) => {
            const next = e.target.checked;
            setBusy(true);
            setError("");
            try {
              await (api as CourseApi).command(server as ServerSnapshot, "review-assist", { granted: next });
              setGranted(next);
              onChanged();
            } catch {
              setError("Your choice could not be saved. Nothing changed.");
            } finally {
              setBusy(false);
            }
          }}
        />
        Let an AI draft notes for my reviewer
      </label>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
