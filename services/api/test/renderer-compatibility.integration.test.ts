import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { compileCourse } from '@course-core/sdk/compiler';
import { fromVisualExperience, SUPPORTED_FEATURES, toVisualExperience, VisualRuntime } from '@course-core/visuals/headless';
import { motionStudyDemo, primitivesDemo } from '@course-core/visuals/demos';
import { createDatabase, type Database } from '../src/database.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';
import { createServer } from '../src/server.js';
import { issueLoginCode } from '../src/auth.js';
import { svgRenderer } from '../src/svg-renderer.js';
import type { RuntimeExtension } from '../src/publication.js';
import { fixture } from './fixture.js';
import { visualContextFixture } from '../../../apps/learner/tests/visualContext.fixture.js';

// Courses built against the visuals build shipped with Core v0.1.3 through v0.1.25 declare this.
const PRIOR = { version: '0.1.0', integrity: 'sha256-e16ff7d93b320f12913f1c3bc5a7246c16d1ca09cc4cf8f1ba8a29d2cde2aa24' };
const FORGED = { version: '0.1.0', integrity: `sha256-${'f'.repeat(64)}` };
// 0.1.1 as courses declare it: its fingerprint, and its package identity (packages/visuals/released-digests.json).
const V011 = { version: '0.1.1', integrity: 'sha256-d64441db68463ba2c62d36d04fc9c60a3378b4a2f783d5f156238b6aa6e2dcd6' };
const EXECUTED = { version: '0.1.1', integrity: 'sha256-b1ff5f870feed056129e627dc69c35bac7db725384979f188bf420a67a4416b8' };
// 0.2.0 and 0.3.0 as courses declare them, and the installed 0.4.0 build's package identity.
const record = JSON.parse(await readFile(new URL('../../../packages/visuals/released-digests.json', import.meta.url), 'utf8')) as { versions: Record<string, { integrity: string; identity: string }> };
const V020 = { version: '0.2.0', integrity: record.versions['0.2.0']!.integrity };
const V020_IDENTITY = { version: '0.2.0', integrity: record.versions['0.2.0']!.identity };
const V030 = { version: '0.3.0', integrity: record.versions['0.3.0']!.integrity };
const V030_IDENTITY = { version: '0.3.0', integrity: record.versions['0.3.0']!.identity };
const IDENTITY = { version: '0.4.0', integrity: record.versions['0.4.0']!.identity };
const V01_FEATURES = ['gradient', 'path_draw'], V02_FEATURES = ['clip', 'equation', 'gradient', 'mask', 'path_draw', 'symbol'];
const V03_FEATURES = ['clip', 'equation', 'gradient', 'layout_set', 'mask', 'panes', 'path_draw', 'spring', 'stagger', 'symbol'];

const origin = 'http://localhost:4310', schema = `course_renderer_${randomUUID().replaceAll('-', '')}`;
let db: Database, app: Awaited<ReturnType<typeof createServer>>, renderer: RuntimeExtension, workspaceId: string, owner: string;
interface Session { headers: Record<string, string> }
const visual = visualContextFixture(), runtime = new VisualRuntime(fromVisualExperience(visual));
const frame = { schemaVersion: 1, sceneVersion: 1, episodeId: 'min', blockId: 'diagram-one', visualId: visual.id, rendererId: visual.rendererId,
  sceneFingerprint: runtime.exportReplay().sceneFingerprint, state: { amount: 4, enabled: true, mode: 'square' }, timeMs: 500, layout: 'compact', reducedMotion: false };

