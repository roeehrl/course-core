import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { createFetchAdminClient } from "../src/client/fetchClient";
import { PlacementView } from "../src/views/PlacementView";
import {
  PlacementAdminError,
  placementErrorMessage,
  type CoursePlacement,
  type PlacementAdminPort,
} from "../src/domain/placementAdmin";
import type { AdminClient, CourseWorkspace } from "../src/domain/contracts";

const placement: CoursePlacement = {
  author: {
    enabled: true,
    maxItems: 4,
    learnerMayDecline: true,
    protectedEpisodeIds: [],
    items: [],
    objectives: [],
  },
  settings: {
    enabled: false,
    retestCooldownHours: 168,
    maxRuns: 1,
    maxItems: null,
    minFamiliesPerEpisode: null,
    excludedAssessmentIds: [],
    excludedObjectiveIds: [],
    protectedEpisodeIds: [],
    revision: 0,
    updatedAt: null,
  },
  effective: {
    enabled: false,
    authorEnabled: true,
    staffEnabled: false,
    maxItems: 4,
    authorMaxItems: 4,
  },
  counters: {
    runs: {},
    exemptions: 0,
    falseSkips: { total: 0, revokedByStaff: 0, laterFailed: 0 },
    unnecessaryRepetitions: 0,
  },
};
const workspace = (permissions: string[]) =>
  ({
    course: { id: "c1" },
    permissions,
    enrollments: [],
  }) as unknown as CourseWorkspace;

