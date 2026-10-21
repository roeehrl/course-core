-- The remaining first-class records of the design's data model: learning step instances,
-- playback contexts, extension manifests, platform capability snapshots, debug traces and
-- decision records. Like the policy records (095), most are a committed projection written
-- by a trigger in the same transaction as the authoritative row, from any code path, so they
-- can never disagree with it. They hold identifiers, codes, versions, digests and dates
-- only, never learner text, and each carries a revision that grows with every change.

-- One learning step of a course version for one enrollment: a step the course declares
-- (learningSteps), or the episode itself when the course declares none. Projected from
-- episode_progress, the authoritative progress row.
CREATE TABLE learning_step_instances(
  enrollment_id uuid NOT NULL REFERENCES enrollments(id),
  course_digest text NOT NULL CHECK(course_digest ~ '^[a-f0-9]{64}$'),
  step_id text NOT NULL CHECK(length(step_id) BETWEEN 1 AND 256),
  episode_id text NOT NULL CHECK(length(episode_id) BETWEEN 1 AND 256),
  -- The declared step kind (explain, solve, gate...), or 'episode' for an implicit step.
  kind text NOT NULL CHECK(length(kind) BETWEEN 1 AND 40),
  requirement text NOT NULL CHECK(requirement IN('required','optional_help')),
  status text NOT NULL CHECK(status IN('current','completed','placed')),
  block_ids jsonb NOT NULL CHECK(jsonb_typeof(block_ids)='array'),
  completed_block_count integer NOT NULL CHECK(completed_block_count>=0),
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(enrollment_id,course_digest,step_id)
);

CREATE FUNCTION project_learning_steps() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE bundle jsonb; digest text; done jsonb := coalesce(NEW.completed_block_ids,'[]');
BEGIN
  SELECT r.server_bundle,r.digest INTO bundle,digest FROM enrollments e JOIN course_releases r ON r.id=e.course_release_id WHERE e.id=NEW.enrollment_id;
  IF digest IS NULL THEN RETURN NEW; END IF;
  WITH declared AS (
    SELECT s->>'id' AS step_id,coalesce(s->>'kind','episode') AS kind,
      CASE WHEN s->>'requirement'='optional_help' THEN 'optional_help' ELSE 'required' END AS requirement,
      coalesce(s->'blockIds','[]') AS block_ids
    FROM policy_items(bundle->'learningSteps') s
    WHERE jsonb_typeof(s)='object' AND s->>'episodeId'=NEW.episode_id AND length(s->>'id') BETWEEN 1 AND 256
  ), steps AS (
    SELECT * FROM declared
    UNION ALL
    SELECT NEW.episode_id,'episode','required',coalesce((SELECT jsonb_agg(b->'id') FROM policy_items(
      (SELECT ep->'blocks' FROM policy_items(bundle->'chapters') c, policy_items(c->'episodes') ep WHERE ep->>'id'=NEW.episode_id LIMIT 1)) b),'[]')
    WHERE NOT EXISTS(SELECT 1 FROM declared)
  ), measured AS (
    SELECT steps.*,(SELECT count(*)::int FROM jsonb_array_elements(steps.block_ids) b WHERE done @> jsonb_build_array(b)) AS completed,
      jsonb_array_length(steps.block_ids) AS total
    FROM steps
  )
  INSERT INTO learning_step_instances AS t(enrollment_id,course_digest,step_id,episode_id,kind,requirement,status,block_ids,completed_block_count,started_at,completed_at)
    SELECT NEW.enrollment_id,digest,m.step_id,NEW.episode_id,left(m.kind,40),m.requirement,
      CASE WHEN NEW.state='placed' THEN 'placed' WHEN NEW.state='completed' OR (m.total>0 AND m.completed=m.total) THEN 'completed' ELSE 'current' END,
      m.block_ids,m.completed,NEW.started_at,
      CASE WHEN NEW.state IN('completed','placed') OR (m.total>0 AND m.completed=m.total) THEN coalesce(NEW.completed_at,clock_timestamp()) END
    FROM measured m
    ON CONFLICT(enrollment_id,course_digest,step_id) DO UPDATE SET status=EXCLUDED.status,completed_block_count=EXCLUDED.completed_block_count,
      completed_at=coalesce(t.completed_at,EXCLUDED.completed_at),revision=t.revision+1,updated_at=clock_timestamp()
    WHERE (t.status,t.completed_block_count) IS DISTINCT FROM (EXCLUDED.status,EXCLUDED.completed_block_count);
  RETURN NEW;
