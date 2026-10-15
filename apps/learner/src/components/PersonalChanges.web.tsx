import React, { useEffect, useState } from "react";
import { isAbortError, type CourseApi, type ServerSnapshot } from "../client/apiClient";
import type { PersonalChangesProps } from "./PersonalChanges";

interface Change {
  proposalId: string;
  appliedAt: string;
  episodeId: string;
  episodeTitle: string;
  blockId: string;
  kind: string;
  why: string;
  classification: "required" | "optional" | "unknown";
  hideable: boolean;
  hidden: boolean;
}
const kinds: Record<string, string> = {
  append_teaching: "Added explanation or example",
  replace_teaching: "Rewrote part of a lesson",
  add_assessment_variant: "Added a fresh practice question",
  insert_episode: "Added a short lesson for you",
};
/** Every change made to this learner's personal course, with the reason. Optional
 * additions can be hidden and restored; required ones stay and can be disputed. */
export function PersonalChanges({ api, server, onChanged }: PersonalChangesProps) {
  const [items, setItems] = useState<Change[]>();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    (api as CourseApi)
      .request<{ changes: Change[] }>(`/api/enrollments/${encodeURIComponent(server.enrollmentId)}/personal-changes`, "GET", undefined, { signal: controller.signal })
      .then((v) => !controller.signal.aborted && setItems(v.changes))
      .catch((error) => !controller.signal.aborted && !isAbortError(error) && setItems([]));
    return () => controller.abort();
  }, [api, server.enrollmentId, server.revision]);
  if (!items) return null;
  return (
    <section className="connected-reading-card connected-changes" aria-labelledby="changes-title">
      <h2 id="changes-title">Your personal changes</h2>
      {items.length === 0 ? (
        <p className="connected-muted">Your course has no personal changes yet.</p>
      ) : (
        <>
          <p className="connected-muted">
            Changes your supervisor made for you, and why. Hiding an optional addition removes it from your lessons
            without affecting any checks or evidence; you can restore it at any time.
          </p>
          <ul>
            {items.map((item) => (
              <li key={`${item.proposalId}/${item.blockId}`}>
                <strong>{kinds[item.kind] ?? item.kind}</strong> · {item.episodeTitle}
                <span className="connected-muted"> · {item.classification} · {new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(item.appliedAt))}</span>
                {item.why && <p>{item.why}</p>}
                {item.hideable ? (
                  <button
                    type="button"
                    className="connected-link-button"
                    disabled={Boolean(busy)}
                    aria-label={`${item.hidden ? "Restore" : "Hide"} this addition in ${item.episodeTitle}`}
                    onClick={async () => {
                      setBusy(item.blockId);
                      setError("");
                      try {
                        await (api as CourseApi).command(server as ServerSnapshot, "personal-changes/visibility", { episodeId: item.episodeId, blockId: item.blockId, hidden: !item.hidden });
                        onChanged();
                      } catch {
                        setError("That change could not be saved. Nothing changed.");
                      } finally {
                        setBusy("");
                      }
                    }}
                  >
                    {item.hidden ? "Restore" : "Hide"}
                  </button>
                ) : (
                  <p className="connected-muted">Required for your path. Ask your companion or course team if you disagree.</p>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      <div aria-live="polite">{error && <p role="alert" className="connected-error-text">{error}</p>}</div>
    </section>
  );
}
