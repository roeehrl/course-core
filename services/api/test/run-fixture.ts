import { randomUUID } from "node:crypto";
import { createJob } from "@course-core/supervisor";
import type { Database } from "../src/database.js";
import { digestJson } from "../src/repository.js";

/** A recorded supervisor run: input event with client facts, frozen input, four tool calls, the
 * stored plan, a provider dispatch, spend and budgets. `tamper` stores a plan the calls do not produce. */
export async function recordSyntheticRun(db: Pick<Database, "query">, options: { workspaceId: string; enrollmentId: string; releaseId: string; learnerId: string;
  credential?: string; role?: "supervisor" | "companion"; tamper?: boolean; episodeId?: string }) {
  const { workspaceId: workspace, enrollmentId: enrollment, releaseId: release } = options, credential = options.credential ?? "synthetic-credential-canary";
  const role = options.role ?? "supervisor", jobId = randomUUID(), inputId = randomUUID(), ownerId = randomUUID(), artifactId = randomUUID(), eventId = randomUUID();
  const e = (await db.query("SELECT * FROM enrollments WHERE id=$1", [enrollment])).rows[0];
  const digest = (await db.query("SELECT digest FROM course_releases WHERE id=$1", [release])).rows[0].digest;
  await db.query(`INSERT INTO learning_events(id,workspace_id,enrollment_id,actor_id,actor_kind,event_type,payload,correlation_id,idempotency_key,platform,app_version,client_sequence,occurred_at)
    VALUES($1,$2,$3,$4,'learner','episode.help_requested','{}',$5,$6,'web','1.4.2',17,clock_timestamp()-interval '1500 milliseconds')`,
    [eventId, workspace, enrollment, options.learnerId, randomUUID(), "ri-event:" + eventId]);
  const spec = {
    schemaVersion: 1 as const, key: { jobId, enrollmentId: enrollment, workspaceId: workspace }, inputEventId: eventId, role,
    fence: { enrollmentRevision: e.revision, profileRevision: e.profile_revision, policyRevision: e.policy_revision, ledgerRevision: 0, courseDigest: digest },
    checkpoints: [{ id: "generate", capability: role, inputRef: inputId, allowance: { microUsd: 900, tokens: 800 }, timeoutMs: 1000, maxAttempts: 2 }],
    budget: { microUsd: 900, tokens: 800 }, deadlineAtMs: Date.now() + 60_000,
  };
  const operation = `${jobId}/generate`;
  const calls = [
    { id: randomUUID(), step: 0, tool: "list_support", arguments: {}, outcome: { result: { available: true, entries: [{ profileId: "ordering-support", entryId: "number-line" }] } } },
    { id: randomUUID(), step: 1, tool: "get_profile", arguments: {}, outcome: { result: { available: true, preferences: "LEARNER_MODEL_CANARY" } } },
    { id: randomUUID(), step: 2, tool: "propose_hypothesis", arguments: { statement: "HYPOTHESIS_TEXT_CANARY", citedEventIds: [eventId] }, outcome: { result: { available: true, recorded: true } } },
    { id: randomUUID(), step: 3, tool: "choose_support", arguments: { profileId: "ordering-support", entryId: "number-line" },
      outcome: { result: { available: true, selected: true, verification: "pending" }, selection: { profileId: "ordering-support", entryId: "number-line", permissionRevision: 1 } } },
  ];
  const plan = role === "companion"
    ? { kind: "companion_message", text: "COMPANION_REPLY_CANARY" }
    : { kind: "supervised_plan", summary: "Offer the number-line walkthrough before the next check.",
        selection: { profileId: "ordering-support", entryId: options.tamper ? "other-entry" : "number-line", permissionRevision: 1 }, toolCallRefs: calls.map((c) => c.id) };
  const runtime = { ...createJob(spec), state: "ready", operations: [{ id: operation, checkpointId: "generate", ownerId, attempt: 1, status: "succeeded",
    reservation: { microUsd: 900, tokens: 800 }, outcome: { status: "succeeded", artifact: { artifactId, digest: digestJson(plan) }, usage: { microUsd: 300, tokens: 120 } } }] };
  await db.query(`INSERT INTO supervisor_jobs(id,enrollment_id,workspace_id,workflow_id,role,state,input_event_id,expected_revision,specification,runtime_snapshot)
    VALUES($1,$2,$3,$4,$5,'ready',$6,$7,$8,$9)`, [jobId, enrollment, workspace, `enrollment-${enrollment}/job-${jobId}`, role, eventId, e.revision, JSON.stringify(spec), JSON.stringify(runtime)]);
  await db.query("INSERT INTO supervisor_inputs(id,job_id,enrollment_id,workspace_id,checkpoint_id,fence,context) VALUES($1,$2,$3,$4,'generate',$5,$6)",
    [inputId, jobId, enrollment, workspace, JSON.stringify(spec.fence), JSON.stringify({ kind: "learning_event", eventId, eventType: "episode.help_requested", courseReleaseId: release,
      episodeId: options.episodeId ?? "min", api_key: credential, chain_of_thought: "PRIVATE_REASONING_CANARY" })]);
  if (role === "supervisor")
    for (const c of calls)
      await db.query("INSERT INTO supervisor_tool_calls(id,job_id,enrollment_id,workspace_id,operation_id,step,tool,request_digest,arguments,outcome) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [c.id, jobId, enrollment, workspace, operation, c.step, c.tool, digestJson(c.arguments), JSON.stringify(c.arguments), JSON.stringify(c.outcome)]);
  await db.query("INSERT INTO supervisor_artifacts(id,job_id,enrollment_id,workspace_id,operation_id,owner_id,digest,content) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
    [artifactId, jobId, enrollment, workspace, operation, ownerId, digestJson(plan), JSON.stringify(plan)]);
  await db.query(`INSERT INTO provider_dispatches(operation_id,job_id,enrollment_id,workspace_id,owner_id,request_digest,state,candidate,finished_at)
    VALUES($1,$2,$3,$4,$5,$6,'completed',$7,clock_timestamp())`, [operation, jobId, enrollment, workspace, ownerId, "b".repeat(64), JSON.stringify({ text: "PROVIDER_CANDIDATE_CANARY" })]);
  await db.query("INSERT INTO supervisor_job_spend(job_id,enrollment_id,workspace_id,micro_usd,tokens) VALUES($1,$2,$3,300,120)", [jobId, enrollment, workspace]);
  await db.query(`INSERT INTO supervisor_enrollment_budgets(enrollment_id,workspace_id,limit_micro_usd,limit_tokens,used_micro_usd,used_tokens,daily_limit_micro_usd)
    VALUES($1,$2,5000,4000,300,120,2000) ON CONFLICT (enrollment_id) DO NOTHING`, [enrollment, workspace]);
  return { jobId, eventId, calls };
}
