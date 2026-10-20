import { expect, type Browser, type Page } from "@playwright/test";

/** The revisions the last refused save listed as waiting for evaluation (role and full digest). */
export async function refusedRevisions(page: Page) {
  await expect(page.getByText(/has no passing agent evaluation/)).toBeVisible();
  const items = page
    .getByRole("status")
    .filter({ hasText: "Waiting for evaluation" })
    .getByRole("listitem");
  await expect(items.first()).toBeVisible();
  return (await items.allTextContents()).map((text) => {
    const match = /^(\w+):.*Revision ([a-f0-9]{64})/.exec(text.trim());
    expect(match, text).not.toBeNull();
    return { role: match![1]!, digest: match![2]! };
  });
}

/** Signs in as the workspace owner in a separate browser session and records an override for each revision. */
export async function ownerOverrides(
  browser: Browser,
  baseURL: string,
  ownerCode: string,
  revisions: { role: string; digest: string }[],
  viewport?: { width: number; height: number } | null,
) {
  const context = await browser.newContext({
    baseURL,
    ...(viewport ? { viewport } : {}),
  });
  try {
    const owner = await context.newPage();
    await owner.goto("/admin/");
    await owner.getByLabel("One-time sign-in code").fill(ownerCode);
    await owner.getByRole("button", { name: "Use code", exact: true }).click();
    await expect(
      owner.getByRole("heading", { name: "Course & releases", level: 1 }),
    ).toBeVisible();
    await owner.getByRole("button", { name: "Providers", exact: true }).click();
    for (const { role, digest } of revisions) {
      await owner.getByLabel("Role", { exact: true }).selectOption(role);
      await owner.getByLabel("Revision digest").fill(digest);
      await owner
        .getByLabel("Reason", { exact: true })
        .fill("Synthetic browser fixture: this model is never contacted.");
      await owner
        .getByRole("button", { name: "Record owner override" })
        .click();
      await expect(
        owner.getByText(
          `Override recorded for the ${role} revision ${digest.slice(0, 12)}.`,
          { exact: false },
        ),
      ).toBeVisible();
    }
  } finally {
    await context.close();
  }
}
