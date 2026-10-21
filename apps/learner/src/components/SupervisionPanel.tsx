import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { CourseApiError, type ServerSnapshot } from "../client/apiClient";
import type {
  SupervisionClient,
  SupervisionPermission,
  SupervisorToolCall,
} from "../client/supervisionClient";
import {
  Badge,
  BadgeSlot,
  Button,
  ButtonPlaceholder,
  Notice,
  styles,
} from "./ui";
import {
  englishTranslator,
  useI18n,
  type MessageKey,
  type Translate,
} from "../i18n";

interface Props {
  accountId: string;
  enrollment: ServerSnapshot;
  client: SupervisionClient;
  mode: "settings" | "timeline";
  pending?: boolean;
  onRevision: (revision: number) => Promise<unknown> | void;
}
const TOOLS = new Set([
  "get_history",
  "get_profile",
  "get_evidence",
  "list_sources",
  "list_support",
  "choose_support",
  "get_model_sources",
  "suggest_model",
  "list_generation_profiles",
  "create_teaching",
  "check_teaching",
  "list_research_topics",
  "request_research",
  "propose_practice_check",
  "list_visuals",
  "choose_visual",
  "request_authority",
  "compare_alternatives",
  "choose_alternative",
]);
function toolLabel(tool: string, t: Translate) {
  return TOOLS.has(tool)
    ? t(`supervisionPanel.tool.${tool}` as MessageKey)
    : t("supervisionPanel.tool.unknown");
}
function callStatus(
  call: SupervisorToolCall,
  t: Translate = englishTranslator().t,
) {
  // A failed or cancelled run delivers nothing, so its receipts never read as pending.
  const ended = ["failed", "cancelled"].includes(call.jobState);
  if (call.tool === "request_research")
    return t(
      call.outcome.researchState === "collected"
        ? "supervisionPanel.status.researchCollected"
        : call.outcome.researchState === "dispatched"
          ? "supervisionPanel.status.researchQueued"
          : call.outcome.researchState === "refused"
            ? "supervisionPanel.status.researchRefused"
            : call.outcome.researchState === "cancelled"
              ? "supervisionPanel.status.researchCancelled"
              : ended
                ? "supervisionPanel.status.researchNotSent"
                : "supervisionPanel.status.researchStaged",
    );
  if (call.tool === "check_teaching")
    return t(
      call.outcome.verification === "passed"
        ? ended
          ? "supervisionPanel.status.checkPassedNotDelivered"
          : "supervisionPanel.status.checkPassed"
        : call.outcome.verification === "rejected"
          ? "supervisionPanel.status.checkRejected"
          : "supervisionPanel.status.checkUnavailable",
    );
  if (call.outcome.delivery === "not_selected")
    return t("supervisionPanel.status.notSelected");
  if (call.outcome.modelSuggestion) {
    if (call.outcome.delivery === "pending_learner_review")
      return t("supervisionPanel.status.suggestionReady");
    if (call.outcome.delivery === "learner_accepted")
      return t("supervisionPanel.status.suggestionAccepted");
    if (call.outcome.delivery === "learner_corrected")
      return t("supervisionPanel.status.suggestionCorrected");
    if (call.outcome.delivery === "learner_disputed")
      return t("supervisionPanel.status.suggestionDisputed");
    return t(
      ended
        ? "supervisionPanel.status.suggestionNotDelivered"
        : "supervisionPanel.status.suggestionPending",
    );
  }
  if (call.appliedPlanRevision !== null && call.outcome.selected)
    return t("supervisionPanel.status.added", {
      plan: call.appliedPlanRevision,
    });
  switch (call.outcome.reason) {
    case "learner_opt_in_required":
      return t("supervisionPanel.status.permissionOff");
    case "independent_assessment_active":
      return t("supervisionPanel.status.independentCheck");
    case "reviewed_support_not_available":
      return t("supervisionPanel.status.noSupport");
    case "tool_projection_limit":
      return t("supervisionPanel.status.toolLimit");
  }
  if (call.outcome.selected)
    return t(
      ended
        ? "supervisionPanel.status.selectionNotDelivered"
        : call.jobState === "applied"
          ? "supervisionPanel.status.processed"
          : "supervisionPanel.status.selectedPending",
    );
  return t("supervisionPanel.status.read");
}
/** An optional settings/record panel. It never adds a required step to the
 * learning path. Key private state by account, enrollment and course pin. */
