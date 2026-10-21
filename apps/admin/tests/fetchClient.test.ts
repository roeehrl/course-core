import { describe, expect, it, vi } from "vitest";
import { createFetchAdminClient } from "../src/client/fetchClient";
import { demoRun, demoSession, demoWorkspace } from "../src/data/fixtures";
import { errorMessage } from "../src/domain/errors";
import {
  context,
  demo,
  enrollmentId,
  request as calendarRequest,
} from "./helpers";
const workspace = demoWorkspace(
  demoSession("administrator").courses[0]!,
  "administrator",
);
const mutation = {
  workspace,
  receipt: { id: "server-receipt", authority: "server", outcome: "saved" },
  message: "Saved.",
};
describe("fetch admin adapter", () => {
  it("uses the enrollment calendar-preview payload and preserves semantic cap errors", async () => {
    const preview = await demo().previewExtension(
      enrollmentId,
      calendarRequest,
    );
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(preview))
      .mockResolvedValueOnce(
        Response.json(
          { error: "PARENT_CAP_CONFLICT", detail: "private diagnostic" },
          { status: 409 },
        ),
      );
    const client = createFetchAdminClient({ baseUrl: "/api", fetch: fetcher });
    await client.previewExtension(enrollmentId, calendarRequest);
    expect(fetcher.mock.calls[0]![0]).toBe(
      `/api/enrollments/${enrollmentId}/extensions/preview`,
    );
    expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).toEqual({
      scopeId: "chapter:foundations",
      days: 2,
    });
    await expect(
      client.previewExtension(enrollmentId, calendarRequest),
    ).rejects.toMatchObject({ code: "parent_cap" });
  });
  it("sends an older-version confirmation only when given and maps the refusal to a plain message", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(mutation))
      .mockResolvedValueOnce(
        Response.json(
          {
            error: "PUBLISH_VERSION_OLDER_THAN_PUBLISHED",
            details: { version: "1.0.0" },
          },
          { status: 409 },
        ),
      );
    const client = createFetchAdminClient({
      baseUrl: "/api/admin",
      fetch: fetcher,
    });
    await client.transitionRelease("c1", "r1", "publish", context(), {
      confirmOlderVersion: true,
    });
    expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).toEqual({
      action: "publish",
      confirmOlderVersion: true,
    });
    const refusal = await client
      .transitionRelease("c1", "r1", "publish", context())
      .catch((e: unknown) => e);
    expect(JSON.parse(fetcher.mock.calls[1]![1]!.body as string)).toEqual({
      action: "publish",
    });
    expect(refusal).toMatchObject({ code: "older_version" });
    expect(errorMessage(refusal)).toMatch(
      /newer version of this course is already published/,
    );
  });
  it("maps an inaccessible-visual publication refusal to its own message (S12)", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        {
          error: "PUBLISH_VISUAL_INACCESSIBLE",
          details: { visualId: "bars", reasons: ["keyboard"] },
        },
        { status: 409 },
      ),
    );
    const client = createFetchAdminClient({ baseUrl: "/api", fetch: fetcher });
    const refused = await client
      .previewExtension(enrollmentId, calendarRequest)
      .catch((error: unknown) => error);
    expect(refused).toMatchObject({ code: "visual_inaccessible" });
    expect(errorMessage(refused)).toMatch(
      /keyboard support and a text alternative/,
    );
  });
  it("encodes identifiers, includes cookie credentials, revisions and idempotency headers", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(mutation));
    const client = createFetchAdminClient({
      baseUrl: "/api/admin/",
      fetch: fetcher,
      requestHeaders: () => ({ "X-CSRF-Token": "test-only-placeholder" }),
    });
    const ctx = context();
    await client.updateCourse(
      "course/name?",
      { title: "Public title", description: "A description" },
      ctx,
    );
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("/api/admin/courses/course%2Fname%3F");
    expect(init).toMatchObject({
      method: "PATCH",
      credentials: "include",
      redirect: "error",
      cache: "no-store",
    });
    const headers = new Headers(init?.headers);
    expect(headers.get("If-Match")).toBe("1");
    expect(headers.get("Idempotency-Key")).toBe(ctx.idempotencyKey);
    expect(JSON.parse(init!.body as string).title).toBe("Public title");
  });
  it.each([
    [403, "permission_denied"],
    [409, "stale_revision"],
    [412, "stale_revision"],
    [428, "pending_review"],
    [424, "config_absent"],
    [500, "unavailable"],
  ])(
    "maps HTTP %s without exposing raw response data",
    async (status, code) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
        new Response("sensitive raw service diagnostic", {
          status: Number(status),
        }),
      );
      const client = createFetchAdminClient({
        baseUrl: "/api/admin",
        fetch: fetcher,
      });
      try {
        await client.getSession();
        throw new Error("Expected rejection");
      } catch (error) {
        expect(error).toMatchObject({ code });
        expect(errorMessage(error)).not.toContain("sensitive");
      }
    },
  );
  it("rejects malformed successful responses", async () => {
    const client = createFetchAdminClient({
      baseUrl: "/api/admin",
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ role: "administrator" })),
    });
    await expect(client.getSession()).rejects.toMatchObject({
      code: "invalid_response",
    });
  });
  it("allowlists run fields instead of retaining hidden reasoning or raw traces", async () => {
    const run = demoRun(workspace, "sorting-run-01")!;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        ...run,
        chain_of_thought: "private internal reasoning",
        raw_trace: "unredacted",
        events: run.events.map((event) => ({
          ...event,
          secret: "not for display",
        })),
      }),
    );
    const client = createFetchAdminClient({
      baseUrl: "/api/admin",
      fetch: fetcher,
    });
    const result = await client.getRun("sorting", "sorting-run-01");
    expect(JSON.stringify(result)).not.toMatch(
      /private internal|unredacted|not for display/,
    );
  });
  it("passes cancellation through read requests and sends previews without mutation headers", async () => {
    const abort = new AbortController();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(demoSession("observer")));
    const client = createFetchAdminClient({
      baseUrl: "/api/admin",
      fetch: fetcher,
    });
    await client.getSession(abort.signal);
    expect(fetcher.mock.calls[0]![1]?.signal).toBe(abort.signal);
    expect(
      new Headers(fetcher.mock.calls[0]![1]?.headers).has("Idempotency-Key"),
    ).toBe(false);
  });
});
