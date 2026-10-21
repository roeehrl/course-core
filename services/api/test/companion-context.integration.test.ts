import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileCourse } from '@course-core/sdk/compiler';
import type { HostBridge, RunRef } from '@course-core/supervisor';
import { createDatabase, transaction, type Database } from '../src/database.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';
import { createServer } from '../src/server.js';
import { issueLoginCode } from '../src/auth.js';
import { svgRenderer } from '../src/svg-renderer.js';
import { teachingContext } from '../src/provider-context.js';
import { loadEnrollment } from '../src/repository.js';
import { resolveSelection, retrieveConversation, RETRIEVAL_LIMITS } from '../src/context-capsule.js';
import { configureSupervisorBudget, createPostgresSupervisorBridge, loadSupervisorInput, recordSupervisorVerification, storeSupervisorArtifact } from '../src/supervisor-bridge.js';
import { contextCapsuleSchema } from '../src/contracts/context-capsule-schema.js';
import { fixture } from './fixture.js';
import { visualContextFixture } from '../../../apps/learner/tests/visualContext.fixture.js';

const origin = 'http://localhost:4310', schema = `course_companion_context_${randomUUID().replaceAll('-', '')}`;
const serviceToken = 'synthetic-test-service-token-not-a-credential';
let db: Database, app: Awaited<ReturnType<typeof createServer>>, workspaceId: string, releaseId: string, digest: string;
let testDatabase: TestDatabase | undefined;
const visual = visualContextFixture();
((visual.scene as unknown as { nodes: { label?: string }[] }).nodes[0]!).label = 'Meter bar';
const TEXT = 'The minimum is no greater than any other member. Compare with `a <= b` for every pair.';

beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  const renderer = await svgRenderer();
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false, installedExtensions: [renderer] });
  const source = fixture();
  const min = source.chapters[0]!.episodes[0]!;
  (min.blocks[0] as { markdown: string }).markdown = TEXT;
  source.visuals.push(visual);
  min.blocks.push({ id: 'meter-visual', type: 'visual', visualId: visual.id });
  source.sources.push({ id: 'walkthrough-source', title: 'Synthetic walkthrough', url: 'https://example.org/walkthrough', reviewedAt: '2026-10-01T00:00:00Z' } as never);
  source.media.push({ id: 'walkthrough', type: 'youtube', sourceRef: 'walkthrough-source', url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ', review: 'reviewed',
    alternativeMarkdown: 'The walkthrough keeps the smaller value after each comparison.', generated: false } as never);
  min.blocks.push({ id: 'min-video', type: 'media', mediaId: 'walkthrough', required: false } as never);
  source.extensions.push({ id: renderer.id, version: renderer.version, integrity: renderer.integrity, execution: 'declarative', entrypoint: 'renderers/svg-v1.js', platforms: ['web'],
    capabilities: ['visual.render'], accessibility: { keyboard: true, reducedMotion: true, textAlternative: visual.accessibility.description } });
  const compiled = compileCourse(source), owner = randomUUID();
  workspaceId = randomUUID(); releaseId = randomUUID(); digest = compiled.digest;
  await db.query('INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)', [owner, `capsule:${owner}`, 'Test author']);
  await db.query('INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)', [workspaceId, `capsule-${workspaceId}`, 'Capsule tests']);
  await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'owner')", [workspaceId, owner]);
  await db.query("INSERT INTO course_releases(id,workspace_id,course_key,version,digest,server_bundle,learner_bundle,status,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,'published',$8)",
    [releaseId, workspaceId, source.id, source.version, compiled.digest, JSON.stringify(compiled.server), JSON.stringify(compiled.learner), owner]);
}, 30_000);
afterAll(async () => { await app?.close(); await db?.end(); await testDatabase?.drop(); });