type Visual = typeof visual;
function course(id: string, declared: { version: string; integrity: string }, shown: Visual = visual) {
  const source = fixture();
  source.id = id;
  source.visuals.push(shown);
  source.chapters[0]!.episodes[0]!.blocks.push({ id: 'diagram-one', type: 'visual', visualId: shown.id });
  source.extensions.push({ id: 'course-core-svg-v1', version: declared.version, integrity: declared.integrity, execution: 'declarative', entrypoint: 'renderers/svg-v1.js', platforms: ['web'], capabilities: ['visual.render'], accessibility: { keyboard: true, reducedMotion: true, textAlternative: visual.accessibility.description } });
  return source;
}
async function session(role: string): Promise<Session> {
  const user = randomUUID();
  await db.query('INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)', [user, `renderer:${user}`, `Test ${role}`]);
  await db.query('INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)', [workspaceId, user, role]);
  const login = await app.inject({ method: 'POST', url: '/auth/redeem', headers: { origin }, payload: { token: await issueLoginCode(db, user) } });
  expect(login.statusCode, login.body).toBe(200);
  return { headers: { origin, cookie: login.cookies.map(c => `${c.name}=${c.value}`).join('; '), 'x-csrf-token': login.json().csrfToken } };
}
async function importAndPublish(admin: Session, declared: { version: string; integrity: string }, shown?: Visual) {
  const imported = await app.inject({ method: 'POST', url: `/api/workspaces/${workspaceId}/releases`, headers: admin.headers, payload: course(`renderer-${randomUUID().slice(0, 8)}`, declared, shown) });
  expect(imported.statusCode, imported.body).toBe(200);
  const releaseId = imported.json().id as string;
  return { releaseId, publish: await app.inject({ method: 'POST', url: `/api/releases/${releaseId}/publish`, headers: admin.headers }) };
}
/** A release published by an earlier Core and pinned, as on a deployed pilot. */
async function pinnedRelease(declared: { version: string; integrity: string }) {
  const source = course(`pinned-${randomUUID().slice(0, 8)}`, declared), compiled = compileCourse(source), releaseId = randomUUID();
  await db.query("INSERT INTO course_releases(id,workspace_id,course_key,version,digest,server_bundle,learner_bundle,status,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,'published',$8)",
    [releaseId, workspaceId, source.id, source.version, compiled.digest, JSON.stringify(compiled.server), JSON.stringify(compiled.learner), owner]);
  return releaseId;
}
async function companion(learner: Session, releaseId: string) {
  const enrolled = await app.inject({ method: 'POST', url: '/api/enrollments', headers: learner.headers, payload: { releaseId } });
  expect(enrolled.statusCode, enrolled.body).toBe(200);
  const id = enrolled.json().id as string;
  const revision = Number((await db.query('SELECT revision FROM enrollments WHERE id=$1', [id])).rows[0].revision);
  const response = await app.inject({ method: 'POST', url: `/api/enrollments/${id}/companion`, headers: learner.headers,
    payload: { expectedRevision: revision, idempotencyKey: randomUUID(), episodeId: 'min', blockId: 'diagram-one', content: 'Why does this result change?', interactiveContext: frame } });
  return { id, response };
}

let testDatabase: TestDatabase | undefined;
beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  renderer = await svgRenderer();
  app = await createServer(db, { loginCodes: true, origin, secureCookies: false, installedExtensions: [renderer] });
  workspaceId = randomUUID(); owner = randomUUID();
  await db.query('INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)', [owner, `renderer:${owner}`, 'Test author']);
  await db.query('INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)', [workspaceId, 'renderer', 'Renderer compatibility']);
}, 30000);
afterAll(async () => { await app?.close(); await db?.end(); await testDatabase?.drop(); });

it('the new Core renderer is a new visuals version with a new integrity', () => {
  expect(renderer.version).toBe('0.4.0');
  expect(renderer.integrity).not.toBe(PRIOR.integrity);
  expect(renderer.acceptedPriorBuilds).toEqual([PRIOR, V011, EXECUTED, V020, V020_IDENTITY, V030, V030_IDENTITY, IDENTITY]);
});

