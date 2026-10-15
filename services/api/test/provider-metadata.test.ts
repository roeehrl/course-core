import { it, expect } from "vitest";
import {
  googleMetadataAdapter,
  boundedMetadataInspection,
} from "../src/provider-metadata.js";
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
  await expect(run).rejects.toThrow("metadata_cancelled");
});
