-- Receipts and events that kept personal data past erasure.
--
-- 1. Course admin command receipts stored the whole admin workspace view as their response:
-- every enrollment's profile (name, goal) and evidence review notes, in plain text, kept
-- forever and never reached by erasure. Receipts now store only the command's own receipt and
-- message; a reply, first or replayed, rebuilds the workspace view as it is (admin-routes.ts).
-- Existing receipts lose the stored view the same way, so a replay of one answers like a
-- replay of a new one.
UPDATE admin_command_receipts SET response = response - 'workspace' WHERE response ? 'workspace';

-- 2. Account erasure removed the login name from app_users but not from what staff commands
-- recorded about the person: people_command_receipts responses and the matching workspace
-- people.* events (loginName, and a revocation's free-text reason), the receipts' request
-- digests (a SHA-256 over the invited display name and login name, open to guessing), and the
-- password-login throttle rows keyed by a SHA-256 of the login name. account-erasure.ts calls
-- this inside the erasure transaction, before the login name is cleared. As with
-- erase_enrollment_digests (065), the receipt rows stay and their digests become the tombstone
-- 'erased', so their idempotency keys stay reserved and a replay is refused (410
-- ACCOUNT_ERASED, people-routes.ts). Identifiers, roles and grant fields remain for audit.
CREATE FUNCTION erase_account_records(p_user uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  counts jsonb := '{}'::jsonb;
  n bigint;
  login text;
BEGIN
  SELECT login_name INTO login FROM app_users WHERE id = p_user;

  UPDATE learning_events e SET payload = (e.payload - 'loginName' - 'reason') || '{"accountErased":true}'::jsonb
    FROM people_command_receipts r
   WHERE r.response->>'userId' = p_user::text
     AND e.workspace_id = r.workspace_id AND e.idempotency_key = 'people:' || r.idempotency_key
     AND e.event_type LIKE 'people.%' AND NOT e.payload ? 'accountErased';
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('peopleEvents', n);

  UPDATE people_command_receipts SET request_digest = 'erased',
         response = (response - 'loginName' - 'reason') || '{"accountErased":true}'::jsonb
   WHERE response->>'userId' = p_user::text AND request_digest <> 'erased';
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('peopleReceipts', n);

  -- passwords.ts throttleKey('login', loginName): sha256 of 'login', a zero byte, the name.
  n := 0;
  IF login IS NOT NULL THEN
    DELETE FROM password_login_failures
     WHERE account_key = encode(sha256('login'::bytea || '\x00'::bytea || convert_to(login, 'UTF8')), 'hex');
    GET DIAGNOSTICS n = ROW_COUNT;
  END IF;
  counts := counts || jsonb_build_object('loginThrottleRows', n);
  RETURN counts;
END $$;

-- Accounts erased before this migration (their login names are already gone, and their
-- throttle rows expire with the login window).
SELECT erase_account_records(user_id) FROM account_erasures;