END $$;
CREATE TRIGGER episode_progress_learning_steps AFTER INSERT OR UPDATE ON episode_progress FOR EACH ROW EXECUTE FUNCTION project_learning_steps();
UPDATE episode_progress SET state=state;

-- Where and how a learner played a visual or media resource: the course version, the block,
-- the renderer and the exact scene. Playback is informational: it is never mastery evidence.
-- Written with the playback observation (visual-observations.ts).
CREATE TABLE playback_contexts(
  id uuid PRIMARY KEY,
  enrollment_id uuid NOT NULL REFERENCES enrollments(id),
  workspace_id uuid NOT NULL,
  course_digest text NOT NULL CHECK(course_digest ~ '^[a-f0-9]{64}$'),
  episode_id text NOT NULL CHECK(length(episode_id) BETWEEN 1 AND 256),
  block_id text NOT NULL CHECK(length(block_id) BETWEEN 1 AND 256),
  resource_kind text NOT NULL CHECK(resource_kind IN('visual','video','image')),
  resource_id text NOT NULL CHECK(length(resource_id) BETWEEN 1 AND 256),
  renderer_id text CHECK(renderer_id IS NULL OR length(renderer_id) BETWEEN 1 AND 128),
  renderer_version text CHECK(renderer_version IS NULL OR length(renderer_version) BETWEEN 1 AND 64),
  renderer_integrity text CHECK(renderer_integrity IS NULL OR renderer_integrity ~ '^sha256-[a-f0-9]{64}$'),
  scene_fingerprint text CHECK(scene_fingerprint IS NULL OR length(scene_fingerprint) BETWEEN 1 AND 64),
  platform text CHECK(platform IS NULL OR length(platform) BETWEEN 1 AND 40),
  app_version text CHECK(app_version IS NULL OR length(app_version) BETWEEN 1 AND 64),
  outcome text NOT NULL CHECK(outcome IN('completed')),
  grants_mastery boolean NOT NULL DEFAULT false CHECK(NOT grants_mastery),
  event_id uuid REFERENCES learning_events(id),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  UNIQUE(enrollment_id,course_digest,episode_id,block_id,resource_id,outcome)
);

-- Each runtime extension a course version declares (renderers, evaluators, activities), as
-- declared: identity, execution, platforms and capabilities. Recorded when a release is
-- stored, and for every existing one.
CREATE TABLE extension_manifests(
  course_release_id uuid NOT NULL REFERENCES course_releases(id),
  workspace_id uuid NOT NULL,
  course_digest text NOT NULL CHECK(course_digest ~ '^[a-f0-9]{64}$'),
  extension_id text NOT NULL CHECK(length(extension_id) BETWEEN 1 AND 200),
  version text NOT NULL CHECK(length(version) BETWEEN 1 AND 64),
  integrity text NOT NULL CHECK(length(integrity) BETWEEN 1 AND 128),
  execution text NOT NULL CHECK(length(execution) BETWEEN 1 AND 40),
  platforms jsonb NOT NULL CHECK(jsonb_typeof(platforms)='array'),
  capabilities jsonb NOT NULL CHECK(jsonb_typeof(capabilities)='array'),
  manifest_digest text NOT NULL CHECK(manifest_digest ~ '^[a-f0-9]{64}$'),
  manifest jsonb NOT NULL CHECK(jsonb_typeof(manifest)='object'),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(course_release_id,extension_id)
);
CREATE FUNCTION extension_manifest_rows(release_id uuid,workspace uuid,course_digest text,bundle jsonb)
RETURNS TABLE(course_release_id uuid,workspace_id uuid,course_digest text,extension_id text,version text,integrity text,execution text,
  platforms jsonb,capabilities jsonb,manifest_digest text,manifest jsonb) LANGUAGE sql STABLE AS $$
  SELECT release_id,workspace,course_digest,x->>'id',x->>'version',x->>'integrity',coalesce(x->>'execution','declarative'),
    CASE WHEN jsonb_typeof(x->'platforms')='array' THEN x->'platforms' ELSE '[]' END,
    CASE WHEN jsonb_typeof(x->'capabilities')='array' THEN x->'capabilities' ELSE '[]' END,
    encode(sha256(convert_to(x::text,'UTF8')),'hex'),x
  FROM policy_items(bundle->'extensions') x
  WHERE jsonb_typeof(x)='object' AND length(x->>'id') BETWEEN 1 AND 200 AND length(x->>'version') BETWEEN 1 AND 64
    AND length(x->>'integrity') BETWEEN 1 AND 128 AND length(coalesce(x->>'execution','declarative')) BETWEEN 1 AND 40
