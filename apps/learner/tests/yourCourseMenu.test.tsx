import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { YourCourseMenu } from "../src/connected/YourCourseMenu.web";

function renderMenu() {
  const profile = vi.fn(),
    signOut = vi.fn();
  render(
    <div>
      <button type="button">Elsewhere</button>
      <YourCourseMenu
        label="Your course"
        description="Signed in as Learner"
        groups={[
          {
            label: "Sample course",
            items: [
              { label: "My profile", onSelect: profile },
              { label: "Learning record", onSelect: vi.fn(), current: true },
              { label: "Locked", onSelect: vi.fn(), disabled: true },
            ],
          },
          { label: "Empty", items: [] },
          {
            label: "Account",
            items: [{ label: "Sign out", onSelect: signOut }],
          },
        ]}
      />
    </div>,
  );
  return {
    profile,
    signOut,
    toggle: screen.getByRole("button", { name: /Your course/ }),
  };
}

it("is a disclosure of ordinary buttons, grouped and labelled, closed by default", () => {
  const { toggle, profile } = renderMenu();
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(
    screen.queryByRole("button", { name: "My profile" }),
  ).not.toBeInTheDocument();
  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByText("Signed in as Learner")).toBeVisible();
  expect(screen.getByRole("group", { name: "Sample course" })).toBeVisible();
  expect(screen.getByRole("group", { name: "Account" })).toBeVisible();
  expect(
    screen.queryByRole("group", { name: "Empty" }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Learning record" }),
  ).toHaveAttribute("aria-current", "page");
  expect(screen.getByRole("button", { name: "Locked" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "My profile" }));
  expect(profile).toHaveBeenCalledOnce();
  // Choosing an item closes the list.
  expect(toggle).toHaveAttribute("aria-expanded", "false");
});

it("closes on Escape and returns focus to its button, and on a click outside", () => {
  const { toggle } = renderMenu();
  fireEvent.click(toggle);
  const item = screen.getByRole("button", { name: "Sign out" });
  item.focus();
  fireEvent.keyDown(item, { key: "Escape" });
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(toggle).toHaveFocus();
  fireEvent.click(toggle);
  fireEvent.pointerDown(screen.getByRole("button", { name: "Elsewhere" }));
  expect(toggle).toHaveAttribute("aria-expanded", "false");
});
