import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

// Real server and database. The Google model listing is scripted by the test server
// (scripts/real-server.ts); no provider is contacted and nothing is generated.
const goodKey = "SYNTHETIC_METADATA_CREDENTIAL",
  revokedKey = "SYNTHETIC_REVOKED_KEY";

async function signIn(page: Page, request: Page["request"]) {
  const fixture = await (await request.post("/test/admin-fixture")).json();
  await page.goto("/admin/");
  await page.getByLabel("One-time sign-in code").fill(fixture.code);
  await page.getByRole("button", { name: "Use code", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Course & releases", level: 1 }),
  ).toBeVisible();
  const responses: string[] = [];
  page.on("response", (r) => {
    if (
      r.url().includes("/api/admin/") &&
      r.headers()["content-type"]?.includes("application/json")
    )
      void r
        .text()
        .then((body) => responses.push(body))
        .catch(() => {});
  });
  await page.getByRole("button", { name: "Providers", exact: true }).click();
  return responses;
}
async function accessible(page: Page) {
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await expect(
    page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    ),
  ).resolves.toBeLessThanOrEqual(1);
}

test("a pasted key is tested, saved under its connection's binding and inspected successfully", async ({
  page,
}, info) => {
  const responses = await signIn(page, page.request);
  const key = page.getByLabel("API key for new connection"),
    save = page.getByRole("button", { name: "Save new connection" }),
    test = page.getByRole("button", { name: "Test key" });
  await expect(page.getByLabel("Installed provider")).toHaveValue("google");
  await expect(save).toBeDisabled();
  await expect(test).toBeDisabled();

  // A wrong key is caught before it is saved, with what to do about it.
  await key.fill(revokedKey);
  await test.click();
  await expect(
    page.getByText(/The provider says this key is not valid/),
  ).toBeVisible();

  // The operator's paste: the key with spaces and a tab around it.
  await key.fill("  " + goodKey + " \t");
  await expect(
    page.getByText(/This key has not passed a test\./),
  ).toBeVisible();
  await test.click();
  await expect(
    page.getByText(/The key works: the provider listed 1 models\./),
  ).toBeVisible();
  await expect(page.getByText(/This key has not passed a test\./)).toHaveCount(
    0,
  );
  await accessible(page);
  await page.screenshot({
    path: info.outputPath("provider-key-tested.png"),
    fullPage: true,
  });
  await save.click();
  await expect(page.getByText(/Configuration saved\./)).toBeVisible();
  await expect(key).toHaveValue("");

  // The advanced fields name the new connection and its real binding.
  const connection = await page
    .getByLabel("Connection to inspect")
    .inputValue();
  expect(connection).toMatch(/^connection-[0-9a-f]{8}$/);
  const binding = await page
    .getByRole("textbox", { name: "Credential binding", exact: true })
    .inputValue();
  expect(binding).toMatch(/^COURSE_PROVIDER_[A-Z0-9]{16}_API_KEY$/);
  await expect(page.getByLabel("Key applies to")).toHaveValue(binding);
  await expect(page.getByLabel("Key applies to")).toContainText(
    `Google connection ${connection}`,
  );
  await expect(page.getByText(`Stored bindings: ${binding}.`)).toBeVisible();

  // The saved key works: the inspection that failed on 0.1.48 now lists the models.
  await page.getByRole("button", { name: "Inspect model metadata" }).click();
  await expect(page.getByText(/Inspected 1 models/)).toBeVisible();
  await accessible(page);
  expect(responses.length).toBeGreaterThan(0);
  expect(responses.every((body) => !body.includes(goodKey))).toBe(true);
  expect(responses.every((body) => !body.includes(revokedKey))).toBe(true);
});

test("a saved key the provider refuses gets a precise message and can be replaced for the same connection", async ({
  page,
}, info) => {
  const responses = await signIn(page, page.request);
  // Saving without a test is allowed, with a warning.
  await page.getByLabel("API key for new connection").fill(revokedKey);
  await expect(
    page.getByText(/This key has not passed a test\./),
  ).toBeVisible();
  await page.getByRole("button", { name: "Save new connection" }).click();
  await expect(page.getByText(/Configuration saved\./)).toBeVisible();
  const connection = await page
    .getByLabel("Connection to inspect")
    .inputValue();

  await page.getByRole("button", { name: "Inspect model metadata" }).click();
  await expect(
    page.getByText(/The provider says this key is not valid/),
  ).toBeVisible();
  await expect(
    page.getByText(/Metadata inspection failed or its scope changed/),
  ).toHaveCount(0);
  await accessible(page);
  await page.screenshot({
    path: info.outputPath("provider-key-refused.png"),
    fullPage: true,
  });

  const replacement = page.getByLabel(`New API key for ${connection}`);
  await replacement.fill(goodKey + "\t");
  await page.getByRole("button", { name: "Test key" }).nth(1).click();
  await expect(
    page.getByText(/The key works: the provider listed 1 models\./),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Save key for this connection" })
    .click();
  await expect(page.getByText(/Configuration saved\./)).toBeVisible();
  // Same connection, same binding: no second connection was created.
  await expect(
    page.getByLabel("Connection to inspect").locator("option"),
  ).toHaveCount(1);
  await page.getByRole("button", { name: "Inspect model metadata" }).click();
  await expect(page.getByText(/Inspected 1 models/)).toBeVisible();
  expect(responses.every((body) => !body.includes(goodKey))).toBe(true);
});
