import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

test('verification CLI detects an aliased entrypoint and importing it does not run the CLI', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'course-entrypoint-'));
  try {
    const original = path.join(directory, 'original.mjs'), alias = path.join(directory, 'alias.mjs');
    await writeFile(original, `import {isMain} from ${JSON.stringify(new URL('./is-main.mjs', import.meta.url).href)}; if(isMain(import.meta.url)) console.log('executed');`);
    await symlink(original, alias);
    assert.equal(execFileSync(process.execPath, [alias], { encoding: 'utf8' }).trim(), 'executed');
    assert.equal(execFileSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(new URL(`file://${original}`).href)})`], { encoding: 'utf8' }), '');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
