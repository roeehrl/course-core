import { isMain } from './is-main.mjs';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { auditPublic } from './audit-public.mjs';
import { ROOT, ensure, readModule, requireFile, requireNode26, testDatabaseUrl } from './modules.mjs';
import { withCheckoutLock } from './orchestrate.mjs';
import { checkTestDatabase } from './check-test-database.mjs';
import { retryTransientCommand } from './network-retry.mjs';

const exec = promisify(execFile);
const platforms = Object.freeze({ x64: 'linux/amd64', arm64: 'linux/arm64' });
const dockerArchitecture = (arch) => ({ x86_64: 'x64', amd64: 'x64', aarch64: 'arm64', arm64: 'arm64' })[arch];

export function requireHostedLinux(environment, platform) {
  ensure(platform === 'linux' && environment.GITHUB_ACTIONS === 'true' && environment.SANDBOX_RUNNER_ENVIRONMENT === 'github-hosted',
    'Root Docker qualification is restricted to GitHub-hosted Linux. Use the sandbox README for separate local qualification.');
}
export function selectSandboxImage(images, arch) {
  ensure(Object.hasOwn(platforms, arch), 'Sandbox CI requires a qualified x64 or arm64 architecture');
  const image = images?.[arch];
  ensure(typeof image === 'string' && /^python@sha256:[a-f0-9]{64}$/.test(image), 'Sandbox image must be the explicit digest-pinned Python image for this architecture');
  return { arch, image, platform: platforms[arch] };
}
export function verifyDockerServer(selection, server) {
  ensure(server.os === 'linux' && dockerArchitecture(server.architecture) === selection.arch,
    'Docker server must be Linux on the selected native architecture; emulated or mismatched qualification is not accepted');
}
export function verifySandboxImage(selection, metadata) {
  verifyDockerServer(selection, metadata);
  const suffix = selection.image.slice('python'.length);
  ensure(Array.isArray(metadata.repoDigests) && metadata.repoDigests.some((value) =>
    ['python', 'library/python', 'docker.io/python', 'docker.io/library/python'].some((name) => value === name + suffix)),
  'Inspected Docker image does not contain the selected qualified digest');
}

export async function requirePracticalBuild(directory) {
  await requireFile(path.join(directory, 'dist/main.js'), 'built API entry point; build the API before practical qualification');
  await requireFile(path.join(directory, 'qualification/practical-flow.ts'), 'API real-Postgres/real-Docker practical qualification');
}

/** `retry` overrides the bounded network retry of the explicit pull (scripts/network-retry.mjs).
 * The pull is by digest and the image is inspected afterwards, so a retried pull cannot
 * substitute other bytes; inspection and the test phases are never retried. */
export async function runDockerGate(action, selection, invoke, environment = {}, retry = {}) {
  ensure(['pull', 'test', 'api-practical'].includes(action), 'Use sandbox-ci.mjs pull, test, or api-practical');
  const database = action === 'api-practical' ? { TEST_DATABASE_URL: testDatabaseUrl(environment).href } : {};
  const server = JSON.parse(await invoke('docker', ['info', '--format', '{"os":{{json .OSType}},"architecture":{{json .Architecture}}}']));
  verifyDockerServer(selection, server);
  if (action === 'pull') {
    await retryTransientCommand(() => invoke('docker', ['pull', '--platform', selection.platform, selection.image]), { label: 'docker pull', ...retry });
  }
  // No pull is allowed in the test phase. A missing image is a hard failure.
  const metadata = JSON.parse(await invoke('docker', ['image', 'inspect', selection.image, '--format', '{"os":{{json .Os}},"architecture":{{json .Architecture}},"repoDigests":{{json .RepoDigests}}}']));
  verifySandboxImage(selection, metadata);
  if (action === 'test') await invoke('npm', ['--workspaces=false', 'run', 'test:docker'], { COURSE_SANDBOX_IMAGE: selection.image });
  if (action === 'api-practical') await invoke('npm', ['--workspaces=false', 'run', 'test:practical'], { COURSE_SANDBOX_IMAGE: selection.image, ...database });
}

