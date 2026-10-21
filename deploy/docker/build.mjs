// Builds the self-host image contents inside the Docker build stage: every module the
// API needs (and the learner/admin web exports it serves) in dependency order, with the
// same locked, script-free npm installs as `node scripts/orchestrate.mjs install api`,
// including its npm retry policy (scripts/npm-retry.mjs): npm's per-request fetch retries,
// plus a whole-command retry of `npm ci` for network-class failures only.
// The orchestrator itself also audits the git checkout, which a Docker build context
// does not carry; CI runs that audit on the same commit.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { ROOT, MODULES, ensure, requireNode26 } from '../../scripts/modules.mjs';
import { resolveModuleGraph } from '../../scripts/dependency-graph.mjs';
import { npmCiWithRetry, npmFetchRetryEnv, spawnAndCapture } from '../../scripts/npm-retry.mjs';

requireNode26();
const { order } = await resolveModuleGraph(['api', 'supervisor'], { extraRoots: ['learner', 'admin'] });
const env = {
  ...process.env, CI: 'true', EXPO_NO_TELEMETRY: '1', NPM_CONFIG_IGNORE_SCRIPTS: 'true', NPM_CONFIG_WORKSPACES: 'false',
  NPM_CONFIG_AUDIT: 'false', NPM_CONFIG_FUND: 'false', NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org/',
  ...npmFetchRetryEnv(),
};
for (const name of order) {
  const { directory: label, build } = MODULES[name];
  const directory = path.join(ROOT, label);
  console.log(`[${label}] npm ci --ignore-scripts`);
  await npmCiWithRetry(directory, () => spawnAndCapture('npm', ['--workspaces=false', 'ci', '--ignore-scripts'], { cwd: directory, env }), { label });
  console.log(`[${label}] npm run ${build}`);
  const result = spawnSync('npm', ['--workspaces=false', 'run', build], { cwd: directory, env, stdio: 'inherit' });
  ensure(result.status === 0, `${label}: npm run ${build} failed`);
}
