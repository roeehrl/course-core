import React, { useEffect, useRef, useState } from "react";
import { isAbortError, type CourseApi, type ServerSnapshot } from "../client/apiClient";
import type { PersonalChangesProps } from "./PersonalChanges";
import { LoadingLine } from "./loadingLine.web";
import { useReservedBlock } from "./reservedHeight";
import { Icon } from "./icons/Icon.web";
import type { IconName } from "./icons/icons";
import { InlineConfirm } from "../connected/ui/InlineConfirm.web";
import { StatusLine } from "../connected/ui/StatusLine.web";
import { Tag } from "../connected/ui/Tag.web";
import { useI18n, type MessageKey } from "../i18n";

interface Change {
  proposalId: string;
  appliedAt: string;
  episodeId: string;
  episodeTitle: string;
  blockId: string;
  kind: string;
  /** Core's own reason as a code; free text in `why` otherwise. */
  whyCode?: string | null;
  why: string;
  classification: "required" | "optional" | "unknown";
  hideable: boolean;
  hidden: boolean;
  planRevision: number;
  provenance?: "author_reviewed" | "generated";
  unverified?: boolean;
  sourceRefs?: { id: string; title: string; url: string | null }[];
  reverted?: boolean;
  /** Set aside by a move to a newer course version (kept in history and export). */
  archived?: boolean;
  revertedAt?: string | null;
  revertable?: boolean;
  transferChecks?: { objectiveId: string; status: "pending" | "passed" | "failed" | "expired" }[];
  /** What was checked automatically before a generated change was added. */
  validation?: { hostChecks: string[]; courseChecks: number; boundary: string };
}

/** The one status a change is in, as a chip (final design §4.9): an icon and two to four words. */
function status(item: Change): { key: MessageKey; icon: IconName } {
  if (item.archived) return { key: "personalChanges.status.archived", icon: "pause-circle" };
  if (item.reverted) return { key: "personalChanges.status.undone", icon: "rotate-ccw" };
  if (!item.hideable) return { key: "personalChanges.status.required", icon: "lock" };
  if (item.hidden) return { key: "personalChanges.status.hidden", icon: "eye-off" };
  return { key: "personalChanges.status.added", icon: "check" };
}

/** Every change made to this learner's personal course, with the reason. Optional
 * additions can be hidden and restored; required ones stay and can be disputed. */
