import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createGate, imageFor, isSandboxContainer, route, unset, validateCreate } from './sandbox-gate.mjs';

const image = 'python@sha256:55432fc4ef6d07e33c10449312f0ec00071bbb310bb9bd7ba626a31fbbc2cb0d';
const volume = 'course-core_sandbox-work';
const name = 'course-sandbox-0f8e4c52-1111-4a3b-9c4d-123456789abc';
/** What docker CLI 29 sends for the sandbox's own `docker create` (packages/sandbox dockerArguments). */
function sandboxCreate() {
  return {
    Hostname: '', Domainname: '', User: '65532:65532', AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: false, OpenStdin: true, StdinOnce: true,
    Env: ['PYTHONDONTWRITEBYTECODE=1', 'PYTHONHASHSEED=0'], Cmd: ['python', '-I', '-B', '/work/runner.py'], Image: image, Volumes: {}, WorkingDir: '', Entrypoint: null,
    Labels: { 'course-core.sandbox': 'true' },
    HostConfig: {
      Binds: null, ContainerIDFile: '', LogConfig: { Type: '', Config: {} }, NetworkMode: 'none', PortBindings: {}, RestartPolicy: { Name: 'no', MaximumRetryCount: 0 },
      AutoRemove: false, VolumeDriver: '', VolumesFrom: null, ConsoleSize: [0, 0], CapAdd: null, CapDrop: ['ALL'], CgroupnsMode: '', Dns: null, DnsOptions: [], DnsSearch: [],
      ExtraHosts: null, GroupAdd: null, IpcMode: '', Cgroup: '', Links: null, OomScoreAdj: 0, PidMode: '', Privileged: false, PublishAllPorts: false, ReadonlyRootfs: true,
      SecurityOpt: ['no-new-privileges'], Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=16m' }, UTSMode: '', UsernsMode: '', ShmSize: 0, Isolation: '', CpuShares: 0,
      Memory: 134217728, NanoCpus: 500000000, CgroupParent: '', BlkioWeight: 0, BlkioWeightDevice: [], BlkioDeviceReadBps: [], BlkioDeviceWriteBps: [], BlkioDeviceReadIOps: [],
      BlkioDeviceWriteIOps: [], CpuPeriod: 0, CpuQuota: 0, CpuRealtimePeriod: 0, CpuRealtimeRuntime: 0, CpusetCpus: '', CpusetMems: '', Devices: [], DeviceCgroupRules: null,
      DeviceRequests: null, MemoryReservation: 0, MemorySwap: 134217728, MemorySwappiness: -1, OomKillDisable: false, PidsLimit: 32,
      Ulimits: [{ Name: 'core', Hard: 0, Soft: 0 }, { Name: 'nofile', Hard: 64, Soft: 64 }], CpuCount: 0, CpuPercent: 0, IOMaximumIOps: 0, IOMaximumBandwidth: 0,
      Mounts: [{ Type: 'volume', Source: volume, Target: '/work', ReadOnly: true, VolumeOptions: { NoCopy: true, Subpath: 'run-AbC123' } }],
      MaskedPaths: null, ReadonlyPaths: null, Init: true,
    },
    NetworkingConfig: { EndpointsConfig: {} },
  };
}
const query = (value = name) => new URLSearchParams({ name: value });
const validate = (body, q = query()) => validateCreate(q, Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)), { image, volume });
const mutated = change => { const body = sandboxCreate(); change(body); return body; };

test('the sandbox\'s own container configuration passes the gate', () => {
  validate(sandboxCreate());
  validate(mutated(body => { body.HostConfig.Mounts[0].VolumeOptions.Subpath = 'qualification/hardening-x1/storage/run-Q9'; body.HostConfig.Memory = body.HostConfig.MemorySwap = 512 * 1048576; }));
  // The CLI builds Env and Ulimits from maps, so their order varies between runs.
  validate(mutated(body => { body.Env.reverse(); body.HostConfig.Ulimits.reverse(); }));
});