type Learner = { id: string; user: string; headers: Record<string, string> };
async function login(user: string) {
  const response = await app.inject({ method: 'POST', url: '/auth/redeem', headers: { origin }, payload: { token: await issueLoginCode(db, user) } });
  expect(response.statusCode, response.body).toBe(200);
  return { origin, cookie: response.cookies.map(c => `${c.name}=${c.value}`).join('; '), 'x-csrf-token': response.json().csrfToken };
}
async function fresh(): Promise<Learner> {
  const user = randomUUID();
  await db.query('INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)', [user, `capsule:${user}`, 'Test learner']);
  await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'learner')", [workspaceId, user]);
  const headers = await login(user);
  const enrolled = await app.inject({ method: 'POST', url: '/api/enrollments', headers, payload: { releaseId } });
  expect(enrolled.statusCode, enrolled.body).toBe(200);
  return { id: enrolled.json().id, user, headers };
}
async function staff(role: string) {
  const user = randomUUID();
  await db.query('INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)', [user, `capsule-staff:${user}`, 'Staff']);
  await db.query('INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)', [workspaceId, user, role]);
  return login(user);
}
const revision = async (id: string) => Number((await db.query('SELECT revision FROM enrollments WHERE id=$1', [id])).rows[0].revision);
async function command(f: Learner, action: string, body: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: `/api/enrollments/${f.id}/${action}`, headers: f.headers, payload: { expectedRevision: await revision(f.id), idempotencyKey: randomUUID(), ...body } });
}
async function ask(f: Learner, content: string, extra: Record<string, unknown> = {}, episodeId = 'min') {
  return command(f, 'companion', { episodeId, content, ...extra });
}
async function answer(f: Learner, assessmentId: string, value: unknown, mode = 'independent') {
  const issued = await command(f, 'challenges', { episodeId: 'min', assessmentId, mode });
  expect(issued.statusCode, issued.body).toBe(200);
  const answered = await command(f, 'answers', { challengeId: issued.json().challengeId, answer: value });
  expect(answered.statusCode, answered.body).toBe(200);
}
const conversation = async (f: Learner) => (await app.inject({ url: `/api/enrollments/${f.id}/companion`, headers: f.headers })).json().messages as Record<string, any>[];
function bridge() {
  return createPostgresSupervisorBridge(db, { serviceToken, workspaceIds: [workspaceId], jobPolicy: { allowance: { microUsd: 100, tokens: 100 }, durationMs: 60_000, timeoutMs: 1_000, maxAttempts: 3 } });
}
/** The real host bridge: the learner's question becomes a companion job; its provider context is built. */
async function admit(f: Learner, eventId: string) {
  const b = bridge();
  const lease = (await b.claimOutbox(randomUUID(), 100, 30_000)).find(row => row.eventId === eventId)!;
  expect(lease).toBeDefined();
  const ref = (await b.prepareOutbox(lease))[0]!; await b.ackOutbox(lease);
  await configureSupervisorBudget(db, { workspaceId }, { microUsd: 10_000, tokens: 10_000 });
  await configureSupervisorBudget(db, { workspaceId, enrollmentId: f.id }, { microUsd: 10_000, tokens: 10_000 });
  const claimed = await b.transition({ type: 'claim', ref, checkpointId: 'generate', ownerId: randomUUID(), availability: { status: 'ready' } });
  expect(claimed.effect).toBe('invoke');
  const input = await loadSupervisorInput(db, ref, claimed.snapshot.specification.checkpoints[0]!.inputRef);
  const teaching = await teachingContext(db, ref, input.context);
  return { b, ref, op: claimed.snapshot.operations[0]!, teaching };
}
async function finish(job: { b: HostBridge; ref: RunRef; op: { id: string; ownerId: string } }, text: string) {
  const output = await storeSupervisorArtifact(db, job.ref, job.op.id, job.op.ownerId, { kind: 'companion_message', text });
  await job.b.transition({ type: 'settle', ref: job.ref, operationId: job.op.id, ownerId: job.op.ownerId, outcome: { status: 'succeeded', artifact: output, usage: { microUsd: 5, tokens: 5 } } });
  const verifier = randomUUID();
  await db.query(`INSERT INTO supervisor_verifier_authorities (id,workspace_id,label,can_verify_companion,can_review_adaptation) VALUES ($1,$2,'Synthetic verifier',true,false)`, [verifier, workspaceId]);
  try { await recordSupervisorVerification(db, job.ref, verifier, 'verified'); }
  catch { return (await job.b.transition({ type: 'verify', ref: job.ref })).snapshot; }
  await job.b.transition({ type: 'verify', ref: job.ref });
  return (await job.b.transition({ type: 'apply', ref: job.ref })).snapshot;
}

