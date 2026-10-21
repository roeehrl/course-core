import { it, expect } from "vitest";
import {
  googleMetadataAdapter,
  anthropicMetadataAdapter,
  boundedMetadataInspection,
  metadataFailureCode,
} from "../src/provider-metadata.js";
import {
  googleError,
  googleModels,
  metadataStub,
  type StubReply,
} from "./metadata-stub-server.js";
const key = "SYNTHETIC_PRIVATE_KEY_CANARY",
  model = (name: string) => ({
    name: "models/" + name,
    displayName: name,
    inputTokenLimit: 100000,
    outputTokenLimit: 4000,
    supportedGenerationMethods: ["generateContent"],
  });
it("only sends bounded metadata GET requests to the fixed Google origin; the key never enters a URL or result", async () => {
  const calls: { url: URL; init: RequestInit | undefined }[] = [];
  const adapter = googleMetadataAdapter(async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    return new Response(
      JSON.stringify(
        calls.length === 1
          ? {
              models: [model("one")],
              nextPageToken: "opaque&key=DO_NOT_INTERPRET",
            }
          : { models: [model("two")] },
      ),
      { headers: { "content-type": "application/json" } },
    );
  });
  const result = await adapter.inspect({
    getCredential: () => key,
    configuration: {},
    signal: new AbortController().signal,
  });
  expect(result.models.map((m) => m.remoteModel)).toEqual(["one", "two"]);
  expect(result.pages).toBe(2);
  expect(result.capabilitiesVerified).toBe(false);
  expect(result.generationPerformed).toBe(false);
  for (const call of calls) {
    expect(call.url.origin).toBe("https://generativelanguage.googleapis.com");
    expect(call.url.pathname).toBe("/v1beta/models");
    expect(call.url.searchParams.has("key")).toBe(false);
    expect(call.init?.method).toBe("GET");
    expect(call.init?.body).toBeUndefined();
    expect(call.init?.redirect).toBe("error");
    expect(new Headers(call.init?.headers).get("x-goog-api-key")).toBe(key);
  }
  expect(calls[1]!.url.searchParams.get("pageToken")).toBe(
    "opaque&key=DO_NOT_INTERPRET",
  );
  expect(JSON.stringify(result)).not.toContain(key);
});
it("rejects redirect/error/non-JSON/oversized/repeated pagination and key echo without exposing raw bodies", async () => {
  for (const response of [
    () => new Response("KEY_CANARY", { status: 302 }),
    () => new Response("{}", { headers: { "content-type": "text/plain" } }),
    () =>
      new Response("x".repeat(1048577), {
        headers: { "content-type": "application/json" },
      }),
    () =>
      new Response(
        JSON.stringify({ models: [{ ...model("one"), displayName: key }] }),
        { headers: { "content-type": "application/json" } },
      ),
  ])
    await expect(
      googleMetadataAdapter(async () => response()).inspect({
        getCredential: () => key,
        configuration: {},
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow();
  let calls = 0;
  await expect(
    googleMetadataAdapter(async () => {
      calls++;
      return new Response(
        JSON.stringify({
          models: [model("model-" + calls)],
          nextPageToken: "same",
        }),
        { headers: { "content-type": "application/json" } },
      );
    }).inspect({
      getCredential: () => key,
      configuration: {},
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow();
  expect(calls).toBe(2);
});
it("caps the catalogue at four pages and marks truncation rather than claiming all models were inspected", async () => {
  let calls = 0;
  const result = await googleMetadataAdapter(
    async () =>
      new Response(
        JSON.stringify({
          models: [model("model-" + ++calls)],
          nextPageToken: "page-" + calls,
        }),
        { headers: { "content-type": "application/json" } },
      ),
  ).inspect({
    getCredential: () => key,
    configuration: {},
    signal: new AbortController().signal,
  });
  expect(calls).toBe(4);
  expect(result.truncated).toBe(true);
});
it("host timeout bounds even an inspector that ignores cancellation", async () => {
  const controller = new AbortController(),
    run = boundedMetadataInspection(
      { label: "test", inspect: () => new Promise(() => {}) },
      {
        getCredential: () => key,
        configuration: {},
        signal: controller.signal,
      },
    );
  controller.abort();
  await expect(run).rejects.toThrow("PROVIDER_METADATA_TIMEOUT");
});

/** Runs one Google inspection against a loopback stub answering `reply`; returns the
 * catalogue or the failure code. */
async function againstStub(
  reply: StubReply,
  options: { key?: string; timeoutMs?: number } = {},
) {
  const stub = await metadataStub(() => reply);
  try {
    const catalog = await boundedMetadataInspection(
      googleMetadataAdapter(stub.fetch),
      {
        getCredential: () => options.key ?? key,
        configuration: {},
        signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
      },
    );
    return { catalog, requests: stub.requests };
  } catch (e) {
    return { code: metadataFailureCode(e), requests: stub.requests };
  } finally {
    await stub.close();
  }
}
it("reads a Google model list from a real HTTP server: GET /v1beta/models with the key only in its header", async () => {
  const { catalog, requests } = await againstStub({
    status: 200,
    body: googleModels,
  });
  expect(catalog?.models.map((m) => m.remoteModel)).toEqual([
    "public-text-model",
    "public-embedding-model",
  ]);
  expect(requests).toHaveLength(1);
  expect(requests[0]!.method).toBe("GET");
  expect(requests[0]!.path).toBe("/v1beta/models?pageSize=100");
  expect(requests[0]!.headers["x-goog-api-key"]).toBe(key);
});
it("names the cause of each refusal: invalid key, API not enabled, restricted key, permission, quota, server error", async () => {
  const cases: [StubReply, string][] = [
    [
      {
        status: 400,
        body: googleError(
          400,
          "INVALID_ARGUMENT",
          "API_KEY_INVALID",
          "API key not valid. Please pass a valid API key.",
        ),
      },
      "PROVIDER_METADATA_KEY_INVALID",
    ],
    [
      { status: 400, body: googleError(400, "INVALID_ARGUMENT", "API_KEY_EXPIRED") },
      "PROVIDER_METADATA_KEY_INVALID",
    ],
    [
      { status: 401, body: googleError(401, "UNAUTHENTICATED") },
      "PROVIDER_METADATA_KEY_INVALID",
    ],
    [
      {
        status: 403,
        body: googleError(403, "PERMISSION_DENIED", "SERVICE_DISABLED"),
      },
      "PROVIDER_METADATA_API_NOT_ENABLED",
    ],
    [
      {
        status: 403,
        body: googleError(403, "PERMISSION_DENIED", "API_KEY_SERVICE_BLOCKED"),
      },
      "PROVIDER_METADATA_KEY_RESTRICTED",
    ],
    [
      { status: 403, body: googleError(403, "PERMISSION_DENIED") },
      "PROVIDER_METADATA_PERMISSION_DENIED",
    ],
    [
      { status: 429, body: googleError(429, "RESOURCE_EXHAUSTED") },
      "PROVIDER_METADATA_RATE_LIMITED",
    ],
    [
      { status: 400, body: googleError(400, "FAILED_PRECONDITION") },
      "PROVIDER_METADATA_REJECTED",
    ],
    [
      { status: 500, body: googleError(500, "INTERNAL") },
      "PROVIDER_METADATA_UPSTREAM_ERROR",
    ],
    // A refusal without a structured body is still classified by its status alone.
    [
      { status: 429, body: "Too many requests", contentType: "text/plain" },
      "PROVIDER_METADATA_RATE_LIMITED",
    ],
    [
      { status: 200, body: "<html>", contentType: "text/html" },
      "PROVIDER_METADATA_INVALID",
    ],
  ];
  for (const [reply, code] of cases) {
    const result = await againstStub(reply);
    expect(result.code, JSON.stringify(reply)).toBe(code);
    expect(result.requests).toHaveLength(1);
  }
});
it("a server that never answers ends at the deadline as a timeout, and an unreachable host as a network failure", async () => {
  const started = Date.now(),
    result = await againstStub({ hang: true }, { timeoutMs: 300 });
  expect(result.code).toBe("PROVIDER_METADATA_TIMEOUT");
  expect(Date.now() - started).toBeLessThan(3000);
  const unreachable = googleMetadataAdapter(async (input, init) => {
    const stub = await metadataStub(() => ({ status: 200, body: {} }));
    const fetchVia = stub.fetch;
    await stub.close();
    return fetchVia(input, init);
  });
  await expect(
    boundedMetadataInspection(unreachable, {
      getCredential: () => key,
      configuration: {},
      signal: AbortSignal.timeout(5000),
    }).catch((e) => Promise.reject(Error(metadataFailureCode(e)))),
  ).rejects.toThrow("PROVIDER_METADATA_NETWORK");
});
it("a missing key and a key with spaces or invisible characters are told apart, without a request", async () => {
  for (const [value, code] of [
    ["", "PROVIDER_METADATA_CREDENTIAL_MISSING"],
    [key + " ", "PROVIDER_METADATA_CREDENTIAL_MALFORMED"],
    ["SYNTHETIC KEY", "PROVIDER_METADATA_CREDENTIAL_MALFORMED"],
    [key + "\u200b", "PROVIDER_METADATA_CREDENTIAL_MALFORMED"],
  ] as const) {
    const result = await againstStub(
      { status: 200, body: googleModels },
      { key: value },
    );
    expect(result.code).toBe(code);
    expect(result.requests).toHaveLength(0);
  }
});
it("classifies Anthropic Models API refusals by error type", async () => {
  for (const [status, type, code] of [
    [401, "authentication_error", "PROVIDER_METADATA_KEY_INVALID"],
    [403, "permission_error", "PROVIDER_METADATA_PERMISSION_DENIED"],
    [429, "rate_limit_error", "PROVIDER_METADATA_RATE_LIMITED"],
    [529, "overloaded_error", "PROVIDER_METADATA_UPSTREAM_ERROR"],
  ] as const) {
    const stub = await metadataStub(() => ({
      status,
      body: { type: "error", error: { type, message: "Synthetic" } },
    }));
    try {
      await expect(
        anthropicMetadataAdapter(stub.fetch)
          .inspect({
            getCredential: () => key,
            configuration: {},
            signal: AbortSignal.timeout(5000),
          })
          .catch((e) => Promise.reject(Error(metadataFailureCode(e)))),
      ).rejects.toThrow(code);
      expect(stub.requests[0]!.path).toBe("/v1/models?limit=100");
    } finally {
      await stub.close();
    }
  }
});
