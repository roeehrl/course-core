import React, { useEffect, useState } from "react";
import { isAbortError, type CourseApi, type ServerSnapshot } from "../client/apiClient";
import type { SupervisorRequestsProps } from "./SupervisorRequests";
import { LoadingLine } from "./loadingLine.web";
import { useI18n, type MessageKey } from "../i18n";

interface AuthorityRequest {
  requestId: string;
  kind: "goal_change" | "required_objectives" | "grading_standard" | "paid_ceiling";
  approver: "learner" | "staff";
  proposal: { goal?: string; objectiveIds?: string[]; limitMicroUsd?: number };
  reason: string | null;
  state: "pending" | "approved" | "rejected" | "expired" | "undone";
  createdAt: string;
  canUndo: boolean;
}
interface TeachingAction {
  actionId: string;
  action: string;
  objectiveIds: string[];
  origin: "trigger" | "follow_up" | "supervisor";
  state: "started" | "scheduled" | "delivered" | "checked" | "ended";
  endReason: string | null;
  dueAt: string | null;
  followUp: null | {
    objectives: { objectiveId: string; result: string }[];
    transferItem?: { assessmentId: string; episodeId: string | null };
    visual?: { visualId: string; episodeId: string | null };
  };
  createdAt: string;
}
/**
 * What the supervisor asked the learner to decide (a new overall goal), what waits for the course
 * team, and the teaching work Core started for them, with follow-ups still to come (design §4:
 * the learner sees changes and can undo them). Codes only from the server; words come from here.
 */
export function SupervisorRequests({ api, server, onChanged }: SupervisorRequestsProps) {
  const i18n = useI18n(),
    t = i18n.t;
  const label = (key: string, fallback: string) => (i18n.has(key as MessageKey) ? t(key as MessageKey) : fallback);
  const [data, setData] = useState<{ requests: AuthorityRequest[]; actions: TeachingAction[] }>();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    (api as CourseApi)
      .request<{ requests: AuthorityRequest[]; actions: TeachingAction[] }>(
        `/api/enrollments/${encodeURIComponent(server.enrollmentId)}/supervision/requests`, "GET", undefined, { signal: controller.signal })
      .then((v) => { if (!controller.signal.aborted) setData({ requests: v.requests ?? [], actions: v.actions ?? [] }); })
      .catch((e) => !controller.signal.aborted && !isAbortError(e) && setData({ requests: [], actions: [] }));
    return () => controller.abort();
  }, [api, server.enrollmentId, server.revision]);
  const episodes = server.course.chapters.flatMap((c) => c.episodes);
  const lesson = (id: string | null | undefined) => (id ? episodes.find((e) => e.id === id)?.title ?? id : "");
  const objective = (id: string) => server.course.objectives.find((o) => o.id === id)?.description ?? id;
  async function decide(request: AuthorityRequest, decision: "approve" | "reject" | "undo") {
    setBusy(request.requestId);
    setError("");
    setNotice("");
    try {
      await (api as CourseApi).command(server as ServerSnapshot, `supervision/requests/${request.requestId}/decision`, { decision });
      setNotice(t(`supervisorRequests.done.${decision}` as MessageKey));
      onChanged();
    } catch {
      setError(t("supervisorRequests.failed"));
    } finally {
      setBusy("");
    }
  }
  const mine = data?.requests.filter((r) => r.approver === "learner") ?? [];
  const staff = data?.requests.filter((r) => r.approver === "staff" && r.state === "pending") ?? [];
  const actions = data?.actions ?? [];
  return (
    <section className="connected-reading-card" aria-labelledby="supervisor-requests-title" aria-busy={!data}>
      <h2 id="supervisor-requests-title">{t("supervisorRequests.title")}</h2>
      {!data ? (
        <LoadingLine reserve={t("supervisorRequests.empty")} />
      ) : mine.length === 0 && staff.length === 0 && actions.length === 0 ? (
        <p className="connected-muted">{t("supervisorRequests.empty")}</p>
      ) : (
        <>
          {mine.length > 0 && (
            <>
              <h3>{t("supervisorRequests.yours")}</h3>
              <ul>
                {mine.map((r) => (
                  <li key={r.requestId}>
                    <p>
                      <strong>{t("supervisorRequests.goal.title")}</strong>{" "}
                      <span className="connected-muted">· {label(`supervisorRequests.state.${r.state}`, r.state)} · {i18n.date(r.createdAt, "medium")}</span>
                    </p>
                    {r.proposal.goal && <p dir="auto">{t("supervisorRequests.goal.proposed", { goal: r.proposal.goal })}</p>}
                    {r.reason && <p className="connected-muted" dir="auto">{t("supervisorRequests.why", { reason: r.reason })}</p>}
                    {r.state === "pending" && (
                      <p role="group" aria-label={t("supervisorRequests.goal.decide")}>
                        <button type="button" className="connected-link-button" disabled={Boolean(busy)} onClick={() => void decide(r, "reject")}>
                          {t("supervisorRequests.goal.keep")}
                        </button>{" "}
                        <button type="button" className="connected-link-button" disabled={Boolean(busy)} onClick={() => void decide(r, "approve")}>
                          {t("supervisorRequests.goal.approve")}
                        </button>
                      </p>
                    )}
                    {r.canUndo && (
                      <button type="button" className="connected-link-button" disabled={Boolean(busy)} onClick={() => void decide(r, "undo")}>
                        {t("supervisorRequests.goal.undo")}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
          {staff.length > 0 && (
            <>
              <h3>{t("supervisorRequests.team")}</h3>
              <ul>
                {staff.map((r) => (
                  <li key={r.requestId}>
                    {label(`supervisorRequests.kind.${r.kind}`, r.kind)}{" "}
                    <span className="connected-muted">· {t("supervisorRequests.waitingForTeam")}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {actions.length > 0 && (
            <>
              <h3>{t("supervisorRequests.actions")}</h3>
              <p className="connected-muted">{t("supervisorRequests.actions.intro")}</p>
              <ul>
                {actions.map((a) => (
                  <li key={a.actionId}>
                    <p>
                      <strong>{label(`supervisorRequests.action.${a.action}`, a.action)}</strong>{" "}
                      <span className="connected-muted">
                        · {i18n.list(a.objectiveIds.map(objective), "unit")} ·{" "}
                        {a.state === "scheduled" && a.dueAt
                          ? t("supervisorRequests.dueOn", { date: i18n.date(a.dueAt, "medium") })
                          : a.state === "ended"
                            ? label(`supervisorRequests.ended.${a.endReason ?? "other"}`, t("supervisorRequests.state.ended"))
                            : label(`supervisorRequests.state.${a.state}`, a.state)}
                      </span>
                    </p>
                    {a.followUp?.transferItem && (
                      <p>{t("supervisorRequests.tryProblem", { lesson: lesson(a.followUp.transferItem.episodeId) })}</p>
                    )}
                    {a.followUp?.visual && (
                      <p>{t("supervisorRequests.seeVisual", { lesson: lesson(a.followUp.visual.episodeId) })}</p>
                    )}
                    {a.followUp?.objectives.map((o) => (
                      <p key={o.objectiveId} className="connected-muted">
                        {label(`supervisorRequests.result.${o.result}`, o.result)}
                      </p>
                    ))}
                  </li>
                ))}
              </ul>
              <p className="connected-muted">{t("supervisorRequests.notEvidence")}</p>
            </>
          )}
        </>
      )}
      <div aria-live="polite">
        {notice && <p>{notice}</p>}
        {error && <p role="alert" className="connected-error-text">{error}</p>}
      </div>
    </section>
  );
}
