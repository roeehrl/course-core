import { describe, expect, it, vi } from "vitest";
import { createFetchAdminClient } from "../src/client/fetchClient";
import { AdminError } from "../src/domain/errors";
import type { EvalStatus } from "../src/domain/providerEvals";
import { trimKey } from "../src/domain/providerSetup";
import {
  ProviderCostError,
  costErrorMessage,
  isDefinitive,
  usd,
  usdField,
} from "../src/domain/providerCosts";

// The provider setup, evaluation and cost ports stay available to API clients; the admin page
// itself uses the AI services port (aiServices.test.tsx).
const typed = ["SYNTHETIC", "TYPED", "KEY"].join("_");
const hex = (c: string) => c.repeat(64);
const uuid = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
const status = (): EvalStatus => ({
  suite: {
    id: "core.public-agent-evals",
    version: "1.0.0",
    digest: hex("a"),
    dialogues: 12,
    coverage: [
      { role: "companion", dialogues: 9 },
      { role: "supervisor", dialogues: 3 },
    ],
  },
  providerRevision: 3,
  gatedAtActivation: true,
  roles: [
    {
      role: "supervisor",
      strategy: "core.supervisor.plan",
      revisionDigest: hex("b"),
      covered: true,
      status: "not_evaluated",
      grandfathered: true,
      activatedBy: "unchanged",
    },
    {
      role: "companion",
      strategy: "core.companion.tutor",
      revisionDigest: hex("c"),
      covered: true,
      status: "passed",
      grandfathered: false,
      activatedBy: "passed",
      evaluatedAt: "2026-10-19T10:00:00.000Z",
    },
    {
      role: "media",
      strategy: "core.media.video",
      revisionDigest: hex("d"),
      covered: false,
      status: "not_covered",
      grandfathered: false,
      activatedBy: "not_covered",
    },
  ],
  results: [
    {
      id: uuid(1),
      role: "companion",
      revisionDigest: hex("c"),
      suiteDigest: hex("a"),
      mode: "live",
      outcome: "passed",
      actorId: uuid(9),
      createdAt: "2026-10-19T10:00:00.000Z",
      failed: [],
    },
    {
      id: uuid(2),
      role: "companion",
      revisionDigest: hex("e"),
      suiteDigest: hex("a"),
      mode: "scripted",
      outcome: "failed",
      actorId: uuid(9),
      createdAt: "2026-10-18T10:00:00.000Z",
      failed: [
        {
          dialogueId: "companion.terse.endpoint-answer",
          graders: ["hint_leakage", "diagnosis_restraint"],
        },
      ],
    },
  ],
  overrides: [
    {
      id: uuid(3),
      role: "supervisor",
      revisionDigest: hex("f"),
      suiteDigest: hex("a"),
      reason: "Reviewed transcripts by hand before the pilot.",
      actorId: uuid(8),
      createdAt: "2026-10-17T10:00:00.000Z",
    },
  ],
});

it("trims pasted keys of surrounding whitespace and invisible characters only", () => {
  expect(trimKey(" \t" + typed + "\r\n​﻿")).toBe(typed);
  expect(trimKey("A B")).toBe("A B");
  expect(trimKey("   ")).toBe("");
});

it("the fetch client posts key tests and keeps only PROVIDER_* reason codes from refusals", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          kind: "google",
          outcome: "ok",
          modelCount: 3,
          truncated: false,
          stored: false,
          generationPerformed: false,
        }),
        { headers: { "content-type": "application/json" } },
      ),
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "PROVIDER_CREDENTIAL_MALFORMED" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "SOME other text" }), {
        status: 429,
        headers: { "content-type": "application/json" },
      }),
    );
  const client = createFetchAdminClient({
    baseUrl: "/api/admin",
    fetch: fetcher,
  });
  const setupPort = client.providerSetup!;
  await expect(
    setupPort.testKey!("w", { kind: "google", key: typed }),
  ).resolves.toMatchObject({ outcome: "ok", modelCount: 3 });
  const [url, init] = fetcher.mock.calls[0]!;
  expect(url).toBe("/api/admin/workspaces/w/provider-setup/test-key");
  expect(init.method).toBe("POST");
  expect(JSON.parse(init.body)).toEqual({ kind: "google", key: typed });
  await expect(
    setupPort.testKey!("w", { kind: "google", key: "A B" }),
  ).rejects.toMatchObject({
    code: "validation",
    reason: "PROVIDER_CREDENTIAL_MALFORMED",
  });
  await expect(
    setupPort.testKey!("w", { kind: "google", key: typed }),
  ).rejects.toMatchObject({ code: "unavailable", reason: undefined });
});

