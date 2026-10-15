-- Every proposed teaching idea has a bounded lifetime unless the learner pins
-- it, whoever wrote it. Learner-written ideas used to have none, so they never
-- lapsed and held active-cap slots forever; an unpinned idea also kept none.
-- The learner can renew an idea for another lifetime ('renewed').
ALTER TABLE teaching_hypothesis_changes DROP CONSTRAINT teaching_hypothesis_changes_action_check;
ALTER TABLE teaching_hypothesis_changes ADD CONSTRAINT teaching_hypothesis_changes_action_check
  CHECK (action IN ('proposed','observed','status_changed','evidence_added','corrected','rejected','pinned','unpinned','probe_scheduled','probe_answered','renewed'));

-- Existing open-ended proposed ideas get the default 30-day lifetime from now,
-- with a new revision and a system entry in their audit trail.
WITH bounded AS (
  UPDATE teaching_hypotheses SET expires_at=clock_timestamp()+interval '30 days',revision=revision+1,updated_at=clock_timestamp()
  WHERE status='proposed' AND NOT pinned AND expires_at IS NULL
  RETURNING id,enrollment_id,workspace_id,revision,expires_at
)
INSERT INTO teaching_hypothesis_changes(id,hypothesis_id,enrollment_id,workspace_id,hypothesis_revision,actor_kind,action,data)
SELECT gen_random_uuid(),id,enrollment_id,workspace_id,revision,'system','renewed',
  jsonb_build_object('reason','bounded_idea_lifetime','expiresAt',expires_at)
FROM bounded;

ALTER TABLE teaching_hypotheses ADD CONSTRAINT teaching_hypotheses_proposed_lifetime
  CHECK (status<>'proposed' OR pinned OR expires_at IS NOT NULL);
