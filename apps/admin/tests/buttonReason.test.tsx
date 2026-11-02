import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Button } from "../src/components/ui";

describe("Button reason", () => {
  it("renders a bare button without a reason, as before", () => {
    const { container } = render(<Button kind="primary">Save</Button>);
    expect(container.firstElementChild?.tagName).toBe("BUTTON");
    expect(screen.getByRole("button", { name: "Save" })).not.toHaveAttribute(
      "aria-describedby",
    );
  });

  it("explains a disabled button on a line linked as its description", () => {
    render(
      <Button kind="primary" disabled reason="No changes yet">
        Save settings
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Save settings" });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription("No changes yet");
    expect(screen.getByText("No changes yet")).toHaveClass("button-reason");
  });

  it("keeps the same element when the button turns enabled, and hides the reason", () => {
    const { rerender } = render(
      <Button disabled reason="No changes yet" aria-describedby="hint">
        Save
      </Button>,
    );
    const before = screen.getByRole("button", { name: "Save" });
    expect(before.getAttribute("aria-describedby")).toMatch(/^hint /);
    rerender(
      <Button reason="No changes yet" aria-describedby="hint">
        Save
      </Button>,
    );
    const after = screen.getByRole("button", { name: "Save" });
    expect(after).toBe(before);
    expect(after).toHaveAttribute("aria-describedby", "hint");
    expect(screen.queryByText("No changes yet")).toBeNull();
  });
});