describe("placement administration", () => {
  it("saves settings that only lower the author's question limit", async () => {
    const port: PlacementAdminPort = {
      course: vi.fn(async () => placement),
      save: vi.fn(async () => ({
        settings: { ...placement.settings, enabled: true, revision: 1 },
      })),
      enrollment: vi.fn(),
      revoke: vi.fn(),
    };
    render(
      <PlacementView
        data={workspace(["policy.write", "enrollment.write"])}
        client={{ placement: port } as unknown as AdminClient}
      />,
    );
    await userEvent.click(
      await screen.findByRole("checkbox", {
        name: /Offer placement to learners/,
      }),
    );
    const save = screen.getByRole("button", {
      name: "Save placement settings",
    });
    await userEvent.type(screen.getByLabelText("Question limit"), "5");
    expect(save).toBeDisabled();
    await userEvent.clear(screen.getByLabelText("Question limit"));
    await userEvent.type(screen.getByLabelText("Question limit"), "3");
    await userEvent.click(save);
    await waitFor(() =>
      expect(port.save).toHaveBeenCalledWith("c1", {
        expectedRevision: 0,
        enabled: true,
        retestCooldownHours: 168,
        maxRuns: 1,
        maxItems: 3,
        minFamiliesPerEpisode: null,
        excludedAssessmentIds: [],
        excludedObjectiveIds: [],
        protectedEpisodeIds: [],
      }),
    );
    expect(await screen.findByText("Placement settings saved.")).toBeVisible();
  });

  it("bounds the question limit by the server's author limit across live releases", async () => {
    // The live release allows 4, an older placement release only 3: the server's bound wins.
    const port: PlacementAdminPort = {
      course: vi.fn(async () => ({ ...placement, authorLimit: 3 })),
      save: vi.fn(),
      enrollment: vi.fn(),
      revoke: vi.fn(),
    };
    render(
      <PlacementView
        data={workspace(["policy.write"])}
        client={{ placement: port } as unknown as AdminClient}
      />,
    );
    const limit = await screen.findByLabelText("Question limit");
    expect(limit).toHaveAttribute("max", "3");
    expect(
      screen.getByText(
        /At most 3, the lowest limit among the published releases that offer placement/,
      ),
    ).toBeVisible();
    const save = screen.getByRole("button", {
      name: "Save placement settings",
    });
    await userEvent.type(limit, "4");
    expect(save).toBeDisabled();
    await userEvent.clear(limit);
    await userEvent.type(limit, "3");
    expect(save).toBeEnabled();
  });

  it("allows no question limit when no live release offers placement", async () => {
    const none = {
      ...placement,
      authorLimit: null,
      author: null,
      effective: null,
    };
    const port: PlacementAdminPort = {
      course: vi.fn(async () => none),
      save: vi.fn(async () => ({ settings: none.settings })),
      enrollment: vi.fn(),
      revoke: vi.fn(),
    };
    render(
      <PlacementView
        data={workspace(["policy.write"])}
        client={{ placement: port } as unknown as AdminClient}
      />,
    );
    const limit = await screen.findByLabelText("Question limit");
    expect(
      screen.getByText(
        "No published release offers placement; leave this empty.",
      ),
    ).toBeVisible();
    expect(limit).not.toHaveAttribute("max");
    const save = screen.getByRole("button", {
      name: "Save placement settings",
    });
    await userEvent.type(limit, "1");
    expect(save).toBeDisabled();
    await userEvent.clear(limit);
    expect(save).toBeEnabled();
    expect(
      placementErrorMessage(new PlacementAdminError("PLACEMENT_NOT_OFFERED")),
    ).toMatch(/No published release of this course offers placement/);
  });

  it("shows settings read-only without policy rights", async () => {
    const port: PlacementAdminPort = {
      course: vi.fn(async () => placement),
      save: vi.fn(),
      enrollment: vi.fn(),
      revoke: vi.fn(),
    };
    render(
      <PlacementView
        data={workspace(["course.read"])}
        client={{ placement: port } as unknown as AdminClient}
      />,
    );
    expect(await screen.findByText(/Off · up to 4 questions/)).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Save placement settings" }),
    ).toBeNull();
  });

  it("calls the settings and override routes and maps refusals", async () => {
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
              JSON.stringify({ error: "PLACEMENT_LIMIT_LOOSENS_AUTHOR" }),
              { status: 409 },
            )
          : new Response(
              JSON.stringify({
                episodeId: "min",
                state: "revoked",
                revision: 3,
              }),
              { status: 200 },
            );
      },
    });
    const refused = await client
      .placement!.save("c1", {
        expectedRevision: 0,
        enabled: true,
        retestCooldownHours: 0,
        maxRuns: 1,
        maxItems: 9,
        minFamiliesPerEpisode: null,
      })
      .catch((e) => e);
    expect(refused).toBeInstanceOf(PlacementAdminError);
    expect(placementErrorMessage(refused)).toMatch(/only be lowered/);
    expect(calls[0]!.url).toBe("/api/admin/courses/c1/placement/settings");
    await client.placement!.revoke(
      "e1",
      "min",
      { reason: "A gap in the invariant.", expectedRevision: 2 },
      "key-12345678",
    );
    expect(calls[1]).toEqual({
      url: "/api/admin/enrollments/e1/placement/exemptions/min/revoke",
      body: {
        reason: "A gap in the invariant.",
        expectedRevision: 2,
        idempotencyKey: "key-12345678",
      },
    });
  });

  it("shows the author's rules, narrows the blueprint and protects a lesson only after checking the effect", async () => {
    const authored: CoursePlacement = {
      ...placement,
      authorBounds: {
        maxRuns: 2,
        minCooldownHours: 24,
        minFamiliesPerEpisode: 2,
      },
      author: {
        enabled: true,
        maxItems: 4,
        learnerMayDecline: true,
        protectedEpisodeIds: ["intro"],
        assistancePolicy: "unassisted_only",
        items: [
          {
            assessmentId: "min-a",
            familyId: "compare",
            objectiveIds: ["minimum"],
            prompt: "Which is smaller?",
          },
          {
            assessmentId: "min-b",
            familyId: "select",
            objectiveIds: ["minimum"],
            prompt: "Minimum of 4 and 9?",
          },
        ],
        objectives: [
          { objectiveId: "minimum", description: "Find a minimum." },
        ],
      },
      blueprint: [
        {
          episodeId: "intro",
          title: "Welcome",
          status: "protected_by_author",
          questions: 0,
          families: 0,
          objectives: [],
        },
        {
          episodeId: "min",
          title: "Minimum",
          status: "placeable",
          questions: 2,
          families: 2,
          objectives: [
            {
              objectiveId: "minimum",
              description: "Find a minimum.",
              placeable: true,
            },
          ],
        },
      ],
    };
    const preview = vi.fn(async () => ({
      current: authored.blueprint!,
      blueprint: [
        authored.blueprint![0]!,
        {
          ...authored.blueprint![1]!,
          status: "protected_by_staff" as const,
          questions: 1,
          families: 1,
        },
      ],
    }));
    const port: PlacementAdminPort = {
      course: vi.fn(async () => authored),
      save: vi.fn(async () => ({
        settings: { ...authored.settings, revision: 1 },
      })),
      preview,
      enrollment: vi.fn(),
      revoke: vi.fn(),
    };
    render(
      <PlacementView
        data={workspace(["policy.write"])}
        client={{ placement: port } as unknown as AdminClient}
      />,
    );
    expect(
      await screen.findByText(
        /At most 2 runs per learner, with at least 24 hours between runs/,
      ),
    ).toBeVisible();
    expect(
      screen.getByText(/Placement questions are answered without help/),
    ).toBeVisible();
    // The author's protected lesson cannot be un-protected here.
    expect(
      screen.getByLabelText(/Welcome · protected by the course author/),
    ).toBeDisabled();
    await userEvent.click(screen.getByLabelText(/Which is smaller\?/));
    await userEvent.click(screen.getByLabelText(/^Minimum$/));
    const save = screen.getByRole("button", {
      name: "Save placement settings",
    });
    expect(save).toBeDisabled();
    expect(screen.getByText(/Check the effect before saving/)).toBeVisible();
    await userEvent.click(
      screen.getByRole("button", { name: "Check the effect" }),
    );
    const expected = {
      expectedRevision: 0,
      enabled: false,
      retestCooldownHours: 168,
      maxRuns: 1,
      maxItems: null,
      minFamiliesPerEpisode: null,
      excludedAssessmentIds: ["min-a"],
      excludedObjectiveIds: [],
      protectedEpisodeIds: ["min"],
    };
    await waitFor(() => expect(preview).toHaveBeenCalledWith("c1", expected));
    expect(await screen.findByText("Always kept (your setting)")).toBeVisible();
    expect(save).toBeEnabled();
    await userEvent.click(save);
    await waitFor(() => expect(port.save).toHaveBeenCalledWith("c1", expected));
  });

  it("explains a refusal for settings looser than the author's", () => {
    expect(
      placementErrorMessage(
        new PlacementAdminError("PLACEMENT_RETESTS_LOOSEN_AUTHOR"),
      ),
    ).toBe(
      "The course author allows fewer runs per learner. Lower the number of runs.",
    );
  });
});