it("converts exact USD strings to integer micro-USD without floating point", () => {
  expect(usdField("", 10)).toBeNull();
  expect(usdField("0.3", 1_000_000_000)).toBe(300_000);
  expect(usdField("0.0375", 1_000_000_000)).toBe(37_500);
  expect(usdField("1000", 1_000_000_000)).toBe(1_000_000_000);
  expect(() => usdField("1000.000001", 1_000_000_000)).toThrow(
    /largest amount/,
  );
  expect(() => usdField("0.1234567", 1_000_000_000)).toThrow(
    /six decimal places/,
  );
  expect(() => usdField("-1", 1_000_000_000)).toThrow();
  expect(() => usdField("1e3", 1_000_000_000)).toThrow();
  expect(usd(960)).toBe("0.000960");
  expect(usd("100960")).toBe("0.100960");
  expect(
    isDefinitive(new ProviderCostError("STALE_PROVIDER_PRICING_VERSION")),
  ).toBe(true);
  expect(isDefinitive(new ProviderCostError("UNAVAILABLE"))).toBe(false);
  expect(
    costErrorMessage(
      new ProviderCostError("PROVIDER_PRICING_EFFECTIVE_DATE_INVALID"),
    ),
  ).toMatch(/earlier than the version it replaces/);
});

describe("provider ports", () => {
  it("the fetch client keeps only schema-checked refusal details", async () => {
    const body = {
      error: "PROVIDER_EVAL_REQUIRED",
      details: {
        suiteId: "core.public-agent-evals",
        suiteDigest: hex("a"),
        roles: [
          {
            role: "companion",
            revisionDigest: hex("9"),
            reason: "not_evaluated",
            note: "dropped",
          },
        ],
      },
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(body, { status: 409 }))
      .mockResolvedValueOnce(
        Response.json(
          { ...body, details: { roles: "<script>" } },
          { status: 409 },
        ),
      );
    const client = createFetchAdminClient({ baseUrl: "/api", fetch: fetcher });
    const input = {
      expectedRevision: 1,
      idempotencyKey: "key-12345",
      configuration: {},
      jobPolicy: {
        allowance: { microUsd: 1, tokens: 1 },
        durationMs: 1000,
        timeoutMs: 100,
        maxAttempts: 1,
      },
      credentials: {},
    };
    const first = await client
      .providerSetup!.save("w", input)
      .catch((e: unknown) => e);
    expect(first).toBeInstanceOf(AdminError);
    expect((first as AdminError).code).toBe("eval_required");
    expect((first as AdminError).details).toEqual({
      suiteDigest: hex("a"),
      roles: [
        {
          role: "companion",
          revisionDigest: hex("9"),
          reason: "not_evaluated",
        },
      ],
    });
    const second = await client
      .providerSetup!.save("w", input)
      .catch((e: unknown) => e);
    expect((second as AdminError).code).toBe("eval_required");
    expect((second as AdminError).details).toBeUndefined();
  });

  it("the fetch client reads status and posts overrides to the workspace routes", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(status()))
      .mockResolvedValueOnce(
        Response.json({
          id: uuid(4),
          role: "companion",
          revisionDigest: hex("c"),
          suiteDigest: hex("a"),
          createdAt: "2026-10-20T10:00:00.000Z",
        }),
      );
    const client = createFetchAdminClient({ baseUrl: "/api", fetch: fetcher });
    expect((await client.providerEvals!.status("w s")).roles).toHaveLength(3);
    expect(fetcher.mock.calls[0]![0]).toBe(
      "/api/workspaces/w%20s/provider-evals",
    );
    await client.providerEvals!.override("w", {
      idempotencyKey: "key-12345",
      role: "companion",
      revisionDigest: hex("c"),
      reason: "A sufficiently long reason.",
    });
    expect(fetcher.mock.calls[1]![0]).toBe(
      "/api/workspaces/w/provider-evals/overrides",
    );
    expect(fetcher.mock.calls[1]![1]!.method).toBe("POST");
  });
});
