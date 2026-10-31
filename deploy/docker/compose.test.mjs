import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { smokeEnvironment } from './smoke.mjs';
import { healthy, isRegistryImage, parse, parseEnv, updateEnv } from './ops.mjs';
import { courseFileNames } from './api-start.mjs';

const read = name => readFile(new URL(name, import.meta.url), 'utf8');
const compose = await read('compose.yaml');
/** Service blocks: two-space-indented keys under the top-level `services:` key. */
function services(text) {
  const body = text.slice(text.indexOf('\nservices:\n') + 11, text.indexOf('\nnetworks:\n')), result = {};
  let name;
  for (const line of body.split('\n')) {
    const match = /^ {2}([a-z-]+):\s*$/.exec(line);
    if (match) { name = match[1]; result[name] = ''; } else if (name) result[name] += `${line}\n`;
  }
  return result;
}
const all = services(compose);

test('the stack runs the core, the sandbox gate and supervision by default', () => {
  assert.deepEqual(Object.keys(all).sort(), ['api', 'db', 'dispatcher', 'proxy', 'proxy-ca', 'sandbox-gate', 'temporal', 'worker']);
  for (const [name, body] of Object.entries(all)) assert.doesNotMatch(body, /profiles:/, `${name} starts without a profile`);
});

test('every third-party image is pinned by exact version and digest', async () => {
  const images = [...compose.matchAll(/^\s+image: (\S+)$/gm)].map(m => m[1]).filter(image => !image.startsWith('${COURSE_CORE_IMAGE'));
  assert.equal(images.length, 3);
  for (const image of images) assert.match(image, /^[a-z]+:\d+\.\d+(?:\.\d+)?@sha256:[a-f0-9]{64}$/, image);
  assert.match(all.db, /image: postgres:17\./, 'PostgreSQL 17, the supported major version');
  const dockerfile = await read('Dockerfile');
  assert.match(dockerfile, /^ARG NODE_IMAGE=node:26\.\d+\.\d+-slim@sha256:[a-f0-9]{64}$/m);
  assert.match(dockerfile, /^ARG DOCKER_CLI_IMAGE=docker:\d+\.\d+\.\d+-cli@sha256:[a-f0-9]{64}$/m);
  assert.deepEqual([...dockerfile.matchAll(/^FROM (\S+)/gm)].map(m => m[1]), ['${DOCKER_CLI_IMAGE}', '${NODE_IMAGE}', '${NODE_IMAGE}']);
  assert.match(dockerfile, /temporal-cli\.mjs install/, 'the Temporal CLI is the digest-checked pin');
  assert.match(dockerfile, /^USER node$/m, 'services do not run as root');
});