$$;
CREATE FUNCTION record_extension_manifests() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO extension_manifests(course_release_id,workspace_id,course_digest,extension_id,version,integrity,execution,platforms,capabilities,manifest_digest,manifest)
    SELECT * FROM extension_manifest_rows(NEW.id,NEW.workspace_id,NEW.digest,NEW.server_bundle) ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;
CREATE TRIGGER course_releases_extension_manifests AFTER INSERT ON course_releases FOR EACH ROW EXECUTE FUNCTION record_extension_manifests();
INSERT INTO extension_manifests(course_release_id,workspace_id,course_digest,extension_id,version,integrity,execution,platforms,capabilities,manifest_digest,manifest)
  SELECT m.* FROM course_releases r, extension_manifest_rows(r.id,r.workspace_id,r.digest,r.server_bundle) m ON CONFLICT DO NOTHING;

-- What a learner's app reported it can do (the SDK PlatformCapabilities record): one row per
-- distinct report per enrollment, with when it was first and last reported. Written by
-- POST /api/enrollments/:id/platform-capabilities.
CREATE TABLE platform_capability_snapshots(
  id uuid PRIMARY KEY,
  enrollment_id uuid NOT NULL REFERENCES enrollments(id),
  workspace_id uuid NOT NULL,
  digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),
  target text NOT NULL CHECK(target IN('web_desktop','web_mobile','ios_phone','ipados_tablet','android_phone','android_tablet')),
  app_version text NOT NULL CHECK(length(app_version) BETWEEN 1 AND 64),
  sdk_version text NOT NULL CHECK(length(sdk_version) BETWEEN 1 AND 64),
  layout_class text NOT NULL CHECK(layout_class IN('compact','medium','expanded')),
  input_modes jsonb NOT NULL CHECK(jsonb_typeof(input_modes)='array'),
  capabilities jsonb NOT NULL CHECK(jsonb_typeof(capabilities)='array'),
  renderer_ids jsonb NOT NULL CHECK(jsonb_typeof(renderer_ids)='array'),
  native_modules jsonb NOT NULL CHECK(jsonb_typeof(native_modules)='array'),
  first_reported_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_reported_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  report_count integer NOT NULL DEFAULT 1 CHECK(report_count>0),
  UNIQUE(enrollment_id,digest)
);

-- One OpenTelemetry trace and the records it wrote (079 links each record to its trace).
-- Projected from those records; a deployment without tracing writes none.
CREATE TABLE debug_traces(
  trace_id text PRIMARY KEY CHECK(trace_id ~ '^[0-9a-f]{32}$' AND trace_id <> repeat('0',32)),
  workspace_id uuid,
  enrollment_id uuid REFERENCES enrollments(id),
  event_count integer NOT NULL DEFAULT 0 CHECK(event_count>=0),
  job_count integer NOT NULL DEFAULT 0 CHECK(job_count>=0),
  dispatch_count integer NOT NULL DEFAULT 0 CHECK(dispatch_count>=0),
  first_recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0)
);
CREATE FUNCTION record_debug_trace() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE kind text := TG_ARGV[0];
BEGIN
  IF NEW.trace_id IS NULL OR (TG_OP='UPDATE' AND OLD.trace_id IS NOT DISTINCT FROM NEW.trace_id) THEN RETURN NEW; END IF;
  INSERT INTO debug_traces AS t(trace_id,workspace_id,enrollment_id,event_count,job_count,dispatch_count)
    VALUES(NEW.trace_id,NEW.workspace_id,NEW.enrollment_id,
      (kind='event')::int,(kind='job')::int,(kind='dispatch')::int)
    ON CONFLICT(trace_id) DO UPDATE SET workspace_id=coalesce(t.workspace_id,EXCLUDED.workspace_id),enrollment_id=coalesce(t.enrollment_id,EXCLUDED.enrollment_id),
      event_count=t.event_count+EXCLUDED.event_count,job_count=t.job_count+EXCLUDED.job_count,dispatch_count=t.dispatch_count+EXCLUDED.dispatch_count,
      last_recorded_at=clock_timestamp(),revision=t.revision+1;
  RETURN NEW;
