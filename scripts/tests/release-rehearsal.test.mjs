import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { ROOT, testDatabaseUrl } from '../modules.mjs';
import { rehearse } from '../release-compat.mjs';

// Real PostgreSQL rehearsal of the release migration/rollback path on small
// synthetic repositories. Requires TEST_DATABASE_URL (a disposable database);
// it fails rather than skips without one. PG_BIN may name the client tool directory.
const exec = promisify(execFile);
const git = (cwd, ...args) => exec('git', ['-C', cwd, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: 'rehearsal', GIT_AUTHOR_EMAIL: 'rehearsal@example.invalid',
  GIT_COMMITTER_NAME: 'rehearsal', GIT_COMMITTER_EMAIL: 'rehearsal@example.invalid' } });
const migrations = 'services/api/migrations';

/** A repository whose v1.0.0 tag has the real first migration; the working tree is the candidate. */
async function repository(candidateFiles) {
  const root = await mkdtemp(path.join(tmpdir(), 'rehearsal-repo-'));
  await mkdir(path.join(root, migrations), { recursive: true });
  await git(root, 'init', '-q');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ version: '1.0.0' }));
  await copyFile(path.join(ROOT, migrations, '001_initial.sql'), path.join(root, migrations, '001_initial.sql'));
  await git(root, 'add', '.'); await git(root, 'commit', '-qm', 'previous'); await git(root, 'tag', 'v1.0.0');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ version: '1.1.0' }));
  for (const [name, text] of Object.entries(candidateFiles)) await writeFile(path.join(root, migrations, name), text);
  return root;
}
async function attempt(files) {
  const root = await repository(files);
  try { return await rehearse(root, { pgBin: process.env.PG_BIN }); } finally { await rm(root, { recursive: true, force: true }); }
}

test('rehearsal requires a disposable database', () => { assert.ok(testDatabaseUrl()); });

test('an additive candidate migrates forward, rolls back exactly and upgrades again', async () => {
  const result = await attempt({ '002_additive.sql': 'ALTER TABLE app_users ADD COLUMN locale text;\nCREATE TABLE rehearsal_notes (id uuid PRIMARY KEY);\n' });
  assert.equal(result.status, 'passed');
  assert.equal(result.previousTag, 'v1.0.0');
  assert.deepEqual(result.addedMigrations, ['002_additive.sql']);
  assert.deepEqual(result.steps, ['previous_migrated', 'seeded', 'backed_up', 'candidate_migrated', 'candidate_idempotent', 'rolled_back', 'previous_verified', 'upgraded_again']);
});

test('a candidate that drops a column or deletes rows fails the rehearsal', async () => {
  await assert.rejects(attempt({ '002_drop.sql': 'ALTER TABLE workspaces DROP COLUMN title;\n' }), /column workspaces\.title was dropped/);
  await assert.rejects(attempt({ '002_delete.sql': 'DELETE FROM memberships WHERE role = \'learner\';\n' }), /table memberships has 1 rows, expected 2/);
});

test('a broken candidate migration or an edited released migration fails the rehearsal', async () => {
  await assert.rejects(attempt({ '002_broken.sql': 'ALTER TABLE missing_table ADD COLUMN x text;\n' }), /Migration 002_broken\.sql failed/);
  await assert.rejects(attempt({ '001_initial.sql': '-- edited after release\n' }), /Applied migration changed: 001_initial\.sql/);
});
