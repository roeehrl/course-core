import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { createTranslator } from "@course-core/i18n";
import enMedia from "../../src/i18n/messages/en/media.json" with { type: "json" };
import heMedia from "../../src/i18n/messages/he/media.json" with { type: "json" };
import enView from "../../src/i18n/messages/en/mediaView.json" with { type: "json" };
import heView from "../../src/i18n/messages/he/mediaView.json" with { type: "json" };
import enApp from "../../src/i18n/messages/en/adminApp.json" with { type: "json" };
import heApp from "../../src/i18n/messages/he/adminApp.json" with { type: "json" };
import enSignIn from "../../src/i18n/messages/en/signIn.json" with { type: "json" };
import heSignIn from "../../src/i18n/messages/he/signIn.json" with { type: "json" };
import { workspaceNav } from "../workspaceNav";

type Locale = "en" | "he";
type Args = Record<string, string | number>;
/** The page's own catalogs, so the test reads exactly what the page shows in each locale. */
function text(locale: Locale) {
  const tr = createTranslator({
    locale,
    catalogs: {
      en: {
        media: enMedia,
        mediaView: enView,
        adminApp: enApp,
        signIn: enSignIn,
      },
      he: {
        media: heMedia,
        mediaView: heView,
        adminApp: heApp,
        signIn: heSignIn,
      },
    },
  });
  type Key = Parameters<typeof tr.t>[0];
  return {
    v: (key: string, args?: Args) => tr.t(`mediaView.${key}` as Key, args),
    m: (key: string, args?: Args) => tr.t(`media.${key}` as Key, args),
    app: (key: string) => tr.t(`adminApp.${key}` as Key),
    signIn: (key: string) => tr.t(`signIn.${key}` as Key),
  };
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
async function openMedia(page: Page, locale: Locale, code: string) {
  const x = text(locale);
  await page.goto(`/admin/?locale=${locale}`);
  await page.getByLabel(x.signIn("code")).fill(code);
  await page
    .getByRole("button", { name: x.signIn("useCode"), exact: true })
    .click();
  await (
    await workspaceNav(page)
  )
    .getByRole("button", { name: x.app("nav.media") })
    .click();
  await expect(
    page.getByRole("heading", { name: x.v("title"), level: 1 }),
  ).toBeVisible();
}

// Real server and database. The video model and the reviewer assistant are scripted adapters and
// the clip tools are stand-ins (scripts/real-server.ts): nothing is generated, contacted or charged
// by a provider. Staff plan a clip with a storyboard, a reviewer approves it, its shot is rendered as
// an exact clip of a course visual, and the automatic check stops a contradicting review, in
// English and Hebrew, at desktop, tablet and phone sizes.
for (const locale of ["en", "he"] as Locale[]) {
  test(`staff plan, approve, render and check an exact clip of a course visual (${locale})`, async ({
    page,
  }, info) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const x = text(locale);
    const fixture = await (
      await page.request.post("/test/media-pipeline-fixture")
    ).json();
    await openMedia(page, locale, fixture.code);
    if (locale === "he")
      await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(
      page.getByText(x.v("clips.ready", { count: 1 })),
    ).toBeVisible();
    await expect(
      page.getByText(x.v("provider.retentionHours", { hours: 48 })),
    ).toBeVisible();

    // Plan: staff write one shot, an exact clip of the course visual.
    await page.getByRole("button", { name: x.v("storyboards.create") }).click();
    const plan = page.getByRole("dialog", {
      name: x.v("storyboards.createTitle"),
    });
    await plan
      .getByLabel(x.v("request.clipTitle"))
      .fill("Sorting by neighbours");
    await plan
      .getByLabel(x.v("request.purpose"))
      .fill("Show how neighbouring values swap until sorted.");
    await plan
      .getByLabel(x.v("storyboards.script"))
      .fill(
        "The bars are compared in pairs and swapped. At the end the smallest value is 1, at the left.",
      );
    await plan.getByLabel(x.v("storyboards.howStaff")).check();
    await plan.getByLabel(x.v("shots.kind")).selectOption("scene");
    await plan
      .getByLabel(x.v("shots.description"))
      .fill("The bars swap places; the smallest value is 1 at the left.");
    await accessible(page);
    await page.screenshot({
      path: info.outputPath(`storyboard-${locale}.png`),
      fullPage: true,
    });
    await plan
      .getByRole("button", { name: x.v("storyboards.createButton") })
      .click();
    await expect(page.getByText(x.v("storyboards.created"))).toBeVisible();

    // A reviewer approves it; only then can its shot be made.
    await page
      .getByRole("button", { name: x.v("storyboards.approve") })
      .click();
    await expect(page.getByText(x.v("storyboards.approved"))).toBeVisible();
    await page
      .getByRole("button", {
        name: x.v("shot.makeLabel", {
          shot: "The bars swap places; the smallest value is 1 at the left.",
        }),
      })
      .click();
    const request = page.getByRole("dialog", { name: x.v("request.title") });
    await expect(
      request.getByText(
        x.v("request.fromShot", { title: "Sorting by neighbours" }),
      ),
    ).toBeVisible();
    await expect(request.getByText(x.v("request.clipFree"))).toBeVisible();
    await accessible(page);
    await request
      .getByRole("button", { name: x.v("request.submitClip") })
      .click();
    await expect(page.getByText(x.v("requestedClip"))).toBeVisible();

    // The render runs on the server; the clip then waits for review.
    expect((await page.request.post("/test/media-run")).ok()).toBe(true);
    await page.reload();
    await (
      await workspaceNav(page)
    )
      .getByRole("button", { name: x.app("nav.media") })
      .click();
    const job = page
      .getByRole("list", { name: x.v("jobs.title") })
      .getByRole("listitem")
      .filter({ hasText: "Sorting by neighbours" });
    await expect(job).toContainText(x.v("kind.scene_clip"));
    await expect(job).toContainText(x.v("state.under_review"));
    await page
      .getByRole("button", {
        name: x.v("openLabel", { title: "Sorting by neighbours" }),
      })
      .click();
    const dialog = page.getByRole("dialog", { name: "Sorting by neighbours" });
    await expect(dialog.locator("video")).toHaveAttribute(
      "src",
      /\/api\/admin\/media-jobs\/[0-9a-f-]+\/asset$/,
    );

    // The review text contradicts the approved shot: the check says so before saving.
    await dialog
      .getByLabel(x.v("review.transcriptLabel"))
      .fill(
        "We compare neighbours and swap them; the smallest value is 7 at the end.",
      );
    await dialog
      .getByLabel(x.v("review.description"))
      .fill("Bars of different heights swap places until they are in order.");
    await dialog.getByRole("button", { name: x.v("checkPanel.run") }).click();
    await expect(
      dialog.getByText(x.v("checkPanel.contradicted")),
    ).toBeVisible();
    await expect(
      dialog.getByText(
        x.m("finding.quantityScript", {
          subject: "smallest value",
          found: "7",
          expected: "1",
        }),
      ),
    ).toBeVisible();
    await accessible(page);
    await page.screenshot({
      path: info.outputPath(`check-${locale}.png`),
      fullPage: true,
    });
    for (const key of [
      "factualAccuracy",
      "labelsAndEquations",
      "captionsMatchNarration",
      "noMisleadingMotion",
    ])
      await dialog.getByLabel(x.v(`check.${key}`)).check();
    await dialog
      .getByLabel(x.v("review.rationale"))
      .fill("Checked against the storyboard shot and the course visual.");
    // Saving the contradicting review is refused with the same finding.
    await dialog.getByRole("button", { name: x.v("review.submit") }).click();
    await expect(
      dialog.getByText(x.m("error.MEDIA_FACTUAL_CHECK_FAILED")),
    ).toBeVisible();
    // Corrected text passes and the clip is approved, still hidden from learners.
    await dialog
      .getByLabel(x.v("review.transcriptLabel"))
      .fill(
        "We compare neighbours and swap them; the smallest value is 1 at the end.",
      );
    await dialog.getByRole("button", { name: x.v("checkPanel.run") }).click();
    await expect(dialog.getByText(x.v("checkPanel.consistent"))).toBeVisible();
    await dialog.getByRole("button", { name: x.v("review.submit") }).click();
    await expect(dialog.getByText(x.v("review.approved"))).toBeVisible();
    expect(errors).toEqual([]);
  });
}
