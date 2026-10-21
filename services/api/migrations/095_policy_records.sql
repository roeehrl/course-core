-- First-class records of the policy domain. The authoritative state of one enrollment's
-- policy and allowance ledger stays a single versioned document in policy_states (one row
-- lock serializes every change). These tables are its committed projection: they are
-- written by a trigger in the same transaction as every change of that document, from any
-- code path, so they can never disagree with it, and they let staff views and reports
-- query across learners without loading every document. They hold identifiers, units,
-- dates and states only, never learner content.

-- The policy of an enrollment at each policy revision (the scopes and pools in force) and
-- the ledger operation that produced it.
CREATE TABLE learning_policy_revisions(
  enrollment_id uuid NOT NULL REFERENCES enrollments(id),
  policy_revision integer NOT NULL CHECK(policy_revision>0),
  ledger_revision integer NOT NULL CHECK(ledger_revision>=0),
  scopes jsonb NOT NULL,
  pools jsonb NOT NULL,
  cause text NOT NULL CHECK(length(cause) BETWEEN 1 AND 100),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(enrollment_id,policy_revision)
);

CREATE TABLE extension_pools(
  enrollment_id uuid NOT NULL REFERENCES enrollments(id),
  pool_id text NOT NULL CHECK(length(pool_id) BETWEEN 1 AND 256),
  unit text NOT NULL,
  scope_ids jsonb NOT NULL,
  total integer NOT NULL CHECK(total>=0),
  max_per_grant integer NOT NULL CHECK(max_per_grant>0),
  max_grants integer NOT NULL CHECK(max_grants>=0),
  debited integer NOT NULL DEFAULT 0 CHECK(debited>=0),
  refunded integer NOT NULL DEFAULT 0 CHECK(refunded>=0),
  grants_used integer NOT NULL DEFAULT 0 CHECK(grants_used>=0),
  ledger_revision integer NOT NULL CHECK(ledger_revision>=0),
  PRIMARY KEY(enrollment_id,pool_id)
);

CREATE TABLE extension_offers(
  enrollment_id uuid NOT NULL REFERENCES enrollments(id),
  offer_id text NOT NULL CHECK(length(offer_id) BETWEEN 1 AND 256),
  scope_id text NOT NULL,
  state text NOT NULL,
  terms_digest text NOT NULL,
  change jsonb NOT NULL,
  pool_debits jsonb NOT NULL,
  required_approvals jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  last_transition_at timestamptz NOT NULL,
  accepted_at timestamptz,
  PRIMARY KEY(enrollment_id,offer_id)
);
CREATE INDEX extension_offers_pending ON extension_offers(state,last_transition_at) WHERE state IN('proposed','accepted_pending_admin');

CREATE TABLE work_reservations(
  enrollment_id uuid NOT NULL REFERENCES enrollments(id),
  reservation_id text NOT NULL CHECK(length(reservation_id) BETWEEN 1 AND 256),
  scope_id text NOT NULL,
  ancestor_scope_ids jsonb NOT NULL,
  purpose text NOT NULL,
  state text NOT NULL,
  work jsonb NOT NULL,
  admitted_policy_revision integer NOT NULL,
  work_id text,
  funded_by text,
  release_reason text,
  PRIMARY KEY(enrollment_id,reservation_id)
);

CREATE TABLE accommodation_overrides(
  enrollment_id uuid NOT NULL REFERENCES enrollments(id),
  accommodation_id text NOT NULL CHECK(length(accommodation_id) BETWEEN 1 AND 256),
  kind text NOT NULL,
  scope_id text NOT NULL,
  adjustment jsonb NOT NULL,
  new_policy_revision integer NOT NULL,
  batch_id text,
  authorized_by text NOT NULL,
  authorized_at timestamptz NOT NULL,
  reason_ref text NOT NULL,
  PRIMARY KEY(enrollment_id,accommodation_id)
);
CREATE INDEX accommodation_overrides_batch ON accommodation_overrides(batch_id) WHERE batch_id IS NOT NULL;

