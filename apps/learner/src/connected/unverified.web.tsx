import React, { useEffect, useState } from "react";
import { isAbortError, type CourseApi } from "../client/apiClient";

/** Generated (AI-written, automatically checked, not person-reviewed) parts of
 * this learner's personal course, keyed so the lesson can label them where the
 * learner reads them. */
export interface UnverifiedContent {
  /** `${episodeId}/${blockId}` -> the personal change that added it. */
  blocks: Map<string, string>;
  /** Inserted personal episodes -> the personal change that added them. */
  episodes: Map<string, string>;
}
interface ChangeRow {
  proposalId: string;
  episodeId: string;
  blockId: string;
  kind: string;
  unverified?: boolean;
  reverted?: boolean;
  hidden?: boolean;
}
export const emptyUnverified = (): UnverifiedContent => ({ blocks: new Map(), episodes: new Map() });

export function indexUnverified(changes: ChangeRow[]): UnverifiedContent {
  const index = emptyUnverified();
  for (const change of changes) {
    if (!change.unverified || change.reverted || change.hidden) continue;
    if (change.kind === "insert_episode") index.episodes.set(change.episodeId, change.proposalId);
    else index.blocks.set(`${change.episodeId}/${change.blockId}`, change.proposalId);
  }
  return index;
}

/** Loads the learner's personal changes (the same list "Your personal changes"
 * shows) whenever their course revision changes. */
export function useUnverifiedContent(api: CourseApi, enrollmentId: string | undefined, revision: number) {
  const [content, setContent] = useState<UnverifiedContent>(emptyUnverified);
  useEffect(() => {
    if (!enrollmentId) return setContent(emptyUnverified());
    const controller = new AbortController();
    api
      .request<{ changes: ChangeRow[] }>(`/api/enrollments/${encodeURIComponent(enrollmentId)}/personal-changes`, "GET", undefined, {
        signal: controller.signal,
      })
      .then((value) => !controller.signal.aborted && setContent(indexUnverified(value.changes ?? [])))
      .catch((error) => {
        // Without the list nothing is labelled; the profile panel still lists every change.
        if (!controller.signal.aborted && !isAbortError(error)) setContent(emptyUnverified());
      });
    return () => controller.abort();
  }, [api, enrollmentId, revision]);
  return content;
}

/** The inline "Unverified" label: a disclosure that explains it and leads to
 * the personal change, where the learner can hide or undo it. */
export function UnverifiedBadge({
  what,
  onReview,
}: {
  /** "This part" or "This lesson". */
  what: string;
  onReview?: () => void;
}) {
  return (
    <details className="connected-unverified">
      <summary
        aria-label={`Unverified: ${what.toLowerCase()} was written by AI and has not been reviewed by a person`}
        title="Written by AI and checked automatically; no person has reviewed it."
      >
        <span aria-hidden="true">⚠︎</span> Unverified
      </summary>
      <div className="connected-unverified-body">
        <p>
          {what} was written by AI for you and checked automatically. No person has reviewed it, so treat it as a draft
          explanation; your checks and progress never depend on it being right.
        </p>
        {onReview && (
          <button type="button" className="connected-link-button" onClick={onReview}>
            See this change, hide or undo it
          </button>
        )}
      </div>
    </details>
  );
}
