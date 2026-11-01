import React, { useEffect, useId, useRef, useState } from "react";
import { ActivityIndicator, Platform, StyleSheet, Text, View } from "react-native";
import { CourseApiError, type ServerSnapshot } from "../client/apiClient";
import type {
  SupervisionClient,
  SupervisionPermission,
  SupervisorToolCall,
} from "../client/supervisionClient";
import {
  Button,
  ButtonPlaceholder,
  styles,
} from "./ui";
import { Icon } from "./icons/Icon";
import type { IconName } from "./icons/icons";
import { LivePressable } from "./LivePressable";
import { PillButton } from "../connected/ui/PillButton";
import { StatusLine } from "../connected/ui/StatusLine";
import { Tag } from "../connected/ui/Tag";
import { colors } from "../theme/colors";
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
/** The icon in front of each line of "What your companion did". */
const TOOL_ICONS: Record<string, IconName> = {
  get_history: "book-open",
  get_profile: "book-open",
  get_evidence: "book-open",
  get_model_sources: "book-open",
  list_sources: "book-open",
  list_research_topics: "book-open",
  list_support: "check",
  choose_support: "check",
  list_visuals: "image",
  choose_visual: "image",
  suggest_model: "lightbulb",
  propose_practice_check: "lightbulb",
  list_generation_profiles: "pencil",
  create_teaching: "pencil",
  check_teaching: "shield-check",
  request_research: "external-link",
  request_authority: "info",
  compare_alternatives: "check",
  choose_alternative: "check",
};
const toolIcon = (tool: string): IconName => TOOL_ICONS[tool] ?? "sparkle";
function toolLabel(tool: string, t: Translate) {
  return TOOLS.has(tool)
    ? t(`supervisionPanel.tool.${tool}` as MessageKey)
    : t("supervisionPanel.tool.unknown");
}
/** A status's chip: its sentence and an icon for what it means (added, no change, waiting, refused). */
const STATUS_ICONS: Partial<Record<MessageKey, IconName>> = {
  "supervisionPanel.status.added": "check",
  "supervisionPanel.status.suggestionAccepted": "check",
  "supervisionPanel.status.suggestionCorrected": "check",
  "supervisionPanel.status.checkPassed": "check",
  "supervisionPanel.status.checkPassedNotDelivered": "pause-circle",
  "supervisionPanel.status.permissionOff": "pause-circle",
  "supervisionPanel.status.independentCheck": "pause-circle",
  "supervisionPanel.status.toolLimit": "pause-circle",
  "supervisionPanel.status.noSupport": "pause-circle",
  "supervisionPanel.status.processed": "pause-circle",
  "supervisionPanel.status.read": "pause-circle",
  "supervisionPanel.status.notSelected": "pause-circle",
  "supervisionPanel.status.suggestionReady": "clock",
  "supervisionPanel.status.suggestionPending": "clock",
  "supervisionPanel.status.selectedPending": "clock",
  "supervisionPanel.status.waitingForSafePoint": "clock",
  "supervisionPanel.status.researchQueued": "clock",
  "supervisionPanel.status.researchStaged": "clock",
  "supervisionPanel.status.researchCollected": "clock",
  "supervisionPanel.status.checkRejected": "alert-circle",
  "supervisionPanel.status.checkUnavailable": "alert-circle",
  "supervisionPanel.status.researchRefused": "alert-circle",
  "supervisionPanel.status.suggestionDisputed": "alert-circle",
};
function callStatus(call: SupervisorToolCall, t: Translate = englishTranslator().t): { text: string; icon: IconName } {
  const key = callStatusKey(call);
  return { text: t(key), icon: STATUS_ICONS[key] ?? "info" };
}
function callStatusKey(call: SupervisorToolCall): MessageKey {
  // A failed or cancelled run delivers nothing, so its receipts never read as pending.
  const ended = ["failed", "cancelled"].includes(call.jobState);
  if (call.tool === "request_research")
    return (
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
                : "supervisionPanel.status.researchStaged"
    );
  if (call.tool === "check_teaching")
    return (
      call.outcome.verification === "passed"
        ? ended
          ? "supervisionPanel.status.checkPassedNotDelivered"
          : "supervisionPanel.status.checkPassed"
        : call.outcome.verification === "rejected"
          ? "supervisionPanel.status.checkRejected"
          : "supervisionPanel.status.checkUnavailable"
    );
  if (call.outcome.delivery === "not_selected")
    return "supervisionPanel.status.notSelected";
  if (call.outcome.delivery === "waiting_for_safe_point")
    return "supervisionPanel.status.waitingForSafePoint";
  if (call.outcome.delivery === "learner_declined")
    return "supervisionPanel.status.learnerDeclined";
  if (call.outcome.delivery === "lapsed")
    return "supervisionPanel.status.lapsed";
  if (call.outcome.modelSuggestion) {
    if (call.outcome.delivery === "pending_learner_review")
      return "supervisionPanel.status.suggestionReady";
    if (call.outcome.delivery === "learner_accepted")
      return "supervisionPanel.status.suggestionAccepted";
    if (call.outcome.delivery === "learner_corrected")
      return "supervisionPanel.status.suggestionCorrected";
    if (call.outcome.delivery === "learner_disputed")
      return "supervisionPanel.status.suggestionDisputed";
    return (
      ended
        ? "supervisionPanel.status.suggestionNotDelivered"
        : "supervisionPanel.status.suggestionPending"
    );
  }
  if (call.appliedPlanRevision !== null && call.outcome.selected)
    return "supervisionPanel.status.added";
  switch (call.outcome.reason) {
    case "learner_opt_in_required":
      return "supervisionPanel.status.permissionOff";
    case "independent_assessment_active":
      return "supervisionPanel.status.independentCheck";
    case "reviewed_support_not_available":
      return "supervisionPanel.status.noSupport";
    case "tool_projection_limit":
      return "supervisionPanel.status.toolLimit";
  }
  if (call.outcome.selected)
    return (
      ended
        ? "supervisionPanel.status.selectionNotDelivered"
        : call.jobState === "applied"
          ? "supervisionPanel.status.processed"
          : "supervisionPanel.status.selectedPending"
    );
  return "supervisionPanel.status.read";
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
  const headingId = `supervision-${mode}-${useId().replace(/:/g, "")}`;
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
  const on = !!permission?.adaptiveTeaching;
  return (
    <View
      style={[styles.card, local.panel]}
      {...(Platform.OS === "web" ? { role: "region", "aria-labelledby": headingId } : {})}
    >
      <View style={local.titleRow}>
        <Text accessibilityRole="header" nativeID={headingId} style={[styles.heading, local.title]}>
          {t(
            mode === "settings"
              ? "supervisionPanel.settings.title"
              : "supervisionPanel.timeline.title",
          )}
        </Text>
        {mode === "settings" && permission ? (
          <Tag
            className="cc-prof-chip"
            icon={on ? "check" : undefined}
            label={t(on ? "supervisionPanel.badge.enabled" : "supervisionPanel.badge.off")}
          />
        ) : mode === "settings" ? (
          // In the chip's place and with its size, so the title line wraps the same once it loads
          // (or when the read fails and a short notice takes the button's place).
          <View style={local.chipSlot}>
            {Platform.OS === "web" && (
              <View aria-hidden style={local.chipGhost}>
                <Tag className="cc-prof-chip cc-prof-placeholder" icon="check" label={t("supervisionPanel.badge.enabled")} />
              </View>
            )}
            {loading && (
              <View style={Platform.OS === "web" ? local.chipSpinner : undefined}>
                <ActivityIndicator
                  size="small"
                  accessibilityLabel={t("supervisionPanel.loading")}
                />
              </View>
            )}
          </View>
        ) : null}
      </View>
      <Text style={styles.body}>
        {t(
          mode === "settings"
            ? "supervisionPanel.settings.body"
            : "supervisionPanel.timeline.body",
        )}
      </Text>
      {mode === "settings" && (
        <Disclosure label={t("supervisionPanel.share.toggle")}>
          <Text style={styles.small}>{t("supervisionPanel.share.on")}</Text>
          <Text style={styles.small}>{t("supervisionPanel.share.detail")}</Text>
          {/* What still runs without the opt-in: paid review that prepares suggestions only. */}
          <Text style={styles.small}>{t("supervisionPanel.share.whenOff")}</Text>
        </Disclosure>
      )}
      {mode === "timeline" && loading && (
        <ActivityIndicator accessibilityLabel={t("supervisionPanel.loading")} />
      )}
      {mode === "settings" ? (
        <View
          style={{
            gap: 12,
            alignItems: "flex-start",
            // A failed read shows a short notice where the badge and button
            // would be; keep the space they were given so nothing below moves.
            minHeight: !loading && !permission ? reserved : undefined,
          }}
          onLayout={(event) => {
            if (loading && !permission && !error && !notice)
              setReserved(event.nativeEvent.layout.height);
          }}
        >
          <Messages error={error} notice={notice} />
          {loading && !permission && (
            // The button's footprint, so that the panel keeps its height when
            // the read finishes (the chip waits in the title line).
            <PillPlaceholder />
          )}
          {permission &&
            (permission.lockedByStudy && !permission.adaptiveTeaching ? (
              <Text style={styles.body}>
                {t("supervisionPanel.lockedByStudy")}
              </Text>
            ) : retry !== null ? (
              <PillButton
                label={t("supervisionPanel.retry")}
                disabled={busy || pending}
                onPress={() => {
                  void change(retry);
                }}
              />
            ) : (
              <PillButton
                label={t(on ? "supervisionPanel.turnOff" : "supervisionPanel.turnOn")}
                disabled={busy || pending || loading}
                onPress={() => {
                  void change(!permission.adaptiveTeaching);
                }}
              />
            ))}
        </View>
      ) : (
        <Messages error={error} notice={notice} />
      )}
      {mode === "timeline" &&
        !loading &&
        !error &&
        (calls.length ? (
          <View style={local.rows}>
            {calls.map((call, index) => {
              const state = callStatus(call, t);
              return (
                <View
                  key={call.id}
                  style={[local.row, index > 0 && local.rowRule]}
                  {...(Platform.OS === "web" ? { dataSet: { prof: "timeline-row" } } : {})}
                >
                  <View style={local.rowLine}>
                    <Icon name={toolIcon(call.tool)} size={16} style={{ color: colors.inkMuted }} />
                    <Text style={[styles.body, local.rowText]}>{toolLabel(call.tool, t)}</Text>
                  </View>
                  <Tag className="cc-prof-chip cc-prof-chip-wrap" icon={state.icon} label={state.text} />
                  <Text style={[styles.small, local.rowTime]}>
                    {i18n.dateTime(call.createdAt)}
                  </Text>
                </View>
              );
            })}
          </View>
        ) : (
          <Text style={styles.small}>{t("supervisionPanel.timeline.empty")}</Text>
        ))}
      <View style={local.refresh}>
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
    </View>
  );
}