test('every way to widen the sandbox through create is refused', () => {
  const refusals = {
    'a host bind mount': body => { body.HostConfig.Binds = ['/:/host']; },
    'a bind mount': body => { body.HostConfig.Mounts[0] = { Type: 'bind', Source: '/', Target: '/work', ReadOnly: true }; },
    'another volume (the database)': body => { body.HostConfig.Mounts[0].Source = 'course-core_db-data'; },
    'a second mount': body => { body.HostConfig.Mounts.push({ ...body.HostConfig.Mounts[0], Target: '/more' }); },
    'a writable mount': body => { body.HostConfig.Mounts[0].ReadOnly = false; },
    'a subpath escaping the run directory': body => { body.HostConfig.Mounts[0].VolumeOptions.Subpath = '../run-x'; },
    'the volume root': body => { delete body.HostConfig.Mounts[0].VolumeOptions.Subpath; },
    'privileged mode': body => { body.HostConfig.Privileged = true; },
    'the bridge network': body => { body.HostConfig.NetworkMode = 'bridge'; },
    'the host network': body => { body.HostConfig.NetworkMode = 'host'; },
    'a case-variant key that would reset the network': body => { body.HostConfig.networkmode = ''; },
    'a case-variant key that would make the mount writable': body => { body.HostConfig.Mounts[0].readonly = false; },
    'a Unicode-folded key': body => { body.HostConfig.Mounts[0].VolumeOptions['ſubpath'] = ''; },
    'an added capability': body => { body.HostConfig.CapAdd = ['SYS_ADMIN']; },
    'kept capabilities': body => { body.HostConfig.CapDrop = []; },
    'an unconfined seccomp profile': body => { body.HostConfig.SecurityOpt = ['no-new-privileges', 'seccomp=unconfined']; },
    'a device': body => { body.HostConfig.Devices = [{ PathOnHost: '/dev/kmsg', PathInContainer: '/dev/kmsg', CgroupPermissions: 'r' }]; },
    'a GPU': body => { body.HostConfig.DeviceRequests = [{ Count: -1, Capabilities: [['gpu']] }]; },
    'the host PID namespace': body => { body.HostConfig.PidMode = 'host'; },
    'the host user namespace': body => { body.HostConfig.UsernsMode = 'host'; },
    'a published port': body => { body.HostConfig.PortBindings = { '80/tcp': [{ HostPort: '8080' }] }; },
    'a restart policy': body => { body.HostConfig.RestartPolicy = { Name: 'always', MaximumRetryCount: 0 }; },
    'a writable root': body => { body.HostConfig.ReadonlyRootfs = false; },
    'more memory than the sandbox allows': body => { body.HostConfig.Memory = body.HostConfig.MemorySwap = 1024 * 1048576; },
    'swap': body => { body.HostConfig.MemorySwap = -1; },
    'more CPU': body => { body.HostConfig.NanoCpus = 4e9; },
    'unlimited processes': body => { body.HostConfig.PidsLimit = -1; },
    'root': body => { body.User = '0:0'; },
    'another image': body => { body.Image = 'python:latest'; },
    'another command': body => { body.Cmd = ['sh', '-c', 'id']; },
    'an entrypoint': body => { body.Entrypoint = ['sh']; },
    'extra environment': body => { body.Env.push('LD_PRELOAD=/work/x.so'); },
    'a repeated variable in place of one': body => { body.Env = ['PYTHONHASHSEED=0', 'PYTHONHASHSEED=0']; },
    'a raised file limit': body => { body.HostConfig.Ulimits = [{ Name: 'core', Hard: 0, Soft: 0 }, { Name: 'nofile', Hard: 65536, Soft: 65536 }]; },
    'a sysctl': body => { body.HostConfig.Sysctls = { 'net.ipv4.ip_forward': '1' }; },
    'a cgroup parent': body => { body.HostConfig.CgroupParent = '/'; },
    'another runtime': body => { body.HostConfig.Runtime = 'other'; },
    'a network endpoint': body => { body.NetworkingConfig.EndpointsConfig = { 'course-core_course': {} }; },
    'other labels': body => { body.Labels = { 'course-core.sandbox': 'true', other: 'x' }; },
    'an anonymous volume': body => { body.Volumes = { '/data': {} }; },
    'a logging driver': body => { body.HostConfig.LogConfig = { Type: 'syslog', Config: { 'syslog-address': 'udp://203.0.113.1:514' } }; },
    'a missing HostConfig': body => { delete body.HostConfig; },
  };
  for (const [label, change] of Object.entries(refusals)) assert.throws(() => validate(mutated(change)), error => error.status === 403, label);
  assert.throws(() => validate(sandboxCreate(), query('db')), error => error.status === 403, 'another container name');
  assert.throws(() => validate(sandboxCreate(), new URLSearchParams({ name, platform: 'linux/amd64' })), error => error.status === 403, 'another query parameter');
  assert.throws(() => validate('{"Image":'), error => error.status === 400, 'invalid JSON');
  // A duplicate key: JSON.parse and Docker's decoder both keep the last value, which is checked.
  assert.throws(() => validate(JSON.stringify(sandboxCreate()).replace('"NetworkMode":"none"', '"NetworkMode":"none","NetworkMode":"bridge"')), error => error.status === 403);
});

