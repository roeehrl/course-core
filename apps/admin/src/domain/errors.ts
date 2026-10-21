import { englishTranslator, type MessageKey, type Translate } from "../i18n";

export type AdminErrorCode =
  | "permission_denied"
  | "stale_revision"
  | "pending_review"
  | "config_absent"
  | "validation"
  | "not_found"
  | "unavailable"
  | "invalid_response"
  | "parent_cap"
  | "per_grant_limit"
  | "allowance_exhausted"
  | "scope_not_extendable"
  | "inactive_enrollment"
  | "offer_limit"
  | "policy_reset_forbidden"
  | "review_invalid"
  | "immutable_release"
  | "runtime_unsupported"
  | "impact_changed"
  | "older_version"
  | "active_release"
  | "no_replacement"
  | "item_defective"
  | "policy_infeasible"
  | "shortened_grant"
  | "ledger_refused"
  | "eval_required"
  | "looser_than_parent"
  | "no_pool_for_unit"
  | "outage_deadline_only"
  | "cohort_too_large"
  | "no_active_learners"
  | "pause_not_allowed";
export class AdminError extends Error {
  constructor(
    public readonly code: AdminErrorCode,
    /** Allowlisted, schema-checked facts for a few codes (eval_required); never a raw body. */
    public readonly details?: unknown,
    /** The service's reason code when it is a provider setup code (PROVIDER_*), so the
     * provider screens can say exactly what to fix. Never free text. */
    public readonly reason?: string,
  ) {
    super(code);
    this.name = "AdminError";
  }
}
/** The catalog key for an error: its code's message, or "unavailable" for anything else. */
export function errorMessageKey(error: unknown): MessageKey {
  return `errors.error.${error instanceof AdminError ? error.code : "unavailable"}` as MessageKey;
}
/** The message for an error in the caller's locale; unconverted callers get English. */
export function errorMessage(
  error: unknown,
  t: Translate = englishTranslator().t,
): string {
  return t(errorMessageKey(error));
}
