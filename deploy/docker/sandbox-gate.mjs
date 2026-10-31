// The sandbox gate: the only path from the Course Core API to a Docker daemon in the Compose stack.
// It listens on a Unix socket in a volume shared with the API alone and forwards to the host's
// Docker socket exactly the calls the code sandbox (packages/sandbox) makes, and only for its own
// containers:
//   - ping, version, a reduced `info` (the isolation fields the sandbox checks);
//   - inspect of the one pinned sandbox image;
//   - create of a `course-sandbox-<uuid>` container whose whole configuration is the sandbox's:
//     the pinned image, no network, read-only root, every capability dropped, no new privileges,
//     the fixed non-root user, bounded memory (no swap), CPU, PIDs and file limits, a small
//     noexec /tmp, and one read-only mount: a run directory of the sandbox work volume. Any other
//     setting (a bind mount, a device, privileged mode, host namespaces, ports, a restart policy)
//     is refused, so the API cannot use the gate to reach the host;
//   - inspect, attach, start, wait and remove of containers that are sandbox containers.
// Everything else is refused. It never pulls on the API's behalf: it pulls the pinned image itself
// at start (by digest, for the daemon's own architecture) and reports ready only once it is present.
import http from 'node:http';
import net from 'node:net';
import { chmod, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const SANDBOX_NAME = /^course-sandbox-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OBJECT_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const SUBPATH = /^(?:[A-Za-z0-9._-]+\/)*run-[A-Za-z0-9_-]{1,64}$/;
const MiB = 1024 * 1024;
/** The `info` fields the sandbox preflight reads; the rest of the host's details stay hidden. */
export const INFO_FIELDS = ['ID', 'OSType', 'Architecture', 'MemoryLimit', 'SwapLimit', 'CpuCfsQuota', 'CpuCfsPeriod', 'PidsLimit', 'SecurityOptions', 'CgroupVersion', 'ServerVersion', 'KernelVersion'];

class Refusal extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const refuse = (field) => { throw new Refusal(403, `course-core sandbox gate: ${field} is not allowed`); };

/** Null, false, zero, '' and an empty array or object are Docker's "not set". An object with any
 * key is set, even `{ "/data": {} }`, which would add a volume. */
export function unset(value) {
  if (value === null || value === undefined || value === false || value === 0 || value === '') return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const exactly = expected => (value, field) => { if (!same(value, expected)) refuse(field); };
/** The same items in any order: the Docker CLI builds some lists (Env, Ulimits) from maps. */
const sameItems = expected => (value, field) => {
  const key = item => JSON.stringify(item);
  if (!Array.isArray(value) || value.length !== expected.length || !same(value.map(key).sort(), expected.map(key).sort())) refuse(field);
};
const oneOf = (...allowed) => (value, field) => { if (!allowed.some(item => same(value, item))) refuse(field); };
const integer = (min, max) => (value, field) => { if (!Number.isSafeInteger(value) || value < min || value > max) refuse(field); };
/** Checks one object: listed keys by their rule, every other key must be unset. */
function check(value, rules, field) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) refuse(field);
  for (const [key, rule] of Object.entries(rules)) {
    if (typeof rule === 'function') rule(value[key], `${field}.${key}`);
    else check(value[key] ?? {}, rule, `${field}.${key}`);
  }
  // Docker decodes JSON keys case-insensitively (with Unicode folding), so a key that differs from a
  // checked one only in case, or any non-ASCII key, could replace a checked value: refuse both.
  const folded = new Set(Object.keys(rules).map(key => key.toLowerCase()));
  for (const [key, item] of Object.entries(value)) {
    if (Object.hasOwn(rules, key)) continue;
    if (/[^\x21-\x7e]/.test(key) || folded.has(key.toLowerCase()) || !unset(item)) refuse(`${field}.${key}`);
  }
}

/**
 * Validates a container create request against the sandbox's own configuration
 * (`dockerArguments` in packages/sandbox). Throws a 403 Refusal naming the first field that differs.
 */