test('requests are routed to the few operations the sandbox makes', () => {
  assert.equal(route('HEAD', '/_ping').op, 'forward');
  assert.equal(route('GET', '/v1.54/info').op, 'info');
  assert.deepEqual(route('GET', `/v1.54/images/${encodeURIComponent(image)}/json`), { op: 'image', reference: image });
  assert.equal(route('POST', `/v1.54/containers/create?name=${name}`).op, 'create');
  for (const [method, url, action] of [['GET', '/v1.54/containers/abc/json', '/json'], ['POST', '/v1.54/containers/abc/start', '/start'], ['POST', '/v1.54/containers/abc/wait?condition=next-exit', '/wait'],
    ['POST', '/v1.54/containers/abc/attach?stderr=1&stdin=1&stdout=1&stream=1', '/attach'], ['DELETE', '/v1.54/containers/abc?force=1', '']]) assert.equal(route(method, url).action, action, url);
  for (const [method, url] of [['POST', '/v1.54/containers/abc/exec'], ['POST', '/v1.54/images/create?fromImage=x'], ['GET', '/v1.54/containers/json'], ['POST', '/v1.54/volumes/create'],
    ['POST', '/v1.54/build'], ['GET', '/v1.54/events'], ['POST', '/v1.54/containers/abc/archive'], ['PUT', '/v1.54/containers/abc/archive?path=/'], ['POST', '/v1.54/containers/abc/update'],
    ['POST', '/v1.54/containers/abc/attach?logs=1&stream=1'], ['GET', '/v1.54/containers/abc/json?size=1'], ['POST', '/v1.54/swarm/init'], ['POST', '/v1.54/networks/create'], ['GET', '/v1.54/system/df']]) assert.equal(route(method, url).op, 'refuse', url);
  assert.equal(route('GET', '/v1.54/volumes/course-core_db-data').op, 'absent');
});

test('only containers with the sandbox\'s own configuration are visible through the gate', () => {
  const object = { Name: `/${name}`, Config: { Image: image, Labels: { 'course-core.sandbox': 'true' } },
    HostConfig: { NetworkMode: 'none', Privileged: false, ReadonlyRootfs: true, Mounts: [{ Type: 'volume', Source: volume, ReadOnly: true }] } };
  assert.equal(isSandboxContainer(object, { image, volume }), true);
  assert.equal(isSandboxContainer({ ...object, Name: '/course-core-db-1' }, { image, volume }), false);
  assert.equal(isSandboxContainer({ ...object, Config: { ...object.Config, Labels: {} } }, { image, volume }), false);
  assert.equal(isSandboxContainer({ ...object, HostConfig: { ...object.HostConfig, NetworkMode: 'bridge' } }, { image, volume }), false);
  assert.equal(imageFor('aarch64', { arm64: 'a', x64: 'b' }), 'a');
  assert.equal(imageFor('x86_64', { arm64: 'a', x64: 'b' }), 'b');
  assert.equal(imageFor('riscv64', { arm64: 'a', x64: 'b' }), undefined);
  assert.equal(unset({}), true); assert.equal(unset([]), true); assert.equal(unset(''), true);
  assert.equal(unset({ '/data': {} }), false, 'an anonymous volume');
  assert.equal(unset({ a: [1] }), false);
});

/** A stand-in Docker daemon on a Unix socket that records what reaches it. */
async function fakeDocker(directory) {
  const seen = [], socket = path.join(directory, 'docker.sock'), listed = { count: 0 };
  const containers = {
    sandbox: { Name: `/${name}`, Config: { Image: image, Labels: { 'course-core.sandbox': 'true' } },
      HostConfig: { NetworkMode: 'none', Privileged: false, ReadonlyRootfs: true, Mounts: [{ Type: 'volume', Source: volume, ReadOnly: true }] } },
    database: { Name: '/course-core-db-1', Config: { Image: 'postgres:17', Labels: {} }, HostConfig: { NetworkMode: 'course', Privileged: false, Mounts: [] } },
  };
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      seen.push(`${req.method} ${req.url}`);
      const inspect = /^\/containers\/([^/]+)\/json$/.exec(req.url)?.[1];
      const reply = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
      if (inspect) return containers[inspect] ? reply(200, containers[inspect]) : reply(404, { message: `No such container: ${inspect}` });
      if (req.url.startsWith('/containers/json?')) return reply(200, Array.from({ length: listed.count }, () => ({})));
      if (req.url === '/info') return reply(200, { OSType: 'linux', Architecture: 'aarch64', MemoryLimit: true, SwapLimit: true, CpuCfsQuota: true, PidsLimit: true, SecurityOptions: ['name=seccomp,profile=builtin'], Name: 'private-host-name', DockerRootDir: '/var/lib/docker', RegistryConfig: { secret: true } });
      if (req.url.startsWith('/v1.54/containers/create')) return reply(201, { Id: 'a'.repeat(64), Warnings: [] });
      return reply(200, {});
    });
  });
  server.on('upgrade', (req, sock) => {
    seen.push(`UPGRADE ${req.url}`); sock.on('error', () => {}); sock.on('end', () => sock.destroy());
    sock.write('HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n'); sock.on('data', data => { if (sock.writable) sock.write(data); });
  });
  await new Promise(resolve => server.listen(socket, resolve));
  return { socket, seen, listed, close: () => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); } };
}
const request = (socketPath, method, pathname, body) => new Promise((resolve, reject) => {
  const req = http.request({ socketPath, method, path: pathname, headers: body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {} }, res => {
    let text = ''; res.on('data', chunk => { text += chunk; }); res.on('end', () => resolve({ status: res.statusCode, text }));
  });
  req.on('error', reject); req.end(body);
});

