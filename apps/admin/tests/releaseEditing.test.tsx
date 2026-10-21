import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { stripBidiControls } from "@course-core/i18n";
import {
  asEditable,
  blockEdits,
  chapterEdits,
  episodeEdits,
  localProblems,
  newId,
  type EditableManifest,
  type LearnerPreview as Preview,
  type ManifestCheck,
  type PublishImpact as Impact,
  type ReleaseEditingPort,
} from "../src/domain/releaseEditing";
import { createFetchAdminClient } from "../src/client/fetchClient";
import {
  StructuredDraftEditor,
  describePath,
} from "../src/components/StructuredDraftEditor";
import { LearnerPreview } from "../src/components/LearnerPreview";
import { PublishImpact } from "../src/components/PublishImpact";
import type { AdminClient } from "../src/domain/contracts";
import type { WorkspaceActions } from "../src/hooks/useAdmin";
import { I18nProvider, createAdminTranslator } from "../src/i18n";

// A synthetic two-chapter course: only its shape matters here.
const course = (): EditableManifest => ({
  schemaVersion: 1,
  id: "synthetic",
  version: "2.0.0",
  objectives: [
    { id: "first", description: "First idea" },
    { id: "second", description: "Second idea" },
  ],
  chapters: [
    {
      id: "basics",
      title: "Basics",
      episodes: [
        {
          id: "intro",
          title: "Intro",
          objectiveIds: ["first"],
          blocks: [
            { id: "intro-text", type: "text", markdown: "Hello." },
            { id: "intro-check", type: "assessment", assessmentId: "q1" },
          ],
        },
        {
          id: "more",
          title: "More",
          objectiveIds: ["second"],
          gateId: "g1",
          blocks: [{ id: "more-text", type: "text", markdown: "More." }],
        },
      ],
    },
    {
      id: "advanced",
      title: "Advanced",
      episodes: [
        {
          id: "deep",
          title: "Deep",
          objectiveIds: ["second"],
          blocks: [{ id: "deep-text", type: "text", markdown: "Deep." }],
        },
      ],
    },
  ],
});
const ID = /^[a-z][a-z0-9._:-]{0,127}$/;

describe("structured edits", () => {
  it("never changes the input, and new ids are valid and unique", () => {
    const before = course();
    const snapshot = JSON.stringify(before);
    const added = chapterEdits.add(before, "Basics", "Intro");
    expect(JSON.stringify(before)).toBe(snapshot);
    const chapter = added.chapters.at(-1)!;
    expect(chapter.id).toBe("basics-2");
    expect(chapter.episodes[0]).toMatchObject({
      id: "intro-2",
      title: "Intro",
      objectiveIds: ["first"],
      blocks: [{ type: "text", markdown: "" }],
    });
    // Titles in other scripts fall back to a plain id.
    const hebrew = chapterEdits.add(added, "פרק חדש", "שיעור");
    expect(hebrew.chapters.at(-1)!.id).toBe("chapter");
    expect(hebrew.chapters.at(-1)!.episodes[0]!.id).toBe("lesson");
    const ids = JSON.stringify(hebrew).match(/"id":"[^"]+"/g)!;
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id.slice(6, -1)).toMatch(ID);
    expect(newId("123 numbers first", "lesson", before)).toBe("lesson");
  });

  it("renames, reorders, moves and removes chapters, lessons and text", () => {
    let m = course();
    m = chapterEdits.rename(m, "basics", "Foundations");
    m = chapterEdits.summary(m, "basics", "Start here.");
    m = chapterEdits.move(m, "advanced", -1);
    expect(m.chapters.map((c) => c.id)).toEqual(["advanced", "basics"]);
    expect(m.chapters[1]).toMatchObject({
      title: "Foundations",
      summary: "Start here.",
    });
    expect(
      chapterEdits.summary(m, "basics", " ").chapters[1],
    ).not.toHaveProperty("summary");
    m = episodeEdits.move(m, "more", -1);
    expect(m.chapters[1]!.episodes.map((e) => e.id)).toEqual(["more", "intro"]);
    m = episodeEdits.requirement(m, "intro", "optional");
    expect(m.chapters[1]!.episodes[1]!.requirement).toBe("optional");
    expect(
      episodeEdits.requirement(m, "intro", "required").chapters[1]!.episodes[1],
    ).not.toHaveProperty("requirement");
    m = episodeEdits.toChapter(m, "intro", "advanced");
    expect(m.chapters[0]!.episodes.map((e) => e.id)).toEqual(["deep", "intro"]);
    m = episodeEdits.objectives(m, "intro", ["first", "second"]);
    m = blockEdits.text(m, "intro", "intro-text", "Changed.");
    m = blockEdits.addText(m, "intro");
    m = blockEdits.move(m, "intro", "intro-check", -1);
    const intro = m.chapters[0]!.episodes[1]!;
    expect(intro.objectiveIds).toEqual(["first", "second"]);
    expect(intro.blocks.map((b) => b.type)).toEqual([
      "assessment",
      "text",
      "text",
    ]);
    expect(intro.blocks[1]!.markdown).toBe("Changed.");
    // A check block is never turned into text.
    expect(
      blockEdits.text(m, "intro", "intro-check", "x").chapters[0]!.episodes[1]!
        .blocks[0],
    ).not.toHaveProperty("markdown");
    m = blockEdits.remove(m, "intro", intro.blocks[2]!.id);
    m = episodeEdits.remove(m, "deep");
    m = chapterEdits.remove(m, "basics");
    expect(m.chapters.map((c) => c.id)).toEqual(["advanced"]);
    // Moving past either end changes nothing.
    expect(chapterEdits.move(m, "advanced", 1)).toEqual(m);
  });

  it("names local problems and server paths in staff terms", () => {
    let m = course();
    m = chapterEdits.rename(m, "basics", " ");
    m = episodeEdits.objectives(m, "intro", []);
    expect(localProblems(m)).toEqual([
      { code: "chapter_title", id: "basics" },
      { code: "lesson_objective", id: "intro" },
    ]);
    expect(localProblems({ ...m, chapters: [] })).toEqual([
      { code: "course_empty", id: "" },
    ]);
    expect(describePath(course(), "/chapters/1/episodes/0/title")).toEqual([
      "Advanced",
      "Deep",
    ]);
    expect(describePath(course(), "/assessments/0")).toEqual([]);
    expect(asEditable({ chapters: "nope" })).toBeNull();
    expect(asEditable(course())).not.toBeNull();
  });
});

