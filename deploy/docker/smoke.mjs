// Brings up the documented self-host stack (compose.yaml) under its own throwaway
// Compose project, then checks it the way a user reaches it: through the TLS proxy.
// It touches only containers, volumes, networks and the image it created itself, and
// removes them all at the end, also on failure. Docker is required; nothing is skipped.
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:https';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export const DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
export const COMPOSE_FILE = path.join(DIRECTORY, 'compose.yaml');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen({ host: '127.0.0.1', port: 0 }, resolve); });
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

/** The smoke project's settings: loopback-only ports, Caddy's own authority, a private subnet. */
export function smokeEnvironment({ httpPort, httpsPort, octet, password, image }) {
  return {
    COURSE_HOSTNAME: 'localhost', POSTGRES_PASSWORD: password, COURSE_BIND_ADDRESS: '127.0.0.1',
    COURSE_HTTP_PORT: String(httpPort), COURSE_HTTPS_PORT: String(httpsPort), CADDY_GLOBAL_OPTIONS: 'local_certs',
    COURSE_SUBNET: `172.30.${octet}.0/24`, COURSE_DYNAMIC_RANGE: `172.30.${octet}.128/25`, COURSE_PROXY_ADDRESS: `172.30.${octet}.10`,
    COURSE_CORE_IMAGE: image,
  };
}

