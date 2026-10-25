import React from "react";
import { Text, View } from "react-native";
import type { CatalogCourse } from "../client/policyClient";
import {
  policyDate,
  policyTimeZone,
  previewPolicyAvailable,
  QUOTA_METRICS,
  quotaName,
} from "../connected/policyPresentation";
import { useI18n } from "../i18n";
import { Badge, Button, Notice, styles, Heading } from "./ui";
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
  const i18n = useI18n(),
    t = i18n.t;
  const p = course.policy,
    valid = previewPolicyAvailable(p),
    zone = policyTimeZone(p);
  return (
    <View style={{ gap: 22 }}>
      <Button
        label={t("enrollmentPreview.back")}
        kind="quiet"
        disabled={pending}
        onPress={onBack}
      />
      <Badge label={t("enrollmentPreview.badge")} />
      <Heading accessibilityRole="header" style={styles.title}>
        {course.title}
      </Heading>
      {course.summary && <Text style={styles.body}>{course.summary}</Text>}
      {!valid ? (
        <Notice error>
          {t("enrollmentPreview.invalid")}
        </Notice>
      ) : (
        <>
          <View style={styles.card}>
            <Text accessibilityRole="header" style={styles.heading}>
              {t("enrollmentPreview.window.title")}
            </Text>
            <Text style={styles.body}>
              {p.window
                ? t("enrollmentPreview.window.days", { days: p.window.calendarDays })
                : t("enrollmentPreview.window.none")}
            </Text>
            <Text style={styles.small}>
              {p.window?.pauseRule === "approved_only"
                ? t("enrollmentPreview.zone.approval", { zone })
                : p.window
                  ? t("enrollmentPreview.zone.continues", { zone })
                  : t("enrollmentPreview.zone.only", { zone })}
            </Text>
            <Text style={styles.body}>
              {p.hardDeadline
                ? t("enrollmentPreview.deadline", { date: policyDate(p.hardDeadline, zone, i18n) })
                : t("enrollmentPreview.noDeadline")}
            </Text>
            {p.targetDate && (
              <Text style={styles.small}>
                {t("enrollmentPreview.target", { date: policyDate(p.targetDate, zone, i18n) })}
              </Text>
            )}
            <Text style={styles.small}>
              {p.existingMaterialAccess === "read_only"
                ? t("enrollmentPreview.access.readOnly")
                : t("enrollmentPreview.access.closes")}
            </Text>
          </View>
          <View style={styles.card}>
            <Text accessibilityRole="header" style={styles.heading}>
              {t("enrollmentPreview.extensions.title")}
            </Text>
            <Text style={styles.body}>
              {p.extensions?.enabled
                ? t("enrollmentPreview.extensions.enabled", {
                    days: p.extensions.calendarDays,
                    grants: p.extensions.maxGrants,
                    perGrant: p.extensions.maxDaysPerGrant,
                  })
                : t("enrollmentPreview.extensions.none")}
            </Text>
            <Text style={styles.small}>
              {t("enrollmentPreview.extensions.note")}
            </Text>
          </View>
          <View style={styles.card}>
            <Text accessibilityRole="header" style={styles.heading}>
              {t("enrollmentPreview.limits.title")}
            </Text>
            {QUOTA_METRICS.map(
              (key) => {
                const value = p.work?.[key];
                return (
                  <Text key={key} style={styles.small}>
                    {value == null
                      ? t("enrollmentPreview.limits.unspecified", { label: quotaName(key, t) })
                      : t("enrollmentPreview.limits.item", { label: quotaName(key, t), value })}
                  </Text>
                );
              },
            )}
            <Text style={styles.small}>
              {t("enrollmentPreview.limits.note")}
            </Text>
          </View>
        </>
      )}
      <Notice>
        {attempted
          ? t("enrollmentPreview.attempted")
          : t("enrollmentPreview.ready")}
      </Notice>
      <Button
        label={
          pending
            ? t("enrollmentPreview.opening")
            : attempted
              ? t("enrollmentPreview.retry")
              : t("enrollmentPreview.start")
        }
        kind="primary"
        disabled={pending || !valid}
        onPress={onStart}
      />
    </View>
  );
}
