import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { accent } from "@course-core/i18n";
import { demoSession, demoWorkspace } from "../../src/data/fixtures";

/** Research sources, generated media, studies and concept mappings in Hebrew and in en-XA. */

const now = "2026-10-02T10:00:00.000Z",
  later = "2026-12-30T10:00:00.000Z";
const hex = (c: string) => c.repeat(64);
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const topicId = "topic-sorting";
const library = {
  release: { id: uuid(1), version: "1.0.0", status: "published" },
  topics: [
    {
      id: topicId,
      objectiveIds: ["obj-1"],
      queryText: "How insertion sort works",
      allowedDomains: ["example.org"],
      episodes: [{ id: "ep-1", title: "Insertion sort" }],
    },
  ],
  sources: [
    {
      id: uuid(11),
      topicId,
      kind: "web",
      url: "https://example.org/insertion-sort",
      fallbackText: null,
      candidateId: null,
      expiresAt: later,
      createdAt: now,
      expired: false,
      inspections: [
        {
          id: hex("a"),
          createdAt: now,
          title: "Insertion sort explained",
          kind: "web",
          basis: "page",
          truncated: true,
          contentDigest: hex("b"),
          text: "Insertion sort builds the sorted list one item at a time.",
          finalUrl: "https://example.org/insertion-sort",
          metadataAvailability: "available",
          fetchedAt: now,
          hops: [],
          attributions: [
            { providerName: "Example Org", authorName: "A. Author" },
          ],
        },
      ],
      failures: [],
      reviews: [
        {
          id: hex("c"),
          inspectionId: hex("a"),
          decision: "approved",
          rationale: "Clear explanation matching the lesson.",
          evidence: [],
          suitability: {
            topicRelevant: true,
            accurateEnoughForUse: true,
            safeForAudience: true,
          },
          rights: { use: "link_only", basis: "link_only", reference: "Linked" },
          segment: null,
          reviewedBy: "u1",
          reviewedAt: now,
        },
      ],
    },
    {
      id: uuid(12),
      topicId,
      kind: "youtube",
      url: "https://www.youtube.com/watch?v=abcdefghijk",
      fallbackText: "Shows items shifting right.",
      candidateId: null,
      durationSeconds: 245,
      captions: "creator_captions",
      embeddable: true,
      expiresAt: later,
      createdAt: now,
      expired: false,
      inspections: [],
      failures: [{ code: "FETCH_FAILED", createdAt: now }],
      reviews: [],
    },
  ],
  attachments: [
    {
      id: uuid(21),
      reviewId: hex("c"),
      sourceId: uuid(11),
      episodeId: "ep-1",
      topicId,
      expiresAt: later,
      createdAt: now,
      state: "active",
      revokedAt: null,
      revokeReason: null,
    },
  ],
  searches: [
    {
      id: uuid(31),
      topicId,
      createdAt: now,
      sent: { q: "insertion sort", relevanceLanguage: null, maxResults: 5 },
      hits: [
        {
          videoId: "zyxwvutsrqp",
          watchUrl: "https://www.youtube.com/watch?v=zyxwvutsrqp",
          title: "Insertion sort in 4 minutes",
          channelTitle: "Algorithms channel",
          publishedAt: null,
          durationSeconds: 245,
          embeddable: false,
          captions: "unknown",
          reviewStatus: "unreviewed",
        },
      ],
      reviewStatus: "unreviewed",
    },
  ],
  grantsCredit: false,
};
const queue = {
  requests: [
    {
      id: "r1",
      topicId,
      episodeId: "ep-1",
      state: "completed",
      candidateId: null,
      reviewState: null,
      content: {
        sources: [
          { uri: "https://example.org/another", title: "Another explanation" },
        ],
      },
    },
  ],
};
const settings = {
  durationSeconds: 8,
  aspectRatio: "16:9",
  resolution: "720p",
};
const pricing = {
  microUsdPerOutputSecond: 50_000,
  source: "Operator rate card",
  reviewedAt: "2026-10-01",
};
const job = (n: number, state: string, failureCode: string | null) => ({
  id: uuid(40 + n),
  state,
  failureCode,
  kind: "generated_short_video",
  paid: true,
  storyboardId: null,
  shotId: null,
  referenceVisualId: null,
  source: null,
  title: n === 1 ? "Insertion sort animation" : "Shifting items clip",
  objective: "See how items shift.",
  script: "Five cards. The third card moves left.",
  enrollmentId: uuid(51),
  learnerName: "Dana Levi",
  episodeId: "ep-1",
  providerRevision: 1,
  modelId: "video-model-1",
  settings,
  pricing,
  estimateMicroUsd: 400_000,
  chargedMicroUsd: state === "failed" ? 0 : 400_000,
  providerOperationId: state === "failed" ? null : "op-123",
  remoteMayContinue: state !== "failed",
  submitAttempts: 1,
  pollAttempts: 3,
  deadlineAt: later,
  createdAt: now,
  updatedAt: now,
  asset: null,
  review: null,
  attachment: null,
  events: [
    { from: null, to: "requested", code: null, at: now },
    { from: "requested", to: state, code: failureCode, at: now },
  ],
  learnerVisible: false,
  grantsCredit: false,
});
const mediaLibrary = {
  release: { id: uuid(1), version: "1.0.0" },
  episodes: [{ id: "ep-1", title: "Insertion sort" }],
  visuals: [],
  clipRendering: "toolchain_missing",
  enrollments: [{ id: uuid(51), name: "Dana Levi", status: "active" }],
  provider: {
    revision: 1,
    kind: "video",
    modelId: "video-model-1",
    settings,
    pricing,
    availability: "ready",
    estimateMicroUsd: 400_000,
    units: { outputSeconds: 8, images: 0, requests: 1 },
    capabilities: {
      kind: "video",
      billing: "per_output_second",
      cancellation: "best_effort",
      maxPromptCharacters: 2000,
      retention: { outputHours: 48, providerStoresRequest: false },
    },
    perJobAllowanceMicroUsd: 1_000_000,
  },
  permissions: { request: true, review: true, attach: true },
  jobs: [job(1, "uncertain", null), job(2, "failed", "MEDIA_BUDGET_EXHAUSTED")],
  liveGenerationVerified: false,
};
const studies = {
  canManage: true,
  canExport: true,
  releases: [
    {
      id: uuid(1),
      version: "1.0.0",
      status: "published",
      placementEnabled: false,
      items: [
        {
          id: "pre-min",
          type: "mcq",
          role: null,
          objectiveIds: ["obj-1"],
          retention: false,
        },
      ],
    },
  ],
  studies: [
    {
      id: uuid(61),
      releaseId: uuid(1),
      title: "Ordering study",
      purpose: "We compare three versions of this course.",
      state: "recruiting",
      revision: 2,
      arms: [
        ["fixed", "Fixed path", 4],
        ["chat_only", "Chat-only companion", 4],
        ["supervisor", "Full supervisor", 3],
      ].map(([id, label, consented]) => ({
        id,
        label,
        behaviour: id,
        explanation: `Arm ${id}.`,
        consented,
        withdrawn: 0,
      })),
      instruments: { pre: ["pre-min"], post: [], transfer: [], delayed: [] },
      minCellSize: 5,
      seedDigest: hex("d"),
      consent: { eligible: 14, consented: 11, withdrawn: 1, undecided: 2 },
      createdAt: now,
      openedAt: now,
      closedAt: null,
      warnings: ["Server warning text."],
    },
  ],
};
const releaseA = uuid(71),
  releaseB = uuid(72);
