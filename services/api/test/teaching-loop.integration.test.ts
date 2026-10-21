import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProviderAdapter, UsageReceipt } from '@course-core/providers';
import type { ProviderRequest, RunRef, Snapshot } from '@course-core/supervisor';
import { createDatabase, transaction, type Database } from '../src/database.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';
import { createServer } from '../src/server.js';
import { issueLoginCode } from '../src/auth.js';
import { appendEvent } from '../src/events.js';
import { ensureCatalog } from '../src/admin-routes.js';
import { configureSupervisorBudget, createPostgresSupervisorBridge, resolveSupervisorOperation, type PostgresSupervisorBridge } from '../src/supervisor-bridge.js';
import { teachingContext } from '../src/provider-context.js';
import { supervisorTools } from '../src/supervisor-tools.js';
import { composeProviders } from '../src/provider-composition.js';
import { scanWakeups } from '../src/wakeups.js';
import { ToolCallRefused } from '../src/supervisor-tool-loop.js';
import { hypothesisCourse } from './hypothesis-fixture.js';
import { canonicalJson } from '@course-core/sdk/compiler';
import { allowUnpricedPaidWork } from './cost-fixture.js';

/**
 * The supervision loop end to end with a SCRIPTED (synthetic) model only (requirements B02-B06,
 * N01): this proves Core's orchestration, authority, caps and records, never real model quality.
 * Trigger -> teaching action -> planner, two concurrent builders, evaluator -> verify -> apply ->
 * follow-up and transfer probe parked until due -> resumed by reconcile on the current state.
 */
const schema = 'teaching_loop_' + randomUUID().replaceAll('-', ''), workspace = randomUUID(), releaseId = randomUUID();
const origin = 'http://localhost:4310', token = randomUUID();
let db: Database, testDatabase: TestDatabase | undefined, app: Awaited<ReturnType<typeof createServer>>, bridge: PostgresSupervisorBridge, owner: Session;
type Session = { id: string; cookie: string; csrf: string };
const scripts = new Map<string, (round: number, prompt: any) => unknown>(), prompts = new Map<string, any[]>();
const usage: UsageReceipt = { accounting: { accountingKey: 'synthetic' }, providerId: 'test', modelId: 'planner', operation: 'assess',
  attempts: [{ attempt: 1, status: 200, outcome: 'response', tokens: { input: 10, output: 20, total: 30, cachedInput: 0, thoughts: 0, toolInput: 0 } }],
  inputCharacters: 100, requestedMaxOutputTokens: 1000, requestedVideoSeconds: null, observedImageCount: null, observedVideoCount: null, cost: null };
