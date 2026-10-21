import React, { useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { CourseApiError, type CourseApi, type ServerSnapshot } from "../client/apiClient";
import { createContinuationClient, type ContinuationView } from "../client/policyClient";
import { policyDate, policyTimeZone } from "../connected/policyPresentation";
import { useI18n, type MessageKey } from "../i18n";
import { Button, colors, Notice, styles } from "./ui";

export interface ContinuationTrackProps {
  api: Pick<CourseApi, "request" | "command">;
  server: ServerSnapshot;
  onChanged: () => void;
}

/** Server codes with their own explanation; anything else gets the generic one. */
export const CONTINUATION_ERRORS = new Set([
  "CONTINUATION_ALREADY_ACTIVE",
  "CONTINUATION_NOT_ACTIVE",
  "ENROLLMENT_NOT_CLOSED",
  "CONTINUATION_NOT_OPTED_IN",
  "CONTINUATION_NO_REQUIRED_WORK",
  "STALE_REVISION",
]);
/** After these the view is out of date, so it reloads to show the current choice. */
const RELOAD_ON = new Set(["STALE_REVISION", "CONTINUATION_ALREADY_ACTIVE", "CONTINUATION_NOT_ACTIVE"]);

/** Native continuation track after a course closes, the same choice as the web view: the learner
 * opts in explicitly to keep spaced review going. It is never required, earns no new credit,
 * keeps the course closed and can be stopped at any time. Staff can never make this choice. */
export function ContinuationTrack({ api, server, onChanged }: ContinuationTrackProps) {
  const i18n = useI18n(),
    t = i18n.t;
  const client = useMemo(() => createContinuationClient(api), [api]);
  const [view, setView] = useState<ContinuationView>();
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    client.load(server.enrollmentId, controller.signal).then(
      (v) => !controller.signal.aborted && setView(v),
      () => undefined,
    );
    return () => controller.abort();
  }, [client, server.enrollmentId, server.revision]);
  if (!view?.available) return null;
  const zone = policyTimeZone(server.course.policy);
  const track = view.track,
    active = track?.state === "active";
  const focus = [...new Set([...(view.reviewFocus?.unprovenConceptIds ?? []), ...(view.reviewFocus?.uncoveredObjectiveIds ?? [])])];
  const description = (objective: string) =>
    server.course.objectives.find((row) => row.id === objective)?.description ?? t("continuationTrack.objectiveFallback");
  async function act(action: () => Promise<ContinuationView>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      setView(await action());
      setAgree(false);
      onChanged();
    } catch (cause) {
      const code = cause instanceof CourseApiError ? cause.code : "";
      setError(t(CONTINUATION_ERRORS.has(code) ? (`continuationTrack.error.${code}` as MessageKey) : "continuationTrack.error.generic"));
      if (RELOAD_ON.has(code)) client.load(server.enrollmentId).then(setView, () => undefined);
    } finally {
      setBusy(false);
    }
  }
  const terms = ["optional", "noRequiredWork", "noCredit", "staysClosed", "stopAnytime"] as const;
  return (
    <View style={styles.card} aria-labelledby="continuation-title">
      <Text nativeID="continuation-title" accessibilityRole="header" aria-level={2} style={styles.heading}>
        {t("continuationTrack.title")}
      </Text>
      {active ? (
        <>
          <Text role="status" style={styles.body}>
            {t("continuationTrack.active", { date: policyDate(track.optedInAt, zone, i18n) })}
          </Text>
          <Text style={styles.body}>{t("continuationTrack.activeExplain")}</Text>
        </>
      ) : (
        <>
          <Text style={styles.body}>{t("continuationTrack.intro")}</Text>
          <View role="list" style={{ gap: 4 }}>
            {terms.map((term) => (
              <Text key={term} role="listitem" style={[styles.body, { color: colors.ink }]}>
                • {t(`continuationTrack.terms.${term}`)}
              </Text>
            ))}
          </View>
          {track?.state === "stopped" && track.stoppedAt && (
            <Text style={styles.small}>{t("continuationTrack.stopped", { date: policyDate(track.stoppedAt, zone, i18n) })}</Text>
          )}
        </>
      )}
      {focus.length > 0 && (
        <>
          <Text accessibilityRole="header" aria-level={3} style={[styles.body, { fontWeight: "600", color: colors.ink }]}>
            {t("continuationTrack.focusHeading")}
          </Text>
          <View role="list" style={{ gap: 4 }}>
            {focus.map((objective) => (
              <Text key={objective} role="listitem" style={[styles.body, { writingDirection: "auto" }]}>
                • {description(objective)}
              </Text>
            ))}
          </View>
        </>
      )}
      {active ? (
        <View style={styles.row}>
          <Button label={t("continuationTrack.stop")} kind="secondary" disabled={busy} onPress={() => void act(() => client.stop(server, view))} />
        </View>
      ) : (
        <>
          <Pressable
            accessibilityRole="checkbox"
            accessibilityLabel={t("continuationTrack.consent")}
            accessibilityState={{ checked: agree, disabled: busy }}
            aria-checked={agree}
            disabled={busy}
            onPress={() => setAgree((value) => !value)}
            style={{ flexDirection: "row", gap: 8, alignItems: "center", minHeight: 44 }}
          >
            <Text aria-hidden style={styles.body}>
              {agree ? "☑" : "☐"}
            </Text>
            <Text style={[styles.body, { flexShrink: 1 }]}>{t("continuationTrack.consent")}</Text>
          </Pressable>
          <View style={styles.row}>
            <Button
              label={t(track?.state === "stopped" ? "continuationTrack.startAgain" : "continuationTrack.start")}
              kind="primary"
              disabled={!agree || busy}
              onPress={() => {
                if (agree) void act(() => client.optIn(server, view, true));
              }}
            />
          </View>
        </>
      )}
      {!!error && <Notice error>{error}</Notice>}
    </View>
  );
}
