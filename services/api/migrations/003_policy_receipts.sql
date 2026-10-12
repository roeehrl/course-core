CREATE TABLE extension_grants (
  id uuid PRIMARY KEY,
  enrollment_id uuid NOT NULL REFERENCES enrollments(id),
  offer_id uuid NOT NULL,
  terms_digest text NOT NULL,
  learner_id uuid NOT NULL REFERENCES app_users(id),
  consent_receipt jsonb NOT NULL,
  ledger_transaction_id uuid NOT NULL UNIQUE,
  idempotency_key text NOT NULL,
  grant_data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (enrollment_id, offer_id),
  UNIQUE (enrollment_id, idempotency_key)
);

CREATE TABLE scope_anchors (
  enrollment_id uuid NOT NULL REFERENCES enrollments(id),
  scope_id text NOT NULL,
  anchor_kind text NOT NULL,
  anchored_at timestamptz NOT NULL,
  resolved_deadline timestamptz NOT NULL,
  PRIMARY KEY (enrollment_id, scope_id)
);
