import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { createFetchAdminClient } from "../src/client/fetchClient";
import { StudyView } from "../src/views/StudyView";
import {
  StudyError,
  studyErrorMessage,
  type Studies,
  type StudiesPort,
  type Study,
} from "../src/domain/studies";
import type { AdminClient, CourseWorkspace } from "../src/domain/contracts";

const releaseId = "00000000-0000-4000-8000-0000000000a1";
const studyId = "00000000-0000-4000-8000-000000000051";
const workspace = {
  course: { id: "c1" },
  permissions: [],
  enrollments: [],
} as unknown as CourseWorkspace;
const study = (state: Study["state"] = "recruiting"): Study => ({
  id: studyId,
  releaseId,
  title: "Ordering study",
  purpose: "We compare three versions of this course.",
  state,
  revision: 2,
  arms: [
    {
      id: "fixed",
      label: "Fixed path",
      behaviour: "fixed",
      consented: 4,
      withdrawn: 1,
    },
    {
      id: "chat_only",
      label: "Chat-only companion",
      behaviour: "chat_only",
      consented: 4,
      withdrawn: 0,
    },
    {
      id: "supervisor",
      label: "Full supervisor",
      behaviour: "supervisor",
      consented: 3,
      withdrawn: 0,
    },
  ],
  instruments: {
    pre: ["pre-min"],
    post: ["post-min"],
    transfer: [],
    delayed: ["min-later-1"],
  },
  minCellSize: 5,
  usabilityMeasures: false,
  usabilityTrials: null,
  seedDigest: "a".repeat(64),
  consent: { eligible: 14, consented: 11, withdrawn: 1, undecided: 2 },
  createdAt: "2026-10-01T10:00:00.000Z",
  openedAt: state === "draft" ? null : "2026-10-02T10:00:00.000Z",
  closedAt: null,
  warnings: [
    {
      code: "ITEM_COUNTS_TOWARD_GATE",
      params: { item: "pre-min", set: "pre" },
    },
  ],
});
const studies = (overrides: Partial<Studies> = {}): Studies => ({
  canManage: true,
  canExport: true,
  releases: [
    {
      id: releaseId,
      version: "1.0.0",
      status: "published",
      placementEnabled: false,
      items: [
        {
          id: "pre-min",
          type: "numeric",
          role: null,
          objectiveIds: ["minimum"],
          retention: false,
        },
        {
          id: "post-min",
          type: "numeric",
          role: null,
          objectiveIds: ["minimum"],
          retention: false,
        },
        {
          id: "xfer-min",
          type: "numeric",
          role: "transfer",
          objectiveIds: ["minimum"],
          retention: false,
        },
        {
          id: "min-later-1",
          type: "numeric",
          role: null,
          objectiveIds: ["minimum"],
          retention: true,
        },
      ],
    },
  ],
  studies: [study()],
  ...overrides,
});
const port = (data: Studies): StudiesPort => ({
  list: vi.fn(async () => data),
  create: vi.fn(async (_c, input) => ({
    study: { ...study("draft"), title: input.title },
    warnings: [],
  })),
  update: vi.fn(),
  transition: vi.fn(async () => ({ study: study("closed") })),
  allocationCheck: vi.fn(async () => ({
    checked: 11,
    mismatches: 0,
    allocated: 12,
    seedDigest: "a".repeat(64),
  })),
  download: vi.fn(async (_id, format) => ({
    body: "participant\r\n",
    filename: `study-00000000.${format}`,
    digest: "b".repeat(64),
    contentType: "text/csv",
  })),
});
const show = (p: StudiesPort) =>
  render(
    <StudyView
      data={workspace}
      client={{ studies: p } as unknown as AdminClient}
    />,
  );