/** One HTTPS request to the published proxy port, trusting only the proxy's own root. */
export function httpsCall({ port, ca, method = 'GET', pathname, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, servername: 'localhost', ca, method, path: pathname, timeout: 15_000,
      headers: { host: `localhost:${port}`, ...(body ? { 'content-type': 'application/json' } : {}), ...headers } }, response => {
      const chunks = []; let size = 0;
      response.on('data', chunk => { size += chunk.length; if (size <= 1_048_576) chunks.push(chunk); });
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

export async function runSmoke({ log = console.log } = {}) {
  const project = `course-core-smoke-${randomBytes(4).toString('hex')}`;
  const scratch = await mkdtemp(path.join(tmpdir(), 'course-core-smoke-'));
  const envFile = path.join(scratch, 'smoke.env');
  const httpPort = await freePort(), httpsPort = await freePort();
  const settings = smokeEnvironment({ httpPort, httpsPort, octet: 100 + Math.floor(Math.random() * 100),
    password: randomBytes(24).toString('hex'), image: `${project}:image` });
  await writeFile(envFile, Object.entries(settings).map(([key, value]) => `${key}=${value}`).join('\n') + '\n', { mode: 0o600 });
  const compose = (args, options = {}) => exec('docker', ['compose', '-p', project, '-f', COMPOSE_FILE, '--env-file', envFile, ...args],
    { maxBuffer: 64 * 1024 * 1024, timeout: options.timeout ?? 120_000 });
  const stream = args => new Promise((resolve, reject) => {
    const child = spawn('docker', ['compose', '-p', project, '-f', COMPOSE_FILE, '--env-file', envFile, ...args], { stdio: ['ignore', 'inherit', 'inherit'] });
    child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error(`docker compose ${args[0]} exited ${code}`)));
  });
  const results = {};
  try {
    log(`Building and starting ${project} (proxy on 127.0.0.1:${httpsPort})`);
    await stream(['up', '-d', '--build', '--wait', '--wait-timeout', '300']);

    // The database is reachable only on the private network: no published port.
    const dbPort = await compose(['port', 'db', '5432']).then(r => r.stdout.trim(), () => '');
    results.databasePublished = dbPort !== '' && !dbPort.endsWith(':0');

    // Bootstrap an owner with a password through the documented command (password on stdin).
    const password = `Smoke-${randomBytes(12).toString('hex')}`;
    const bootstrap = await new Promise((resolve, reject) => {
      const child = spawn('docker', ['compose', '-p', project, '-f', COMPOSE_FILE, '--env-file', envFile, 'exec', '-T', 'api',
        'node', 'dist/bootstrap-cli.js', 'self-host-smoke', 'smoke-owner', 'Smoke owner', '--password'], { stdio: ['pipe', 'pipe', 'inherit'] });
      let out = ''; child.stdout.on('data', chunk => { out += chunk; });
      child.once('error', reject); child.once('close', code => code === 0 ? resolve(JSON.parse(out.trim().split('\n').at(-1))) : reject(new Error(`bootstrap exited ${code}`)));
      child.stdin.end(`${password}\n`);
    });
    results.bootstrapped = typeof bootstrap.workspaceId === 'string';

    // Trust only the proxy's own root certificate for the HTTPS checks.
    const caFile = path.join(scratch, 'root.crt');
    await compose(['cp', 'proxy:/data/caddy/pki/authorities/local/root.crt', caFile]);
    const ca = await readFile(caFile);
    const origin = `https://localhost:${httpsPort}`;
    const call = options => httpsCall({ port: httpsPort, ca, ...options });

    const health = await call({ pathname: '/health' });
    results.health = health.status === 200 && JSON.parse(health.text).status === 'ok';
    results.hsts = /max-age=\d+/.test(health.headers['strict-transport-security'] ?? '');
    results.learnerPage = (await call({ pathname: '/' })).status === 200;
    results.adminPage = (await call({ pathname: '/admin/' })).status === 200;
    results.anonymousRefused = (await call({ pathname: '/api/workspaces' })).status === 401;
    results.wrongPasswordRefused = (await call({ method: 'POST', pathname: '/auth/login', headers: { origin }, body: { login: 'smoke-owner', password: `${password}x` } })).status === 401;
    const login = await call({ method: 'POST', pathname: '/auth/login', headers: { origin }, body: { login: 'smoke-owner', password } });
    const cookies = (login.headers['set-cookie'] ?? []).map(cookie => cookie.split(';')[0]).join('; ');
    results.signedIn = login.status === 200 && (login.headers['set-cookie'] ?? []).every(cookie => /;\s*Secure/i.test(cookie));
    const workspaces = await call({ pathname: '/api/workspaces', headers: { cookie: cookies } });
    results.ownerSeesWorkspace = workspaces.status === 200 && workspaces.text.includes(bootstrap.workspaceId);
    const plain = await httpCall(httpPort, '/health');
    results.plainHttpRedirects = [301, 302, 307, 308].includes(plain.status) && String(plain.headers.location ?? '').startsWith('https://');

    // Keep-alive: the API exits after SIGTERM and the restart policy brings it back healthy.
    const before = (await compose(['ps', '-q', 'api'])).stdout.trim();
    const startedAt = (await exec('docker', ['inspect', '-f', '{{.State.StartedAt}}', before])).stdout.trim();
    await compose(['exec', '-T', 'api', 'node', '-e', "process.kill(1,'SIGTERM')"]).catch(() => {});
    let restarted = false;
    for (let attempt = 0; attempt < 90 && !restarted; attempt++) {
      await delay(2000);
      const state = (await exec('docker', ['inspect', '-f', '{{.State.StartedAt}} {{.State.Health.Status}}', before])).stdout.trim().split(' ');
      restarted = state[0] !== startedAt && state[1] === 'healthy';
    }
    results.restartedAfterExit = restarted && (await call({ pathname: '/health' })).status === 200;
    // The saved account survived the restart: sign in again.
    results.dataSurvivedRestart = (await call({ method: 'POST', pathname: '/auth/login', headers: { origin }, body: { login: 'smoke-owner', password } })).status === 200;
    return results;
  } catch (error) {
    try { log((await compose(['logs', '--no-color', '--tail', '80'])).stdout); } catch { /* diagnostics only */ }
    throw error;
  } finally {
    await compose(['--profile', 'supervision', 'down', '--volumes', '--remove-orphans', '--timeout', '20'], { timeout: 180_000 }).catch(error => log(`cleanup: ${error.message}`));
    await exec('docker', ['image', 'rm', settings.COURSE_CORE_IMAGE]).catch(() => {});
    await rm(scratch, { recursive: true, force: true });
  }
}
