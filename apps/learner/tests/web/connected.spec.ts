import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { connectedSnapshot } from "../connectedFixtures";

/** Production UI with explicit fixture HTTP responses; real database flows run separately. */
async function fixtureHost(
  page: Page,
  review: "reviewed" | "unreviewed" = "reviewed",
) {
  const snapshot = connectedSnapshot();
  snapshot.course.media[0]!.review = review;
  await page.route("**/auth/session", (route) =>
    route.fulfill({
      json: { user: { id: "public-user", displayName: "Public learner" } },
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
    if (path.endsWith("/read")) {
      const input = request.postDataJSON();
      snapshot.lessons[0]!.completedBlockIds.push(input.blockId);
      snapshot.revision++;
      return route.fulfill({ json: { revision: snapshot.revision } });
    }
    if (path === `/api/enrollments/${snapshot.enrollmentId}`)
      return route.fulfill({ json: snapshot });
    return route.fulfill({ status: 404, json: { error: "NOT_FOUND" } });
  });
  await page.goto("/");
  await page
    .getByRole("button", { name: "Continue learning →", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Continue learning →", exact: true })
    .click();
}
test("production connected renderer, safe sources, explicit video load and no automatic completion", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let videoRequests = 0;
  await page.route("https://www.youtube-nocookie.com/**", (route) => {
    videoRequests++;
    return route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><html><body>External video request intercepted by test.</body></html>",
    });
  });
  // Stand-in for the official IFrame Player API script; the real one is never fetched.
  let apiLoads = 0;
  await page.route("https://www.youtube.com/iframe_api", (route) => {
    apiLoads++;
    return route.fulfill({
      contentType: "text/javascript",
      body: `window.YT = { Player: function (element, options) {
        var frame = document.createElement("iframe");
        frame.src = options.host + "/embed/" + options.videoId + "?enablejsapi=1&autoplay=" + options.playerVars.autoplay;
        element.replaceWith(frame);
        this.getIframe = function () { return frame; };
        this.destroy = function () { frame.remove(); };
      } };
      window.onYouTubeIframeAPIReady && window.onYouTubeIframeAPIReady();`,
    });
  });
  await fixtureHost(page);
  await expect(
    page.getByRole("link", { name: /Public reading/ }),
  ).toHaveAttribute("href", "https://example.org/reference");
  await expect(
    page.getByText("Course reference", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/urn:private/)).toHaveCount(0);
  await page
    .getByRole("button", { name: "Mark this part read", exact: true })
    .click();
  await expect(page.locator(".ccv-scene")).toBeVisible();
  await page
    .getByRole("slider", { name: "Target position", exact: true })
    .fill("25");
  await page.setViewportSize({ width: 834, height: 1112 });
  await expect(
    page.getByRole("slider", { name: "Target position", exact: true }),
  ).toHaveValue("25");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("slider", { name: "Target position", exact: true }),
  ).toHaveValue("25");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(
    page.getByRole("button", { name: "Play animation" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Complete episode →", exact: true }),
  ).toBeDisabled();
  const a11y = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(a11y.violations).toEqual([]);
  await page.screenshot({
    path: info.outputPath("connected-visual.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Mark this part read", exact: true })
    .click();
  expect(videoRequests).toBe(0);
  expect(apiLoads).toBe(0);
  await expect(page.locator("iframe")).toHaveCount(0);
  await expect(
    page.getByText("A written explanation of the changing pattern."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Load reviewed video" }).click();
  await expect(page.locator("iframe")).toHaveAttribute(
    "src",
    "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?enablejsapi=1&autoplay=0",
  );
  expect(apiLoads).toBe(1);
  await expect.poll(() => videoRequests).toBe(1);
  await expect(
    page.getByRole("button", { name: "Mark this part read", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Complete episode →", exact: true }),
  ).toBeDisabled();
  expect(errors).toEqual([]);
});
test("mandatory unreviewed media cannot be acknowledged through the connected host", async ({
  page,
}) => {
  await fixtureHost(page, "unreviewed");
  await page
    .getByRole("button", { name: "Mark this part read", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Mark this part read", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Mark this part read", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Complete episode →", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Load reviewed video" }),
  ).toHaveCount(0);
});
