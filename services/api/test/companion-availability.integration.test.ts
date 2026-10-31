import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { compileCourse } from '@course-core/sdk/compiler';
import type { ProviderAdapter } from '@course-core/providers';
import { createDatabase, type Database } from '../src/database.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';
import { createServer } from '../src/server.js';
import { issueLoginCode } from '../src/auth.js';
import { composeProviders } from '../src/provider-composition.js';
import { allowUnpricedPaidWork } from './cost-fixture.js';
import { fixture } from './fixture.js';

// What the learner app shows as the companion's state comes from here: ready only when a companion
// job can actually run (a supervisor bridge for the workspace, a bound and configured companion
// model, and a price or the workspace's consent to unpriced work).
const origin = 'http://localhost:4310', schema = `course_companion_availability_${randomUUID().replaceAll('-', '')}`;
let db: Database, testDatabase: TestDatabase | undefined;
const apps: Awaited<ReturnType<typeof createServer>>[] = [];
let workspaceId: string, releaseId: string;
// Never called: availability reads configuration only.
const adapter: ProviderAdapter = { providerId: 'availability-provider', validateModel: () => {}, ports: {
  tutoring: { async tutor() { throw new Error('not called'); }, async tutorStream() { throw new Error('not called'); } } } };
const tutor = () => composeProviders({ registry: { revision: 'availability-registry', models: [
  { id: 'tutor', providerId: 'availability-provider', remoteModel: 'availability/tutor', providerConfig: {}, enabled: true, capabilities: ['tutoring'], tools: [],
    limits: { maxInputCharacters: 20000, maxOutputTokens: 1000 } }] },
  adapters: [{ id: 'availability-provider', kind: 'test', credentialEnv: 'COURSE_PROVIDER_TEST_API_KEY' }],
  roles: { companion: { modelId: 'tutor', maxInputCharacters: 12000, maxOutputTokens: 1000 } } },
  () => 'fake-key-only-in-test', { test: () => adapter });
beforeAll(async () => {
  testDatabase = await createTestDatabase(schema);
  db = createDatabase(testDatabase.url);
  const compiled = compileCourse(fixture()), owner = randomUUID();
  workspaceId = randomUUID(); releaseId = randomUUID();
  await db.query('INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)', [owner, `availability:${owner}`, 'Author']);
  await db.query('INSERT INTO workspaces(id,slug,title) VALUES($1,$2,$3)', [workspaceId, `availability-${workspaceId}`, 'Availability tests']);
  await db.query("INSERT INTO course_releases(id,workspace_id,course_key,version,digest,server_bundle,learner_bundle,status,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,'published',$8)",
    [releaseId, workspaceId, compiled.server.id, compiled.server.version, compiled.digest, JSON.stringify(compiled.server), JSON.stringify(compiled.learner), owner]);
}, 30_000);
afterAll(async () => { for (const app of apps) await app.close(); await db?.end(); await testDatabase?.drop(); });

async function availability(options: Omit<Parameters<typeof createServer>[1], 'origin' | 'loginCodes' | 'secureCookies'>) {
  const app = await createServer(db, { loginCodes: true, origin, secureCookies: false, ...options });
  apps.push(app);
  const user = randomUUID();
  await db.query('INSERT INTO app_users(id,subject,display_name) VALUES($1,$2,$3)', [user, `availability:${user}`, 'Learner']);
  await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'learner')", [workspaceId, user]);
  const login = await app.inject({ method: 'POST', url: '/auth/redeem', headers: { origin }, payload: { token: await issueLoginCode(db, user) } });
  const headers = { origin, cookie: login.cookies.map(c => `${c.name}=${c.value}`).join('; '), 'x-csrf-token': login.json().csrfToken };
  const id = (await app.inject({ method: 'POST', url: '/api/enrollments', headers, payload: { releaseId } })).json().id as string;
  const read = async (enrollmentId = id, as = headers) => app.inject({ method: 'GET', url: `/api/enrollments/${enrollmentId}/companion/availability`, headers: as });
  return { read, id, headers };
}

it('reports the companion ready only when a companion job can run, and to the enrolled learner only', async () => {
  const bridge = { serviceToken: randomUUID(), workspaceIds: [workspaceId] };
  // No supervisor bridge: nothing would ever answer, whatever the providers.
  expect((await (await availability({ providers: tutor() })).read()).json()).toEqual({ status: 'not_set_up' });
  // A bridge but no companion binding.
  expect((await (await availability({ supervisor: bridge })).read()).json()).toEqual({ status: 'not_set_up' });
  // A bridge for another workspace only.
  expect((await (await availability({ supervisor: { ...bridge, workspaceIds: [randomUUID()] }, providers: tutor() })).read()).json()).toEqual({ status: 'not_set_up' });
  // Bound, but the workspace requires a price for paid work and the model has none: the worker would wait.
  const unpriced = await availability({ supervisor: bridge, providers: tutor() });
  expect((await unpriced.read()).json()).toEqual({ status: 'not_set_up' });
  // The workspace accepts unpriced work: a companion job runs.
  await allowUnpricedPaidWork(db, workspaceId);
  expect((await unpriced.read()).json()).toEqual({ status: 'ready' });
  // Another learner cannot read this enrollment's availability.
  const other = await availability({ supervisor: bridge, providers: tutor() });
  expect((await unpriced.read(other.id)).statusCode).toBe(404);
  expect((await other.read(unpriced.id, other.headers)).statusCode).toBe(404);
  expect((await other.read()).json()).toEqual({ status: 'ready' });
});
