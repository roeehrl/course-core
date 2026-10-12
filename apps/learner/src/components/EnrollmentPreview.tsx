import React from "react";
import { Text, View } from "react-native";
import type { CatalogCourse } from "../client/policyClient";
import {
  policyDate,
  policyTimeZone,
  previewPolicyAvailable,
  quotaLabel,
} from "../connected/policyPresentation";
import { Badge, Button, Notice, styles } from "./ui";
export interface EnrollmentPreviewProps {
  course: CatalogCourse;
  pending: boolean;
  attempted?: boolean;
  onStart: () => void;
  onBack: () => void;
}
export function EnrollmentPreview({
  course,
  pending,
  attempted,
  onStart,
  onBack,
}: EnrollmentPreviewProps) {
  const p = course.policy,
    valid = previewPolicyAvailable(p),
    zone = policyTimeZone(p);
  return (
    <View style={{ gap: 22 }}>
      <Button
        label="← Back to courses"
        kind="quiet"
        disabled={pending}
        onPress={onBack}
      />
      <Badge label="Before you start" />
      <Text accessibilityRole="header" style={styles.title}>
        {course.title}
      </Text>
      {course.summary && <Text style={styles.body}>{course.summary}</Text>}
      {!valid ? (
        <Notice error>
          The published learning limits are unavailable. Contact your course
          team before starting; no new enrollment will be created here.
        </Notice>
      ) : (
        <>
          <View style={styles.card}>
            <Text accessibilityRole="header" style={styles.heading}>
              Your learning window
            </Text>
            <Text style={styles.body}>
              {p.window
                ? `${p.window.calendarDays} calendar days from starting this course.`
                : "No course calendar window is specified."}
            </Text>
            <Text style={styles.small}>
              Times shown in {zone}.{" "}
              {p.window?.pauseRule === "approved_only"
                ? "Pauses require approval."
                : p.window
                  ? "The calendar continues while you are away."
                  : ""}
            </Text>
            <Text style={styles.body}>
              {p.hardDeadline
                ? `Course must finish by ${policyDate(p.hardDeadline, zone)}. This may end the window earlier.`
                : "No separate fixed end date is specified."}
            </Text>
            {p.targetDate && (
              <Text style={styles.small}>
                Suggested target: {policyDate(p.targetDate, zone)}. This is a
                planning target, not an extension.
              </Text>
            )}
            <Text style={styles.small}>
              {p.existingMaterialAccess === "read_only"
                ? "Course default: after the window closes, existing material remains available for review."
                : "Access to existing material closes when the learning window ends."}
            </Text>
          </View>
          <View style={styles.card}>
            <Text accessibilityRole="header" style={styles.heading}>
              Extension allowance
            </Text>
            <Text style={styles.body}>
              {p.extensions?.enabled
                ? `${p.extensions.calendarDays} calendar days total, across up to ${p.extensions.maxGrants} extensions. Each extension can add at most ${p.extensions.maxDaysPerGrant} days.`
                : "No extension allowance is included by default."}
            </Text>
            <Text style={styles.small}>
              Extensions are optional offers. Nothing is added or spent unless
              you explicitly accept the terms and the server confirms it.
            </Text>
          </View>
          <View style={styles.card}>
            <Text accessibilityRole="header" style={styles.heading}>
              Additional learning limits
            </Text>
            {(Object.keys(quotaLabel) as (keyof typeof quotaLabel)[]).map(
              (key) => (
                <Text key={key} style={styles.small}>
                  {quotaLabel[key]}: {p.work?.[key] ?? "Not specified"}.
                </Text>
              ),
            )}
            <Text style={styles.small}>
              Chapter-specific limits may also apply. Your saved course and
              current chapter dates are shown after starting.
            </Text>
          </View>
        </>
      )}
      <Notice>
        {attempted
          ? "A start request was sent. If it reached the server, the learning window may already be running. Retrying resumes a saved enrollment if one exists."
          : "Choose Start course when you are ready to begin the enrollment and its course window. Reopening an existing enrollment never resets its clock."}
      </Notice>
      <Button
        label={
          pending
            ? "Opening course…"
            : attempted
              ? "Retry start or resume"
              : "Start course"
        }
        kind="primary"
        disabled={pending || !valid}
        onPress={onStart}
      />
    </View>
  );
}
