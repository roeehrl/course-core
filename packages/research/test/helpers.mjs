import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:https';
import { once } from 'node:events';

export const publicIP = { address: '93.184.215.14', family: 4 };
export const request = { policyId: 'public-reading', topicId: 'ordering', sourceId: 'guide' };
export function policy() {
  return { id: request.policyId, revision: 1, approvedBy: 'author-1', approvalId: 'approval-1', expiresAt: new Date(Date.now() + 3600000).toISOString(),
    topics: [{ id: 'ordering', description: 'Compare and order values using independent examples.' }], allowedHosts: ['source.example', 'other.example'],
    sources: [{ id: 'guide', kind: 'web', url: 'https://source.example/guide', topicIds: ['ordering'],
      attribution: { trust: 'untrusted_provider_metadata', providerName: 'Synthetic catalog', requiredNotice: 'Credit the original author.', searchRank: 1 } }] };
}
export function authorizer(saved = policy(), role = 'author') {
  const credential = randomUUID();
  return { credential, authorize: async token => {
    if (token !== credential) throw new Error('PRIVATE_AUTH_ERROR_CANARY');
    return { actorId: 'author-1', role, policy: saved };
  } };
}
export const html = '<!doctype html><html><head><title>Ordering values</title></head><body><main><h1>Compare values</h1><p>Choose the smaller value by comparing each pair independently.</p></main></body></html>';
export function hop(overrides = {}) {
  return { status: 200, body: Buffer.from(html), mediaType: 'text/html', charset: 'utf-8', address: publicIP, ...overrides };
}
/** Disposable TLS material is generated per test process and removed afterwards;
 * there is no committed private key, provider credential or external listener. */
export async function loopback(handler) {
  const directory = await mkdtemp(join(tmpdir(), 'course-research-tls-'));
  try {
    const generated = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1',
      '-subj', '/CN=source.example', '-addext', 'subjectAltName=DNS:source.example', '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem')], { encoding: 'utf8', stdio: 'ignore' });
    if (generated.status !== 0) throw new Error('OpenSSL is required for the real TLS loopback tests.');
    const key = await readFile(join(directory, 'key.pem')), ca = await readFile(join(directory, 'cert.pem')), seen = [];
    const server = createServer({ key, cert: ca }, (req, res) => { seen.push({ url: req.url, headers: req.headers, servername: req.socket.servername }); handler(req, res); });
    const sockets = new Set();
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    server.on('tlsClientError', () => {});
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    return { server, seen, ca: ca.toString(), port: server.address().port, async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true });
    } };
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}
