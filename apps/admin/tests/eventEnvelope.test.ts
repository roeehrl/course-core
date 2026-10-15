import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createFetchAdminClient } from "../src/client/fetchClient";
import { ADMIN_APP_VERSION, createEventEnvelope } from "../src/client/eventEnvelope";

const ENVELOPE = ["x-course-platform", "x-course-app-version", "x-course-client-sequence", "x-course-occurred-at"];

describe("admin event envelope", () => {
  it("reports the package version", () => {
    const manifest = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8"));
    expect(ADMIN_APP_VERSION).toBe(manifest.version);
  });

  it("sends the learner app's contract on writes only, with a per-client increasing sequence the API accepts", () => {
    const at = new Date("2026-10-15T12:00:00.000Z");
    const envelope = createEventEnvelope(() => at);
    expect(envelope("GET")).toEqual({});
    const first = envelope("POST"), second = envelope("patch");
    expect(first).toEqual({ "X-Course-Platform": "web", "X-Course-App-Version": ADMIN_APP_VERSION, "X-Course-Client-Sequence": "1", "X-Course-Occurred-At": at.toISOString() });
    expect(second["X-Course-Client-Sequence"]).toBe("2");
    expect(createEventEnvelope(() => at)("POST")["X-Course-Client-Sequence"]).toBe("1");
    // The formats services/api/src/event-envelope.ts accepts (this job has no API install; the
    // real-API browser test checks that the server stores them).
    expect(first["X-Course-App-Version"]).toMatch(/^[0-9A-Za-z.+_-]{1,64}$/);
    expect(first["X-Course-Client-Sequence"]).toMatch(/^[0-9]{1,15}$/);
    expect(first["X-Course-Occurred-At"]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("adds the headers to every admin write (both request paths) and never to reads", async () => {
    const seen: { method: string; headers: Headers }[] = [];
    const client = createFetchAdminClient({
      baseUrl: "/api/admin",
      requestHeaders: () => ({ "X-CSRF-Token": "csrf-test" }),
      fetch: async (_url, init) => {
        seen.push({ method: String(init?.method), headers: new Headers(init?.headers) });
        return new Response(JSON.stringify({ error: "NOT_FOUND" }), { status: 404 });
      },
    });
    await client.getCourse("course").catch(() => undefined);
    await client.reviewEvidence("course", "enrollment", "evidence", { decision: "reject", note: "Synthetic." }, { expectedRevision: "3", idempotencyKey: "key-123456", targetRevision: 2 }).catch(() => undefined);
    await client.gateReviews!.resolve("00000000-0000-4000-8000-000000000001", { outcome: "upheld", note: "Synthetic note." }, "gate-review-1").catch(() => undefined);
    await client.gateReviews!.queue("course").catch(() => undefined);
    const [read, write, direct, directRead] = seen;
    for (const name of ENVELOPE) {
      expect(read!.headers.has(name)).toBe(false);
      expect(directRead!.headers.has(name)).toBe(false);
    }
    expect(write!.method).toBe("POST");
    expect(write!.headers.get("x-course-platform")).toBe("web");
    expect(write!.headers.get("x-csrf-token")).toBe("csrf-test");
    expect(write!.headers.get("x-course-client-sequence")).toBe("1");
    expect(direct!.headers.get("x-course-client-sequence")).toBe("2");
    expect(Date.parse(direct!.headers.get("x-course-occurred-at")!)).not.toBeNaN();
  });
});
