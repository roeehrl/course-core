// Builds the self-host image contents inside the Docker build stage: every module the
// API needs (and the learner/admin web exports it serves) in dependency order, with the
// same locked, script-free npm installs as `node scripts/orchestrate.mjs install api`.
// The orchestrator itself also audits the git checkout, which a Docker build context
// does not carry; CI runs that audit on the same commit.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { ROOT, MODULES, ensure, requireNode26 } from '../../scripts/modules.mjs';
import { resolveModuleGraph } from '../../scripts/dependency-graph.mjs';

requireNode26();
const { order } = await resolveModuleGraph(['api', 'supervisor'], { extraRoots: ['learner', 'admin'] });
const env = {
  ...process.env, CI: 'true', EXPO_NO_TELEMETRY: '1', NPM_CONFIG_IGNORE_SCRIPTS: 'true', NPM_CONFIG_WORKSPACES: 'false',
  NPM_CONFIG_AUDIT: 'false', NPM_CONFIG_FUND: 'false', NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org/',
};
for (const name of order) {
  const directory = path.join(ROOT, MODULES[name].directory);
  for (const args of [['ci', '--ignore-scripts'], ['run', MODULES[name].build]]) {
    console.log(`[${MODULES[name].directory}] npm ${args.join(' ')}`);
    const result = spawnSync('npm', ['--workspaces=false', ...args], { cwd: directory, env, stdio: 'inherit' });
    ensure(result.status === 0, `${MODULES[name].directory}: npm ${args.join(' ')} failed`);
  }
}