/** One status line at most for each: a failure (announced at once) and a confirmation. They fit
 * the space the loading chip and button kept, so nothing below moves. */
function Messages({ error, notice }: { error: string; notice: string }) {
  return (
    <>
      {!!error && (
        <View accessibilityRole="alert" aria-live="assertive">
          <StatusLine tone="error" text={error} />
        </View>
      )}
      {!!notice && (
        <View accessibilityLiveRegion="polite" aria-live="polite">
          <StatusLine tone="ink" icon="check" text={notice} />
        </View>
      )}
    </>
  );
}

/** An inert block the size of a PillButton, kept in the layout while the
 * choice it stands for loads. Hidden from assistive technology. */
function PillPlaceholder() {
  if (Platform.OS !== "web") return <ButtonPlaceholder />;
  return (
    <View style={local.placeholder}>
      <span aria-hidden="true" className="cc-ui-pill cc-ui-pill-outline cc-ui-pill-36 cc-prof-placeholder">
        {"\u00a0"}
      </span>
    </View>
  );
}

/** A "What this shares" toggle: the button says whether its text is shown. */
function Disclosure({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <View style={local.disclosure}>
      <LivePressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        aria-expanded={open}
        onPress={() => setOpen((value) => !value)}
        style={local.disclosureButton}
      >
        <Icon name={open ? "chevron-up" : "chevron-down"} size={16} style={{ color: colors.accent }} />
        <Text style={local.disclosureLabel}>{label}</Text>
      </LivePressable>
      {open && <View style={local.disclosureBody}>{children}</View>}
    </View>
  );
}

