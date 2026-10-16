-- Erasure also removes digests of what it redacts (erased-digests.ts).
--
-- Idempotency receipts and provenance rows keep a plain SHA-256 of the request or
-- record they bind. When the hashed input comes from a small domain (a 0-10 answer,
-- a toggle, a multiple-choice option, a short profile field) the erased value can be
-- recovered by hashing every candidate and comparing. Erasure therefore replaces each
-- such digest with the tombstone 'erased': a fixed marker that matches no request
-- digest and says plainly that the value was removed.
--
-- The rows themselves stay, so idempotency keys remain reserved: a replay after
-- erasure finds the receipt and is answered 410 ENROLLMENT_ERASED; it is never
-- applied again.

-- 1. Columns whose format check would refuse the tombstone.
ALTER TABLE supervisor_tool_calls DROP CONSTRAINT supervisor_tool_calls_request_digest_check,
  ADD CONSTRAINT supervisor_tool_calls_request_digest_check CHECK (request_digest ~ '^[a-f0-9]{64}$' OR request_digest = 'erased');
ALTER TABLE media_jobs DROP CONSTRAINT media_jobs_request_digest_check,
  ADD CONSTRAINT media_jobs_request_digest_check CHECK (request_digest ~ '^[a-f0-9]{64}$' OR request_digest = 'erased');
ALTER TABLE media_command_receipts DROP CONSTRAINT media_command_receipts_request_digest_check,
  ADD CONSTRAINT media_command_receipts_request_digest_check CHECK (request_digest ~ '^[a-f0-9]{64}$' OR request_digest = 'erased');
ALTER TABLE learner_model_sources DROP CONSTRAINT learner_model_sources_event_digest_check,
  ADD CONSTRAINT learner_model_sources_event_digest_check CHECK (event_digest ~ '^[a-f0-9]{64}$' OR event_digest = 'erased');
ALTER TABLE supervisor_model_effects DROP CONSTRAINT supervisor_model_effects_selection_digest_check,
  ADD CONSTRAINT supervisor_model_effects_selection_digest_check CHECK (selection_digest ~ '^[a-f0-9]{64}$' OR selection_digest = 'erased');
ALTER TABLE rubric_assist_requests DROP CONSTRAINT rubric_assist_requests_response_digest_check,
  ADD CONSTRAINT rubric_assist_requests_response_digest_check CHECK (response_digest ~ '^[a-f0-9]{64}$' OR response_digest = 'erased');

-- 2. Course-level admin receipts name no enrollment, yet some bind a learner's data (a staff
-- profile, an evidence review note, a dispute resolution). They now record the enrollment
-- they concern so erasure can find them. Commands that create, edit or review one
-- enrollment record it (admin-routes.ts, evidence-disputes.ts).
ALTER TABLE admin_command_receipts ADD COLUMN enrollment_id uuid REFERENCES enrollments(id);
CREATE INDEX admin_command_receipts_enrollment ON admin_command_receipts(enrollment_id) WHERE enrollment_id IS NOT NULL;
-- Earlier dispute resolutions name their dispute in the stored response.
UPDATE admin_command_receipts r SET enrollment_id = c.enrollment_id
  FROM learner_evidence_controls c
 WHERE r.enrollment_id IS NULL AND c.kind = 'dispute' AND r.response->>'disputeId' = c.id::text;
-- Earlier staff enrollments, profile edits and evidence reviews: the command's audit event and the enrollment's
-- own event share a transaction, so the same actor, workspace and transaction timestamp. Link
-- a receipt only when exactly one enrollment matches; ambiguous ones stay unlinked.
UPDATE admin_command_receipts r SET enrollment_id = m.enrollment_id
  FROM (SELECT r2.catalog_id, r2.idempotency_key, (array_agg(DISTINCT e.enrollment_id))[1] AS enrollment_id
          FROM admin_command_receipts r2
          JOIN admin_course_catalog cat ON cat.id = r2.catalog_id
          JOIN learning_events a ON a.workspace_id = cat.workspace_id
           AND a.idempotency_key = 'admin:' || r2.catalog_id || ':' || r2.idempotency_key
           AND a.event_type IN ('admin.enrollment.created', 'admin.profile.updated', 'admin.evidence.reviewed')
          JOIN learning_events e ON e.workspace_id = a.workspace_id AND e.created_at = a.created_at
           AND e.actor_id IS NOT DISTINCT FROM a.actor_id AND e.enrollment_id IS NOT NULL
         WHERE r2.enrollment_id IS NULL
         GROUP BY r2.catalog_id, r2.idempotency_key
        HAVING count(DISTINCT e.enrollment_id) = 1) m
 WHERE r.catalog_id = m.catalog_id AND r.idempotency_key = m.idempotency_key;

-- 3. The tombstoning itself, one statement per digest. data-lifecycle.ts calls this inside
-- every enrollment erasure; it returns the number of rows changed per label. To cover a new
-- digest, replace this function in a later migration with one more statement and re-run it
-- for enrollments already erased (as step 4 does).
CREATE FUNCTION erase_enrollment_digests(p_enrollment uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
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

  -- companion_context_capsules.digest is already set to 'erased' by data-lifecycle.ts (053).

  PERFORM set_config('course_core.erasure_enrollment', previous, true);
  RETURN counts;
END $$;

-- 4. Enrollments erased before this migration still hold plain digests.
SELECT erase_enrollment_digests(id) FROM enrollments WHERE status = 'erased';