END $$;
CREATE TRIGGER learning_events_debug_trace AFTER INSERT OR UPDATE OF trace_id ON learning_events FOR EACH ROW EXECUTE FUNCTION record_debug_trace('event');
CREATE TRIGGER supervisor_jobs_debug_trace AFTER INSERT OR UPDATE OF trace_id ON supervisor_jobs FOR EACH ROW EXECUTE FUNCTION record_debug_trace('job');
CREATE TRIGGER provider_dispatches_debug_trace AFTER INSERT OR UPDATE OF trace_id ON provider_dispatches FOR EACH ROW EXECUTE FUNCTION record_debug_trace('dispatch');
INSERT INTO debug_traces(trace_id,workspace_id,enrollment_id,event_count,job_count,dispatch_count,first_recorded_at,last_recorded_at)
  SELECT trace_id,(array_agg(workspace_id) FILTER (WHERE workspace_id IS NOT NULL))[1],(array_agg(enrollment_id) FILTER (WHERE enrollment_id IS NOT NULL))[1],
    sum(e)::int,sum(j)::int,sum(d)::int,min(at),max(at)
  FROM (SELECT trace_id,workspace_id,enrollment_id,1 e,0 j,0 d,created_at at FROM learning_events WHERE trace_id IS NOT NULL
    UNION ALL SELECT trace_id,workspace_id,enrollment_id,0,1,0,created_at FROM supervisor_jobs WHERE trace_id IS NOT NULL
    UNION ALL SELECT trace_id,workspace_id,enrollment_id,0,0,1,clock_timestamp() FROM provider_dispatches WHERE trace_id IS NOT NULL) x
  GROUP BY trace_id ON CONFLICT DO NOTHING;

-- Every decision about a learner's path, whatever made it (the SDK DecisionRecord): gate,
-- placement, intervention, adaptation, extension and closure decisions, each with the course
-- and policy versions it was made against, the evidence it used, its outcome and reason as
-- codes, and who decided. Projected from each decision's authoritative row.
CREATE TABLE decision_records(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK(kind IN('gate','placement','intervention','adaptation','extension','closure')),
  source_ref text NOT NULL CHECK(length(source_ref) BETWEEN 1 AND 300),
  subject_ref text NOT NULL CHECK(length(subject_ref) BETWEEN 1 AND 300),
  enrollment_id uuid NOT NULL REFERENCES enrollments(id),
  course_digest text NOT NULL CHECK(course_digest ~ '^[a-f0-9]{64}$'),
  policy_revision integer NOT NULL CHECK(policy_revision>=0),
  gate_version text,
  input_evidence_refs jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(input_evidence_refs)='array'),
  outcome text NOT NULL CHECK(length(outcome) BETWEEN 1 AND 60),
  reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 100),
  decided_by_kind text NOT NULL CHECK(decided_by_kind IN('host_policy','staff','learner','sdk_reference')),
  decided_by text NOT NULL CHECK(length(decided_by) BETWEEN 1 AND 200),
  decided_at timestamptz NOT NULL,
  trace_id text,
  UNIQUE(kind,source_ref,outcome)
);
CREATE INDEX decision_records_enrollment ON decision_records(enrollment_id,decided_at);

CREATE FUNCTION record_decision(k text,source text,subject text,enrollment uuid,policy integer,gate text,refs jsonb,result text,why text,
  by_kind text,by_id text,at timestamptz) RETURNS void LANGUAGE plpgsql AS $$
DECLARE d text; p integer;
BEGIN
  SELECT r.digest,e.policy_revision INTO d,p FROM enrollments e JOIN course_releases r ON r.id=e.course_release_id WHERE e.id=enrollment;
  IF d IS NULL THEN RETURN; END IF;
  INSERT INTO decision_records(kind,source_ref,subject_ref,enrollment_id,course_digest,policy_revision,gate_version,input_evidence_refs,outcome,reason,
    decided_by_kind,decided_by,decided_at)
    VALUES(k,left(source,300),left(subject,300),enrollment,d,coalesce(policy,p),gate,
      CASE WHEN jsonb_typeof(refs)='array' AND jsonb_array_length(refs)<=200 THEN refs ELSE '[]' END,
      left(result,60),left(coalesce(nullif(why,''),result),100),by_kind,left(by_id,200),coalesce(at,clock_timestamp()))
    ON CONFLICT DO NOTHING;
END $$;

CREATE FUNCTION decisions_from_gate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM record_decision('gate','gate_decision:'||NEW.id,NEW.gate_id,NEW.enrollment_id,NEW.policy_revision,NEW.gate_version,NEW.evidence_refs,
    NEW.status,NEW.status,'host_policy','progression-gates',NEW.decided_at);
  RETURN NEW;
END $$;
CREATE TRIGGER gate_decisions_decision AFTER INSERT ON gate_decisions FOR EACH ROW EXECUTE FUNCTION decisions_from_gate();

