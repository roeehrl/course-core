import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { ROOT } from './modules.mjs';

const exec = promisify(execFile);
const doc = await readFile(path.join(ROOT, 'docs/threat-model.md'), 'utf8');
const tracked = (await exec('git', ['-C', ROOT, 'ls-files', '-z'], { maxBuffer: 64 * 1024 * 1024 })).stdout.split('\0').filter(Boolean);

test('the threat model covers authentication, tenant retrieval, generated code, prompt injection and supply chain', async () => {
  const headings = [...doc.matchAll(/^#{2,3} (.+)$/gm)].map(match => match[1]);
  for (const required of ['Authentication', 'Authorization and tenant isolation', 'Prompt injection and generated content', 'Generated and learner code',
    'Course packages and installers', 'Telemetry and logs', 'Supply chain', 'Summary of residual risks'])
    assert.ok(headings.includes(required), `threat model section ${required}`);
  // Every threat table row names the mitigation in code and the residual risk.
  for (const row of doc.split('\n').filter(line => /^\| [^-|]/.test(line) && !line.startsWith('| Threat |')))
    assert.equal(row.split(' | ').length, 3, `three columns: ${row.slice(0, 80)}`);
  assert.match(await readFile(path.join(ROOT, 'SECURITY.md'), 'utf8'), /\(docs\/threat-model\.md\)/, 'SECURITY.md links the threat model');
});

test('every mitigation code reference still names a tracked file and lines that exist', async () => {
  const lineCounts = new Map();
  const lines = async file => {
    if (!lineCounts.has(file)) lineCounts.set(file, (await readFile(path.join(ROOT, file), 'utf8')).split('\n').length);
    return lineCounts.get(file);
  };
  const references = [...doc.matchAll(/`([A-Za-z0-9_./-]+\.(?:ts|tsx|mjs|js|sql|yml|json|py)):(\d+)(?:-(\d+))?`/g)];
  assert.ok(references.length >= 50, 'the threat model cites code');
  const problems = [];
  for (const [, name, start, end] of references) {
    // Short references (`auth.ts:29`) use a basename that is unique among tracked sources.
    const candidates = name.includes('/') ? tracked.filter(file => file === name) : tracked.filter(file => path.posix.basename(file) === name && !file.includes('/test/'));
    if (candidates.length === 0) { problems.push(`${name}: no tracked file`); continue; }
    const last = Number(end ?? start);
    if (Number(start) < 1 || last < Number(start)) { problems.push(`${name}:${start}-${end}: reversed range`); continue; }
    const fits = await Promise.all(candidates.map(async file => last <= await lines(file)));
    if (!fits.some(Boolean)) problems.push(`${name}:${start}${end ? `-${end}` : ''}: past the end of ${candidates.join(', ')}`);
  }
  assert.deepEqual(problems, []);
});
