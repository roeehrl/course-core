import React, { useEffect, useState } from "react";
import { isAbortError, type CourseApi } from "../client/apiClient";
import { useT } from "../i18n";

/** Generated (AI-written, automatically checked, not person-reviewed) parts of
 * this learner's personal course, keyed so the lesson can label them where the
 * learner reads them. */
export interface UnverifiedContent {
  /** `${episodeId}/${blockId}` -> the personal change that added it. */
  blocks: Map<string, string>;
  /** Inserted personal episodes -> the personal change that added them. */
  episodes: Map<string, string>;
  /** Generated questions and exercises (by item ID) -> the personal change that added them. */
  questions: Map<string, string>;
}
interface ChangeRow {
  proposalId: string;
  episodeId: string;
  blockId: string;
  kind: string;
  assessmentId?: string;
  unverified?: boolean;
  reverted?: boolean;
  hidden?: boolean;
}
export const emptyUnverified = (): UnverifiedContent => ({ blocks: new Map(), episodes: new Map(), questions: new Map() });

export function indexUnverified(changes: ChangeRow[]): UnverifiedContent {
  const index = emptyUnverified();
  for (const change of changes) {
    if (!change.unverified || change.reverted || change.hidden) continue;
    if (change.kind === "insert_episode") index.episodes.set(change.episodeId, change.proposalId);
    else index.blocks.set(`${change.episodeId}/${change.blockId}`, change.proposalId);
    // A generated question is labelled wherever it is asked, including a lesson's check.
    if (change.assessmentId) index.questions.set(change.assessmentId, change.proposalId);
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
  /** What the label is on: one part of a lesson, the whole lesson, or a question. */
  what: "part" | "lesson" | "question";
  onReview?: () => void;
}) {
  const t = useT();
  return (
    <details className="connected-unverified">
      <summary
        aria-label={t("unverified.label", { what })}
        title={t("unverified.tooltip")}
      >
        <span aria-hidden="true">⚠︎</span> {t("unverified.badge")}
      </summary>
      <div className="connected-unverified-body">
        <p>{what === "question" ? t("unverified.bodyQuestion") : t("unverified.body", { what })}</p>
        {onReview && (
          <button type="button" className="connected-link-button" onClick={onReview}>
            {t("unverified.review")}
          </button>
        )}
      </div>
    </details>
  );
}