export async function main(args = process.argv.slice(2)) {
  requireNode26();
  ensure(args.length === 1 && ['pull', 'test', 'api-practical'].includes(args[0]), 'Usage: node scripts/sandbox-ci.mjs <pull|test|api-practical>');
  requireHostedLinux(process.env, process.platform);
  const practical = args[0] === 'api-practical';
  if (practical) testDatabaseUrl();
  await withCheckoutLock(ROOT, async () => {
    await auditPublic(ROOT, practical ? ['api', 'sandbox'] : ['sandbox']);
    const sandbox = await readModule('sandbox');
    const module = practical ? await readModule('api') : sandbox;
    const entry = path.join(sandbox.directory, 'dist/index.js');
    await requireFile(entry, 'built sandbox image registry; run the root sandbox install/check first');
    await requireFile(path.join(sandbox.directory, 'test/docker.test.mjs'), 'sandbox real-Docker qualification suite');
    if (practical) {
      await requirePracticalBuild(module.directory);
      await checkTestDatabase();
    }
    const { QUALIFIED_IMAGES } = await import(pathToFileURL(entry).href);
    const selection = selectSandboxImage(QUALIFIED_IMAGES, process.arch);
    const scratch = await mkdtemp(path.join(tmpdir(), 'course-core-sandbox-ci-'));
    try {
      await writeFile(path.join(scratch, 'user.npmrc'), 'registry=https://registry.npmjs.org/\nignore-scripts=true\naudit=false\nfund=false\nworkspaces=false\n');
      await writeFile(path.join(scratch, 'global.npmrc'), '');
      const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG'].filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
      Object.assign(env, {
        PATH: `${path.dirname(process.execPath)}${path.delimiter}${env.PATH ?? ''}`,
        CI: 'true', NPM_CONFIG_USERCONFIG: path.join(scratch, 'user.npmrc'),
        NPM_CONFIG_GLOBALCONFIG: path.join(scratch, 'global.npmrc'), NPM_CONFIG_CACHE: path.join(scratch, 'cache'),
        NPM_CONFIG_IGNORE_SCRIPTS: 'true', NPM_CONFIG_WORKSPACES: 'false',
      });
      const invoke = async (command, arguments_, extraEnv = {}) => {
        const result = await exec(command, arguments_, {
          cwd: module.directory, env: { ...env, ...extraEnv }, timeout: 300_000, maxBuffer: 8 * 1024 * 1024,
        }).catch((error) => {
          if (command === 'npm') process.stderr.write(error.stdout ?? '');
          // The output is kept only so a network-class pull failure can be classified and retried.
          throw Object.assign(new Error(`${command} ${arguments_[0]} failed (${error.code ?? 'unknown'}); Docker qualification did not pass`),
            { output: `${error.stderr ?? ''}\n${error.stdout ?? ''}` });
        });
        if (command === 'npm') process.stdout.write(result.stdout);
        return result.stdout;
      };
      if (args[0] === 'pull') console.log(`Explicitly pulling ${selection.platform} ${selection.image}`);
      await runDockerGate(args[0], selection, invoke, practical ? process.env : {});
      console.log(args[0] === 'pull' ? `Sandbox image prepared and inspected: ${selection.image}`
        : practical ? `API practical qualification passed with real Postgres and ${selection.platform} Docker: ${selection.image}`
          : `Real Docker qualification passed for ${selection.platform}: ${selection.image}`);
    } finally { await rm(scratch, { recursive: true, force: true }); }
  });
}
if (isMain(import.meta.url)) {
  main().catch((error) => { console.error(`Sandbox CI gate failed: ${error.message}`); process.exitCode = 1; });
}