describe("study administration view", () => {
  it("shows arm balance, consent counts, instruments and warnings; exports, checks allocation and closes with confirmation", async () => {
    const p = port(studies());
    URL.createObjectURL = vi.fn(() => "blob:study");
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
      () => undefined,
    );
    show(p);
    const balance = await screen.findByRole("region", {
      name: "Arm balance of Ordering study",
    });
    expect(within(balance).getAllByRole("row")).toHaveLength(4);
    expect(
      within(balance).getByRole("rowheader", { name: "Chat-only companion" }),
    ).toBeVisible();
    // What each arm switches is worded from its behaviour code, not sent by the server.
    expect(
      within(balance).getByText(/^The fixed lesson path: the AI companion/),
    ).toBeVisible();
    expect(
      screen.getByText("Included in exports").closest(".stat"),
    ).toHaveTextContent("Consented11");
    expect(
      screen.getByText("Have not joined").closest(".stat"),
    ).toHaveTextContent("Not decided2");
    expect(
      screen.getByText(/Arms smaller than 5 are left out of exports/),
    ).toBeVisible();
    expect(screen.getByText(/also counts toward a gate/)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    await waitFor(() =>
      expect(p.download).toHaveBeenCalledWith(studyId, "csv"),
    );
    expect(
      await screen.findByText(
        /Downloaded study-00000000\.csv .*recorded in the audit log/,
      ),
    ).toBeVisible();
    await userEvent.click(
      screen.getByRole("button", { name: "Check allocation" }),
    );
    expect(
      await screen.findByText(
        "All 11 assignments match the seeded draw (12 made in total).",
      ),
    ).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Close study" }));
    expect(screen.getByText(/A closed study cannot reopen/)).toBeVisible();
    await userEvent.click(
      screen.getByRole("button", { name: "Confirm close" }),
    );
    await waitFor(() =>
      expect(p.transition).toHaveBeenCalledWith(studyId, "close", 2),
    );
  });

  it("reviewers and instructors read aggregates only: no setup, open, close, allocation or export controls", async () => {
    show(port(studies({ canManage: false, canExport: false })));
    await screen.findByRole("region", {
      name: "Arm balance of Ordering study",
    });
    for (const name of [
      "Export CSV",
      "Export JSON",
      "Close study",
      "Check allocation",
      "New study",
    ])
      expect(screen.queryByRole("button", { name })).toBeNull();
  });

  it("sets up a draft: arms, item sets (delayed only for retention items) and the minimum cell size", async () => {
    const p = port(studies({ studies: [] }));
    show(p);
    await userEvent.click(
      await screen.findByRole("button", { name: "New study" }),
    );
    await userEvent.type(screen.getByLabelText("Title"), "Ordering study");
    await userEvent.type(
      screen.getByLabelText("Purpose shown to learners"),
      "We compare three versions of this course.",
    );
    await userEvent.selectOptions(screen.getByLabelText(/^pre-min/), "pre");
    await userEvent.selectOptions(screen.getByLabelText(/^post-min/), "post");
    await userEvent.selectOptions(
      screen.getByLabelText(/^xfer-min/),
      "transfer",
    );
    expect(
      within(screen.getByLabelText(/^post-min/)).getByRole("option", {
        name: /Delayed check \(not a retention item\)/,
      }),
    ).toBeDisabled();
    await userEvent.selectOptions(
      screen.getByLabelText(/^min-later-1/),
      "delayed",
    );
    await userEvent.click(screen.getByLabelText("Include Chat-only companion"));
    await userEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(p.create).toHaveBeenCalledTimes(1));
    const [catalogId, input] = vi.mocked(p.create).mock.calls[0]!;
    expect(catalogId).toBe("c1");
    expect(input).toMatchObject({
      releaseId,
      minCellSize: 5,
      instruments: {
        pre: ["pre-min"],
        post: ["post-min"],
        transfer: ["xfer-min"],
        delayed: ["min-later-1"],
      },
    });
    expect(input.arms.map((a) => a.behaviour)).toEqual(["fixed", "supervisor"]);
    expect(await screen.findByText(/saved as a draft/)).toBeVisible();
  });

  it("explains refused definitions by problem code", () => {
    expect(
      studyErrorMessage(
        new StudyError("STUDY_DEFINITION_INVALID", [
          "STUDY_DELAYED_NOT_RETENTION",
        ]),
      ),
    ).toMatch(/held-out retention items/);
    expect(studyErrorMessage(new StudyError("FORBIDDEN"))).toMatch(
      /Owners and admins/,
    );
    expect(studyErrorMessage(new Error("x"))).toMatch(/Nothing changed/);
  });

  it("the fetch client returns the export as text with its digest, and passes refusal problems through", async () => {
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith("/export?format=csv"))
        return new Response("participant,arm\r\n", {
          status: 200,
          headers: {
            "Content-Disposition": 'attachment; filename="study-12345678.csv"',
            "X-Export-Digest": "c".repeat(64),
          },
        });
      return new Response(
        JSON.stringify({
          error: "STUDY_DEFINITION_INVALID",
          details: { problems: ["STUDY_ITEM_UNKNOWN", "<script>"] },
        }),
        { status: 422 },
      );
    });
    const client = createFetchAdminClient({
      baseUrl: "/api/admin",
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    expect(await client.studies!.download(studyId, "csv")).toEqual({
      body: "participant,arm\r\n",
      filename: "study-12345678.csv",
      digest: "c".repeat(64),
      contentType: "text/csv",
    });
    const refused = await client
      .studies!.create("c1", {
        releaseId,
        title: "x",
        purpose: "y",
        arms: [],
        instruments: { pre: [], post: [], transfer: [], delayed: [] },
        minCellSize: 5,
        usabilityMeasures: false,
      })
      .catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(StudyError);
    expect((refused as StudyError).problems).toEqual(["STUDY_ITEM_UNKNOWN"]);
  });
});

