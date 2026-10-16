import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { CourseApiError, type ServerSnapshot } from "../client/apiClient";
import type {
  SupervisionClient,
  SupervisionPermission,
  SupervisorToolCall,
} from "../client/supervisionClient";
import { Badge, Button, Notice, styles } from "./ui";

interface Props {
  accountId: string;
  enrollment: ServerSnapshot;
  client: SupervisionClient;
  mode: "settings" | "timeline";
  pending?: boolean;
  onRevision: (revision: number) => Promise<unknown> | void;
}
const labels: Record<string, string> = {
  get_history: "Read saved conversation",
  get_profile: "Read learning profile",
  get_evidence: "Read verified learning evidence",
  list_sources: "Review course source references",
  list_support: "Find reviewed learning support",
  choose_support: "Select reviewed learning support",
  get_model_sources: "Read sources for a learning preference",
  suggest_model: "Suggest a learning preference",
  list_generation_profiles: "Find approved tools for new teaching",
  create_teaching: "Create teaching for independent verification",
  check_teaching: "Check a teaching draft against references",
  list_research_topics: "Read approved public research topics",
  request_research: "Request public-source research",
};
function callStatus(call: SupervisorToolCall) {
  if (call.tool === "request_research")
    return call.outcome.researchState === "collected"
      ? "Public sources collected · content and rights review required"
      : call.outcome.researchState === "dispatched"
        ? "Public-source research queued · results need review"
        : call.outcome.researchState === "refused"
          ? "Research request could not run · nothing was collected"
          : call.outcome.researchState === "cancelled"
            ? "Research request ended · nothing will be collected"
            : "Research request staged · final plan review required";
  if (call.tool === "check_teaching")
    return call.outcome.verification === "passed"
      ? "Reference checks passed · final review still required"
      : call.outcome.verification === "rejected"
        ? "Draft rejected by reference checks · revision needed"
        : "Reference check unavailable · draft was not approved";
  if (call.outcome.delivery === "not_selected")
    return "Another option was selected for your lesson";
  if (call.outcome.modelSuggestion) {
    if (call.outcome.delivery === "pending_learner_review")
      return "Ready for your review · open Learning memory";
    if (call.outcome.delivery === "learner_accepted")
      return "Accepted by you · no completion credit granted";
    if (call.outcome.delivery === "learner_corrected")
      return "Corrected by you · no completion credit granted";
    if (call.outcome.delivery === "learner_disputed")
      return "Disputed by you · excluded from companion context";
    return ["failed", "cancelled"].includes(call.jobState)
      ? "Suggestion was not delivered"
      : "Suggested · awaiting verification and delivery";
  }
  if (call.appliedPlanRevision !== null && call.outcome.selected)
    return `Added to your lesson · plan ${call.appliedPlanRevision}`;
  switch (call.outcome.reason) {
    case "learner_opt_in_required":
      return "No lesson change · permission is off";
    case "independent_assessment_active":
      return "No lesson change during an independent check";
    case "reviewed_support_not_available":
      return "No matching reviewed support available";
    case "tool_projection_limit":
      return "Information exceeded the safe tool limit";
  }
  if (call.outcome.selected)
    return ["failed", "cancelled"].includes(call.jobState)
      ? "Selection was not delivered"
      : call.jobState === "applied"
        ? "Request processed · no lesson change recorded"
        : "Selected · awaiting verification and delivery";
  return "Information read · no completion credit granted";
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
  const [permission, setPermission] = useState<SupervisionPermission>();
  const [calls, setCalls] = useState<SupervisorToolCall[]>([]);
  const [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [retry, setRetry] = useState<boolean | null>(null),
    [refreshKey, setRefreshKey] = useState(0);
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
          setError(
            "Supervisor information is unavailable. Refresh to try again.",
          );
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
        saved.adaptiveTeaching
          ? "Personal lesson support is enabled."
          : "Personal lesson support is off. Earlier delivered material stays in your record.",
      );
      try {
        await onRevision(saved.revision);
      } catch {
        if (alive.current)
          setError(
            "Permission was saved. Refresh your course to see its current progress.",
          );
      }
    } catch (e) {
      if (!alive.current) return;
      const uncertain =
        !(e instanceof CourseApiError) || e.status < 400 || e.status >= 500;
      setRetry(uncertain ? target : null);
      setError(
        uncertain
          ? "The change is unconfirmed. Retry the same choice before making a different change."
          : e instanceof CourseApiError
            ? e.message
            : "Permission could not be saved. Refresh and try again.",
      );
    } finally {
      writing.current = false;
      if (alive.current) setBusy(false);
    }
  }
  return (
    <View style={[styles.card, { marginTop: 20 }]}>
      <Text accessibilityRole="header" style={styles.heading}>
        {mode === "settings"
          ? "Personal lesson support"
          : "Supervisor activity"}
      </Text>
      <Text style={styles.body}>
        {mode === "settings"
          ? "Allow the supervisor to add reviewed explanations and practice within your course limits, propose source-linked learning preferences for your review in Learning memory, and note ideas about what may help you from your answers and questions, for you to correct or reject. While it is on, the AI model your course uses also receives your open ideas about what may help you, including ones you wrote and your corrections, to guide your teaching. Ideas you reject or that lapse are not sent, and nothing from other learners is included. Your independent checks and completion requirements stay the same. You can turn this off at any time."
          : "See the tools used for your enrollment and whether selected support reached your lesson. This record is optional; continue learning on your course path."}
      </Text>
      {loading && (
        <ActivityIndicator accessibilityLabel="Loading supervisor information" />
      )}
      {error && <Notice error>{error}</Notice>}
      {notice && <Notice>{notice}</Notice>}
      {mode === "settings" && permission && (
        <>
          <Badge
            tone={permission.adaptiveTeaching ? "mint" : "neutral"}
            label={permission.adaptiveTeaching ? "Enabled" : "Off"}
          />
          {retry !== null ? (
            <Button
              label="Retry permission change"
              disabled={busy || pending}
              onPress={() => {
                void change(retry);
              }}
            />
          ) : (
            <Button
              label={
                permission.adaptiveTeaching
                  ? "Turn off personal support"
                  : "Enable personal support"
              }
              disabled={busy || pending || loading}
              onPress={() => {
                void change(!permission.adaptiveTeaching);
              }}
            />
          )}
        </>
      )}
      {mode === "timeline" &&
        !loading &&
        !error &&
        (calls.length ? (
          calls.map((call) => (
            <View key={call.id} style={{ gap: 4, marginTop: 12 }}>
              <Text style={styles.heading}>
                {labels[call.tool] ?? "Supervisor tool"}
              </Text>
              <Text style={styles.body}>{callStatus(call)}</Text>
              <Text style={styles.small}>
                {new Date(call.createdAt).toLocaleString()}
              </Text>
              {!!call.contextRefs.messageIds.length && (
                <Text style={styles.small}>
                  Context: {call.contextRefs.messageIds.length} saved
                  conversation messages.
                </Text>
              )}
              {!!call.contextRefs.sourceIds.length && (
                <Text style={styles.small}>
                  Context: {call.contextRefs.sourceIds.length} course source
                  references.
                </Text>
              )}
              {!!call.contextRefs.modelSourceEventIds?.length && (
                <Text style={styles.small}>
                  Context: {call.contextRefs.modelSourceEventIds.length}{" "}
                  learning events · proposal does not grant mastery
                </Text>
              )}
            </View>
          ))
        ) : (
          <Notice>
            No supervisor tools have been used for this enrollment yet.
          </Notice>
        ))}
      <Button
        label="Refresh supervisor information"
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