export function validateCreate(query, body, { image, volume }) {
  const names = [...query.keys()];
  if (names.length !== 1 || names[0] !== 'name' || !SANDBOX_NAME.test(query.get('name') ?? '')) refuse('the container name');
  let config;
  try { config = JSON.parse(body.toString('utf8')); } catch { throw new Refusal(400, 'course-core sandbox gate: invalid JSON'); }
  check(config, {
    Image: exactly(image), User: exactly('65532:65532'),
    AttachStdin: exactly(true), AttachStdout: exactly(true), AttachStderr: exactly(true), OpenStdin: exactly(true), StdinOnce: exactly(true), Tty: exactly(false),
    Env: sameItems(['PYTHONDONTWRITEBYTECODE=1', 'PYTHONHASHSEED=0']), Cmd: exactly(['python', '-I', '-B', '/work/runner.py']),
    Entrypoint: oneOf(null, undefined, []), Labels: exactly({ 'course-core.sandbox': 'true' }),
    HostConfig: {
      NetworkMode: exactly('none'), ReadonlyRootfs: exactly(true), CapDrop: exactly(['ALL']), SecurityOpt: exactly(['no-new-privileges']),
      Init: exactly(true), Privileged: oneOf(false, undefined),
      Memory: integer(64 * MiB, 512 * MiB), MemorySwap: (value, field) => { if (value !== config.HostConfig.Memory) refuse(field); },
      MemorySwappiness: oneOf(-1, null, undefined), NanoCpus: integer(1, 500_000_000), PidsLimit: integer(1, 32),
      Ulimits: sameItems([{ Name: 'core', Hard: 0, Soft: 0 }, { Name: 'nofile', Hard: 64, Soft: 64 }]),
      Tmpfs: exactly({ '/tmp': 'rw,noexec,nosuid,size=16m' }),
      RestartPolicy: oneOf({ Name: 'no', MaximumRetryCount: 0 }, { Name: '', MaximumRetryCount: 0 }, undefined),
      ConsoleSize: oneOf([0, 0], null, undefined),
      LogConfig: oneOf({ Type: '', Config: {} }, { Type: '' }, {}, null, undefined),
      Mounts: (mounts, field) => {
        if (!Array.isArray(mounts) || mounts.length !== 1) refuse(field);
        check(mounts[0], { Type: exactly('volume'), Source: exactly(volume), Target: exactly('/work'), ReadOnly: exactly(true),
          VolumeOptions: { NoCopy: exactly(true), Subpath: (subpath, name) => { if (typeof subpath !== 'string' || !SUBPATH.test(subpath) || subpath.split('/').some(part => part === '..' || part === '.')) refuse(name); } } }, field);
      },
    },
    NetworkingConfig: {},
  }, 'create');
}