const valid: ManifestCheck = {
  valid: true,
  issues: [],
  identityMatches: true,
  summary: { chapters: 2, episodes: 3, assessments: 1, objectives: 2 },
  digest: "a".repeat(64),
  runtime: { ready: true, code: null },
  changes: { identical: false, changes: 1, kinds: {} },
};
function editorSetup(check: ManifestCheck) {
  const port = {
    check: vi.fn(async () => check),
    preview: vi.fn(),
    publishImpact: vi.fn(),
  } as unknown as ReleaseEditingPort;
  const updateRelease = vi.fn(async () => ({}));
  const client = {
    getReleaseManifest: vi.fn(async () => ({
      manifest: course(),
      notes: "Notes.",
      editable: true,
    })),
    updateRelease,
  } as unknown as AdminClient;
  const actions = {
    pending: false,
    run: vi.fn(
      async (_key: string, action: (context: unknown) => Promise<unknown>) =>
        action({ expectedRevision: "1", idempotencyKey: "k" }),
    ),
  } as unknown as WorkspaceActions;
  const onClose = vi.fn();
  render(
    <StructuredDraftEditor
      client={client}
      port={port}
      courseId="c1"
      releaseId="r1"
      actions={actions}
      onClose={onClose}
    />,
  );
  return { port, updateRelease, onClose };
}

