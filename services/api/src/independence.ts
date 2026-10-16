/**
 * Whether an answer counts as independent work. It does only when the check it answered was
 * issued independent-eligible and no assistance was given on it before submission (a hint,
 * a revealed answer, or consented companion help downgrades the check). The attempt's own
 * `mode` names how the check was requested, not whether it stayed unassisted.
 */
export const isIndependentCheck = (check: { independent_eligible: boolean; assistance: string }) =>
  check.independent_eligible && check.assistance === 'none';
/** The same predicate in SQL, over an assessment_challenges row aliased `alias`. */
export const INDEPENDENT_CHECK_SQL = (alias: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(alias)) throw new Error('INVALID_SQL_ALIAS');
  return `(${alias}.independent_eligible AND ${alias}.assistance='none')`;
};
