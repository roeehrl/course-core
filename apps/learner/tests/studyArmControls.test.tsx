import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ReviewedMedia } from "../src/components/ReviewedMedia.web";

const media = { id: "clip", kind: "video", title: "Clip", sourceRef: "s1", alternativeMarkdown: "A described clip." } as never;

describe("controls pointing at the companion", () => {
  it("a reviewed video offers 'Ask your companion' only where the companion is available", () => {
    const { rerender } = render(<ReviewedMedia media={media} />);
    expect(screen.getByRole("button", { name: /Ask your companion about this video/ })).toBeVisible();
    rerender(<ReviewedMedia media={media} companionAvailable={false} />);
    expect(screen.queryByRole("button", { name: /companion/i })).toBeNull();
    expect(screen.getByText("A described clip.")).toBeVisible();
  });
});
