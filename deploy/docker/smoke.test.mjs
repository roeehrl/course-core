import assert from 'node:assert/strict';
import test from 'node:test';
import { runSmoke } from './smoke.mjs';

// Real Docker only: builds the image, starts the documented stack and reaches it through
// the TLS proxy. A missing Docker daemon fails this test; it is never skipped.
test('the documented Docker self-host stack comes up, signs an owner in over TLS and restarts after exit', { timeout: 45 * 60_000 }, async () => {
  const results = await runSmoke({ log: message => process.stderr.write(`${message}\n`) });
  assert.deepEqual(results, {
    databasePublished: false, bootstrapped: true, health: true, hsts: true, learnerPage: true, adminPage: true,
    anonymousRefused: true, wrongPasswordRefused: true, signedIn: true, ownerSeesWorkspace: true, plainHttpRedirects: true,
    restartedAfterExit: true, dataSurvivedRestart: true,
  });
});
