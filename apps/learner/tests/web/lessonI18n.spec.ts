import { test, expect, type Locator, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { connectedSnapshot } from "../connectedFixtures";
import { authorPolicy } from "../policyFixtures";

/** The roadmap, placement, enrollment preview, profile and a code lesson under a UI locale
 * (`?locale=` override), with declared HTTP fixtures only. */
const starter = "def solve(input):\n    return input\n";
async function host(page: Page, locale: string) {
  const snapshot = connectedSnapshot();
  snapshot.course.policy = authorPolicy;
  snapshot.lessons[0]!.completedBlockIds = ["reading", "picture", "movie"];
  snapshot.activeChallenges = [
    {
      challengeId: "code-challenge",
      episodeId: "intro",
      mode: "independent",
      independentEligible: true,
      question: { id: "code-question", type: "code", language: "python", starterCode: starter, prompt: "Return the input." },
    },
  ];
  let enrolled = false;
  await page.route("**/auth/session", (route) =>
    route.fulfill({ json: { user: { id: "i18n-learner", displayName: "Learner" } } }),
  );
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (path === "/api/me/locale") return route.fulfill({ json: { preference: null, locale: "en", source: "default" } });
    if (path === "/api/workspaces") return route.fulfill({ json: [{ id: "workspace" }] });
    if (path === "/api/workspaces/workspace/courses")
      return route.fulfill({
        json: [
          {
            id: "release-one",
            title: snapshot.course.title,
            version: "1.0.0",
            status: "published",
            summary: "Observe patterns in small steps.",
            policy: authorPolicy,
          },
        ],
      });
    if (path === "/api/enrollments") {
      if (request.method() === "POST") {
        enrolled = true;
        return route.fulfill({ json: { id: snapshot.enrollmentId } });
      }
      return route.fulfill({
        json: enrolled
          ? [{ id: snapshot.enrollmentId, releaseId: "release-one", title: snapshot.course.title, version: "1.0.0", status: "active" }]
          : [],
      });
    }
    if (path.endsWith("/companion")) return route.fulfill({ json: { messages: [] } });
    if (path === `/api/enrollments/${snapshot.enrollmentId}`) return route.fulfill({ json: snapshot });
    return route.fulfill({ status: 404, json: { error: "NOT_FOUND" } });
  });
  await page.goto(`/?locale=${locale}`);
  return snapshot;
}

async function expectNoHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
}
async function expectAccessible(page: Page) {
  expect(
    (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations,
  ).toEqual([]);
}
/** Every text node in `scope` is either pseudo-localized (⟦…⟧), course content, or symbols. */
async function expectOnlyCatalogText(scope: Locator, content: string[]) {
  const loose = await scope.evaluate((root, allowed) => {
    const found: string[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      // The code protocol and submission checks come from connected/code.ts, converted separately.
      if (!parent || parent.closest("[aria-hidden='true'], textarea, pre, script, style, .connected-code-protocol, .connected-code-error"))
        continue;
      const text = (node.textContent ?? "").trim();
      if (!text || /^[\s\d·/•●✓↗○…◇–\-:.,()]*$/.test(text) || allowed.includes(text)) continue;
      if (!parent.closest("*")!.textContent!.includes("⟦")) found.push(text);
    }
    return found;
  }, content);
  expect(loose).toEqual([]);
}

test("Hebrew: enrollment preview, roadmap, placement, profile and a code lesson lay out right to left", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await host(page, "he");
  await expect(page.locator("html")).toHaveAttribute("lang", "he");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");

  await page.getByRole("button", { name: "פתיחת הקורס", exact: true }).click();
  await expect(page.getByText("לפני שמתחילים")).toBeVisible();
  await expect(page.getByText("90 ימים קלנדריים מתחילת הקורס.")).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expectAccessible(page);

  await page.getByRole("button", { name: "התחלת הקורס", exact: true }).click();
  const roadmap = page.getByTestId("course-roadmap");
  await expect(roadmap.getByRole("heading", { name: "מסלול הלמידה שלך" })).toBeVisible();
  await expect(roadmap.getByRole("list", { name: /השיעורים ב-/ })).toBeVisible();
  // Placement could not load: the panel says so in Hebrew.
  await expect(page.getByText("השיבוץ לא זמין כרגע. אפשר להתחיל ללמוד כרגיל או לנסות שוב.")).toBeVisible();
  // Right to left: the resume text starts at the right edge, never left of the button's end.
  const resume = await roadmap.getByRole("button", { name: "המשך למידה ←" }).boundingBox();
  const next = await roadmap.getByText("הצעד הקטן הבא שלך").boundingBox();
  expect(next!.x + next!.width).toBeGreaterThanOrEqual(resume!.x + resume!.width - 2);
  await expectNoHorizontalOverflow(page);
  await expectAccessible(page);

  await roadmap.getByRole("button", { name: "המשך למידה ←" }).click();
  const editor = page.getByRole("textbox", { name: "הקוד שלך", exact: true });
  await expect(editor).toBeVisible();
  await expect(editor).toHaveAttribute("dir", "ltr");
  await expect(page.getByRole("button", { name: "הוספת ארבעה רווחים" })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expectAccessible(page);

  await page.getByRole("button", { name: "הקורס שלך" }).click();
  await page.getByRole("button", { name: "הפרופיל שלי" }).click();
  await expect(page.getByRole("button", { name: "שמירת הפרופיל" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "שם תצוגה" })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expectAccessible(page);
  expect(errors).toEqual([]);
});

test("en-XA pseudo-locale: roadmap, placement and code editor text all comes from the catalog", async ({ page }) => {
  const snapshot = await host(page, "en-XA");
  await page.getByRole("button", { name: /^⟦Öþéñ çöûŕšé/ }).click();
  await page.getByRole("button", { name: /^⟦Šţåŕţ/ }).click();
  const roadmap = page.getByTestId("course-roadmap");
  await expect(roadmap).toBeVisible();
  const course = snapshot.course;
  const content = [
    course.title,
    course.summary ?? "",
    ...course.objectives.map((objective) => objective.description),
    ...course.chapters.flatMap((chapter) => [chapter.title, ...chapter.episodes.map((episode) => episode.title)]),
  ];
  await expectOnlyCatalogText(roadmap, content);
  await expectOnlyCatalogText(page.locator(".connected-placement"), content);
  await expectNoHorizontalOverflow(page);

  await roadmap.getByRole("button").filter({ hasText: /⟦/ }).first().click();
  const tools = page.locator(".connected-code-editor");
  await expect(tools).toBeVisible();
  await expectOnlyCatalogText(tools, [...content, "Return the input."]);
});
