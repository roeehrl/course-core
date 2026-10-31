import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { AdminApp } from "../src/AdminApp";
import { demo } from "./helpers";

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
    // The course picker moves into the drawer on phones; the bar names the course instead.
    expect(within(bar).queryByLabelText("Course")).toBeNull();
    expect(bar.querySelector(".app-bar-title small")).toHaveTextContent(
      "Sorting, step by step",
    );
    expect(screen.queryByRole("navigation")).toBeNull();
  });

  it("keeps the course picker and refresh in the bar on tablets", async () => {
    windowOfWidth(834);
    render(<AdminApp client={demo()} />);
    await screen.findByRole("heading", { level: 1 });
    const bar = document.querySelector<HTMLElement>(".app-bar")!;
    expect(within(bar).getByLabelText("Course")).toBeInTheDocument();
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
    // The course picker and the mode badge are in the drawer on phones.
    expect(within(drawer).getByLabelText("Course")).toBeInTheDocument();
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
});