const finish = (summary: string) => ({ decision: 'finish', tool: 'none', argumentsJson: '{}', summary });
const call = (tool: string, args: unknown = {}) => ({ decision: 'tool', tool, argumentsJson: JSON.stringify(args), summary: '' });
const adapter: ProviderAdapter = { providerId: 'test', validateModel() {}, ports: { structured_assessment: { async assess(req) {
  const [key, round] = req.accounting.accountingKey.split(':round-');
  const prompt = JSON.parse(req.messages[0]!.text);
  prompts.set(key!, [...(prompts.get(key!) ?? []), { prompt, system: req.systemInstruction, tools: (req.outputSchema as any).properties.tool.enum }]);
  const script = scripts.get(key!);
  return { usage, output: (script ? script(Number(round), prompt) : finish('Nothing to change.')) as never };
} } } };
const keyOf = (operationId: string) => createHash('sha256').update(operationId).digest('hex');
const headers = (s: Session) => ({ cookie: s.cookie, origin, 'x-csrf-token': s.csrf });
async function login(role = 'learner'): Promise<Session> {
  const id = randomUUID();
  await db.query('INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)', [id, 'test:' + id, 'Synthetic person']);
  await db.query('INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)', [workspace, id, role]);
  const r = await app.inject({ method: 'POST', url: '/auth/redeem', headers: { origin }, payload: { token: await issueLoginCode(db, id) } });
  expect(r.statusCode, r.body).toBe(200);
  return { id, cookie: r.cookies.map(c => `${c.name}=${c.value}`).join('; '), csrf: r.json().csrfToken };
}
async function revision(id: string) { return (await db.query('SELECT revision FROM enrollments WHERE id=$1', [id])).rows[0].revision as number; }
async function command(learner: Session, id: string, path: string, body: Record<string, unknown>) {
  const r = await app.inject({ method: 'POST', url: `/api/enrollments/${id}/${path}`, headers: headers(learner), payload: { expectedRevision: await revision(id), idempotencyKey: randomUUID(), ...body } });
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
}
async function enroll(consent = true) {
  const learner = await login();
  const enrolled = await app.inject({ method: 'POST', url: '/api/enrollments', headers: headers(learner), payload: { releaseId } });
  expect(enrolled.statusCode, enrolled.body).toBe(200);
  const id = enrolled.json().id as string;
  await command(learner, id, 'supervision', { adaptiveTeaching: consent });
  await configureSupervisorBudget(db, { workspaceId: workspace, enrollmentId: id }, { microUsd: 10_000_000, tokens: 50_000_000 });
  return { learner, id };
}
async function rpc(body: unknown) {
  const r = await app.inject({ method: 'POST', url: '/v1/supervisor/bridge', headers: { authorization: 'Bearer ' + token }, payload: body });
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
}
async function snapshotOf(jobId: string) { return (await db.query<{ runtime_snapshot: Snapshot }>('SELECT runtime_snapshot FROM supervisor_jobs WHERE id=$1', [jobId])).rows[0]!.runtime_snapshot; }
/** Runs one checkpoint as the workflow activity does: claim, provider gateway, settle. */
async function runCheckpoint(ref: RunRef, checkpointId: string, script?: (round: number, prompt: any) => unknown) {
  const ownerId = randomUUID();
  const claim = await bridge.transition({ type: 'claim', ref, checkpointId, ownerId, availability: { status: 'ready' } });
  if (claim.effect !== 'invoke') return claim;
  const op = claim.snapshot.operations.find(o => o.checkpointId === checkpointId)!;
  const request: ProviderRequest = { schemaVersion: 1, operationId: op.id, job: claim.snapshot.specification.key, role: 'supervisor',
    checkpoint: claim.snapshot.specification.checkpoints.find(c => c.id === checkpointId)!, fence: claim.snapshot.specification.fence };
  if (script) scripts.set(keyOf(op.id), script);
  const r = await app.inject({ method: 'POST', url: '/v1/operations', headers: { authorization: 'Bearer ' + token, 'idempotency-key': op.id }, payload: request });
  expect(r.statusCode, r.body).toBe(200);
  expect(r.json().status).toBe('succeeded');
  return bridge.transition({ type: 'settle', ref, operationId: op.id, ownerId, outcome: r.json() });
}
async function prepareEvent(eventId: string) {
  const outbox = (await bridge.claimOutboxEvent(eventId, randomUUID(), 30000))!;
  expect(outbox).not.toBeNull();
  const jobs = await bridge.prepareOutbox(outbox);
  await bridge.ackOutbox(outbox);
  return jobs;
}
async function admitReview(learner: Session, id: string) {
  const event = await transaction(db, client => appendEvent(client, { workspaceId: workspace, enrollmentId: id, actorId: learner.id, actorKind: 'learner',
    type: 'learning.review_requested', payload: { episodeId: 'min' }, idempotencyKey: randomUUID(), supervise: true }));
  const [ref] = await prepareEvent(event.id);
  return ref!;
}

beforeAll(async () => {
  if (!process.env.TEST_DATABASE_URL || process.env.DATABASE_URL) throw Error('Disposable TEST_DATABASE_URL required');
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  const providers = composeProviders({
    registry: { revision: 'teaching-loop', models: [{ id: 'planner', providerId: 'test', remoteModel: 'planner', providerConfig: {}, enabled: true,
      capabilities: ['structured_assessment'], tools: [], limits: { maxInputCharacters: 40000, maxOutputTokens: 2000 } }] },
    adapters: [{ id: 'test', kind: 'test', credentialEnv: 'COURSE_PROVIDER_TEST_API_KEY' }],
    roles: { supervisor: { modelId: 'planner', maxInputCharacters: 30000, maxOutputTokens: 1000, maxToolRounds: 8 } },
  }, () => 'synthetic', { test: () => adapter });
  const jobPolicy = { allowance: { microUsd: 100000, tokens: 1200000 } };
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false, providers, supervisor: { serviceToken: token, workspaceIds: [workspace], jobPolicy } });
  bridge = createPostgresSupervisorBridge(db, { workspaceIds: [workspace], jobPolicy });
  await db.query('INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)', [workspace, 'teaching-loop', 'Teaching loop qualification']);
  await allowUnpricedPaidWork(db, workspace);
  owner = await login('owner');
  const course = hypothesisCourse();
  // A registered course visual shown in the lesson, for the visual/media tools (N01).
  const server = structuredClone(course.server) as any;
  server.visuals = [{ id: 'number-line', rendererId: 'core.svg', platforms: ['web'], state: {}, scene: {}, layouts: { compact: {}, expanded: {} },
    timeline: { durationMs: 4000, seekable: true, cues: [] }, accessibility: { description: 'Three values placed on a number line, smallest on the left.', reducedMotion: {} }, referenceChecks: ['order'] },
  { id: 'no-description', rendererId: 'core.svg', platforms: ['web'], state: {}, scene: {}, layouts: { compact: {}, expanded: {} },
    timeline: { durationMs: 1000, seekable: true, cues: [] }, accessibility: { description: '', reducedMotion: {} }, referenceChecks: [] }];
  server.chapters[0].episodes[0].blocks.push({ id: 'min-visual', type: 'visual', visualId: 'number-line' }, { id: 'min-visual-2', type: 'visual', visualId: 'no-description' });
  const digest = createHash('sha256').update(canonicalJson(server)).digest('hex');
  await db.query(`INSERT INTO course_releases(id,workspace_id,course_key,version,digest,server_bundle,learner_bundle,status,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,'published',$8)`,
    [releaseId, workspace, course.server.id, course.server.version, digest, JSON.stringify(server), JSON.stringify(course.learner), owner.id]);
  await ensureCatalog(db, releaseId);
  await configureSupervisorBudget(db, { workspaceId: workspace }, { microUsd: 100_000_000, tokens: 1_000_000_000 });
}, 30000);
afterAll(async () => {
  await app?.close(); await db?.end();
  await testDatabase?.drop();
});

