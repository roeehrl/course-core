import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { SkipScanner, requireNothingSkipped } from './test-skips.mjs';

const exec = promisify(execFile);
const script = fileURLToPath(new URL('./test-skips.mjs', import.meta.url));
const scan = (...chunks) => { const scanner = new SkipScanner(); for (const chunk of chunks) scanner.push(chunk); return scanner.end(); };

// Summaries as the pinned runners print them (node 26, Vitest 5.0.4, Playwright 1.64.0 list reporter).
const NODE_CLEAN = 'ℹ tests 3\nℹ suites 0\nℹ pass 3\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\nℹ duration_ms 58.8\n';
const NODE_SKIP = 'ℹ tests 3\nℹ suites 0\nℹ pass 1\nℹ fail 0\nℹ cancelled 0\nℹ skipped 1\nℹ todo 1\n';
const VITEST_CLEAN = ' \u001b[2mTest Files \u001b[22m \u001b[1m\u001b[32m12 passed\u001b[39m\u001b[22m\u001b[90m (12)\u001b[39m\n      Tests  140 passed (140)\n   Duration  9.2s\n';
const VITEST_SKIP = ' Test Files  1 passed | 1 skipped (2)\n      Tests  1 passed | 3 skipped | 1 todo (5)\n';
const PLAYWRIGHT_CLEAN = '  ✓  1 p/a.spec.ts:2:1 › runs (3ms)\n\n  14 passed (1.2m)\n';
const PLAYWRIGHT_SKIP = '  -  2 p/a.spec.ts:3:1 › skipped\n\n  2 skipped\n  1 passed (292ms)\n';

test('clean summaries from node:test, Vitest and Playwright pass', () => {
  for (const output of [NODE_CLEAN, VITEST_CLEAN, PLAYWRIGHT_CLEAN, NODE_CLEAN + VITEST_CLEAN]) {
    const result = scan(output);
    assert.ok(result.summaries > 0);
    assert.doesNotThrow(() => requireNothingSkipped(result));
  }
});

test('a skipped, todo, fixme or not-run test fails, in any runner and across chunk boundaries', () => {
  assert.deepEqual(scan(NODE_SKIP), { summaries: 1, skipped: 1, todo: 1, notRun: 0 });
  assert.deepEqual(scan(VITEST_SKIP), { summaries: 1, skipped: 3, todo: 1, notRun: 0 });
  assert.deepEqual(scan(PLAYWRIGHT_SKIP), { summaries: 1, skipped: 2, todo: 0, notRun: 0 });
  assert.deepEqual(scan('  3 failed\n  1 did not run\n  2 passed (4s)\n'), { summaries: 1, skipped: 0, todo: 0, notRun: 1 });
  // A summary line split across stream chunks is still read.
  assert.deepEqual(scan(NODE_CLEAN, 'ℹ tests 2\nℹ ski', 'pped 1\n'), { summaries: 2, skipped: 1, todo: 0, notRun: 0 });
  for (const output of [NODE_SKIP, VITEST_SKIP, PLAYWRIGHT_SKIP, NODE_CLEAN + PLAYWRIGHT_SKIP])
    assert.throws(() => requireNothingSkipped(scan(output), 'suite'), /suite: .*test-level skips/);
});

test('output without any runner summary fails rather than passing unseen', () => {
  assert.throws(() => requireNothingSkipped(scan('build ok\nskipped 2 optional steps\n')), /no test runner summary/);
});

test('the wrapper runs a real node:test suite and fails it on a skip, keeping a failing exit code', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'test-skips-'));
  try {
    const clean = path.join(directory, 'clean.test.mjs'), skipped = path.join(directory, 'skipped.test.mjs'), failing = path.join(directory, 'failing.test.mjs');
    await writeFile(clean, "import test from 'node:test';\ntest('runs', () => {});\n");
    await writeFile(skipped, "import test from 'node:test';\ntest('runs', () => {});\ntest('does not apply here', { skip: 'no database' }, () => {});\n");
    await writeFile(failing, "import test from 'node:test';\ntest('fails', () => { throw new Error('no'); });\n");
    // Without NODE_TEST_CONTEXT the child runs as a top-level test run, as it does in CI.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const run = file => exec(process.execPath, [script, '--', process.execPath, '--test', file], { env });
    assert.match((await run(clean)).stdout, /No skipped tests in 1 runner summary/);
    await assert.rejects(run(skipped), error => error.code === 1 && /1 skipped, 0 todo/.test(error.stderr));
    await assert.rejects(run(failing), error => error.code === 1 && /failed/.test(error.stderr));
    await assert.rejects(exec(process.execPath, [script, process.execPath]), /Use: node scripts\/test-skips\.mjs/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
