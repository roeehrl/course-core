import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileCourse } from '@course-core/sdk/compiler';
import { createDatabase, transaction, type Database } from '../src/database.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';
import { appendEvent } from '../src/events.js';
import { initialPolicy } from '../src/policy-adapter.js';
import { searchCoursePassages, searchLearnerQuestions, searchQuery } from '../src/retrieval.js';
import { fixture } from './fixture.js';

const schema = `retrieval_${randomUUID().replaceAll('-', '')}`;
let db: Database;
let testDatabase: TestDatabase | undefined;
beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
}, 30_000);
afterAll(async () => { await db?.end(); await testDatabase?.drop(); });

function course(extraText = 'Comparisons keep the smaller value; ties keep the first one.') {
  const manifest = fixture();
  manifest.sources = [{ id: 'ref-sorting', title: 'Selection algorithms reference', url: 'https://example.org/selection', reviewedAt: '2026-01-01T00:00:00Z' }];
  manifest.chapters[0]!.episodes[0]!.blocks.push({ id: 'min-more', type: 'text', markdown: extraText, sourceRefs: ['ref-sorting'] });
  return manifest;
}
async function release(workspaceId: string, manifest = course(), status = 'published') {
  const id = randomUUID(), compiled = compileCourse(manifest), author = randomUUID();
  await db.query('INSERT INTO app_users (id,subject,display_name) VALUES ($1,$2,$3)', [author, `synthetic:${author}`, 'Synthetic author']);
  await db.query(`INSERT INTO course_releases (id,workspace_id,course_key,version,digest,server_bundle,learner_bundle,status,created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id, workspaceId, compiled.server.id, `1.0.${Math.floor(Math.random() * 100000)}`, compiled.digest, JSON.stringify(compiled.server), JSON.stringify(compiled.learner), status, author]);
  return { id, digest: compiled.digest };
}
async function workspace() {
  const id = randomUUID();
  await db.query('INSERT INTO workspaces (id,slug,title) VALUES ($1,$2,$3)', [id, `w-${id}`, 'Synthetic workspace']);
  return id;
}
async function enroll(workspaceId: string, releaseId: string, userId = randomUUID()) {
  const enrollmentId = randomUUID(), compiled = compileCourse(course());
  await db.query('INSERT INTO app_users (id,subject,display_name) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [userId, `synthetic:${userId}`, 'Synthetic learner']);
  await db.query("INSERT INTO memberships (workspace_id,user_id,role) VALUES ($1,$2,'learner') ON CONFLICT DO NOTHING", [workspaceId, userId]);
  await db.query(`INSERT INTO enrollments (id,workspace_id,course_release_id,user_id,policy,current_episode_id) VALUES ($1,$2,$3,$4,$5,'min')`,
    [enrollmentId, workspaceId, releaseId, userId, JSON.stringify(compiled.server.policy)]);
  await db.query('INSERT INTO policy_states (enrollment_id,policy_revision,ledger_revision,snapshot) VALUES ($1,1,0,$2)',
    [enrollmentId, JSON.stringify(initialPolicy(compiled.server, enrollmentId, userId, new Date().toISOString()))]);
  return { enrollmentId, userId };
}
async function ask(workspaceId: string, enrollmentId: string, userId: string, digest: string, content: string, role: 'learner' | 'assistant' = 'learner') {
  const messageId = randomUUID();
  await db.query('INSERT INTO companion_messages(id,enrollment_id,role,content,context) VALUES ($1,$2,$3,$4,$5)',
    [messageId, enrollmentId, role, content, JSON.stringify({ episodeId: 'min', courseDigest: digest })]);
  const event = await transaction(db, client => appendEvent(client, { workspaceId, enrollmentId, actorId: userId, actorKind: role === 'learner' ? 'learner' : 'agent',
    type: 'companion.requested', payload: { messageId }, idempotencyKey: randomUUID() }));
  return { messageId, eventId: event.id };
}
const passages = (releaseId: string, workspaceId: string, q: string) => transaction(db, client => searchCoursePassages(client, { releaseId, workspaceId }, q));
const questions = (enrollmentId: string, workspaceId: string, courseDigest: string, q: string) =>
  transaction(db, client => searchLearnerQuestions(client, { enrollmentId, workspaceId, courseDigest }, q));

describe('query construction', () => {
  it('keeps only words, as prefix terms, and turns operators and quotes into nothing', () => {
    expect(searchQuery('Running MINIMUM?')).toBe('running:* | minimum:*');
    expect(searchQuery("min & ! | :* ' ) ( <-> \\ %")).toBe('min:*');
    expect(searchQuery('  !!! ')).toBeNull();
    expect(searchQuery('Größe x2 größe')).toBe('größe:* | x2:*');
    expect(searchQuery(Array.from({ length: 20 }, (_, i) => `w${i}`).join(' '))!.split(' | ')).toHaveLength(8);
  });
});

describe('course passages', () => {
  it('index text blocks and source titles at import, rank matches, and stay inside one release', async () => {
    const w = await workspace(), own = await release(w), foreign = await release(await workspace(), course('FOREIGN_RELEASE_CANARY minimum'));
    const rows = (await db.query('SELECT passage_id,kind,episode_id,source_refs FROM course_release_passages WHERE course_release_id=$1 ORDER BY passage_id', [own.id])).rows;
    expect(rows).toEqual([
      { passage_id: 'block:max-text', kind: 'text_block', episode_id: 'max', source_refs: [] },
      { passage_id: 'block:min-more', kind: 'text_block', episode_id: 'min', source_refs: ['ref-sorting'] },
      { passage_id: 'block:min-text', kind: 'text_block', episode_id: 'min', source_refs: [] },
      { passage_id: 'source:ref-sorting', kind: 'source', episode_id: null, source_refs: ['ref-sorting'] },
    ]);
    // Prefix words, any word, ranked: the passage matching both words comes first.
    const found = await passages(own.id, w, 'smaller compar');
    expect(found[0]).toMatchObject({ passageId: 'block:min-more', episodeId: 'min', sourceRefs: ['ref-sorting'] });
    expect(found[0]!.snippet).toContain('smaller value');
    // Episode titles are indexed with each block (weighted higher): both blocks of 'Minimum' match, the one that says it ranks first.
    expect((await passages(own.id, w, 'minim')).map(p => p.passageId)).toEqual(['block:min-text', 'block:min-more']);
    expect((await passages(own.id, w, 'member')).map(p => p.passageId)).toEqual(['block:max-text', 'block:min-text']);
    expect((await passages(own.id, w, 'selection')).map(p => p.passageId)).toEqual(['source:ref-sorting']);
    expect(JSON.stringify(await passages(own.id, w, 'foreign_release_canary minimum'))).not.toContain('FOREIGN');
    expect(await passages(foreign.id, w, 'minimum')).toEqual([]);
    expect(await passages(own.id, w, "'; DROP TABLE course_releases; --")).toEqual([]);
    expect(await passages(own.id, w, ':* & |')).toEqual([]);
  });
  it('follow a draft whose bundle is replaced', async () => {
    const w = await workspace(), draft = await release(w, course(), 'draft');
    expect(await passages(draft.id, w, 'ties')).toHaveLength(1);
    const replaced = compileCourse(course('Revised wording about stable ordering.'));
    await db.query('UPDATE course_releases SET server_bundle=$2 WHERE id=$1', [draft.id, JSON.stringify(replaced.server)]);
    expect(await passages(draft.id, w, 'ties')).toEqual([]);
    expect((await passages(draft.id, w, 'stable')).map(p => p.passageId)).toEqual(['block:min-more']);
  });
  it('return at most five bounded snippets', async () => {
    const w = await workspace(), manifest = course();
    for (let i = 0; i < 9; i++) manifest.chapters[0]!.episodes[1]!.blocks.push({ id: `bulk-${i}`, type: 'text', markdown: `Bulk comparison note ${i}. ${'filler '.repeat(400)}` });
    const r = await release(w, manifest);
    const found = await passages(r.id, w, 'bulk');
    expect(found).toHaveLength(5);
    expect(found.every(p => p.snippet.length <= 400)).toBe(true);
  });
});

describe('learner questions', () => {
  it('match only this enrollment\'s own, current, unexcluded learner questions', async () => {
    const w = await workspace(), r = await release(w), other = await release(w);
    const a = await enroll(w, r.id), sameUserOther = await enroll(w, other.id, a.userId), peer = await enroll(w, r.id);
    const own = await ask(w, a.enrollmentId, a.userId, r.digest, 'Why does the running minimum keep the first tie?');
    await ask(w, a.enrollmentId, a.userId, r.digest, 'ASSISTANT_CANARY running minimum answer', 'assistant');
    await ask(w, a.enrollmentId, a.userId, 'f'.repeat(64), 'OLD_VERSION_CANARY running minimum');
    await ask(w, sameUserOther.enrollmentId, a.userId, other.digest, 'OTHER_ENROLLMENT_CANARY running minimum');
    await ask(w, peer.enrollmentId, peer.userId, r.digest, 'PEER_CANARY running minimum');
    const excluded = await ask(w, a.enrollmentId, a.userId, r.digest, 'EXCLUDED_CANARY running minimum');
    await db.query('INSERT INTO companion_context_exclusions(id,enrollment_id,workspace_id,message_id,event_id) VALUES ($1,$2,$3,$4,$5)',
      [randomUUID(), a.enrollmentId, w, excluded.messageId, excluded.eventId]);
    const deleted = await ask(w, a.enrollmentId, a.userId, r.digest, 'running minimum soon deleted');
    await db.query("UPDATE companion_messages SET content='[deleted]' WHERE id=$1", [deleted.messageId]);
    const found = await questions(a.enrollmentId, w, r.digest, 'running minimum');
    expect(found).toEqual([expect.objectContaining({ messageId: own.messageId, eventId: own.eventId, episodeId: 'min' })]);
    expect(found[0]!.snippet).toContain('running minimum');
    for (const canary of ['ASSISTANT', 'OLD_VERSION', 'OTHER_ENROLLMENT', 'PEER', 'EXCLUDED']) expect(JSON.stringify(found)).not.toContain(canary);
    // The workspace must match the enrollment; erasure ends retrieval.
    expect(await questions(a.enrollmentId, await workspace(), r.digest, 'running minimum')).toEqual([]);
    await db.query("UPDATE companion_messages SET content='[erased]' WHERE enrollment_id=$1", [a.enrollmentId]);
    expect(await questions(a.enrollmentId, w, r.digest, 'running minimum')).toEqual([]);
  });
  it('use the full-text index', async () => {
    const plan = (await db.query(`EXPLAIN (FORMAT JSON) SELECT id FROM companion_messages WHERE role='learner' AND search @@ to_tsquery('simple','minimum:*')`)).rows[0]['QUERY PLAN'];
    await db.query('SET enable_seqscan=off');
    const forced = JSON.stringify((await db.query(`EXPLAIN (FORMAT JSON) SELECT id FROM companion_messages WHERE role='learner' AND search @@ to_tsquery('simple','minimum:*')`)).rows[0]['QUERY PLAN']);
    await db.query('RESET enable_seqscan');
    expect(plan).toBeDefined();
    expect(forced).toContain('companion_messages_search');
  });
});