describe('teaching actions from the trigger table (B02, B03, B04, B05)', () => {
  it('a confident wrong answer starts a contrast case that a planner, two concurrent builders and an evaluator carry out; delivery schedules a follow-up and a transfer probe', async () => {
    const { learner, id } = await enroll();
    const issued = await command(learner, id, 'challenges', { episodeId: 'min', assessmentId: 'min-practice', mode: 'practice' });
    await command(learner, id, 'answers', { challengeId: issued.challengeId, answer: 'nine', confidence: 5 });
    const action = (await db.query("SELECT * FROM teaching_actions WHERE enrollment_id=$1", [id])).rows[0];
    expect(action).toMatchObject({ action: 'contrast_case', state: 'started', origin: 'trigger', rule_id: 'T1', objective_ids: ['minimum'], job_id: null });

    const [ref] = await prepareEvent(action.event_id);
    const spec = (await snapshotOf(ref!.jobId)).specification;
    // The job record names its objective (B05) and its logical roles (B04).
    expect(spec.objective).toEqual({ kind: 'teaching_action', objectiveIds: ['minimum'], refs: [action.id] });
    expect((await db.query('SELECT objective FROM supervisor_jobs WHERE id=$1', [ref!.jobId])).rows[0].objective).toEqual(spec.objective);
    expect(spec.checkpoints.map(c => [c.id, c.logicalRole, c.group ?? null])).toEqual([
      ['plan', 'planner', null], ['build-a', 'builder', 'build'], ['build-b', 'builder', 'build'], ['evaluate', 'evaluator', null]]);
    expect((await db.query('SELECT job_id FROM teaching_actions WHERE id=$1', [action.id])).rows[0].job_id).toBe(ref!.jobId);

    await runCheckpoint(ref!, 'plan', () => finish('Contrast 3 with 9: show why the largest is not the smallest.'));
    // Both builders are claimed before either settles: they run side by side.
    const ownerA = randomUUID(), ownerB = randomUUID();
    const claimA = await bridge.transition({ type: 'claim', ref: ref!, checkpointId: 'build-a', ownerId: ownerA, availability: { status: 'ready' } });
    const claimB = await bridge.transition({ type: 'claim', ref: ref!, checkpointId: 'build-b', ownerId: ownerB, availability: { status: 'ready' } });
    expect([claimA.effect, claimB.effect, claimB.snapshot.state]).toEqual(['invoke', 'invoke', 'building']);
    const settleBuilder = async (claimed: typeof claimA, ownerId: string, checkpointId: string, script: (round: number, prompt: any) => unknown) => {
      const op = claimed.snapshot.operations.find(o => o.checkpointId === checkpointId)!;
      scripts.set(keyOf(op.id), script);
      const request: ProviderRequest = { schemaVersion: 1, operationId: op.id, job: claimed.snapshot.specification.key, role: 'supervisor',
        checkpoint: claimed.snapshot.specification.checkpoints.find(c => c.id === checkpointId)!, fence: claimed.snapshot.specification.fence };
      const r = await app.inject({ method: 'POST', url: '/v1/operations', headers: { authorization: 'Bearer ' + token, 'idempotency-key': op.id }, payload: request });
      expect(r.json().status, r.body).toBe('succeeded');
      await bridge.transition({ type: 'settle', ref: ref!, operationId: op.id, ownerId, outcome: r.json() });
      return prompts.get(keyOf(op.id))!;
    };
    const seenA = await settleBuilder(claimA, ownerA, 'build-a', round => round === 0 ? call('propose_practice_check', { objectiveId: 'minimum' }) : finish('A new practice problem from a family not tried yet.'));
    const seenB = await settleBuilder(claimB, ownerB, 'build-b', round => round === 0 ? call('list_visuals')
      : round === 1 ? call('choose_visual', { visualId: 'number-line', objectiveId: 'minimum' }) : finish('Show the number line.'));
    // Builders see the planner's brief and their own alternative; they cannot ask for authority or write hypotheses.
    expect(seenA[0].prompt.context.task).toMatchObject({ logicalRole: 'builder', alternative: 'build-a', brief: 'Contrast 3 with 9: show why the largest is not the smallest.',
      actions: [{ action: 'contrast_case', objectiveIds: ['minimum'] }] });
    expect(seenA[0].tools).toContain('propose_practice_check');
    expect(seenA[0].tools).not.toContain('request_authority');
    expect(seenA[0].tools).not.toContain('propose_hypothesis');
    expect(seenA[0].tools).not.toContain('choose_alternative');
    expect(seenA[0].system).toContain('You are one builder');
    expect(seenB[1].prompt.toolResults[0].result.visuals.map((v: any) => v.id)).toEqual(['number-line', 'no-description']);

    let evaluatorSeen: any[] = [];
    await runCheckpoint(ref!, 'evaluate', (round, prompt) => {
      evaluatorSeen.push(prompt);
      return round === 0 ? call('compare_alternatives') : round === 1 ? call('choose_alternative', { checkpointId: 'build-a' }) : finish('The practice problem checks the contrast directly.');
    });
    evaluatorSeen = prompts.get([...prompts.keys()].at(-1)!)!;
    expect(evaluatorSeen[0].prompt.context.task.alternatives.map((a: any) => [a.checkpointId, a.builds])).toEqual([['build-a', ['suggestions']], ['build-b', ['suggestions']]]);
    expect(evaluatorSeen[0].tools.filter((t: string) => t !== 'none').every((t: string) => ['compare_alternatives', 'choose_alternative', 'check_teaching', 'get_assessment_outline',
      'get_history', 'get_profile', 'get_evidence', 'search_history'].includes(t))).toBe(true);
    expect(evaluatorSeen[1].prompt.toolResults[0].result.alternatives).toHaveLength(2);

    const verified = await rpc({ method: 'transition', command: { type: 'verify', ref } });
    expect(verified.snapshot.state).toBe('ready');
    const applied = await rpc({ method: 'transition', command: { type: 'apply', ref } });
    expect(applied.snapshot.state).toBe('applied');

    // One writer: only the evaluator's choice (build-a's practice problem) was delivered.
    const rows = (await db.query('SELECT * FROM teaching_actions WHERE enrollment_id=$1 ORDER BY created_at,id', [id])).rows;
    expect(rows.find(r => r.id === action.id).state).toBe('delivered');
    const suggestion = rows.filter(r => r.origin === 'supervisor');
    expect(suggestion).toEqual([expect.objectContaining({ action: 'transfer_check', state: 'delivered', outcome: { transferItem: { assessmentId: 'min-again', episodeId: 'min' } } })]);
    const followUps = rows.filter(r => r.origin === 'follow_up');
    expect(followUps.map(r => [r.action, r.state, r.parent_id]).sort()).toEqual([['follow_up', 'scheduled', action.id], ['transfer_probe', 'scheduled', action.id]]);
    for (const row of followUps) {
      const parked = await snapshotOf(row.job_id);
      expect([parked.state, parked.reason, parked.specification.objective]).toEqual(['follow_up_due', 'follow_up_scheduled',
        { kind: row.action, objectiveIds: ['minimum'], refs: [row.id] }]);
      expect(parked.dueAtMs).toBe(new Date(row.due_at).getTime());
    }
    expect(Math.round((new Date(followUps.find(r => r.action === 'transfer_probe').due_at).getTime() - Date.now()) / 3_600_000)).toBe(72);
    // Not due yet: reconcile leaves them parked.
    expect((await bridge.reconcile(50)).resume.map(r => r.jobId)).not.toContain(followUps[0].job_id);

    // The learner sees what was started for them and what is coming (codes only).
    const view = await app.inject({ url: `/api/enrollments/${id}/supervision/requests`, headers: headers(learner) });
    expect(view.statusCode, view.body).toBe(200);
    expect(view.json().actions.map((a: any) => [a.action, a.state])).toEqual(expect.arrayContaining([['contrast_case', 'delivered'], ['transfer_check', 'delivered'],
      ['follow_up', 'scheduled'], ['transfer_probe', 'scheduled']]));
    expect(view.json().actions.every((a: any) => a.countsAsEvidence === false)).toBe(true);

    // Due: the dispatcher's reconcile resumes them on today's state, after resolving their check.
    await command(learner, id, 'profile', { profile: { displayName: 'Synthetic person', goal: 'Order values', pace: 'steady' } });
    await db.query("UPDATE supervisor_jobs SET runtime_snapshot=jsonb_set(runtime_snapshot,'{dueAtMs}',to_jsonb((extract(epoch FROM clock_timestamp())*1000)::bigint-1000)) WHERE id=ANY($1::uuid[])",
      [followUps.map(r => r.job_id)]);
    const resumed = (await bridge.reconcile(50)).resume.filter(r => followUps.some(f => f.job_id === r.jobId));
    expect(resumed.map(r => r.generation)).toEqual([2, 2]);
    const probe = (await db.query("SELECT state,outcome FROM teaching_actions WHERE parent_id=$1 AND action='transfer_probe'", [action.id])).rows[0];
    expect(probe.state).toBe('checked');
    expect(probe.outcome.objectives).toEqual([{ objectiveId: 'minimum', result: 'no_attempt' }]);
    // A novel item: not attempted, not the gate's or a probe's, preferring an untried family.
    expect(probe.outcome.transferItem).toEqual({ assessmentId: 'min-again', episodeId: 'min', familyId: 'practice-again' });
    // Re-based on the learner's state now, not the state at delivery.
    const rebased = await snapshotOf(followUps[0].job_id);
    const now = (await db.query('SELECT e.revision-e.navigation_revision AS enrollment,e.profile_revision AS profile,p.ledger_revision AS ledger FROM enrollments e JOIN policy_states p ON p.enrollment_id=e.id WHERE e.id=$1', [id])).rows[0];
    expect([rebased.specification.fence.enrollmentRevision, rebased.specification.fence.profileRevision, rebased.specification.fence.ledgerRevision]).toEqual([now.enrollment, now.profile, Number(now.ledger)]);
    // The resumed follow-up's run is told what it is following up.
    const run = await runCheckpoint({ ...resumed.find(r => r.jobId === followUps.find(f => f.action === 'transfer_probe').job_id)!, generation: 2 }, 'generate', () => finish('Offer the new problem.'));
    expect(run.snapshot.state).toBe('running');
    const last = prompts.get([...prompts.keys()].at(-1)!)!;
    expect(last[0].prompt.context.task.actions).toEqual([{ action: 'transfer_probe', objectiveIds: ['minimum'],
      followUp: { objectives: [{ objectiveId: 'minimum', result: 'no_attempt' }], transferItem: { assessmentId: 'min-again', episodeId: 'min', familyId: 'practice-again' } } }]);
    expect(last[0].tools).not.toContain('choose_alternative');
  }, 60000);

  it('a failed or cancelled action job ends its action with the reason; caps and the open-action rule hold back repeats', async () => {
    const { learner, id } = await enroll();
    for (let i = 0; i < 3; i++) {
      const issued = await command(learner, id, 'challenges', { episodeId: 'min', assessmentId: 'min-practice', mode: 'practice' });
      await command(learner, id, 'answers', { challengeId: issued.challengeId, abstain: true });
    }
    const actions = (await db.query("SELECT * FROM teaching_actions WHERE enrollment_id=$1", [id])).rows;
    // One worked example is open; the repeats are held back (recommendation cooldown or the open action).
    expect(actions.map(a => a.action)).toEqual(['worked_example']);
    const skipped = (await db.query("SELECT skipped FROM teaching_signals WHERE enrollment_id=$1 AND signal_kind='answer.abstained' ORDER BY created_at", [id])).rows.flatMap(r => r.skipped);
    expect(skipped.some((s: any) => s.reason === 'recommendation_cooldown' || s.reason === 'already_open')).toBe(true);
    const [ref] = await prepareEvent(actions[0].event_id);
    // A worked example builds new material: planner, two builders, evaluator.
    expect((await snapshotOf(ref!.jobId)).specification.checkpoints.map(c => c.id)).toEqual(['plan', 'build-a', 'build-b', 'evaluate']);
    await bridge.transition({ type: 'halt', ref: ref!, reason: 'cancel_requested' });
    expect((await db.query("SELECT state,end_reason FROM teaching_actions WHERE id=$1", [actions[0].id])).rows[0]).toEqual({ state: 'ended', end_reason: 'cancel_requested' });
    // A forged action event (not system, or naming another enrollment's action) is refused, never run.
    const forged = await transaction(db, client => appendEvent(client, { workspaceId: workspace, enrollmentId: id, actorId: learner.id, actorKind: 'learner',
      type: 'teaching.action_started', payload: { actionId: actions[0].id }, idempotencyKey: randomUUID(), supervise: true }));
    expect(await prepareEvent(forged.id)).toEqual([]);
    expect((await db.query('SELECT disposition,reason_code FROM supervisor_preparations WHERE event_id=$1', [forged.id])).rows[0]).toEqual({ disposition: 'refused', reason_code: 'TEACHING_ACTION_NOT_STARTED' });
  }, 60000);

  it('without the learner opt-in or under recommend_only autonomy, nothing is started; review_due (T10) prepares the next review', async () => {
    const off = await enroll(false);
    const issued = await command(off.learner, off.id, 'challenges', { episodeId: 'min', assessmentId: 'min-practice', mode: 'practice' });
    await command(off.learner, off.id, 'answers', { challengeId: issued.challengeId, answer: 'nine', confidence: 5 });
    expect((await db.query('SELECT count(*)::int AS n FROM teaching_actions WHERE enrollment_id=$1', [off.id])).rows[0].n).toBe(0);

    await db.query("INSERT INTO supervision_settings(workspace_id,autonomy_level,permitted_tool_families) VALUES($1,'recommend_only',ARRAY['learner_read','teaching']) ON CONFLICT (workspace_id) DO UPDATE SET autonomy_level='recommend_only'", [workspace]);
    try {
      const held = await enroll();
      const again = await command(held.learner, held.id, 'challenges', { episodeId: 'min', assessmentId: 'min-practice', mode: 'practice' });
      await command(held.learner, held.id, 'answers', { challengeId: again.challengeId, answer: 'nine', confidence: 5 });
      expect((await db.query('SELECT count(*)::int AS n FROM teaching_actions WHERE enrollment_id=$1', [held.id])).rows[0].n).toBe(0);
      const signal = (await db.query("SELECT recommendations,skipped FROM teaching_signals WHERE enrollment_id=$1", [held.id])).rows[0];
      expect(signal.recommendations.map((r: any) => r.action)).toEqual(['contrast_case']);
      expect(signal.skipped).toContainEqual({ ruleId: 'T1', what: 'action:contrast_case', reason: 'autonomy_recommend_only' });
    } finally { await db.query('DELETE FROM supervision_settings WHERE workspace_id=$1', [workspace]); }

    const due = await enroll();
    await db.query("INSERT INTO retention_schedules(enrollment_id,objective_id,demonstrated_at,step,due_at) VALUES($1,'minimum',clock_timestamp()-interval '2 days',1,clock_timestamp()-interval '1 minute')", [due.id]);
    await scanWakeups(db, { batchSize: 1000 });
    const review = (await db.query("SELECT action,rule_id,state FROM teaching_actions WHERE enrollment_id=$1", [due.id])).rows;
    expect(review).toEqual([{ action: 'prepare_review', rule_id: 'T10', state: 'started' }]);
    expect((await db.query("SELECT rule_ids FROM teaching_signals WHERE enrollment_id=$1 AND signal_kind='review.due'", [due.id])).rows[0].rule_ids).toEqual(['T10']);
  }, 60000);
});