describe('answers stay attached to the context they were asked in', () => {
  it('switching episode during generation keeps the answer, echoing its context revision and capsule', async () => {
    const f = await fresh();
    await answer(f, 'min-a', 'two'); await answer(f, 'min-b', 4);
    for (const blockId of ['min-text', 'meter-visual', 'min-video']) expect((await command(f, 'read', { episodeId: 'min', blockId })).statusCode).toBe(200);
    const completed = await command(f, 'complete', { episodeId: 'min' });
    expect(completed.statusCode, completed.body).toBe(200);
    const asked = await ask(f, 'Why is the comparison less-or-equal?', { selection: { kind: 'text', courseDigest: digest, excerpt: 'a <= b' }, uiRevision: 7 });
    expect(asked.statusCode, asked.body).toBe(200);
    expect(asked.json()).toMatchObject({ state: 'queued', selectedAnchor: { kind: 'formula' } });
    const job = await admit(f, asked.json().eventId);
    expect(job.teaching.focus).toMatchObject({ selection: { kind: 'formula', blockId: 'min-text', excerpt: 'a <= b' }, authority: 'learner_pointed_at_this_not_evidence' });
    // Mid-generation the learner moves to the next lesson and asks something else there.
    const read = await command(f, 'read', { episodeId: 'max', blockId: 'max-text' });
    expect(read.statusCode, read.body).toBe(200);
    expect((await ask(f, 'A question in the next lesson.', {}, 'max')).statusCode).toBe(200);
    const snapshot = await finish(job, 'Because the minimum may equal another member.');
    expect(snapshot.state).toBe('applied');
    const messages = await conversation(f);
    const reply = messages.find(row => row.role === 'assistant')!;
    expect(reply.content).toBe('Because the minimum may equal another member.');
    // The answer row itself carries the question's lesson, not the one the learner moved to.
    expect(reply.context).toMatchObject({ episodeId: 'min', blockId: null, answersMessageId: asked.json().messageId });
    expect((await db.query('SELECT context FROM companion_messages WHERE id=$1', [reply.id])).rows[0].context).toMatchObject({ episodeId: 'min', answersMessageId: asked.json().messageId });
    expect(reply.context_used).toMatchObject({ episodeId: 'min', answersMessageId: asked.json().messageId, contextRevision: asked.json().contextRevision, courseDigest: digest,
      selection: { kind: 'formula', excerpt: 'a <= b' } });
    const stored = (await db.query('SELECT capsule FROM companion_context_capsules WHERE job_id=$1', [job.ref.jobId])).rows[0].capsule;
    expect(stored).toMatchObject({ kind: 'companion_context_capsule', episodeId: 'min', uiRevision: 7, recentEventCursor: expect.any(String), assessmentMode: 'none' });
    // D01: the stored capsule is a valid public ContextCapsule (contracts/context-capsule.ts).
    expect(contextCapsuleSchema.safeParse(stored).error).toBeUndefined();
    expect(stored.evidenceRefs.length).toBeGreaterThan(0);
    // The capsule the learner sees carries the same constraint snapshot the job was given (G07 parity).
    expect(stored.resolvedConstraintSnapshot.view).toEqual(job.teaching.constraints.resolvedPolicy);
    expect(reply.context_used.constraints).toEqual({ deadline: job.teaching.constraints.deadline, expansionAllowed: job.teaching.constraints.expansionAllowed,
      independentAssessmentActive: false, policyRevision: job.teaching.revisions!.policy, digest: stored.resolvedConstraintSnapshot.digest });
  });

  it('a real context change (a new independent check) still fences the answer', async () => {
    const f = await fresh();
    const asked = await ask(f, 'What does minimum mean?');
    const job = await admit(f, asked.json().eventId);
    expect((await command(f, 'challenges', { episodeId: 'min', assessmentId: 'min-a', mode: 'independent' })).statusCode).toBe(200);
    expect((await finish(job, 'Never delivered.')).reason).toBe('stale_revision');
    expect((await conversation(f)).some(row => row.role === 'assistant')).toBe(false);
  });
});

