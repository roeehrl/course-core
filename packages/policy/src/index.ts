export { PolicyError, type PolicyState, type ScopePolicy, type CalendarRule, type CalendarWindow,
  type Work, type Offer, type ExtensionChange, type AuthorityReceipt, type Transition, type Reservation } from './contracts.js';
export { addCalendarDays, resolveCalendarWindow, canonicalInstant, compareInstants, previewCalendarRule, type CalendarTransitionPreview } from './time.js';
export { createPolicyState, resolveConstraints, checkAction, checkActions, checkQuotas, validateScopePolicy,
  type ConstraintSnapshot, type QuotaConstraint, type DeadlineConstraint, type Violation } from './resolver.js';
export { poolBalances, previewExtension, proposeExtension, acceptExtension, grantExtension, disposeOffer } from './extensions.js';
export { reserveWork, commitWork, cancelReservation, coverageSummary } from './work.js';
export { previewPolicyChange, applyPolicyChange, previewAccommodation, applyAccommodation, previewClosure, closeEnrollment, checkClosedQuestion } from './lifecycle.js';
export { previewRevocation, revokeGrant, previewRefund, refundAllowance, previewExceptionalGrant, grantExceptional } from './exceptions.js';
export { checkFeasibility, type FeasibilityIssue, type FeasibilityAlternative } from './feasibility.js';
