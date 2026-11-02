import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AdminApp } from "../src/AdminApp";
import type { AdminClient } from "../src/domain/contracts";
import type { PeopleAdminPort } from "../src/domain/people";
import { I18nProvider, createAdminTranslator } from "../src/i18n";
import {
  adminBase,
  lastCourse,
  legacyRoute,
  parseAddress,
  rememberCourse,
  routePath,
} from "../src/routing";
import { atCourse, demo, openAddress } from "./helpers";

const parse = (path: string, search = "", hash = "") =>
  parseAddress(path, search, hash, adminBase(path));
const heading = (name: string) =>
  screen.findByRole("heading", { level: 1, name });
const switcher = () =>
  screen.getAllByRole("button", { name: /^Switch course/ })[0]!;
const breadcrumb = () =>
  screen.getByRole("navigation", { name: "You are here" });
const sidebar = () =>
  screen.getByRole("navigation", { name: "Workspace navigation" });

describe("addresses (routing.ts)", () => {
  it("gives every workspace page and course page its own address, and reads it back", () => {
    for (const page of [
      "courses",
      "people",
      "providers",
      "supervision",
      "limits",
      "mappings",
      "audit",
      "platform",
      "integrations",
    ] as const) {
      const path = routePath({ scope: "workspace", page }, "/admin");
      expect(path).toMatch(/^\/admin\/[a-z-]+$/);
      expect(parse(path)).toEqual({
        route: { scope: "workspace", page },
        canonical: true,
      });
    }
    expect(routePath({ scope: "workspace", page: "providers" }, "/admin")).toBe(
      "/admin/ai-services",
    );
    for (const page of [
      "overview",
      "course",
      "assessments",
      "policy",
      "access",
      "section:glaze-lab",
    ] as const) {
      const path = routePath(
        { scope: "course", courseId: "graphs", page },
        "/admin/demo",
      );
      expect(path.startsWith("/admin/demo/courses/graphs/")).toBe(true);
      expect(parse(path)).toEqual({
        route: { scope: "course", courseId: "graphs", page },
        canonical: true,
      });
    }
    expect(
      routePath({ scope: "course", courseId: "c1", page: "course" }, "/admin"),
    ).toBe("/admin/courses/c1/releases");
  });

  it("reads older and partial addresses as the page they meant", () => {
    // The app itself: no page (the caller opens the last course or the Courses home).
    expect(parse("/admin/")).toEqual({ route: null, canonical: true });
    expect(parse("/admin/demo")).toEqual({ route: null, canonical: true });
    // A course without a page opens where a course opens.
    expect(parse("/admin/courses/c1").route).toEqual({
      scope: "course",
      courseId: "c1",
      page: "course",
    });
    // Older view ids, in the path, the hash or ?view=.
    expect(parse("/admin/courses/c1/allowances")).toEqual({
      route: { scope: "course", courseId: "c1", page: "allowances" },
      canonical: false,
    });
    expect(parse("/admin/providers").route).toEqual({
      scope: "workspace",
      page: "providers",
    });
    expect(parse("/admin/", "", "#policy").route).toEqual({
      scope: "course",
      courseId: null,
      page: "policy",
    });
    expect(parse("/admin/", "?view=audit").route).toEqual({
      scope: "workspace",
      page: "audit",
    });
    // A workspace page under a course is the workspace page.
    expect(parse("/admin/courses/c1/ai-services").route).toEqual({
      scope: "workspace",
      page: "providers",
    });
    // A course page without a course.
    expect(parse("/admin/policy").route).toEqual({
      scope: "course",
      courseId: null,
      page: "policy",
    });
    // Nonsense is no page at all.
    for (const path of [
      "/admin/nope",
      "/admin/courses/c1/nope",
      "/admin/courses/c1/policy/extra",
      "/admin/courses/%E0%A4%A/policy",
    ])
      expect(parse(path).route).toBeNull();
    // Notification links carry the older view ids too.
    expect(legacyRoute("reviews", "c2")).toEqual({
      scope: "course",
      courseId: "c2",
      page: "reviews",
    });
    expect(legacyRoute("platform", "c2")).toEqual({
      scope: "workspace",
      page: "platform",
    });
  });

  it("remembers the last course per person, and survives storage that refuses", () => {
    rememberCourse("ada", "graphs");
    rememberCourse("bo", "sorting");
    expect(lastCourse("ada")).toBe("graphs");
    expect(lastCourse("bo")).toBe("sorting");
    const get = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("SecurityError");
      });
    const set = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("SecurityError");
      });
    expect(() => rememberCourse("ada", "sorting")).not.toThrow();
    expect(lastCourse("ada")).toBeNull();
    get.mockRestore();
    set.mockRestore();
  });
});

