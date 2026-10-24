import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { stripBidiControls } from "@course-core/i18n";
import { VersionMoves } from "../src/components/VersionMoves";
import type { AdminClient } from "../src/domain/contracts";
import {
  moveCodeMessage,
  VersionMoveError,
  type LearnerImpact,
  type MoveDetail,
  type MovePreview,
  type VersionMovesPort,
  type VersionMovesView,
} from "../src/domain/versionMoves";
import { I18nProvider, createAdminTranslator } from "../src/i18n";
import en from "../src/i18n/messages/en/versionMoves.json";
import he from "../src/i18n/messages/he/versionMoves.json";
import { currentContext, demo } from "./helpers";

// Synthetic identities and lessons only.
const none = { count: 0, items: [] };
const learner = (over: Partial<LearnerImpact> = {}): LearnerImpact => ({
  enrollmentId: "e-1",
  displayName: "Ada Example",
  status: "active",
  outcome: "ready",
  refusal: null,
  policyCode: null,
  wait: null,
  progress: {
    completeBefore: false,
    completeAfter: false,
    creditedBefore: 2,
    creditedAfter: 1,
    kept: 1,
    changedKept: none,
    checkpointsAgain: { count: 1, items: [{ id: "min", title: "Minimum" }] },
    onHold: none,
    removed: none,
    nextBefore: null,
    nextAfter: { id: "min", title: "Minimum" },
  },
  evidence: { records: 3 },
  openWork: { questions: 0, activities: 0 },
  personalChanges: 0,
  policy: { addedScopes: ["episode:range"], keptScopes: 5 },
  carryOver: {
    carried: {
      count: 1,
      items: [
        {
          id: "intro",
          title: "Intro",
          gateId: "intro-gate",
          code: "CARRIED",
          items: 2,
        },
      ],
    },
    notCarried: {
      count: 1,
      items: [
        {
          id: "min",
          title: "Minimum",
          gateId: "min-gate",
          code: "ANSWER_KEY_CHANGED",
          items: 2,
        },
      ],
    },
  },
  personalChangeList: none,
  dropsPersonalChanges: false,
  costDigest: "c".repeat(64),
  ...over,
});
const view: VersionMovesView = {
  versions: [
    {
      releaseId: "r2",
      version: "2.0.0",
      status: "published",
      learners: 0,
      newer: [],
    },
    {
      releaseId: "r1",
      version: "1.0.0",
      status: "published",
      learners: 3,
      newer: [{ releaseId: "r2", version: "2.0.0" }],
    },
  ],
  moves: [],
  permissions: { move: true },
};
const preview: MovePreview = {
  moveId: "m-1",
  previewDigest: "d".repeat(64),
  expiresAt: "2026-10-21T10:15:00Z",
  scope: "cohort",
  enrollmentId: null,
  from: { releaseId: "r1", version: "1.0.0" },
  to: { releaseId: "r2", version: "2.0.0" },
  content: {
    changes: 2,
    lessons: { added: 1, removed: 0, changed: 1, unchanged: 1 },
    questions: { added: 0, removed: 0, changed: 0 },
    newLessons: [{ id: "range", title: "Range" }],
  },
  totals: {
    learners: 3,
    ready: 1,
    waits: 1,
    refused: 1,
    losingCredit: 1,
    carriedCheckpoints: 3,
    offered: 1,
  },
  learners: [
    learner(),
    learner({
      enrollmentId: "e-2",
      displayName: "Ben Example",
      outcome: "waits",
      wait: "ATTEMPT_IN_PROGRESS",
      openWork: { questions: 1, activities: 0 },
      progress: { ...learner().progress, checkpointsAgain: none, kept: 0 },
    }),
    learner({
      enrollmentId: "e-3",
      displayName: null,
      outcome: "refused",
      refusal: "MOVE_PERSONAL_CHANGES",
      personalChanges: 1,
      personalChangeList: {
        count: 1,
        items: [
          { episodeId: "min", title: "Minimum", kind: "append_teaching" },
        ],
      },
    }),
  ],
  rules: { waitsAtMostDays: 7 },
};

