/**
 * The total AI spending limit that applies to one learner (requirement B09). A learner's own
 * limit (limit_source='own', set by staff) always wins. Otherwise the workspace's choice for
 * every learner applies (supervisor_workspace_budgets.default_enrollment_limit_mode):
 *   'limit'      each learner may spend up to the workspace default amount;
 *   'unlimited'  the owner chose not to cap learners one by one: no per-learner ceiling, while
 *                the workspace total and each learner's daily and per-lesson limits still apply;
 *   'unset'      nothing chosen yet: 0, so nothing paid runs for that learner.
 * `null` means "no per-learner ceiling"; it is only ever the result of the explicit 'unlimited'.
 */
export type DefaultLearnerLimitMode = 'unset' | 'limit' | 'unlimited';
export const DEFAULT_LEARNER_LIMIT_MODES = ['unset', 'limit', 'unlimited'] as const;

interface EnrollmentLimitRow { limit_source?: string | null; limit_micro_usd?: string | number | null; limit_tokens?: string | number | null }
interface WorkspaceDefaultRow {
  default_enrollment_limit_mode?: string | null;
  default_enrollment_limit_micro_usd?: string | number | null;
  default_enrollment_limit_tokens?: string | number | null;
}
export function effectiveLearnerLimit(enrollment: EnrollmentLimitRow | undefined, workspace: WorkspaceDefaultRow | undefined): { microUsd: number; tokens: number } | null {
  if (enrollment?.limit_source === 'own') return { microUsd: Number(enrollment.limit_micro_usd ?? 0), tokens: Number(enrollment.limit_tokens ?? 0) };
  if (workspace?.default_enrollment_limit_mode === 'unlimited') return null;
  return { microUsd: Number(workspace?.default_enrollment_limit_micro_usd ?? 0), tokens: Number(workspace?.default_enrollment_limit_tokens ?? 0) };
}
/** The same rule in SQL over an enrollment budget row `b` and its workspace budget row `w`
 * (either may be missing in a LEFT JOIN): NULL only for the explicit 'unlimited'. */
export const effectiveLearnerLimitSql = (column: 'micro_usd' | 'tokens', b = 'b', w = 'w') =>
  `(CASE WHEN ${b}.limit_source='own' THEN ${b}.limit_${column} WHEN ${w}.default_enrollment_limit_mode='unlimited' THEN NULL
     ELSE COALESCE(${w}.default_enrollment_limit_${column},0) END)`;
/** Which rule gave a learner their limit: their own, the workspace amount, or none by choice. */
export const learnerLimitSourceSql = (b = 'b', w = 'w') =>
  `(CASE WHEN ${b}.limit_source='own' THEN 'own' WHEN ${w}.default_enrollment_limit_mode='unlimited' THEN 'unlimited' ELSE 'default' END)`;
