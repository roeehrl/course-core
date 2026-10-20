import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createFetchAdminClient } from "../src/client/fetchClient";
import { AuditView } from "../src/views/AuditView";
import { OverviewError, overviewErrorMessage } from "../src/domain/overview";
import type { AdminClient, CourseWorkspace } from "../src/domain/contracts";

const workspace = (permissions: string[]) =>
  ({
    course: { id: "c1", workspaceId: "00000000-0000-4000-8000-000000000001" },
    permissions,
  }) as unknown as CourseWorkspace;

describe("audit log", () => {
  it("builds the paged, filtered query and maps refusals", async () => {
    const urls: string[] = [];
    const client = createFetchAdminClient({
      baseUrl: "/api/admin",
      fetch: async (url) => {
        urls.push(String(url));
        return urls.length === 1
          ? new Response(JSON.stringify({ events: [], nextBefore: null }), {
              status: 200,
            })
          : new Response(JSON.stringify({ error: "FORBIDDEN" }), {
              status: 403,
            });
      },
    });
    await client.audit!.list("ws-1", {
      before: "42",
      actorKind: "staff",
      limit: 20,
    });
    expect(urls[0]).toBe(
      "/api/admin/workspaces/ws-1/audit?before=42&actorKind=staff&limit=20",
    );
    const refused = await client.audit!.list("ws-1", {}).catch((e) => e);
    expect(refused).toBeInstanceOf(OverviewError);
    expect(overviewErrorMessage(refused)).toMatch(/support observer/);
  });

  it("shows staff details and withholds learner details", async () => {
    const list = vi.fn(async () => ({
      nextBefore: null,
      events: [
        {
          sequence: "2",
          id: "00000000-0000-4000-8000-000000000002",
          at: "2026-10-15T00:00:00.000Z",
          actorKind: "staff" as const,
          actor: "Owner",
          type: "course.published",
          enrollmentId: null,
          payload: { releaseId: "r1" },
          payloadWithheld: false,
        },
        {
          sequence: "1",
          id: "00000000-0000-4000-8000-000000000003",
          at: "2026-10-15T00:00:00.000Z",
          actorKind: "learner" as const,
          actor: null,
          type: "assessment.submitted",
          enrollmentId: "00000000-0000-4000-8000-000000000004",
          payload: null,
          payloadWithheld: true,
        },
      ],
    }));
    render(
      <AuditView
        data={workspace(["audit.read"])}
        client={{ audit: { list } } as unknown as AdminClient}
      />,
    );
    expect(await screen.findByText('{"releaseId":"r1"}')).toBeVisible();
    expect(screen.getByText("Details withheld · learner record")).toBeVisible();
  });

  it("explains when the role cannot read the log", () => {
    render(
      <AuditView
        data={workspace(["course.read"])}
        client={{ audit: { list: vi.fn() } } as unknown as AdminClient}
      />,
    );
    expect(screen.getByText(/cannot read the audit log/)).toBeVisible();
  });
});