CREATE TABLE closure_reports(
  enrollment_id uuid PRIMARY KEY REFERENCES enrollments(id),
  closed_at timestamptz NOT NULL,
  reason text NOT NULL,
  coverage text NOT NULL,
  mastery text NOT NULL,
  uncovered_objective_ids jsonb NOT NULL,
  unproven_concept_ids jsonb NOT NULL,
  policy_revision integer NOT NULL
);

-- The resolved constraints of every scope at one policy and ledger revision: deadlines,
-- quotas, and which level binds. Written by the deadline-timer planner (wakeups.ts), which
-- resolves them anyway to plan the timers, and replaced when a newer revision is resolved.
CREATE TABLE policy_constraint_snapshots(
  enrollment_id uuid NOT NULL REFERENCES enrollments(id),
  scope_id text NOT NULL CHECK(length(scope_id) BETWEEN 1 AND 256),
  policy_revision integer NOT NULL,
  ledger_revision integer NOT NULL,
  effective_deadline timestamptz,
  binding_scope_id text,
  binding_level text,
  snapshot jsonb NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(enrollment_id,scope_id)
);

CREATE FUNCTION policy_items(value jsonb) RETURNS SETOF jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_array_elements(CASE WHEN jsonb_typeof(value)='array' THEN value ELSE '[]'::jsonb END)
$$;

CREATE FUNCTION project_policy_state() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s jsonb := NEW.snapshot;
BEGIN
  INSERT INTO learning_policy_revisions(enrollment_id,policy_revision,ledger_revision,scopes,pools,cause)
    VALUES(NEW.enrollment_id,NEW.policy_revision,NEW.ledger_revision,coalesce(s->'scopes','[]'),coalesce(s->'pools','[]'),
      coalesce(left(s->'audit'->-1->>'operation',100),'created'))
    ON CONFLICT DO NOTHING;
  INSERT INTO extension_pools(enrollment_id,pool_id,unit,scope_ids,total,max_per_grant,max_grants,debited,refunded,grants_used,ledger_revision)
    SELECT NEW.enrollment_id,p->>'poolId',p->>'unit',p->'scopeIds',(p->>'total')::int,(p->>'maxPerGrant')::int,(p->>'maxGrants')::int,
      coalesce((SELECT sum((d->>'amount')::int) FROM policy_items(s->'grants') g, policy_items(g->'poolDebits') d WHERE d->>'poolId'=p->>'poolId'),0),
      coalesce((SELECT sum((r->>'amount')::int) FROM policy_items(s->'refunds') r WHERE r->>'poolId'=p->>'poolId'),0),
      (SELECT count(*) FROM policy_items(s->'grants') g, policy_items(g->'poolDebits') d WHERE d->>'poolId'=p->>'poolId'),
      NEW.ledger_revision
    FROM policy_items(s->'pools') p WHERE p ? 'poolId'
    ON CONFLICT(enrollment_id,pool_id) DO UPDATE SET debited=EXCLUDED.debited,refunded=EXCLUDED.refunded,grants_used=EXCLUDED.grants_used,
      total=EXCLUDED.total,max_per_grant=EXCLUDED.max_per_grant,max_grants=EXCLUDED.max_grants,scope_ids=EXCLUDED.scope_ids,ledger_revision=EXCLUDED.ledger_revision;
  INSERT INTO extension_offers(enrollment_id,offer_id,scope_id,state,terms_digest,change,pool_debits,required_approvals,created_at,expires_at,last_transition_at,accepted_at)
    SELECT NEW.enrollment_id,o->'terms'->>'offerId',o->'terms'->>'scopeId',o->>'state',o->>'termsDigest',o->'terms'->'change',
      coalesce(o->'terms'->'poolDebits','[]'),coalesce(o->'terms'->'requiredApprovals','[]'),(o->'terms'->>'createdAt')::timestamptz,
      (o->'terms'->>'expiresAt')::timestamptz,(o->>'lastTransitionAt')::timestamptz,(o->'acceptance'->>'acceptedAt')::timestamptz
    FROM policy_items(s->'offers') o WHERE o->'terms' ? 'offerId'
    ON CONFLICT(enrollment_id,offer_id) DO UPDATE SET state=EXCLUDED.state,last_transition_at=EXCLUDED.last_transition_at,accepted_at=EXCLUDED.accepted_at;
  INSERT INTO work_reservations(enrollment_id,reservation_id,scope_id,ancestor_scope_ids,purpose,state,work,admitted_policy_revision,work_id,funded_by,release_reason)
    SELECT NEW.enrollment_id,r->>'reservationId',r->>'scopeId',coalesce(r->'ancestorScopeIds','[]'),coalesce(r->>'purpose','extra'),r->>'state',r->'work',
      (r->>'admittedPolicyRevision')::int,r->>'workId',r->'funding'->>'reservationId',r->'release'->>'reason'
    FROM policy_items(s->'reservations') r WHERE r ? 'reservationId'
    ON CONFLICT(enrollment_id,reservation_id) DO UPDATE SET state=EXCLUDED.state,work=EXCLUDED.work,work_id=EXCLUDED.work_id,release_reason=EXCLUDED.release_reason;
  INSERT INTO accommodation_overrides(enrollment_id,accommodation_id,kind,scope_id,adjustment,new_policy_revision,batch_id,authorized_by,authorized_at,reason_ref)
    SELECT NEW.enrollment_id,a->>'accommodationId',a->>'kind',a->'adjustment'->>'scopeId',a->'adjustment',(a->>'newPolicyRevision')::int,a->>'batchId',
      a->'authorityReceipt'->>'actorId',(a->'authorityReceipt'->>'authorizedAt')::timestamptz,a->>'reasonRef'
    FROM policy_items(s->'accommodations') a WHERE a ? 'accommodationId'
    ON CONFLICT DO NOTHING;
  IF jsonb_typeof(s->'closure')='object' THEN
    INSERT INTO closure_reports(enrollment_id,closed_at,reason,coverage,mastery,uncovered_objective_ids,unproven_concept_ids,policy_revision)
      VALUES(NEW.enrollment_id,(s->'closure'->>'closedAt')::timestamptz,s->'closure'->>'reason',s->'closure'->>'coverage',s->'closure'->>'mastery',
        coalesce(s->'closure'->'uncoveredObjectiveIds','[]'),coalesce(s->'closure'->'unprovenConceptIds','[]'),NEW.policy_revision)
      ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER policy_states_project AFTER INSERT OR UPDATE ON policy_states FOR EACH ROW EXECUTE FUNCTION project_policy_state();
