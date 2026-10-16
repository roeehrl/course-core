import React, { useEffect, useState } from "react";
import type { CourseApi, ServerSnapshot } from "../client/apiClient";
import type { ReviewAssistConsentProps } from "./ReviewAssistConsent";

/** The learner's own choice whether an AI may draft notes for the human who
 * reviews their written answers, or for a checkpoint's fixed automatic check
 * of their quoted words. Off by default; the AI never grades anything. */
export function ReviewAssistConsent({ api, server, onChanged }: ReviewAssistConsentProps) {
  const [granted, setGranted] = useState<boolean>();
  const [applies, setApplies] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Written items are listed; checkpoints judged in conversation are known only to the server, which says whether the choice applies.
  const written = server.course.assessments.some((a) => ["rubric", "teach_back", "counterexample", "experiment_design"].includes(a.type));
  useEffect(() => {
    const controller = new AbortController();
    (api as CourseApi)
      .request<{ granted: boolean; applies?: boolean }>(`/api/enrollments/${encodeURIComponent(server.enrollmentId)}/review-assist`, "GET", undefined, { signal: controller.signal })
      .then((v) => { if (controller.signal.aborted) return; setGranted(v.granted); setApplies(v.applies ?? written); })
      .catch(() => undefined);
    return () => controller.abort();
  }, [api, server.enrollmentId, server.revision, written]);
  if (!applies || granted === undefined) return null;
  return (
    <section className="connected-reading-card" aria-labelledby="review-assist-title">
      <h2 id="review-assist-title">Reviews of your written answers</h2>
      <p className="connected-muted">
        A person reviews your written answers. You can let an AI draft notes for that reviewer to check. The AI sees
        the question, the rubric and your answers in that review conversation only — not your name, profile or history.
        It never grades you: the reviewer decides, or, at a checkpoint the course checks automatically, a fixed check
        that only accepts quotes of your own words.
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
