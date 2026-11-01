import { expect, test } from "@playwright/test";
import { chooseFromMenu, openProfile } from "./learner-menu.js";
import { recordRendererHealth, watchRenderer } from "./renderer-health.js";
import { AxeBuilder } from "@axe-core/playwright";
import type { Locator, Page, Request } from "@playwright/test";
import { declinePlacement, enterNextLesson, fakeYouTubeApi, fillAnswer, openCurrentLesson } from "./learner-helpers.js";

// Split from learner.spec.ts: the profile and record (teaching, data, agents, reviews, ideas).

test.beforeEach(async ({ page }) => watchRenderer(page));
test.afterEach(async ({ page }, testInfo) => recordRendererHealth(page, testInfo));
test("independently verified new teaching is visible on the linear lesson and survives reload without granting mastery", async ({
  page,
  request,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const session = await request.post("/test/model-session", {
    data: { generated: true },
  });
  expect(session.ok()).toBe(true);
  await page.goto(`/#signin=${(await session.json()).token}`);
  await openCurrentLesson(page);
  await page
    .getByRole("button", { name: "Mark this part read", exact: true })
    .click();
  await expect(
    page.getByText("Minimum of [31, -14, 9] is -14.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Demonstrated", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Finish this lesson →", exact: true }),
  ).toBeDisabled();
  await page.reload();
  await openCurrentLesson(page);
  await expect(
    page.getByText("Minimum of [31, -14, 9] is -14.", { exact: true }),
  ).toHaveCount(1);
  await expect(page.getByText("Demonstrated", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Finish this lesson →", exact: true }),
  ).toBeDisabled();
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
  await page.screenshot({
    path: info.outputPath("verified-generated-teaching.png"),
    fullPage: true,
  });
  // A required personal change is explained but cannot be hidden, in the UI or the API.
  await openProfile(page);
  const changes = page.getByRole("region", { name: "Your personal changes" });
  await expect(changes.getByText("Required for your path", { exact: true })).toBeVisible();
  await expect(changes.getByText("Ask your companion or course team if you disagree.", { exact: true })).toBeVisible();
  await expect(changes.getByRole("button", { name: /this addition/ })).toHaveCount(0);
  const id = (await (await page.request.get("/api/enrollments")).json())[0].id;
  const listed = (await (await page.request.get(`/api/enrollments/${id}/personal-changes`)).json()).changes[0];
  const snapshot = await (await page.request.get(`/api/enrollments/${id}`)).json();
  const csrf = (await page.context().cookies()).find((c) => c.name === "course_csrf")!.value;
  const refused = await page.request.post(`/api/enrollments/${id}/personal-changes/visibility`, {
    headers: { origin: new URL(page.url()).origin, "x-csrf-token": csrf },
    data: { expectedRevision: snapshot.revision, idempotencyKey: "hide-required-" + id, episodeId: listed.episodeId, blockId: listed.blockId, hidden: true },
  });
  expect((await refused.json()).error).toBe("CHANGE_NOT_HIDEABLE");
});
test("rejected teaching is repaired and its optional activity record distinguishes feedback from delivery", async ({
  page,
  request,
}, info) => {
  const session = await request.post("/test/model-session", {
    data: { generated: true, repair: true },
  });
  expect(session.ok()).toBe(true);
  await page.goto(`/#signin=${(await session.json()).token}`);
  await openCurrentLesson(page);
  await page
    .getByRole("button", { name: "Mark this part read", exact: true })
    .click();
  await expect(
    page.getByText("Minimum of [31, -14, 9] is -14.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Minimum of [31, -14, 9] is 9.", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Finish this lesson →", exact: true }),
  ).toBeDisabled();
  await chooseFromMenu(page, "Learning record");
  await expect(
    page.getByRole("heading", { name: "What your companion did", exact: true }),
  ).toBeVisible();
  // Each row: the line, then its status chip; feedback on a draft is not a delivery.
  await expect(
    page.getByText("Checked a draft against the course", { exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByText("The draft didn't pass the course's checks, so it needs revising.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText("Another option was picked for your lesson.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText("Added to your lesson.", { exact: true }),
  ).toHaveCount(1);
  await expect(
    page.getByText("Minimum of [31, -14, 9] is 9.", { exact: true }),
  ).toHaveCount(0);
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: info.outputPath("bounded-teaching-repair.png"),
    fullPage: true,
  });
});

test("supervisor preference proposal is corrected and disputed by its learner through the real UI without credit", async ({
  page,
  request,
}, info) => {
  const session = await request.post("/test/model-session");
  expect(session.ok()).toBe(true);
  await page.goto(`/#signin=${(await session.json()).token}`);
  await page
    .getByRole("button", { name: /^(Start the course|Start lesson \d+|Continue lesson \d+|Continue learning) →$/ })
    .click();
  await openProfile(page);
  await expect(
    page.locator(".cc-prof-chip", { hasText: "Waiting for you" }),
  ).toBeVisible();
  await expect(page.getByText("From your companion", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Suggested explanation: Step by step", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Demonstrated", { exact: true })).toHaveCount(0);
  await page
    .getByRole("button", { name: "Correct", exact: true })
    .click();
  await page
    .getByRole("radiogroup", { name: "Corrected suggestion", exact: true })
    .getByRole("radio", { name: "Worked examples", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Save correction", exact: true })
    .click();
  await expect(
    page.locator(".cc-prof-chip", { hasText: "Corrected" }),
  ).toBeVisible();
  await page.reload();
  await page
    .getByRole("button", { name: /^(Start the course|Start lesson \d+|Continue lesson \d+|Continue learning) →$/ })
    .click();
  await openProfile(page);
  await expect(
    page.getByText("Suggested explanation: Worked examples", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Dispute", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Confirm dispute", exact: true })
    .click();
  await expect(
    page.getByText("Disputed, so your companion doesn't use it.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Suggested explanation: Worked examples", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Demonstrated", { exact: true })).toHaveCount(0);
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: info.outputPath("supervisor-model-review.png"),
    fullPage: true,
  });
});

test("a learner downloads their data and then erases this course's learning data", async ({ page, request }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const signIn = await request.post("/test/session");
  await page.goto(`/#signin=${(await signIn.json()).token}`);
  await page
    .getByRole("article")
    .filter({ has: page.getByRole("heading", { name: "Ordering values", exact: true }) })
    .getByRole("button", { name: "Open course", exact: true })
    .click();
  await page.getByRole("button", { name: "Start course", exact: true }).click();
  await enterNextLesson(page);
  await page.getByRole("button", { name: "Mark this part read", exact: true }).click();
  // The read is committed (the next part is offered) before the profile opens, so
  // its revision refresh cannot reload the profile panels underneath the click.
  await expect(page.getByRole("button", { name: "Start the next check →", exact: true })).toBeVisible();
  await openProfile(page);
  const panel = page.getByRole("region", { name: "Your data" });
  await expect(panel).toBeVisible();
  // The personal-changes panel above "Your data" also grows when it loads; a
  // click while it settles can release over whatever moved under the pointer.
  await expect(page.getByRole("heading", { name: "Your personal changes" })).toBeVisible();
  // Staff access to the record is listed for the learner (none in this journey).
  await expect(panel.getByText("No one on the course staff has viewed or downloaded your record.")).toBeVisible();
  const download = page.waitForEvent("download");
  await panel.getByRole("button", { name: "Download my data (JSON)" }).click();
  await expect(panel.getByText("Your data file was prepared. Check your downloads.")).toBeVisible();
  const file = await download;
  const exported = JSON.parse(await (await import("node:fs/promises")).readFile((await file.path())!, "utf8"));
  expect(exported.format).toBe("course-core.enrollment-export");
  expect(exported.events.items.map((e: { event_type: string }) => e.event_type)).toContain("block.read");
  await panel.getByText(/Erase my learning data for/).click();
  const enrollmentId = exported.enrollment.id as string;
  await panel.getByLabel(/Why are you erasing it/).fill("I want to start fresh elsewhere.");
  await panel.getByLabel(`Type ERASE ${enrollmentId.slice(0, 8)} to confirm`).fill(`ERASE ${enrollmentId.slice(0, 8)}`);
  expect(
    (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations,
  ).toEqual([]);
  await panel.getByRole("button", { name: "Erase permanently" }).click();
  await expect(page.getByText("Your learning data for this course was erased.")).toBeVisible();
  const erasedCard = page
    .getByRole("article")
    .filter({ has: page.getByText(/learning data erased/) });
  await expect(erasedCard).toBeVisible();
  await expect(erasedCard.getByRole("button", { name: /^(Start the course|Start lesson \d+|Continue lesson \d+|Continue learning) →$/ })).toHaveCount(0);
  expect((await page.request.get(`/api/enrollments/${enrollmentId}`)).status()).toBe(410);
  await expect(page.getByText(/You erased your learning data for this version/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Resume course" })).toHaveCount(0);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
  ).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("learner-data.png"), fullPage: true });
  expect(errors).toEqual([]);
});

test("a learner connects an external agent with a scoped key, and disconnecting it stops the key at once", async ({ page, request }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const signIn = await request.post("/test/session");
  await page.goto(`/#signin=${(await signIn.json()).token}`);
  await page
    .getByRole("article")
    .filter({ has: page.getByRole("heading", { name: "Ordering values", exact: true }) })
    .getByRole("button", { name: "Open course", exact: true })
    .click();
  await page.getByRole("button", { name: "Start course", exact: true }).click();
  await enterNextLesson(page);
  await expect(page.getByRole("button", { name: "Mark this part read", exact: true })).toBeVisible();
  await openProfile(page);
  // Connected agents wait behind "Advanced" in My profile.
  await page.getByText("Advanced", { exact: true }).click();
  const panel = page.getByRole("region", { name: "Connected agents" });
  await expect(panel.getByText("No agents are connected.")).toBeVisible();
  await panel.getByText("Connect an agent").click();
  await panel.getByLabel("Name for this agent").fill("Synthetic desk agent");
  await panel.getByRole("checkbox", { name: /Your question history/ }).check();
  await panel.getByRole("button", { name: "Connect agent" }).click();
  const key = panel.getByLabel("Access key");
  await expect(key).toBeVisible();
  const token = await key.inputValue();
  expect(token).toMatch(/^ccat_[A-Za-z0-9_-]{43}$/);
  await expect(panel.getByRole("list", { name: "Agents connected now" }).getByText("Synthetic desk agent", { exact: true })).toBeVisible();
  expect(
    (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations,
  ).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await panel.screenshot({ path: testInfo.outputPath("connected-agents.png") });
  // The agent reads with the key alone (no session cookie), and only within its scopes.
  const agent = { authorization: `Bearer ${token}` };
  const context = await request.post("/api/agent-tools/v1/tools/get_context", { headers: agent, data: {} });
  expect(context.status(), await context.text()).toBe(200);
  expect((await context.json()).result.course.title).toBe("Ordering values");
  expect((await request.post("/api/agent-tools/v1/tools/propose_intervention", { headers: agent, data: {} })).status()).toBe(403);
  const listed = await request.post("/api/agent-tools/mcp", { headers: agent, data: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
  expect((await listed.json()).result.tools.map((t: { name: string }) => t.name)).toEqual(["get_context", "get_profile", "get_evidence", "get_history"]);
  await panel.getByRole("button", { name: "I saved it" }).click();
  await expect(panel.getByLabel("Access key")).toHaveCount(0);
  await panel.getByRole("button", { name: "Disconnect Synthetic desk agent" }).click();
  await expect(panel.getByText("Earlier: Synthetic desk agent (disconnected)")).toBeVisible();
  expect((await request.post("/api/agent-tools/v1/tools/get_context", { headers: agent, data: {} })).status()).toBe(401);
  // Once dismissed, the key is nowhere on the page; the list never carries it.
  expect(await page.content()).not.toContain(token);
  expect(errors).toEqual([]);
});

test("a learner sees each staff view and staff download of their record, and their notes stay private", async ({ page, request }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // A learner and the course owner of the same workspace (the owner acts through the real API).
  const fixture = await (await request.post("/test/rubric-session")).json();
  await page.goto(`/#signin=${fixture.token}`);
  await page.getByRole("button", { name: "Open course", exact: true }).click();
  await page.getByRole("button", { name: "Start course", exact: true }).click();
  await declinePlacement(page);
  const id = (await (await page.request.get("/api/enrollments")).json())[0].id as string;
  // The owner can read the evidence projection of the learner model, not the learner's notes or history.
  const model = await request.get(`/api/enrollments/${id}/learner-model`, { headers: fixture.reviewer });
  expect(model.status()).toBe(200);
  expect(await model.json()).toMatchObject({ access: "staff", withheld: ["selfReport", "suggestions", "changes", "history"] });
  expect((await request.get(`/api/enrollments/${id}/learner-model/history`, { headers: fixture.reviewer })).status()).toBe(403);
  // The learner writes private notes about themselves.
  const marker = "PRIVATE_NOTE_" + Date.now();
  const saved = await page.request.post(`/api/enrollments/${id}/learner-model/profile`, {
    headers: { origin: new URL(page.url()).origin, "x-csrf-token": (await page.context().cookies()).find((c) => c.name === "course_csrf")!.value },
    data: { expectedRevision: (await (await page.request.get(`/api/enrollments/${id}`)).json()).revision, idempotencyKey: crypto.randomUUID(),
      profile: { preferences: {}, priorKnowledge: [], thoughts: marker } },
  });
  expect(saved.status(), await saved.text()).toBe(200);
  // One read-only view and one data download by the owner; neither contains the notes.
  const viewed = await request.get(`/api/admin/enrollments/${id}/learner-view`, { headers: fixture.reviewer });
  expect(viewed.status()).toBe(200);
  expect(await viewed.text()).not.toContain(marker);
  const staffCopy = await request.get(`/api/admin/enrollments/${id}/export`, { headers: fixture.reviewer });
  expect(staffCopy.status()).toBe(200);
  expect(await staffCopy.text()).not.toContain(marker);
  expect(await staffCopy.json()).toMatchObject({ audience: "staff", learnerModel: null, companion: null });
  await openProfile(page);
  const panel = page.getByRole("region", { name: "Your data" });
  const access = panel.getByRole("region", { name: "Staff access to your record" });
  await expect(access.getByRole("listitem")).toHaveCount(2);
  await expect(access.getByRole("listitem").nth(0)).toContainText("Rubric reviewer (owner) viewed your record");
  await expect(access.getByRole("listitem").nth(1)).toContainText("Rubric reviewer (owner) downloaded a copy of your data");
  await expect(access.getByText(/neither the view nor their copy includes your companion conversation or your own notes/)).toBeVisible();
  await expect(access.getByText(/Both include your profile: your display name, learning goal and pace/)).toBeVisible();
  await access.scrollIntoViewIfNeeded();
  expect((await new AxeBuilder({ page }).include(".connected-staff-views").withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  const box = (await access.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await access.screenshot({ path: testInfo.outputPath("staff-access.png") });
  // The same records are in the learner's own data file.
  const exported = await (await page.request.get(`/api/enrollments/${id}/export`)).json();
  expect(exported.staffViews).toHaveLength(1);
  expect(exported.staffExports).toMatchObject([{ exporterName: "Rubric reviewer", exporterRole: "owner" }]);
  expect(exported.learnerModel.profile.profile.thoughts).toBe(marker);
  expect(errors).toEqual([]);
});

const placementAnswers: [RegExp, string, boolean][] = [
  [/Which is smaller\?/, "2", true],
  [/Minimum of 4 and 9\?/, "4", false],
  [/Maximum of 4 and 9\?/, "9", false],
  [/Maximum of -3 and -8\?/, "-3", false],
];

test("a written explanation waits for an independent reviewer before the gate can pass", async ({ page, request }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const fixture = await (await request.post("/test/rubric-session")).json();
  await page.goto(`/#signin=${fixture.token}`);
  await page.getByRole("button", { name: "Open course", exact: true }).click();
  await page.getByRole("button", { name: "Start course", exact: true }).click();
  await declinePlacement(page);
  await page.getByRole("button", { name: /^(Start the course|Start lesson \d+|Continue lesson \d+|Continue learning) →$/ }).first().click();
  await page.getByRole("button", { name: "Mark this part read", exact: true }).click();
  await page.getByRole("button", { name: "Start the next check →", exact: true }).click();
  await page.getByRole("radio", { name: "2", exact: true }).click();
  await page.getByRole("button", { name: "Check", exact: true }).click();
  await page.getByRole("button", { name: "Start the next check →", exact: true }).click();
  await expect(page.getByText("A REVIEWER WILL LOOK FOR")).toBeVisible();
  await expect(page.getByText("States the invariant: the kept value is never greater than any element seen.")).toBeVisible();
  await fillAnswer(page.getByRole("textbox", { name: "Your explanation" }), "To find the minimum I keep the smallest value seen so far and compare every next element with it. Because each comparison keeps the smaller value, the kept value is never greater than any element.");
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
  await page.getByRole("button", { name: "Submit for review", exact: true }).click();
  await expect(page.getByText(/Submitted for review\./)).toBeVisible();
  await expect(page.getByRole("region", { name: "Your written answers" }).getByText("Waiting for review", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Finish this lesson →", exact: true })).toBeDisabled();
  // A separate reviewer (the course owner) records quoted findings through the real API.
  const course = (await (await page.request.get("/api/enrollments")).json())[0];
  const catalog = (await (await request.get("/api/admin/session", { headers: fixture.reviewer })).json()).courses[0].id;
  const pending = (await (await request.get(`/api/admin/courses/${catalog}/rubric-reviews`, { headers: fixture.reviewer })).json()).pending;
  expect(pending).toHaveLength(1);
  const saved = await request.post(`/api/admin/rubric-reviews/${pending[0].attemptId}`, {
    headers: fixture.reviewer,
    data: {
      decision: "met",
      criteria: [
        { criterionId: "invariant", met: true, quote: "the kept value is never greater than any element" },
        { criterionId: "every-element", met: true, quote: "compare every next element with it" },
        { criterionId: "edge", met: false, note: "Empty list not discussed." },
      ],
      idempotencyKey: "browser-review-" + course.id,
    },
  });
  expect(saved.ok(), await saved.text()).toBeTruthy();
  await page.reload();
  await openCurrentLesson(page);
  await expect(page.getByText("Criteria met", { exact: true })).toBeVisible();
  await expect(page.getByText("Empty list not discussed.", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Finish this lesson →", exact: true })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("written-review.png"), fullPage: true });
  expect(errors).toEqual([]);
});

test("a reviewer's neutral question continues the written answer as a conversation the learner replies to", async ({ page, request }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const fixture = await (await request.post("/test/rubric-session")).json();
  await page.goto(`/#signin=${fixture.token}`);
  await page.getByRole("button", { name: "Open course", exact: true }).click();
  await page.getByRole("button", { name: "Start course", exact: true }).click();
  await declinePlacement(page);
  await page.getByRole("button", { name: /^(Start the course|Start lesson \d+|Continue lesson \d+|Continue learning) →$/ }).first().click();
  await page.getByRole("button", { name: "Mark this part read", exact: true }).click();
  await page.getByRole("button", { name: "Start the next check →", exact: true }).click();
  await page.getByRole("radio", { name: "2", exact: true }).click();
  await page.getByRole("button", { name: "Check", exact: true }).click();
  await page.getByRole("button", { name: "Start the next check →", exact: true }).click();
  await fillAnswer(page.getByRole("textbox", { name: "Your explanation" }), "I keep the smallest value seen so far and compare every next element with it.");
  await page.getByRole("button", { name: "Submit for review", exact: true }).click();
  await expect(page.getByRole("region", { name: "Your written answers" }).getByText("Waiting for review", { exact: true })).toBeVisible();
  const catalog = (await (await request.get("/api/admin/session", { headers: fixture.reviewer })).json()).courses[0].id;
  const opening = (await (await request.get(`/api/admin/courses/${catalog}/rubric-reviews`, { headers: fixture.reviewer })).json()).pending[0];
  const question = await request.post(`/api/admin/rubric-reviews/${opening.attemptId}`, { headers: fixture.reviewer, data: {
    decision: "needs_clarification", probeOnly: true, learnerNote: "Why does the kept value end up being the minimum?", idempotencyKey: "browser-probe-" + opening.attemptId,
    criteria: [
      { criterionId: "invariant", met: false },
      { criterionId: "every-element", met: true, quote: "compare every next element with it" },
      { criterionId: "edge", met: false },
    ] } });
  expect(question.ok(), await question.text()).toBeTruthy();
  await page.reload();
  await openCurrentLesson(page);
  await expect(page.getByText("Reviewer: Why does the kept value end up being the minimum?")).toBeVisible();
  await page.getByRole("textbox", { name: "Your reply to the reviewer" }).fill("Each comparison keeps the smaller value, so the kept value is never greater than any element seen.");
  await page.getByRole("button", { name: "Send reply", exact: true }).click();
  // The reply is labelled and carries its own status chip.
  await expect(page.locator(".cc-prof-review-status").filter({ hasText: "Your reply" }).getByText("Waiting for review", { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Your reply to the reviewer" })).toHaveCount(0);
  const reply = (await (await request.get(`/api/admin/courses/${catalog}/rubric-reviews`, { headers: fixture.reviewer })).json()).pending[0];
  expect(reply.thread).toHaveLength(1);
  expect(reply.independentEligible).toBe(true);
  await expect(page.getByRole("button", { name: "Finish this lesson →", exact: true })).toBeDisabled();
  expect(errors).toEqual([]);
});

test("a learner sees why their course changed and can hide and restore an optional addition", async ({ page, request }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const session = await request.post("/test/model-session", { data: { generated: true, optional: true } });
  await page.goto(`/#signin=${(await session.json()).token}`);
  await openCurrentLesson(page);
  await page.getByRole("button", { name: "Mark this part read", exact: true }).click();
  const teaching = page.getByText("Minimum of [31, -14, 9] is -14.", { exact: true });
  await expect(teaching).toBeVisible();
  await openProfile(page);
  const panel = page.getByRole("region", { name: "Your personal changes" });
  await expect(panel.getByText("Added explanation or example")).toBeVisible();
  // Its status is a chip; no "·" chains.
  await expect(panel.getByText("Added to your lesson", { exact: true })).toBeVisible();
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
  await panel.getByRole("button", { name: /^Hide this addition/ }).click();
  await expect(panel.getByRole("button", { name: /^Restore this addition/ })).toBeVisible();
  const enrollments = await (await page.request.get("/api/enrollments")).json();
  const id = enrollments[0].id;
  let snapshot = await (await page.request.get(`/api/enrollments/${id}`)).json();
  expect(JSON.stringify(snapshot.course)).not.toContain("Minimum of [31, -14, 9] is -14.");
  const evidenceBefore = snapshot.lessons[0].gate;
  await page.screenshot({ path: testInfo.outputPath("personal-changes.png"), fullPage: true });
  await panel.getByRole("button", { name: /^Restore this addition/ }).click();
  await expect(panel.getByRole("button", { name: /^Hide this addition/ })).toBeVisible();
  snapshot = await (await page.request.get(`/api/enrollments/${id}`)).json();
  expect(JSON.stringify(snapshot.course)).toContain("Minimum of [31, -14, 9] is -14.");
  expect(snapshot.lessons[0].gate).toEqual(evidenceBefore);
  // Generated text is labelled unverified, and the learner can undo it for good after confirming.
  await expect(panel.getByText("Unverified.", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: /^Undo: Added explanation or example/ }).click();
  await panel.getByRole("button", { name: "Keep it", exact: true }).click();
  await panel.getByRole("button", { name: /^Undo: Added explanation or example/ }).click();
  // The confirmation fades in (M17); its colours are checked once it has.
  await expect(panel.getByRole("button", { name: "Keep it", exact: true })).toBeFocused();
  await expect.poll(() => page.evaluate(() => document.getAnimations().filter((a) => a.playState === "running").length)).toBe(0);
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
  await panel.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(panel.getByText("Undone", { exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: /^(Undo|Hide|Restore)/ })).toHaveCount(0);
  snapshot = await (await page.request.get(`/api/enrollments/${id}`)).json();
  expect(JSON.stringify(snapshot.course)).not.toContain("Minimum of [31, -14, 9] is -14.");
  expect(snapshot.lessons[0].gate).toEqual(evidenceBefore);
  await page.screenshot({ path: testInfo.outputPath("personal-change-undone.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test("a learner sees teaching ideas in plain language, checks one, then pins, corrects and rejects it without credit", async ({ page, request }, info) => {
  const session = await request.post("/test/hypothesis-session");
  expect(session.ok()).toBe(true);
  await page.goto(`/#signin=${(await session.json()).token}`);
  await page.getByRole("button", { name: /^(Start the course|Start lesson \d+|Continue lesson \d+|Continue learning) →$/ }).click();
  await openProfile(page);
  const statement = "You may be choosing the largest value when the question asks for the smallest.";
  await expect(page.getByText(statement, { exact: true })).toBeVisible();
  await expect(page.getByText("Possible mix-up", { exact: true })).toBeVisible();
  await expect(page.getByText("An idea to check", { exact: true })).toBeVisible();
  await expect(page.getByText("Noticed from a check answer", { exact: true })).toBeVisible();
  await expect(page.getByText("Tentative: based on 1 observation", { exact: true })).toBeVisible();

  // A quick check: answered, and stated never to count toward progress.
  await page.getByRole("button", { name: "Ask for a quick check of this idea", exact: true }).click();
  await expect(page.getByText("Which is the smallest of 4, 9 and 2?", { exact: true })).toBeVisible();
  await expect(page.getByText("Quick check · doesn't count toward progress", { exact: true })).toBeVisible();
  await expect(page.locator(".cc-prof-unverified")).toHaveText("Unverified");
  await page.getByRole("radiogroup", { name: "Your answer", exact: true }).getByRole("radio", { name: "9", exact: true }).click();
  await page.getByRole("button", { name: "Submit check", exact: true }).click();
  await expect(page.getByText("Thanks. This helps your companion; it doesn't count toward your progress.", { exact: true })).toBeVisible();
  await expect(page.getByText("Supported by your answers", { exact: true })).toBeVisible();
  await page.getByText(statement, { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("teaching-hypothesis-checked.png") });

  await page.getByRole("button", { name: "Pin idea", exact: true }).click();
  await expect(page.getByText("Pinned by you", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Correct this idea", exact: true }).click();
  const correction = "I read “smallest” as “largest”.";
  await page.getByRole("textbox", { name: "Say it in your own words", exact: true }).fill(correction);
  // The save is held until the page has been checked: no success is shown, and the save cannot be
  // sent twice, before the server answers (it answers once the correction is committed).
  let answer!: () => void;
  const held = new Promise<void>((resolve) => { answer = resolve; });
  const decision = /\/hypotheses\/[^/]+\/decision$/;
  await page.route(decision, async (route) => { await held; await route.continue(); });
  const saved = page.waitForResponse((r) => r.request().method() === "POST" && decision.test(new URL(r.url()).pathname));
  await page.getByRole("button", { name: "Save correction", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save correction", exact: true })).toBeDisabled();
  await expect(page.getByText(/Your correction is saved/)).toHaveCount(0);
  answer();
  expect((await saved).ok()).toBe(true);
  await page.unroute(decision);
  await expect(page.getByText("Your correction is saved and replaces the original wording for your companion.", { exact: true })).toBeVisible();
  // The idea's card now carries the saved wording. The editor's own box holds the same text while
  // it is open, so the assertion names the card, and the editor has closed.
  const corrected = page.locator(`[aria-label="Teaching idea: ${correction}"]`);
  await expect(corrected.getByText(correction, { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Say it in your own words", exact: true })).toHaveCount(0);
  // The committed correction persists across reload.
  await page.reload();
  await page.getByRole("button", { name: /^(Start the course|Start lesson \d+|Continue lesson \d+|Continue learning) →$/ }).click();
  await openProfile(page);
  await expect(corrected.getByText(correction, { exact: true })).toBeVisible();
  await expect(corrected.getByText(/^Your correction\. Original wording: /)).toBeVisible();
  await expect(page.getByText("Pinned by you", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Reject this idea", exact: true }).click();
  await page.getByRole("button", { name: "Confirm reject", exact: true }).click();
  await expect(page.getByText("No open ideas.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Show earlier ideas", exact: true }).click();
  await expect(page.getByText("You rejected this", { exact: true })).toBeVisible();
  // Nothing here grants credit.
  await expect(page.getByText("Demonstrated", { exact: true })).toHaveCount(0);
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("teaching-hypotheses.png"), fullPage: true });
});

test("an idea the learner writes is kept for a limited time and can be kept longer", async ({ page, request }, info) => {
  const session = await request.post("/test/hypothesis-session");
  expect(session.ok()).toBe(true);
  const decisions: Record<string, unknown>[] = [];
  page.on("request", (r) => { if (r.method() === "POST" && /\/decision$/.test(new URL(r.url()).pathname)) decisions.push(r.postDataJSON()); });
  await page.goto(`/#signin=${(await session.json()).token}`);
  await page.getByRole("button", { name: /^(Start the course|Start lesson \d+|Continue lesson \d+|Continue learning) →$/ }).click();
  await openProfile(page);
  await page.getByRole("button", { name: "Show ask for a quick check", exact: true }).click();
  await expect(page.getByText(/What you write here becomes one of your ideas/)).toBeVisible();
  const note = "I compare only the first two numbers.";
  await page.getByRole("textbox", { name: "What do you think is confusing you? (optional)", exact: true }).fill(note);
  await page.getByRole("button", { name: "Ask for a check", exact: true }).click();
  const card = page.locator(`[aria-label="Teaching idea: ${note}"]`);
  await expect(card.getByText(/^From your request/)).toBeVisible();
  // The same bounded lifetime as an automatic idea, visible to the learner.
  await expect(card.getByText(/^Kept until /)).toBeVisible();
  await expect(page.getByText(/kept for 30 days, then lapses and frees its place/)).toBeVisible();
  await card.getByRole("button", { name: "Keep this idea for another 30 days", exact: true }).click();
  await expect(page.getByText("Kept for another 30 days.", { exact: true })).toBeVisible();
  expect(decisions.at(-1)).toMatchObject({ action: "renew" });
  await card.scrollIntoViewIfNeeded();
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("teaching-idea-lifetime.png") });
});

test("an optional confidence rating with a declared item reaches the teaching ideas but never the result", async ({ page, request }, info) => {
  const session = await request.post("/test/hypothesis-session?check=1");
  expect(session.ok()).toBe(true);
  const sent: Record<string, unknown>[] = [];
  page.on("request", (r) => { if (r.method() === "POST" && /\/answers$/.test(new URL(r.url()).pathname)) sent.push(r.postDataJSON()); });
  await page.goto(`/#signin=${(await session.json()).token}`);
  await page.getByRole("button", { name: /^(Start the course|Start lesson \d+|Continue lesson \d+|Continue learning) →$/ }).click();
  await enterNextLesson(page);
  await expect(page.getByText("Which is the smallest of 7, 3 and 9?", { exact: true })).toBeVisible();
  const confidence = page.getByRole("radiogroup", { name: "Confidence", exact: true });
  await expect(confidence).toHaveAccessibleDescription(/never changes your result/);
  // Optional: nothing is chosen until the learner picks a level.
  for (const radio of await confidence.getByRole("radio").all()) await expect(radio).not.toBeChecked();
  await confidence.getByRole("radio", { name: "5", exact: true }).click();
  await expect(confidence.getByRole("radio", { name: "5", exact: true })).toBeChecked();
  await page.getByRole("radiogroup", { name: "Your answer", exact: true }).getByRole("radio", { name: "9", exact: true }).click();
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).exclude("iframe").analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("answer-confidence.png") });
  await page.getByRole("button", { name: "Check", exact: true }).click();
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0]).toMatchObject({ answer: "nine", confidence: 5 });
  // The confident wrong answer is observed against the open idea; no credit appears.
  await openProfile(page);
  await expect(page.getByText(/based on 2 observations/)).toBeVisible();
  await expect(page.getByText("Demonstrated", { exact: true })).toHaveCount(0);
});

test("a learner disputes a result and keeps it out of AI context, without any change to credit", async ({ page, request }, info) => {
  const session = await request.post("/test/hypothesis-session");
  expect(session.ok()).toBe(true);
  await page.goto(`/#signin=${(await session.json()).token}`);
  await page.getByRole("button", { name: /^(Start the course|Start lesson \d+|Continue lesson \d+|Continue learning) →$/ }).click();
  await openProfile(page);
  await page.getByRole("button", { name: "Search history", exact: true }).click();
  await page.getByRole("button", { name: /^Show history references / }).first().click();
  await expect(page.getByText("Your companion may use this result.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^Dispute result / }).click();
  const send = page.getByRole("button", { name: "Send dispute", exact: true });
  await expect(send).toBeDisabled();
  await page.getByRole("textbox", { name: /^Why should evidence .+ be reviewed\?$/ }).fill("I meant the smallest value; please look at it again.");
  await send.click();
  await expect(page.getByText("Change saved. Assessment evidence is unchanged.", { exact: true })).toBeVisible();
  await expect(page.getByText("Disputed", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^Don't let your companion use this: / }).click();
  await expect(page.getByText("Disputed, and a review is open. Your companion doesn't use this result.", { exact: true })).toBeVisible();
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("evidence-controls.png"), fullPage: true });
  // Both controls persist across reload; nothing was demonstrated by them.
  await page.reload();
  await page.getByRole("button", { name: /^(Start the course|Start lesson \d+|Continue lesson \d+|Continue learning) →$/ }).click();
  await openProfile(page);
  await expect(page.getByText("Disputed", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Search history", exact: true }).click();
  await page.getByRole("button", { name: /^Show history references / }).first().click();
  await expect(page.getByText("Disputed, and a review is open. Your companion doesn't use this result.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^Withdraw dispute / }).click();
  await expect(page.getByText("Your companion doesn't use this result.", { exact: true })).toBeVisible();
  await expect(page.getByText("Demonstrated", { exact: true })).toHaveCount(0);
});