export function PersonalChanges({ api, server, onChanged }: PersonalChangesProps) {
  const i18n = useI18n(),
    t = i18n.t;
  const day = (value: string) => i18n.date(value, "medium");
  const kindLabel = (kind: string) => {
    const key = `personalChanges.kind.${kind}` as MessageKey;
    return i18n.has(key) ? t(key) : kind;
  };
  const reason = (item: Change) => {
    const key = `personalChanges.why.${item.whyCode ?? ""}` as MessageKey;
    return item.whyCode && i18n.has(key) ? { text: t(key), course: false } : { text: item.why, course: true };
  };
  const checkLabel = (id: string) => {
    const key = `personalChanges.check.${id.replaceAll("-", "_")}` as MessageKey;
    return i18n.has(key) ? t(key) : t("personalChanges.check.other");
  };
  const emptyCopy = t("personalChanges.empty");
  const [items, setItems] = useState<Change[]>();
  const [planRevision, setPlanRevision] = useState(0);
  const [confirming, setConfirming] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  // The Undo that opened the confirmation takes focus back when the learner keeps the change.
  const undoButtons = useRef(new Map<string, HTMLButtonElement>());
  const refocus = useRef("");
  useEffect(() => {
    const controller = new AbortController();
    (api as CourseApi)
      .request<{ changes: Change[]; planRevision?: number }>(`/api/enrollments/${encodeURIComponent(server.enrollmentId)}/personal-changes`, "GET", undefined, { signal: controller.signal })
      .then((v) => { if (controller.signal.aborted) return; setItems(v.changes); setPlanRevision(v.planRevision ?? 0); })
      .catch((error) => !controller.signal.aborted && !isAbortError(error) && setItems([]));
    return () => controller.abort();
  }, [api, server.enrollmentId, server.revision]);
  useEffect(() => {
    if (confirming || !refocus.current) return;
    undoButtons.current.get(refocus.current)?.focus();
    refocus.current = "";
  }, [confirming]);
  // Shown while loading with the empty state's footprint (the common case), or
  // the height the list last settled at, so panels below do not move.
  const reserve = useReservedBlock<HTMLElement>(`changes:${server.enrollmentId}`, !!items);
  async function setHidden(item: Change) {
    setBusy(item.blockId);
    setError("");
    try {
      await (api as CourseApi).command(server as ServerSnapshot, "personal-changes/visibility", { episodeId: item.episodeId, blockId: item.blockId, hidden: !item.hidden });
      onChanged();
    } catch {
      setError(t("personalChanges.saveFailed"));
    } finally {
      setBusy("");
    }
  }
  async function undo(item: Change) {
    setBusy(item.proposalId);
    setError("");
    try {
      await (api as CourseApi).command(server as ServerSnapshot, "personal-changes/revert", { proposalId: item.proposalId, expectedPlanRevision: planRevision });
      setConfirming("");
      onChanged();
    } catch {
      setError(t("personalChanges.undo.failed"));
    } finally {
      setBusy("");
    }
  }
  return (
    <section
      ref={reserve.ref}
      style={{ minHeight: reserve.minHeight }}
      className="connected-reading-card connected-changes cc-prof-section"
      aria-labelledby="changes-title"
      aria-busy={!items}
    >
      <div className="cc-prof-head">
        <h2 id="changes-title" className="cc-prof-title">{t("personalChanges.title")}</h2>
        {items && items.length > 0 && <p className="cc-prof-intro">{t("personalChanges.intro")}</p>}
      </div>
      {!items ? (
        <LoadingLine reserve={emptyCopy} />
      ) : items.length === 0 ? (
        <p className="connected-muted">{emptyCopy}</p>
      ) : (
        <ul className="cc-prof-list">
          {items.map((item, index) => {
            // A change with several parts is undone once, from its first listed part.
            const first = items.findIndex((other) => other.proposalId === item.proposalId) === index;
            const label = t("personalChanges.changeLabel", { kind: kindLabel(item.kind), episode: item.episodeTitle });
            const titleId = `cc-prof-change-${item.proposalId}-${item.blockId}`;
            const state = status(item);
            const why = reason(item);
            const checks = item.validation
              ? [...item.validation.hostChecks.map(checkLabel), ...(item.validation.courseChecks > 0 ? [t("personalChanges.check.course")] : [])]
              : [];
            const undoable = !item.reverted && !item.archived && item.revertable && first;
            return (
              <li
                key={`${item.proposalId}/${item.blockId}`}
                className="cc-prof-card"
                aria-labelledby={titleId}
                // The lesson's "Unverified" label links here.
                {...(first ? { id: `personal-change-${item.proposalId}`, tabIndex: -1 } : {})}
              >
                <div className="cc-prof-card-head">
                  <h3 id={titleId} className="cc-prof-card-title">
                    {label}
                  </h3>
                  <span className="cc-prof-time">{t("personalChanges.addedOn", { date: day(item.appliedAt) })}</span>
                </div>
                <div className="cc-prof-chips">
                  <Tag className="cc-prof-chip" icon={state.icon} label={t(state.key)} />
                </div>
                {item.archived ? (
                  <p className="cc-prof-detail">{t("personalChanges.archived")}</p>
                ) : item.reverted ? (
                  <p className="cc-prof-detail">
                    {item.revertedAt ? t("personalChanges.revertedOn", { date: day(item.revertedAt) }) : t("personalChanges.reverted")}
                  </p>
                ) : !item.hideable ? (
                  <p className="cc-prof-detail">{t("personalChanges.requiredDetail")}</p>
                ) : null}
                {why.text && (
                  <p className="cc-prof-detail">
                    {t("personalChanges.whyLabel")}{" "}
                    {/* A translated reason follows the page direction; free text keeps its own. */}
                    <span dir={why.course ? "auto" : undefined}>{why.text}</span>
                  </p>
                )}
                {item.unverified && (
                  <p className="cc-prof-detail">
                    <strong>{t("personalChanges.unverified.label")}</strong> {t("personalChanges.unverified.body")}
                  </p>
                )}
                {checks.length > 0 && (
                  <div className="cc-prof-checks">
                    <p id={`${titleId}-checks`} className="cc-prof-detail">
                      {t("personalChanges.checksLabel")}
                    </p>{" "}
                    <ul aria-labelledby={`${titleId}-checks`}>
                      {checks.map((check, n) => (
                        <li key={n}>
                          <Icon name="check" size={16} />
                          <span>{check}</span>
                        </li>
                      ))}
                    </ul>
                    {item.validation?.boundary === "added_by_learner_after_attempt" && (
                      <p className="cc-prof-detail">{t("personalChanges.addedAfterAttempt")}</p>
                    )}
                  </div>
                )}
                {item.sourceRefs && item.sourceRefs.length > 0 && (
                  <p className="cc-prof-detail">
                    {t("personalChanges.sources")}{" "}
                    {item.sourceRefs.map((source, i) => (
                      <React.Fragment key={source.id}>
                        {i > 0 && t("personalChanges.sourceSeparator")}
                        {source.url ? (
                          <a href={source.url} target="_blank" rel="noopener noreferrer" dir="auto">
                            {source.title}
                          </a>
                        ) : (
                          <bdi>{source.title}</bdi>
                        )}
                      </React.Fragment>
                    ))}
                  </p>
                )}
                {first && item.transferChecks && item.transferChecks.length > 0 && (
                  <p className="cc-prof-detail">
                    {t("personalChanges.transfer", {
                      statuses: i18n.list(
                        item.transferChecks.map((c) => t(`personalChanges.transfer.${c.status}` as MessageKey)),
                        "unit",
                      ),
                    })}
                  </p>
                )}
                {((!item.archived && !item.reverted && item.hideable) || undoable) && (
                  <div className="cc-prof-actions">
                    {!item.archived && !item.reverted && item.hideable && (
                      <button
                        type="button"
                        className="cc-ui-text-button cc-prof-text-button"
                        disabled={Boolean(busy)}
                        aria-label={t(item.hidden ? "personalChanges.restoreLabel" : "personalChanges.hideLabel", { episode: item.episodeTitle })}
                        onClick={() => void setHidden(item)}
                      >
                        {t(item.hidden ? "personalChanges.restore" : "personalChanges.hide")}
                      </button>
                    )}
                    {undoable && (
                      <button
                        ref={(node) => {
                          if (node) undoButtons.current.set(item.proposalId, node);
                          else undoButtons.current.delete(item.proposalId);
                        }}
                        type="button"
                        className="cc-ui-text-button cc-prof-text-button"
                        disabled={Boolean(busy)}
                        aria-expanded={confirming === item.proposalId}
                        aria-label={t("personalChanges.undo.label", { label })}
                        onClick={() => setConfirming(item.proposalId)}
                      >
                        {t("personalChanges.undo.button")}
                      </button>
                    )}
                  </div>
                )}
                {undoable && confirming === item.proposalId && (
                  <InlineConfirm
                    className="cc-prof-confirm"
                    sentence={t("personalChanges.undo.question")}
                    confirmLabel={t("personalChanges.undo.yes")}
                    onConfirm={() => {
                      if (!busy) void undo(item);
                    }}
                    cancelLabel={t("personalChanges.undo.keep")}
                    onCancel={() => {
                      refocus.current = item.proposalId;
                      setConfirming("");
                    }}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
      <div aria-live="polite">{error && <div role="alert"><StatusLine tone="error" text={error} /></div>}</div>
    </section>
  );
}
