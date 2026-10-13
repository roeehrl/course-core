import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test("real saved companion, explicit consent, replay and responsive draft preservation", async ({
  page,
  request,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const token = (await (await request.post("/test/session")).json()).token;
  await page.goto(`/#signin=${token}`);
  await page
    .getByRole("article")
    .filter({
      has: page.getByRole("heading", { name: "Ordering values", exact: true }),
    })
    .getByRole("button", { name: "Open course", exact: true })
    .click();
  await page.getByRole("button", { name: "Start course", exact: true }).click();
  await page
    .getByRole("button", { name: "Continue learning →", exact: true })
    .click();
  const navigation = page.getByRole("navigation", {
    name: "Learning navigation",
  });
  await expect(
    navigation.getByRole("button", { name: "← Course roadmap", exact: true }),
  ).toBeVisible();
  await expect(
    navigation.getByRole("button", { name: "← All courses" }),
  ).toHaveCount(0);
  const mainHeading = await page
    .getByRole("heading", { name: "Minimum", exact: true })
    .boundingBox();
  expect(mainHeading!.y).toBeLessThan(220);
  await page
    .getByRole("button", { name: "Mark this part read", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Start the next check →", exact: true })
    .click();
  await page.getByRole("radio", { name: "2", exact: true }).click();
  if (info.project.name !== "desktop")
    await page.getByRole("button", { name: "Companion", exact: true }).click();
  const draft = page.getByRole("textbox", {
    name: "Message to your companion",
    exact: true,
  });
  await draft.fill("Explain how to compare these values.");
  await page.setViewportSize({ width: 1440, height: 960 });
  await expect(draft).toHaveValue("Explain how to compare these values.");
  await draft.focus();
  await page.setViewportSize({ width: 834, height: 1112 });
  await expect(
    page.getByRole("dialog", { name: "Your companion" }),
  ).toBeVisible();
  await expect(draft).toBeFocused();
  const requests: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().endsWith("/companion"))
      requests.push(r.postData()!);
  });
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Switch to practice & send" }),
  ).toBeVisible();
  expect(requests).toHaveLength(0);
  await page.getByRole("button", { name: "Keep independent attempt" }).click();
  expect(requests).toHaveLength(0);
  await page.getByRole("button", { name: "Close companion" }).click();
  await expect(
    page.getByRole("radio", { name: "2", exact: true }),
  ).toBeChecked();
  await page.getByRole("button", { name: "Companion", exact: true }).click();
  await expect(draft).toHaveValue("Explain how to compare these values.");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  const sent = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/companion"),
  );
  await page.getByRole("button", { name: "Switch to practice & send" }).click();
  expect((await sent).status()).toBe(200);
  await expect(draft).toHaveValue("");
  await expect(
    page.getByText("Explain how to compare these values.", { exact: true }),
  ).toBeVisible();
  expect(JSON.parse(requests[0]!).allowAssessmentAssistance).toBe(true);
  await expect(page.getByText(/^From: Minimum/)).toBeVisible();
  const a11y = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(a11y.violations).toEqual([]);
  await page.screenshot({
    path: info.outputPath("companion-drawer.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Close companion" }).click();
  await expect(
    page.getByText("Practice · no independent credit", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Companion", exact: true }),
  ).toBeFocused();
  await page.reload();
  await page
    .getByRole("button", { name: "Continue learning →", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Continue learning →", exact: true })
    .click();
  await expect(
    page.getByRole("radio", { name: "2", exact: true }),
  ).toBeChecked();
  await page.getByRole("button", { name: "Companion", exact: true }).click();
  await expect(
    page.getByText("Explain how to compare these values.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(/Queued|Waiting for service|Preparing a reply/),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close companion" }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Pick up where you left off." }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
