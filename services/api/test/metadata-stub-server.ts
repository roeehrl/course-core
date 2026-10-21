import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo, Socket } from "node:net";

/** One scripted answer of the loopback stub. `hang` accepts the request and never answers. */
export type StubReply =
  | { status: number; body: unknown; contentType?: string }
  | { hang: true };
export interface StubRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
}

/**
 * A loopback HTTP server standing in for a provider's metadata endpoint. Adapters keep their
 * fixed public URL; `fetch` rewrites only the origin to this server, so the real HTTP
 * client, status codes, headers and bodies are exercised without reaching a provider.
 */
export async function metadataStub(reply: (request: StubRequest) => StubReply) {
  const requests: StubRequest[] = [],
    sockets = new Set<Socket>();
  const server = createServer((req, res) => {
    const request = {
      method: req.method ?? "",
      path: req.url ?? "",
      headers: req.headers,
    };
    requests.push(request);
    const answer = reply(request);
    if ("hang" in answer) return;
    res.writeHead(answer.status, {
      "content-type": answer.contentType ?? "application/json",
    });
    res.end(
      typeof answer.body === "string"
        ? answer.body
        : JSON.stringify(answer.body),
    );
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", resolve),
  );
  const port = (server.address() as AddressInfo).port;
  const viaStub: typeof fetch = (input, init) => {
    const url = new URL(
      input instanceof Request ? input.url : String(input),
    );
    return fetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, init);
  };
  return {
    fetch: viaStub,
    requests,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Error bodies in the shape the Gemini API returns (google.rpc.Status with ErrorInfo). */
export const googleError = (
  code: number,
  status: string,
  reason?: string,
  message = "Synthetic provider error",
) => ({
  error: {
    code,
    message,
    status,
    ...(reason
      ? {
          details: [
            {
              "@type": "type.googleapis.com/google.rpc.ErrorInfo",
              reason,
              domain: "googleapis.com",
            },
          ],
        }
      : {}),
  },
});
export const googleModels = {
  models: [
    {
      name: "models/public-text-model",
      displayName: "Public test model",
      inputTokenLimit: 131072,
      outputTokenLimit: 4000,
      supportedGenerationMethods: ["generateContent"],
    },
    {
      name: "models/public-embedding-model",
      displayName: "Public embedding model",
      supportedGenerationMethods: ["embedContent"],
    },
  ],
};