describe('answer rows saved before they carried their lesson', () => {
  it('take the lesson of the question they answer; rows with no question or an erased one stay unlabelled', async () => {
    const f = await fresh();
    const answered = async (questionContext: Record<string, unknown> | null, text: string) => {
      const job = randomUUID();
      await db.query(`INSERT INTO supervisor_jobs(id,enrollment_id,workspace_id,workflow_id,role,state,expected_revision,specification) VALUES ($1,$2,$3,$4,'companion','applied',1,'{}')`,
        [job, f.id, workspaceId, `legacy-${job}`]);
      if (questionContext) await db.query("INSERT INTO companion_messages(id,enrollment_id,role,content,context,job_id) VALUES ($1,$2,'learner','Q',$3,$4)", [randomUUID(), f.id, JSON.stringify(questionContext), job]);
      await db.query("INSERT INTO companion_messages(id,enrollment_id,role,content,context,job_id) VALUES ($1,$2,'assistant',$3,'{\"artifactId\":\"x\"}',$4)", [randomUUID(), f.id, text, job]);
    };
    await answered({ episodeId: 'max', blockId: 'max-text' }, 'LEGACY_WITH_QUESTION');
    await answered({ episodeId: 'min' }, 'LEGACY_NO_BLOCK');
    await answered({}, 'LEGACY_ERASED_QUESTION');
    await answered(null, 'LEGACY_NO_QUESTION');
    await db.query("INSERT INTO companion_messages(id,enrollment_id,role,content,context) VALUES ($1,$2,'assistant','NO_JOB','{}')", [randomUUID(), f.id]);
    const rows = Object.fromEntries((await conversation(f)).filter(row => row.role === 'assistant').map(row => [row.content, row.context]));
    expect(rows.LEGACY_WITH_QUESTION).toEqual({ artifactId: 'x', episodeId: 'max', blockId: 'max-text' });
    expect(rows.LEGACY_NO_BLOCK).toEqual({ artifactId: 'x', episodeId: 'min', blockId: null });
    expect(rows.LEGACY_ERASED_QUESTION).toEqual({ artifactId: 'x' });
    expect(rows.LEGACY_NO_QUESTION).toEqual({ artifactId: 'x' });
    expect(rows.NO_JOB).toEqual({});
    // Stored rows are not rewritten by reading them.
    expect((await db.query("SELECT count(*)::int AS n FROM companion_messages WHERE enrollment_id=$1 AND role='assistant' AND context ? 'episodeId'", [f.id])).rows[0].n).toBe(0);
  });
});