describe('tool families and logical roles are enforced by the host (N01, B04, Q08)', () => {
  it('refuses a tool outside the checkpoint\'s logical role or the workspace\'s permitted families, and validates visual choices', async () => {
    const { learner, id } = await enroll();
    const ref = await admitReview(learner, id);
    const claim = await bridge.transition({ type: 'claim', ref, checkpointId: 'generate', ownerId: randomUUID(), availability: { status: 'ready' } });
    const op = claim.snapshot.operations[0]!;
    const request: ProviderRequest = { schemaVersion: 1, operationId: op.id, job: claim.snapshot.specification.key, role: 'supervisor',
      checkpoint: claim.snapshot.specification.checkpoints[0]!, fence: claim.snapshot.specification.fence };
    const resolved = await resolveSupervisorOperation(db, request);
    const port = supervisorTools(db, request, await teachingContext(db, resolved.ref, resolved.input.context));
    // A single-writer run never delegates.
    await expect(port.invoke('compare_alternatives', {}, 0)).rejects.toBeInstanceOf(ToolCallRefused);
    // A visual must have been listed first, and must carry an accessible description.
    await expect(port.invoke('choose_visual', { visualId: 'number-line', objectiveId: 'minimum' }, 0)).rejects.toMatchObject({ code: 'VISUAL_NOT_OBSERVED' });
    await port.invoke('list_visuals', {}, 1);
    await expect(port.invoke('choose_visual', { visualId: 'no-description', objectiveId: 'minimum' }, 2)).rejects.toMatchObject({ code: 'VISUAL_UNAVAILABLE' });
    await expect(port.invoke('choose_visual', { visualId: 'number-line', objectiveId: 'maximum' }, 2)).rejects.toMatchObject({ code: 'OBJECTIVE_OUT_OF_SCOPE' });
    expect((await port.invoke('choose_visual', { visualId: 'number-line', objectiveId: 'minimum' }, 2)).suggestion).toEqual({ kind: 'visual', objectiveId: 'minimum', visualId: 'number-line', episodeId: 'min' });
    // Authority requests are validated per kind.
    await expect(port.invoke('request_authority', { kind: 'goal_change', reason: 'r', objectiveIds: ['minimum'] }, 3)).rejects.toBeInstanceOf(ToolCallRefused);
    await expect(port.invoke('request_authority', { kind: 'required_objectives', reason: 'r', objectiveIds: ['unknown'] }, 3)).rejects.toMatchObject({ code: 'OBJECTIVE_OUT_OF_SCOPE' });
    // Families the workspace does not permit are refused even if a model names them.
    await db.query("INSERT INTO supervision_settings(workspace_id,permitted_tool_families) VALUES($1,ARRAY['learner_read','teaching'])", [workspace]);
    try {
      await expect(port.invoke('list_visuals', {}, 4)).rejects.toMatchObject({ code: 'SUPERVISOR_TOOL_UNAVAILABLE' });
      await expect(port.invoke('get_assessment_outline', {}, 4)).rejects.toMatchObject({ code: 'SUPERVISOR_TOOL_UNAVAILABLE' });
      expect((await port.invoke('get_profile', {}, 4)).result).toBeTruthy();
      const context = await teachingContext(db, resolved.ref, resolved.input.context);
      expect(context.permittedToolFamilies).toEqual(['learner_read', 'teaching']);
    } finally { await db.query('DELETE FROM supervision_settings WHERE workspace_id=$1', [workspace]); }
  }, 60000);
});

