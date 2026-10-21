import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { stripBidiControls } from "@course-core/i18n";
import { I18nProvider, createAdminTranslator } from "../src/i18n";
import {
  ResearchActionError,
  researchErrorMessage,
} from "../src/domain/research";
import {
  StudyError,
  defaultArms,
  setLabel,
  studyErrorMessage,
} from "../src/domain/studies";
import {
  MediaActionError,
  failureText,
  mediaErrorMessage,
  usd,
} from "../src/domain/media";
import {
  ConceptMappingError,
  conceptMappingErrorMessage,
} from "../src/domain/conceptMappings";
import { StudyView } from "../src/views/StudyView";
import { ConceptMappingsView } from "../src/views/ConceptMappingsView";
import { ResearchView } from "../src/views/ResearchView";
import type { AdminClient, CourseWorkspace } from "../src/domain/contracts";
import type { Studies } from "../src/domain/studies";
import type {
  ConceptMappingPort,
  MappingPair,
} from "../src/domain/conceptMappings";

const he = createAdminTranslator("he");
const en = createAdminTranslator("en");
const plain = (text: string | null) => stripBidiControls(text ?? "");

describe("research, studies, media and mapping messages", () => {
  it("translate known server codes and fall back for unknown ones", () => {
    expect(
      researchErrorMessage(new ResearchActionError("FORBIDDEN"), he.t),
    ).toBe("התפקיד שלך לא מאפשר את פעולת המחקר הזו.");
    // Points at the page's YouTube search card, which alone says where the key goes.
    expect(
      plain(
        researchErrorMessage(
          new ResearchActionError("YOUTUBE_SEARCH_NOT_CONFIGURED"),
          he.t,
        ),
      ),
    ).toContain("חיפוש ב-YouTube");
    expect(
      researchErrorMessage(
        new ResearchActionError("YOUTUBE_SEARCH_NOT_CONFIGURED"),
      ),
    ).toBe(
      "Nothing was searched: this workspace has no YouTube key yet. The YouTube search card on this page says where to add it.",
    );
    expect(
      researchErrorMessage(new ResearchActionError("RESEARCH_FETCH_FAILED")),
    ).toBe(
      "Inspection or review was refused (fetch failed). Nothing was approved or delivered.",
    );
    expect(researchErrorMessage(new Error("offline"), he.t)).toBe(
      "שירות המחקר אינו זמין. שום דבר לא אושר ולא נמסר.",
    );
    expect(
      studyErrorMessage(
        new StudyError("INVALID_REQUEST", [
          "STUDY_PRE_REQUIRED",
          "STUDY_SOMETHING_NEW",
        ]),
        he.t,
      ),
    ).toBe("כדי לפתוח צריך לפחות פריט אחד במבחן המקדים. STUDY_SOMETHING_NEW");
    expect(studyErrorMessage(new StudyError("NOPE"), he.t)).toBe(
      "המחקרים אינם זמינים כרגע. שום דבר לא השתנה.",
    );
    expect(mediaErrorMessage(new MediaActionError("MEDIA_NEW_CODE"))).toBe(
      "The media service refused this (new code). Nothing was published.",
    );
    expect(failureText("MEDIA_CAPACITY", he.t)).toBe(
      "נדחה: יותר מדי משימות מדיה כבר רצות",
    );
    expect(failureText("MEDIA_SOMETHING_ELSE", he.t)).toBe(
      "media something else",
    );
    expect(failureText(null, he.t)).toBeNull();
    expect(
      conceptMappingErrorMessage(new ConceptMappingError("FORBIDDEN"), he.t),
    ).toMatch(/^רק בעלים או מנהל\/ת/);
    expect(conceptMappingErrorMessage(undefined)).toBe(
      "Concept mappings are unavailable right now. Nothing changed.",
    );
  });

  it("formats dollar amounts for the locale with 2 or 4 decimals", () => {
    expect(usd(400_000, en)).toBe("$0.40");
    expect(usd(12_345, en)).toBe("$0.0123");
    expect(usd(null, en)).toBe("not available");
    expect(usd(null, he)).toBe("לא זמין");
    const hebrew = stripBidiControls(usd(400_000, he));
    expect(hebrew).toContain("0.40");
    expect(hebrew).toContain("$");
  });

  it("names default arms and instrument sets in the author's locale", () => {
    expect(defaultArms(he.t).map((arm) => [arm.id, arm.label])).toEqual([
      ["fixed", "מסלול קבוע"],
      ["chat_only", "מלווה בצ'אט בלבד"],
      ["supervisor", "פיקוח מלא"],
    ]);
    expect(defaultArms().map((arm) => arm.label)).toEqual([
      "Fixed path",
      "Chat-only companion",
      "Full supervisor",
    ]);
    expect(setLabel("delayed", he.t)).toBe("בדיקה מאוחרת");
  });
});

