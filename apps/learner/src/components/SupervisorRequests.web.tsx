import React, { useEffect, useState } from "react";
import { isAbortError, type CourseApi, type ServerSnapshot } from "../client/apiClient";
import type { SupervisorRequestsProps } from "./SupervisorRequests";
import { LoadingLine } from "./loadingLine.web";
import { Icon } from "./icons/Icon.web";
import type { IconName } from "./icons/icons";
import { PillButton } from "../connected/ui/PillButton.web";
import { PreparingDots } from "../connected/ui/PreparingDots.web";
import { StatusLine } from "../connected/ui/StatusLine.web";
import { Tag } from "../connected/ui/Tag.web";
import { publishWaitingDecisions, requestsPath } from "../connected/companion/DecisionLine.web";
import { useI18n, type MessageKey } from "../i18n";

export interface AuthorityRequest {
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

const ACTION_STATE: Record<Exclude<TeachingAction["state"], "started" | "scheduled">, IconName> = { delivered: "check", checked: "check", ended: "pause-circle" };

/**
 * What the companion asked the learner to decide (a new overall goal), what waits for the course
 * team, and the teaching work Core started for them, with follow-ups still to come (final design
 * §4.10). Each item shows one status chip and at most one detail line. Codes only from the server;
 * words come from here. The root is `#profile-decisions`, where the companion's "Review" leads.
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
      .request<{ requests: AuthorityRequest[]; actions: TeachingAction[] }>(requestsPath(server.enrollmentId), "GET", undefined, { signal: controller.signal })
      .then((v) => {
        if (controller.signal.aborted) return;
        setData({ requests: v.requests ?? [], actions: v.actions ?? [] });
        // The companion's line and the trigger's dot follow what waits here.
        publishWaitingDecisions(v.requests ?? []);
      })
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
      // The decided request no longer waits, whatever the next read says.
      if (data) publishWaitingDecisions(data.requests.filter((r) => r.requestId !== request.requestId));
      onChanged();
    } catch {
      setError(t("supervisorRequests.failed"));
    } finally {
      setBusy("");
    }
  }
  const waiting = data?.requests.filter((r) => r.approver === "learner" && r.state === "pending") ?? [];
  const decided = data?.requests.filter((r) => r.approver === "learner" && r.state !== "pending") ?? [];
  const staff = data?.requests.filter((r) => r.approver === "staff" && r.state === "pending") ?? [];
  const actions = data?.actions ?? [];
  const empty = waiting.length + decided.length + staff.length + actions.length === 0;
  const actionChip = (a: TeachingAction) =>
    a.state === "started" ? (
      <span className="cc-ui-tag is-muted cc-prof-chip">
        <PreparingDots />
        {t("supervisorRequests.state.started")}
      </span>
    ) : a.state === "scheduled" ? (
      <Tag
        className="cc-prof-chip"
        icon="clock"
        label={a.dueAt ? t("supervisorRequests.dueOn", { date: i18n.date(a.dueAt, "medium") }) : t("supervisorRequests.state.scheduled")}
      />
    ) : (
      <Tag className="cc-prof-chip" icon={ACTION_STATE[a.state]} label={t(`supervisorRequests.state.${a.state}` as MessageKey)} />
    );
  return (
    <section
      id="profile-decisions"
      tabIndex={-1}
      className="connected-reading-card cc-prof-section"
      aria-labelledby="supervisor-requests-title"
      aria-busy={!data}
    >
      <div className="cc-prof-head">
        <h2 id="supervisor-requests-title" className="cc-prof-title">{t("supervisorRequests.title")}</h2>
      </div>
      {!data ? (
        <LoadingLine reserve={t("supervisorRequests.empty")} />
      ) : empty ? (
        <p className="connected-muted">{t("supervisorRequests.empty")}</p>
      ) : (
        <>
          {waiting.length > 0 && (
            <div className="cc-prof-group">
              <h3 className="cc-prof-group-title">{t("supervisorRequests.yours")}</h3>
              <ul className="cc-prof-list">
                {waiting.map((r) => (
                  <li key={r.requestId} className="cc-prof-card cc-prof-decision">
                    <Icon name="sparkle" size={16} />
                    <div className="cc-prof-decision-body">
                      <p className="cc-prof-card-title" dir="auto">
                        {r.proposal.goal ? t("supervisorRequests.goal.proposed", { goal: r.proposal.goal }) : t("supervisorRequests.goal.title")}
                      </p>
                      {r.reason && <p className="cc-prof-detail" dir="auto">{t("supervisorRequests.why", { reason: r.reason })}</p>}
                      <div role="group" aria-label={t("supervisorRequests.goal.decide")} className="cc-prof-buttons">
                        <PillButton variant="accent" disabled={Boolean(busy)} label={t("supervisorRequests.goal.approve")} onPress={() => void decide(r, "approve")} />
                        <PillButton disabled={Boolean(busy)} label={t("supervisorRequests.goal.keep")} onPress={() => void decide(r, "reject")} />
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {decided.length > 0 && (
            <div className="cc-prof-group">
              <h3 className="cc-prof-group-title">{t("supervisorRequests.decided")}</h3>
              <ul className="cc-prof-rows">
                {decided.map((r) => (
                  <li key={r.requestId} className="cc-prof-row">
                    <span className="cc-prof-row-text" dir="auto">
                      {r.proposal.goal ? t("supervisorRequests.goal.proposed", { goal: r.proposal.goal }) : t("supervisorRequests.goal.title")}
                    </span>
                    <Tag
                      className="cc-prof-chip"
                      icon={r.state === "approved" ? "check" : r.state === "expired" ? "clock" : "rotate-ccw"}
                      label={label(`supervisorRequests.state.${r.state}`, r.state)}
                    />
                    {r.canUndo && (
                      <button type="button" className="cc-ui-text-button cc-prof-text-button cc-prof-row-action" disabled={Boolean(busy)} onClick={() => void decide(r, "undo")}>
                        {t("supervisorRequests.goal.undo")}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {staff.length > 0 && (
            <div className="cc-prof-group">
              <h3 className="cc-prof-group-title">{t("supervisorRequests.team")}</h3>
              <ul className="cc-prof-rows">
                {staff.map((r) => (
                  <li key={r.requestId} className="cc-prof-row">
                    <span className="cc-prof-row-text">{label(`supervisorRequests.kind.${r.kind}`, r.kind)}</span>
                    <Tag className="cc-prof-chip" icon="clock" label={t("supervisorRequests.waitingForTeam")} />
                  </li>
                ))}
              </ul>
            </div>
          )}
          {actions.length > 0 && (
            <div className="cc-prof-group">
              <h3 className="cc-prof-group-title">{t("supervisorRequests.actions")}</h3>
              <p className="cc-prof-detail">{t("supervisorRequests.actions.intro")}</p>
              <ul className="cc-prof-rows">
                {actions.map((a) => (
                  <li key={a.actionId} className="cc-prof-row">
                    <span className="cc-prof-row-text">{label(`supervisorRequests.action.${a.action}`, a.action)}</span>
                    {actionChip(a)}
                    <div className="cc-prof-row-details">
                      {a.objectiveIds.length > 0 && (
                        <p className="cc-prof-detail">{t("supervisorRequests.about", { objectives: i18n.list(a.objectiveIds.map(objective), "unit") })}</p>
                      )}
                      {a.state === "ended" && (
                        <p className="cc-prof-detail">{label(`supervisorRequests.ended.${a.endReason ?? "other"}`, t("supervisorRequests.ended.other"))}</p>
                      )}
                      {a.followUp?.transferItem && (
                        <p className="cc-prof-detail">{t("supervisorRequests.tryProblem", { lesson: lesson(a.followUp.transferItem.episodeId) })}</p>
                      )}
                      {a.followUp?.visual && (
                        <p className="cc-prof-detail">{t("supervisorRequests.seeVisual", { lesson: lesson(a.followUp.visual.episodeId) })}</p>
                      )}
                      {a.followUp?.objectives.map((o) => (
                        <p key={o.objectiveId} className="cc-prof-detail">
                          {label(`supervisorRequests.result.${o.result}`, o.result)}
                        </p>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="cc-prof-detail">{t("supervisorRequests.notEvidence")}</p>
        </>
      )}
      <div aria-live="polite">
        {notice && <StatusLine tone="ink" icon="check" text={notice} />}
        {error && <div role="alert"><StatusLine tone="error" text={error} /></div>}
      </div>
    </section>
  );
}
