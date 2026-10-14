-- Optional passkey (WebAuthn) sign-in. Passwords remain the primary credential; a
-- passkey is a convenience alternative a signed-in person adds to their own account.

-- The WebAuthn user handle: 32 random bytes per account, created with the account's
-- first passkey. It is opaque (not the account id, subject or login name), so an
-- authenticator never stores anything that identifies the person to another site.
ALTER TABLE app_users ADD COLUMN passkey_user_handle text UNIQUE
  CHECK (passkey_user_handle IS NULL OR passkey_user_handle ~ '^[A-Za-z0-9_-]{43}$');

-- One row per registered authenticator credential. credential_id is the
-- authenticator-chosen id (base64url); public_key is the COSE public key; sign_count
-- is the last signature counter seen (0 for authenticators that do not count).
CREATE TABLE passkey_credentials (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES app_users(id),
  credential_id text NOT NULL UNIQUE CHECK (credential_id ~ '^[A-Za-z0-9_-]+$' AND length(credential_id) BETWEEN 16 AND 1366),
  public_key bytea NOT NULL CHECK (octet_length(public_key) BETWEEN 16 AND 2048),
  sign_count bigint NOT NULL DEFAULT 0 CHECK (sign_count >= 0 AND sign_count <= 4294967295),
  transports text[] NOT NULL DEFAULT '{}',
  device_type text NOT NULL CHECK (device_type IN ('singleDevice','multiDevice')),
  backed_up boolean NOT NULL DEFAULT false,
  friendly_name text NOT NULL CHECK (length(friendly_name) BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_used_at timestamptz
);
CREATE INDEX passkey_credentials_user ON passkey_credentials (user_id, created_at);

-- Single-use ceremony challenges with a short lifetime. A registration challenge is
-- bound to the account and to the session that requested it; a sign-in challenge is
-- bound to neither (discoverable credentials). Rows are deleted when consumed and
-- expired rows are deleted as new challenges are issued. address_key is the SHA-256
-- throttle key of the requesting client address, used to bound open sign-in challenges.
CREATE TABLE passkey_challenges (
  id uuid PRIMARY KEY,
  purpose text NOT NULL CHECK (purpose IN ('registration','authentication')),
  challenge text NOT NULL UNIQUE CHECK (challenge ~ '^[A-Za-z0-9_-]{43}$'),
  user_id uuid REFERENCES app_users(id),
  session_hash text CHECK (session_hash IS NULL OR session_hash ~ '^[a-f0-9]{64}$'),
  address_key text NOT NULL CHECK (address_key ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((purpose = 'registration') = (user_id IS NOT NULL AND session_hash IS NOT NULL))
);
CREATE INDEX passkey_challenges_expires ON passkey_challenges (expires_at);
CREATE INDEX passkey_challenges_address ON passkey_challenges (address_key, expires_at);