const releaseId = "00000000-0000-4000-8000-0000000000a1";
const studies: Studies = {
  canManage: true,
  canExport: true,
  releases: [
    {
      id: releaseId,
      version: "1.0.0",
      status: "published",
      placementEnabled: true,
      items: [],
    },
  ],
  studies: [
    {
      id: "00000000-0000-4000-8000-000000000051",
      releaseId,
      title: "Ordering study",
      purpose: "We compare three versions of this course.",
      state: "recruiting",
      revision: 2,
      arms: (["fixed", "chat_only"] as const).map((id) => ({
        id,
        label: id,
        behaviour: id,
        explanation: "x",
        consented: 1,
        withdrawn: 0,
      })),
      instruments: { pre: [], post: [], transfer: [], delayed: [] },
      minCellSize: 5,
      seedDigest: "a".repeat(64),
      consent: { eligible: 2, consented: 2, withdrawn: 0, undecided: 0 },
      createdAt: "2026-10-01T10:00:00.000Z",
      openedAt: "2026-10-02T10:00:00.000Z",
      closedAt: null,
      warnings: [],
    },
  ],
};

describe("study and concept mapping views in Hebrew", () => {
  it("renders the study card in Hebrew with ids and digests left to right", async () => {
    render(
      <I18nProvider value={he}>
        <StudyView
          data={{ course: { id: "c1" } } as unknown as CourseWorkspace}
          client={
            {
              studies: { list: vi.fn(async () => studies) },
            } as unknown as AdminClient
          }
        />
      </I18nProvider>,
    );
    expect(await screen.findByText("על המחקרים")).toBeVisible();
    expect(screen.getByText("בגיוס")).toBeVisible();
    expect(
      screen.getByText(/השיבוץ מופעל בקורס הזה, באותו אופן בכל הזרועות\./),
    ).toBeVisible();
    expect(screen.getByText(`${"a".repeat(16)}…`)).toHaveAttribute(
      "dir",
      "ltr",
    );
    // The opened time is formatted for Hebrew, in UTC.
    expect(screen.getByText(/נפתח ב-/).textContent).toMatch(/UTC/);
    expect(
      screen.getByRole("button", { name: /^ייצוא .*CSV/ }),
    ).toBeInTheDocument();
  });

  it("shows a prerequisite link read from the second course as 'requires' with Hebrew history", async () => {
    const a = {
      releaseId: "00000000-0000-4000-8000-000000000071",
      workspaceId: "00000000-0000-4000-8000-000000000090",
      courseKey: "sorting",
      version: "1.0.0",
      title: "Sorting",
    };
    const b = {
      ...a,
      releaseId: "00000000-0000-4000-8000-000000000072",
      courseKey: "graphs",
      title: "Graphs",
    };
    const pair: MappingPair = {
      courses: {
        a: { ...a, objectives: [{ id: "o1", description: "Sort a list" }] },
        b: { ...b, objectives: [{ id: "g1", description: "Trace BFS" }] },
      },
      mapping: {
        id: "00000000-0000-4000-8000-000000000099",
        revision: 3,
        state: "retired",
        updatedAt: "2026-10-02T10:00:00.000Z",
        courses: { a, b },
        links: [
          {
            relation: "prerequisite_of",
            from: { releaseId: b.releaseId, objectiveId: "g1" },
            to: { releaseId: a.releaseId, objectiveId: "o1" },
          },
        ],
        linksDigest: "d",
        authoredBy: "staff",
        inferred: false,
        history: [
          {
            revision: 3,
            action: "retired",
            linkCount: 1,
            linksDigest: "d",
            author: {
              id: "00000000-0000-4000-8000-000000000098",
              displayName: "דנה לוי",
            },
            roles: { a: "support_observer", b: "auditor" },
            note: "",
            createdAt: "2026-10-02T10:00:00.000Z",
          },
        ],
      },
    };
    const port: ConceptMappingPort = {
      candidates: vi.fn(async () => ({
        courses: [a, b].map((c, i) => ({
          catalogId: `00000000-0000-4000-8000-00000000008${i}`,
          workspaceId: c.workspaceId,
          workspaceTitle: "Main",
          courseKey: c.courseKey,
          title: c.title,
          role: "owner",
          releases: [
            {
              releaseId: c.releaseId,
              version: c.version,
              status: i ? "archived" : "published",
              title: null,
              objectives: [],
            },
          ],
        })),
        maxLinks: 10,
      })),
      pair: vi.fn(async () => pair),
      save: vi.fn(),
      retire: vi.fn(),
    };
    const user = userEvent.setup();
    render(
      <I18nProvider value={he}>
        <ConceptMappingsView
          client={{ conceptMappings: port } as unknown as AdminClient}
        />
      </I18nProvider>,
    );
    const first = await screen.findByLabelText("קורס ראשון");
    expect(
      within(screen.getByLabelText("קורס שני"))
        .getAllByRole("option")
        .map((o) => plain(o.textContent)),
    ).toContain("Graphs 1.0.0 (בארכיון) · Main");
    await user.selectOptions(first, a.releaseId);
    await user.selectOptions(screen.getByLabelText("קורס שני"), b.releaseId);
    expect(await screen.findByLabelText("יחס")).toHaveValue("requires");
    expect(
      screen.getByRole("option", { name: "דורשת (כדרישת קדם) את המטרה" }),
    ).toBeInTheDocument();
    expect(screen.getByText("הוצא משימוש · גרסה 3")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "שחזור עם הקישורים האלה" }),
    ).toBeVisible();
    const history = screen.getByRole("region", { name: "היסטוריית המיפוי" });
    expect(within(history).getByText("דנה לוי").tagName).toBe("BDI");
    // Roles use the shell's names; an unknown role stays a code, not a wrong translation.
    expect(plain(within(history).getByText(/התמיכה/).textContent)).toBe(
      "(צופה מטעם התמיכה / auditor)",
    );
  });
});

