import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runSmoke } from './smoke.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { maxBuffer: 64 * 1024 * 1024, ...options });
  assert.equal(result.status, 0, `${command} ${args[0]}: ${result.error ?? result.stderr}`);
  return result.stdout;
}

// Each builder really builds a context holding the local state that must never reach an image,
// with the repository's own .dockerignore. FROM scratch: nothing is pulled.
test('local state stays out of the build context on the legacy builder and on BuildKit', { timeout: 5 * 60_000 }, async () => {
  const context = await mkdtemp(path.join(process.env.COURSE_SMOKE_TMPDIR ?? tmpdir(), 'course-core-context-'));
  try {
    await cp(path.join(ROOT, '.dockerignore'), path.join(context, '.dockerignore'));
    await writeFile(path.join(context, 'Dockerfile'), 'FROM scratch\nCOPY . /context/\n');
    const sent = ['deploy/docker/compose.yaml', 'packages/x/.env.example', 'packages/x/index.js'];
    const kept = ['.git/HEAD', '.local/bin/temporal', 'node_modules/x/index.js', 'packages/x/.env', 'deploy/docker/.env', 'deploy/docker/.env.backup',
      'deploy/docker/course-files/hidden.json', 'deploy/docker/backups/snapshot/compose.env', 'deploy/docker/.ops/bootstrap.json'];
    for (const file of [...sent, ...kept]) {
      await mkdir(path.dirname(path.join(context, file)), { recursive: true });
      await writeFile(path.join(context, file), 'x');
    }
    for (const [builder, DOCKER_BUILDKIT] of [['legacy', '0'], ['buildkit', '1']]) {
      const image = `course-core-context-${randomBytes(4).toString('hex')}:${builder}`;
      run('docker', ['build', '-q', '-t', image, context], { env: { ...process.env, DOCKER_BUILDKIT } });
      try {
        const container = run('docker', ['create', image, '/none']).toString().trim();
        let archive;
        try { archive = run('docker', ['cp', `${container}:/context`, '-']); }
        finally { spawnSync('docker', ['rm', '-f', container], { stdio: 'ignore' }); }
        const files = run('tar', ['-tf', '-'], { input: archive }).toString().split('\n').filter(name => name && !name.endsWith('/')).map(name => name.replace(/^context\//, ''));
        assert.deepEqual(files.sort(), ['.dockerignore', 'Dockerfile', ...sent].sort(), builder);
      } finally { spawnSync('docker', ['rmi', '-f', image], { stdio: 'ignore' }); }
    }
  } finally { await rm(context, { recursive: true, force: true }); }
});

// Real Docker only: builds the image, starts the documented stack with the operations script and
// reaches it through the TLS proxy. A missing Docker daemon fails this test; it is never skipped.
test('the documented Docker stack grades code in sandboxes, supervises, backs up, upgrades and rolls back', { timeout: 75 * 60_000 }, async () => {
  const results = await runSmoke({ log: message => process.stderr.write(`${message}\n`) });
  assert.deepEqual(results, {
    upWithSupervision: true, teachingVerifierQualified: true, databasePublished: false, bootstrapped: true, supervisorReachesApi: true,
    health: true, hsts: true, learnerPage: true, adminPage: true, anonymousRefused: true, wrongPasswordRefused: true, signedIn: true,
    ownerSeesWorkspace: true, plainHttpRedirects: true, loopbackHttpServes: true, codePassGraded: true, codeFailGraded: true,
    sandboxQualifiedThroughGate: true, restartedAfterExit: true, dataSurvivedRestart: true, backupRestoreDrill: true,
    upgraded: true, brokenUpgradeRolledBack: true,
  });
});