describe("structured draft editor", () => {
  it("edits a lesson title, checks the exact draft on the server, then saves it", async () => {
    const user = userEvent.setup();
    const { port, updateRelease, onClose } = editorSetup(valid);
    const dialog = await screen.findByRole("dialog", { name: "Edit draft" });
    await user.click(within(dialog).getByText("Intro"));
    const title = within(dialog).getAllByLabelText("Lesson title")[0]!;
    await user.clear(title);
    await user.type(title, "Welcome");
    await user.click(
      within(dialog).getByRole("button", { name: "Check the draft" }),
    );
    expect(
      await within(dialog).findByText("The draft passed every check"),
    ).toBeVisible();
    const checked = (port.check as ReturnType<typeof vi.fn>).mock
      .calls[0]![2] as EditableManifest;
    expect(checked.chapters[0]!.episodes[0]!.title).toBe("Welcome");
    await user.click(
      within(dialog).getByRole("button", { name: "Check and save draft" }),
    );
    await waitFor(() => expect(updateRelease).toHaveBeenCalledTimes(1));
    const [courseId, releaseId, input] = updateRelease.mock
      .calls[0] as unknown as [
      string,
      string,
      { notes: string; manifest: EditableManifest },
    ];
    expect([courseId, releaseId, input.notes]).toEqual(["c1", "r1", "Notes."]);
    expect(input.manifest.chapters[0]!.episodes[0]!.title).toBe("Welcome");
    expect(onClose).toHaveBeenCalled();
  });

  it("does not save a draft the server refuses, and says where the problem is", async () => {
    const user = userEvent.setup();
    const { updateRelease } = editorSetup({
      ...valid,
      valid: false,
      issues: [
        { code: "MISSING_REFERENCE", path: "/chapters/0/episodes/1/gateId" },
      ],
      summary: null,
      digest: null,
      runtime: null,
      changes: null,
    });
    const dialog = await screen.findByRole("dialog", { name: "Edit draft" });
    await user.click(
      within(dialog).getByRole("button", { name: "Check and save draft" }),
    );
    const notice = await within(dialog).findByRole("alert");
    expect(stripBidiControls(notice.textContent ?? "")).toContain(
      "Basics › More: This points to something the course does not define.",
    );
    expect(updateRelease).not.toHaveBeenCalled();
  });

  it("blocks saving locally when a lesson loses every objective", async () => {
    const user = userEvent.setup();
    const { port } = editorSetup(valid);
    const dialog = await screen.findByRole("dialog", { name: "Edit draft" });
    await user.click(within(dialog).getByText("Intro"));
    await user.click(
      within(dialog).getAllByRole("checkbox", { name: "First idea" })[0]!,
    );
    expect(
      within(dialog).getByText(
        /Lesson “Intro” needs at least one learning objective/,
      ),
    ).toBeVisible();
    expect(
      within(dialog).getByRole("button", { name: "Check and save draft" }),
    ).toBeDisabled();
    expect(port.check).not.toHaveBeenCalled();
  });
});

const preview: Preview = {
  source: "saved",
  syntheticLearners: true,
  course: {
    id: "synthetic",
    version: "2.0.0",
    title: "Synthetic",
    locale: "en",
  },
  outline: [
    {
      id: "basics",
      title: "Basics",
      episodes: [
        {
          id: "intro",
          title: "Intro",
          requirement: "required",
          gateId: null,
          blocks: 2,
        },
      ],
    },
  ],
  profiles: [
    {
      profile: "new_learner",
      complete: false,
      counts: { completed: 0, placed: 0, available: 1, locked: 0 },
      lessons: [
        {
          episodeId: "intro",
          chapterId: "basics",
          requirement: "required",
          status: "available",
        },
      ],
      next: {
        episodeId: "intro",
        title: "Intro",
        chapterId: "basics",
        blocks: [
          { id: "t", type: "text", excerpt: "Hello.", truncated: false },
        ],
      },
    },
    {
      profile: "placed_out",
      complete: true,
      counts: { completed: 0, placed: 1, available: 0, locked: 0 },
      lessons: [
        {
          episodeId: "intro",
          chapterId: "basics",
          requirement: "required",
          status: "placed",
        },
      ],
      next: null,
    },
    {
      profile: "first_chapter_done",
      complete: true,
      counts: { completed: 1, placed: 0, available: 0, locked: 0 },
      lessons: [
        {
          episodeId: "intro",
          chapterId: "basics",
          requirement: "required",
          status: "completed",
        },
      ],
      next: null,
    },
    {
      profile: "nearly_finished",
      complete: false,
      counts: { completed: 0, placed: 0, available: 1, locked: 0 },
      lessons: [
        {
          episodeId: "intro",
          chapterId: "basics",
          requirement: "required",
          status: "available",
        },
      ],
      next: null,
    },
  ],
};

