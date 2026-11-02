-- The learner's feedback on a companion reply (companion-routes.ts): Helpful or Not helpful, an
-- optional short comment saying what was wrong, and whether they reported a problem. One row per
-- reply, changed in place. It is part of the learner's private conversation: their own export
-- includes it and staff copies withhold it (learner-privacy.ts, 'companion'). It is never read by
-- the teaching context and never touches evidence or credit. Messages are redacted, never deleted,
-- so nothing cascades: deleting a question deletes the feedback on the answers it removes, and
-- erasing the enrollment deletes every row (data-lifecycle.ts). Additive: replies from before this
-- migration simply have no feedback.
CREATE TABLE companion_reply_feedback (
  enrollment_id uuid NOT NULL REFERENCES enrollments(id),
  workspace_id uuid NOT NULL,
  message_id uuid NOT NULL REFERENCES companion_messages(id),
  vote text CHECK (vote IN ('helpful', 'not_helpful')),
  comment text CHECK (char_length(comment) <= 500),
  reported boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (enrollment_id, message_id),
  FOREIGN KEY (enrollment_id, workspace_id) REFERENCES enrollments(id, workspace_id)
);
CREATE INDEX companion_reply_feedback_message ON companion_reply_feedback (message_id);