describe('separate authority for goal, grading and paid-ceiling changes (B06)', () => {
  async function requestAuthority(learner: Session, id: string, args: Record<string, unknown>) {
    const ref = await admitReview(learner, id);
    await runCheckpoint(ref, 'generate', round => round === 0 ? call('request_authority', args) : finish('Asked for a decision.'));
    const parked = await rpc({ method: 'transition', command: { type: 'verify', ref } });
    return { ref, parked };
  }
  it('a goal change waits for the learner, who approves it, can undo it, and the job then finishes', async () => {
    const { learner, id } = await enroll();
    const before = (await db.query("SELECT profile->>'goal' AS goal FROM enrollments WHERE id=$1", [id])).rows[0].goal;
    const { ref, parked } = await requestAuthority(learner, id, { kind: 'goal_change', reason: 'You asked about maxima twice.', proposedGoal: 'Find minima and maxima' });
    expect([parked.snapshot.state, parked.snapshot.reason]).toEqual(['needs_input', 'input_required']);
    // A person may take days: the job's deadline was extended while it waits.
    expect(parked.snapshot.specification.deadlineAtMs).toBeGreaterThan(Date.now() + 6 * 86_400_000);
    const listed = await app.inject({ url: `/api/enrollments/${id}/supervision/requests`, headers: headers(learner) });
    const [request] = listed.json().requests;
    expect(request).toMatchObject({ kind: 'goal_change', approver: 'learner', state: 'pending', proposal: { goal: 'Find minima and maxima' } });
    // Staff cannot decide the learner's goal, and another learner cannot read it.
    const staff = await app.inject({ method: 'POST', url: `/api/admin/workspaces/${workspace}/supervision/requests/${request.requestId}/decision`, headers: headers(owner),
      payload: { idempotencyKey: randomUUID(), decision: 'approve' } });
    expect([staff.statusCode, staff.json().error]).toEqual([403, 'AUTHORITY_DECIDED_BY_LEARNER']);
    const stranger = await login();
    expect((await app.inject({ url: `/api/enrollments/${id}/supervision/requests`, headers: headers(stranger) })).statusCode).toBe(404);
    // A late step of the parked generation changes nothing.
    expect((await rpc({ method: 'transition', command: { type: 'apply', ref } })).snapshot.state).toBe('needs_input');

    const approved = await command(learner, id, `supervision/requests/${request.requestId}/decision`, { decision: 'approve' });
    expect(approved).toMatchObject({ state: 'approved', canUndo: true });
    expect((await db.query("SELECT profile->>'goal' AS goal FROM enrollments WHERE id=$1", [id])).rows[0].goal).toBe('Find minima and maxima');
    const next = { ...ref, generation: 2 };
    expect((await snapshotOf(ref.jobId)).state).toBe('queued');
    expect((await bridge.transition({ type: 'claim', ref: next, checkpointId: 'generate', ownerId: randomUUID(), availability: { status: 'ready' } })).effect).toBe('continue');
    expect((await rpc({ method: 'transition', command: { type: 'verify', ref: next } })).snapshot.state).toBe('ready');
    expect((await rpc({ method: 'transition', command: { type: 'apply', ref: next } })).snapshot.state).toBe('applied');

    const undone = await command(learner, id, `supervision/requests/${request.requestId}/decision`, { decision: 'undo' });
    expect(undone.state).toBe('undone');
    expect((await db.query("SELECT profile->>'goal' AS goal FROM enrollments WHERE id=$1", [id])).rows[0].goal).toBe(before ?? '');
    const again = await app.inject({ method: 'POST', url: `/api/enrollments/${id}/supervision/requests/${request.requestId}/decision`, headers: headers(learner),
      payload: { expectedRevision: await revision(id), idempotencyKey: randomUUID(), decision: 'undo' } });
    expect([again.statusCode, again.json().error]).toEqual([409, 'AUTHORITY_UNDO_UNAVAILABLE']);
  }, 60000);

  it('a paid ceiling is decided by an owner or admin only; a rejection ends the job and changes nothing', async () => {
    const { learner, id } = await enroll();
    const { ref } = await requestAuthority(learner, id, { kind: 'paid_ceiling', reason: 'Two more practice sessions.', proposedLimitMicroUsd: 20_000_000 });
    const request = (await db.query('SELECT id FROM supervisor_authority_requests WHERE job_id=$1', [ref.jobId])).rows[0].id;
    const mine = await app.inject({ method: 'POST', url: `/api/enrollments/${id}/supervision/requests/${request}/decision`, headers: headers(learner),
      payload: { expectedRevision: await revision(id), idempotencyKey: randomUUID(), decision: 'approve' } });
    expect([mine.statusCode, mine.json().error]).toEqual([403, 'AUTHORITY_DECIDED_BY_STAFF']);
    const instructor = await login('instructor');
    for (const who of [instructor, learner]) {
      const denied = await app.inject({ method: 'POST', url: `/api/admin/workspaces/${workspace}/supervision/requests/${request}/decision`, headers: headers(who),
        payload: { idempotencyKey: randomUUID(), decision: 'approve' } });
      expect(denied.statusCode).toBe(403);
      expect((await app.inject({ url: `/api/admin/workspaces/${workspace}/supervision/requests`, headers: headers(who) })).statusCode).toBe(403);
    }
    const queue = await app.inject({ url: `/api/admin/workspaces/${workspace}/supervision/requests`, headers: headers(owner) });
    expect(queue.json().requests.find((r: any) => r.requestId === request)).toMatchObject({ kind: 'paid_ceiling', state: 'pending', proposal: { limitMicroUsd: 20_000_000 }, enrollmentId: id });
    const decided = await app.inject({ method: 'POST', url: `/api/admin/workspaces/${workspace}/supervision/requests/${request}/decision`, headers: headers(owner),
      payload: { idempotencyKey: randomUUID(), decision: 'approve' } });
    expect(decided.statusCode, decided.body).toBe(200);
    expect((await db.query('SELECT limit_micro_usd FROM supervisor_enrollment_budgets WHERE enrollment_id=$1', [id])).rows[0].limit_micro_usd).toBe('20000000');
    expect((await db.query("SELECT actor_kind,payload FROM learning_events WHERE enrollment_id=$1 AND event_type='supervisor.authority_decided'", [id])).rows[0])
      .toMatchObject({ actor_kind: 'staff', payload: { kind: 'paid_ceiling', decision: 'approve' } });

    const rejected = await requestAuthority(learner, id, { kind: 'grading_standard', reason: 'The rubric is stricter than the lesson.', objectiveIds: ['minimum'] });
    const second = (await db.query('SELECT id FROM supervisor_authority_requests WHERE job_id=$1', [rejected.ref.jobId])).rows[0].id;
    const no = await app.inject({ method: 'POST', url: `/api/admin/workspaces/${workspace}/supervision/requests/${second}/decision`, headers: headers(owner),
      payload: { idempotencyKey: randomUUID(), decision: 'reject' } });
    expect(no.json().state).toBe('rejected');
    expect((await snapshotOf(rejected.ref.jobId)).state).toBe('cancelled');
  }, 60000);

  it('a plan may not mix an authority request with teaching changes, and propose_only autonomy refuses teaching changes', async () => {
    const { learner, id } = await enroll();
    const ref = await admitReview(learner, id);
    await runCheckpoint(ref, 'generate', round => round === 0 ? call('propose_practice_check', { objectiveId: 'minimum' })
      : round === 1 ? call('request_authority', { kind: 'goal_change', reason: 'r', proposedGoal: 'g' }) : finish('Both.'));
    // The tool loop emits the plan; the verifier refuses it as a whole.
    expect((await rpc({ method: 'transition', command: { type: 'verify', ref } })).snapshot).toMatchObject({ state: 'failed', reason: 'verification_rejected' });
    expect((await db.query('SELECT count(*)::int AS n FROM supervisor_authority_requests WHERE job_id=$1', [ref.jobId])).rows[0].n).toBe(0);

    await db.query("INSERT INTO supervision_settings(workspace_id,autonomy_level,permitted_tool_families) VALUES($1,'propose_only',ARRAY['learner_read','teaching','assessment'])", [workspace]);
    try {
      const other = await admitReview(learner, id);
      await runCheckpoint(other, 'generate', round => round === 0 ? call('propose_practice_check', { objectiveId: 'minimum' }) : finish('Practice.'));
      expect((await rpc({ method: 'transition', command: { type: 'verify', ref: other } })).snapshot).toMatchObject({ state: 'failed', reason: 'verification_rejected' });
    } finally { await db.query('DELETE FROM supervision_settings WHERE workspace_id=$1', [workspace]); }
  }, 60000);
});
