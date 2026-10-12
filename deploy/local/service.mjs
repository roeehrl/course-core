import { constants } from 'node:fs';
import { lstat, mkdir, realpath, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { parseArguments, repositoryRoot, loadConfiguration } from './pilot.mjs';
import { PilotError, ensure, absolute, privateDirectory, privateJson, privateFile, writePrivate, mutex,
  hash, uid, control, ownerRecord, launchctl, delay } from './runtime.mjs';

const launcher = fileURLToPath(new URL('./pilot.mjs', import.meta.url));
function labelFor(root, state, installationId) { return `com.coursecore.pilot.${hash(`${uid()}\0${root}\0${state}`).slice(0, 16)}.${installationId.replaceAll('-', '')}`; }
function xml(value) { return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;'); }
function encode(value) {
  if (typeof value === 'string') return `<string>${xml(value)}</string>`;
  if (typeof value === 'boolean') return value ? '<true/>' : '<false/>';
  if (Number.isSafeInteger(value)) return `<integer>${value}</integer>`;
  if (Array.isArray(value)) return `<array>${value.map(encode).join('')}</array>`;
  return `<dict>${Object.entries(value).map(([key, item]) => `<key>${xml(key)}</key>${encode(item)}`).join('')}</dict>`;
}
export function launchdDefinition({ root, state, installationId, node = process.execPath }) {
  const label = labelFor(root, state, installationId);
  return { Label: label, ProgramArguments: [node, launcher, 'start', '--root', root, '--state', state], WorkingDirectory: root,
    EnvironmentVariables: { PATH: [path.dirname(node), '/usr/bin', '/bin', '/usr/sbin', '/sbin', '/usr/local/bin', '/opt/homebrew/bin'].join(':'),
      HOME: homedir(), CORE_PILOT_MANAGED_LABEL: label, CORE_PILOT_INSTALLATION_ID: installationId },
    RunAtLoad: true, KeepAlive: { SuccessfulExit: false }, ThrottleInterval: 30, ExitTimeOut: 80,
    ProcessType: 'Background', LowPriorityIO: true, AbandonProcessGroup: false,
    SoftResourceLimits: { NumberOfFiles: 1024, Core: 0 }, HardResourceLimits: { NumberOfFiles: 4096, Core: 0 },
    StandardOutPath: '/dev/null', StandardErrorPath: '/dev/null' };
}
export function plist(definition) { return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">${encode(definition)}</plist>\n`; }
async function agentsDirectory(input, create) {
  const directory = absolute(input);
  if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  ensure(info.isDirectory() && !info.isSymbolicLink() && info.uid === uid() && !(info.mode & 0o022), 'insecure_agents_directory');
  return realpath(directory);
}
export function manager(options = {}) {
  const rootInput = options.root ?? repositoryRoot, stateInput = options.state ?? path.join(repositoryRoot, '.local/pilot');
  const agentsInput = options.agentsDirectory ?? path.join(homedir(), 'Library/LaunchAgents');
  const run = options.launchctl ?? launchctl;
  const domain = `gui/${uid()}`;
  async function context() { return { root: await realpath(absolute(rootInput)), state: await privateDirectory(stateInput) }; }
  async function receipt({ root, state }) {
    const found = await privateJson(path.join(state, 'installation.json'), true); if (!found) return null;
    const r = found.value;
    ensure(r?.schemaVersion === 1 && r.uid === uid() && r.root === root && r.state === state
      && /^[a-f0-9-]{36}$/.test(r.installationId) && r.label === labelFor(root, state, r.installationId)
      && typeof r.node === 'string' && r.node === absolute(r.node) && r.launcher === launcher
      && r.agentsDirectory === await agentsDirectory(agentsInput, false)
      && r.plistPath === path.join(r.agentsDirectory, `${r.label}.plist`), 'installation_ownership_mismatch');
    const file = await privateFile(r.plistPath);
    ensure(hash(file.text) === r.plistDigest && file.text === plist(launchdDefinition({ ...r, node: r.node })), 'installation_file_changed');
    return r;
  }
  async function registration(r) {
    // print's text is diagnostic, not an API or an identity source. Only its exit status is used.
    const value = await run(['print', `${domain}/${r.label}`]);
    if (value.code === 0) return 'loaded'; if (value.code === 113) return 'not_loaded'; return 'unknown';
  }
  async function pilot(state) {
    try { return await control(state, 'status'); }
    catch (error) { return { status: 'blocked', code: error instanceof PilotError ? error.code : 'pilot_status_unavailable' }; }
  }
  return {
    async status() {
      const c = await context(), r = await receipt(c);
      return { status: r ? 'installed' : 'not_installed', ...(r ? { label: r.label, registration: await registration(r) } : {}),
        pilot: await pilot(c.state), providerAcceptance: 'not_verified' };
    },
    async install() {
      ensure(process.platform === 'darwin' || options.launchctl, 'launchd_requires_macos');
      const c = await context(); await loadConfiguration(c.root, c.state);
      return mutex(c.state, 'installation.lock', async () => {
        const existing = await receipt(c);
        if (existing) {
          const state = await registration(existing); ensure(state !== 'unknown', 'registration_unavailable');
          if (state === 'loaded') return { status: 'already_installed', label: existing.label, registration: state, pilot: await pilot(c.state) };
          // No stop, replacement or implicit restart of a foreground owner is allowed.
          ensure(!await privateJson(path.join(c.state, 'owner.json'), true), 'existing_owner_requires_coordination');
          const result = await run(['bootstrap', domain, existing.plistPath]);
          ensure(result.code === 0 && await registration(existing) === 'loaded', 'registration_unconfirmed');
          return { status: 'installed', label: existing.label, registration: 'loaded', pilot: await pilot(c.state) };
        }
        ensure(!await privateJson(path.join(c.state, 'owner.json'), true), 'existing_owner_requires_coordination');
        for (const item of ['run.lock', 'control.sock', 'transition.lock']) {
          try { await lstat(path.join(c.state, item)); throw new PilotError('unreconciled_runtime_state'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        const directory = await agentsDirectory(agentsInput, true), installationId = randomUUID(), node = await realpath(process.execPath);
        const definition = launchdDefinition({ ...c, installationId, node });
        const r = { schemaVersion: 1, ...c, uid: uid(), node, launcher, installationId, label: definition.Label, agentsDirectory: directory,
          plistPath: path.join(directory, `${definition.Label}.plist`), plistDigest: hash(plist(definition)) };
        ensure(await registration(r) === 'not_loaded', 'label_not_proven_unused');
        // Exclusive creation; an unrelated plist is never overwritten or removed.
        await writePrivate(r.plistPath, plist(definition));
        await writePrivate(path.join(c.state, 'installation.json'), JSON.stringify(r));
        const bootstrapped = await run(['bootstrap', domain, r.plistPath]);
        // An uncertain bootstrap retains ownership receipts for a safe status/retry, never blind rollback.
        ensure(bootstrapped.code === 0 && await registration(r) === 'loaded', 'registration_unconfirmed');
        return { status: 'installed', label: r.label, registration: 'loaded', pilot: await pilot(c.state) };
      });
    },
    async uninstall() {
      ensure(process.platform === 'darwin' || options.launchctl, 'launchd_requires_macos');
      const c = await context();
      return mutex(c.state, 'installation.lock', async () => {
        const r = await receipt(c); if (!r) return { status: 'not_installed' };
        const registered = await registration(r); ensure(registered !== 'unknown', 'registration_unavailable');
        let preservedForeground = false;
        const status = await pilot(c.state);
        if (status.status === 'running' || status.status === 'starting') {
          if (status.managedBy?.label === r.label && status.managedBy?.installationId === r.installationId) {
            await control(c.state, 'stop');
            const until = Date.now() + 75_000;
            while (Date.now() < until && await privateJson(path.join(c.state, 'owner.json'), true)) await delay(200);
            ensure(!await privateJson(path.join(c.state, 'owner.json'), true), 'managed_stop_unconfirmed');
          } else preservedForeground = true;
        } else if (await privateJson(path.join(c.state, 'owner.json'), true)) {
          // Never authenticate a stale PID by launchctl diagnostics or kill it ourselves.
          throw new PilotError('runtime_ownership_requires_review');
        }
        if (registered === 'loaded') {
          const result = await run(['bootout', `${domain}/${r.label}`]);
          ensure([0, 113].includes(result.code), 'unregistration_unconfirmed');
        }
        ensure(await registration(r) === 'not_loaded', 'unregistration_unconfirmed');
        await receipt(c); // Recheck the exact file immediately before removing only our plist/receipt.
        await unlink(r.plistPath); await unlink(path.join(c.state, 'installation.json'));
        return { status: 'uninstalled', preservedForeground, configurationAndData: 'preserved' };
      });
    },
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  Promise.resolve().then(async () => {
    const args = parseArguments(process.argv.slice(2), ['install', 'status', 'uninstall']);
    const result = await manager(args)[args.mode](); process.stdout.write(JSON.stringify(result) + '\n');
  }).catch(error => {
    process.stderr.write(JSON.stringify({ status: 'blocked', code: error instanceof PilotError ? error.code : 'service_operation_failed' }) + '\n'); process.exitCode = 1;
  });
}