describe('bounded, episode-scoped retrieval with references', () => {
  it('replaces the cross-lesson paste: this lesson only, bounded, referenced, summarized and learner-correctable', async () => {
    const f = await fresh();
    const other = await fresh();
    await ask(other, 'OTHER_LEARNER_CANARY');
    const sent: { messageId: string; eventId: string }[] = [];
    for (let index = 0; index < 11; index++) sent.push((await ask(f, `Lesson question ${index} ${'x'.repeat(index === 10 ? 1500 : 10)}`)).json());
    // Another lesson's conversation never reaches this lesson's context.
    await command(f, 'read', { episodeId: 'min', blockId: 'min-text' });
    await db.query("INSERT INTO companion_messages(id,enrollment_id,role,content,context) VALUES ($1,$2,'learner','OTHER_LESSON_CANARY',$3)", [randomUUID(), f.id, JSON.stringify({ episodeId: 'max', courseDigest: digest })]);
    const current = (await ask(f, 'The current question.')).json();
    const retrieved = await transaction(db, client => retrieveConversation(client, { enrollmentId: f.id, episodeId: 'min', courseDigest: digest, currentMessageId: current.messageId }));
    const text = JSON.stringify(retrieved);
    expect(text).not.toContain('OTHER_LESSON_CANARY'); expect(text).not.toContain('OTHER_LEARNER_CANARY'); expect(text).not.toContain('The current question.');
    expect(retrieved.history.length).toBeLessThanOrEqual(RETRIEVAL_LIMITS.messages);
    expect(retrieved.history.reduce((sum, row) => sum + row.content.length, 0)).toBeLessThanOrEqual(RETRIEVAL_LIMITS.totalCharacters);
    expect(retrieved.history.every(row => row.content.length <= RETRIEVAL_LIMITS.messageCharacters)).toBe(true);
    // Newest first in the window, each with its message and request event reference.
    expect(retrieved.refs.at(-1)).toMatchObject({ messageId: sent[10]!.messageId, eventId: sent[10]!.eventId, clipped: true, characters: RETRIEVAL_LIMITS.messageCharacters });
    // Older questions are summarized extractively, naming their source events.
    expect(retrieved.summary).toMatchObject({ kind: 'earlier_questions_in_lesson', count: 3 });
    expect(retrieved.summary!.sourceEventIds).toEqual([sent[2]!.eventId, sent[1]!.eventId, sent[0]!.eventId]);
    expect(retrieved.summary!.items[0]!.excerpt).toContain('Lesson question 2');
    // The learner asks the companion not to use one message again; retrieval skips it and replays are refused.
    const exclude = (excluded: boolean, key = randomUUID()) => app.inject({ method: 'POST', url: `/api/enrollments/${f.id}/companion/context-exclusions`, headers: f.headers,
      payload: { expectedRevision: 0, idempotencyKey: key, messageId: sent[9]!.messageId, excluded } });
    const withRevision = async (excluded: boolean) => app.inject({ method: 'POST', url: `/api/enrollments/${f.id}/companion/context-exclusions`, headers: f.headers,
      payload: { expectedRevision: await revision(f.id), idempotencyKey: randomUUID(), messageId: sent[9]!.messageId, excluded } });
    expect((await exclude(true)).statusCode).toBe(400);
    const excluded = await withRevision(true);
    expect(excluded.statusCode, excluded.body).toBe(200);
    expect((await withRevision(true)).json().error).toBe('CONTEXT_EXCLUSION_UNCHANGED');
    const after = await transaction(db, client => retrieveConversation(client, { enrollmentId: f.id, episodeId: 'min', courseDigest: digest, currentMessageId: current.messageId }));
    expect(after.refs.map(ref => ref.messageId)).not.toContain(sent[9]!.messageId);
    expect(JSON.stringify(after)).not.toContain('Lesson question 9');
    expect((await conversation(f)).find(row => row.id === sent[9]!.messageId)).toMatchObject({ excluded: true });
    // Staff, peers and unknown messages cannot change it.
    for (const headers of [await staff('owner'), await staff('instructor'), other.headers])
      expect((await app.inject({ method: 'POST', url: `/api/enrollments/${f.id}/companion/context-exclusions`, headers,
        payload: { expectedRevision: await revision(f.id), idempotencyKey: randomUUID(), messageId: sent[9]!.messageId, excluded: false } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/api/enrollments/${f.id}/companion/context-exclusions`, headers: f.headers,
      payload: { expectedRevision: await revision(f.id), idempotencyKey: randomUUID(), messageId: randomUUID(), excluded: true } })).json().error).toBe('MESSAGE_NOT_FOUND');
    expect((await withRevision(false)).statusCode).toBe(200);
  });
});

describe('selection anchors and media', () => {
  it('rejects stale or foreign anchors instead of guessing, and keeps valid ones exact', async () => {
    const f = await fresh();
    const before = await revision(f.id);
    const refused = [
      { selection: { kind: 'text', courseDigest: digest, excerpt: 'Text that was never in this lesson.' } },
      { selection: { kind: 'text', courseDigest: 'f'.repeat(64), excerpt: 'The minimum is no greater' } },
      { selection: { kind: 'text', courseDigest: digest, excerpt: 'The maximum is no less than any other member.' } },
      { selection: { kind: 'code', courseDigest: digest, excerpt: 'return min(values)', lineStart: 2, lineEnd: 2, codeSnapshotHash: 'a'.repeat(64) } },
      { selection: { kind: 'visual_node', courseDigest: digest, blockId: 'meter-visual', nodeId: 'result' } },
      { selection: { kind: 'visual_node', courseDigest: digest, blockId: 'min-text', nodeId: 'meter' } },
      { media: { courseDigest: digest, mediaId: 'missing-media' } },
      { media: { courseDigest: 'f'.repeat(64), mediaId: 'walkthrough' } },
    ];
    for (const extra of refused) {
      const response = await ask(f, 'About this?', extra);
      expect(response.statusCode, JSON.stringify(extra)).toBe(409); expect(response.json().error).toBe('ANCHOR_STALE');
    }
    for (const extra of [{ selection: { kind: 'text', courseDigest: digest, excerpt: ' ' } }, { selection: { kind: 'code', courseDigest: digest, excerpt: 'x', lineStart: 5, lineEnd: 2, codeSnapshotHash: 'a'.repeat(64) } },
      { media: { courseDigest: digest, mediaId: 'walkthrough', playbackSeconds: -1 } }, { selection: { kind: 'other' } }])
      expect((await ask(f, 'About this?', extra)).statusCode, JSON.stringify(extra)).toBe(400);
    // Nothing was written by a refused request.
    expect(await revision(f.id)).toBe(before);
    expect((await db.query('SELECT count(*)::int AS n FROM companion_messages WHERE enrollment_id=$1', [f.id])).rows[0].n).toBe(0);
    // Valid: a labelled part of the illustration, prose, and the course video at a position.
    const node = await ask(f, 'What does the bar show?', { selection: { kind: 'visual_node', courseDigest: digest, blockId: 'meter-visual', nodeId: 'meter' },
      media: { courseDigest: digest, mediaId: 'walkthrough', playbackSeconds: 83.27 } });
    expect(node.statusCode, node.body).toBe(200);
    expect(node.json()).toMatchObject({ selectedAnchor: { kind: 'visual_node' }, mediaRef: { mediaId: 'walkthrough', playbackSeconds: 83.3 } });
    const stored = (await db.query('SELECT context FROM companion_messages WHERE id=$1', [node.json().messageId])).rows[0].context;
    expect(stored.selectedAnchor).toEqual({ kind: 'visual_node', blockId: 'meter-visual', visualId: visual.id, nodeId: 'meter', label: 'Meter bar', courseDigest: digest });
    expect(stored.mediaRef).toEqual({ mediaId: 'walkthrough', blockId: 'min-video', kind: 'youtube', playbackSeconds: 83.3, reviewedSegment: null });
    const prose = await ask(f, 'And this sentence?', { selection: { kind: 'text', courseDigest: digest, excerpt: 'no greater than   any other' } });
    expect(prose.statusCode, prose.body).toBe(200);
    expect((await db.query('SELECT context FROM companion_messages WHERE id=$1', [prose.json().messageId])).rows[0].context.selectedAnchor)
      .toMatchObject({ kind: 'text', blockId: 'min-text', excerpt: 'no greater than any other', contentDigest: createHash('sha256').update(TEXT).digest('hex') });
    // A result log: text from the learner's latest graded answer in this lesson.
    await answer(f, 'min-a', 'five', 'practice');
    const log = await ask(f, 'Why this feedback?', { selection: { kind: 'text', courseDigest: digest, excerpt: '2 is below 5.' } });
    expect(log.statusCode, log.body).toBe(200);
    expect((await db.query('SELECT context FROM companion_messages WHERE id=$1', [log.json().messageId])).rows[0].context.selectedAnchor).toMatchObject({ kind: 'log_entry', assessmentId: 'min-a' });
    // The learner's own code lines in an open code check of this lesson (resolved against a code item).
    const context = await loadEnrollment(db, { id: f.user, displayName: 'Test learner' }, f.id);
    const course = structuredClone(context.release.server_bundle);
    course.assessments.push({ id: 'synthetic-code', type: 'code', objectiveIds: ['minimum'], familyId: 'code', language: 'python', starterCode: '', prompt: 'Write it.', grading: { evaluatorId: 'none', fixtureRef: 'none' } } as never);
    const challengeId = randomUUID();
    await db.query(`INSERT INTO assessment_challenges(id,enrollment_id,episode_id,assessment_id,course_digest,mode,independent_eligible,expires_at) VALUES ($1,$2,'min','synthetic-code',$3,'practice',false,now()+interval '1 hour')`, [challengeId, f.id, digest]);
    const episode = course.chapters[0]!.episodes[0]!;
    const code = await transaction(db, client => resolveSelection(client, { ...context, release: { ...context.release, server_bundle: course } }, episode,
      { kind: 'code', courseDigest: digest, excerpt: '    return min(values)', lineStart: 2, lineEnd: 2, codeSnapshotHash: 'b'.repeat(64) }));
    expect(code).toEqual({ kind: 'code_line', assessmentId: 'synthetic-code', challengeId, lineStart: 2, lineEnd: 2, excerpt: '    return min(values)', codeSnapshotHash: 'b'.repeat(64), courseDigest: digest, source: 'learner_draft' });
  });
});

describe('privacy, export and erasure', () => {
  it('keeps capsules in the learner export only and erases them with the conversation', async () => {
    const f = await fresh();
    const asked = await ask(f, 'CAPSULE_QUESTION_CANARY', { selection: { kind: 'text', courseDigest: digest, excerpt: 'The minimum is no greater' } });
    const job = await admit(f, asked.json().eventId);
    expect((await finish(job, 'An answer.')).state).toBe('applied');
    const mine = await app.inject({ url: `/api/enrollments/${f.id}/export`, headers: f.headers });
    expect(mine.json().companionContext.capsules.items).toHaveLength(1);
    const owner = await staff('owner');
    const staffCopy = await app.inject({ url: `/api/admin/enrollments/${f.id}/export`, headers: owner });
    expect(staffCopy.statusCode, staffCopy.body).toBe(200);
    expect(staffCopy.json().companionContext).toBeNull();
    expect(staffCopy.body).not.toContain('The minimum is no greater');
    expect((await app.inject({ url: `/api/enrollments/${f.id}/companion`, headers: owner })).statusCode).toBe(404);
    const erased = await app.inject({ method: 'POST', url: `/api/enrollments/${f.id}/erase`, headers: f.headers, payload: { confirmation: `ERASE ${f.id.slice(0, 8)}`, reason: 'Synthetic erasure request.' } });
    expect(erased.statusCode, erased.body).toBe(200);
    expect(erased.json().counts.companionContextCapsules).toBe(1);
    expect((await db.query('SELECT capsule FROM companion_context_capsules WHERE job_id=$1', [job.ref.jobId])).rows[0].capsule).toEqual({});
  });
});
