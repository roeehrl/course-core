import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminApp } from "../src/AdminApp";
import { Dialog } from "../src/components/ui";
import { atCourse, demo, openAddress } from "./helpers";

/** A window of the given width: `matchMedia` answers the frame's max-width queries for it and
 * tells listeners when `resize` changes it. */
function windowOfWidth(initial: number) {
  let width = initial;
  const lists = new Set<{ query: string; listeners: Set<() => void> }>();
  const matches = (query: string) => {
    const max = /max-width:\s*([\d.]+)px/.exec(query);
    return max ? width <= Number(max[1]) : false;
  };
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => {
      const entry = { query, listeners: new Set<() => void>() };
      lists.add(entry);
      return {
        get matches() {
          return matches(query);
        },
        media: query,
        addEventListener: (_: string, listener: () => void) =>
          entry.listeners.add(listener),
        removeEventListener: (_: string, listener: () => void) =>
          entry.listeners.delete(listener),
      };
    },
  });
  return {
    resize(next: number) {
      width = next;
      act(() => {
        for (const entry of lists)
          for (const listener of entry.listeners) listener();
      });
    },
  };
}
afterEach(() => {
  delete (window as { matchMedia?: unknown }).matchMedia;
});

describe("phone and tablet navigation", () => {
  // A course page unless a test says otherwise.
  beforeEach(() => atCourse());
  it("shows an app bar with the section's name instead of the sidebar, and the course on phones", async () => {
    windowOfWidth(390);
    render(<AdminApp client={demo()} />);
    const heading = await screen.findByRole("heading", { level: 1 });
    expect(document.querySelector(".sidebar")).toBeNull();
    const bar = document.querySelector<HTMLElement>(".app-bar")!;
    expect(within(bar).getByText(heading.textContent!)).toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: "Open menu" });
    expect(toggle).toHaveAttribute("aria-haspopup", "dialog");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    // The course switcher is in the drawer on phones; the bar names the course instead.
    expect(
      within(bar).queryByRole("button", { name: /^Switch course/ }),
    ).toBeNull();
    expect(bar.querySelector(".app-bar-title small")).toHaveTextContent(
      "Sorting, step by step",
    );
    expect(screen.queryByRole("navigation")).toBeNull();
  });

  it("names the workspace under a workspace page's name on phones", async () => {
    windowOfWidth(390);
    openAddress("/admin/ai-services");
    render(<AdminApp client={demo()} />);
    await screen.findByRole("heading", { level: 1, name: "AI services" });
    const bar = document.querySelector<HTMLElement>(".app-bar")!;
    expect(bar.querySelector(".app-bar-title small")).toHaveTextContent(
      "Example school",
    );
  });

  it("keeps the breadcrumb with the course switcher and refresh in the bar on tablets", async () => {
    windowOfWidth(834);
    render(<AdminApp client={demo()} />);
    await screen.findByRole("heading", { level: 1 });
    const bar = document.querySelector<HTMLElement>(".app-bar")!;
    const crumbs = within(bar).getByRole("navigation", {
      name: "You are here",
    });
    expect(
      within(crumbs).getByRole("button", { name: /^Switch course/ }),
    ).toBeInTheDocument();
    expect(within(crumbs).getByText("Course & releases")).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(
      within(bar).getByRole("button", { name: "Refresh workspace" }),
    ).toBeInTheDocument();
    expect(bar.querySelector(".app-bar-title small")).toBeNull();
  });

  it("opens the navigation as a modal drawer on the current section and gives focus back on close", async () => {
    windowOfWidth(390);
    const user = userEvent.setup();
    render(<AdminApp client={demo()} />);
    await screen.findByRole("heading", { level: 1 });
    const toggle = screen.getByRole("button", { name: "Open menu" });
    await user.click(toggle);
    const drawer = screen.getByRole("dialog", { name: "Menu" });
    expect(drawer).toHaveAttribute("aria-modal", "true");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const nav = within(drawer).getByRole("navigation", {
      name: "Workspace navigation",
    });
    const current = within(nav).getByRole("button", {
      name: "Course & releases",
    });
    expect(current).toHaveAttribute("aria-current", "page");
    expect(current).toHaveFocus();
    // The course card (back to every course, the course switcher) and the mode badge are in
    // the drawer.
    expect(
      within(drawer).getByRole("link", { name: "All courses" }),
    ).toBeInTheDocument();
    expect(
      within(drawer).getByRole("button", { name: /^Switch course/ }),
    ).toBeInTheDocument();
    // A course's pages are grouped under three headings.
    expect(
      within(nav)
        .getAllByRole("group")
        .map((group) => group.getAttribute("aria-labelledby")),
    ).toEqual(["nav-group-course", "nav-group-learners", "nav-group-rules"]);
    expect(within(drawer).getByText("Demo workspace")).toBeInTheDocument();
    // Escape (the dialog's cancel) closes it and focus returns to the menu button.
    fireEvent(drawer, new Event("cancel", { cancelable: true }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(toggle).toHaveFocus();
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    // The close button does the same.
    await user.click(toggle);
    await user.click(screen.getByRole("button", { name: "Close menu" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(toggle).toHaveFocus();
    expect(document.body.style.overflow).toBe("");
  });

  it("opens the chosen section, closes the drawer and focuses the new page's heading", async () => {
    windowOfWidth(390);
    const user = userEvent.setup();
    render(<AdminApp client={demo()} />);
    await screen.findByRole("heading", { level: 1 });
    await user.click(screen.getByRole("button", { name: "Open menu" }));
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Enrollments",
      }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading).toHaveTextContent("Enrollments");
    expect(heading).toHaveFocus();
    expect(document.querySelector(".app-bar-title strong")).toHaveTextContent(
      "Enrollments",
    );
  });

  it("mirrors the workspace level in the drawer, and goes back and forth between the levels", async () => {
    windowOfWidth(390);
    const user = userEvent.setup();
    render(<AdminApp client={demo()} />);
    await screen.findByRole("heading", { level: 1, name: "Course & releases" });
    await user.click(screen.getByRole("button", { name: "Open menu" }));
    await user.click(
      within(screen.getByRole("dialog")).getByRole("link", {
        name: "All courses",
      }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      await screen.findByRole("heading", { level: 1, name: "Courses" }),
    ).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Open menu" }));
    const drawer = screen.getByRole("dialog");
    // The workspace's name instead of the course card, and the workspace's pages.
    expect(within(drawer).getByText("Example school")).toBeInTheDocument();
    expect(
      within(drawer).queryByRole("button", { name: /^Switch course/ }),
    ).toBeNull();
    expect(
      within(drawer)
        .getAllByRole("group")
        .map((group) => group.getAttribute("aria-labelledby")),
    ).toEqual(["nav-group-workspace", "nav-group-server"]);
    expect(
      within(drawer).getByRole("button", { name: "Courses" }),
    ).toHaveAttribute("aria-current", "page");
  });

  it("closes a drawer left open when the window widens to the sidebar", async () => {
    const size = windowOfWidth(1024);
    const user = userEvent.setup();
    render(<AdminApp client={demo()} />);
    await screen.findByRole("heading", { level: 1 });
    await user.click(screen.getByRole("button", { name: "Open menu" }));
    expect(screen.getByRole("dialog", { name: "Menu" })).toBeInTheDocument();
    size.resize(1280);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.querySelector(".sidebar")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Open menu" })).toBeNull();
    expect(document.body.style.overflow).toBe("");
    // Narrowing again shows the bar with the drawer closed.
    size.resize(800);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "Open menu" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("keeps the sidebar where the window cannot be measured", async () => {
    render(<AdminApp client={demo()} />);
    await screen.findByRole("heading", { level: 1 });
    expect(document.querySelector(".sidebar")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Open menu" })).toBeNull();
  });

  it("opens and stays open under StrictMode, as on the development server", async () => {
    // Browsers fire `close` after close() in a later task. Under StrictMode the drawer's effect
    // runs twice (open, close, open): the first close's event arrives once it is open again.
    const close = vi
      .spyOn(HTMLDialogElement.prototype, "close")
      .mockImplementation(function (this: HTMLDialogElement) {
        this.removeAttribute("open");
        setTimeout(() => this.dispatchEvent(new Event("close")));
      });
    windowOfWidth(390);
    const user = userEvent.setup();
    render(
      <StrictMode>
        <AdminApp client={demo()} />
      </StrictMode>,
    );
    await screen.findByRole("heading", { level: 1 });
    const toggle = screen.getByRole("button", { name: "Open menu" });
    await user.click(toggle);
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(screen.getByRole("dialog", { name: "Menu" })).toHaveAttribute(
      "open",
    );
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    await user.click(
      within(screen.getByRole("dialog", { name: "Menu" })).getByRole("button", {
        name: "Close menu",
      }),
    );
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(screen.queryByRole("dialog", { name: "Menu" })).toBeNull();
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    close.mockRestore();
  });

  it("keeps a dialog open under StrictMode", async () => {
    const close = vi
      .spyOn(HTMLDialogElement.prototype, "close")
      .mockImplementation(function (this: HTMLDialogElement) {
        this.removeAttribute("open");
        setTimeout(() => this.dispatchEvent(new Event("close")));
      });
    const onClose = vi.fn();
    render(
      <StrictMode>
        <Dialog title="Confirm" onClose={onClose}>
          <p>Body</p>
        </Dialog>
      </StrictMode>,
    );
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(screen.getByRole("dialog", { name: "Confirm" })).toHaveAttribute(
      "open",
    );
    expect(onClose).not.toHaveBeenCalled();
    close.mockRestore();
  });
});
