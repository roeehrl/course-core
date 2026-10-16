import { createHash, createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A small in-process S3-compatible endpoint for tests: path-style buckets, PUT/GET/DELETE/HEAD,
 * single byte ranges, If-Match and Signature Version 4 checking (written here independently of
 * the client). It never touches a network beyond loopback. Real MinIO qualification is
 * `npm run test:object-store` (qualification/object-store-flow.ts).
 */
export interface FakeObject { body: Buffer; etag: string; contentType: string }
export class FakeS3 {
  readonly objects = new Map<string, FakeObject>();
  readonly requests: { method: string; path: string; signed: boolean }[] = [];
  /** Answers the next matching requests with this status instead of serving them. */
  readonly failures: { method: string; status: number }[] = [];
  #server: Server | undefined;
  endpoint = '';
  constructor(readonly bucket: string, readonly accessKeyId: string, readonly secretAccessKey: string, readonly region = 'us-east-1') {}
  async start() {
    this.#server = createServer((request, response) => {
      void this.#handle(request).then(({ status, headers, body }) => {
        response.writeHead(status, headers); response.end(body);
      }, () => { response.writeHead(500); response.end(); });
    });
    await new Promise<void>(resolve => this.#server!.listen(0, '127.0.0.1', resolve));
    this.endpoint = `http://127.0.0.1:${(this.#server!.address() as AddressInfo).port}`;
    return this;
  }
  async stop() { await new Promise<void>(resolve => this.#server ? this.#server.close(() => resolve()) : resolve()); }
  key(path: string) { return path.slice(`/${this.bucket}/`.length); }
  #verify(request: IncomingMessage, payloadHash: string) {
    const authorization = request.headers.authorization ?? '';
    const match = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([a-z0-9;-]+), Signature=([a-f0-9]{64})$/.exec(authorization);
    if (!match || match[1] !== this.accessKeyId || match[3] !== this.region) return false;
    const amzDate = String(request.headers['x-amz-date'] ?? '');
    if (amzDate.slice(0, 8) !== match[2] || request.headers['x-amz-content-sha256'] !== payloadHash) return false;
    const names = match[4]!.split(';');
    const canonicalHeaders = names.map(name => `${name}:${String(request.headers[name] ?? '').trim()}\n`).join('');
    const url = new URL(request.url ?? '/', 'http://placeholder');
    const canonical = [request.method, url.pathname, '', canonicalHeaders, match[4], payloadHash].join('\n');
    const toSign = ['AWS4-HMAC-SHA256', amzDate, `${match[2]}/${this.region}/s3/aws4_request`, createHash('sha256').update(canonical).digest('hex')].join('\n');
    let key = createHmac('sha256', 'AWS4' + this.secretAccessKey).update(match[2]!).digest();
    for (const part of [this.region, 's3', 'aws4_request']) key = createHmac('sha256', key).update(part).digest();
    return createHmac('sha256', key).update(toSign).digest('hex') === match[5];
  }
  async #handle(request: IncomingMessage): Promise<{ status: number; headers: Record<string, string>; body?: Buffer }> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks), path = new URL(request.url ?? '/', 'http://placeholder').pathname;
    const payloadHash = createHash('sha256').update(body).digest('hex');
    const signed = this.#verify(request, payloadHash);
    this.requests.push({ method: request.method ?? '', path, signed });
    if (!signed) return { status: 403, headers: {} };
    const failure = this.failures.findIndex(f => f.method === request.method);
    if (failure >= 0) return { status: this.failures.splice(failure, 1)[0]!.status, headers: {} };
    if (path === `/${this.bucket}`) return { status: request.method === 'HEAD' ? 200 : 405, headers: {} };
    if (!path.startsWith(`/${this.bucket}/`)) return { status: 404, headers: {} };
    const key = this.key(path), stored = this.objects.get(key);
    if (request.method === 'PUT') {
      const etag = `"${createHash('md5').update(body).digest('hex')}"`;
      this.objects.set(key, { body, etag, contentType: String(request.headers['content-type'] ?? '') });
      return { status: 200, headers: { etag } };
    }
    if (request.method === 'DELETE') { this.objects.delete(key); return { status: 204, headers: {} }; }
    if (request.method !== 'GET') return { status: 405, headers: {} };
    if (!stored) return { status: 404, headers: {} };
    if (request.headers['if-match'] && request.headers['if-match'] !== stored.etag) return { status: 412, headers: {} };
    const range = /^bytes=(\d+)-(\d+)$/.exec(String(request.headers.range ?? ''));
    if (range) {
      const start = Number(range[1]), end = Math.min(Number(range[2]), stored.body.length - 1);
      const part = stored.body.subarray(start, end + 1);
      return { status: 206, headers: { etag: stored.etag, 'content-length': String(part.length), 'content-range': `bytes ${start}-${end}/${stored.body.length}` }, body: part };
    }
    return { status: 200, headers: { etag: stored.etag, 'content-length': String(stored.body.length), 'content-type': stored.contentType }, body: stored.body };
  }
}
