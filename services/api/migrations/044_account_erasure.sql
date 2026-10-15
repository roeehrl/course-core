-- Account-level erasure and deleting one companion question (account-erasure.ts,
-- companion-routes.ts). Both revoke what was derived from the removed data.
--
-- account_erasures records one completed account erasure: which enrollments it
-- erased and the counts, with the requester's reason. The account row itself is
-- kept as an anonymous identifier so audit rows that name it stay valid; its
-- name, sign-in identity, sessions, credentials and memberships are removed.
CREATE TABLE account_erasures (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL UNIQUE REFERENCES app_users(id),
  enrollment_ids jsonb NOT NULL CHECK (jsonb_typeof(enrollment_ids) = 'array'),
  counts jsonb NOT NULL,
  reason text NOT NULL CHECK (length(reason) BETWEEN 10 AND 1000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- A learner-model suggestion whose source question the learner deleted is
-- revoked: it leaves provider context and is shown as revoked.
ALTER TABLE learner_model_changes DROP CONSTRAINT learner_model_changes_action_check;
ALTER TABLE learner_model_changes ADD CONSTRAINT learner_model_changes_action_check
  CHECK (action IN ('profile.edited','proposal.created','proposal.accepted','proposal.corrected','proposal.disputed','proposal.source_revoked'));
ALTER TABLE learner_model_changes DROP CONSTRAINT learner_model_changes_check;
ALTER TABLE learner_model_changes ADD CONSTRAINT learner_model_changes_check CHECK (
  (action='profile.edited' AND proposal_id IS NULL AND actor_kind='learner') OR
  (action='proposal.created' AND proposal_id IS NOT NULL AND actor_kind='agent') OR
  (action IN ('proposal.accepted','proposal.corrected','proposal.disputed','proposal.source_revoked') AND proposal_id IS NOT NULL AND actor_kind='learner'));