describe("YouTube search without a key", () => {
  const data = {
    releases: [
      {
        id: "release-1",
        version: "1.0.0",
        state: "published",
        availableForNewLearners: true,
      },
    ],
    permissions: ["course.write", "provider.configure"],
    course: { id: "course-1", workspaceId: "workspace-1" },
  } as unknown as CourseWorkspace;
  const research = (configured: boolean) =>
    ({
      library: async () => ({
        topics: [
          {
            id: "topic-1",
            queryText: "gradient descent",
            episodes: [],
            allowedDomains: [],
          },
        ],
        sources: [],
        attachments: [],
        searches: [],
      }),
      queue: async () => ({ requests: [] }),
      youtubeSearch: vi.fn(async () => ({})),
      youtubeStatus: async () => ({
        configured,
        searches: { used: 0, limit: 10 },
        units: { used: 0, limit: 1000 },
        resetsAt: "2026-10-22T07:00:00.000Z",
        exhaustedByProvider: false,
      }),
    }) as unknown as NonNullable<AdminClient["research"]>;

  it("says where the key goes once and keeps search off until it is added", async () => {
    const port = research(false);
    render(
      <I18nProvider value={createAdminTranslator("en")}>
        <ResearchView data={data} client={{ research: port } as AdminClient} />
      </I18nProvider>,
    );
    expect(
      await screen.findByText(/^YouTube search is off until/),
    ).toBeVisible();
    expect(screen.getAllByText(/AI services, under Advanced/)).toHaveLength(1);
    expect(
      screen.getByRole("button", { name: "Search YouTube" }),
    ).toBeDisabled();
  });

  it("allows search once a key is configured", async () => {
    render(
      <I18nProvider value={createAdminTranslator("en")}>
        <ResearchView
          data={data}
          client={{ research: research(true) } as AdminClient}
        />
      </I18nProvider>,
    );
    expect(await screen.findByText(/^Today: 0 of 10 searches/)).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Search YouTube" }),
    ).toBeEnabled();
  });
});
