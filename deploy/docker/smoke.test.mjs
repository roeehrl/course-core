import assert from 'node:assert/strict';
import test from 'node:test';
import { runSmoke } from './smoke.mjs';

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