describe("workspace and course levels", () => {
  it("opens on the Courses home the first time, then on the course used last", async () => {
    const first = render(<AdminApp client={demo()} />);
    await heading("Courses");
    await screen.findByRole("table", { name: "Courses in this workspace" });
    expect(window.location.pathname).toBe("/admin/courses");
    // A workspace page: no course in the breadcrumb, no course switcher anywhere.
    expect(
      within(breadcrumb()).getByRole("link", { name: "Example school" }),
    ).toBeInTheDocument();
    expect(within(breadcrumb()).getByText("Courses")).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.queryByRole("button", { name: /^Switch course/ })).toBeNull();
    expect(
      within(sidebar())
        .getAllByRole("group")
        .map((group) => group.getAttribute("aria-labelledby")),
    ).toEqual(["nav-group-workspace", "nav-group-server"]);
    await userEvent.click(
      screen.getByRole("button", { name: "Open A first look at graphs" }),
    );
    await heading("Course & releases");
    expect(window.location.pathname).toBe("/admin/courses/graphs/releases");
    first.unmount();
    // Signing in again at the app's own address opens that course.
    openAddress("/admin/");
    render(<AdminApp client={demo()} />);
    await heading("Course & releases");
    expect(window.location.pathname).toBe("/admin/courses/graphs/releases");
    expect(switcher()).toHaveAccessibleName(
      "Switch course. Open now: A first look at graphs",
    );
  });

  it("opens a deep link, keeps the page when switching course, and follows the browser's back button", async () => {
    openAddress("/admin/courses/graphs/policy?locale=en");
    render(<AdminApp client={demo()} />);
    await heading("Policy & extensions");
    expect(
      screen.getByText("A first look at graphs", { selector: ".page-course" }),
    ).toBeInTheDocument();
    expect(
      within(sidebar())
        .getAllByRole("group")
        .map((group) => group.getAttribute("aria-labelledby")),
    ).toEqual(["nav-group-course", "nav-group-learners", "nav-group-rules"]);
    // Another course, on the same page.
    await userEvent.click(switcher());
    const list = screen.getByRole("listbox", { name: "Courses" });
    expect(
      within(list).getByRole("option", { name: /A first look at graphs/ }),
    ).toHaveAttribute("aria-selected", "true");
    await userEvent.click(
      within(list).getByRole("option", { name: "Sorting, step by step" }),
    );
    await heading("Policy & extensions");
    expect(window.location.pathname).toBe("/admin/courses/sorting/policy");
    // The query string (the locale) stays.
    expect(window.location.search).toBe("?locale=en");
    // Back to every course, to a workspace page, then back twice with the browser.
    await userEvent.click(
      screen.getAllByRole("link", { name: "All courses" })[0]!,
    );
    await heading("Courses");
    await userEvent.click(
      within(sidebar()).getByRole("button", { name: "AI services" }),
    );
    await heading("AI services");
    expect(window.location.pathname).toBe("/admin/ai-services");
    // The workspace page is read through the course used last, but names the workspace.
    expect(
      screen.getByText("Example school", { selector: ".page-course" }),
    ).toBeInTheDocument();
    act(() => window.history.back());
    await heading("Courses");
    act(() => window.history.back());
    await heading("Policy & extensions");
    expect(window.location.pathname).toBe("/admin/courses/sorting/policy");
  });

  it("replaces older, unknown and forbidden addresses with the page's own", async () => {
    openAddress("/admin/#providers");
    const first = render(<AdminApp client={demo()} />);
    await heading("AI services");
    expect(window.location.pathname).toBe("/admin/ai-services");
    expect(window.location.hash).toBe("");
    first.unmount();
    // A course this person cannot open leaves them on the Courses home.
    openAddress("/admin/courses/not-a-course/policy");
    const second = render(<AdminApp client={demo()} />);
    await heading("Courses");
    await waitFor(() =>
      expect(window.location.pathname).toBe("/admin/courses"),
    );
    second.unmount();
    // A page this role is not offered opens the level's home (platform is for administrators).
    openAddress("/admin/platform");
    const third = render(<AdminApp client={demo({ role: "reviewer" })} />);
    await waitFor(() =>
      expect(window.location.pathname).toBe("/admin/courses"),
    );
    await heading("Courses");
    third.unmount();
    // A course page without a course opens on the first course when none was used.
    openAddress("/admin/policy");
    render(<AdminApp client={demo()} />);
    await heading("Policy & extensions");
    expect(window.location.pathname).toBe("/admin/courses/sorting/policy");
  });

  it("finds a course in the switcher by typing, with the keyboard only", async () => {
    atCourse();
    const user = userEvent.setup();
    render(<AdminApp client={demo()} />);
    await heading("Course & releases");
    switcher().focus();
    await user.keyboard("{Enter}");
    const search = screen.getByRole("combobox", { name: "Find a course" });
    expect(search).toHaveFocus();
    expect(switcher()).toHaveAttribute("aria-expanded", "true");
    await user.keyboard("graph");
    const list = screen.getByRole("listbox", { name: "Courses" });
    expect(within(list).queryByRole("option", { name: /Sorting/ })).toBeNull();
    const active = search.getAttribute("aria-activedescendant")!;
    expect(document.getElementById(active)).toHaveTextContent(
      "A first look at graphs",
    );
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(window.location.pathname).toBe("/admin/courses/graphs/releases"),
    );
    // Escape closes the list and gives focus back to the button.
    await user.click(switcher());
    await user.keyboard("zzz");
    expect(screen.getByText("No course matches “zzz”.")).toHaveAttribute(
      "role",
      "status",
    );
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(switcher()).toHaveFocus();
  });

  it("speaks Hebrew at both levels", async () => {
    atCourse("policy");
    render(
      <I18nProvider value={createAdminTranslator("he")}>
        <AdminApp client={demo()} />
      </I18nProvider>,
    );
    await heading("מדיניות והארכות");
    expect(
      screen.getByRole("navigation", { name: "המיקום שלך" }),
    ).toBeVisible();
    expect(
      screen.getAllByRole("button", { name: /^החלפת קורס/ })[0],
    ).toBeVisible();
    await userEvent.click(
      screen.getAllByRole("link", { name: "כל הקורסים" })[0]!,
    );
    await heading("קורסים");
    expect(
      screen.getByRole("group", { name: "סביבת העבודה" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "שרת" })).toBeInTheDocument();
  });
});