const candidates = {
  courses: [
    ["Sorting", "sorting", releaseA, "Explain insertion sort", "o1"],
    ["Graphs", "graphs", releaseB, "Trace a breadth-first search", "g1"],
  ].map(([title, courseKey, releaseId, description, objectiveId], i) => ({
    catalogId: uuid(80 + i),
    workspaceId: uuid(90),
    workspaceTitle: "Main workspace",
    courseKey,
    title,
    role: "owner",
    releases: [
      {
        releaseId,
        version: "1.0.0",
        status: "published",
        title: null,
        objectives: [{ id: objectiveId, description }],
      },
    ],
  })),
  maxLinks: 50,
};
const side = (c: (typeof candidates.courses)[number]) => ({
  releaseId: c.releases[0]!.releaseId,
  workspaceId: c.workspaceId,
  courseKey: c.courseKey,
  version: "1.0.0",
  title: c.title,
});
const pair = {
  courses: {
    a: {
      ...side(candidates.courses[0]!),
      objectives: candidates.courses[0]!.releases[0]!.objectives,
    },
    b: {
      ...side(candidates.courses[1]!),
      objectives: candidates.courses[1]!.releases[0]!.objectives,
    },
  },
  mapping: {
    id: uuid(99),
    revision: 1,
    state: "active",
    updatedAt: now,
    courses: {
      a: side(candidates.courses[0]!),
      b: side(candidates.courses[1]!),
    },
    links: [
      {
        relation: "prerequisite_of",
        from: { releaseId: releaseB, objectiveId: "g1" },
        to: { releaseId: releaseA, objectiveId: "o1" },
      },
    ],
    linksDigest: hex("e"),
    authoredBy: "staff",
    inferred: false,
    history: [
      {
        revision: 1,
        action: "created",
        linkCount: 1,
        linksDigest: hex("e"),
        author: { id: uuid(98), displayName: "Dana Levi" },
        roles: { a: "owner", b: "admin" },
        note: "Reviewed by both teams",
        createdAt: now,
      },
    ],
  },
};
/** Course, learner and server text from the fixtures above: content, never translated. */
const content = [
  "How insertion sort works",
  "Insertion sort",
  "Insertion sort explained",
  "Insertion sort builds the sorted list one item at a time.",
  "Example Org",
  "A. Author",
  "Clear explanation matching the lesson.",
  "Another explanation",
  "Insertion sort in 4 minutes",
  "Algorithms channel",
  "Insertion sort animation",
  "Shifting items clip",
  "Dana Levi",
  "Operator rate card",
  "Ordering study",
  "We compare three versions of this course.",
  "Fixed path",
  "Chat-only companion",
  "Full supervisor",
  "Arm fixed.",
  "Arm chat_only.",
  "Arm supervisor.",
  "Server warning text.",
  "Sorting",
  "Graphs",
  "Main workspace",
  "Explain insertion sort",
  "Trace a breadth-first search",
  "Reviewed by both teams",
];

