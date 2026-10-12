import React from "react";
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import {
  safeHttpsUrl,
  youtubeVideoId,
  mediaAvailability,
} from "../src/connected/resources";
import { VisualBlock } from "../src/components/VisualBlock.web";
import { ReviewedMedia } from "../src/components/ReviewedMedia.web";
import { SourceLinks } from "../src/components/SourceLinks.web";
import { MarkdownContent } from "../src/components/MarkdownContent";
import { connectedSnapshot } from "./connectedFixtures";

describe("reviewed and non-executable course resources", () => {
  it("allows explicit HTTPS sources and keeps private URNs as plain labels", () => {
    for (const value of [
      "javascript:alert(1)",
      "http://example.org",
      "https://user:password@example.org",
      "//example.org",
      "https://example.org\\evil",
      "urn:private:secret",
    ])
      expect(safeHttpsUrl(value)).toBeUndefined();
    render(<SourceLinks sources={connectedSnapshot().course.sources} />);
    expect(
      screen.getByRole("link", { name: /Public reading/ }),
    ).toHaveAttribute("href", "https://example.org/reference");
    expect(screen.getByText("Course reference")).toBeVisible();
    expect(screen.queryByText(/urn:private/)).not.toBeInTheDocument();
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });
  it("recognizes only exact YouTube hosts and validated video IDs", () => {
    for (const url of [
      "https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ",
      "https://evil.test/embed/dQw4w9WgXcQ",
      "https://youtube.com/watch?v=bad",
      "https://youtube.com:444/watch?v=dQw4w9WgXcQ",
    ])
      expect(youtubeVideoId(url)).toBeUndefined();
    expect(youtubeVideoId("https://youtu.be/dQw4w9WgXcQ?si=untrusted")).toBe(
      "dQw4w9WgXcQ",
    );
  });
  it("loads no iframe before consent and constructs only a no-cookie embed without autoplay", () => {
    const media = connectedSnapshot().course.media[0]!;
    const { container, rerender } = render(<ReviewedMedia media={media} />);
    expect(container.querySelector("iframe")).toBeNull();
    expect(screen.getByText(/written explanation/)).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "Load reviewed video" }),
    );
    const frame = container.querySelector("iframe")!;
    expect(frame.src).toBe(
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=0&rel=0",
    );
    expect(frame.getAttribute("allow")).not.toContain("autoplay");
    rerender(<ReviewedMedia media={{ ...media, review: "unreviewed" }} />);
    expect(container.querySelector("iframe")).toBeNull();
  });
  it("blocks expired, unreviewed, rejected, missing and closed required media, including after load", () => {
    const media = connectedSnapshot().course.media[0]!;
    for (const value of [
      undefined,
      { ...media, review: "unreviewed" as const },
      { ...media, review: "rejected" as const },
      { ...media, url: media.url + "&expires=1" },
      { ...media, url: media.url + "&expires=invalid" },
    ])
      expect(mediaAvailability(value).canAcknowledge).toBe(false);
    expect(mediaAvailability(media, true).canAcknowledge).toBe(false);
    expect(
      mediaAvailability(
        { ...media, review: "unreviewed" },
        false,
        Date.now(),
        false,
      ).canAcknowledge,
    ).toBe(true);
    const expiring = { ...media, url: media.url + "&expires=2000000000" };
    const { container, rerender } = render(
      <ReviewedMedia media={expiring} now={1999999999000} />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Load reviewed video" }),
    );
    rerender(<ReviewedMedia media={expiring} now={2000000001000} />);
    expect(container.querySelector("iframe")).toBeNull();
  });
  it("uses the public visuals runtime and retains unknown-renderer text fallback", () => {
    const experience = connectedSnapshot().course.visuals[0]!;
    const { container, rerender } = render(
      <VisualBlock experience={experience} />,
    );
    expect(container.querySelector("svg")).not.toBeNull();
    expect(screen.getByRole("slider", { name: "Timeline" })).toBeVisible();
    rerender(
      <VisualBlock
        experience={{ ...experience, rendererId: "future-renderer" }}
      />,
    );
    expect(container.querySelector("svg")).toBeNull();
    expect(
      screen.getByText(experience.accessibility.description),
    ).toBeVisible();
    rerender(
      <VisualBlock
        experience={{ ...experience, scene: { script: "alert(1)" } }}
      />,
    );
    expect(container.querySelector("svg")).toBeNull();
  });
  it("keeps Markdown text and code inert and renders only safe inline links", () => {
    const { container } = render(
      <MarkdownContent
        markdown={
          "See [public](https://example.org) and [private](urn:private:secret).\n\n<script>bad()</script>\n\n```js\nalert(1)\n```"
        }
      />,
    );
    expect(screen.getByRole("link", { name: "public" })).toHaveAttribute(
      "href",
      "https://example.org/",
    );
    expect(screen.getByText("private")).toBeVisible();
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("alert(1)");
  });
});

it("preserves interactive visual state across equivalent refreshed server JSON", () => {
  const experience = connectedSnapshot().course.visuals[0]!;
  const { rerender } = render(<VisualBlock experience={experience} />);
  fireEvent.change(screen.getByRole("slider", { name: "Target position" }), {
    target: { value: "25" },
  });
  expect(screen.getByRole("slider", { name: "Target position" })).toHaveValue(
    "25",
  );
  rerender(<VisualBlock experience={JSON.parse(JSON.stringify(experience))} />);
  expect(screen.getByRole("slider", { name: "Target position" })).toHaveValue(
    "25",
  );
});
