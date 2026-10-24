import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { demoSession, demoWorkspace } from "../../src/data/fixtures";

/** A fictional signed-in owner for the connected host, served by explicit route fixtures. */
export const MOCK_USER = {
  id: "mock-owner",
  displayName: "Dana Levi",
  loginName: "dana.levi",
  hasPassword: true,
};
export const MOCK_WORKSPACE = { id: "demo-workspace", title: "Example school" };

export interface ConnectedAdminMock {
  /** Bodies of PUT /api/me/locale, in order. */
  savedLocales: unknown[];
  /** Bodies of POST /auth/password, in order. */
  passwordChanges: unknown[];
  /** Number of POST /auth/logout requests. */
  signOuts: number;
}

/**
 * Routes the connected admin host (`/admin/`) to fixtures: a signed-in owner with a password,
 * one owned workspace, the demo course workspace, passkeys and notifications. With
 * `courses: false` the owner has no course yet and sees the first-run screen.
 */
export async function mockConnectedAdmin(
  page: Page,
  context: BrowserContext,
  options: { courses?: boolean } = {},
): Promise<ConnectedAdminMock> {
  const state: ConnectedAdminMock = {
    savedLocales: [],
    passwordChanges: [],
    signOuts: 0,
  };
  let signedIn = true;
  const session = demoSession("administrator");
  if (options.courses === false) {
    session.courses = [];
    session.workspaces = [{ ...MOCK_WORKSPACE, role: "owner" }];
  }
  const workspace = {
    ...demoWorkspace(
      session.courses[0] ?? demoSession("administrator").courses[0]!,
      "administrator",
    ),
    role: "owner",
  };
  await context.addCookies([
    {
      name: "course_csrf",
      value: "mock-csrf",
      url: test.info().project.use.baseURL!,
    },
  ]);
  await page.route("**/auth/session", (route) =>
    signedIn
      ? route.fulfill({ json: { user: MOCK_USER } })
      : route.fulfill({ status: 401, json: { error: "UNAUTHENTICATED" } }),
  );
  await page.route("**/auth/options", (route) =>
    route.fulfill({ json: { loginCodes: false, passkeys: false } }),
  );
  await page.route("**/auth/logout", (route) => {
    state.signOuts++;
    signedIn = false;
    return route.fulfill({ json: { signedOut: true } });
  });
  await page.route("**/auth/password", async (route) => {
    state.passwordChanges.push(route.request().postDataJSON());
    await route.fulfill({ json: { changed: true } });
  });
  await page.route("**/auth/passkeys", (route) =>
    route.fulfill({
      json: {
        available: true,
        passkeys: [
          {
            id: "pk-1",
            name: "Passkey on Mac",
            createdAt: "2026-10-01T09:30:00.000Z",
            lastUsedAt: "2026-10-20T15:10:00.000Z",
            backedUp: true,
          },
        ],
      },
    }),
  );
  await page.route("**/api/me/locale", async (route) => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON() as { locale: string };
      state.savedLocales.push(body);
      await route.fulfill({
        json: { preference: body.locale, locale: body.locale, source: "user" },
      });
    } else
      await route.fulfill({
        json: { preference: null, locale: "en", source: "request" },
      });
  });
  await page.route("**/api/workspaces", (route) =>
    route.fulfill({ json: [{ ...MOCK_WORKSPACE, role: "owner" }] }),
  );
  await page.route("**/api/workspaces/*/locale", (route) =>
    route.fulfill({ json: { defaultLocale: null, supported: ["en", "he"] } }),
  );
  await page.route("**/api/admin/session", (route) =>
    route.fulfill({ json: session }),
  );
  await page.route("**/api/admin/workspaces/*/notifications**", (route) =>
    route.fulfill({ json: { items: [], unread: 0, nextCursor: null } }),
  );
  await page.route("**/api/admin/courses/sorting", (route) =>
    route.fulfill({ json: workspace }),
  );
  return state;
}

export async function expectAccessible(page: Page) {
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
}
