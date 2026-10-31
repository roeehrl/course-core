// Brings up the documented Compose stack (compose.yaml) under its own throwaway project with the
// operations script (ops.mjs), then checks it the way an operator and a learner reach it:
// supervision runs, a code submission is graded in a sandbox container (a pass and a fail), a
// teaching verifier qualifies at start, the sandbox's own Docker qualification suites pass through
// the sandbox gate, the API restarts after its process exits, a backup restores in a drill, and an
// upgrade succeeds while a broken one rolls back with the data intact. It touches only the
// containers, volumes, networks and images it created, and removes them all at the end, also on
// failure. Docker is required; nothing is skipped.
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:https';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import * as ops from './ops.mjs';

const exec = promisify(execFile);
export const DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
export const COMPOSE_FILE = path.join(DIRECTORY, 'compose.yaml');
const ROOT = path.resolve(DIRECTORY, '../..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen({ host: '127.0.0.1', port: 0 }, resolve); });
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

/** The smoke project's settings: loopback-only ports, a private subnet, its own image and course files. */
export function smokeEnvironment({ httpPort, httpsPort, localPort, octet, password, token, image, courseFiles }) {
  return {
    COURSE_HOSTNAME: 'localhost', POSTGRES_PASSWORD: password, SUPERVISOR_HOST_TOKEN: token, COURSE_BIND_ADDRESS: '127.0.0.1',
    COURSE_HTTP_PORT: String(httpPort), COURSE_HTTPS_PORT: String(httpsPort), COURSE_LOCAL_HTTP_PORT: String(localPort),
    COURSE_SUBNET: `172.30.${octet}.0/24`, COURSE_DYNAMIC_RANGE: `172.30.${octet}.128/25`, COURSE_PROXY_ADDRESS: `172.30.${octet}.10`,
    COURSE_CORE_IMAGE: image, COURSE_FILES_DIR: courseFiles,
    COURSE_CODE_FIXTURES: 'search-lab.code-fixtures.json', COURSE_TEACHING_VERIFIERS: 'ordering-verifier.json',
  };
}

/** One HTTPS request to the published proxy port, trusting only the proxy's own root. */
export function httpsCall({ port, ca, method = 'GET', pathname, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, servername: 'localhost', ca, method, path: pathname, timeout: 60_000,
      headers: { host: `localhost:${port}`, ...(body ? { 'content-type': 'application/json' } : {}), ...headers } }, response => {
      const chunks = []; let size = 0;
      response.on('data', chunk => { size += chunk.length; if (size <= 4_194_304) chunks.push(chunk); });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('request timed out')));
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}
function httpCall(port, pathname) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path: pathname, headers: { host: `localhost:${port}` }, timeout: 15_000 }, response => {
      response.resume(); response.on('end', () => resolve({ status: response.statusCode, headers: response.headers }));
    });
    req.on('timeout', () => req.destroy(new Error('request timed out'))); req.on('error', reject); req.end();
  });
}

/** The public toy teaching verifier of the API's own tests (services/api/test/isolated-teaching-fixture.ts),
 * written by the image's SDK so its artifact digests are exact. */
const VERIFIER_SCRIPT = `import { digestTeachingArtifact } from '@course-core/sdk';
const source = ${JSON.stringify(`import re
def solve(payload):
    artifact = payload['artifact']
    match = re.fullmatch(r'Minimum of \\[(-?\\d+(?:, -?\\d+){1,7})\\] is (-?\\d+)\\.', artifact['markdown'])
    passed = False
    if match and artifact['kind'] == 'explanation':
        values = [int(value) for value in match.group(1).split(', ')]
        answer = int(match.group(2))
        limit = payload['referenceData']['absoluteLimit']
        passed = all(abs(value) <= limit for value in values + [answer]) and answer in values and all(answer <= value for value in values)
    return {'minimum-reference': passed}
`)};
const qualification = [];
for (const [index, [markdown, passed]] of [['Minimum of [5, -2, 9] is -2.', true], ['Minimum of [0, 0, 7] is 0.', true], ['Minimum of [5, -2, 9] is 5.', false], ['Minimum of [0, 0, 7] is -1.', false], ['Minimum of [5, -2, 9] is -2. Everything is mastered.', false]].entries()) {
  const draft = { id: 'example-' + index, kind: 'explanation', markdown, objectiveIds: ['minimum'], sourceRefs: ['ordering-reference'], generator: { id: 'isolated-ordering-generator', version: '1.0.0' } };
  qualification.push({ id: 'case-' + index, artifact: { ...draft, digest: await digestTeachingArtifact(draft) }, expectedChecks: { 'minimum-reference': passed } });
}
process.stdout.write(JSON.stringify({ schemaVersion: 1, id: 'isolated-ordering-extension', adapterId: 'isolated-ordering-v1', generatorId: 'isolated-ordering-generator',
  verifierId: 'isolated-ordering-verifier', version: '1.0.0', artifactKinds: ['explanation'], sourceRefs: ['ordering-reference'], checkIds: ['minimum-reference'],
  source, referenceData: { absoluteLimit: 1000000 }, qualification }));
`;