describe("learner preview and publish impact", () => {
  it("shows each made-up learner's roadmap and next lesson, in Hebrew too", async () => {
    const user = userEvent.setup();
    const port = {
      preview: vi.fn(async () => preview),
    } as unknown as ReleaseEditingPort;
    const { unmount } = render(
      <LearnerPreview
        port={port}
        courseId="c1"
        releaseId="r1"
        manifest={{ x: 1 }}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Show the preview" }));
    expect(port.preview).toHaveBeenCalledWith("c1", "r1", { x: 1 });
    expect(await screen.findByText("What they see next")).toBeVisible();
    expect(screen.getByText("Hello.")).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: "Tested out of what they know" }),
    );
    expect(screen.getByText("Tested out")).toBeVisible();
    expect(
      screen.getByText("This learner has finished every required lesson."),
    ).toBeVisible();
    unmount();
    render(
      <I18nProvider value={createAdminTranslator("he")}>
        <LearnerPreview port={port} courseId="c1" releaseId="r1" />
      </I18nProvider>,
    );
    await user.click(screen.getByRole("button", { name: "הצגת התצוגה" }));
    expect(await screen.findByText("מה רואים בהמשך")).toBeVisible();
  });

  it("confirms publication with the digest of the analysis shown", async () => {
    const user = userEvent.setup();
    const impact: Impact = {
      impact: {
        from: {
          id: "00000000-0000-4000-8000-000000000001",
          version: "1.0.0",
          digest: "b".repeat(64),
        },
        to: {
          id: "00000000-0000-4000-8000-000000000002",
          version: "2.0.0",
          digest: "c".repeat(64),
        },
        contentChanges: 2,
        kinds: { episodes: { added: 1, removed: 0, changed: 1 } },
        changedOrRemovedEpisodes: ["intro"],
        changedOrRemovedItems: [],
        learnersPinnedToActive: 7,
        learnersMidwayInChangedLessons: 2,
        enrollmentsLast30Days: 4,
        defectiveItemsFixed: [],
        defectiveItemsCarriedOver: ["q9"],
        newLearnersGet: "2.0.0",
        existingLearnersMove: false,
      },
      impactDigest: "d".repeat(64),
      confirmationRequired: true,
    };
    const port = {
      publishImpact: vi.fn(async () => impact),
    } as unknown as ReleaseEditingPort;
    const onConfirm = vi.fn();
    render(
      <PublishImpact
        port={port}
        courseId="c1"
        releaseId="r2"
        version="2.0.0"
        pending={false}
        onConfirm={onConfirm}
      />,
    );
    expect(
      await screen.findByText(/7 learners stay on version 1.0.0/),
    ).toBeVisible();
    expect(
      screen.getByText(/2 enrolled learners are part-way through a lesson/),
    ).toBeVisible();
    expect(screen.getByText("Faulty checks carried over")).toBeVisible();
    expect(
      screen.getByText(/Lessons: 1 added, 1 changed, 0 removed/),
    ).toBeVisible();
    const confirm = screen.getByRole("button", { name: "Confirm publication" });
    expect(confirm).toBeDisabled();
    await user.click(
      screen.getByRole("checkbox", {
        name: "I confirm publication of version 2.0.0.",
      }),
    );
    await user.click(confirm);
    expect(onConfirm).toHaveBeenCalledWith("d".repeat(64), false);
  });

  it("publishing an older version than one already published also needs that confirmed", async () => {
    const user = userEvent.setup();
    const port = {
      publishImpact: vi.fn(async () => ({
        impact: {
          from: null,
          newLearnersGet: "1.5.0",
          enrollmentsLast30Days: 0,
          learnersPinnedToActive: 0,
          learnersMidwayInChangedLessons: 0,
          defectiveItemsFixed: [],
          defectiveItemsCarriedOver: [],
          existingLearnersMove: false,
        },
        impactDigest: "e".repeat(64),
        confirmationRequired: true,
      })),
    } as unknown as ReleaseEditingPort;
    const onConfirm = vi.fn();
    render(
      <PublishImpact
        port={port}
        courseId="c1"
        releaseId="r3"
        version="1.5.0"
        newerPublished="2.0.0"
        pending={false}
        onConfirm={onConfirm}
      />,
    );
    expect(
      await screen.findByText(/Version 2.0.0 is already published/),
    ).toBeVisible();
    await user.click(
      screen.getByRole("checkbox", {
        name: "I confirm publication of version 1.5.0.",
      }),
    );
    const confirm = screen.getByRole("button", { name: "Confirm publication" });
    expect(confirm).toBeDisabled();
    await user.click(
      screen.getByRole("checkbox", {
        name: "I want to publish the older version 1.5.0",
      }),
    );
    await user.click(confirm);
    expect(onConfirm).toHaveBeenCalledWith("e".repeat(64), true);
  });

  it("calls the check, preview and impact routes and maps refusals to plain messages", async () => {
    const calls: { url: string; body: unknown; method: string }[] = [];
    const client = createFetchAdminClient({
      baseUrl: "/api/admin",
      fetch: async (url, init) => {
        calls.push({
          url: String(url),
          method: init?.method ?? "GET",
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        return new Response(
          JSON.stringify({ error: "COURSE_IDENTITY_MISMATCH" }),
          { status: 400 },
        );
      },
    });
    const refused = await client
      .releaseEditing!.preview("c1", "r1", { id: "x" })
      .catch((e) => e);
    expect(refused.code).toBe("COURSE_IDENTITY_MISMATCH");
    await client.releaseEditing!.check("c1", "r1", { id: "x" }).catch(() => {});
    await client.releaseEditing!.publishImpact("c1", "r1").catch(() => {});
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "POST /api/admin/courses/c1/releases/r1/preview",
      "POST /api/admin/courses/c1/releases/r1/check",
      "GET /api/admin/courses/c1/releases/r1/publish-impact",
    ]);
    expect(calls[0]!.body).toEqual({ manifest: { id: "x" } });
  });
});
