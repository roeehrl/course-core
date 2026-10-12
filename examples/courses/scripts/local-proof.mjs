import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer as reserveSocket } from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createDatabase } from '../../../services/api/dist/database.js';
import { migrate } from '../../../services/api/dist/migrations.js';
import { createServer } from '../../../services/api/dist/server.js';
import { issueLoginCode } from '../../../services/api/dist/auth.js';
import { runProtocolScenario } from './protocol-scenario.mjs';

const exec = promisify(execFile);
async function docker(args) {
  const result = await exec('docker', args, { timeout: 15000, maxBuffer: 262144 });
  return result.stdout.trim();
}
async function freePort() {
  const server = reserveSocket();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
function testDatabase(raw) {
  assert(raw, 'Provide an explicit disposable TEST_DATABASE_URL, or pass --docker');
  const url = new URL(raw);
  assert(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  assert(/^\/course_core_(?:ci|test(?:_[a-z0-9_]+)?)$/.test(url.pathname));
  assert(!url.search && !url.hash && ['postgres:', 'postgresql:'].includes(url.protocol));
  return url;
}
export async function localProof({ startDocker = false } = {}) {
  assert(!process.env.DATABASE_URL, 'Do not run this disposable proof with DATABASE_URL set');
  const schema = `course_examples_${randomUUID().replaceAll('-', '')}`;
  let containerId, admin, db, app, schemaCreated = false;
  try {
    let url;
    if (startDocker) {
      // Uses only an already-present public PostgreSQL image; never pulls or touches an existing container.
      await docker(['image', 'inspect', 'postgres:17']);
      const name = `course-examples-${randomUUID()}`;
      containerId = await docker(['create', '--pull=never', '--name', name, '--label', 'course-core.example-proof=true',
        '--memory=384m', '--cpus=1', '--tmpfs=/var/lib/postgresql/data:rw,size=256m', '-e', 'POSTGRES_USER=course_ci', '-e', 'POSTGRES_PASSWORD=course_ci_test_only',
        '-e', 'POSTGRES_DB=course_core_test', '-p', '127.0.0.1::5432', 'postgres:17']);
      assert(/^[a-f0-9]{64}$/.test(containerId));
      await docker(['start', containerId]);
      const mapping = await docker(['port', containerId, '5432/tcp']);
      const match = /^127\.0\.0\.1:(\d+)$/.exec(mapping); assert(match);
      url = new URL('postgres://127.0.0.1/course_core_test');
      url.port = match[1];
      url.username = 'course_ci'; url.password = 'course_ci_test_only';
      let ready = false;
      for (let attempt = 0; attempt < 40; attempt++) {
        try { await docker(['exec', containerId, 'pg_isready', '-h', '127.0.0.1', '-U', 'course_ci', '-d', 'course_core_test']); ready = true; break; }
        catch { await delay(250); }
      }
      assert(ready, 'Owned PostgreSQL container did not become ready');
    } else url = testDatabase(process.env.TEST_DATABASE_URL);
    url = testDatabase(url.href);
    admin = createDatabase(url.href);
    const version = Number((await admin.query("SELECT current_setting('server_version_num') AS version")).rows[0].version);
    assert(version >= 170000 && version < 180000, 'PostgreSQL 17 is required for this proof');
    await admin.query(`CREATE SCHEMA ${schema}`); schemaCreated = true;
    const scoped = new URL(url); scoped.searchParams.set('options', `-csearch_path=${schema}`);
    db = createDatabase(scoped.href);
    await migrate(db, fileURLToPath(new URL('../../../services/api/migrations/', import.meta.url)));
    const port = await freePort(), origin = `http://127.0.0.1:${port}`;
    app = await createServer(db, { origin, secureCookies: false });
    await app.listen({ host: '127.0.0.1', port });
    const workspaceId = randomUUID();
    await db.query('INSERT INTO workspaces (id,slug,title) VALUES ($1,$2,$3)', [workspaceId, `examples-${randomUUID()}`, 'Everyday learning']);
    async function login(role, label) {
      const id = randomUUID();
      await db.query('INSERT INTO app_users (id,subject,display_name) VALUES ($1,$2,$3)', [id, `examples:${id}`, label]);
      await db.query('INSERT INTO memberships (workspace_id,user_id,role) VALUES ($1,$2,$3)', [workspaceId, id, role]);
      const token = await issueLoginCode(db, id);
      const response = await fetch(`${origin}/auth/redeem`, { method: 'POST', redirect: 'error',
        headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
      assert.equal(response.status, 200);
      const data = await response.json();
      return { cookie: response.headers.getSetCookie().map(value => value.split(';')[0]).join('; '), csrf: data.csrfToken };
    }
    const owner = await login('owner', 'Example owner');
    const learner = await login('learner', 'Example learner');
    const otherLearner = await login('learner', 'Another learner');
    const report = await runProtocolScenario({ baseUrl: origin, origin, workspaceId, owner, learner, otherLearner });
    return { ...report, persistence: 'real-postgresql-17', host: 'isolated-loopback-api', providerServicesStarted: false };
  } finally {
    // Remove only the exact resources created above; never stop an existing service.
    try { await app?.close(); }
    finally {
      try { await db?.end(); }
      finally {
        try { if (schemaCreated) await admin.query(`DROP SCHEMA ${schema} CASCADE`); }
        finally {
          try { await admin?.end(); }
          finally { if (containerId) await docker(['rm', '--force', '--volumes', containerId]); }
        }
      }
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert(process.argv.slice(2).every(arg => arg === '--docker'), 'Use no arguments, or --docker');
  localProof({ startDocker: process.argv.includes('--docker') }).then(report => console.log(JSON.stringify(report, null, 2)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
