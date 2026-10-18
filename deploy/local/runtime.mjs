import { createServer, connect } from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rename, rmdir, unlink } from 'node:fs/promises';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import path from 'node:path';

export class PilotError extends Error { constructor(code) { super(code); this.code = code; } }
export function ensure(value, code) { if (!value) throw new PilotError(code); }
export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export const hash = value => createHash('sha256').update(value).digest('hex');
export const uid = () => process.getuid();
export const names = ['temporal', 'api', 'worker', 'dispatcher'];
export function absolute(value) { ensure(typeof value === 'string' && path.isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value), 'invalid_path'); return path.resolve(value); }
export async function privateDirectory(value, create = false) {
  const directory = absolute(value);
  if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  ensure(info.isDirectory() && !info.isSymbolicLink() && info.uid === uid() && !(info.mode & 0o077), 'insecure_state_directory');
  return realpath(directory);
}
export async function privateFile(file, optional = false, maximum = 65_536) {
  // writePrivate(…, true) replaces a file with rename(). A reader that opened the old
  // inode just before that rename sees nlink 0 (no longer linked anywhere), which is
  // neither a hard link nor insecure: it is simply stale. Re-open to read the current
  // version; a hard link (nlink > 1) is still refused.
  for (let attempt = 0; ; attempt++) {
    let handle;
    try {
      handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await handle.stat();
      if (info.nlink === 0 && attempt < 5) continue;
      ensure(info.isFile() && info.uid === uid() && !(info.mode & 0o077) && info.nlink === 1 && info.size <= maximum, 'insecure_private_file');
      return { text: await handle.readFile('utf8'), info };
    } catch (error) { if (optional && error.code === 'ENOENT') return null; if (error instanceof PilotError) throw error; throw new PilotError('private_file_unavailable'); }
    finally { await handle?.close(); }
  }
}
export async function privateJson(file, optional = false) {
  const result = await privateFile(file, optional); if (!result) return null;
  try { return { value: JSON.parse(result.text), info: result.info, text: result.text }; }
  catch { throw new PilotError('invalid_private_json'); }
}
export async function writePrivate(file, text, replace = false, mode = 0o600) {
  ensure(Number.isInteger(mode) && !(mode & ~0o700) && mode & 0o400, 'insecure_private_file');
  const temporary = `${file}.new-${randomUUID()}`;
  let handle;
  try {
    handle = await open(replace ? temporary : file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(text); if (mode !== 0o600) await handle.chmod(mode); await handle.sync(); await handle.close(); handle = undefined;
    if (replace) await rename(temporary, file);
  } finally { await handle?.close(); if (replace) await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
export async function mutex(state, name, body) {
  const directory = path.join(state, name), token = randomUUID();
  try { await mkdir(directory, { mode: 0o700 }); } catch (error) { if (error.code === 'EEXIST') throw new PilotError('transition_busy_or_unreconciled'); throw error; }
  try {
    await writePrivate(path.join(directory, 'holder.json'), JSON.stringify({ token, pid: process.pid }));
    return await body();
  } finally {
    const holder = await privateJson(path.join(directory, 'holder.json'));
    ensure(holder.value.token === token, 'transition_ownership_changed');
    await unlink(path.join(directory, 'holder.json')); await rmdir(directory);
  }
}
export function alive(pid) {
  ensure(Number.isSafeInteger(pid) && pid > 1, 'invalid_recorded_pid');
  try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; return true; }
}
export function validateOwner(owner, state) {
  ensure(owner?.schemaVersion === 2 && owner.kind === 'course-core-local-pilot', 'legacy_or_unknown_owner');
  ensure(owner.state === state && owner.uid === uid() && /^[a-f0-9-]{36}$/.test(owner.instanceId) && /^[a-f0-9]{64}$/.test(owner.controlToken)
    && Number.isSafeInteger(owner.pid) && owner.pid > 1 && Array.isArray(owner.ports) && owner.ports.length === 3
    && owner.ports.every(p => Number.isInteger(p) && p >= 1024 && p <= 65535)
    && owner.children && Object.keys(owner.children).every(n => names.includes(n))
    && Object.values(owner.children).every(p => Number.isSafeInteger(p) && p > 1)
    && (owner.pending === null || names.includes(owner.pending))
    && ['starting', 'running', 'stopping', 'cleanup_required'].includes(owner.phase), 'invalid_owner_record');
  return owner;
}
export async function ownerRecord(state) {
  const found = await privateJson(path.join(state, 'owner.json'), true);
  return found ? validateOwner(found.value, state) : null;
}
export async function sameOwner(state, instanceId) {
  const current = await ownerRecord(state); ensure(current?.instanceId === instanceId, 'owner_changed'); return current;
}
export function controlPath(state) { const file = path.join(state, 'control.sock'); ensure(Buffer.byteLength(file) <= 100, 'control_path_too_long'); return file; }
export async function socketInfo(state) {
  try {
    const info = await lstat(controlPath(state));
    ensure(info.isSocket() && info.uid === uid() && !(info.mode & 0o077), 'insecure_or_unowned_socket');
    return { dev: info.dev, ino: info.ino };
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export async function portFree(port) {
  const server = createServer();
  return new Promise(resolve => {
    server.once('error', () => resolve(false));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => server.close(() => resolve(true)));
  });
}
async function socketAccepts(file) {
  return new Promise(resolve => {
    const socket = connect(file); let done = false;
    const finish = value => { if (!done) { done = true; socket.destroy(); resolve(value); } };
    socket.setTimeout(1000); socket.once('connect', () => finish(true)); socket.once('timeout', () => finish(true));
    socket.once('error', error => finish(!['ECONNREFUSED', 'ENOENT'].includes(error.code)));
  });
}
// Called only while transition.lock is held. Nothing here sends a termination signal.
export async function recoverStale(state) {
  const owner = await ownerRecord(state);
  const socket = await socketInfo(state);
  let lock;
  try { lock = await lstat(path.join(state, 'run.lock')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!owner) { ensure(!socket && !lock, 'unowned_state_requires_review'); return false; }
  ensure(lock?.isDirectory() && lock.uid === uid() && !(lock.mode & 0o077), 'invalid_run_lock');
  ensure(!alive(owner.pid), 'owner_pid_live_or_reused');
  ensure(owner.pending === null, 'uncertain_child_spawn_requires_review');
  ensure(Object.values(owner.children).every(pid => !alive(pid)), 'child_pid_live_or_reused');
  ensure((await Promise.all(owner.ports.map(portFree))).every(Boolean), 'service_port_in_use');
  if (socket) {
    ensure(owner.socket?.ino === socket.ino && owner.socket?.dev === socket.dev, 'socket_identity_changed');
    ensure(!await socketAccepts(controlPath(state)), 'socket_has_live_listener');
    await unlink(controlPath(state));
  }
  await sameOwner(state, owner.instanceId); await unlink(path.join(state, 'owner.json')); await rmdir(path.join(state, 'run.lock'));
  return true;
}
function mac(token, parts) { return createHmac('sha256', token).update(JSON.stringify(parts)).digest('hex'); }
function matches(a, b) { return typeof a === 'string' && /^[a-f0-9]{64}$/.test(a) && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex')); }
export function controlServer(owner, report, stop) {
  const sockets = new Set();
  const server = createServer(socket => {
    if (sockets.size >= 8) { socket.destroy(); return; } sockets.add(socket);
    let buffer = '', challenge, nonce, used = false;
    socket.setTimeout(3000); socket.on('timeout', () => socket.destroy()); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
    socket.on('data', chunk => {
      if (used) { socket.destroy(); return; }
      buffer += chunk.toString('utf8'); if (Buffer.byteLength(buffer) > 8192) { socket.destroy(); return; }
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        let input; try { input = JSON.parse(line); } catch { socket.destroy(); return; }
        if (input.protocol !== 2 || input.instanceId !== owner.instanceId) { socket.destroy(); return; }
        if (!challenge) {
          if (input.action !== 'hello' || !/^[a-f0-9]{64}$/.test(input.nonce)) { socket.destroy(); return; }
          nonce = input.nonce; challenge = randomBytes(32).toString('hex');
          socket.write(JSON.stringify({ protocol: 2, instanceId: owner.instanceId, nonce, challenge, mac: mac(owner.controlToken, ['hello', owner.instanceId, nonce, challenge]) }) + '\n');
        } else {
          if (!['status', 'stop'].includes(input.action) || input.nonce !== nonce || input.challenge !== challenge
            || !matches(input.mac, mac(owner.controlToken, [input.action, owner.instanceId, nonce, challenge]))) { socket.destroy(); return; }
          used = true;
          const result = input.action === 'status' ? report() : { status: 'stopping', instanceId: owner.instanceId };
          socket.end(JSON.stringify({ protocol: 2, instanceId: owner.instanceId, nonce, challenge, result,
            mac: mac(owner.controlToken, ['result', owner.instanceId, nonce, challenge, result]) }) + '\n');
          if (input.action === 'stop') void stop('requested');
          return;
        }
      }
    });
  });
  return { server, async close() { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(() => resolve())); } };
}
export async function control(stateInput, action = 'status') {
  ensure(['status', 'stop'].includes(action), 'invalid_control_action');
  const state = await privateDirectory(stateInput), owner = await ownerRecord(state);
  if (!owner) { ensure(!await socketInfo(state), 'unowned_state_requires_review'); return { status: 'not_running' }; }
  const info = await socketInfo(state);
  ensure(info && info.ino === owner.socket?.ino && info.dev === owner.socket?.dev, 'socket_identity_changed');
  return new Promise((resolve, reject) => {
    const socket = connect(controlPath(state)), nonce = randomBytes(32).toString('hex'); let buffer = '', challenge, settled = false;
    const fail = () => { if (!settled) { settled = true; socket.destroy(); reject(new PilotError('control_unverified_or_unavailable')); } };
    socket.setTimeout(5000); socket.on('error', fail); socket.on('timeout', fail); socket.on('end', () => { if (!settled) fail(); });
    socket.on('connect', () => socket.write(JSON.stringify({ protocol: 2, action: 'hello', instanceId: owner.instanceId, nonce }) + '\n'));
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8'); if (Buffer.byteLength(buffer) > 16384) { fail(); return; }
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        let input; try { input = JSON.parse(buffer.slice(0, newline)); } catch { fail(); return; } buffer = buffer.slice(newline + 1);
        if (input.protocol !== 2 || input.instanceId !== owner.instanceId || input.nonce !== nonce) { fail(); return; }
        if (!challenge) {
          if (!/^[a-f0-9]{64}$/.test(input.challenge) || !matches(input.mac, mac(owner.controlToken, ['hello', owner.instanceId, nonce, input.challenge]))) { fail(); return; }
          challenge = input.challenge;
          // Never send a stop command until the existing connection authenticated its owner.
          socket.write(JSON.stringify({ protocol: 2, action, instanceId: owner.instanceId, nonce, challenge,
            mac: mac(owner.controlToken, [action, owner.instanceId, nonce, challenge]) }) + '\n');
        } else {
          if (input.challenge !== challenge || !matches(input.mac, mac(owner.controlToken, ['result', owner.instanceId, nonce, challenge, input.result]))) { fail(); return; }
          settled = true; socket.destroy(); resolve(input.result); return;
        }
      }
    });
  });
}
export async function portOwnedBy(port, pid) {
  try {
    const { stdout } = await promisify(execFile)('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'], { timeout: 3000, maxBuffer: 16384 });
    const pids = stdout.split('\n').filter(line => /^p\d+$/.test(line)).map(line => Number(line.slice(1)));
    return pids.length > 0 && pids.every(value => value === pid);
  } catch { return false; }
}
export class RotatingLog {
  constructor(state, { bytes = 1_048_576, backups = 3 } = {}) {
    ensure(Number.isInteger(bytes) && bytes >= 1024 && bytes <= 16_777_216 && Number.isInteger(backups) && backups >= 1 && backups <= 8, 'invalid_log_limits');
    this.file = path.join(state, 'services.log'); this.bytes = bytes; this.backups = backups; this.queue = Promise.resolve(); this.pending = 0; this.failed = false;
  }
  write(code, fields = {}) {
    ensure(/^[a-z_]{1,64}$/.test(code), 'invalid_log_code');
    // Callers supply only fixed operational fields. Raw output, configuration and exception text are excluded.
    const record = { at: new Date().toISOString(), code };
    for (const [key, value] of Object.entries(fields)) {
      ensure(['service', 'stream', 'bytes', 'exitCode', 'signal', 'count'].includes(key), 'invalid_log_field');
      if (key === 'service') ensure(names.includes(value), 'invalid_log_service');
      else if (key === 'stream') ensure(['stdout', 'stderr'].includes(value), 'invalid_log_stream');
      else if (key === 'signal') ensure(['SIGTERM', 'SIGKILL', 'SIGINT', null].includes(value), 'invalid_log_signal');
      else ensure(value === null || Number.isSafeInteger(value) && value >= 0, 'invalid_log_number');
      record[key] = value;
    }
    if (this.pending >= 128 || this.failed) return;
    const line = JSON.stringify(record) + '\n'; this.pending++;
    this.queue = this.queue.then(async () => {
      const old = await privateFile(this.file, true, this.bytes + 2048);
      if (old && old.info.size + Buffer.byteLength(line) > this.bytes) {
        for (let i = this.backups; i >= 1; i--) {
          const destination = `${this.file}.${i}`;
          if (await privateFile(destination, true, this.bytes + 2048)) await unlink(destination);
          const source = i === 1 ? this.file : `${this.file}.${i - 1}`;
          if (await privateFile(source, true, this.bytes + 2048)) await rename(source, destination);
        }
      }
      const handle = await open(this.file, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
      try { const info = await handle.stat(); ensure(info.uid === uid() && !(info.mode & 0o077) && info.nlink === 1, 'insecure_log'); await handle.writeFile(line); }
      finally { await handle.close(); }
    }).catch(() => { this.failed = true; }).finally(() => { this.pending--; });
  }
  async flush() { await this.queue; ensure(!this.failed, 'log_storage_failed'); }
}
export async function launchctl(args) {
  ensure(process.platform === 'darwin', 'launchd_requires_macos');
  try { const result = await promisify(execFile)('/bin/launchctl', args, { timeout: 80_000, maxBuffer: 262144 }); return { code: 0, stdout: result.stdout, stderr: result.stderr }; }
  catch (error) { return { code: typeof error.code === 'number' ? error.code : -1, stdout: '', stderr: '' }; }
}
