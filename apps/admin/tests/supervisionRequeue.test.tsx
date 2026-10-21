import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { createFetchAdminClient } from "../src/client/fetchClient";
import { SupervisionView } from "../src/views/SupervisionView";
import {
  SupervisionError,
  supervisionErrorMessage,
  type SupervisionOverview,
  type SupervisionPort,
} from "../src/domain/supervision";
import type { AdminClient, CourseWorkspace } from "../src/domain/contracts";

const enrollmentId = "00000000-0000-4000-8000-000000000001";
const quarantinedId = "00000000-0000-4000-8000-0000000000a1";
const refusedId = "00000000-0000-4000-8000-0000000000b1";
const releasedId = "00000000-0000-4000-8000-0000000000c1";
const workspace = {
  course: { id: "c1" },
  permissions: [],
  enrollments: [
    {
      id: enrollmentId,
      status: "active",
      profile: { displayName: "Avery Learner" },
    },
  ],
} as unknown as CourseWorkspace;
const overview = (canRequeue: boolean): SupervisionOverview => ({
  control: {
    state: "active",
    revision: 0,
    reasonCode: null,
    changedBy: null,
    changedAt: null,
  },
  jobs: [],
  pendingSignals: 0,
  undeliveredEvents: [
    {
      eventId: quarantinedId,
      eventType: "learning.updated",
      outcome: "quarantined",
      reason: "attempts_exhausted",
      at: "2026-10-01T10:00:00.000Z",
      requeued: false,
      requeueable: true,
    },
    {
      eventId: refusedId,
      eventType: "companion.requested",
      outcome: "refused",
      reason: "SUPERVISOR_NOT_FOUND",
      at: "2026-10-01T09:00:00.000Z",
      requeued: false,
      requeueable: false,
    },
    {
      eventId: releasedId,
      eventType: "research.requested",
      outcome: "quarantined",
      reason: "dispatch_unavailable",
      at: "2026-10-01T08:00:00.000Z",
      requeued: true,
      requeueable: false,
    },
  ],
  canControl: true,
  canRequeue,
});
async function open(port: SupervisionPort) {
  render(
    <SupervisionView
      data={workspace}
      client={{ supervision: port } as unknown as AdminClient}
    />,
  );
  await userEvent.selectOptions(screen.getByLabelText("Learner"), enrollmentId);
  return screen.findByRole("region", { name: "Requests that did not run" });
}

describe("re-queueing a quarantined supervisor request", () => {
  it("lets an owner re-queue a quarantined request once with a required reason, and offers nothing for refused or released ones", async () => {
    const port: SupervisionPort = {
      overview: vi.fn(async () => overview(true)),
      control: vi.fn(),
      requeue: vi.fn(async () => ({
        eventId: quarantinedId,
        eventType: "learning.updated",
        previousCode: "attempts_exhausted",
        previousAttempts: 8,
        replayed: false,
      })),
    };
    const table = await open(port);
    expect(
      within(table).getAllByRole("button", { name: /^Re-queue/ }),
    ).toHaveLength(1);
    expect(within(table).getByText("Not re-queueable")).toBeVisible();
    expect(within(table).getByText("Already re-queued")).toBeVisible();
    expect(within(table).getByText("re-queued once")).toBeVisible();
    await userEvent.click(
      within(table).getByRole("button", {
        name: /^Re-queue Request \(learning\.updated\)/,
      }),
    );
    const confirm = screen.getByRole("button", { name: "Re-queue once" });
    expect(confirm).toBeDisabled();
    await userEvent.type(
      screen.getByLabelText("Reason for re-queueing"),
      "too short",
    );
    expect(confirm).toBeDisabled();
    await userEvent.type(
      screen.getByLabelText("Reason for re-queueing"),
      " - outage over",
    );
    await userEvent.click(confirm);
    await waitFor(() => expect(port.requeue).toHaveBeenCalledTimes(1));
    const [id, eventId, input] = vi.mocked(port.requeue!).mock.calls[0]!;
    expect([id, eventId, input.reason]).toEqual([
      enrollmentId,
      quarantinedId,
      "too short - outage over",
    ]);
    expect(input.idempotencyKey).toMatch(/^requeue-/);
    expect(
      await screen.findByText(/^Request re-queued with fresh attempts\./),
    ).toBeVisible();
    expect(port.overview).toHaveBeenCalledTimes(2);
  });

  it("shows no re-queue action to a role without the permission", async () => {
    const port: SupervisionPort = {
      overview: vi.fn(async () => overview(false)),
      control: vi.fn(),
      requeue: vi.fn(),
    };
    const table = await open(port);
    expect(
      within(table).queryByRole("button", { name: /^Re-queue/ }),
    ).toBeNull();
    expect(
      within(table).queryByRole("columnheader", { name: "Action" }),
    ).toBeNull();
  });

  it("explains a refusal and keeps the form so nothing is lost", async () => {
    const port: SupervisionPort = {
      overview: vi.fn(async () => overview(true)),
      control: vi.fn(),
      requeue: vi.fn(async () => {
        throw new SupervisionError("SUPERVISION_CONSENT_WITHDRAWN");
      }),
    };
    const table = await open(port);
    await userEvent.click(
      within(table).getByRole("button", {
        name: /^Re-queue Request \(learning\.updated\)/,
      }),
    );
    await userEvent.type(
      screen.getByLabelText("Reason for re-queueing"),
      "Provider outage resolved.",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Re-queue once" }),
    );
    expect(
      await screen.findByText(/withdrew consent for AI supervision/),
    ).toBeVisible();
    expect(screen.getByLabelText("Reason for re-queueing")).toHaveValue(
      "Provider outage resolved.",
    );
  });

  it("posts to the re-queue route and maps its refusals", async () => {
    const calls: { url: string; body?: unknown }[] = [];
    const client = createFetchAdminClient({
      baseUrl: "/api/admin",
      fetch: async (url, init) => {
        calls.push({
          url: String(url),
          ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
        });
        return calls.length === 1
          ? new Response(
              JSON.stringify({ error: "SUPERVISOR_EVENT_ALREADY_REQUEUED" }),
              { status: 409 },
            )
          : new Response(
              JSON.stringify({
                eventId: quarantinedId,
                eventType: "learning.updated",
                previousCode: "dispatch_unavailable",
                previousAttempts: 3,
                replayed: true,
              }),
              { status: 200 },
            );
      },
    });
    const refused = await client.supervision!.requeue!(
      enrollmentId,
      quarantinedId,
      {
        idempotencyKey: "requeue-12345678",
        reason: "Provider outage resolved.",
      },
    ).catch((e) => e);
    expect(refused).toBeInstanceOf(SupervisionError);
    expect(supervisionErrorMessage(refused)).toMatch(/already re-queued once/);
    expect(calls[0]).toEqual({
      url: `/api/admin/enrollments/${enrollmentId}/supervision/events/${quarantinedId}/requeue`,
      body: {
        idempotencyKey: "requeue-12345678",
        reason: "Provider outage resolved.",
      },
    });
    expect(
      await client.supervision!.requeue!(enrollmentId, quarantinedId, {
        idempotencyKey: "requeue-12345678",
        reason: "Provider outage resolved.",
      }),
    ).toMatchObject({ replayed: true, previousAttempts: 3 });
  });
});
