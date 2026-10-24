/**
 * What a staff command did, as a code and parameters. The admin app words each code in the
 * staff member's language (apps/admin/src/i18n/messages/<locale>/serverMessages.json, key code.<CODE>); the
 * API never sends the sentence itself (docs/i18n.md, "The API speaks codes, not prose").
 * Every code here needs an English and a Hebrew message: test/staff-messages.test.ts checks.
 */
export const STAFF_MESSAGE_CODES = [
  "EVIDENCE_REVIEW_ACCEPTED",
  "EVIDENCE_INVALIDATED",
  "RELEASE_ARCHIVED",
  "RELEASE_ACTIVATED",
  "RELEASE_PUBLISHED",
  "RELEASE_APPROVED",
  "RELEASE_SUBMITTED",
  "COURSE_SAVED",
  "DRAFT_CREATED",
  "DRAFT_SAVED",
  "ITEM_DEFECTIVE",
  "ENROLLMENT_CREATED",
  "PROFILE_SAVED",
  "PROVIDER_REQUESTED",
  "OFFER_PROPOSED",
  "POLICY_MIGRATED",
  "PAUSE_APPLIED",
  "OUTAGE_APPLIED",
  "ACCOMMODATION_APPLIED",
  "POLICY_SETTINGS_SAVED",
  "OFFER_APPROVED",
  "OFFER_REJECTED",
  "GRANT_REVOKED",
  "ALLOWANCE_REFUNDED",
  "EXCEPTION_APPLIED",
  "COHORT_MIGRATED",
] as const;
export type StaffMessageCode = (typeof STAFF_MESSAGE_CODES)[number];
export interface StaffMessage {
  code: StaffMessageCode;
  /** Values the message names: counts, item IDs. Never prose. */
  params?: Record<string, string | number>;
}
export const staffMessage = (code: StaffMessageCode, params?: Record<string, string | number>): StaffMessage =>
  params ? { code, params } : { code };

/** Release checks (admin-routes.ts `validation`), worded by the admin app under `releaseChecks.code.<CODE>`. */
export const RELEASE_CHECK_CODES = [
  "SDK_DIGEST_MATCHES",
  "SDK_DIGEST_MISMATCH",
  "RUNTIME_SUPPORTED",
  "RUNTIME_UNSUPPORTED",
  "SANDBOXED_WEB_ACTIVITIES",
  "GATE_RECOGNITION_ONLY",
  "GATE_PARTIAL_OBJECTIVES",
  "GATE_TRANSFER_MISSING",
  "GATE_MISCONCEPTION_CHECK_MISSING",
  "GATE_EVIDENCE_UNREACHABLE",
] as const;
export type ReleaseCheckCode = (typeof RELEASE_CHECK_CODES)[number];
