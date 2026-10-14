-- Username/password sign-in. A login name is separate from the opaque `subject`
-- (invited accounts have subjects like invite:<workspace>:<user>). It is stored
-- already NFKC-normalised and lower-cased, so the unique constraint is
-- case-insensitive.
ALTER TABLE app_users ADD COLUMN login_name text UNIQUE
  CHECK (login_name IS NULL OR (login_name = lower(login_name) AND login_name ~ '^[a-z0-9][a-z0-9._@+:-]{0,126}[a-z0-9]$'));

-- PHC-style string: $scrypt$ln=<log2 N>,r=<r>,p=<p>$<salt b64>$<hash b64>.
-- Algorithm and parameters are stored per user so they can be upgraded on sign-in.
CREATE TABLE password_credentials (
  user_id uuid PRIMARY KEY REFERENCES app_users(id),
  password_hash text NOT NULL CHECK (password_hash ~ '^\$scrypt\$ln=[0-9]{1,2},r=[0-9]{1,2},p=[0-9]{1,2}\$[A-Za-z0-9+/]{16,64}\$[A-Za-z0-9+/]{32,128}$'),
  must_change boolean NOT NULL DEFAULT false,
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Failed password attempts, durable across API restarts and shared by every API
-- process using this database. Keys are SHA-256 hashes of the normalised login
-- name (known or not, so no account enumeration) and of the client address.
-- Rows older than the throttle window are deleted as new failures are recorded.
CREATE TABLE password_login_failures (
  id bigserial PRIMARY KEY,
  account_key text NOT NULL CHECK (account_key ~ '^[a-f0-9]{64}$'),
  address_key text NOT NULL CHECK (address_key ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX password_login_failures_account ON password_login_failures (account_key, created_at);
CREATE INDEX password_login_failures_address ON password_login_failures (address_key, created_at);
CREATE INDEX password_login_failures_created ON password_login_failures (created_at);
