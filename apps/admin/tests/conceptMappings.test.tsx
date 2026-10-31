import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ConceptMappingsView } from "../src/views/ConceptMappingsView";
import { createFetchAdminClient } from "../src/client/fetchClient";
import {
  ConceptMappingError,
  conceptMappingErrorMessage,
  type ConceptMapping,
  type ConceptMappingPort,
  type MappingPair,
} from "../src/domain/conceptMappings";
import type { AdminClient } from "../src/domain/contracts";
import { actNow, firstSight, withoutAct } from "./raceHelpers";

const A = "00000000-0000-4000-8000-0000000000a1",
  B = "00000000-0000-4000-8000-0000000000b2";
const objectives = [
  { id: "minimum", description: "Find a minimum." },
  { id: "maximum", description: "Find a maximum." },
];
const candidates = {
  maxLinks: 200,
  courses: [
    {
      catalogId: "00000000-0000-4000-8000-0000000000c1",
      workspaceId: "00000000-0000-4000-8000-0000000000d1",
      workspaceTitle: "Space A",
      courseKey: "ordering",
      title: "Ordering values",
      role: "owner",
      releases: [
        {
          releaseId: A,
          version: "1.0.0",
          status: "published",
          title: "Ordering values",
          objectives,
        },
      ],
    },
    {
      catalogId: "00000000-0000-4000-8000-0000000000c2",
      workspaceId: "00000000-0000-4000-8000-0000000000d2",
      workspaceTitle: "Space B",
      courseKey: "practice",
      title: "Ordering practice",
      role: "admin",
      releases: [
        {
          releaseId: B,
          version: "2.0.0",
          status: "published",
          title: "Ordering practice",
          objectives,
        },
      ],
    },
  ],
};
const course = (releaseId: string, title: string, version: string) => ({
  releaseId,
  workspaceId: "00000000-0000-4000-8000-0000000000d1",
  courseKey: title.toLowerCase(),
  version,
  title,
});
const saved = (
  links: ConceptMapping["links"],
  revision = 1,
  state: "active" | "retired" = "active",
): ConceptMapping => ({
  id: "00000000-0000-4000-8000-0000000000e1",
  revision,
  state,
  updatedAt: "2026-10-20T10:00:00.000Z",
  courses: {
    a: course(A, "Ordering values", "1.0.0"),
    b: course(B, "Ordering practice", "2.0.0"),
  },
  links,
  linksDigest: "f".repeat(64),
  authoredBy: "staff",
  inferred: false,
  history: [
    {
      revision,
      action:
        revision === 1
          ? "created"
          : state === "retired"
            ? "retired"
            : "revised",
      linkCount: links.length,
      linksDigest: "f".repeat(64),
      author: {
        id: "00000000-0000-4000-8000-0000000000f1",
        displayName: "Owner of both",
      },
      roles: { a: "owner", b: "admin" },
      note: "Reviewed together",
      createdAt: "2026-10-20T10:00:00.000Z",
    },
  ],
});
const pair = (mapping: ConceptMapping | null): MappingPair => ({
  courses: {
    a: { ...course(A, "Ordering values", "1.0.0"), objectives },
    b: { ...course(B, "Ordering practice", "2.0.0"), objectives },
  },
  mapping,
});
function setup(port: Partial<ConceptMappingPort> = {}) {
  const full: ConceptMappingPort = {
    candidates: vi.fn(async () => candidates),
    pair: vi.fn(async () => pair(null)),
    save: vi.fn(async (input) => saved(input.links)),
    retire: vi.fn(async () => saved([], 2, "retired")),
    ...port,
  };
  render(
    <ConceptMappingsView
      client={{ conceptMappings: full } as unknown as AdminClient}
    />,
  );
  return full;
}
async function choose() {
  await userEvent.selectOptions(
    await screen.findByLabelText("First course"),
    "Ordering practice 2.0.0 · Space B",
  );
  await userEvent.selectOptions(
    screen.getByLabelText("Second course"),
    "Ordering values 1.0.0 · Space A",
  );
}