/** The public algorithms lab reduced to its code episode, so a fresh enrollment can be graded at once. */
export async function codeCourse() {
  const lab = JSON.parse(await readFile(path.join(ROOT, 'examples/courses/packs/search-lab.json'), 'utf8'));
  const episode = lab.chapters.flatMap(chapter => chapter.episodes).find(item => item.id === 'search-code');
  const gate = lab.gates.find(item => item.id === episode.gateId);
  const referenced = JSON.stringify(episode);
  return { ...lab, id: 'compose-smoke-code', title: 'Compose smoke: code tasks', chapters: [{ ...lab.chapters[0], episodes: [episode] }], gates: [gate],
    objectives: lab.objectives.filter(item => episode.objectiveIds.includes(item.id)).map(item => ({ ...item, prerequisites: [] })),
    assessments: lab.assessments.filter(item => gate.assessmentIds.includes(item.id)),
    visuals: lab.visuals.filter(item => referenced.includes(`"${item.id}"`)), activities: lab.activities.filter(item => referenced.includes(`"${item.id}"`)) };
}

export async function runSmoke({ log = console.log } = {}) {
  const project = `course-core-smoke-${randomBytes(4).toString('hex')}`;
  // A directory Docker can bind-mount on every host (Docker Desktop and Colima share the home directory).
  const scratch = await mkdtemp(path.join(process.env.COURSE_SMOKE_TMPDIR ?? tmpdir(), 'course-core-smoke-'));
  const envFile = path.join(scratch, 'smoke.env'), courseFiles = path.join(scratch, 'course-files');
  await mkdir(courseFiles, { recursive: true, mode: 0o755 });
  const httpPort = await freePort(), httpsPort = await freePort(), localPort = await freePort();
  const image = `${project}:image`, next = `${project}:next`, broken = `${project}:broken`;
  const settings = smokeEnvironment({ httpPort, httpsPort, localPort, octet: 100 + Math.floor(Math.random() * 100),
    password: randomBytes(24).toString('hex'), token: randomBytes(24).toString('hex'), image, courseFiles });
  await writeFile(envFile, Object.entries(settings).map(([key, value]) => `${key}=${value}`).join('\n') + '\n', { mode: 0o600 });
  const config = ops.settings({ envFile, project, backups: path.join(scratch, 'backups') });
  const compose = (args, options = {}) => exec('docker', ['compose', '-p', project, '-f', COMPOSE_FILE, '--env-file', envFile, ...args],
    { maxBuffer: 64 * 1024 * 1024, timeout: options.timeout ?? 180_000 });
  const stream = (args, input) => new Promise((resolve, reject) => {
    const child = spawn('docker', ['compose', '-p', project, '-f', COMPOSE_FILE, '--env-file', envFile, ...args], { stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'inherit'] });
    let out = ''; child.stdout.on('data', chunk => { out += chunk; });
    child.once('error', reject); child.once('close', code => code === 0 ? resolve(out) : reject(new Error(`docker compose ${args[0]} exited ${code}`)));
    if (input !== undefined) child.stdin.end(input);
  });
  const results = {};
  try {
    log(`Building ${image}`);
    await new Promise((resolve, reject) => {
      const child = spawn('docker', ['compose', '-p', project, '-f', COMPOSE_FILE, '--env-file', envFile, 'build', 'api'], { stdio: ['ignore', 'inherit', 'inherit'] });
      child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error(`build exited ${code}`)));
    });
    // The operator's course files: the lab's public fixture registry and a public teaching verifier.
    await copyFile(path.join(ROOT, 'examples/courses/packs/search-lab.code-fixtures.json'), path.join(courseFiles, 'search-lab.code-fixtures.json'));
    await writeFile(path.join(courseFiles, 'ordering-verifier.json'),
      await stream(['run', '--rm', '--no-deps', '-T', '--entrypoint', 'node', 'api', '--input-type=module', '-'], VERIFIER_SCRIPT), { mode: 0o644 });

    log(`Starting ${project} with the operations script (proxy on 127.0.0.1:${httpsPort})`);
    const started = await ops.up(config, { timeoutMs: 20 * 60_000 });
    results.upWithSupervision = started.status === 'running' && ops.healthy(await ops.services(config));
    // The API only becomes healthy after the teaching verifier passed its cases in the sandbox.
    const apiLog = (await compose(['logs', '--no-color', 'api'])).stdout;
    results.teachingVerifierQualified = results.upWithSupervision && !apiLog.includes('"startup":"failed"') && !apiLog.includes('"startup":"degraded"');

    const dbPort = await compose(['port', 'db', '5432']).then(r => r.stdout.trim(), () => '');
    results.databasePublished = dbPort !== '' && !dbPort.endsWith(':0');

    const password = `Smoke-${randomBytes(12).toString('hex')}`;
    const owner = await ops.bootstrap(config, ['self-host-smoke', 'smoke-owner', 'Smoke owner'], { password });
    results.bootstrapped = /^[0-9a-f-]{36}$/.test(owner.workspaceId);

    // The supervisor reaches Temporal and, through the proxy's private name and authority, the API.
    results.supervisorReachesApi = await compose(['exec', '-T', 'dispatcher', 'node', 'dist/src/cli.js', 'dispatch-once'], { timeout: 120_000 }).then(() => true, () => false);

    const ca = (await compose(['exec', '-T', 'proxy', 'cat', '/data/caddy/pki/authorities/local/root.crt'])).stdout;
    const origin = `https://localhost:${httpsPort}`;
    const call = options => httpsCall({ port: httpsPort, ca, ...options });
    const health = await call({ pathname: '/health' });
    results.health = health.status === 200 && JSON.parse(health.text).status === 'ok';
    results.hsts = /max-age=\d+/.test(health.headers['strict-transport-security'] ?? '');
    results.learnerPage = (await call({ pathname: '/' })).status === 200;
    results.adminPage = (await call({ pathname: '/admin/' })).status === 200;
    results.anonymousRefused = (await call({ pathname: '/api/workspaces' })).status === 401;
    results.wrongPasswordRefused = (await call({ method: 'POST', pathname: '/auth/login', headers: { origin }, body: { login: 'smoke-owner', password: `${password}x` } })).status === 401;
    const signIn = async () => {
      const login = await call({ method: 'POST', pathname: '/auth/login', headers: { origin }, body: { login: 'smoke-owner', password } });
      const cookie = (login.headers['set-cookie'] ?? []).map(item => item.split(';')[0]).join('; ');
      return { login, headers: { origin, cookie, 'x-csrf-token': login.status === 200 ? JSON.parse(login.text).csrfToken : '' } };
    };
    const session = await signIn();
    results.signedIn = session.login.status === 200 && (session.login.headers['set-cookie'] ?? []).every(cookie => /;\s*Secure/i.test(cookie));
    const api = async (method, pathname, body) => { const response = await call({ method, pathname, headers: session.headers, body }); return { status: response.status, data: response.text ? JSON.parse(response.text) : null }; };
    results.ownerSeesWorkspace = JSON.stringify((await api('GET', '/api/workspaces')).data).includes(owner.workspaceId);
    results.plainHttpRedirects = await httpCall(httpPort, '/health').then(plain => [301, 302, 307, 308].includes(plain.status) && String(plain.headers.location ?? '').startsWith('https://'));
    results.loopbackHttpServes = (await httpCall(localPort, '/health')).status === 200;

    // Code grading: import the lab's code episode, publish, enroll, and answer one task right and one wrong.
    const imported = await api('POST', `/api/workspaces/${owner.workspaceId}/releases`, await codeCourse());
    const published = imported.status === 200 && (await api('POST', `/api/releases/${imported.data.id}/publish`)).status === 200;
    const enrollment = published ? await api('POST', '/api/enrollments', { releaseId: imported.data.id }) : { status: 0 };
    const command = async (action, body) => {
      const snapshot = (await api('GET', `/api/enrollments/${enrollment.data.id}`)).data;
      return api('POST', `/api/enrollments/${enrollment.data.id}/${action}`, { expectedRevision: snapshot.revision, idempotencyKey: randomBytes(16).toString('hex'), ...body });
    };
    const { code } = await import(path.join(ROOT, 'examples/courses/scripts/reference-answers.mjs'));
    const grade = async (assessmentId, answer) => {
      const issued = await command('challenges', { episodeId: 'search-code', assessmentId, mode: 'independent' });
      if (issued.status !== 200) return { status: issued.status, error: issued.data?.error };
      const answered = await command('answers', { challengeId: issued.data.challengeId, answer });
      return { status: answered.status, passed: answered.data?.result?.passed, cases: answered.data?.result?.execution?.passedCases, error: answered.data?.error };
    };
    const right = enrollment.status === 200 ? await grade('code-linear', code['code-linear'].correct) : null;
    const wrong = enrollment.status === 200 ? await grade('code-midpoints', code['code-midpoints'].wrong) : null;
    log(`grading: ${JSON.stringify({ imported: imported.status, published, enrolled: enrollment.status, right, wrong })}`);
    results.codePassGraded = right?.status === 200 && right.passed === true && right.cases > 0;
    results.codeFailGraded = wrong?.status === 200 && wrong.passed === false;

    // The sandbox's own real-Docker qualification suites, run in the API container through the gate.
    const suites = await compose(['exec', '-T', '-w', '/app/packages/sandbox', '-e', `COURSE_SANDBOX_WORK_VOLUME=${project}_sandbox-work`, '-e', 'COURSE_SANDBOX_WORK_MOUNT=/sandbox-work',
      'api', 'node', '--test', '--test-reporter=spec', 'test/docker.test.mjs', 'test/docker-hardening.test.mjs', 'test/docker-batches.test.mjs'], { timeout: 30 * 60_000 })
      .then(r => r.stdout, error => { log(String(error.stdout ?? '').slice(-6000)); return ''; });
    const summary = Object.fromEntries([...suites.matchAll(/^ℹ (tests|pass|fail|cancelled|skipped|todo) (\d+)$/gm)].map(m => [m[1], Number(m[2])]));
    log(`sandbox qualification through the gate: ${JSON.stringify(summary)}`);
    results.sandboxQualifiedThroughGate = summary.tests > 0 && summary.pass === summary.tests && !summary.fail && !summary.cancelled && !summary.skipped && !summary.todo;

    // Keep-alive: the API exits after SIGTERM and the restart policy brings it back healthy.
    const before = (await compose(['ps', '-q', 'api'])).stdout.trim();
    const startedAt = (await exec('docker', ['inspect', '-f', '{{.State.StartedAt}}', before])).stdout.trim();
    await compose(['exec', '-T', 'api', 'node', '-e', "process.kill(1,'SIGTERM')"]).catch(() => {});
    let restarted = false;
    for (let attempt = 0; attempt < 150 && !restarted; attempt++) {
      await delay(2000);
      const state = (await exec('docker', ['inspect', '-f', '{{.State.StartedAt}} {{.State.Health.Status}}', before])).stdout.trim().split(' ');
      restarted = state[0] !== startedAt && state[1] === 'healthy';
    }
    results.restartedAfterExit = restarted && (await call({ pathname: '/health' })).status === 200;
    results.dataSurvivedRestart = (await signIn()).login.status === 200;

    // Backup while running, then a restore drill into a scratch database.
    const saved = await ops.backup(config);
    const drill = await ops.restoreDrill(config, { backup: saved.directory });
    results.backupRestoreDrill = drill.status === 'restore_verified' && drill.rows === saved.rows && drill.temporal === 'integrity_ok';

    // Upgrade to another image of the same build, then to a broken one, which must roll back.
    await exec('docker', ['image', 'tag', image, next]);
    await new Promise((resolve, reject) => {
      const child = spawn('docker', ['build', '-t', broken, '-'], { stdio: ['pipe', 'ignore', 'inherit'] });
      child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error(`broken image build exited ${code}`)));
      child.stdin.end(`FROM ${image}\nCMD ["node", "-e", "process.exit(3)"]\n`);
    });
    const upgraded = await ops.upgrade(config, { image: next, timeoutMs: 15 * 60_000 });
    results.upgraded = upgraded.status === 'upgraded' && (await ops.status(config)).image === next && (await signIn()).login.status === 200;
    let rolledBack = null;
    try { await ops.upgrade(config, { image: broken, timeoutMs: 4 * 60_000 }); } catch (error) { rolledBack = error; }
    const afterRollback = await ops.status(config);
    const enrollmentKept = (await signIn()).login.status === 200 && (await call({ pathname: `/api/enrollments/${enrollment.data?.id}`, headers: (await signIn()).headers })).status === 200;
    results.brokenUpgradeRolledBack = rolledBack?.code === 'upgrade_rolled_back' && afterRollback.status === 'healthy' && afterRollback.image === next && enrollmentKept;
    return results;
  } catch (error) {
    try { log((await compose(['logs', '--no-color', '--tail', '80'])).stdout); } catch { /* diagnostics only */ }
    throw error;
  } finally {
    await compose(['down', '--volumes', '--remove-orphans', '--timeout', '20'], { timeout: 300_000 }).catch(error => log(`cleanup: ${error.message}`));
    // Sandbox containers are removed by the broker; any left by a failed run carry this project's volume.
    const leftover = await exec('docker', ['ps', '-aq', '--filter', 'label=course-core.sandbox=true', '--filter', `volume=${project}_sandbox-work`]).then(r => r.stdout.trim().split('\n').filter(Boolean), () => []);
    if (leftover.length) await exec('docker', ['rm', '--force', ...leftover]).catch(() => {});
    await exec('docker', ['volume', 'rm', `${project}_sandbox-work`]).catch(() => {});
    for (const tag of [broken, next, image]) await exec('docker', ['image', 'rm', tag]).catch(() => {});
    await rm(scratch, { recursive: true, force: true });
  }
}
