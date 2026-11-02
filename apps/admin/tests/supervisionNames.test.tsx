import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  AuthorityQueueCard,
  SupervisionSettingsCard,
} from "../src/views/SupervisionSettings";
import type {
  AuthorityRequest,
  SupervisionSettingsPort,
} from "../src/domain/supervision";

// AI supervision names what a change is about: objectives by their course text and tools by
// their kind, never by ids (those stay under "Technical details"). Older servers send ids only.
const workspace = "00000000-0000-4000-8000-000000000001";
const request = (proposal: AuthorityRequest["proposal"]): AuthorityRequest => ({
  requestId: "00000000-0000-4000-8000-0000000000d1",
  jobId: "00000000-0000-4000-8000-0000000000a1",
  kind: "required_objectives",
  approver: "staff",
  proposal,
  reason: null,
  state: "pending",
  decidedAt: null,
  createdAt: "2026-10-12T10:05:00.000Z",
  learnerName: "Dana",
});
const queue = (requests: AuthorityRequest[]) =>
  ({
    requests: vi.fn().mockResolvedValue({ requests }),
  }) as unknown as SupervisionSettingsPort;

describe("supervision names", () => {
  it("names a request's objectives by their course text", async () => {
    render(
      <AuthorityQueueCard
        workspaceId={workspace}
        port={queue([
          request({
            objectiveIds: ["obj-min", "obj-max"],
            objectives: [
              { id: "obj-min", description: "Find the smaller number" },
              { id: "obj-max", description: "Find the larger number" },
            ],
          }),
        ])}
      />,
    );
    const line = await screen.findByText(/^Objectives:/);
    expect(line.textContent).toContain("Find the smaller number");
    expect(line.textContent).toContain("Find the larger number");
    expect(line.textContent).not.toContain("obj-min");
    const details = screen.getByText("Technical details").closest("details")!;
    expect(details).not.toHaveAttribute("open");
    expect(details.textContent).toContain("obj-min, obj-max");
  });

  it("counts the objectives when an older server sends only ids", async () => {
    render(
      <AuthorityQueueCard
        workspaceId={workspace}
        port={queue([request({ objectiveIds: ["obj-min", "obj-max"] })])}
      />,
    );
    expect(await screen.findByText("2 objectives")).toBeVisible();
    expect(
      screen.getByText("Technical details").closest("details")!.textContent,
    ).toContain("obj-min");
  });

  it("names the tools a settings change adds or removes by their kind", async () => {
    const port = {
      load: vi.fn().mockResolvedValue({
        workspaceId: workspace,
        autonomyLevel: "verified_changes",
        permittedToolFamilies: ["learner_read", "teaching"],
        conversationConfirmation: "checkpoints_as_authored",
        revision: 1,
        families: [
          {
            id: "learner_read",
            tools: [{ id: "get_history", sideEffects: "none" }],
          },
          {
            id: "teaching",
            tools: [{ id: "list_sources", sideEffects: "none" }],
          },
          {
            id: "research",
            tools: [
              { id: "list_research_topics", sideEffects: "none" },
              { id: "request_research", sideEffects: "proposal_only" },
            ],
          },
        ],
      }),
      preview: vi.fn().mockResolvedValue({
        autonomyLevel: "verified_changes",
        effects: [],
        toolsAdded: ["list_research_topics", "request_research", "new_tool"],
        toolsRemoved: [],
        warnings: [],
        optedInLearners: 0,
        openTeachingActions: 0,
      }),
    } as unknown as SupervisionSettingsPort;
    render(<SupervisionSettingsCard workspaceId={workspace} port={port} />);
    fireEvent.click(await screen.findByRole("checkbox", { name: /Research/ }));
    fireEvent.click(screen.getByRole("button", { name: /Check/ }));
    const [added] = await screen.findAllByText(/will become available/);
    if (!added) throw new Error("no added tools line");
    // Two research tools by their kind; a tool of no listed kind keeps its id.
    expect(added.textContent).toContain("Research (2)");
    expect(added.textContent).toContain("new_tool");
    expect(added.textContent).not.toContain("request_research");
    const details = screen.getByText("Technical details").closest("details")!;
    expect(details.textContent).toContain("request_research");
  });
});
