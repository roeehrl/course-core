import { test, expect } from "./health";

// The companion keeps the draft, its value and the focus as the window changes between expanded,
// medium and compact (a pane beside the lesson, then a sheet), and closing it returns focus to
// the button that opens it. Split from companion.spec.ts.
test("the draft keeps its value and focus across window sizes, and closing returns focus to the trigger", async ({
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
    .getByRole("button", { name: /^(Start the course|Start lesson \d+|Continue lesson \d+|Continue learning) →$/ })
    .click();
  await page
    .getByRole("button", { name: "Mark this part read", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Start the next check →", exact: true })
    .click();
  await page.getByRole("radio", { name: "2", exact: true }).click();
  if (!info.project.name.endsWith("desktop"))
    await page.getByRole("button", { name: "Companion", exact: true }).click();
  const draft = page.getByRole("textbox", {
    name: "Message to your companion",
    exact: true,
  });
  await draft.fill("Explain how to compare these values.");
  await page.setViewportSize({ width: 1440, height: 960 });
  await expect(draft).toHaveValue("Explain how to compare these values.");
  await draft.focus();
  // A tablet-width (medium) window keeps the companion beside the lesson; the
  // learner who was typing stays in the same field.
  await page.setViewportSize({ width: 834, height: 1112 });
  await expect(
    page.getByRole("complementary", { name: "Your companion" }),
  ).toBeVisible();
  await expect(draft).toBeFocused();
  // A compact window turns it into a sheet, still with the same field and focus.
  await page.setViewportSize({ width: 599, height: 1112 });
  await expect(
    page.getByRole("dialog", { name: "Your companion" }),
  ).toBeVisible();
  await expect(draft).toBeFocused();
  await page.getByRole("button", { name: "Close companion" }).click();
  await expect(
    page.getByRole("radio", { name: "2", exact: true }),
  ).toBeChecked();
  await expect(
    page.getByRole("button", { name: "Companion", exact: true }),
  ).toBeFocused();
  await page.getByRole("button", { name: "Companion", exact: true }).click();
  await expect(draft).toHaveValue("Explain how to compare these values.");
  expect(errors).toEqual([]);
});