const local = StyleSheet.create({
  panel: { marginTop: 20, gap: 12 },
  titleRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 10 },
  title: { marginBottom: 0 },
  disclosure: { gap: 8, alignItems: "flex-start" },
  disclosureButton: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 24 },
  disclosureLabel: { color: colors.accent, fontSize: 14, lineHeight: 20, fontWeight: "600" },
  disclosureBody: { gap: 6 },
  rows: { borderWidth: 1, borderColor: colors.line, borderRadius: 12, backgroundColor: colors.surface },
  row: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 16, rowGap: 6, paddingHorizontal: 16, paddingVertical: 12 },
  rowRule: { borderTopWidth: 1, borderTopColor: colors.line },
  rowLine: { flexDirection: "row", alignItems: "center", gap: 12, flexGrow: 1, flexShrink: 1, flexBasis: 240, minWidth: 0 },
  rowText: { color: colors.ink, flexShrink: 1 },
  rowTime: { marginStart: "auto", color: colors.inkMuted },
  refresh: { alignItems: "flex-start" },
  placeholder: { alignItems: "flex-start" },
  chipSlot: { justifyContent: "center", alignItems: "center" },
  chipGhost: { position: "relative" },
  chipSpinner: { position: "absolute", top: 0, bottom: 0, left: 0, right: 0, alignItems: "center", justifyContent: "center" },
});
