import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { createFetchAdminClient } from "../src/client/fetchClient";
import { LearnerViewCard } from "../src/components/LearnerViewCard";
import { Markdown } from "../src/components/LearnerViewScreen";
import {
  learnerViewErrorMessage,
  LearnerViewError,
  type LearnerView,
} from "../src/domain/learnerView";
import type { AdminClient, Enrollment } from "../src/domain/contracts";

const enrollmentId = "6b0e4c2a-8a1c-4d7e-9f3a-1c2b3d4e5f60";
function sample(): LearnerView {
  return {
    readOnly: true,
    view: {
      id: "0b0e4c2a-8a1c-4d7e-9f3a-1c2b3d4e5f61",
      viewedAt: "2026-10-14T10:00:00.000Z",
      viewer: { id: "owner", name: "Owner", role: "owner" },
      visibleToLearner: true,
    },
    learner: { displayName: "Sam" },
    snapshot: {
      enrollmentId,
      revision: 4,
      status: "active",
      profile: { displayName: "Sam" },
      planRevision: 0,
      adaptationRequirements: [],
      lessons: [
        {
          id: "one",
          requirement: "required",
          status: "available",
          completedBlockIds: ["one-text"],
          gate: {
            passed: false,
            objectives: [
              { id: "o1", families: ["a"], required: 2, passed: false },
            ],
          },
        },
        {
          id: "two",
          requirement: "required",
          status: "locked",
          completedBlockIds: [],
          gate: null,
        },
      ],
      complete: false,
      nextEpisodeId: "one",
      course: {
        title: "Public course",
        summary: "",
        objectives: [{ id: "o1", description: "Compare values." }],
        chapters: [
          {
            id: "c",
            title: "Chapter",
            episodes: [
              {
                id: "one",
                title: "First lesson",
                objectiveIds: ["o1"],
                blocks: [
                  {
                    id: "one-text",
                    type: "text",
                    markdown: "Hello **world** <script>x</script>",
                  },
                ],
                gateId: "g",
              },
              {
                id: "two",
                title: "Second lesson",
                objectiveIds: ["o1"],
                blocks: [{ id: "two-text", type: "text", markdown: "Later." }],
              },
            ],
          },
        ],
        visuals: [],
        media: [],
        sources: [],
      },
      recovery: [],
      inaccessibleEpisodeIds: [],
      closureReport: null,
      activeChallenges: [
        {
          challengeId: "1b0e4c2a-8a1c-4d7e-9f3a-1c2b3d4e5f62",
          episodeId: "one",
          question: {
            id: "q",
            type: "choice",
            prompt: "Which is smaller?",
            options: [
              { id: "a", text: "2" },
              { id: "b", text: "5" },
            ],
          },
          mode: "independent",
          independentEligible: true,
          expiresAt: "2026-10-14T11:00:00.000Z",
        },
      ],
    },
    personalChanges: [],
    reviews: [],
    withheld: [
      { id: "companion", label: "Companion conversation", reason: "Private." },
    ],
  };
}
const enrollment = { id: enrollmentId, status: "active" } as Enrollment;

