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
  planRevision: number;
  provenance?: "author_reviewed" | "generated";
  unverified?: boolean;
  sourceRefs?: { id: string; title: string; url: string | null }[];
  reverted?: boolean;
  revertedAt?: string | null;
  revertable?: boolean;
  transferChecks?: { objectiveId: string; status: "pending" | "passed" | "failed" | "expired" }[];
}
const transferLabel = { pending: "not yet checked", passed: "passed", failed: "not yet", expired: "no check taken" } as const;
const day = (value: string) => new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value));
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
  const [planRevision, setPlanRevision] = useState(0);
  const [confirming, setConfirming] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    (api as CourseApi)
      .request<{ changes: Change[]; planRevision?: number }>(`/api/enrollments/${encodeURIComponent(server.enrollmentId)}/personal-changes`, "GET", undefined, { signal: controller.signal })
      .then((v) => { if (controller.signal.aborted) return; setItems(v.changes); setPlanRevision(v.planRevision ?? 0); })
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
            without affecting any checks or evidence; you can restore it at any time. Undoing a change removes it for
            good; your answers and progress stay.
          </p>
          <ul>
            {items.map((item, index) => {
              // A change with several parts is undone once, from its first listed part.
              const first = items.findIndex((other) => other.proposalId === item.proposalId) === index;
              const label = `${kinds[item.kind] ?? item.kind} in ${item.episodeTitle}`;
              return (
              <li
                key={`${item.proposalId}/${item.blockId}`}
                // The lesson's "Unverified" label links here.
                {...(first ? { id: `personal-change-${item.proposalId}`, tabIndex: -1 } : {})}
              >
                <strong>{kinds[item.kind] ?? item.kind}</strong> · {item.episodeTitle}
                <span className="connected-muted"> · {item.classification} · {day(item.appliedAt)}</span>
                {item.unverified && (
                  <p>
                    <strong>Unverified.</strong> <span className="connected-muted">Written by AI and checked automatically; no person has reviewed it.</span>
                  </p>
                )}
                {item.why && <p>{item.why}</p>}
                {item.sourceRefs && item.sourceRefs.length > 0 && (
                  <p className="connected-muted">
                    Sources:{" "}
                    {item.sourceRefs.map((source, i) => (
                      <React.Fragment key={source.id}>
                        {i > 0 && ", "}
                        {source.url ? <a href={source.url} target="_blank" rel="noopener noreferrer">{source.title}</a> : source.title}
                      </React.Fragment>
                    ))}
                  </p>
                )}
                {first && item.transferChecks && item.transferChecks.length > 0 && (
                  <p className="connected-muted">
                    Your next independent check on this: {item.transferChecks.map((c) => transferLabel[c.status]).join(", ")}.
                  </p>
                )}
                {item.reverted ? (
                  <p className="connected-muted">Undone{item.revertedAt ? ` on ${day(item.revertedAt)}` : ""}. It no longer appears in your lessons.</p>
                ) : item.hideable ? (
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
                {!item.reverted && item.revertable && first && (
                  confirming === item.proposalId ? (
                    <p role="group" aria-label={`Confirm undo: ${label}`}>
                      Undo this change? Your answers and progress stay.{" "}
                      <button
                        type="button"
                        className="connected-link-button"
                        disabled={Boolean(busy)}
                        onClick={async () => {
                          setBusy(item.proposalId);
                          setError("");
                          try {
                            await (api as CourseApi).command(server as ServerSnapshot, "personal-changes/revert", { proposalId: item.proposalId, expectedPlanRevision: planRevision });
                            setConfirming("");
                            onChanged();
                          } catch {
                            setError("That change could not be undone. Nothing changed.");
                          } finally {
                            setBusy("");
                          }
                        }}
                      >
                        Yes, undo
                      </button>{" "}
                      <button type="button" className="connected-link-button" disabled={Boolean(busy)} onClick={() => setConfirming("")}>
                        Keep it
                      </button>
                    </p>
                  ) : (
                    <button type="button" className="connected-link-button" disabled={Boolean(busy)} aria-label={`Undo: ${label}`} onClick={() => setConfirming(item.proposalId)}>
                      Undo
                    </button>
                  )
                )}
              </li>
              );
            })}
          </ul>
        </>
      )}
      <div aria-live="polite">{error && <p role="alert" className="connected-error-text">{error}</p>}</div>
    </section>
  );
}