it('the runtime extension listing exposes the accepted prior build, marked as such', async () => {
  expect((await app.inject({ url: '/api/runtime/extensions', headers: { origin } })).statusCode).toBe(401);
  const listed = await app.inject({ url: '/api/runtime/extensions', headers: (await session('author')).headers });
  expect(listed.statusCode, listed.body).toBe(200);
  const svg = (listed.json().extensions as Record<string, unknown>[]).filter(e => e.id === 'course-core-svg-v1');
  const prior = (build: { version: string; integrity: string }, renderFeatures: readonly string[]) =>
    ({ id: 'course-core-svg-v1', ...build, capabilities: ['visual.render'], platforms: ['web'], codeReady: null, acceptedPriorBuild: true, installedVersion: renderer.version, renderFeatures });
  expect(svg).toEqual([
    { id: 'course-core-svg-v1', version: renderer.version, integrity: renderer.integrity, capabilities: ['visual.render'], platforms: ['web'], codeReady: null, acceptedPriorBuild: false, renderFeatures: SUPPORTED_FEATURES },
    prior(PRIOR, V01_FEATURES), prior(V011, V01_FEATURES), prior(EXECUTED, V01_FEATURES),
    prior(V020, V02_FEATURES), prior(V020_IDENTITY, V02_FEATURES), prior(V030, V03_FEATURES), prior(V030_IDENTITY, V03_FEATURES),
    prior(IDENTITY, SUPPORTED_FEATURES),
  ]);
  // Exactly the builds publication accepts: nothing else is advertised.
  expect(svg.map(e => `${e.version}/${e.integrity}`)).not.toContain(`${FORGED.version}/${FORGED.integrity}`);
});

it('a course declaring the old 0.1.0 build still publishes and gets interactive context', async () => {
  const admin = await session('admin'), learner = await session('learner');
  const { releaseId, publish } = await importAndPublish(admin, PRIOR);
  expect(publish.statusCode, publish.body).toBe(200);
  const { response } = await companion(learner, releaseId);
  expect(response.statusCode, response.body).toBe(200);
  const stored = (await db.query('SELECT context FROM companion_messages WHERE id=$1', [response.json().messageId])).rows[0].context;
  expect(stored.interactiveContext).toMatchObject({ authority: 'context-only', renderer: { id: 'course-core-svg-v1', version: renderer.version, integrity: renderer.integrity } });
  expect(stored.interactiveContext.readout.join(' ')).toContain('16');
});

it('an already published, pinned 0.1.0 release keeps interactive context', async () => {
  const learner = await session('learner');
  const { response } = await companion(learner, await pinnedRelease(PRIOR));
  expect(response.statusCode, response.body).toBe(200);
});

it('a course declaring the new 0.4.0 build publishes', async () => {
  const { publish } = await importAndPublish(await session('admin'), { version: renderer.version, integrity: renderer.integrity });
  expect(publish.statusCode, publish.body).toBe(200);
});

it('a course declaring the 0.1.1 package identity publishes and gets interactive context from the 0.4.0 renderer', async () => {
  const admin = await session('admin'), learner = await session('learner');
  const { releaseId, publish } = await importAndPublish(admin, EXECUTED);
  expect(publish.statusCode, publish.body).toBe(200);
  const { response } = await companion(learner, releaseId);
  expect(response.statusCode, response.body).toBe(200);
  const stored = (await db.query('SELECT context FROM companion_messages WHERE id=$1', [response.json().messageId])).rows[0].context;
  expect(stored.interactiveContext).toMatchObject({ renderer: { id: 'course-core-svg-v1', version: renderer.version, integrity: renderer.integrity } });
});

it('a forged integrity cannot publish and a pinned forged release gets no interactive context', async () => {
  const admin = await session('admin'), learner = await session('learner');
  for (const declared of [FORGED, { version: PRIOR.version, integrity: renderer.integrity }, { version: renderer.version, integrity: PRIOR.integrity },
    { version: PRIOR.version, integrity: EXECUTED.integrity }]) {
    const { releaseId, publish } = await importAndPublish(admin, declared);
    expect(publish.statusCode, publish.body).toBe(409);
    expect(publish.json()).toMatchObject({ error: 'PUBLISH_CAPABILITY_MISSING' });
    expect((await db.query('SELECT status FROM course_releases WHERE id=$1', [releaseId])).rows[0].status).toBe('draft');
  }
  const { id, response } = await companion(learner, await pinnedRelease(FORGED));
  expect(response.statusCode, response.body).toBe(409);
  expect(response.json()).toMatchObject({ error: 'INTERACTIVE_RENDERER_UNAVAILABLE' });
  expect((await db.query('SELECT count(*) FROM companion_messages WHERE enrollment_id=$1', [id])).rows[0].count).toBe('0');
});

