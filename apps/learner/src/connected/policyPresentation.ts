import type { LearningPolicy } from "@course-core/sdk";
import type { ServerSnapshot } from "../client/apiClient";
import { englishTranslator, type LearnerTranslator, type MessageKey, type Translate } from "../i18n";
type PolicyFormatter = Pick<LearnerTranslator, "t" | "dateTime">;
export function policyTimeZone(policy: LearningPolicy | undefined): string {
  const zone = policy?.window?.timeZone ?? "UTC";
  try {
    // i18n-ignore: validates the zone name only; nothing is formatted for display
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return zone;
  } catch {
    return "UTC";
  }
}
/** Zone names that are UTC itself: the offset ("GMT+0") would only repeat the zone's name. */
const UTC_ZONES = new Set(["UTC", "Etc/UTC", "Etc/UCT", "UCT", "Etc/Universal", "Universal", "Etc/Zulu", "Zulu"]);
/** A policy instant in the policy's time zone, in the UI locale (pass `useI18n()`): "Nov 8, 2026,
 * 7:41 AM · UTC", or with the offset for any other zone ("… 9:41 AM GMT+2 · Asia/Jerusalem"). */
export function policyDate(value: string | null, zone = "UTC", i18n: PolicyFormatter = englishTranslator()): string {
  if (value === null) return i18n.t("policyPresentation.date.none");
  if (!Number.isFinite(Date.parse(value))) return i18n.t("policyPresentation.date.unavailable");
  try {
    const date = i18n.dateTime(value, { timeZone: zone, year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
      ...(UTC_ZONES.has(zone) ? {} : { timeZoneName: "shortOffset" as const }) });
    return i18n.t("policyPresentation.date.inZone", { date, zone });
  } catch {
    return zone === "UTC"
      ? i18n.t("policyPresentation.date.inZone", { date: new Date(value).toISOString(), zone: "UTC" })
      : policyDate(value, "UTC", i18n);
  }
}
/** Whether a deadline is a time an author set (a course or chapter `hardDeadline` or `targetDate`),
 * rather than one counted from a window such as "90 days after enrollment", whose minute is only
 * when the learner happened to enroll. */
export function authoredInstant(value: string | null | undefined, policies: readonly (LearningPolicy | undefined)[]): boolean {
  const at = value ? Date.parse(value) : NaN;
  if (!Number.isFinite(at)) return false;
  return policies.some((policy) => [policy?.hardDeadline, policy?.targetDate].some((date) => date !== undefined && Date.parse(date) === at));
}
/** A due date as the learner reads it: in their own time zone, the date only unless an author set
 * the time ("Jan 29, 2027", or "Jan 29, 2027, 5:00 PM GMT+2"). */
export function dueDate(value: string, i18n: PolicyFormatter, exactTime = false): string {
  if (!Number.isFinite(Date.parse(value))) return i18n.t("policyPresentation.date.unavailable");
  return i18n.dateTime(value, { year: "numeric", month: "short", day: "numeric",
    ...(exactTime ? { hour: "numeric", minute: "2-digit", timeZoneName: "short" as const } : {}) });
}
export function scopeLabel(
  scopeId: string,
  course: ServerSnapshot["course"],
  t: Translate = englishTranslator().t,
): string {
  if (scopeId === "course") return t("policyPresentation.scope.course");
  // The organization and enrollment levels have no title of their own: name them by level.
  if (scopeId === "organization") return t("policyPresentation.scope.organization");
  if (scopeId === "enrollment") return t("policyPresentation.scope.enrollment");
  const chapter = course.chapters.find(
    (row) => `chapter:${row.id}` === scopeId,
  );
  if (chapter) return t("policyPresentation.scope.chapter", { title: chapter.title });
  const episode = course.chapters
    .flatMap((row) => row.episodes)
    .find((row) => `episode:${row.id}` === scopeId);
  return episode ? t("policyPresentation.scope.lesson", { title: episode.title }) : t("policyPresentation.scope.other");
}
export type QuotaMetric = "additionalMinutes" | "additionalEpisodes" | "remediationCyclesPerConcept";
/** The learner-facing name of a work allowance, in the translator's locale. */
export function quotaName(metric: QuotaMetric, t: Translate = englishTranslator().t): string {
  return t(`policyPresentation.quota.${metric}` as MessageKey);
}
/** Every work allowance, in display order. */
export const QUOTA_METRICS: readonly QuotaMetric[] = ["additionalMinutes", "additionalEpisodes", "remediationCyclesPerConcept"];
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
      // i18n-ignore: validates the zone name only; nothing is formatted for display
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
