/** The course version an attempt counts on: the latest live carry-over of it (carried-checkpoints.ts),
 * else its own. `alias` names the attempts row in the surrounding query. No imports, so any evidence
 * reader can use it. */
export const effectiveDigestSql = (alias = 'a') =>
  `COALESCE((SELECT cc.course_digest FROM carried_checkpoint_attempts cc WHERE cc.attempt_id=${alias}.id AND cc.undone_at IS NULL ORDER BY cc.created_at DESC LIMIT 1),${alias}.course_digest)`;
