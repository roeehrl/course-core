import { test, expect } from "./health";
import { chooseFromMenu } from "./learner-menu";
import { closeCompanion, composerBox, openCompanion } from "./companion-helpers";

// A real saved companion message: sent with the learner's consent while a counted question is
// open, then after a reload the answer draft, the saved message and its state are all still
// there. The consent choices are companion-consent.spec.ts; the draft across window sizes is
// companion-responsive.spec.ts.
test("real saved companion message survives a reload with the answer draft and its state", async ({
  page,
  request,
}) => {
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
    .getByRole("button", { name: /^(Start the course|Start lesson \d+|Continue lesson \d+|Continue learning) →$/ })
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
  await openCompanion(page);
  const draft = composerBox(page);
  await draft.fill("Explain how to compare these values.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const sent = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/companion"),
  );
  await page.getByRole("button", { name: "Send as practice" }).click();
  expect((await sent).status()).toBe(200);
  await expect(draft).toHaveValue("");
  await expect(
    page.getByText("Explain how to compare these values.", { exact: true }),
  ).toBeVisible();
  await closeCompanion(page);
  await page.reload();
  await page
    .getByRole("button", { name: /^(Start the course|Start lesson \d+|Continue lesson \d+|Continue learning) →$/ })
    .click();
  await page
    .getByRole("button", { name: /^(Start the course|Start lesson \d+|Continue lesson \d+|Continue learning) →$/ })
    .click();
  await expect(
    page.getByRole("radio", { name: "2", exact: true }),
  ).toBeChecked();
  await openCompanion(page);
  await expect(
    page.getByText("Explain how to compare these values.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(/Queued|Waiting for service|Preparing a reply|Sent · a reply is being written/),
  ).toBeVisible();
  await closeCompanion(page);
  await chooseFromMenu(page, "Sign out");
  await expect(
    page.getByRole("heading", { name: "Pick up where you left off." }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
