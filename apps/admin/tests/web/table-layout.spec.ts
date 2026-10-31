import { test, expect, type Page } from "@playwright/test";
import { mockConnectedAdmin } from "./connectedAdmin";
import { closeWorkspaceNav, workspaceNav } from "../workspaceNav";

/**
 * Every admin table shares one layout (styles.css):
 * - No cell is centred. Browsers centre <th> by default; text starts at the reading edge (the
 *   right in Hebrew) and figures (`.num`) line up at the end.
 * - A cell keeps the table's direction. A cell with its own `dir` (an event code, an id) turns
 *   "start" into the other edge; the direction belongs on the cell's content.
 * - Below 700px every table is a list of cards and nothing scrolls sideways: no table is wider
 *   than its frame, and the page does not scroll horizontally.
 * Runs on the desktop and phone projects, in English and Hebrew, over every section of the demo
 * workspace and over the connected People page (the owner's view, with row actions).
 */
interface TableProblem {
  where: string;
  problem: string;
}

async function tableProblems(page: Page, where: string) {
  return page.evaluate(
    ({ where, phone }) => {
      const problems: TableProblem[] = [];
      const visible = (el: Element) =>
        (el as HTMLElement).checkVisibility() &&
        el.getBoundingClientRect().width > 1;
      const tables = [...document.querySelectorAll("main table")].filter(
        visible,
      ) as HTMLTableElement[];
      for (const [index, table] of tables.entries()) {
        const name = `${where} table ${index + 1}`;
        const tableDirection = getComputedStyle(table).direction;
        for (const cell of table.querySelectorAll("th, td")) {
          if (!visible(cell) || cell.closest(".sr-only")) continue;
          const style = getComputedStyle(cell);
          const text = (cell.textContent ?? "").trim().slice(0, 40);
          if (/center/.test(style.textAlign))
            problems.push({ where: name, problem: `centred cell "${text}"` });
          if (style.direction !== tableDirection)
            problems.push({
              where: name,
              problem: `cell "${text}" runs ${style.direction} in a ${tableDirection} table`,
            });
          if (
            !phone &&
            cell.classList.contains("num") &&
            !["end", tableDirection === "rtl" ? "left" : "right"].includes(
              style.textAlign,
            )
          )
            problems.push({
              where: name,
              problem: `figure "${text}" is not end-aligned`,
            });
        }
        if (phone) {
          const frame = (table.closest(".table-wrap, .ai-table-wrap") ??
            table.parentElement)!;
          if (frame.scrollWidth > frame.clientWidth + 1)
            problems.push({
              where: name,
              problem: `scrolls sideways (${frame.scrollWidth}px in ${frame.clientWidth}px)`,
            });
          const box = table.getBoundingClientRect();
          if (box.left < -1 || box.right > window.innerWidth + 1)
            problems.push({
              where: name,
              problem: `wider than the screen (${Math.round(box.left)}..${Math.round(box.right)})`,
            });
        }
      }
      if (
        phone &&
        document.documentElement.scrollWidth >
          document.documentElement.clientWidth + 1
      )
        problems.push({ where, problem: "the page scrolls sideways" });
      return { count: tables.length, problems };
    },
    { where, phone: page.viewportSize()!.width < 700 },
  );
}

/** Opens each workspace section in turn and collects the table problems found there. */
async function everySection(page: Page) {
  const nav = await workspaceNav(page);
  const count = await nav.locator("button").count();
  await closeWorkspaceNav(page);
  let tables = 0;
  const problems: TableProblem[] = [];
  for (let index = 0; index < count; index++) {
    const button = (await workspaceNav(page)).locator("button").nth(index);
    const name = (await button.innerText()).trim();
    await button.click();
    await closeWorkspaceNav(page);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(name);
    await expect(page.locator("main [aria-busy='true']")).toHaveCount(0);
    await page.waitForLoadState("networkidle");
    const found = await tableProblems(page, name);
    tables += found.count;
    problems.push(...found.problems);
  }
  return { tables, problems };
}

for (const locale of ["en", "he"]) {
  test(`demo workspace tables are start-aligned and fit a phone (${locale})`, async ({
    page,
  }) => {
    await page.goto(`/admin/demo?locale=${locale}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const { tables, problems } = await everySection(page);
    // The demo shows tables (graded attempts, run details); a run that found none proves nothing.
    expect(tables).toBeGreaterThanOrEqual(2);
    expect(problems).toEqual([]);
  });

  test(`the people table is start-aligned, with figures at the end, and fits a phone (${locale})`, async ({
    page,
    context,
  }) => {
    await mockConnectedAdmin(page, context);
    await page.route("**/api/admin/workspaces/*/people", (route) =>
      route.fulfill({ json: people }),
    );
    await page.route("**/api/admin/workspaces/*/course-grants", (route) =>
      route.fulfill({ json: { grants: [] } }),
    );
    await page.goto(`/admin/?locale=${locale}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await (
      await workspaceNav(page)
    )
      .getByRole("button", {
        name: locale === "he" ? "אנשים ותפקידים" : "People & roles",
      })
      .click();
    await closeWorkspaceNav(page);
    const table = page.getByRole("table");
    await expect(table.getByRole("row")).toHaveCount(people.people.length + 1);
    const found = await tableProblems(page, "People & roles");
    expect(found.count).toBe(1);
    expect(found.problems).toEqual([]);
    // The owner's own row has no actions; the others keep theirs, by name.
    const other = table.getByRole("row").filter({ hasText: "Avi Peretz" });
    await expect(
      other.getByRole("button", {
        name: locale === "he" ? "הסרה" : "Remove",
        exact: true,
      }),
    ).toBeVisible();
  });
}

let serial = 0;
const person = (
  displayName: string,
  role: string,
  extra: Record<string, unknown> = {},
) => ({
  userId: `00000000-0000-4000-8000-${String(++serial).padStart(12, "0")}`,
  displayName,
  role,
  joinedAt: "2026-09-01T08:00:00Z",
  addedBy: "Dana Levi",
  enrollments: 1,
  lastSignInAt: "2026-10-20T09:30:00Z",
  self: false,
  canChangeRole: true,
  canRevoke: true,
  canIssueSignIn: true,
  canSetPassword: true,
  ...extra,
});
const people = {
  actorRole: "owner",
  roles: ["owner", "admin", "learner", "support_observer", "service"],
  loginCodes: true,
  people: [
    person("Dana Levi", "owner", {
      self: true,
      addedBy: null,
      enrollments: 0,
      canChangeRole: false,
      canRevoke: false,
      canIssueSignIn: false,
      canSetPassword: false,
      loginName: "dana.levi",
    }),
    person("Maya Cohen", "admin", { loginName: "maya.cohen" }),
    person("Avi Peretz", "learner", {
      enrollments: 12,
      mustChangePassword: true,
      loginName: "avi.peretz",
    }),
    person("נועה בן דוד", "support_observer", { lastSignInAt: null }),
    person("Integration bot", "service", { enrollments: 0 }),
  ],
};