it('publication refuses a 0.2 primitive under a 0.1.1 declaration and accepts it under 0.2.0', async () => {
  const admin = await session('admin'), primitives = toVisualExperience(primitivesDemo) as unknown as Visual;
  for (const declared of [V011, EXECUTED, PRIOR]) {
    const { releaseId, publish } = await importAndPublish(admin, declared, primitives);
    expect(publish.statusCode, publish.body).toBe(409);
    expect(publish.json()).toMatchObject({ error: 'PUBLISH_RENDER_FEATURE_UNSUPPORTED', details: { visualId: 'primitives', declaredVersion: declared.version, missingFeatures: ['clip', 'equation', 'mask', 'symbol'] } });
    expect((await db.query('SELECT status FROM course_releases WHERE id=$1', [releaseId])).rows[0].status).toBe('draft');
  }
  for (const declared of [{ version: renderer.version, integrity: renderer.integrity }, IDENTITY]) {
    const { publish } = await importAndPublish(admin, declared, primitives);
    expect(publish.statusCode, publish.body).toBe(200);
  }
});

/** The motion study without its 0.4 publish-time checks. */
function motionWithoutChecks() {
  const scene = structuredClone(motionStudyDemo) as unknown as Record<string, unknown>;
  delete scene.invariants;
  delete scene.goldens;
  return scene;
}
it('publication refuses 0.3 motion features under a 0.2.0 declaration and accepts them under 0.3.0', async () => {
  const admin = await session('admin'), motion = toVisualExperience(motionWithoutChecks()) as unknown as Visual;
  for (const declared of [V020, V020_IDENTITY]) {
    const { releaseId, publish } = await importAndPublish(admin, declared, motion);
    expect(publish.statusCode, publish.body).toBe(409);
    expect(publish.json()).toMatchObject({ error: 'PUBLISH_RENDER_FEATURE_UNSUPPORTED', details: { visualId: 'running-max', missingFeatures: ['layout_set', 'panes', 'spring', 'stagger'] } });
    expect((await db.query('SELECT status FROM course_releases WHERE id=$1', [releaseId])).rows[0].status).toBe('draft');
  }
  // 0.2.0 declarations keep publishing 0.2 primitives.
  expect((await importAndPublish(admin, V020, toVisualExperience(primitivesDemo) as unknown as Visual)).publish.statusCode).toBe(200);
  for (const declared of [V030, { version: renderer.version, integrity: renderer.integrity }, IDENTITY]) {
    const { publish } = await importAndPublish(admin, declared, motion);
    expect(publish.statusCode, publish.body).toBe(200);
  }
});

it('publication runs the scene checks: a contradictory or drifted visual is refused and stays draft (S05)', async () => {
  const admin = await session('admin'), current = { version: renderer.version, integrity: renderer.integrity };
  const divergent = structuredClone(motionStudyDemo) as unknown as { panes: { rows: number[][] }[]; goldens?: unknown };
  delete divergent.goldens;
  divergent.panes[1]!.rows[3]![2] = 8;
  const drifted = structuredClone(motionStudyDemo) as unknown as { nodes: { children: { height: number }[] }[] };
  drifted.nodes[1]!.children[0]!.height = 61;
  for (const [scene, error] of [[divergent, 'PUBLISH_VISUAL_INVARIANT_FAILED'], [drifted, 'PUBLISH_VISUAL_GOLDEN_MISMATCH']] as const) {
    const { releaseId, publish } = await importAndPublish(admin, current, toVisualExperience(scene) as unknown as Visual);
    expect(publish.statusCode, publish.body).toBe(409);
    expect(publish.json()).toMatchObject({ error, details: { visualId: 'running-max' } });
    expect((await db.query('SELECT status FROM course_releases WHERE id=$1', [releaseId])).rows[0].status).toBe('draft');
  }
  // The intact scene, checks included, publishes.
  expect((await importAndPublish(admin, current, toVisualExperience(motionStudyDemo) as unknown as Visual)).publish.statusCode).toBe(200);
});