test('the gate forwards the sandbox\'s calls and nothing else reaches Docker', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'sandbox-gate-'));
  const docker = await fakeDocker(directory), listen = path.join(directory, 'gate.sock');
  const gate = createGate({ upstream: docker.socket, image, volume });
  await new Promise(resolve => gate.server.listen(listen, resolve));
  try {
    assert.equal((await request(listen, 'GET', '/_gate/ready')).status, 503);
    assert.equal(await gate.prepare(), true);
    assert.equal((await request(listen, 'GET', '/_gate/ready')).status, 200);
    docker.seen.length = 0;
    const info = JSON.parse((await request(listen, 'GET', '/v1.54/info')).text);
    assert.equal(info.Architecture, 'aarch64'); assert.equal(info.Name, undefined); assert.equal(info.RegistryConfig, undefined); assert.equal(info.DockerRootDir, undefined);
    assert.equal((await request(listen, 'POST', `/v1.54/containers/create?name=${name}`, JSON.stringify(sandboxCreate()))).status, 201);
    assert.equal((await request(listen, 'POST', `/v1.54/containers/create?name=${name}`, JSON.stringify(mutated(body => { body.HostConfig.Privileged = true; })))).status, 403);
    docker.listed.count = 8;
    assert.equal((await request(listen, 'POST', `/v1.54/containers/create?name=${name}`, JSON.stringify(sandboxCreate()))).status, 429, 'at most 8 sandbox containers');
    docker.listed.count = 0;
    assert.equal((await request(listen, 'POST', '/v1.54/containers/sandbox/start')).status, 200);
    assert.equal((await request(listen, 'POST', '/v1.54/containers/database/start')).status, 404);
    assert.equal((await request(listen, 'DELETE', '/v1.54/containers/database?force=1')).status, 404);
    assert.equal((await request(listen, 'GET', '/v1.54/containers/database/json')).status, 404);
    assert.equal((await request(listen, 'POST', '/v1.54/containers/sandbox/exec', '{}')).status, 403);
    assert.equal((await request(listen, 'GET', '/v1.54/containers/json?all=1')).status, 403);
    assert.equal((await request(listen, 'GET', `/v1.54/images/${encodeURIComponent('postgres:17')}/json`)).status, 404);
    assert.equal((await request(listen, 'POST', '/v1.54/containers/sandbox/start', '{"x":1}')).status, 400);
    assert.equal((await request(listen, 'DELETE', '/v1.54/containers/sandbox?force=1')).status, 200);
    // The attached stream of a sandbox container is passed through; another container's is refused.
    const attach = id => new Promise(resolve => {
      const socket = connect(listen, () => socket.write(`POST /v1.54/containers/${id}/attach?stderr=1&stdin=1&stdout=1&stream=1 HTTP/1.1\r\nHost: docker\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Length: 0\r\n\r\n`));
      let text = '', pinged = false;
      socket.on('error', () => {});
      socket.on('data', data => {
        text += data;
        if (!pinged && text.includes('\r\n\r\n') && text.startsWith('HTTP/1.1 101')) { pinged = true; socket.write('ping'); }
        if (text.endsWith('\r\n\r\nping') || !text.startsWith('HTTP/1.1 101')) { socket.destroy(); resolve(text); }
      });
      socket.on('close', () => resolve(text));
    });
    assert.match(await attach('sandbox'), /^HTTP\/1\.1 101[\s\S]*\r\n\r\nping$/);
    assert.match(await attach('database'), /^HTTP\/1\.1 404/);
    assert.deepEqual(docker.seen.filter(line => !line.includes('/json')), ['GET /info', `POST /v1.54/containers/create?name=${name}`, 'POST /v1.54/containers/sandbox/start',
      'DELETE /v1.54/containers/sandbox?force=1', 'UPGRADE /v1.54/containers/sandbox/attach?stderr=1&stdin=1&stdout=1&stream=1']);
  } finally {
    gate.server.closeAllConnections(); await new Promise(resolve => gate.server.close(resolve)); await docker.close(); await rm(directory, { recursive: true, force: true });
  }
});
