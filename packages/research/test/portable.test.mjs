import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFile } from 'node:fs/promises';

test('portable entrypoint loads without any transitive Node imports or networking', async () => {
  const hooks = registerHooks({ resolve(specifier, context, next) {
    if (specifier.startsWith('node:')) throw new Error(`Non-portable import: ${specifier}`);
    return next(specifier, context);
  } });
  try {
    const api = await import('@course-core/research');
    assert.equal(api.parseYouTubeId('aB_cD-eF123'), 'aB_cD-eF123');
    assert.equal(api.createSourceInspector, undefined);
    assert.equal(api.createSourceReviewer, undefined);
  } finally { hooks.deregister(); }
});
test('network entrypoint is Node-conditioned and private transport/test seams are not package exports', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(manifest.exports), ['.', './node']);
  assert.equal(manifest.exports['./node'].default, undefined); assert.equal(manifest.exports['./node'].browser, undefined);
  await assert.rejects(import('@course-core/research/internal/network'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
});
