-- In-app notifications (notifications.ts): a bell in the admin app for staff and a smaller one in the
-- learner app. No external service is contacted. A notification is a kind code with parameters
-- (identifiers, counts, versions, never prose: each app words the code in the reader's language), a
-- link to the place to act and a read state per person.
--
-- Staff notifications describe a condition that holds now (approvals waiting, an AI role that needs
-- a check, failed jobs, the AI budget near its limit, backups overdue). They are refreshed from their
-- sources when the person opens the list, keyed by `dedupe_key`; one whose condition has cleared is
-- deleted. Learner notifications record something that happened (the course was updated, a move to
-- a newer version is offered, an answer is ready). At most 200 rows are kept per person and
-- audience; read ones go after 30 days and every one after 180. Erasing an enrollment deletes its
-- rows, and erasing an account deletes all of that person's rows.
CREATE TABLE notifications (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  user_id uuid NOT NULL REFERENCES app_users(id),
  audience text NOT NULL CHECK (audience IN ('staff', 'learner')),
  kind text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_]{0,63}$'),
  params jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(params) = 'object' AND octet_length(params::text) <= 2048),
  -- An app path such as /courses/<id>/reviews; never an external address.
  link text CHECK (link IS NULL OR (link ~ '^/[A-Za-z0-9/_.:-]*$' AND length(link) <= 300)),
  dedupe_key text NOT NULL CHECK (length(dedupe_key) BETWEEN 1 AND 300),
  -- What makes an updated notification new again (for example a later failure).
  fingerprint text NOT NULL DEFAULT '',
  -- A notification whose rank rises (more approvals waiting) is unread again; one that falls is not.
  rank integer NOT NULL DEFAULT 0,
  enrollment_id uuid REFERENCES enrollments(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  read_at timestamptz,
  UNIQUE (user_id, dedupe_key)
);
CREATE INDEX notifications_list ON notifications(user_id, audience, workspace_id, updated_at DESC, id);
CREATE INDEX notifications_enrollment ON notifications(enrollment_id) WHERE enrollment_id IS NOT NULL;