async function signIn(page: Page, locale: "he" | null) {
  const session = demoSession("administrator"),
    workspace = {
      ...demoWorkspace(session.courses[0]!, "administrator"),
      role: "admin",
    };
  await page.route("**/auth/session", (route) =>
    route.fulfill({
      json: { user: { id: "u1", displayName: "Mock user", locale } },
    }),
  );
  await page.route("**/api/me/locale*", (route) =>
    route.fulfill({
      json: locale
        ? { preference: locale, locale, source: "user" }
        : { preference: null, locale: "en", source: "request" },
    }),
  );
  await page.route("**/api/workspaces", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/admin/session", (route) =>
    route.fulfill({ json: session }),
  );
  await page.route("**/api/admin/courses/sorting", (route) =>
    route.fulfill({ json: workspace }),
  );
  await page.route("**/api/admin/releases/*/research/library", (route) =>
    route.fulfill({ json: library }),
  );
  await page.route("**/api/admin/releases/*/research", (route) =>
    route.fulfill({ json: queue }),
  );
  await page.route("**/api/admin/releases/*/media-jobs", (route) =>
    route.fulfill({ json: mediaLibrary }),
  );
  await page.route("**/api/admin/releases/*/media-storyboards", (route) =>
    route.fulfill({ json: { storyboards: [] } }),
  );
  await page.route("**/api/admin/media-jobs/*", (route) =>
    route.fulfill({ json: mediaLibrary.jobs[0] }),
  );
  await page.route("**/api/admin/courses/*/studies", (route) =>
    route.fulfill({ json: studies }),
  );
  await page.route("**/api/admin/concept-mappings/candidates", (route) =>
    route.fulfill({ json: candidates }),
  );
  await page.route("**/api/admin/concept-mappings?*", (route) =>
    route.fulfill({ json: pair }),
  );
}
/** No horizontal scrolling. Compared with the configured viewport, because isMobile widens innerWidth. */
async function expectNoHorizontalOverflow(page: Page) {
  const width = page.viewportSize()!.width;
  expect(
    await page.evaluate(() =>
      Math.max(document.documentElement.scrollWidth, window.innerWidth),
    ),
  ).toBeLessThanOrEqual(width);
}
async function expectAccessible(page: Page) {
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
}
/** Text in the main area that is neither pseudo-localized, fixture content, a date nor a code. */
async function untranslated(page: Page) {
  return page.evaluate((allowed) => {
    const out: string[] = [];
    const main = document.querySelector("#main-content") ?? document.body;
    const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement!;
      // Codes and ids inside the view (not the page's own dir) are exempt.
      const exempt = parent.closest('[dir="ltr"], code, .mono, h1');
      if (exempt && main.contains(exempt)) continue;
      let text = (node.textContent ?? "").replace(/⟦[^⟧]*⟧/g, "");
      // Longest first, so "Insertion sort" does not cut "Insertion sort explained".
      for (const value of [...allowed].sort((x, y) => y.length - x.length))
        text = text.replaceAll(value, "");
      text = text.replace(/[⁦⁧⁨⁩]/g, "");
      if (/\b\d{4}\b/.test(text)) continue; // a formatted date or time
      if (/[A-Za-z]{2,}/.test(text)) out.push(text.trim());
    }
    return out;
  }, content);
}

