import { expect, type Browser } from "@playwright/test";
import { openSection } from "../workspaceNav";

/** Signs in as the workspace owner in a separate browser session and approves every model that
 * waits for a quality check on the AI services page (the server resolves the exact version). */
export async function ownerApproves(
  browser: Browser,
  baseURL: string,
  ownerCode: string,
  viewport?: { width: number; height: number } | null,
  reason = "Synthetic browser fixture: this model is never contacted.",
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
    await openSection(owner, "AI services");
    const check = owner.locator("#ai-check");
    await check.getByText("Approve without checking", { exact: true }).click();
    await check.getByLabel("Why are you skipping the check?").fill(reason);
    await check.getByRole("button", { name: "Approve and turn on" }).click();
    await expect(check.getByText("Approved and turned on.")).toBeVisible();
    return owner;
  } finally {
    await context.close();
  }
}
