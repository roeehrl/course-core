import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AdminApp } from "../src/AdminApp";
import type { AdminClient } from "../src/domain/contracts";
import { demo } from "./helpers";

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
const picker = () => screen.getByRole("combobox", { name: "Course" });

describe("adding and managing courses", () => {
  it("offers Add a course in the switcher to installers and opens the new course when done", async () => {
    const client = installer();
    render(<AdminApp client={client} />);
    await screen.findByRole("heading", { level: 1, name: "Course & releases" });
    const add = await within(picker()).findByRole("option", {
      name: "Add a course…",
    });
    expect(add.closest("optgroup")).toHaveAttribute("label", "Workspace");
    await userEvent.selectOptions(picker(), add);
    // The switcher stays on the open course while the dialog runs.
    expect(picker()).toHaveValue("sorting");
    const dialog = await screen.findByRole("dialog", { name: "Add a course" });
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Finish synthetic install" }),
    );
    await waitFor(() => expect(picker()).toHaveValue("graphs"));
    expect(client.getSession).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("hides Add a course where installing is not possible, and Manage courses opens the Courses page", async () => {
    render(<AdminApp client={demo()} />);
    await screen.findByRole("heading", { level: 1, name: "Course & releases" });
    expect(
      within(picker()).queryByRole("option", { name: "Add a course…" }),
    ).toBeNull();
    await userEvent.selectOptions(
      picker(),
      within(picker()).getByRole("option", { name: "Manage courses" }),
    );
    expect(
      await screen.findByRole("heading", { level: 1, name: "Courses" }),
    ).toBeInTheDocument();
    expect(picker()).toHaveValue("sorting");
    // Adding is shown, disabled, with the reason.
    const addButton = screen.getByRole("button", { name: "Add a course" });
    expect(addButton).toBeDisabled();
    expect(addButton).toHaveAccessibleDescription(
      "Adding courses is not available in this workspace.",
    );
  });

  it("lists every course with its live version, learners and last update, and opens one", async () => {
    render(<AdminApp client={demo()} />);
    await screen.findByRole("heading", { level: 1, name: "Course & releases" });
    const nav = screen.getByRole("navigation", {
      name: "Workspace navigation",
    });
    const courseGroup = within(nav).getByRole("group", { name: "Course" });
    // First in the Course group.
    expect(within(courseGroup).getAllByRole("button")[0]).toHaveTextContent(
      "Courses",
    );
    await userEvent.click(
      within(courseGroup).getByRole("button", { name: "Courses" }),
    );
    const table = await screen.findByRole("table", {
      name: "Courses in this workspace",
    });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Sorting, step by step");
    expect(rows[0]).toHaveTextContent("Open now");
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
    await waitFor(() => expect(picker()).toHaveValue("graphs"));
    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Course & releases",
      }),
    ).toBeInTheDocument();
  });

  it("enables Add a course on the Courses page for installers and calls the course page's button Install a new version", async () => {
    render(<AdminApp client={installer()} />);
    expect(
      await screen.findByRole("button", { name: "Install a new version" }),
    ).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Install course" })).toBeNull();
    await userEvent.selectOptions(
      picker(),
      within(picker()).getByRole("option", { name: "Manage courses" }),
    );
    const add = await screen.findByRole("button", { name: "Add a course" });
    expect(add).toBeEnabled();
    await userEvent.click(add);
    expect(
      await screen.findByRole("dialog", { name: "Add a course" }),
    ).toBeInTheDocument();
  });
});