CREATE FUNCTION decisions_from_placement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state IN('declined','finished','accepted') AND (TG_OP='INSERT' OR OLD.state IS DISTINCT FROM NEW.state) THEN
    PERFORM record_decision('placement','placement_run:'||NEW.id,coalesce(NEW.start_episode_id,'placement'),NEW.enrollment_id,NULL,NULL,'[]',
      NEW.state,coalesce(NEW.stop_reason,NEW.state),CASE WHEN NEW.state IN('declined','accepted') THEN 'learner' ELSE 'host_policy' END,
      CASE WHEN NEW.state IN('declined','accepted') THEN 'learner' ELSE 'placement' END,coalesce(NEW.accepted_at,NEW.finished_at,NEW.updated_at));
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER placement_runs_decision AFTER INSERT OR UPDATE OF state ON placement_runs FOR EACH ROW EXECUTE FUNCTION decisions_from_placement();

CREATE FUNCTION decisions_from_closure() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM record_decision('closure','closure_report:'||NEW.enrollment_id,'enrollment',NEW.enrollment_id,NEW.policy_revision,NULL,'[]',
    NEW.coverage,NEW.reason,'host_policy','policy',NEW.closed_at);
  RETURN NEW;
END $$;
CREATE TRIGGER closure_reports_decision AFTER INSERT ON closure_reports FOR EACH ROW EXECUTE FUNCTION decisions_from_closure();

CREATE FUNCTION decisions_from_extension_offer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' OR OLD.state IS DISTINCT FROM NEW.state THEN
    PERFORM record_decision('extension','extension_offer:'||NEW.enrollment_id||':'||NEW.offer_id,NEW.scope_id,NEW.enrollment_id,NULL,NULL,'[]',
      NEW.state,NEW.state,CASE WHEN NEW.state LIKE 'accepted%' OR NEW.state='declined' THEN 'learner' ELSE 'host_policy' END,
      CASE WHEN NEW.state LIKE 'accepted%' OR NEW.state='declined' THEN 'learner' ELSE 'policy' END,NEW.last_transition_at);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER extension_offers_decision AFTER INSERT OR UPDATE OF state ON extension_offers FOR EACH ROW EXECUTE FUNCTION decisions_from_extension_offer();

CREATE FUNCTION decisions_from_adaptation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM record_decision('adaptation','adaptation_application:'||NEW.enrollment_id||':'||NEW.proposal_id,'plan:'||NEW.plan_revision,NEW.enrollment_id,NULL,NULL,
    jsonb_build_array(NEW.event_id::text),'applied','plan_revision_applied','host_policy','adaptation',NEW.applied_at);
  RETURN NEW;
END $$;
CREATE TRIGGER adaptation_applications_decision AFTER INSERT ON adaptation_applications FOR EACH ROW EXECUTE FUNCTION decisions_from_adaptation();

CREATE FUNCTION decisions_from_teaching_action() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' OR OLD.state IS DISTINCT FROM NEW.state THEN
    PERFORM record_decision('intervention','teaching_action:'||NEW.id,NEW.action,NEW.enrollment_id,NULL,NULL,NEW.objective_ids,
      NEW.state,coalesce(NEW.end_reason,NEW.rule_id,NEW.origin),'host_policy',CASE WHEN NEW.origin='supervisor' THEN 'supervisor' ELSE 'teaching-rules' END,NEW.updated_at);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER teaching_actions_decision AFTER INSERT OR UPDATE OF state ON teaching_actions FOR EACH ROW EXECUTE FUNCTION decisions_from_teaching_action();

-- Existing decisions, once.
SELECT record_decision('gate','gate_decision:'||id,gate_id,enrollment_id,policy_revision,gate_version,evidence_refs,status,status,'host_policy','progression-gates',decided_at)
  FROM gate_decisions;
SELECT record_decision('placement','placement_run:'||id,coalesce(start_episode_id,'placement'),enrollment_id,NULL,NULL,'[]',state,coalesce(stop_reason,state),
  CASE WHEN state IN('declined','accepted') THEN 'learner' ELSE 'host_policy' END,CASE WHEN state IN('declined','accepted') THEN 'learner' ELSE 'placement' END,
  coalesce(accepted_at,finished_at,updated_at)) FROM placement_runs WHERE state IN('declined','finished','accepted');
SELECT record_decision('closure','closure_report:'||enrollment_id,'enrollment',enrollment_id,policy_revision,NULL,'[]',coverage,reason,'host_policy','policy',closed_at)
  FROM closure_reports;