describe("concept mapping editor", () => {
  it("picks two courses, adds links in either direction and saves them as staff-authored links", async () => {
    const port = setup();
    await choose();
    await waitFor(() =>
      expect(port.pair).toHaveBeenCalledWith(B, A, expect.anything()),
    );
    expect(
      await screen.findByText("No links yet. Add the first one."),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Save mapping" })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "Add link" }));
    // An incomplete link cannot be saved.
    expect(screen.getByRole("button", { name: "Save mapping" })).toBeDisabled();
    const first = screen.getByRole("group", { name: "Link 1" });
    await userEvent.selectOptions(
      within(first).getByLabelText("Objective in Ordering practice 2.0.0"),
      "Find a minimum.",
    );
    await userEvent.selectOptions(
      within(first).getByLabelText("Objective in Ordering values 1.0.0"),
      "Find a minimum.",
    );
    await userEvent.click(screen.getByRole("button", { name: "Add link" }));
    const second = screen.getByRole("group", { name: "Link 2" });
    await userEvent.selectOptions(
      within(second).getByLabelText("Objective in Ordering practice 2.0.0"),
      "Find a maximum.",
    );
    await userEvent.selectOptions(
      within(second).getByLabelText("Relation"),
      "requires (as a prerequisite)",
    );
    await userEvent.selectOptions(
      within(second).getByLabelText("Objective in Ordering values 1.0.0"),
      "Find a minimum.",
    );
    await userEvent.type(
      screen.getByLabelText("Note for the history (optional)"),
      "Reviewed with both teams",
    );
    await userEvent.click(screen.getByRole("button", { name: "Save mapping" }));
    await waitFor(() => expect(port.save).toHaveBeenCalledTimes(1));
    const input = vi.mocked(port.save).mock.calls[0]![0];
    expect(input).toMatchObject({
      releaseIds: [B, A],
      expectedRevision: 0,
      note: "Reviewed with both teams",
    });
    expect(input.idempotencyKey).toMatch(/^mapping-/);
    expect(input.links).toEqual([
      {
        relation: "equivalent",
        from: { releaseId: B, objectiveId: "minimum" },
        to: { releaseId: A, objectiveId: "minimum" },
      },
      // "Practice's maximum requires values' minimum": stored as values' minimum is a prerequisite of practice's maximum.
      {
        relation: "prerequisite_of",
        from: { releaseId: A, objectiveId: "minimum" },
        to: { releaseId: B, objectiveId: "maximum" },
      },
    ]);
    expect(
      await screen.findByText("Mapping saved as version 1."),
    ).toBeVisible();
    const history = screen.getByRole("region", { name: "Mapping history" });
    expect(within(history).getByText("Created")).toBeVisible();
    expect(within(history).getByText(/Owner of both/)).toBeVisible();
    expect(within(history).getByText("(Owner / Admin)")).toBeVisible();
  });

  it("keeps a link added the moment the saved mapping appears", async () => {
    const existing = saved([
      {
        relation: "equivalent",
        from: { releaseId: B, objectiveId: "minimum" },
        to: { releaseId: A, objectiveId: "minimum" },
      },
    ]);
    let arrive = () => {};
    setup({
      pair: vi.fn(
        () =>
          new Promise<MappingPair>((resolve) => {
            arrive = () => resolve(pair(existing));
          }),
      ),
    });
    await choose();
    const add = await withoutAct(() => {
      arrive();
      return firstSight(() =>
        screen.queryByRole("button", { name: "Add link" }),
      );
    });
    // Added in the same task the mapping appeared in, before React's pending effects ran.
    await actNow(() => fireEvent.click(add));
    expect(screen.getByRole("group", { name: "Link 1" })).toBeVisible();
    expect(screen.getByRole("group", { name: "Link 2" })).toBeVisible();
  });

  it("shows a saved mapping from either side, retires it and explains refusals without changing anything", async () => {
    const existing = saved([
      {
        relation: "prerequisite_of",
        from: { releaseId: A, objectiveId: "maximum" },
        to: { releaseId: B, objectiveId: "minimum" },
      },
    ]);
    const port = setup({
      pair: vi.fn(async () => pair(existing)),
      save: vi.fn(async () => {
        throw new ConceptMappingError("FORBIDDEN");
      }),
    });
    await choose();
    const link = await screen.findByRole("group", { name: "Link 1" });
    // Seen from practice → values, values' maximum being a prerequisite reads as "requires".
    expect(within(link).getByLabelText("Relation")).toHaveValue("requires");
    expect(
      within(link).getByLabelText("Objective in Ordering practice 2.0.0"),
    ).toHaveValue("minimum");
    expect(
      within(link).getByLabelText("Objective in Ordering values 1.0.0"),
    ).toHaveValue("maximum");
    expect(screen.getByText("active · version 1")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Save mapping" }));
    expect(
      await screen.findByText(
        conceptMappingErrorMessage(new ConceptMappingError("FORBIDDEN")),
      ),
    ).toBeVisible();
    expect(screen.getByText("active · version 1")).toBeVisible();
    await userEvent.click(
      screen.getByRole("button", { name: "Retire mapping" }),
    );
    await waitFor(() =>
      expect(port.retire).toHaveBeenCalledWith(
        existing.id,
        expect.objectContaining({ expectedRevision: 1 }),
      ),
    );
    expect(
      await screen.findByText(/Mapping retired as version 2/),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Restore with these links" }),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "Retire mapping" })).toBeNull();
  });

  it("removes a link, refuses two versions of one course and needs two mappable courses", async () => {
    const existing = saved([
      {
        relation: "equivalent",
        from: { releaseId: A, objectiveId: "minimum" },
        to: { releaseId: B, objectiveId: "minimum" },
      },
    ]);
    setup({ pair: vi.fn(async () => pair(existing)) });
    await choose();
    await userEvent.click(
      await screen.findByRole("button", { name: "Remove link 1" }),
    );
    expect(screen.queryByRole("group", { name: "Link 1" })).toBeNull();
    expect(screen.getByText("No links yet. Add the first one.")).toBeVisible();
  });

  it("is unavailable without a connected port, and lists nothing to map with fewer than two courses", async () => {
    const { unmount } = render(
      <ConceptMappingsView client={{} as AdminClient} />,
    );
    expect(
      screen.getByText("Concept mappings are not available here"),
    ).toBeVisible();
    unmount();
    setup({
      candidates: vi.fn(async () => ({
        ...candidates,
        courses: [candidates.courses[0]!],
      })),
    });
    expect(
      await screen.findByText("Two published courses are needed"),
    ).toBeVisible();
  });

  it("calls the documented server routes", async () => {
    const calls: { url: string; method: string; body: unknown }[] = [];
    const fetcher = vi.fn(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        calls.push({
          url: String(url),
          method: init?.method ?? "GET",
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        const path = String(url);
        const body = path.endsWith("/candidates")
          ? candidates
          : path.includes("?")
            ? pair(null)
            : saved([]);
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    );
    const client = createFetchAdminClient({
      baseUrl: "/api/admin",
      fetch: fetcher as unknown as typeof fetch,
    });
    await client.conceptMappings!.candidates();
    await client.conceptMappings!.pair(A, B);
    await client.conceptMappings!.save({
      releaseIds: [A, B],
      expectedRevision: 0,
      idempotencyKey: "mapping-key-1",
      links: [],
    });
    await client.conceptMappings!.retire(
      "00000000-0000-4000-8000-0000000000e1",
      { expectedRevision: 1, idempotencyKey: "mapping-key-2" },
    );
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET /api/admin/concept-mappings/candidates",
      `GET /api/admin/concept-mappings?first=${A}&second=${B}`,
      "POST /api/admin/concept-mappings",
      "POST /api/admin/concept-mappings/00000000-0000-4000-8000-0000000000e1/retire",
    ]);
    fetcher.mockImplementationOnce(
      async () =>
        new Response(JSON.stringify({ error: "CONCEPT_MAPPING_STALE" }), {
          status: 409,
        }),
    );
    await expect(client.conceptMappings!.candidates()).rejects.toMatchObject({
      code: "CONCEPT_MAPPING_STALE",
    });
  });
});
