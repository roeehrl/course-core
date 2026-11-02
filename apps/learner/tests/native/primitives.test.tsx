import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
// The native project resolves the React Native fallbacks of the shared pieces, never `.web`.
import { Icon } from "../../src/components/icons/Icon";
import { Chip } from "../../src/connected/ui/Chip";
import { LongAnswerComposer } from "../../src/connected/ui/LongAnswerComposer";
import { MetaLine } from "../../src/connected/ui/MetaLine";
import { NoticeBanner } from "../../src/connected/ui/NoticeBanner";
import { PillButton } from "../../src/connected/ui/PillButton";
import { PreparingDots } from "../../src/connected/ui/PreparingDots";
import { StatusLine } from "../../src/connected/ui/StatusLine";
import { Tag } from "../../src/connected/ui/Tag";
import { colors } from "../../src/theme/colors";

describe("native fallbacks of the shared pieces", () => {
  it("use the hex palette", () => {
    expect(colors.accent).toBe("#087B69");
  });

  it("render their words and actions on native controls", () => {
    const press = vi.fn();
    const { container } = render(
      <>
        <Icon name="sparkle" />
        <PillButton label="Get a fresh check" onPress={press} />
        <Chip label="Question 1" variant="removable" onRemove={press} removeLabel="Remove Question 1" />
        <Chip label="Explain this" variant="fill" onPress={press} />
        <Tag label="Personal" variant="outline" />
        <StatusLine text="Waiting to send" action={{ label: "Cancel", onPress: press }} />
        <MetaLine rule>Counts toward this lesson</MetaLine>
        <NoticeBanner text="Offline" action={{ label: "Retry", onPress: press }} />
        <PreparingDots label="Preparing" />
      </>,
    );
    expect(container.querySelector("svg")).toBeNull();
    for (const name of ["Get a fresh check", "Remove Question 1", "Explain this", "Cancel", "Retry"])
      fireEvent.click(screen.getByRole("button", { name }));
    expect(press).toHaveBeenCalledTimes(5);
    expect(screen.getByText("Personal")).toBeVisible();
    expect(screen.getByText("Counts toward this lesson")).toBeVisible();
    expect(screen.getByLabelText("Preparing")).toBeVisible();
  });

  it("long-answer composer submits with its button, not when empty", () => {
    const submit = vi.fn();
    const { rerender } = render(<LongAnswerComposer label="Reply" value="" onChange={() => {}} onSubmit={submit} submitLabel="Send reply" />);
    expect(screen.getByRole("button", { name: "Send reply" })).toHaveAttribute("aria-disabled", "true");
    rerender(<LongAnswerComposer label="Reply" value="Thanks" onChange={() => {}} onSubmit={submit} submitLabel="Send reply" />);
    fireEvent.click(screen.getByRole("button", { name: "Send reply" }));
    expect(submit).toHaveBeenCalledOnce();
  });
});
