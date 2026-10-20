-- Ended sign-in sessions (expired or revoked) are purged a while after they end (session-purge.ts).
-- The People screen's "last sign-in" was the newest session row, so it is now kept on the account,
-- set at each sign-in. Accounts erased earlier keep none.
ALTER TABLE app_users ADD COLUMN last_sign_in_at timestamptz;
UPDATE app_users u SET last_sign_in_at = s.latest
  FROM (SELECT user_id, max(created_at) AS latest FROM auth_sessions GROUP BY user_id) s
  WHERE s.user_id = u.id AND u.subject NOT LIKE 'erased:%';
-- When a session stopped working: its revocation, or its expiry if that came first (LEAST ignores NULL).
CREATE INDEX auth_sessions_ended_at ON auth_sessions ((LEAST(revoked_at, expires_at)));