describe("pages split by level", () => {
  it("puts organization limits on their own workspace page and the course's policy changes on its Policy page", async () => {
    openAddress("/admin/organization-limits");
    const first = render(<AdminApp client={demo()} />);
    await heading("Organization limits");
    await waitFor(() =>
      expect(
        screen.getByText("Outer limits for every course in this workspace"),
      ).toBeVisible(),
    );
    first.unmount();
    atCourse("policy");
    render(<AdminApp client={demo()} />);
    await heading("Policy & extensions");
    const onThisPage = await screen.findByRole("navigation", {
      name: "On this page",
    });
    expect(within(onThisPage).queryByText("Organization limits")).toBeNull();
    expect(within(onThisPage).getByText("Policy changes")).toBeInTheDocument();
    expect(
      screen.queryByText("Outer limits for every course in this workspace"),
    ).toBeNull();
  });

  it("keeps workspace members on People & roles and grants for one course on its Course access page", async () => {
    const person = {
      userId: "00000000-0000-4000-8000-0000000000a1",
      displayName: "Scoped Sam",
      role: "course_scoped" as const,
      joinedAt: "2026-10-01T00:00:00.000Z",
      addedBy: null,
      enrollments: 0,
      lastSignInAt: null,
      self: false,
      canChangeRole: true,
      canRevoke: true,
      canIssueSignIn: false,
    };
    const people = {
      list: vi.fn(async () => ({
        actorRole: "owner" as const,
        roles: ["owner" as const, "course_scoped" as const],
        people: [person],
      })),
      grants: vi.fn(async () => ({ grants: [] })),
      grant: vi.fn(),
      revokeGrant: vi.fn(),
    } as unknown as PeopleAdminPort;
    const client: AdminClient = { ...demo(), people };
    openAddress("/admin/people");
    const first = render(<AdminApp client={client} />);
    await heading("People & roles");
    expect(await screen.findByText("Scoped Sam")).toBeVisible();
    expect(screen.queryByText(/^Course access:/)).toBeNull();
    first.unmount();
    atCourse("access", "graphs");
    render(<AdminApp client={client} />);
    await heading("Course access");
    expect(
      await screen.findByText("Course access: A first look at graphs"),
    ).toBeVisible();
    expect(
      within(sidebar()).getByRole("button", { name: "Course access" }),
    ).toHaveAttribute("aria-current", "page");
  });

  it("offers Course access only where people's course grants can be read", async () => {
    atCourse();
    render(<AdminApp client={demo()} />);
    await heading("Course & releases");
    expect(
      within(sidebar()).queryByRole("button", { name: "Course access" }),
    ).toBeNull();
  });
});
