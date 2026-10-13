import React, { useEffect, useState } from "react";

export interface WrittenReview {
  attemptId: string;
  episodeId: string;
  submittedAt: string;
  status: "pending_review" | "met" | "not_met" | "needs_clarification";
  learnerNote: string | null;
  criteria: { id: string; description: string; required: boolean; met: boolean | null; quote: string | null; note: string | null }[];
}
export type ReviewsLoader = (enrollmentId: string, signal: AbortSignal) => Promise<WrittenReview[]>;
const labels: Record<WrittenReview["status"], string> = {
  pending_review: "Waiting for a reviewer",
  met: "Reviewed · criteria met",
  not_met: "Reviewed · not yet",
  needs_clarification: "Reviewer asked for clarification",
};
/** Shows this episode's written answers and their review outcome. Pending
 * answers never unlock progress; the gate updates only after review. */
export function ReviewStatus({ loader, enrollmentId, episodeId, revision }: { loader: ReviewsLoader; enrollmentId: string; episodeId: string; revision: number }) {
  const [items, setItems] = useState<WrittenReview[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    loader(enrollmentId, controller.signal)
      .then((all) => !controller.signal.aborted && setItems(all.filter((r) => r.episodeId === episodeId)))
      .catch(() => !controller.signal.aborted && setItems([]));
    return () => controller.abort();
  }, [loader, enrollmentId, episodeId, revision]);
  if (!items.length) return null;
  return (
    <section className="connected-reviews" aria-label="Your written answers">
      <h3>Your written answers</h3>
      <ul>
        {items.map((item) => (
          <li key={item.attemptId}>
            <strong>{labels[item.status]}</strong>
            {item.learnerNote && <p>Reviewer: {item.learnerNote}</p>}
            {item.status !== "pending_review" && (
              <ul>
                {item.criteria.map((c) => (
                  <li key={c.id}>
                    {c.met ? "✓" : "○"} {c.description}
                    {c.quote && <span> — <q>{c.quote}</q></span>}
                    {c.note && <span className="connected-muted"> — {c.note}</span>}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
