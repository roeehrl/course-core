import React, { useEffect, useState } from "react";
import { isAbortError, type CourseApi, type ServerSnapshot } from "../client/apiClient";
import type { PersonalChangesProps } from "./PersonalChanges";
import { LoadingLine } from "./loadingLine.web";
import { useReservedBlock } from "./reservedHeight";
import { useI18n, type MessageKey } from "../i18n";

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
  const classificationLabel = (value: string) => {
    const key = `personalChanges.classification.${value}` as MessageKey;
    return i18n.has(key) ? t(key) : value;
  };
  const emptyCopy = t("personalChanges.empty");
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
  // Shown while loading with the empty state's footprint (the common case), or
  // the height the list last settled at, so panels below do not move.
  const reserve = useReservedBlock<HTMLElement>(`changes:${server.enrollmentId}`, !!items);
  return (
    <section
      ref={reserve.ref}
      style={{ minHeight: reserve.minHeight }}
      className="connected-reading-card connected-changes"
      aria-labelledby="changes-title"
      aria-busy={!items}
    >
      <h2 id="changes-title">{t("personalChanges.title")}</h2>
      {!items ? (
        <LoadingLine reserve={emptyCopy} />
      ) : items.length === 0 ? (
        <p className="connected-muted">{emptyCopy}</p>
      ) : (
        <>
          <p className="connected-muted">{t("personalChanges.intro")}</p>
          <ul>
            {items.map((item, index) => {
              // A change with several parts is undone once, from its first listed part.
              const first = items.findIndex((other) => other.proposalId === item.proposalId) === index;
              const label = t("personalChanges.changeLabel", { kind: kindLabel(item.kind), episode: item.episodeTitle });
              return (
              <li
                key={`${item.proposalId}/${item.blockId}`}
                // The lesson's "Unverified" label links here.
                {...(first ? { id: `personal-change-${item.proposalId}`, tabIndex: -1 } : {})}
              >
                <strong>{kindLabel(item.kind)}</strong> · <bdi>{item.episodeTitle}</bdi>
                <span className="connected-muted">
                  {" "}
                  · {classificationLabel(item.classification)} · {day(item.appliedAt)}
                </span>
                {item.unverified && (
                  <p>
                    <strong>{t("personalChanges.unverified.label")}</strong>{" "}
                    <span className="connected-muted">{t("personalChanges.unverified.body")}</span>
                  </p>
                )}
                {item.why && <p dir="auto">{item.why}</p>}
                {item.sourceRefs && item.sourceRefs.length > 0 && (
                  <p className="connected-muted">
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
                  <p className="connected-muted">
                    {t("personalChanges.transfer", {
                      statuses: i18n.list(
                        item.transferChecks.map((c) => t(`personalChanges.transfer.${c.status}` as MessageKey)),
                        "unit",
                      ),
                    })}
                  </p>
                )}
                {item.reverted ? (
                  <p className="connected-muted">
                    {item.revertedAt
                      ? t("personalChanges.revertedOn", { date: day(item.revertedAt) })
                      : t("personalChanges.reverted")}
                  </p>
                ) : item.hideable ? (
                  <button
                    type="button"
                    className="connected-link-button"
                    disabled={Boolean(busy)}
                    aria-label={t(item.hidden ? "personalChanges.restoreLabel" : "personalChanges.hideLabel", { episode: item.episodeTitle })}
                    onClick={async () => {
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
                    }}
                  >
                    {t(item.hidden ? "personalChanges.restore" : "personalChanges.hide")}
                  </button>
                ) : (
                  <p className="connected-muted">{t("personalChanges.required")}</p>
                )}
                {!item.reverted && item.revertable && first && (
                  confirming === item.proposalId ? (
                    <p role="group" aria-label={t("personalChanges.undo.confirmLabel", { label })}>
                      {t("personalChanges.undo.question")}{" "}
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
                            setError(t("personalChanges.undo.failed"));
                          } finally {
                            setBusy("");
                          }
                        }}
                      >
                        {t("personalChanges.undo.yes")}
                      </button>{" "}
                      <button type="button" className="connected-link-button" disabled={Boolean(busy)} onClick={() => setConfirming("")}>
                        {t("personalChanges.undo.keep")}
                      </button>
                    </p>
                  ) : (
                    <button type="button" className="connected-link-button" disabled={Boolean(busy)} aria-label={t("personalChanges.undo.label", { label })} onClick={() => setConfirming(item.proposalId)}>
                      {t("personalChanges.undo.button")}
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
