import React from "react";
import { Text, View } from "react-native";
import type { ServerSnapshot } from "../client/apiClient";
import { policyDate, policyTimeZone } from "../connected/policyPresentation";
import { useI18n } from "../i18n";
import { styles, Badge } from "./ui";
export function ClosureSummary({ server }: { server: ServerSnapshot }) {
  const i18n = useI18n(),
    t = i18n.t;
  const report = server.closureReport;
  const notices = server.closedRecordNotices ?? [];
  if (!report && !server.complete) return null;
  const description = (id: string) =>
    server.course.objectives.find((row) => row.id === id)?.description ??
    t("closureSummary.objectiveFallback");
  return (
    <View style={styles.card}>
      <Badge label={t("closureSummary.badge")} />
      <Text accessibilityRole="header" style={styles.heading}>
        {report?.reason === "cap"
          ? t("closureSummary.title.cap")
          : report?.reason === "withdrawn"
            ? t("closureSummary.title.withdrawn")
            : t("closureSummary.title.complete")}
      </Text>
      {report ? (
        <>
          <Text style={styles.small}>
            {t("closureSummary.recorded", {
              date: policyDate(report.closedAt, policyTimeZone(server.course.policy), i18n),
            })}
          </Text>
          <Text style={styles.body}>
            {report.coverage === "complete"
              ? t("closureSummary.coverage.complete")
              : t("closureSummary.coverage.partial")}
          </Text>
          <Text style={styles.body}>
            {report.mastery === "demonstrated"
              ? t("closureSummary.mastery.demonstrated")
              : t("closureSummary.mastery.needed")}
          </Text>
          {report.uncoveredObjectiveIds.length > 0 && (
            <View style={{ gap: 8 }}>
              <Text style={styles.heading}>{t("closureSummary.revisit")}</Text>
              {report.uncoveredObjectiveIds.map((id) => (
                <Text key={id} style={styles.small}>
                  {description(id)}
                </Text>
              ))}
            </View>
          )}
          {report.unprovenConceptIds.length > 0 && (
            <View style={{ gap: 8 }}>
              <Text style={styles.heading}>{t("closureSummary.checksNeeded")}</Text>
              {report.unprovenConceptIds.map((id) => (
                <Text key={id} style={styles.small}>
                  {description(id)}
                </Text>
              ))}
            </View>
          )}
          <Text style={styles.small}>
            {t("closureSummary.furtherLearning")}
          </Text>
        </>
      ) : (
        <Text style={styles.body}>
          {t("closureSummary.noReport")}
        </Text>
      )}
      {report && notices.length > 0 && (
        <View style={{ gap: 8 }}>
          <Text accessibilityRole="header" style={styles.heading}>
            {t("closureSummary.changes.title")}
          </Text>
          {notices.map((notice) => (
            <Text key={notice.evidenceId} style={styles.small}>
              {t(
                notice.reason
                  ? "closureSummary.changes.withdrawnWithReason"
                  : "closureSummary.changes.withdrawn",
                {
                  date: policyDate(notice.withdrawnAt, policyTimeZone(server.course.policy), i18n),
                  objective: description(notice.objectiveId),
                  reason: notice.reason ?? "",
                },
              )}
            </Text>
          ))}
          <Text style={styles.small}>
            {t("closureSummary.changes.note")}
          </Text>
        </View>
      )}
      <Text style={styles.small}>
        {t("closureSummary.disclaimer")}
      </Text>
    </View>
  );
}
