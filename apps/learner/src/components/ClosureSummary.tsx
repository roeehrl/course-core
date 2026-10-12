import React from "react";
import { Text, View } from "react-native";
import type { ServerSnapshot } from "../client/apiClient";
import { policyDate, policyTimeZone } from "../connected/policyPresentation";
import { styles, Badge } from "./ui";
export function ClosureSummary({ server }: { server: ServerSnapshot }) {
  const report = server.closureReport;
  if (!report && !server.complete) return null;
  const description = (id: string) =>
    server.course.objectives.find((row) => row.id === id)?.description ??
    "A learning objective needs further attention.";
  return (
    <View style={styles.card}>
      <Badge label="Your learning record" />
      <Text accessibilityRole="header" style={styles.heading}>
        {report?.reason === "cap"
          ? "Learning window closed"
          : report?.reason === "withdrawn"
            ? "Enrollment ended"
            : "Course learning steps complete"}
      </Text>
      {report ? (
        <>
          <Text style={styles.small}>
            Recorded{" "}
            {policyDate(report.closedAt, policyTimeZone(server.course.policy))}
          </Text>
          <Text style={styles.body}>
            Material coverage:{" "}
            {report.coverage === "complete"
              ? "Complete"
              : "Some required material remains"}
            .
          </Text>
          <Text style={styles.body}>
            Independent understanding:{" "}
            {report.mastery === "demonstrated"
              ? "Demonstrated in the course checks"
              : "Further independent checks are needed"}
            .
          </Text>
          {report.uncoveredObjectiveIds.length > 0 && (
            <View style={{ gap: 8 }}>
              <Text style={styles.heading}>Material to revisit</Text>
              {report.uncoveredObjectiveIds.map((id) => (
                <Text key={id} style={styles.small}>
                  {description(id)}
                </Text>
              ))}
            </View>
          )}
          {report.unprovenConceptIds.length > 0 && (
            <View style={{ gap: 8 }}>
              <Text style={styles.heading}>Checks still needed</Text>
              {report.unprovenConceptIds.map((id) => (
                <Text key={id} style={styles.small}>
                  {description(id)}
                </Text>
              ))}
            </View>
          )}
          <Text style={styles.small}>
            Further learning is a separate, optional choice; this course does
            not expand automatically.
          </Text>
        </>
      ) : (
        <Text style={styles.body}>
          Your course steps are recorded as complete. A detailed closure report
          has not been issued.
        </Text>
      )}
      <Text style={styles.small}>
        This is a record of course learning, not professional certification or
        qualification.
      </Text>
    </View>
  );
}
