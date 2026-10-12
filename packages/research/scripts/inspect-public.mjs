import assert from 'node:assert/strict';
import { createSourceInspector } from '../dist/node.js';

assert(process.argv.length === 2, 'This diagnostic accepts no arbitrary URLs or queries.');
const policy = {
  id: 'public-diagnostic', revision: 1, approvedBy: 'diagnostic-author', approvalId: 'diagnostic-fixed-source',
  expiresAt: new Date(Date.now() + 60000).toISOString(),
  topics: [{ id: 'array-map', description: 'The public JavaScript Array.map reference.' }],
  allowedHosts: ['developer.mozilla.org'],
  sources: [{ id: 'mdn-array-map', kind: 'web', url: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/map', topicIds: ['array-map'] }],
};
const inspector = createSourceInspector(async credential => {
  assert.equal(credential, 'public-diagnostic');
  return { actorId: 'diagnostic-author', role: 'author', policy };
}, { maxConcurrent: 1, limits: { maxBytes: 524288, totalMs: 10000, maxRedirects: 2 } });
try {
  const result = await inspector.inspect('public-diagnostic', { policyId: policy.id, topicId: 'array-map', sourceId: 'mdn-array-map' });
  assert.equal(result.state, 'unreviewed');
  assert(result.content.text.length > 100);
  console.log(JSON.stringify({ state: result.state, title: result.title, url: result.provenance.finalUrl,
    bytes: result.provenance.bytes, textCharacters: result.content.text.length, truncated: result.content.truncated,
    contentDigest: result.content.digest, bodyDigest: result.provenance.bodyDigest,
    fetchedAt: result.provenance.fetchedAt, publication: 'not_authorized' }));
} catch (error) {
  console.error(JSON.stringify({ state: 'failed', code: error?.code ?? 'inspection_failed' }));
  process.exitCode = 1;
}
