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
import { svgRenderer } from '../../../services/api/dist/svg-renderer.js';
import { reviewedRubricEvaluator } from '../../../services/api/dist/rubric-evaluator.js';
import { declarativeActivityRuntime } from '../../../services/api/dist/activity-runtime.js';
import { codeEvaluator } from '../../../services/api/dist/code-evaluator.js';
import { DockerSandbox, QUALIFIED_IMAGES } from '../../../packages/sandbox/dist/index.js';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { runProtocolScenario } from './protocol-scenario.mjs';
import { directory, loadPacks, codeFixtureFiles, assertNoBank } from './lib.mjs';
import { code as codeAnswers } from './reference-answers.mjs';

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
/** Private packs (`--private-pack <manifest.json>`, `--code-fixtures <registry.json>`) are read from
 * the operator's own disk and never committed or fetched by public CI. They get a publish, enroll and
 * no-leak check on the same unchanged host; their item-by-item acceptance stays with their owner. */
export async function localProof({ startDocker = false, privatePacks = [], privateFixtures = [] } = {}) {
  assert(!process.env.DATABASE_URL, 'Do not run this disposable proof with DATABASE_URL set');
  const schema = `course_examples_${randomUUID().replaceAll('-', '')}`;
  let containerId, admin, db, app, schemaCreated = false, storage;
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
    // The host composition an operator gets from the API's own entry point (services/api/src/main.ts):
    // the SVG renderer, the reviewed-rubric protocol and the declarative activity runtime, plus each
    // pack's data-only code fixture registry, as CODE_FIXTURE_FILES installs it. No Core code changes.
    const packs = await loadPacks(), fixtureFiles = [...(await Promise.all(packs.map(codeFixtureFiles))).flat(), ...privateFixtures];
    const installedExtensions = [await svgRenderer(), reviewedRubricEvaluator(), declarativeActivityRuntime()];
    if (fixtureFiles.length) {
      const image = process.env.COURSE_SANDBOX_IMAGE ?? QUALIFIED_IMAGES[process.arch];
      assert(image, 'Code tasks need the qualified sandbox image for this platform (npm run sandbox:pull)');
      // Docker Desktop cannot clean up bind mounts under the macOS temporary folder; keep them in the checkout.
      await mkdir(path.join(directory, '.local'), { recursive: true, mode: 0o700 });
      storage = await mkdtemp(path.join(directory, '.local', 'sandbox-'));
      const sandbox = new DockerSandbox({ image, storageDirectory: storage });
      assert.equal((await sandbox.readiness()).ready, true, 'Code tasks need Docker and the qualified sandbox image (npm run sandbox:pull); this gate never skips them');
      for (const file of fixtureFiles) installedExtensions.push(await codeEvaluator(await readFile(file), sandbox));
    }
    app = await createServer(db, { loginCodes: true, origin, secureCookies: false, installedExtensions });
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
    const reviewer = await login('instructor', 'Example reviewer');
    const report = await runProtocolScenario({ baseUrl: origin, origin, workspaceId, owner, learner, otherLearner, reviewer, packs });
    const privateReports = [];
    for (const file of privatePacks) privateReports.push(await privatePackSmoke(JSON.parse(await readFile(file, 'utf8')), { origin, workspaceId, owner, learner: await login('learner', 'Private pack learner') }));
    // The scenario submits only the code tasks it is issued. Every task's reference program must
    // pass all of its hidden cases in the real sandbox, and its known-wrong program must not.
    const codeTasks = [];
    for (const item of packs.flatMap(course => course.assessments).filter(item => item.type === 'code')) {
      const evaluator = installedExtensions.find(row => row.id === item.grading.evaluatorId);
      const right = await evaluator.evaluateCode(item, codeAnswers[item.id].correct), wrong = await evaluator.evaluateCode(item, codeAnswers[item.id].wrong);
      assert(right.passed && right.execution.passedCases === right.execution.totalCases, `${item.id}: the reference program failed a hidden case`);
      assert(!wrong.passed && wrong.execution.status === 'graded', `${item.id}: the known-wrong program was not rejected`);
      codeTasks.push(item.id);
    }
    return { ...report, persistence: 'real-postgresql-17', host: 'isolated-loopback-api', providerServicesStarted: false,
      installedExtensions: installedExtensions.map(row => `${row.id}@${row.version}`), codeExecution: fixtureFiles.length ? 'real-docker-sandbox' : 'none', codeTasksCheckedBothWays: codeTasks,
      ...(privateReports.length ? { privatePacks: privateReports } : {}) };
  } finally {
    // Remove only the exact resources created above; never stop an existing service.
    try { await app?.close(); }
    finally {
      try { await db?.end(); }
      finally {
        try { if (schemaCreated) await admin.query(`DROP SCHEMA ${schema} CASCADE`); }
        finally {
          try { await admin?.end(); }
          finally {
            try { if (containerId) await docker(['rm', '--force', '--volumes', containerId]); }
            finally { if (storage) await rm(storage, { recursive: true, force: true }); }
          }
        }
      }
    }
  }
}
/** Import, publish and enroll in a private pack on the same host, and check the learner view holds
 * no grading data or unissued prompts. Reports only IDs and counts, never course content. */
async function privatePackSmoke(course, { origin, workspaceId, owner, learner }) {
  const send = (who, method, pathname, body) => fetch(new URL(pathname, origin), { method, redirect: 'error',
    headers: { origin, cookie: who.cookie, 'x-csrf-token': who.csrf, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
    .then(async response => { const data = await response.json(); assert.equal(response.status, 200, `Private pack ${course.id}: ${pathname} answered ${response.status} ${data.error ?? ''}`); return data; });
  const release = await send(owner, 'POST', `/api/workspaces/${workspaceId}/releases`, course);
  await send(owner, 'POST', `/api/releases/${release.id}/publish`);
  const enrollment = await send(learner, 'POST', '/api/enrollments', { releaseId: release.id });
  assertNoBank(await send(learner, 'GET', `/api/enrollments/${enrollment.id}`), course);
  return { courseId: course.id, version: course.version, published: true, enrolled: true, noAnswerBankLeak: true };
}
function parseArguments(args) {
  const options = { startDocker: false, privatePacks: [], privateFixtures: [] };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--docker') options.startDocker = true;
    else if (args[i] === '--private-pack' && args[i + 1]) options.privatePacks.push(path.resolve(args[++i]));
    else if (args[i] === '--code-fixtures' && args[i + 1]) options.privateFixtures.push(path.resolve(args[++i]));
    else throw new Error('Use: [--docker] [--private-pack <manifest.json>]... [--code-fixtures <registry.json>]...');
  }
  // Private material stays outside this public repository.
  for (const file of [...options.privatePacks, ...options.privateFixtures]) assert(!file.startsWith(path.resolve(directory, '../..') + path.sep), 'Keep private packs outside the public repository');
  return options;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  Promise.resolve().then(() => localProof(parseArguments(process.argv.slice(2)))).then(report => console.log(JSON.stringify(report, null, 2)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