describe("read-only learner view", () => {
  it("is a single GET on the admin API and maps server refusals", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(sample()))
      .mockResolvedValueOnce(
        Response.json({ error: "FORBIDDEN" }, { status: 403 }),
      );
    const client = createFetchAdminClient({
      baseUrl: "/api/admin",
      fetch: fetcher,
    });
    expect(
      (await client.learnerView!.open(enrollmentId)).learner.displayName,
    ).toBe("Sam");
    expect(fetcher.mock.calls[0]![0]).toBe(
      `/api/admin/enrollments/${enrollmentId}/learner-view`,
    );
    expect(fetcher.mock.calls[0]![1]).toMatchObject({
      method: "GET",
      body: undefined,
    });
    const refused = await client
      .learnerView!.open(enrollmentId)
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(LearnerViewError);
    expect(learnerViewErrorMessage(refused)).toMatch(
      /Only workspace owners and admins/,
    );
  });

  it("opens only on request and renders the learner's lesson, gate and open check without any command", async () => {
    const open = vi.fn(async () => sample());
    render(
      <LearnerViewCard
        client={{ learnerView: { open } } as unknown as AdminClient}
        enrollment={enrollment}
      />,
    );
    expect(open).not.toHaveBeenCalled();
    await userEvent.click(
      screen.getByRole("button", { name: "Open read-only learner view" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: /Sam · Public course/,
    });
    expect(open).toHaveBeenCalledTimes(1);
    expect(
      await within(dialog).findByText("Read-only view of Sam's learning space"),
    ).toBeVisible();
    expect(within(dialog).getByText("1 of 1 parts read")).toBeVisible();
    expect(within(dialog).getByText("Which is smaller?")).toBeVisible();
    for (const radio of within(dialog).getAllByRole("radio"))
      expect(radio).toBeDisabled();
    expect(dialog.querySelector("form, textarea, script")).toBeNull();
    await userEvent.click(
      within(dialog).getByRole("button", { name: /Second lesson/ }),
    );
    expect(
      within(dialog).getByRole("heading", { name: "Second lesson" }),
    ).toBeVisible();
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("shows the learner's checkpoint decision, next steps and gate review read-only", async () => {
    const view = sample();
    view.snapshot.lessons[0]!.gate = {
      ...view.snapshot.lessons[0]!.gate!,
      status: "closed_with_gaps",
      learnerVisibleReason: "The course limit was reached before this checkpoint was ready.",
      criterionResults: [{ criterionId: "transfer", met: false, reason: "Needs a new transfer task." }],
      nextActions: [{ kind: "appeal", label: "Request a staff review of this decision within 14 days" }],
      review: { state: "upheld", reviewerNote: "Extend first.", requestedAt: "2026-10-15T10:00:00.000Z" },
      exception: null,
    };
    const open = vi.fn(async () => view);
    render(<LearnerViewCard client={{ learnerView: { open } } as unknown as AdminClient} enrollment={enrollment} />);
    await userEvent.click(screen.getByRole("button", { name: "Open read-only learner view" }));
    const dialog = await screen.findByRole("dialog", { name: /Sam · Public course/ });
    expect(await within(dialog).findByText("Checkpoint decision: closed with gaps")).toBeVisible();
    expect(within(dialog).getByText("The course limit was reached before this checkpoint was ready.")).toBeVisible();
    expect(within(dialog).getByText(/Still needed · Needs a new transfer task\./)).toBeVisible();
    expect(within(dialog).getByRole("list", { name: "Learner next steps" })).toHaveTextContent("Request a staff review of this decision within 14 days");
    expect(within(dialog).queryByRole("button", { name: /Request a staff review/ })).toBeNull();
    expect(within(dialog).getByText(/upheld · “Extend first\.”/)).toBeVisible();
    expect(dialog.querySelector("form, textarea")).toBeNull();
  });

  it("is disabled for an erased enrollment and absent without the port", () => {
    const { container, unmount } = render(
      <LearnerViewCard client={{} as AdminClient} enrollment={enrollment} />,
    );
    expect(container).toBeEmptyDOMElement();
    unmount();
    render(
      <LearnerViewCard
        client={{ learnerView: { open: vi.fn() } } as unknown as AdminClient}
        enrollment={{ ...enrollment, status: "erased" }}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Open read-only learner view" }),
    ).toBeDisabled();
  });

  it("renders prose as text, never as HTML", () => {
    const { container } = render(
      <Markdown
        markdown={
          "# Title\n\nUse `min` and **care** <img src=x onerror=alert(1)>\n\n```py\nprint(1)\n```"
        }
      />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByRole("heading", { name: "Title" })).toBeVisible();
    expect(screen.getByText("min").tagName).toBe("CODE");
    expect(screen.getByText("print(1)")).toBeVisible();
  });
});
