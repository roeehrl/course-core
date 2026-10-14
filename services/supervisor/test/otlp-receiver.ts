import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface ReceivedExport { path: string; headers: IncomingHttpHeaders; raw: string; body: any }
export interface ExportedSpan { name: string; traceId: string; spanId: string; parentSpanId?: string; kind: number;
  attributes: Record<string, unknown>; status?: { code?: number; message?: string }; resource: Record<string, unknown> }

function value(input: any): unknown {
  if (!input || typeof input !== 'object') return input;
  if ('stringValue' in input) return input.stringValue;
  if ('intValue' in input) return Number(input.intValue);
  if ('doubleValue' in input) return input.doubleValue;
  if ('boolValue' in input) return input.boolValue;
  return input;
}
export const attributes = (list: any[] | undefined) => Object.fromEntries((list ?? []).map(item => [item.key, value(item.value)]));

/** In-process OTLP/HTTP JSON receiver for tests. Records every request it receives. */
export async function otlpReceiver() {
  const received: ReceivedExport[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown = null; try { body = JSON.parse(raw); } catch { /* recorded raw */ }
      received.push({ path: request.url ?? '', headers: request.headers, raw, body });
      response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url, received,
    spans(): ExportedSpan[] {
      return received.filter(r => r.path === '/v1/traces').flatMap(r => (r.body?.resourceSpans ?? []).flatMap((rs: any) =>
        (rs.scopeSpans ?? []).flatMap((ss: any) => (ss.spans ?? []).map((span: any) => ({ ...span, kind: span.kind,
          attributes: attributes(span.attributes), resource: attributes(rs.resource?.attributes) })))));
    },
    metrics(): { name: string; points: Record<string, unknown>[]; resource: Record<string, unknown> }[] {
      return received.filter(r => r.path === '/v1/metrics').flatMap(r => (r.body?.resourceMetrics ?? []).flatMap((rm: any) =>
        (rm.scopeMetrics ?? []).flatMap((sm: any) => (sm.metrics ?? []).map((metric: any) => {
          const data = metric.sum ?? metric.histogram ?? metric.gauge ?? {};
          return { name: metric.name, points: (data.dataPoints ?? []).map((p: any) => attributes(p.attributes)), resource: attributes(rm.resource?.attributes) };
        }))));
    },
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}
