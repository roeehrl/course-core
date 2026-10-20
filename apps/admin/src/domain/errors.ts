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
  | "active_release"
  | "no_replacement"
  | "item_defective"
  | "policy_infeasible"
  | "shortened_grant"
  | "ledger_refused"
  | "eval_required";
export class AdminError extends Error {
  constructor(
    public readonly code: AdminErrorCode,
    /** Allowlisted, schema-checked facts for a few codes (eval_required); never a raw body. */
    public readonly details?: unknown,
  ) {
    super(code);
    this.name = "AdminError";
  }
}
export function errorMessage(error: unknown): string {
  const messages: Record<AdminErrorCode, string> = {
    permission_denied:
      "Permission denied. Your account cannot perform this action. Ask an administrator to review your access.",
    stale_revision:
      "This workspace changed since you opened it. Refresh the latest revision, then review your changes again.",
    pending_review:
      "This action is waiting for review. Approval must be recorded before it can continue.",
    config_absent:
      "Required provider configuration is absent. No provider action was performed.",
    validation:
      "The request could not be accepted. Check the fields, limits and consent, then try again.",
    not_found:
      "This item is no longer available. Refresh the workspace to see the current state.",
    unavailable:
      "The workspace service is unavailable. Your unsaved edits are still here. Try again when ready.",
    parent_cap:
      "A binding ancestor or ultimate deadline prevents this extension. No partial extension was silently substituted; choose different terms or review the ancestor policy.",
    per_grant_limit:
      "The requested calendar days exceed this allowance pool's maximum days per grant.",
    allowance_exhausted:
      "The allowance has insufficient remaining calendar days or grants. No balance changed.",
    scope_not_extendable:
      "This scope has no enabled extension allowance or no local deadline/window to extend. Open-ended mode does not remove inherited ancestor caps.",
    inactive_enrollment:
      "This enrollment is paused or closed. An extension cannot silently reopen it.",
    offer_limit:
      "An outstanding offer, offer-frequency limit or cooldown prevents another proposal for this scope.",
    policy_reset_forbidden:
      "The policy engine rejected a reset of established anchors, scope identities, work counters or ultimate ceilings. Review the existing policy and propose a preserving migration.",
    review_invalid:
      "Review cannot promote an incorrect, assisted, obsolete or unsupported result into mastery. The recorded grade and independence remain unchanged.",
    immutable_release:
      "Published or archived releases are immutable. Create a new validated draft instead.",
    runtime_unsupported:
      "Publication is blocked by the installed runtime: a required evaluator, activity handler or visual validator is absent or rejected the scene, or a gate's conversational evaluator names no single cited rubric (name a 0.5 evaluator definition bound to exactly one rubric, or a deterministic evaluator whose installed adapter confirms quoted findings). Metadata does not establish a working handler.",
    impact_changed:
      "The impact changed since you reviewed it (new learners, evidence or content). Review the updated impact, then confirm again.",
    active_release:
      "The release new learners start on cannot be archived. Select another release for new learners first.",
    no_replacement:
      "No other item can replace this one. Confirm that learners lose this route to the checkpoint, or add a replacement in a new release.",
    item_defective:
      "This item is already marked defective on this release.",
    policy_infeasible:
      "The required core path and final assessment do not fit this envelope. Nothing was saved; review the disclosed issues and alternatives. Mastery criteria are never lowered to make a plan fit.",
    eval_required:
      "This provider, model or prompt revision has no passing agent evaluation. Record an evaluation report, or ask a workspace owner to record an override, then save again. Nothing was changed.",
    shortened_grant:
      "This change shortens time already promised by a grant, exception or accommodation. Acknowledge each affected grant explicitly before applying it.",
    ledger_refused:
      "The ledger refused this operation: the grant is already revoked, the refund exceeds what the grant debited, or the item no longer exists. Nothing changed.",
    invalid_response:
      "The service returned an incompatible response. No update was applied to this view.",
  };
  return messages[error instanceof AdminError ? error.code : "unavailable"];
}
