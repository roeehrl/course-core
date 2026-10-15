import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { connectedSnapshot } from "../connectedFixtures";
const starter =
  "def solve(input):\n    # Return a JSON-compatible value.\n    return input\n";
/** Exported connected UI with declared HTTP fixtures; no sandbox success is simulated. */
async function codeHost(
  page: Page,
  language = "python",
  failure = "EVALUATOR_NOT_CONFIGURED",
) {
  const snapshot = connectedSnapshot();
  snapshot.lessons[0]!.completedBlockIds = ["reading", "picture", "movie"];
  snapshot.activeChallenges = [
    {
      challengeId: "code-challenge",
      episodeId: "intro",
      mode: "independent",
      independentEligible: true,
      question: {
        id: "code-question",
        type: "code",
        language,
        starterCode: starter,
        prompt:
          "Implement solve(input): return the reversed JSON list. Example: [1, 2] → [2, 1]. Python standard library only.",
      },
    },
  ];
  const submissions: unknown[] = [];
  await page.route("**/auth/session", (route) =>
    route.fulfill({
      json: { user: { id: "code-learner", displayName: "Code learner" } },
    }),
  );
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (path === "/api/enrollments")
      return route.fulfill({
        json: [
          {
            id: snapshot.enrollmentId,
            title: snapshot.course.title,
            version: "1.0.0",
            status: "active",
          },
        ],
      });
    if (path === "/api/workspaces") return route.fulfill({ json: [] });
    if (path.endsWith("/companion"))
      return route.fulfill({ json: { messages: [] } });
    if (path.endsWith("/answers")) {
      submissions.push(request.postDataJSON());
      await new Promise((resolve) => setTimeout(resolve, 250));
      return route.fulfill({ status: 409, json: { error: failure } });
    }
    if (path === `/api/enrollments/${snapshot.enrollmentId}`)
      return route.fulfill({ json: snapshot });
    return route.fulfill({ status: 404, json: { error: "NOT_FOUND" } });
  });
  async function open() {
    await page
      .getByRole("button", { name: "Continue learning →", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Continue learning →", exact: true })
      .click();
  }
  await page.goto("/");
  await open();
  return { submissions, open };
}
test("Python draft, viewport changes, reload, explicit help consent and unconfigured grader fail closed", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { submissions, open } = await codeHost(page);
  const editor = page.getByRole("textbox", { name: "Your code", exact: true });
  await expect(editor).toHaveValue(starter);
  await expect(editor).toHaveAttribute("autocorrect", "off");
  await expect(editor).toHaveAttribute("spellcheck", "false");
  const solution =
    "def solve(input):\n    return list(reversed(input))\n# " +
    "long draft ".repeat(500);
  await editor.fill(solution);
  await editor.focus();
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("button", { name: "Run code & check" }),
  ).toBeFocused();
  await page.setViewportSize({ width: 834, height: 1112 });
  await expect(editor).toHaveValue(solution);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(editor).toHaveValue(solution);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.reload();
  await open();
  await expect(editor).toHaveValue(solution);
  await page.getByRole("button", { name: "Companion", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Message to your companion" })
    .fill("Help me with this code.");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Switch to practice & send" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Keep independent attempt" }).click();
  await page.getByRole("button", { name: "Close companion" }).click();
  await expect(editor).toHaveValue(solution);
  await page.getByRole("button", { name: "Run code & check" }).click();
  await expect(
    page.getByRole("button", { name: "Checking code…" }),
  ).toBeDisabled();
  await expect(page.getByText(/grader is not configured/)).toBeVisible();
  expect(submissions).toHaveLength(1);
  expect(submissions[0]).toMatchObject({
    challengeId: "code-challenge",
    answer: solution,
    expectedRevision: 1,
  });
  await expect(editor).toHaveValue(solution);
  await expect(
    page.getByRole("button", { name: "Complete episode →" }),
  ).toBeDisabled();
  await expect(
    page.getByText("Code check passed.", { exact: true }),
  ).toHaveCount(0);
  const a11y = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(a11y.violations).toEqual([]);
  await page.screenshot({
    path: info.outputPath("code-editor.png"),
    fullPage: true,
  });
  await editor.fill("");
  await page.reload();
  await open();
  await expect(editor).toHaveValue("");
  await expect(
    page.getByRole("button", { name: "Run code & check" }),
  ).toBeDisabled();
  expect(errors).toEqual([]);
});
test("unknown language cannot submit or claim success; oversized imports preserve source", async ({
  page,
}) => {
  const { submissions } = await codeHost(page, "javascript");
  const editor = page.getByRole("textbox", { name: "Your code" });
  await expect(
    page.getByRole("button", { name: "Run code & check" }),
  ).toBeDisabled();
  await expect(
    page.getByText(/exercise uses an unsupported language/),
  ).toBeVisible();
  expect(submissions).toHaveLength(0);
  await expect(
    page.getByRole("button", { name: "Complete episode →" }),
  ).toBeDisabled();
  await page
    .getByLabel("Choose Python source file")
    .setInputFiles({
      name: "too-large.py",
      mimeType: "text/x-python",
      buffer: Buffer.alloc(64001, 35),
    });
  await expect(page.getByText(/no larger than 64,000 bytes/)).toBeVisible();
  await expect(editor).toHaveValue(starter);
});