const views = [
  {
    nav: { he: "מקורות מחקר", en: "Research sources" },
    heText: ["לא אמין עד שנבדק", "נמסר ללומדים", "סריקה חוזרת"],
  },
  {
    nav: { he: "מדיה שנוצרה", en: "Generated media" },
    heText: ["משימות מדיה", "יצירת וידאו", "התוצאה לא ודאית"],
  },
  {
    nav: { he: "מחקרים", en: "Studies" },
    heText: ["על המחקרים", "איזון בין הזרועות", "בגיוס"],
  },
  {
    nav: { he: "מיפויי מושגים", en: "Concept mappings" },
    heText: ["בחירת שני קורסים"],
  },
];
async function wideAsDesktop(page: Page) {
  if (page.viewportSize()!.width > 1000)
    await page.setViewportSize({ width: 1280, height: 900 });
}
async function chooseMappingPair(page: Page, first: string, second: string) {
  await page.getByLabel(first).selectOption(releaseA);
  await page.getByLabel(second).selectOption(releaseB);
}

test("research, media, studies and concept mappings render in Hebrew right to left without overflow", async ({
  page,
}) => {
  await wideAsDesktop(page);
  await signIn(page, "he");
  await page.goto("/admin/");
  await expect(page.locator("html")).toHaveAttribute("lang", "he");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  for (const view of views) {
    await page.getByRole("button", { name: view.nav.he }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      view.nav.he,
    );
    for (const text of view.heText)
      await expect(page.getByText(text, { exact: true }).first()).toBeVisible();
    if (view.nav.en === "Concept mappings") {
      await chooseMappingPair(page, "קורס ראשון", "קורס שני");
      await expect(page.getByText("קישורים בין מטרות למידה")).toBeVisible();
      await expect(page.getByText("פעיל · גרסה 1")).toBeVisible();
      await expect(page.getByLabel("יחס")).toHaveValue("requires");
    }
    if (view.nav.en === "Research sources")
      // Course text keeps its own direction inside right-to-left chrome.
      await expect(page.locator(".research-url").first()).toHaveAttribute(
        "dir",
        "ltr",
      );
    await expectNoHorizontalOverflow(page);
    await expectAccessible(page);
  }
  // The media job dialog: translated states, history and the review form.
  await page.getByRole("button", { name: "מדיה שנוצרה" }).click();
  await page
    .getByRole("button", { name: /^פתיחת .*Insertion sort animation/ })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("היסטוריה (2)")).toBeVisible();
  await expect(
    dialog.getByText("ייתכן שהספק עדיין ישלים את הפעולה", { exact: false }),
  ).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expectAccessible(page);
});

test("the en-XA pseudo-locale leaves no untranslated text in research, media, studies or concept mappings", async ({
  page,
}) => {
  await wideAsDesktop(page);
  await signIn(page, null);
  await page.goto("/admin/?locale=en-XA");
  await expect(page.locator("html")).toHaveAttribute("lang", "en-XA");
  for (const view of views) {
    // By accessible name (accented English under en-XA), so new navigation items do not shift it.
    await page
      .locator(".nav-links")
      .getByRole("button", { name: accent(view.nav.en) })
      .click();
    if (view.nav.en === "Concept mappings") {
      const pickers = page.locator(".mapping-pickers select");
      await pickers.nth(0).selectOption(releaseA);
      await pickers.nth(1).selectOption(releaseB);
      await expect(page.locator(".mapping-link")).toHaveCount(1);
    } else await expect(page.locator(".loading")).toHaveCount(0);
    await expect(page.locator("#main-content .card").first()).toBeVisible();
    // Expand collapsed details so their text is checked too.
    await page.evaluate(() =>
      document
        .querySelectorAll("#main-content details")
        .forEach((d) => ((d as HTMLDetailsElement).open = true)),
    );
    await expect(page.locator("#main-content")).toContainText("⟦");
    expect(await untranslated(page)).toEqual([]);
    // en-XA pads each message with one unbroken run of "~", which cannot wrap in a
    // 390 px column; real Hebrew text is checked on phones in the test above.
    if (page.viewportSize()!.width > 1000)
      await expectNoHorizontalOverflow(page);
  }
  // The check itself catches text that bypasses the catalog.
  await page.evaluate(() => {
    const probe = document.createElement("p");
    probe.textContent = "Hardcoded probe";
    document.querySelector("#main-content")!.append(probe);
  });
  expect(await untranslated(page)).toEqual(["Hardcoded probe"]);
});