/** A sandbox container, as Docker reports it: the gate's own create rules still hold. */
export function isSandboxContainer(object, { image, volume }) {
  return Boolean(object && SANDBOX_NAME.test(String(object.Name ?? '').replace(/^\//, '')) && object.Config?.Labels?.['course-core.sandbox'] === 'true'
    && object.Config?.Image === image && object.HostConfig?.NetworkMode === 'none' && object.HostConfig?.Privileged === false
    && object.HostConfig?.ReadonlyRootfs === true && Array.isArray(object.HostConfig?.Mounts) && object.HostConfig.Mounts.length === 1
    && object.HostConfig.Mounts[0].Type === 'volume' && object.HostConfig.Mounts[0].Source === volume && object.HostConfig.Mounts[0].ReadOnly === true);
}

/** Classifies one request: the allowed operation and its object, or a refusal. */
export function route(method, url) {
  const parsed = new URL(url, 'http://gate');
  const pathname = parsed.pathname.replace(/^\/v1\.\d{1,3}(?=\/)/, '');
  const query = parsed.searchParams;
  const only = (...keys) => [...query.keys()].every(key => keys.includes(key));
  if ((method === 'GET' || method === 'HEAD') && pathname === '/_ping' && only()) return { op: 'forward' };
  if (method === 'GET' && pathname === '/version' && only()) return { op: 'forward' };
  if (method === 'GET' && pathname === '/info' && only()) return { op: 'info' };
  if (method === 'GET' && pathname === '/_gate/ready' && only()) return { op: 'ready' };
  if (method === 'POST' && pathname === '/containers/create') return { op: 'create', query };
  let match = /^\/images\/(.+)\/json$/.exec(pathname);
  if (method === 'GET' && match && only()) return { op: 'image', reference: decodeURIComponent(match[1]) };
  match = /^\/containers\/([^/]+)(\/[a-z]+)?$/.exec(pathname);
  if (match && OBJECT_REFERENCE.test(match[1])) {
    const [, id, action = ''] = match;
    const flags = keys => only(...keys) && [...query.values()].every(value => ['1', 'true', '0', 'false'].includes(value));
    if (method === 'GET' && action === '/json' && only()) return { op: 'container', id, action };
    if (method === 'POST' && action === '/start' && only()) return { op: 'container', id, action };
    if (method === 'POST' && action === '/wait' && only('condition') && ['next-exit', 'not-running', 'removed', null].includes(query.get('condition'))) return { op: 'container', id, action };
    if (method === 'POST' && action === '/attach' && flags(['stdin', 'stdout', 'stderr', 'stream'])) return { op: 'container', id, action, upgrade: true };
    if (method === 'DELETE' && action === '' && flags(['force', 'v'])) return { op: 'container', id, action };
  }
  // Other object lookups (for example the CLI's untyped `docker inspect` falling through to
  // networks or volumes) are answered as absent, so they reveal nothing and fail as Docker does.
  if (method === 'GET' && /^\/(?:networks|volumes|plugins|nodes|services|tasks|secrets|configs)\/[^/]+(?:\/json)?$/.test(pathname)) return { op: 'absent', what: 'object', id: decodeURIComponent(pathname.split('/')[2]) };
  return { op: 'refuse' };
}

/** For a refused create: the shape of the request (sizes and environment variable names), never values. */
function describe(body) {
  try {
    const config = JSON.parse(body.toString('utf8'));
    return { bytes: body.length, env: Array.isArray(config.Env) ? config.Env.map(item => String(item).split('=')[0].slice(0, 64)) : typeof config.Env, keys: Object.keys(config).length };
  } catch { return { bytes: body.length }; }
}
function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', chunk => { size += chunk.length; if (size > limit) { reject(new Refusal(413, 'course-core sandbox gate: request too large')); req.destroy(); } else chunks.push(chunk); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
const hasBody = req => Number(req.headers['content-length'] ?? 0) > 0 || req.headers['transfer-encoding'] !== undefined;

export function createGate({ upstream, image, volume, log = () => {}, maxContainers = 8 }) {
  let ready = false;
  const call = (method, pathname, body) => new Promise((resolve, reject) => {
    const request = http.request({ socketPath: upstream, method, path: pathname, headers: { host: 'docker', ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}) } }, response => {
      const chunks = []; let size = 0;
      response.on('data', chunk => { size += chunk.length; if (size <= 4 * MiB) chunks.push(chunk); });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
      response.on('error', reject);
    });
    request.on('error', reject);
    request.end(body);
  });
  const forward = (req, res, body) => {
    const headers = { ...req.headers };
    delete headers.connection;
    const request = http.request({ socketPath: upstream, method: req.method, path: req.url, headers: { ...headers, ...(body ? { 'content-length': body.length } : {}) } }, response => {
      res.writeHead(response.statusCode, response.headers);
      // `wait` answers its headers at once and its body only when the container exits; the CLI
      // starts the container only after it sees those headers.
      res.flushHeaders();
      response.pipe(res);
    });
    request.on('error', () => { if (!res.headersSent) json(res, 502, { message: 'course-core sandbox gate: Docker is unavailable' }); else res.destroy(); });
    res.on('close', () => request.destroy());
    request.end(body);
  };
  /** Looks the container up in Docker; only a sandbox container is visible through the gate. */
  const sandboxContainer = async id => {
    const found = await call('GET', `/containers/${encodeURIComponent(id)}/json`);
    if (found.status === 200 && isSandboxContainer(JSON.parse(found.body.toString('utf8')), { image, volume })) return found;
    if (found.status === 200 || found.status === 404) throw new Refusal(404, `No such container: ${id}`);
    throw new Refusal(502, 'course-core sandbox gate: Docker is unavailable');
  };

  const server = http.createServer(async (req, res) => {
    const decision = route(req.method, req.url);
    try {
      if (decision.op === 'refuse') { log({ event: 'sandbox_gate.refused', method: req.method, path: new URL(req.url, 'http://gate').pathname.slice(0, 120) }); throw new Refusal(403, 'course-core sandbox gate: this Docker call is not allowed'); }
      if (decision.op === 'ready') return json(res, ready ? 200 : 503, { ready });
      if (decision.op === 'create') {
        const body = await readBody(req, 64 * 1024);
        try { validateCreate(decision.query, body, { image, volume }); }
        catch (error) { if (error instanceof Refusal) log({ event: 'sandbox_gate.create_refused', reason: error.message, ...describe(body) }); throw error; }
        // The broker runs one container at a time; a few more cover qualification and cleanup races.
        // Anything beyond that is refused, so a misbehaving caller cannot fill the host with sandboxes.
        const listed = await call('GET', `/containers/json?all=1&filters=${encodeURIComponent(JSON.stringify({ label: ['course-core.sandbox=true'], volume: [volume] }))}`);
        if (listed.status !== 200) throw new Refusal(502, 'course-core sandbox gate: Docker is unavailable');
        if (JSON.parse(listed.body.toString('utf8')).length >= maxContainers) { log({ event: 'sandbox_gate.container_limit' }); throw new Refusal(429, 'course-core sandbox gate: too many sandbox containers'); }
        return forward(req, res, body);
      }
      if (hasBody(req)) throw new Refusal(400, 'course-core sandbox gate: unexpected request body');
      if (decision.op === 'forward') return forward(req, res);
      if (decision.op === 'info') {
        const info = await call('GET', '/info');
        if (info.status !== 200) throw new Refusal(502, 'course-core sandbox gate: Docker is unavailable');
        const full = JSON.parse(info.body.toString('utf8'));
        return json(res, 200, Object.fromEntries(INFO_FIELDS.filter(key => Object.hasOwn(full, key)).map(key => [key, full[key]])));
      }
      if (decision.op === 'image') {
        if (decision.reference !== image) throw new Refusal(404, `No such image: ${decision.reference}`);
        return forward(req, res);
      }
      if (decision.op === 'absent') throw new Refusal(404, `No such ${decision.what}: ${decision.id}`);
      if (decision.op === 'container') {
        const found = await sandboxContainer(decision.id);
        if (decision.action === '/json') { res.writeHead(200, { 'content-type': 'application/json', 'content-length': found.body.length }); return res.end(found.body); }
        return forward(req, res);
      }
      throw new Refusal(403, 'course-core sandbox gate: this Docker call is not allowed');
    } catch (error) {
      if (res.headersSent) return res.destroy();
      if (error instanceof Refusal) return json(res, error.status, { message: error.message });
      return json(res, 502, { message: 'course-core sandbox gate: Docker is unavailable' });
    }
  });
  // `docker start --attach` hijacks the connection for the container's stdin and output streams.
  server.on('upgrade', async (req, socket, head) => {
    const decision = route(req.method, req.url);
    const fail = (status, message) => { socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\ncontent-type: application/json\r\nconnection: close\r\n\r\n${JSON.stringify({ message })}`); };
    socket.on('error', () => {});
    try {
      if (decision.op !== 'container' || !decision.upgrade || hasBody(req)) throw new Refusal(403, 'course-core sandbox gate: this Docker call is not allowed');
      await sandboxContainer(decision.id);
    } catch (error) { return fail(error instanceof Refusal ? error.status : 502, error instanceof Refusal ? error.message : 'course-core sandbox gate: Docker is unavailable'); }
    const target = net.connect(upstream, () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      target.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head.length) target.write(head);
      socket.pipe(target); target.pipe(socket);
    });
    target.on('error', () => socket.destroy());
    socket.on('close', () => target.destroy());
    target.on('close', () => socket.destroy());
  });
  server.headersTimeout = 30_000;
  server.requestTimeout = 0; // `wait` and attached streams last as long as the learner's run.
  server.maxConnections = 64;

  /** Pulls the pinned image if Docker does not have it yet; ready once it is there. */
  async function prepare() {
    const present = await call('GET', `/images/${encodeURIComponent(image)}/json`).catch(() => ({ status: 0 }));
    if (present.status !== 200) {
      const [repository, digest] = image.split('@');
      log({ event: 'sandbox_gate.pulling_image' });
      const pulled = await call('POST', `/images/create?fromImage=${encodeURIComponent(repository)}&tag=${encodeURIComponent(digest)}`).catch(() => ({ status: 0 }));
      if (pulled.status !== 200 || (await call('GET', `/images/${encodeURIComponent(image)}/json`).catch(() => ({ status: 0 }))).status !== 200) return false;
    }
    ready = true;
    log({ event: 'sandbox_gate.ready' });
    return true;
  }
  return { server, prepare, upstreamCall: call, get ready() { return ready; } };
}

/** The pinned image for the daemon's architecture, as the API itself selects it. */
export function imageFor(architecture, qualified) {
  const key = { aarch64: 'arm64', arm64: 'arm64', x86_64: 'x64', amd64: 'x64' }[architecture];
  return key ? qualified[key] : undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const log = fields => process.stderr.write(`${JSON.stringify(fields)}\n`);
  const listen = process.env.SANDBOX_GATE_SOCKET ?? '/run/sandbox-gate/docker.sock';
  const upstream = process.env.SANDBOX_GATE_UPSTREAM ?? '/var/run/docker.sock';
  const volume = process.env.SANDBOX_WORK_VOLUME;
  if (!volume || !OBJECT_REFERENCE.test(volume)) { log({ event: 'sandbox_gate.configuration_invalid', field: 'SANDBOX_WORK_VOLUME' }); process.exit(78); }
  const { QUALIFIED_IMAGES } = await import(pathToFileURL(process.env.SANDBOX_PACKAGE ?? '/app/packages/sandbox/dist/index.js').href);
  // The daemon's architecture decides the image, as `QUALIFIED_IMAGES[process.arch]` does in the API.
  let image = process.env.COURSE_SANDBOX_IMAGE;
  for (let attempt = 0; !image; attempt++) {
    const probe = createGate({ upstream, image: 'none', volume });
    const info = await probe.upstreamCall('GET', '/info').catch(() => undefined);
    if (info?.status === 200) image = imageFor(JSON.parse(info.body.toString('utf8')).Architecture, QUALIFIED_IMAGES);
    if (info?.status === 200 && !image) { log({ event: 'sandbox_gate.architecture_unsupported' }); process.exit(78); }
    if (!image) { if (attempt === 0) log({ event: 'sandbox_gate.docker_unavailable' }); await new Promise(resolve => setTimeout(resolve, 5000)); }
  }
  if (!/^[a-z0-9./_-]+@sha256:[a-f0-9]{64}$/.test(image)) { log({ event: 'sandbox_gate.configuration_invalid', field: 'COURSE_SANDBOX_IMAGE' }); process.exit(78); }
  const gate = createGate({ upstream, image, volume, log });
  await mkdir(path.dirname(listen), { recursive: true });
  await rm(listen, { force: true });
  await new Promise((resolve, reject) => { gate.server.once('error', reject); gate.server.listen(listen, resolve); });
  // Only the API shares this socket's volume; it connects as its own unprivileged user.
  await chmod(listen, 0o666);
  log({ event: 'sandbox_gate.listening' });
  while (!(await gate.prepare())) { log({ event: 'sandbox_gate.image_unavailable' }); await new Promise(resolve => setTimeout(resolve, 15_000)); }
  const stop = () => gate.server.close(() => process.exit(0));
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
}
