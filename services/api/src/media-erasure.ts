import type { PoolClient } from "pg";

/**
 * Generated media is requested by staff for one enrollment (migration 035: every job, asset,
 * review and attachment belongs to exactly one enrollment), so what staff wrote for it is
 * personalised to that learner: the title, objective and script sent to the provider, the
 * reviewer's captions, transcript, visual description and rationale, and the reason an
 * attachment was revoked. Erasure redacts that text and deletes the rendered clip, made for this
 * learner only. Kept, because spend and audit totals rely on them and they hold no learner
 * content: identifiers, states and event codes, asset digests, model, settings and pricing,
 * charges and ledger rows, review decisions and boolean findings, and the provider operation's
 * identity (its opaque adapter state is replaced). The request digests of the job and of staff
 * media commands hash the redacted text, so erasure replaces them with a tombstone
 * (erased-digests.ts, migration 065). Jobs of other enrollments are never touched.
 *
 * Placeholders satisfy migration 035's length checks, so no schema change is needed, and every
 * statement is idempotent.
 */
export const ERASED_MEDIA_TEXT = "[erased with the learner's data]";
/** A caption track that still parses as WebVTT and carries no cue. */
export const ERASED_CAPTIONS = "WEBVTT\n\nNOTE erased with the learner's data\n";
export const ERASED_REVOKE_REASON = "Learner data erased";

/** SQL for a stored provider operation without its opaque adapter state. The typed identity
 * (provider, model, registry revision, accounting key, requested duration) stays for audit; the
 * remote handle remains in `provider_operation_id`. */
export const redactedOperationSql = (operation: string) =>
  `jsonb_set(${operation},'{providerState}','{"erased":true}'::jsonb)`;

const JOBS = "SELECT id FROM media_jobs WHERE enrollment_id=$1";

/** Run inside the erasure transaction, after the enrollment's media jobs are locked and ended. */
export async function eraseEnrollmentMedia(client: PoolClient, enrollmentId: string) {
  const count = async (sql: string, extra: string[] = []) => (await client.query(sql, [enrollmentId, ERASED_MEDIA_TEXT, ...extra])).rowCount ?? 0;
  const mediaJobText = await count(`UPDATE media_jobs SET title=$2,objective=$2,script=$2,
      provider_operation=CASE WHEN provider_operation IS NULL THEN NULL ELSE ${redactedOperationSql("provider_operation")} END
    WHERE enrollment_id=$1 AND (title<>$2 OR objective<>$2 OR script<>$2 OR provider_operation->'providerState'<>'{"erased":true}'::jsonb)`);
  const mediaReviews = await count(`UPDATE media_reviews SET rationale=$2,
      transcript=CASE WHEN transcript IS NULL THEN NULL ELSE $2 END,
      visual_description=CASE WHEN visual_description IS NULL THEN NULL ELSE $2 END,
      captions_vtt=CASE WHEN captions_vtt IS NULL THEN NULL ELSE $3 END
    WHERE job_id IN (${JOBS}) AND (rationale<>$2 OR transcript<>$2 OR visual_description<>$2)`, [ERASED_CAPTIONS]);
  // Revocations staff made earlier may give a learner-specific reason; live ones were ended above.
  const mediaRevokeReasons = (await client.query(
    "UPDATE media_attachments SET revoke_reason=$2 WHERE enrollment_id=$1 AND revoked_at IS NOT NULL AND revoke_reason<>$2",
    [enrollmentId, ERASED_REVOKE_REASON])).rowCount ?? 0;
  // Storyboards are written for this learner's episode too (migration 102); their shots go, their
  // state and review stay. Check findings quote the reviewer's text, so they go as well.
  const mediaStoryboards = await count(`UPDATE media_storyboards SET title=$2,objective=$2,script=$2,request_digest='erased',
      shots=jsonb_build_array(jsonb_build_object('id','shot-1','kind','generated','description',$2::text,'narration','','durationSeconds',4)),
      review_note=CASE WHEN review_note IS NULL THEN NULL ELSE $2 END
    WHERE enrollment_id=$1 AND (title<>$2 OR objective<>$2 OR script<>$2)`);
  const mediaChecks = (await client.query(`UPDATE media_checks SET findings='[]'::jsonb WHERE job_id IN (${JOBS}) AND findings<>'[]'::jsonb`, [enrollmentId])).rowCount ?? 0;
  // Check receipts carry the findings for replay; storyboard receipts hash the staff text.
  // (Job receipts' digests are tombstoned by erase_enrollment_digests.)
  const mediaCheckReceipts = (await client.query(`UPDATE media_command_receipts SET response=jsonb_build_object('jobId',response->>'jobId','erased',true)
    WHERE response ? 'rules' AND response->>'jobId' IN (SELECT id::text FROM media_jobs WHERE enrollment_id=$1)`, [enrollmentId])).rowCount ?? 0;
  const mediaStoryboardReceipts = (await client.query(`UPDATE media_command_receipts SET request_digest='erased'
    WHERE request_digest<>'erased' AND response->>'storyboardId' IN (SELECT id::text FROM media_storyboards WHERE enrollment_id=$1)`, [enrollmentId])).rowCount ?? 0;
  // The rendered clip was made for this learner alone; its digest stays on the review.
  const mediaAssets = (await client.query(`DELETE FROM media_assets WHERE job_id IN (${JOBS})`, [enrollmentId])).rowCount ?? 0;
  return { mediaJobText, mediaReviews, mediaRevokeReasons, mediaAssets, mediaStoryboards, mediaChecks, mediaCheckReceipts, mediaStoryboardReceipts };
}
