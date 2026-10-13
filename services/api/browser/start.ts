import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { compileCourse } from '@course-core/sdk/compiler';
import { createDatabase } from '../src/database.js';
import { migrate } from '../src/migrations.js';
import { createServer } from '../src/server.js';
import { issueLoginCode } from '../src/auth.js';
import { fixture } from '../test/fixture.js';
import { toVisualExperience } from '@course-core/visuals/headless';
import { sortingDemo } from '@course-core/visuals/demos';
import { svgRenderer } from '../src/svg-renderer.js';
import {recoveryFixture} from '../test/recovery-fixture.js';
import {approveAdaptationRegistry} from '../src/adaptation-store.js';

// Test-only loopback host. Not included in the API build or production routes.
if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required for real browser/database acceptance.');
const schema = `course_browser_${randomUUID().replaceAll('-', '')}`;
const admin = createDatabase(process.env.TEST_DATABASE_URL);
await admin.query(`CREATE SCHEMA ${schema}`);
const url = new URL(process.env.TEST_DATABASE_URL); url.searchParams.set('options', `-csearch_path=${schema}`);
const db = createDatabase(url.toString());
await migrate(db, fileURLToPath(new URL('../migrations', import.meta.url)));
const renderer = await svgRenderer(),recovery=recoveryFixture();
const app = await createServer(db, { origin: 'http://127.0.0.1:4317', secureCookies: false, learnerDirectory: fileURLToPath(new URL('../../../apps/learner/dist', import.meta.url)), installedExtensions: [renderer],adaptation:recovery.runtime });
const source = recovery.course, visual = toVisualExperience(sortingDemo);
source.extensions.push({ id: renderer.id, version: renderer.version, integrity: renderer.integrity, execution: 'declarative', entrypoint: 'renderers/svg-v1.js', platforms: ['web'], capabilities: ['visual.render'], accessibility: { keyboard: true, reducedMotion: true, textAlternative: visual.accessibility.description } });
source.visuals.push(visual);
source.chapters[0]!.episodes[1]!.blocks.unshift({ id: 'max-visual', type: 'visual', visualId: visual.id });
const workspaceId = randomUUID(), ownerId = randomUUID(), releaseId = randomUUID(), course = compileCourse(source);
await db.query('INSERT INTO app_users (id,subject,display_name) VALUES ($1,$2,$3)', [ownerId, 'test:owner', 'Test owner']);
await db.query('INSERT INTO workspaces (id,slug,title) VALUES ($1,$2,$3)', [workspaceId, 'browser', 'Browser acceptance']);
await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'owner')",[workspaceId,ownerId]);
await db.query("INSERT INTO course_releases (id,workspace_id,course_key,version,digest,server_bundle,learner_bundle,status,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,'published',$8)", [releaseId, workspaceId, course.server.id, course.server.version, course.digest, JSON.stringify(course.server), JSON.stringify(course.learner), ownerId]);
await approveAdaptationRegistry(db,{id:ownerId,displayName:'Test owner'},{releaseId,expectedRegistryRevision:0,configuration:recovery.config},recovery.runtime);
app.post('/test/session', async () => {
  const userId = randomUUID();
  await db.query('INSERT INTO app_users (id,subject,display_name) VALUES ($1,$2,$3)', [userId, `test:${userId}`, 'Browser learner']);
  await db.query("INSERT INTO memberships (workspace_id,user_id,role) VALUES ($1,$2,'learner')", [workspaceId, userId]);
  return { token: await issueLoginCode(db, userId) };
});
app.addHook('onClose', async () => {
  await db.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
});
await app.listen({ host: '127.0.0.1', port: 4317 });
process.on('SIGINT', () => { void app.close(); }); process.on('SIGTERM', () => { void app.close(); });
