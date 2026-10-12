import type { LearningPolicy } from "@course-core/sdk";
import type { ServerSnapshot } from "../client/apiClient";
export function policyTimeZone(policy: LearningPolicy | undefined): string {
  const zone = policy?.window?.timeZone ?? "UTC";
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return zone;
  } catch {
    return "UTC";
  }
}
export function policyDate(value: string | null, zone = "UTC"): string {
  if (value === null) return "No calendar deadline specified";
  if (!Number.isFinite(Date.parse(value))) return "Date unavailable";
  try {
    return `${new Intl.DateTimeFormat("en", { timeZone: zone, year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "shortOffset" }).format(new Date(value))} · ${zone}`;
  } catch {
    return zone === "UTC"
      ? `${new Date(value).toISOString()} · UTC`
      : policyDate(value, "UTC");
  }
}
export function scopeLabel(
  scopeId: string,
  course: ServerSnapshot["course"],
): string {
  if (scopeId === "course") return "Course";
  const chapter = course.chapters.find(
    (row) => `chapter:${row.id}` === scopeId,
  );
  if (chapter) return `Chapter: ${chapter.title}`;
  const episode = course.chapters
    .flatMap((row) => row.episodes)
    .find((row) => `episode:${row.id}` === scopeId);
  return episode ? `Lesson: ${episode.title}` : "Learning scope";
}
export const quotaLabel = {
  additionalMinutes: "Extra learning minutes",
  additionalEpisodes: "Extra lessons",
  remediationCyclesPerConcept: "Review rounds per skill",
} as const;
export function previewPolicyAvailable(
  policy: LearningPolicy | undefined,
): policy is LearningPolicy {
  if (
    !policy ||
    !["bounded", "open_ended"].includes(policy.mode) ||
    !["read_only", "closed"].includes(policy.existingMaterialAccess)
  )
    return false;
  const natural = (v: unknown) =>
    typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
  if (policy.window) {
    if (
      typeof policy.window.timeZone !== "string" ||
      !policy.window.timeZone ||
      !natural(policy.window.calendarDays) ||
      !["enrollment_started", "scope_started", "scope_assigned"].includes(
        policy.window.anchor,
      ) ||
      !["never", "approved_only"].includes(policy.window.pauseRule)
    )
      return false;
    try {
      new Intl.DateTimeFormat("en", { timeZone: policy.window.timeZone });
    } catch {
      return false;
    }
  }
  for (const date of [policy.hardDeadline, policy.targetDate])
    if (
      date !== undefined &&
      (!/(?:Z|[+-]\d{2}:\d{2})$/.test(date) ||
        !Number.isFinite(Date.parse(date)))
    )
      return false;
  if (Object.values(policy.work ?? {}).some((value) => !natural(value)))
    return false;
  if (
    policy.extensions?.enabled &&
    (![
      policy.extensions.calendarDays,
      policy.extensions.maxGrants,
      policy.extensions.maxDaysPerGrant,
    ].every(natural) ||
      policy.extensions.learnerAcceptanceRequired !== true)
  )
    return false;
  if (
    policy.mode === "bounded" &&
    !policy.window &&
    !policy.hardDeadline &&
    !Object.keys(policy.work ?? {}).length
  )
    return false;
  return true;
}