test('only the TLS proxy publishes ports; the database, API, Temporal and gate stay private', () => {
  for (const [name, body] of Object.entries(all)) {
    if (name === 'proxy') assert.match(body, /^ {4}ports:\n {6}- \$\{COURSE_BIND_ADDRESS:-0\.0\.0\.0\}:\$\{COURSE_HTTP_PORT:-80\}:80\n {6}- \$\{COURSE_BIND_ADDRESS:-0\.0\.0\.0\}:\$\{COURSE_HTTPS_PORT:-443\}:443\n(?: {6}#.*\n)* {6}- 127\.0\.0\.1:\$\{COURSE_LOCAL_HTTP_PORT:-8380\}:8380$/m);
    else assert.doesNotMatch(body, /^ {4}(?:ports|expose):/m, name);
  }
  assert.match(all['proxy-ca'], /^ {4}network_mode: none$/m);
  assert.match(all['proxy-ca'], /proxy-data:\/data:ro/, 'only the public root certificate leaves the proxy volume');
  assert.doesNotMatch(all['proxy-ca'], /\.key/);
  assert.match(all.temporal, /'--ip', '127\.0\.0\.1'/, 'Temporal listens on loopback in its own namespace');
  for (const name of ['worker', 'dispatcher']) assert.match(all[name], /^ {4}network_mode: service:temporal$/m, name);
  assert.match(all.api, /PUBLIC_ORIGIN: https:\/\//, 'the API refuses a non-loopback origin without HTTPS');
  assert.match(all.api, /TRUSTED_PROXIES: \$\{COURSE_PROXY_ADDRESS:-172\.30\.89\.10\}/);
  assert.match(all.proxy, /ipv4_address: \$\{COURSE_PROXY_ADDRESS:-172\.30\.89\.10\}/);
  assert.match(all.proxy, /aliases: \[core-proxy\.internal\]/);
  assert.match(all.worker, /SUPERVISOR_HOST_URL: https:\/\/core-proxy\.internal/);
});

test('only the sandbox gate holds the Docker socket, without a network, root file system or capabilities', async () => {
  for (const [name, body] of Object.entries(all)) {
    if (name === 'sandbox-gate') continue;
    assert.doesNotMatch(body, /\/var\/run\/docker\.sock|COURSE_DOCKER_SOCKET/, `${name} must not mount the Docker socket`);
  }
  const gate = all['sandbox-gate'];
  assert.match(gate, /- \$\{COURSE_DOCKER_SOCKET:-\/var\/run\/docker\.sock\}:\/var\/run\/docker\.sock$/m);
  for (const line of [/^ {4}network_mode: none$/m, /^ {4}read_only: true$/m, /^ {4}cap_drop: \[ALL\]$/m, /no-new-privileges:true/, /sandbox-gate:\/run\/sandbox-gate$/m]) assert.match(gate, line);
  // The gate's socket volume is shared with the API alone.
  for (const [name, body] of Object.entries(all)) if (!['api', 'sandbox-gate'].includes(name)) assert.doesNotMatch(body, /sandbox-gate:\//, name);
  assert.match(all.api, /DOCKER_HOST: unix:\/\/\/run\/sandbox-gate\/docker\.sock/);
  assert.match(all.api, /SANDBOX_WORK_VOLUME: \$\{COMPOSE_PROJECT_NAME\}_sandbox-work/);
  assert.match(gate, /SANDBOX_WORK_VOLUME: \$\{COMPOSE_PROJECT_NAME\}_sandbox-work/);
  assert.match(all.api, /condition: service_healthy[\s\S]*sandbox-gate:\n {8}condition: service_healthy/);
  assert.match(all.api, /- \$\{COURSE_FILES_DIR:-\.\/course-files\}:\/course-files:ro$/m, 'course files are mounted read-only');
  assert.match(all.api, /\/run\/course-files:uid=1000,gid=1000,mode=0700/, 'and copied into private memory');
});

test('every service restarts unless stopped and the long-running ones have health checks', () => {
  for (const [name, body] of Object.entries(all)) {
    if (name === 'proxy-ca') assert.match(body, /^ {4}restart: 'no'$/m, 'the one-shot certificate copy runs once');
    else assert.match(body, /^ {4}restart: unless-stopped$/m, name);
  }
  for (const name of ['db', 'sandbox-gate', 'api', 'proxy', 'temporal']) assert.match(all[name], /^ {4}healthcheck:\n {6}test: /m, name);
  assert.match(all.proxy, /api:\n {8}condition: service_healthy/);
  assert.match(compose, /max-size: 10m/, 'container logs are rotated');
});

test('secrets come from an uncommitted env file, never from the compose file', async () => {
  assert.match(compose, /POSTGRES_PASSWORD: \$\{POSTGRES_PASSWORD:\?/);
  assert.match(compose, /SUPERVISOR_HOST_TOKEN: \$\{SUPERVISOR_HOST_TOKEN:\?/);
  assert.doesNotMatch(compose, /(?:PASSWORD|TOKEN|SECRET|KEY)[A-Z_]*: (?!\$\{)['"]?[^'"\s$]/);
  const example = await read('.env.example');
  assert.match(example, /^POSTGRES_PASSWORD=$/m, 'the example leaves the password empty');
  assert.match(example, /^SUPERVISOR_HOST_TOKEN=$/m);
  assert.doesNotMatch(example, /^[A-Z_]*(?:PASSWORD|TOKEN)=\S/m);
  const ignore = await read('Dockerfile.dockerignore');
  for (const pattern of ['**/.env', '**/node_modules', '.git', '.local', 'deploy/docker/course-files', 'deploy/docker/backups']) assert.ok(ignore.split('\n').includes(pattern), pattern);
  const gitignore = await readFile(new URL('../../.gitignore', import.meta.url), 'utf8');
  for (const pattern of ['deploy/docker/course-files/', 'deploy/docker/backups/', 'deploy/docker/.ops/']) assert.ok(gitignore.split('\n').includes(pattern), pattern);
});

test('the operations script edits env files without losing lines and judges health strictly', () => {
  const text = '# comment\nPOSTGRES_PASSWORD=\n# SUPERVISOR_WORKSPACE_IDS=\nCOURSE_HOSTNAME=localhost\n';
  const next = updateEnv(text, { POSTGRES_PASSWORD: 'p', SUPERVISOR_WORKSPACE_IDS: 'w', COURSE_CORE_IMAGE: 'i' });
  assert.equal(next, '# comment\nPOSTGRES_PASSWORD=p\nSUPERVISOR_WORKSPACE_IDS=w\nCOURSE_HOSTNAME=localhost\nCOURSE_CORE_IMAGE=i\n');
  assert.deepEqual(parseEnv(next), { POSTGRES_PASSWORD: 'p', SUPERVISOR_WORKSPACE_IDS: 'w', COURSE_HOSTNAME: 'localhost', COURSE_CORE_IMAGE: 'i' });
  assert.throws(() => updateEnv(text, { POSTGRES_PASSWORD: 'a\nB=c' }), /invalid_env_value/);
  const up = { state: 'running', health: 'healthy' };
  const states = { db: up, 'sandbox-gate': up, api: up, proxy: up, temporal: up, worker: { state: 'running', health: null }, dispatcher: { state: 'running', health: null }, 'proxy-ca': { state: 'exited', exitCode: 0 } };
  assert.equal(healthy(states), true);
  assert.equal(healthy({ ...states, api: { state: 'running', health: 'starting' } }), false);
  assert.equal(healthy({ ...states, 'proxy-ca': { state: 'exited', exitCode: 1 } }), false);
  assert.equal(healthy({ ...states, worker: { state: 'restarting', health: null } }), false);
  assert.equal(isRegistryImage('ghcr.io/roeehrl/course-core:v0.1.60'), true);
  assert.equal(isRegistryImage('course-core-selfhost:local'), false);
  assert.deepEqual(parse(['upgrade', '--image', 'x', '--timeout-seconds', '60']), { command: 'upgrade', args: [], options: { image: 'x', 'timeout-seconds': '60' } });
});

test('course files are plain names inside the mounted directory', () => {
  assert.deepEqual(courseFileNames('a.json, b-c.json', 'X'), ['a.json', 'b-c.json']);
  assert.deepEqual(courseFileNames('', 'X'), []);
  for (const bad of ['../secret', '/etc/passwd', 'a/b.json', '.hidden', 'a.json,a.json']) assert.throws(() => courseFileNames(bad, 'X'), bad);
});

test('the smoke project binds loopback only and uses its own subnet and image', () => {
  const env = smokeEnvironment({ httpPort: 18080, httpsPort: 18443, localPort: 18380, octet: 150, password: 'a'.repeat(48), token: 'b'.repeat(48), image: 'course-core-smoke-1:image', courseFiles: '/tmp/files' });
  assert.equal(env.COURSE_BIND_ADDRESS, '127.0.0.1');
  assert.equal(env.COURSE_PROXY_ADDRESS, '172.30.150.10');
  assert.ok(env.COURSE_PROXY_ADDRESS.startsWith(env.COURSE_SUBNET.slice(0, -4)) && !env.COURSE_DYNAMIC_RANGE.startsWith('172.30.150.0/'));
  assert.notEqual(env.COURSE_CORE_IMAGE, 'course-core-selfhost:local');
  assert.equal(env.COURSE_CODE_FIXTURES, 'search-lab.code-fixtures.json');
});