function setup(port: Partial<VersionMovesPort>, locale: "en" | "he" = "en") {
  const versionMoves = {
    get: vi.fn(async () => view),
    learners: vi.fn(async () => ({
      learners: [
        { enrollmentId: "e-1", displayName: "Ada Example", status: "active" },
      ],
    })),
    preview: vi.fn(async () => preview),
    confirm: vi.fn(),
    detail: vi.fn(),
    undo: vi.fn(),
    cancel: vi.fn(),
    ...port,
  } as unknown as VersionMovesPort;
  const onMoved = vi.fn();
  render(
    <I18nProvider value={createAdminTranslator(locale)}>
      <VersionMoves
        client={{ mode: "connected", versionMoves } as unknown as AdminClient}
        courseId="cat-1"
        onMoved={onMoved}
      />
    </I18nProvider>,
  );
  return { versionMoves, onMoved };
}

describe("moving learners to a newer version", () => {
  it("previews before anything moves, says what happens to each learner, and needs a reason and an acknowledgement", async () => {
    const confirm = vi.fn(async () => ({
      moveId: "m-1",
      scope: "cohort" as const,
      state: "confirmed",
      reason: "Fixes",
      from: preview.from,
      to: preview.to,
      createdAt: "2026-10-21T10:00:00Z",
      confirmedAt: "2026-10-21T10:01:00Z",
      totals: { moved: 1, waiting: 1, refused: 1, undone: 0, cancelled: 0 },
      learners: [],
    }));
    const { versionMoves, onMoved } = setup({ confirm });
    await userEvent.click(
      await screen.findByRole("button", { name: "Show what would happen" }),
    );
    expect(versionMoves.preview).toHaveBeenCalledWith("cat-1", {
      fromReleaseId: "r1",
      toReleaseId: "r2",
    });
    const panel = await screen.findByRole("region", {
      name: "What moving to version 2.0.0 does",
    });
    const text = stripBidiControls(panel.textContent ?? "");
    expect(text).toContain("Must pass the checkpoint again in: Minimum.");
    expect(text).toContain(
      "3 pieces of evidence stay recorded with version 1.0.0.",
    );
    expect(text).toContain("Answering a question right now.");
    expect(text).toContain("personal changes built on the current version");
    expect(text).toContain("Learner without a name");
    expect(text).toContain("New lessons: Range");
    // What carries over unchanged, and why the rest does not.
    expect(text).toContain("Carries over unchanged: Intro.");
    expect(text).toContain(
      "Minimum: this checkpoint does not carry over. The answer key or rubric of one of its questions changed in the new version.",
    );
    // Learners with personal changes are offered the move instead.
    expect(text).toContain("Personal changes the move would drop: Minimum.");
    expect(text).toContain(
      "1 learner has personal changes. Instead of moving them now, confirming offers them the move in the app.",
    );
    const submit = within(panel).getByRole("button", {
      name: "Move 2 learners",
    });
    expect(submit).toBeDisabled();
    await userEvent.type(
      within(panel).getByLabelText("Why are you moving them?"),
      "Fixes",
    );
    expect(submit).toBeDisabled();
    await userEvent.click(
      within(panel).getByRole("checkbox", {
        name: "I understand that 1 learner must redo some progress, as listed above.",
      }),
    );
    expect(submit).toBeEnabled();
    await userEvent.click(submit);
    expect(confirm).toHaveBeenCalledWith("cat-1", "m-1", {
      previewDigest: preview.previewDigest,
      reason: "Fixes",
      acknowledgeLostCredit: true,
    });
    expect(await screen.findByText(/1 learner moved\./)).toBeVisible();
    expect(onMoved).toHaveBeenCalled();
  });

  it("previews one chosen learner", async () => {
    const { versionMoves } = setup({});
    await userEvent.click(
      await screen.findByRole("radio", { name: "One learner" }),
    );
    await screen.findByRole("option", { name: "Ada Example" });
    await userEvent.click(
      screen.getByRole("button", { name: "Show what would happen" }),
    );
    expect(versionMoves.preview).toHaveBeenCalledWith("cat-1", {
      fromReleaseId: "r1",
      toReleaseId: "r2",
      enrollmentId: "e-1",
    });
  });

  it("says what to do when the server refuses, and hides moving from people who may not", async () => {
    setup({
      preview: vi.fn(async () => {
        throw new VersionMoveError("MOVE_TARGET_NOT_PUBLISHED");
      }),
    });
    await userEvent.click(
      await screen.findByRole("button", { name: "Show what would happen" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Learners can only move to a published version. Publish it first.",
    );
  });

  it("shows nothing to change for a reader without permission", async () => {
    setup({
      get: vi.fn(async () => ({ ...view, permissions: { move: false } })),
    });
    expect(
      await screen.findByText(
        /Only owners and administrators can move learners/,
      ),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Show what would happen" }),
    ).toBeNull();
  });

  it("renders in Hebrew", async () => {
    setup({}, "he");
    await userEvent.click(
      await screen.findByRole("button", { name: "הצגת מה יקרה" }),
    );
    expect(
      await screen.findByRole("region", { name: /מה עושה המעבר לגרסה/ }),
    ).toBeVisible();
  });

  it("translates every code in both languages and falls back for an unknown one", () => {
    expect(Object.keys(he).sort()).toEqual(Object.keys(en).sort());
    expect(moveCodeMessage("SOMETHING_NEW")).toContain("SOMETHING_NEW");
    expect(moveCodeMessage("UNDO_LEARNER_CONTINUED")).toMatch(
      /already worked on the new version/,
    );
  });
});

describe("forcing a move for a learner who did not accept", () => {
  const detail = (
    offer: object | null,
    state: "refused" | "moved" = "refused",
  ): MoveDetail => ({
    moveId: "m-1",
    scope: "learner" as const,
    state: "confirmed",
    reason: "Fixes",
    from: preview.from,
    to: preview.to,
    createdAt: "2026-10-21T10:00:00Z",
    confirmedAt: "2026-10-21T10:01:00Z",
    totals: { moved: 0, waiting: 0, refused: 1, undone: 0, cancelled: 0 },
    learners: [
      {
        enrollmentId: "e-3",
        displayName: "Cy Example",
        state,
        code: state === "refused" ? "MOVE_PERSONAL_CHANGES" : null,
        movedAt: null,
        undoneAt: null,
        undo: null,
        dropsPersonalChanges: false,
        offer: offer as MoveDetail["learners"][number]["offer"],
      },
    ],
  });
  const withHistory = {
    ...view,
    moves: [{ ...detail(null), learners: undefined, undoable: 0 }],
  } as unknown as VersionMovesView;

  it("needs a reason, says what happens to the personal changes, and reports the result", async () => {
    const force = vi.fn(async () => ({
      status: "moved" as const,
      code: null,
      move: detail(
        {
          state: "forced",
          code: null,
          reason: "Retiring v1",
          decidedAt: "2026-10-21T11:00:00Z",
          forcible: false,
        },
        "moved",
      ),
    }));
    const { onMoved } = setup({
      get: vi.fn(async () => withHistory),
      detail: vi.fn(async () =>
        detail({
          state: "declined",
          code: null,
          reason: null,
          decidedAt: "2026-10-21T10:30:00Z",
          forcible: true,
        }),
      ),
      force,
    });
    await userEvent.click(
      await screen.findByRole("button", { name: "Show learners" }),
    );
    expect(
      await screen.findByText(
        "The learner declined the move and keeps their personal changes.",
      ),
    ).toBeVisible();
    const submit = screen.getByRole("button", { name: "Move anyway" });
    expect(submit).toBeDisabled();
    expect(
      screen.getByText(
        /archived, not deleted, and stay in their history and export/,
      ),
    ).toBeVisible();
    await userEvent.type(
      screen.getByLabelText("Why move this learner anyway?"),
      "Retiring v1",
    );
    await userEvent.click(submit);
    expect(force).toHaveBeenCalledWith("cat-1", "m-1", "e-3", {
      reason: "Retiring v1",
    });
    expect(
      await screen.findByText(
        "The learner was moved. Their personal changes are archived.",
      ),
    ).toBeVisible();
    expect(
      screen.getByText(
        /Moved anyway by staff\. Their personal changes are archived\. Reason: Retiring v1/,
      ),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "Move anyway" })).toBeNull();
    expect(onMoved).toHaveBeenCalled();
  });

  it("does not offer forcing to a reader without permission, and says it in Hebrew", async () => {
    setup(
      {
        get: vi.fn(async () => ({
          ...withHistory,
          permissions: { move: false },
        })),
        detail: vi.fn(async () =>
          detail({
            state: "offered",
            code: null,
            reason: null,
            decidedAt: null,
            forcible: true,
          }),
        ),
      },
      "he",
    );
    await userEvent.click(
      await screen.findByRole("button", { name: /הצגת הלומדים/ }),
    );
    expect(await screen.findByText(/נשלחה הצעה לעבור באפליקציה/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "להעביר בכל זאת" })).toBeNull();
  });
});

