-- Activity observations (059) keep a SHA-256 receipt digest of the observation for idempotent
-- replay. An observation is often a small-domain value (a number in a range, a toggle, one option),
-- so the digest gives it back by guessing. erase_enrollment_digests (065) gains one statement for it,
-- and enrollments erased before this migration are tombstoned once.
CREATE OR REPLACE FUNCTION erase_enrollment_digests(p_enrollment uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  counts jsonb := '{}'::jsonb;
  n bigint;
  previous text := coalesce(current_setting('course_core.erasure_enrollment', true), '');
BEGIN
  -- learner_model_sources is append-only except inside this enrollment's erasure (018).
  PERFORM set_config('course_core.erasure_enrollment', p_enrollment::text, true);

  UPDATE command_receipts SET request_digest = 'erased' WHERE enrollment_id = p_enrollment AND request_digest <> 'erased';
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('commandReceiptDigests', n);

  UPDATE admin_command_receipts SET request_digest = 'erased' WHERE enrollment_id = p_enrollment AND request_digest <> 'erased';
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('adminReceiptDigests', n);

  UPDATE media_command_receipts r SET request_digest = 'erased'
   WHERE r.request_digest <> 'erased' AND r.response->>'jobId' IN (SELECT id::text FROM media_jobs WHERE enrollment_id = p_enrollment);
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('mediaReceiptDigests', n);

  UPDATE media_jobs SET request_digest = 'erased' WHERE enrollment_id = p_enrollment AND request_digest <> 'erased';
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('mediaRequestDigests', n);

  UPDATE rubric_reviews SET criteria = jsonb_set(criteria, '{requestDigest}', '"erased"')
   WHERE enrollment_id = p_enrollment AND criteria ? 'requestDigest' AND criteria->>'requestDigest' IS DISTINCT FROM 'erased';
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('writtenAnswerReviewDigests', n);

  UPDATE rubric_appeals SET findings = jsonb_set(findings, '{requestDigest}', '"erased"')
   WHERE enrollment_id = p_enrollment AND findings ? 'requestDigest' AND findings->>'requestDigest' IS DISTINCT FROM 'erased';
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('writtenAnswerAppealDigests', n);

  UPDATE rubric_assist_requests SET response_digest = 'erased' WHERE enrollment_id = p_enrollment AND response_digest <> 'erased';
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('reviewAssistAnswerDigests', n);

  UPDATE gate_review_requests SET request_digest = 'erased' WHERE enrollment_id = p_enrollment AND request_digest <> 'erased';
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('gateReviewDigests', n);

  UPDATE learner_model_sources SET event_digest = 'erased' WHERE enrollment_id = p_enrollment AND event_digest <> 'erased';
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('learnerModelSourceDigests', n);

  UPDATE supervisor_model_effects SET selection_digest = 'erased' WHERE enrollment_id = p_enrollment AND selection_digest <> 'erased';
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('supervisorModelSelectionDigests', n);

  UPDATE supervisor_tool_calls SET request_digest = 'erased' WHERE enrollment_id = p_enrollment AND request_digest <> 'erased';
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('supervisorToolCallDigests', n);

  -- 076: activity observation receipts hash the observation (often a small-domain value).
  UPDATE activity_observations SET request_digest = 'erased' WHERE enrollment_id = p_enrollment AND request_digest <> 'erased';
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('activityObservationDigests', n);

  -- companion_context_capsules.digest is already set to 'erased' by data-lifecycle.ts (053).

  PERFORM set_config('course_core.erasure_enrollment', previous, true);
  RETURN counts;
END $$;

SELECT erase_enrollment_digests(id) FROM enrollments WHERE status = 'erased';