export function SupervisionPanel(props: Props) {
  return (
    <Panel
      key={JSON.stringify([
        props.accountId,
        props.enrollment.enrollmentId,
        props.enrollment.courseDigest,
        props.mode,
      ])}
      {...props}
    />
  );
}
function Panel({ enrollment, client, mode, pending, onRevision }: Props) {
  const i18n = useI18n();
  const t = i18n.t;
  const [permission, setPermission] = useState<SupervisionPermission>();
  const [calls, setCalls] = useState<SupervisorToolCall[]>([]);
  const [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [retry, setRetry] = useState<boolean | null>(null),
    [refreshKey, setRefreshKey] = useState(0),
    [reserved, setReserved] = useState<number>();
  const alive = useRef(true),
    writing = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setPermission(undefined);
    setCalls([]);
    const read =
      mode === "settings"
        ? client
            .permission(enrollment.enrollmentId, controller.signal)
            .then((value) => {
              if (!controller.signal.aborted) setPermission(value);
            })
        : client
            .tools(enrollment.enrollmentId, controller.signal)
            .then((value) => {
              if (!controller.signal.aborted) setCalls(value);
            });
    void read
      .catch(() => {
        if (!controller.signal.aborted)
          setError(t("supervisionPanel.error.unavailable"));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [client, enrollment.enrollmentId, enrollment.revision, mode, refreshKey]);
  async function change(target: boolean) {
    if (writing.current || pending || !permission) return;
    writing.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const saved = await client.setPermission(
        { ...enrollment, revision: permission.revision },
        target,
      );
      if (!alive.current) return;
      setPermission(saved);
      setRetry(null);
      setNotice(
        t(
          saved.adaptiveTeaching
            ? "supervisionPanel.notice.enabled"
            : "supervisionPanel.notice.off",
        ),
      );
      try {
        await onRevision(saved.revision);
      } catch {
        if (alive.current)
          setError(t("supervisionPanel.error.savedRefresh"));
      }
    } catch (e) {
      if (!alive.current) return;
      const uncertain =
        !(e instanceof CourseApiError) || e.status < 400 || e.status >= 500;
      setRetry(uncertain ? target : null);
      setError(
        uncertain
          ? t("supervisionPanel.error.unconfirmed")
          : e instanceof CourseApiError
            ? e.message
            : t("supervisionPanel.error.notSaved"),
      );
    } finally {
      writing.current = false;
      if (alive.current) setBusy(false);
    }
  }
  return (
    <View style={[styles.card, { marginTop: 20 }]}>
      <Text accessibilityRole="header" style={styles.heading}>
        {t(
          mode === "settings"
            ? "supervisionPanel.settings.title"
            : "supervisionPanel.timeline.title",
        )}
      </Text>
      <Text style={styles.body}>
        {t(
          mode === "settings"
            ? "supervisionPanel.settings.body"
            : "supervisionPanel.timeline.body",
        )}
      </Text>
      {mode === "timeline" && loading && (
        <ActivityIndicator accessibilityLabel={t("supervisionPanel.loading")} />
      )}
      {mode === "settings" ? (
        <View
          style={{
            gap: 14,
            // A failed read shows a short notice where the badge and button
            // would be; keep the space they were given so nothing below moves.
            minHeight: !loading && !permission ? reserved : undefined,
          }}
          onLayout={(event) => {
            if (loading && !permission && !error && !notice)
              setReserved(event.nativeEvent.layout.height);
          }}
        >
          {error && <Notice error>{error}</Notice>}
          {notice && <Notice>{notice}</Notice>}
          {loading && !permission && (
            // The same footprint as the badge and button below, so that the
            // panel keeps its height when the read finishes.
            <>
              <BadgeSlot>
                <ActivityIndicator
                  accessibilityLabel={t("supervisionPanel.loading")}
                />
              </BadgeSlot>
              <ButtonPlaceholder />
            </>
          )}
          {permission && (
            <>
              <Badge
                tone={permission.adaptiveTeaching ? "mint" : "neutral"}
                label={t(
                  permission.adaptiveTeaching
                    ? "supervisionPanel.badge.enabled"
                    : "supervisionPanel.badge.off",
                )}
              />
              {permission.lockedByStudy && !permission.adaptiveTeaching ? (
                <Text style={styles.body}>
                  {t("supervisionPanel.lockedByStudy")}
                </Text>
              ) : retry !== null ? (
                <Button
                  label={t("supervisionPanel.retry")}
                  disabled={busy || pending}
                  onPress={() => {
                    void change(retry);
                  }}
                />
              ) : (
                <Button
                  label={t(
                    permission.adaptiveTeaching
                      ? "supervisionPanel.turnOff"
                      : "supervisionPanel.turnOn",
                  )}
                  disabled={busy || pending || loading}
                  onPress={() => {
                    void change(!permission.adaptiveTeaching);
                  }}
                />
              )}
            </>
          )}
        </View>
      ) : (
        <>
          {error && <Notice error>{error}</Notice>}
          {notice && <Notice>{notice}</Notice>}
        </>
      )}
      {mode === "timeline" &&
        !loading &&
        !error &&
        (calls.length ? (
          calls.map((call) => (
            <View key={call.id} style={{ gap: 4, marginTop: 12 }}>
              <Text style={styles.heading}>
                {toolLabel(call.tool, t)}
              </Text>
              <Text style={styles.body}>{callStatus(call, t)}</Text>
              <Text style={styles.small}>
                {i18n.dateTime(call.createdAt)}
              </Text>
              {!!call.contextRefs.messageIds.length && (
                <Text style={styles.small}>
                  {t("supervisionPanel.context.messages", {
                    count: call.contextRefs.messageIds.length,
                  })}
                </Text>
              )}
              {!!call.contextRefs.sourceIds.length && (
                <Text style={styles.small}>
                  {t("supervisionPanel.context.sources", {
                    count: call.contextRefs.sourceIds.length,
                  })}
                </Text>
              )}
              {!!call.contextRefs.modelSourceEventIds?.length && (
                <Text style={styles.small}>
                  {t("supervisionPanel.context.events", {
                    count: call.contextRefs.modelSourceEventIds.length,
                  })}
                </Text>
              )}
            </View>
          ))
        ) : (
          <Notice>
            {t("supervisionPanel.timeline.empty")}
          </Notice>
        ))}
      <Button
        label={t("supervisionPanel.refresh")}
        kind="quiet"
        disabled={busy || loading || retry !== null}
        onPress={() => {
          setError("");
          setRefreshKey((n) => n + 1);
        }}
      />
    </View>
  );
}
