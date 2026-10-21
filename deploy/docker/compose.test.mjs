import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { smokeEnvironment } from './smoke.mjs';

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

test('self-host compose defines the core and optional supervision services', () => {
  assert.deepEqual(Object.keys(all).sort(), ['api', 'db', 'dispatcher', 'proxy', 'proxy-ca', 'temporal', 'worker']);
  for (const name of ['proxy-ca', 'temporal', 'worker', 'dispatcher']) assert.match(all[name], /^ {4}profiles: \[supervision\]$/m, name);
  for (const name of ['db', 'api', 'proxy']) assert.doesNotMatch(all[name], /profiles:/, name);
});

test('every third-party image is pinned by exact version and digest', () => {
  const images = [...compose.matchAll(/^\s+image: (\S+)$/gm)].map(m => m[1]).filter(image => !image.startsWith('${COURSE_CORE_IMAGE'));
  assert.equal(images.length, 3);
  for (const image of images) assert.match(image, /^[a-z]+:\d+\.\d+(?:\.\d+)?@sha256:[a-f0-9]{64}$/, image);
  assert.match(all.db, /image: postgres:17\./, 'PostgreSQL 17, the supported major version');
  return read('Dockerfile').then(dockerfile => {
    assert.match(dockerfile, /^ARG NODE_IMAGE=node:26\.\d+\.\d+-slim@sha256:[a-f0-9]{64}$/m);
    assert.deepEqual([...dockerfile.matchAll(/^FROM (\S+)/gm)].map(m => m[1]), ['${NODE_IMAGE}', '${NODE_IMAGE}']);
    assert.match(dockerfile, /temporal-cli\.mjs install/, 'the Temporal CLI is the digest-checked pin');
    assert.match(dockerfile, /^USER node$/m, 'services do not run as root');
  });
});

test('only the TLS proxy publishes ports; database, API and Temporal stay private', () => {
  for (const [name, body] of Object.entries(all)) {
    if (name === 'proxy') assert.match(body, /^ {4}ports:\n {6}- \$\{COURSE_BIND_ADDRESS:-0\.0\.0\.0\}:\$\{COURSE_HTTP_PORT:-80\}:80\n {6}- \$\{COURSE_BIND_ADDRESS:-0\.0\.0\.0\}:\$\{COURSE_HTTPS_PORT:-443\}:443$/m);
    else assert.doesNotMatch(body, /^ {4}(?:ports|expose):/m, name);
  }
  assert.match(all['proxy-ca'], /^ {4}network_mode: none$/m);
  assert.match(all['proxy-ca'], /proxy-data:\/data:ro/, 'only the public root certificate leaves the proxy volume');
  assert.match(all['proxy-ca'], /root\.crt/);
  assert.doesNotMatch(all['proxy-ca'], /\.key/);
  assert.match(all.temporal, /'--ip', '127\.0\.0\.1'/, 'Temporal listens on loopback in its own namespace');
  for (const name of ['worker', 'dispatcher']) assert.match(all[name], /^ {4}network_mode: service:temporal$/m, name);
  assert.match(all.api, /PUBLIC_ORIGIN: https:\/\//, 'the API refuses a non-loopback origin without HTTPS');
  assert.match(all.api, /TRUSTED_PROXIES: \$\{COURSE_PROXY_ADDRESS:-172\.30\.89\.10\}/);
  assert.match(all.proxy, /ipv4_address: \$\{COURSE_PROXY_ADDRESS:-172\.30\.89\.10\}/);
});

test('every service restarts unless stopped and the long-running ones have health checks', () => {
  for (const [name, body] of Object.entries(all)) {
    if (name === 'proxy-ca') assert.match(body, /^ {4}restart: 'no'$/m, 'the one-shot certificate copy runs once');
    else assert.match(body, /^ {4}restart: unless-stopped$/m, name);
  }
  for (const name of ['db', 'api', 'proxy', 'temporal']) assert.match(all[name], /^ {4}healthcheck:\n {6}test: /m, name);
  assert.match(all.api, /condition: service_healthy/);
  assert.match(all.proxy, /api:\n {8}condition: service_healthy/);
});

test('secrets come from an uncommitted env file, never from the compose file', async () => {
  assert.match(compose, /POSTGRES_PASSWORD: \$\{POSTGRES_PASSWORD:\?/);
  assert.doesNotMatch(compose, /(?:PASSWORD|TOKEN|SECRET|KEY)[A-Z_]*: (?!\$\{)['"]?[^'"\s$]/);
  const example = await read('.env.example');
  assert.match(example, /^POSTGRES_PASSWORD=$/m, 'the example leaves the password empty');
  assert.doesNotMatch(example, /^[A-Z_]*(?:PASSWORD|TOKEN)=\S/m);
  const ignore = await read('Dockerfile.dockerignore');
  for (const pattern of ['**/.env', '**/node_modules', '.git', '.local']) assert.ok(ignore.split('\n').includes(pattern), pattern);
});

test('the smoke project binds loopback only and uses its own subnet and image', () => {
  const env = smokeEnvironment({ httpPort: 18080, httpsPort: 18443, octet: 150, password: 'a'.repeat(48), image: 'course-core-smoke-1:image' });
  assert.equal(env.COURSE_BIND_ADDRESS, '127.0.0.1');
  assert.equal(env.CADDY_GLOBAL_OPTIONS, 'local_certs');
  assert.equal(env.COURSE_PROXY_ADDRESS, '172.30.150.10');
  assert.ok(env.COURSE_PROXY_ADDRESS.startsWith(env.COURSE_SUBNET.slice(0, -4)) && !env.COURSE_DYNAMIC_RANGE.startsWith('172.30.150.0/'));
  assert.notEqual(env.COURSE_CORE_IMAGE, 'course-core-selfhost:local');
});
