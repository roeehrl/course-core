import { test, expect } from "./health";

// The companion keeps the draft, its value and the focus as the window changes from a panel beside
// the lesson (1440) to the tablet's sheet (834) and the phone's (599). The sheet is the same
// complementary region at every size, opens at Half and never turns into a dialog, not even when
// the message box takes focus; closing it returns focus to the trigger in the header. Split from
// companion.spec.ts.
test("the draft keeps its value and focus across window sizes, and closing returns focus to the trigger", async ({
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
  await page
    .getByRole("button", { name: "Mark this part read", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Start the next check →", exact: true })
    .click();
  await page.getByRole("radio", { name: "2", exact: true }).click();
  const companion = page.getByRole("complementary", { name: "Your companion", exact: true });
  const trigger = page.locator(".connected-header .connected-companion-trigger");
  const draft = page.getByRole("textbox", {
    name: "Message to your companion",
    exact: true,
  });
  await page.setViewportSize({ width: 1440, height: 960 });
  if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
  await expect(companion).toHaveAttribute("data-placement", "docked");
  await draft.fill("Explain how to compare these values.");
  await draft.focus();
  // A tablet in portrait: the learner who was typing keeps the companion, now a sheet, and the
  // same field with its text and focus.
  await page.setViewportSize({ width: 834, height: 1112 });
  await expect(companion).toHaveAttribute("data-placement", "sheet");
  await expect(companion).toHaveClass(/is-tablet/);
  await expect(draft).toBeFocused();
  await expect(draft).toHaveValue("Explain how to compare these values.");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // A phone: still the same region, field and focus.
  await page.setViewportSize({ width: 599, height: 1112 });
  await expect(companion).toHaveClass(/is-phone/);
  await expect(companion).toBeVisible();
  await expect(draft).toBeFocused();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Close companion" }).click();
  await expect(companion).toHaveCount(0);
  await expect(page.getByRole("radio", { name: "2", exact: true })).toBeChecked();
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  // Every open starts at Half, and focusing the message box goes to Full without changing what
  // the region is: the lesson behind it is never made inert.
  await trigger.click();
  await expect(companion).toHaveAttribute("data-detent", "half");
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await draft.click();
  await expect(companion).toHaveAttribute("data-detent", "full");
  await expect(companion).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await page.locator("[inert]").count()).toBe(0);
  await expect(draft).toHaveValue("Explain how to compare these values.");
  await page.getByRole("button", { name: "Close companion" }).click();
  await trigger.click();
  await expect(companion).toHaveAttribute("data-detent", "half");
  expect(errors).toEqual([]);
});