describe("study definition from a file and usability timing (W01, P15)", () => {
  const file = (body: unknown, name = "study.json") =>
    new File([typeof body === "string" ? body : JSON.stringify(body)], name, {
      type: "application/json",
    });
  const definition = {
    title: "Ordering study from the course",
    purpose:
      "We compare three versions of this course to learn which helps people learn ordering best.",
    arms: [
      { id: "fixed", label: "Fixed lessons", behaviour: "fixed" },
      { id: "supervisor", label: "Full course", behaviour: "supervisor" },
    ],
    instruments: {
      pre: ["pre-min"],
      post: ["post-min"],
      transfer: ["xfer-min"],
      delayed: ["min-later-1"],
    },
    minCellSize: 7,
    usabilityMeasures: true,
  };

  it("fills the form from a course's study.json, saves nothing until Save, and sends the usability choice", async () => {
    const p = port(studies({ studies: [] }));
    show(p);
    await userEvent.click(
      await screen.findByRole("button", { name: "New study" }),
    );
    await userEvent.upload(
      screen.getByLabelText("Fill in from a file (optional)"),
      file({ schemaVersion: 1, definition, protocol: {} }),
    );
    expect(
      await screen.findByText(
        /Filled in from study.json: 2 versions and 4 check questions/,
      ),
    ).toBeVisible();
    expect(p.create).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Title")).toHaveValue(
      "Ordering study from the course",
    );
    expect(screen.getByLabelText(/^pre-min/)).toHaveValue("pre");
    expect(screen.getByLabelText(/^min-later-1/)).toHaveValue("delayed");
    expect(
      screen.getByLabelText("Include Chat-only companion"),
    ).not.toBeChecked();
    expect(
      screen.getByLabelText(
        "Also time how participants find their way in the app",
      ),
    ).toBeChecked();
    await userEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(p.create).toHaveBeenCalledTimes(1));
    expect(vi.mocked(p.create).mock.calls[0]![1]).toMatchObject({
      releaseId,
      title: definition.title,
      minCellSize: 7,
      usabilityMeasures: true,
      instruments: definition.instruments,
      arms: [
        { id: "fixed", label: "Fixed lessons", behaviour: "fixed" },
        { id: "supervisor", label: "Full course", behaviour: "supervisor" },
      ],
    });
  });

  it("says plainly what is wrong with a file and changes nothing", async () => {
    show(port(studies({ studies: [] })));
    await userEvent.click(
      await screen.findByRole("button", { name: "New study" }),
    );
    const input = screen.getByLabelText("Fill in from a file (optional)");
    await userEvent.upload(input, file("{not json"));
    expect(await screen.findByText(/not readable JSON/)).toBeVisible();
    await userEvent.upload(
      input,
      file({ definition: { ...definition, minCellSize: 1 } }),
    );
    expect(
      await screen.findByText(/"minCellSize" is missing or not valid/),
    ).toBeVisible();
    await userEvent.upload(
      input,
      file({
        definition: {
          ...definition,
          instruments: {
            ...definition.instruments,
            pre: ["other-course-item"],
          },
        },
      }),
    );
    expect(
      await screen.findByText(/not in the chosen release: other-course-item/),
    ).toBeVisible();
    await userEvent.upload(
      input,
      file({
        definition: {
          ...definition,
          arms: [definition.arms[0], { ...definition.arms[0], id: "fixed_b" }],
        },
      }),
    );
    expect(await screen.findByText(/two versions of the kind/)).toBeVisible();
    expect(screen.getByLabelText("Title")).toHaveValue("");
  });

  it("shows on the study whether usability timing is on and how many timed steps arrived", async () => {
    show(
      port(
        studies({
          studies: [
            { ...study(), usabilityMeasures: true, usabilityTrials: 12 },
          ],
        }),
      ),
    );
    expect(
      await screen.findByText(
        "Usability timing: on. 12 timed steps received so far.",
      ),
    ).toBeVisible();
  });
});

it("words study warnings from codes in Hebrew, and keeps older English or unknown codes readable", async () => {
  const { studyWarningText } = await import("../src/domain/studies");
  const { createAdminTranslator } = await import("../src/i18n");
  const he = createAdminTranslator("he");
  expect(
    studyWarningText(
      {
        code: "ITEM_COUNTS_TOWARD_GATE",
        params: { item: "pre-min", set: "pre" },
      },
      he.t,
      he.has,
    ),
  ).toContain("מבחן מקדים");
  expect(studyWarningText("Older English warning.", he.t, he.has)).toBe(
    "Older English warning.",
  );
  expect(studyWarningText({ code: "NEW_WARNING" })).toBe(
    "Check this study's instruments (NEW_WARNING).",
  );
});
