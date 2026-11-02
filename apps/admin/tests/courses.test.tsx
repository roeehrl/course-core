import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AdminApp } from "../src/AdminApp";
import type { AdminClient } from "../src/domain/contracts";
import { atCourse, demo, openAddress } from "./helpers";

// The package installer has its own tests (installCourse.test.tsx); here it only finishes with the
// catalog id a real install would report.
vi.mock("../src/components/InstallCourse", () => ({
  InstallCourse: ({
    onFinished,
  }: {
    onFinished: (catalogId?: string) => void;
  }) => (
    <button type="button" onClick={() => onFinished("graphs")}>
      Finish synthetic install
    </button>
  ),
}));

/** The demo as a connected workspace whose owner can install course packages. */
function installer(): AdminClient {
  const base = demo();
  return {
    ...base,
    mode: "connected",
    coursePackages: {} as NonNullable<AdminClient["coursePackages"]>,
    getCourse: async (id, signal) => ({
      ...(await base.getCourse(id, signal)),
      role: "owner",
    }),
    getSession: vi.fn(base.getSession),
  };
}
/** The open course's switcher (the breadcrumb's; the sidebar card has the same one). */
const switcher = () =>
  screen.getAllByRole("button", { name: /^Switch course/ })[0]!;
const openSwitcher = async () => {
  await userEvent.click(switcher());
  return screen.getByRole("listbox", { name: "Courses" });
};

describe("adding and managing courses", () => {
  it("offers Add a course in the switcher to installers and opens the new course when done", async () => {
    const client = installer();
    atCourse();
    render(<AdminApp client={client} />);
    await screen.findByRole("heading", { level: 1, name: "Course & releases" });
    const list = await openSwitcher();
    const actions = within(list).getByRole("group", { name: "Workspace" });
    await userEvent.click(
      within(actions).getByRole("option", { name: "Add a course…" }),
    );
    // The open course stays as it is while the dialog runs.
    expect(switcher()).toHaveAccessibleName(
      "Switch course. Open now: Sorting, step by step",
    );
    const dialog = await screen.findByRole("dialog", { name: "Add a course" });
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Finish synthetic install" }),
    );
    await waitFor(() =>
      expect(switcher()).toHaveAccessibleName(
        "Switch course. Open now: A first look at graphs",
      ),
    );
    expect(window.location.pathname).toBe("/admin/courses/graphs/releases");
    expect(client.getSession).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("hides Add a course where installing is not possible, and All courses opens the Courses home", async () => {
    atCourse();
    render(<AdminApp client={demo()} />);
    await screen.findByRole("heading", { level: 1, name: "Course & releases" });
    const list = await openSwitcher();
    expect(
      within(list).queryByRole("option", { name: "Add a course…" }),
    ).toBeNull();
    await userEvent.click(
      within(list).getByRole("option", { name: "All courses" }),
    );
    expect(
      await screen.findByRole("heading", { level: 1, name: "Courses" }),
    ).toBeInTheDocument();
    // The workspace level has no course switcher.
    expect(screen.queryByRole("button", { name: /^Switch course/ })).toBeNull();
    // Adding is shown, disabled, with the reason.
    const addButton = screen.getByRole("button", { name: "Add a course" });
    expect(addButton).toBeDisabled();
    expect(addButton).toHaveAccessibleDescription(
      "Adding courses is not available in this workspace.",
    );
  });

  it("lists every course with its live version, learners and last update, and opens one", async () => {
    atCourse();
    const first = render(<AdminApp client={demo()} />);
    await screen.findByRole("heading", { level: 1, name: "Course & releases" });
    first.unmount();
    // Signed in again at the app's own address: the Courses home is a workspace page.
    openAddress("/admin/courses");
    render(<AdminApp client={demo()} />);
    const nav = await screen.findByRole("navigation", {
      name: "Workspace navigation",
    });
    const group = within(nav).getByRole("group", { name: "Workspace" });
    // First in the Workspace group.
    expect(within(group).getAllByRole("button")[0]).toHaveTextContent(
      "Courses",
    );
    const table = await screen.findByRole("table", {
      name: "Courses in this workspace",
    });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Sorting, step by step");
    // The course used last is marked.
    expect(rows[0]).toHaveTextContent("Opened last");
    expect(rows[0]).toHaveTextContent("1.4.0");
    expect(within(rows[0]!).getAllByRole("cell")[1]).toHaveTextContent("3");
    expect(rows[0]).toHaveTextContent("Oct 28, 2026");
    expect(rows[1]).toHaveTextContent("A first look at graphs");
    expect(rows[1]).toHaveTextContent("None yet");
    await userEvent.click(
      within(rows[1]!).getByRole("button", {
        name: "Open A first look at graphs",
      }),
    );
    await waitFor(() =>
      expect(switcher()).toHaveAccessibleName(
        "Switch course. Open now: A first look at graphs",
      ),
    );
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Course & releases",
      }),
    ).toBeInTheDocument();
  });

  it("enables Add a course on the Courses page for installers and calls the course page's button Install a new version", async () => {
    atCourse();
    render(<AdminApp client={installer()} />);
    expect(
      await screen.findByRole("button", { name: "Install a new version" }),
    ).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Install course" })).toBeNull();
    await userEvent.click(
      within(await openSwitcher()).getByRole("option", { name: "All courses" }),
    );
    const add = await screen.findByRole("button", { name: "Add a course" });
    expect(add).toBeEnabled();
    await userEvent.click(add);
    expect(
      await screen.findByRole("dialog", { name: "Add a course" }),
    ).toBeInTheDocument();
  });
});