describe("demo version moves", () => {
  it("moves demo learners only to a newer published version and moves them back", async () => {
    const client = demo();
    const port = client.versionMoves!;
    const before = await port.get("sorting");
    expect(before.versions.every((v) => v.newer.length === 0)).toBe(true);
    const workspace = await client.getCourse("sorting");
    const draft = workspace.releases.find((r) => r.state === "draft")!;
    await expect(
      port.preview("sorting", {
        fromReleaseId: workspace.releases.find((r) => r.state === "published")!
          .id,
        toReleaseId: draft.id,
      }),
    ).rejects.toMatchObject({ code: "MOVE_TARGET_NOT_PUBLISHED" });
    for (const action of ["submit-review", "approve", "publish"] as const)
      await client.transitionRelease(
        "sorting",
        draft.id,
        action,
        await currentContext(client),
      );
    const view = await port.get("sorting");
    const from = view.versions.find((v) => v.version === "1.0.0")!;
    expect(from.newer.map((v) => v.version)).toEqual(["1.1.0"]);
    const previewed = await port.preview("sorting", {
      fromReleaseId: from.releaseId,
      toReleaseId: from.newer[0]!.releaseId,
    });
    expect(previewed.totals.learners).toBeGreaterThan(0);
    await expect(
      port.confirm("sorting", previewed.moveId, {
        previewDigest: "0".repeat(64),
        reason: "Demo",
        acknowledgeLostCredit: false,
      }),
    ).rejects.toMatchObject({ code: "STALE_PREVIEW" });
    const done = await port.confirm("sorting", previewed.moveId, {
      previewDigest: previewed.previewDigest,
      reason: "Demo",
      acknowledgeLostCredit: false,
    });
    expect(done.totals.moved).toBe(previewed.totals.ready);
    const moved = (await client.getCourse("sorting")).enrollments.filter(
      (e) => e.releaseVersion === "1.1.0",
    );
    expect(moved.length).toBe(previewed.totals.ready);
    const undone = await port.undo("sorting", previewed.moveId, {
      reason: "Demo undo",
    });
    expect(undone.undone.length).toBe(previewed.totals.ready);
    await waitFor(async () =>
      expect(
        (await client.getCourse("sorting")).enrollments.some(
          (e) => e.releaseVersion === "1.1.0",
        ),
      ).toBe(false),
    );
  });

  it("offers the move to the demo learner with a personal change, and lets staff force it with a reason", async () => {
    const client = demo();
    const port = client.versionMoves!;
    const workspace = await client.getCourse("sorting");
    const draft = workspace.releases.find((r) => r.state === "draft")!;
    for (const action of ["submit-review", "approve", "publish"] as const)
      await client.transitionRelease(
        "sorting",
        draft.id,
        action,
        await currentContext(client),
      );
    const from = (await port.get("sorting")).versions.find(
      (v) => v.version === "1.0.0",
    )!;
    const previewed = await port.preview("sorting", {
      fromReleaseId: from.releaseId,
      toReleaseId: from.newer[0]!.releaseId,
    });
    const personal = previewed.learners.find(
      (l) => l.refusal === "MOVE_PERSONAL_CHANGES",
    )!;
    expect(personal.personalChangeList.count).toBe(1);
    expect(previewed.totals.offered).toBe(1);
    expect(previewed.totals.carriedCheckpoints).toBeGreaterThan(0);
    const done = await port.confirm("sorting", previewed.moveId, {
      previewDigest: previewed.previewDigest,
      reason: "Demo",
      acknowledgeLostCredit: false,
    });
    expect(
      done.learners.find((l) => l.enrollmentId === personal.enrollmentId)!
        .offer,
    ).toMatchObject({ state: "offered", forcible: true });
    await expect(
      port.force("sorting", previewed.moveId, personal.enrollmentId, {
        reason: " ",
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    const forced = await port.force(
      "sorting",
      previewed.moveId,
      personal.enrollmentId,
      { reason: "Demo force" },
    );
    expect(
      forced.move.learners.find(
        (l) => l.enrollmentId === personal.enrollmentId,
      ),
    ).toMatchObject({
      state: "moved",
      dropsPersonalChanges: true,
      offer: { state: "forced", reason: "Demo force" },
    });
    await expect(
      port.force("sorting", previewed.moveId, personal.enrollmentId, {
        reason: "Again",
      }),
    ).rejects.toMatchObject({ code: "MOVE_OFFER_NOT_OPEN" });
  });

  it("refuses moving for a reviewer", async () => {
    const port = demo({ role: "reviewer" }).versionMoves!;
    const view = await port.get("sorting");
    expect(view.permissions.move).toBe(false);
    await expect(
      port.preview("sorting", { fromReleaseId: "a", toReleaseId: "b" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