-- Existing enrollments: project their current document once.
UPDATE policy_states SET snapshot=snapshot;

-- The definition of each progression gate in each course version that decisions are made
-- against. A gate decision names (course_digest, gate_id, gate_version); this is the gate
-- revision it was judged by. Recorded when a release is stored, and for every existing one.
CREATE TABLE gate_revisions(
  course_digest text NOT NULL CHECK(course_digest ~ '^[a-f0-9]{64}$'),
  gate_id text NOT NULL CHECK(length(gate_id) BETWEEN 1 AND 200),
  gate_version text NOT NULL CHECK(length(gate_version) BETWEEN 1 AND 100),
  definition jsonb NOT NULL CHECK(jsonb_typeof(definition)='object'),
  first_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(course_digest,gate_id)
);
CREATE FUNCTION record_gate_revisions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO gate_revisions(course_digest,gate_id,gate_version,definition)
    SELECT NEW.digest,g->>'id',coalesce(g->>'version','legacy-0.4'),g FROM policy_items(NEW.server_bundle->'gates') g
    WHERE jsonb_typeof(g)='object' AND length(g->>'id') BETWEEN 1 AND 200
    ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;
CREATE TRIGGER course_releases_gate_revisions AFTER INSERT ON course_releases FOR EACH ROW EXECUTE FUNCTION record_gate_revisions();
INSERT INTO gate_revisions(course_digest,gate_id,gate_version,definition)
  SELECT r.digest,g->>'id',coalesce(g->>'version','legacy-0.4'),g FROM course_releases r, policy_items(r.server_bundle->'gates') g
  WHERE jsonb_typeof(g)='object' AND length(g->>'id') BETWEEN 1 AND 200
  ON CONFLICT DO NOTHING;
